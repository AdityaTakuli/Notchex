import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isDesktopWindow} from './compat.js';

const REVEAL_DELAY_MS = 70;
const HIDE_DELAY_MS = 450;
const SLIDE_MS = 190;
const EDGE_PX = 2;
const FILL_FADE_MS = 220;

/* macOS-style top bar: GNOME's panel is slid out of view and only comes
   back while the pointer rests on the top screen edge (outside the notch),
   while a panel menu is open, or in the Overview. Windows no longer make
   room for the panel; instead an invisible strut as tall as the notch
   keeps maximized windows just below it.

   GNOME tracks the panel as chrome that reserves screen space; we re-track
   it without that (the same private LayoutManager calls hide-top-bar
   extensions use) and restore the original tracking on disable. */
export class TopBarAutoHide {
    /* opts: reservedHeight() → px, isOverNotch(x, y) → bool,
             fillColor() → CSS color for the strip beside the island, or null.
             The strip is only painted while an app window is open on the
             primary monitor; on an empty desktop the wallpaper shows. */
    constructor(opts) {
        this._opts = opts;
        this._enabled = false;
        this._hidden = false;
        this._showTimer = 0;
        this._hideTimer = 0;
    }

    enable() {
        if (this._enabled) return;
        this._enabled = true;
        const lm = Main.layoutManager;
        const box = lm.panelBox;

        lm._untrackActor(box);
        lm._trackActor(box, {affectsStruts: false, trackFullscreen: true});

        this._panelTrackHover = Main.panel.track_hover;
        Main.panel.track_hover = true;
        Main.panel.connectObject('notify::hover', () => this._onHoverChanged(), this);
        Main.overview.connectObject(
            'showing', () => this._show(),
            'hiding',  () => this._scheduleHide(),
            this);
        lm.connectObject('monitors-changed', () => this.relayout(), this);
        box.connectObject('notify::height', () => {
            if (this._hidden) box.translation_y = -box.height;
        }, this);

        /* hot strip along the top edge that reveals the panel */
        this._edge = new St.Widget({name: 'notchex-top-edge', reactive: true, track_hover: true});
        this._edge.connect('notify::hover', () => this._onHoverChanged());
        lm.addChrome(this._edge, {affectsInputRegion: true, trackFullscreen: true});

        /* reserves the space under the island so windows start below it;
           optionally painted (black) so the strip beside the notch reads as
           one bar with it, like a MacBook. Non-reactive: clicks go through.
           Kept below the panel so the revealed panel covers it. */
        this._strut = new St.Widget({name: 'notchex-strut', reactive: false});
        lm.addChrome(this._strut, {affectsStruts: true, affectsInputRegion: false, trackFullscreen: true});
        lm.uiGroup.set_child_below_sibling(this._strut, box);
        this._strut.opacity = 0;
        this._filled = false;

        /* window open/close/minimize/workspace switches decide the fill */
        const queue = () => this._queueFillCheck();
        global.window_manager.connectObject(
            'map', queue, 'destroy', queue, 'minimize', queue, 'unminimize', queue,
            'switch-workspace', queue, this);
        global.display.connectObject('restacked', queue, 'window-entered-monitor', queue,
            'window-left-monitor', queue, this);

        this.relayout();
        this._hide(false);
    }

    disable() {
        if (!this._enabled) return;
        this._enabled = false;
        this._clearTimers();
        const lm = Main.layoutManager;
        const box = lm.panelBox;

        Main.panel.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        if (this._fillIdle) { GLib.source_remove(this._fillIdle); this._fillIdle = 0; }
        lm.disconnectObject(this);
        box.disconnectObject(this);
        Main.panel.track_hover = this._panelTrackHover;

        for (const actor of [this._edge, this._strut]) {
            try { lm.removeChrome(actor); } catch (_) {}
            actor.destroy();
        }
        this._edge = this._strut = null;

        lm._untrackActor(box);
        lm._trackActor(box, {affectsStruts: true, trackFullscreen: true});
        box.remove_all_transitions();
        box.translation_y = 0;
        this._hidden = false;
    }

    /* monitor / notch size changed */
    relayout() {
        if (!this._enabled) return;
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return;
        /* leave the extreme corners to GNOME's hot corner */
        const inset = 4;
        this._edge.set_position(mon.x + inset, mon.y);
        this._edge.set_size(mon.width - 2 * inset, EDGE_PX);
        this._strut.set_position(mon.x, mon.y);
        this._strut.set_size(mon.width, Math.max(1, Math.round(this._opts.reservedHeight())));
        const fill = this._opts.fillColor();
        this._strut.set_style(fill ? `background-color: ${fill};` : null);
        this._updateFill(false);
    }

    /* coalesce bursts of window-manager signals; a destroyed window is
       still listed while its 'destroy' signal runs */
    _queueFillCheck() {
        if (this._fillIdle || !this._enabled) return;
        this._fillIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._fillIdle = 0;
            this._updateFill(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _hasAppWindow() {
        const primary = Main.layoutManager.primaryIndex;
        const ws = global.workspace_manager.get_active_workspace();
        return ws.list_windows().some(w =>
            !isDesktopWindow(w) &&
            !w.minimized &&
            !w.is_skip_taskbar() &&
            w.get_monitor() === primary &&
            [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG]
                .includes(w.get_window_type()) &&
            w.showing_on_its_workspace());
    }

    _updateFill(animate) {
        if (!this._enabled) return;
        const want = !!this._opts.fillColor() && this._hasAppWindow();
        if (want === this._filled && animate) return;
        this._filled = want;
        this._strut.remove_all_transitions();
        if (!animate) {
            this._strut.opacity = want ? 255 : 0;
            return;
        }
        this._strut.ease({
            opacity: want ? 255 : 0,
            duration: FILL_FADE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
    }

    _onHoverChanged() {
        if (!this._enabled) return;
        if (this._edge.hover && this._hidden) {
            const [x, y] = global.get_pointer();
            if (this._opts.isOverNotch(x, y)) return;
            this._clearShowTimer();
            this._showTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, REVEAL_DELAY_MS, () => {
                this._showTimer = 0;
                if (this._edge?.hover) this._show();
                return GLib.SOURCE_REMOVE;
            });
            return;
        }
        if (Main.panel.hover || this._edge.hover) {
            this._clearHideTimer();
            return;
        }
        this._clearShowTimer();
        this._scheduleHide();
    }

    _keepVisible() {
        return Main.panel.hover || this._edge?.hover || Main.overview.visible ||
            !!Main.panel.menuManager?.activeMenu;
    }

    _scheduleHide() {
        if (!this._enabled || this._hidden) return;
        this._clearHideTimer();
        this._hideTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, HIDE_DELAY_MS, () => {
            /* a menu may still be open — keep checking until it closes */
            if (this._keepVisible()) return GLib.SOURCE_CONTINUE;
            this._hideTimer = 0;
            this._hide(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _show() {
        this._clearHideTimer();
        if (!this._enabled || !this._hidden) return;
        this._hidden = false;
        const box = Main.layoutManager.panelBox;
        box.remove_all_transitions();
        box.ease({translation_y: 0, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        if (!this._keepVisible()) this._scheduleHide();
    }

    _hide(animate) {
        this._hidden = true;
        const box = Main.layoutManager.panelBox;
        box.remove_all_transitions();
        if (!animate) {
            box.translation_y = -box.height;
            return;
        }
        box.ease({translation_y: -box.height, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_IN_QUAD});
    }

    _clearShowTimer() {
        if (this._showTimer) { GLib.source_remove(this._showTimer); this._showTimer = 0; }
    }

    _clearHideTimer() {
        if (this._hideTimer) { GLib.source_remove(this._hideTimer); this._hideTimer = 0; }
    }

    _clearTimers() {
        this._clearShowTimer();
        this._clearHideTimer();
    }
}
