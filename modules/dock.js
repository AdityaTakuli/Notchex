import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as AppFavorites from 'resource:///org/gnome/shell/ui/appFavorites.js';
import * as BoxPointer from 'resource:///org/gnome/shell/ui/boxpointer.js';
import * as Dialog from 'resource:///org/gnome/shell/ui/dialog.js';
import * as DND from 'resource:///org/gnome/shell/ui/dnd.js';
import * as ModalDialog from 'resource:///org/gnome/shell/ui/modalDialog.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import {AppMenu} from 'resource:///org/gnome/shell/ui/appMenu.js';

import {Motion, Curve, animate, reducedMotion, FrameLoop} from './animations.js';
import {boxLayout, launchContext, isDesktopWindow, makeRect} from './compat.js';
import {GlassLayer} from './glass.js';

const HIDE_DELAY_MS = 650;
const GLASS_KEYS = ['glass-enabled', 'glass-dock', 'glass-blur'];
const TOOLTIP_DELAY_MS = 250;
const PREVIEW_DELAY_MS = 650;
const PREVIEW_LINGER_MS = 350;
const EDGE_PX = 2;
/* magnification falls off to nothing this many icon-slots away */
const MAG_REACH = 2.6;
/* how far (px) outside the Dock an icon must be dropped to unpin it */
const UNPIN_DISTANCE = 90;

const APP_WINDOW_TYPES = [Meta.WindowType.NORMAL, Meta.WindowType.DIALOG, Meta.WindowType.MODAL_DIALOG];

function appWindows(app) {
    return app.get_windows().filter(w => !w.skip_taskbar && !isDesktopWindow(w));
}

/* running apps worth showing: skip ones whose only windows are desktop
   surfaces (e.g. the Desktop Icons extension) */
function isDockableRunning(app) {
    const wins = app.get_windows();
    return wins.length === 0 || wins.some(w => !isDesktopWindow(w) && !w.skip_taskbar);
}

/* ———————————————————————————— item ———————————————————————————— */

/* One icon in the Dock: an app (pinned or running) or the Trash.

   Magnification works on two levels so it never re-rasterises icons:
   the icon is rendered once at its largest size and shown scaled down
   (a cheap transform), while its slot along the Dock's main axis grows
   with the scale so neighbours are pushed aside like on macOS. */
class DockItem {
    constructor(dock, {app = null, kind = 'app'}) {
        this.dock = dock;
        this.app = app;
        this.kind = kind;
        this.scale = 1;
        this.target = 1;

        this.actor = new St.Button({
            style_class: 'notchex-dock-item',
            reactive: true,
            can_focus: true,
            track_hover: true,
            button_mask: St.ButtonMask.ONE | St.ButtonMask.TWO | St.ButtonMask.THREE,
            accessible_name: this.title,
        });
        this.actor._delegate = this;

        const side = dock.side;
        this._box = boxLayout({vertical: side === 'bottom', style_class: 'notchex-dock-item-box'});
        this._holder = new St.Widget({style_class: 'notchex-dock-icon-holder'});
        this.icon = new St.Icon({style_class: 'notchex-dock-icon'});
        this._holder.add_child(this.icon);
        this._dots = boxLayout({vertical: side !== 'bottom', style_class: 'notchex-dock-dots',
            x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        if (side === 'left') {
            this._box.add_child(this._dots);
            this._box.add_child(this._holder);
        } else {
            this._box.add_child(this._holder);
            this._box.add_child(this._dots);
        }
        this.actor.set_child(this._box);

        this.actor.connect('clicked', (_b, button) => dock._onItemClicked(this, button));
        this.actor.connect('notify::hover', () => dock._onItemHover(this));
        this.actor.connect('button-press-event', (_a, event) => {
            if (event.get_button() === Clutter.BUTTON_SECONDARY) {
                dock._openItemMenu(this);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });

        if (kind === 'app') {
            this._windowsId = app.connect('windows-changed', () => {
                this.syncRunning();
                dock._queueIconGeometry();
            });
            this._draggable = DND.makeDraggable(this.actor, {timeoutThreshold: 200});
            this._draggable.connect('drag-begin', () => dock._onItemDragBegin(this));
            this._draggable.connect('drag-cancelled', () => dock._onItemDragCancelled(this));
            this._draggable.connect('drag-end', () => dock._onItemDragEnd(this));
        }
        this.refreshIcon();
        this.syncRunning();
    }

    get title() {
        if (this.kind === 'trash') return 'Trash';
        return this.app?.get_name() ?? '';
    }

    get id() {
        return this.kind === 'trash' ? '::trash' : this.app.get_id();
    }

    /* icons come from the shared IconManager (custom → macOS-style →
       GNOME); `animated` cross-fades when a better icon arrives later */
    refreshIcon(animated = false) {
        const d = this.dock;
        this.icon.icon_size = d.maxIconLogical;
        let next;
        if (this.kind === 'trash')
            next = Gio.ThemedIcon.new(d.trashCount > 0 ? 'user-trash-full' : 'user-trash');
        else
            next = d.icons?.getAppIcon(this.app).gicon ?? this.app.get_icon() ?? Gio.ThemedIcon.new('application-x-executable');
        if (animated && this.icon.mapped && !reducedMotion() && !next.equal(this.icon.gicon)) {
            this.icon.remove_all_transitions();
            this.icon.ease({
                opacity: 0, duration: 70, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    this.icon.gicon = next;
                    this.icon.ease({opacity: 255, duration: 110, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                },
            });
        } else {
            this.icon.gicon = next;
            this.icon.opacity = 255;
        }
        this.applyScale(this.scale);
    }

    syncRunning() {
        this._dots.destroy_all_children();
        if (!this.dock.showIndicators) return;
        let n = 0;
        if (this.kind === 'trash') {
            n = this.dock.trashCount > 0 ? 1 : 0;
        } else if (this.app.state !== Shell.AppState.STOPPED) {
            n = Math.max(1, Math.min(3, appWindows(this.app).length));
        }
        for (let i = 0; i < n; i++) {
            const dot = new St.Widget({style_class: 'notchex-dock-dot', opacity: 0});
            this._dots.add_child(dot);
            animate(dot, {opacity: 255}, Motion.NORMAL);
        }
    }

    /* scale: 1 … 1+magnification; px geometry comes from the Dock */
    applyScale(scale) {
        this.scale = scale;
        const d = this.dock;
        const base = d.basePx;
        const iconPx = d.maxIconPx;
        const grow = Math.round(base * scale);
        const iconScale = scale * base / iconPx;
        this.icon.set_pivot_point(...d.iconPivot);
        this.icon.set_scale(iconScale, iconScale);
        if (d.side === 'bottom') {
            this._holder.set_size(grow, base);
            this.icon.set_position(Math.round((grow - iconPx) / 2), base - iconPx);
        } else {
            this._holder.set_size(base, grow);
            const x = d.side === 'left' ? 0 : base - iconPx;
            this.icon.set_position(x, Math.round((grow - iconPx) / 2));
        }
    }

    /* short bounce on launch — runs alongside the launch, never delays it */
    bounce() {
        if (!this.dock.launchAnimation || reducedMotion()) return;
        const d = this.dock;
        const lift = Math.round(d.basePx * 0.35) * (d.side === 'right' ? -1 : 1);
        const prop = d.side === 'bottom' ? 'translation_y' : 'translation_x';
        const out = d.side === 'bottom' ? -Math.abs(lift) : lift;
        this.icon.remove_all_transitions();
        this.icon.ease({
            [prop]: out, duration: 150, mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => this.icon.ease({
                [prop]: 0, duration: 230, mode: Clutter.AnimationMode.EASE_OUT_BOUNCE,
            }),
        });
    }

    /* center along the main axis, in stage coordinates */
    mainCenter() {
        const [x, y] = this.actor.get_transformed_position();
        const [w, h] = this.actor.get_transformed_size();
        return this.dock.side === 'bottom' ? x + w / 2 : y + h / 2;
    }

    getDragActor() {
        return new St.Icon({gicon: this.icon.gicon, icon_size: this.dock.iconLogical});
    }

    getDragActorSource() {
        return this.icon;
    }

    destroy() {
        if (this._windowsId) this.app.disconnect(this._windowsId);
        this._windowsId = 0;
        this.actor.destroy();
    }
}

/* ———————————————————————————— dock ———————————————————————————— */

/* Floating macOS-style Dock.

   Apps come from GNOME's own favorites (the same list the Overview dash
   and Ubuntu Dock use) plus running apps; everything updates from Shell
   signals (favorites changed, app state, windows changed) — nothing polls.
   Magnification is driven by a frame-clock loop that only runs while the
   icons are moving toward their targets. */
export class Dock {
    constructor(settings, {onLaunch, icons} = {}) {
        this._settings = settings;
        this._onLaunch = onLaunch;
        this.icons = icons ?? null;
        this._enabled = false;
        this._items = new Map();
        this._revealed = true;
        this._timers = new Set();
        this._settingsId = settings.connect('changed', (_s, key) => this._onSettingChanged(key));
        this._sync();
    }

    destroy() {
        this.disable();
        if (this._settingsId) this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
    }

    _onSettingChanged(key) {
        if (key === 'dock-enabled') {
            this._sync();
            return;
        }
        if ((key.startsWith('dock-') || GLASS_KEYS.includes(key)) && this._enabled) {
            /* appearance/behaviour changed: rebuild cleanly */
            this.disable();
            this._sync();
        }
    }

    _sync() {
        if (this._settings.get_boolean('dock-enabled')) this.enable();
        else this.disable();
    }

    /* ——— configuration ——— */

    _readConfig() {
        const s = this._settings;
        const scale = St.ThemeContext.get_for_stage(global.stage).scale_factor || 1;
        this.side = ['bottom', 'left', 'right'].includes(s.get_string('dock-position'))
            ? s.get_string('dock-position') : 'bottom';
        this.iconLogical = s.get_int('dock-icon-size');
        this.mag = s.get_boolean('dock-magnify') && !reducedMotion()
            ? s.get_int('dock-magnification') / 100 : 0;
        this.maxIconLogical = Math.round(this.iconLogical * (1 + this.mag));
        this.basePx = Math.round(this.iconLogical * scale);
        this.maxIconPx = Math.round(this.maxIconLogical * scale);
        this.marginPx = Math.round(s.get_int('dock-edge-margin') * scale);
        this.hideMode = s.get_string('dock-autohide');
        this.showIndicators = s.get_boolean('dock-show-running');
        this.launchAnimation = s.get_boolean('dock-launch-animation');
        this.iconPivot = {bottom: [0.5, 1], left: [0, 0.5], right: [1, 0.5]}[this.side];
        this._uiScale = scale;
    }

    _glassOn() {
        return this._settings.get_boolean('glass-enabled') && this._settings.get_boolean('glass-dock');
    }

    /* `bar`: the Dock surface itself, which is frosted glass when enabled
       and so takes a lighter tint; tooltips/previews stay solid */
    _surfaceStyle(bar = false) {
        const s = this._settings;
        let theme = s.get_string('dock-theme');
        if (theme === 'auto') {
            try {
                const iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
                theme = iface.get_string('color-scheme') === 'prefer-light' ? 'light' : 'dark';
            } catch (_) { theme = 'dark'; }
        }
        let a = Math.max(0, Math.min(100, s.get_int('dock-opacity'))) / 100;
        if (bar && this._glassOn()) a *= 0.6;
        const r = s.get_int('dock-corner-radius');
        this.theme = theme;
        return theme === 'light'
            ? `background-color: rgba(246, 246, 248, ${a}); border: 1px solid rgba(0, 0, 0, 0.10); border-radius: ${r}px;`
            : `background-color: rgba(28, 28, 30, ${a}); border: 1px solid rgba(255, 255, 255, 0.12); border-radius: ${r}px;`;
    }

    /* ——— lifecycle ——— */

    enable() {
        if (this._enabled) return;
        this._enabled = true;
        this._readConfig();
        const vertical = this.side !== 'bottom';

        this._favorites = AppFavorites.getAppFavorites();
        this._appSystem = Shell.AppSystem.get_default();

        /* full-length, non-reactive strip along the edge; the Dock bar is
           centred inside it by the layout, so width changes from
           magnification never need manual repositioning */
        this.actor = new St.Widget({
            name: 'notchexDock',
            layout_manager: new Clutter.BinLayout(),
            reactive: false,
        });
        this._bar = boxLayout({
            vertical,
            style_class: `notchex-dock ${this.side} ${this._settings.get_string('dock-theme')}`,
            reactive: true,
            track_hover: true,
            x_align: this.side === 'bottom' ? Clutter.ActorAlign.CENTER
                : (this.side === 'left' ? Clutter.ActorAlign.START : Clutter.ActorAlign.END),
            y_align: this.side === 'bottom' ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER,
        });
        this._bar.set_style(this._surfaceStyle(true));
        this._bar.add_style_class_name(this.theme);
        this._bar._delegate = this;
        this.actor.add_child(this._bar);

        this._bar.connect('motion-event', (_a, event) => this._onMotion(event));
        this._bar.connect('notify::hover', () => this._onBarHover());
        this._bar.connect('button-press-event', (_a, event) => {
            if (event.get_button() !== Clutter.BUTTON_SECONDARY) return Clutter.EVENT_PROPAGATE;
            this._openDockMenu(event);
            return Clutter.EVENT_STOP;
        });

        Main.layoutManager.addChrome(this.actor, {affectsInputRegion: true, trackFullscreen: true});
        if (this._glassOn()) {
            this._glass = new GlassLayer(this._bar, {
                parent: Main.layoutManager.uiGroup,
                below: this.actor,
                blur: this._settings.get_int('glass-blur'),
            });
        }

        /* hot edge that brings a hidden Dock back */
        this._edge = new St.Widget({name: 'notchexDockEdge', reactive: true, track_hover: true});
        this._edge.connect('notify::hover', () => {
            if (this._edge.hover) this._reveal(true);
            else this._scheduleHide();
        });
        Main.layoutManager.addChrome(this._edge, {affectsInputRegion: true, trackFullscreen: true});

        /* reserve space for an always-visible Dock */
        if (this.hideMode === 'always') {
            this._strut = new Clutter.Actor({name: 'notchexDockStrut', reactive: false});
            Main.layoutManager.addChrome(this._strut, {affectsStruts: true, affectsInputRegion: false,
                trackFullscreen: true});
        }

        this._menuManager = new PopupMenu.PopupMenuManager(this._bar);
        this._loop = new FrameLoop(this._bar, dt => this._stepMagnification(dt));

        this._favorites.connectObject('changed', () => this._rebuildItems(), this);
        this.icons?.connectObject('icon-changed', (_m, id) => {
            for (const item of this._allItems()) {
                if (item.kind === 'app' && (id === '*' || item.id === id)) item.refreshIcon(true);
            }
        }, this);
        this._appSystem.connectObject(
            'installed-changed', () => this._rebuildItems(),
            'app-state-changed', () => this._rebuildItems(),
            this);
        Main.layoutManager.connectObject('monitors-changed', () => this._relayout(), this);
        Main.overview.connectObject(
            'showing', () => {
                /* the Overview dash may not exist yet when we start at login */
                this._hideOverviewDash(true);
                this._reveal(true);
            },
            'hiding', () => this._updateAutohide(),
            'item-drag-begin', () => this._onExternalDragBegin(),
            'item-drag-end', () => this._onExternalDragEnd(),
            'item-drag-cancelled', () => this._onExternalDragEnd(),
            this);
        this._hideOverviewDash(true);

        const queue = () => this._queueAutohide();
        global.window_manager.connectObject('map', queue, 'destroy', queue, 'minimize', queue,
            'unminimize', queue, 'switch-workspace', queue, 'size-change', queue, this);
        global.display.connectObject('restacked', queue, 'grab-op-end', queue,
            'notify::focus-window', () => this._trackFocusWindow(), this);
        this._trackFocusWindow();

        if (this._settings.get_boolean('dock-show-trash')) this._watchTrash();

        this._rebuildItems();
        this._relayout();
        this._reveal(false, false);
        this._bar.opacity = 0;
        this._queueAutohide();
        this._later(60, () => this._updateAutohide(true));
    }

    disable() {
        if (!this._enabled) return;
        this._enabled = false;
        for (const id of this._timers) GLib.source_remove(id);
        this._timers.clear();
        this._hideTooltip();
        this._hidePreviews(true);
        this._clearPlaceholder();
        this._updateIconGeometry(true);
        if (this._dragMonitor) {
            DND.removeDragMonitor(this._dragMonitor);
            this._dragMonitor = null;
        }
        this._loop?.destroy();
        this._loop = null;
        this._favorites?.disconnectObject(this);
        this.icons?.disconnectObject(this);
        this._appSystem?.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        Main.overview.disconnectObject(this);
        global.window_manager.disconnectObject(this);
        global.display.disconnectObject(this);
        this._focusWindow?.disconnectObject(this);
        this._focusWindow = null;
        this._trashMonitor?.cancel();
        this._trashMonitor = null;
        this._trashCancel?.cancel();
        this._trashCancel = null;
        this._hideOverviewDash(false);
        this._glass?.destroy();
        this._glass = null;
        this._menu?.destroy();
        this._menu = null;
        for (const item of this._items.values()) item.destroy();
        this._items.clear();
        this._orderSig = null;
        this._trashItem?.destroy();
        this._trashItem = null;
        for (const a of [this._strut, this._edge, this.actor]) {
            if (!a) continue;
            try { Main.layoutManager.removeChrome(a); } catch (_) {}
            a.destroy();
        }
        this._strut = this._edge = this.actor = this._bar = null;
    }

    _later(ms, cb) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timers.delete(id);
            if (this._enabled) cb();
            return GLib.SOURCE_REMOVE;
        });
        this._timers.add(id);
        return id;
    }

    _cancel(id) {
        if (id && this._timers.has(id)) {
            GLib.source_remove(id);
            this._timers.delete(id);
        }
        return 0;
    }

    /* GNOME's Overview has its own dash at the bottom; with the Dock on,
       that would be a second dock, so fold it away (restored on disable). */
    _hideOverviewDash(hide) {
        const dash = Main.overview.dash;
        if (!dash) return;
        if (hide && this.side === 'bottom') {
            this._dashWasVisible ??= dash.visible;
            dash.hide();
            dash.set_height(0);
        } else if (!hide && this._dashWasVisible !== undefined) {
            dash.set_height(-1);
            dash.visible = this._dashWasVisible;
            this._dashWasVisible = undefined;
        }
    }

    /* ——— geometry ——— */

    get thicknessPx() {
        return this.basePx + Math.round(14 * this._uiScale);
    }

    _relayout() {
        if (!this._enabled) return;
        this._queueIconGeometry();
        const mon = Main.layoutManager.primaryMonitor;
        if (!mon) return;
        const headroom = Math.round(this.basePx * this.mag) + Math.round(24 * this._uiScale);
        const thick = this.thicknessPx + this.marginPx + headroom;
        const m = this.marginPx;
        if (this.side === 'bottom') {
            this.actor.set_position(mon.x, mon.y + mon.height - thick);
            this.actor.set_size(mon.width, thick);
            this._bar.set_style(`${this._surfaceStyle(true)} margin-bottom: ${m / this._uiScale}px;`);
            this._edge.set_position(mon.x, mon.y + mon.height - EDGE_PX);
            this._edge.set_size(mon.width, EDGE_PX);
            this._strut?.set_position(mon.x, mon.y + mon.height - this.thicknessPx - m);
            this._strut?.set_size(mon.width, this.thicknessPx + m);
        } else {
            const left = this.side === 'left';
            const x = left ? mon.x : mon.x + mon.width - thick;
            this.actor.set_position(x, mon.y);
            this.actor.set_size(thick, mon.height);
            this._bar.set_style(`${this._surfaceStyle(true)} margin-${this.side}: ${m / this._uiScale}px;`);
            this._edge.set_position(left ? mon.x : mon.x + mon.width - EDGE_PX, mon.y);
            this._edge.set_size(EDGE_PX, mon.height);
            this._strut?.set_position(left ? mon.x : mon.x + mon.width - this.thicknessPx - m, mon.y);
            this._strut?.set_size(this.thicknessPx + m, mon.height);
        }
    }

    /* the Dock bar's resting rectangle (for "intelligent" hiding) */
    _restRect() {
        const [bx, by] = this._bar.get_transformed_position();
        const [bw, bh] = this._bar.get_transformed_size();
        const tx = this._bar.translation_x, ty = this._bar.translation_y;
        return {x: bx - tx, y: by - ty, width: bw, height: bh};
    }

    /* ——— items ——— */

    _rebuildItems() {
        if (!this._enabled) return;
        const favs = this._favorites.getFavorites();
        const favIds = new Set(favs.map(a => a.get_id()));
        const running = this._appSystem.get_running()
            .filter(a => !favIds.has(a.get_id()) && isDockableRunning(a));
        const order = [...favs, ...running];

        /* app-state-changed fires often; only restructure when the set or
           order of icons actually changes — otherwise just refresh dots so
           hover/magnification state is left alone */
        const separators = this._settings.get_boolean('dock-separators');
        const showTrash = this._settings.get_boolean('dock-show-trash');
        const sig = `${order.map(a => a.get_id()).join('|')}#${favs.length}#${separators}#${showTrash}`;
        if (sig === this._orderSig) {
            for (const item of this._items.values()) item.syncRunning();
            return;
        }
        this._orderSig = sig;

        const keep = new Set(order.map(a => a.get_id()));
        for (const [id, item] of this._items) {
            if (!keep.has(id)) {
                item.destroy();
                this._items.delete(id);
            }
        }
        this._bar.remove_all_children();
        order.forEach((app, i) => {
            if (separators && i === favs.length && running.length && favs.length)
                this._bar.add_child(this._separator());
            let item = this._items.get(app.get_id());
            if (!item) {
                item = new DockItem(this, {app});
                this._items.set(app.get_id(), item);
            } else {
                item.syncRunning();
            }
            this._bar.add_child(item.actor);
        });
        if (showTrash) {
            if (separators && order.length) this._bar.add_child(this._separator());
            this._trashItem ??= new DockItem(this, {kind: 'trash'});
            this._bar.add_child(this._trashItem.actor);
        }
        this._baseline = null;
        this._resetMagnification();
        this._queueIconGeometry();
    }

    _separator() {
        return new St.Widget({
            style_class: `notchex-dock-separator ${this.side === 'bottom' ? 'vertical' : 'horizontal'}`,
            y_align: Clutter.ActorAlign.CENTER,
            x_align: Clutter.ActorAlign.CENTER,
        });
    }

    _allItems() {
        return this._bar.get_children().map(a => a._delegate).filter(d => d instanceof DockItem);
    }

    /* ——— magnification ——— */

    _onMotion(event) {
        if (!this.mag || this._dragging) return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const p = this.side === 'bottom' ? x : y;
        const items = this._allItems();
        /* distances use the resting layout so the icons don't feed back
           into their own targets as they grow */
        if (!this._baseline || this._baseline.length !== items.length)
            this._baseline = items.map(it => it.mainCenter());
        const slot = this.basePx * 1.15;
        items.forEach((it, i) => {
            const d = Math.abs(p - this._baseline[i]) / slot;
            const influence = d >= MAG_REACH ? 0 : (Math.cos(Math.PI * d / MAG_REACH) + 1) / 2;
            it.target = 1 + this.mag * influence;
        });
        this._loop.start();
        return Clutter.EVENT_PROPAGATE;
    }

    /* Tell mutter where each app's icon sits, so minimizing a window
       shrinks it into its own Dock icon (GNOME's minimize animation and
       effects like Magic Lamp use this). Measured at the resting layout. */
    _queueIconGeometry() {
        if (!this._enabled || this._geomTimer) return;
        this._geomTimer = this._later(120, () => {
            this._geomTimer = 0;
            this._updateIconGeometry();
        });
    }

    _updateIconGeometry(clear = false) {
        const mon = Main.layoutManager.primaryMonitor;
        for (const it of this._allItems()) {
            if (it.kind !== 'app') continue;
            let rect = null;
            if (!clear && mon) {
                const [tx, ty] = it._holder.get_transformed_position();
                let [w, h] = it._holder.get_transformed_size();
                if (!(w > 0 && h > 0)) continue;
                let x = tx - this._bar.translation_x;
                let y = ty - this._bar.translation_y;
                /* The dock floats a margin away from the screen edge, but
                   minimize effects decide which edge to shrink toward from
                   the rect touching it — Magic Lamp otherwise picks "top"
                   and pours the window into the notch. Stretch the rect
                   out to the dock's edge: it still sits under the icon. */
                if (this.side === 'bottom') {
                    h = mon.y + mon.height - y;
                } else if (this.side === 'left') {
                    w += x - mon.x;
                    x = mon.x;
                } else {
                    w = mon.x + mon.width - x;
                }
                rect = makeRect(x, y, w, h);
            }
            for (const win of it.app.get_windows()) {
                try { win.set_icon_geometry(rect); } catch (_) {}
            }
        }
    }

    _stepMagnification(dt) {
        const k = 1 - Math.exp(-dt * 22);
        let moving = false;
        for (const it of this._allItems()) {
            let s = it.scale + (it.target - it.scale) * k;
            if (Math.abs(it.target - s) < 0.002) s = it.target;
            else moving = true;
            if (s !== it.scale) it.applyScale(s);
        }
        if (!moving) this._queueIconGeometry();
        return moving;
    }

    _resetMagnification() {
        for (const it of this._allItems()) it.target = 1;
        this._loop?.start();
        this._baseline = null;
    }

    /* ——— hover / reveal ——— */

    _onBarHover() {
        if (this._bar.hover) {
            this._reveal(true);
            if (!this._baselineFresh) this._baseline = null;
        } else {
            this._resetMagnification();
            this._scheduleHide();
        }
    }

    _keepVisible() {
        return this._bar?.hover || this._edge?.hover || this._menu?.isOpen || this._previews ||
            this._dragging || this._externalDrag || Main.overview.visible;
    }

    _reveal(on, animate_ = true) {
        if (!this._enabled) return;
        this._hideTimer = this._cancel(this._hideTimer);
        if (on === this._revealed && animate_) return;
        this._revealed = on;
        const bar = this._bar;
        const [w, h] = bar.get_size();
        const off = {bottom: [0, h + this.marginPx + 12], left: [-(w + this.marginPx + 12), 0],
            right: [w + this.marginPx + 12, 0]}[this.side];
        bar.set_pivot_point(0.5, 0.5);
        const props = on
            ? {translation_x: 0, translation_y: 0, opacity: 255, scale_x: 1, scale_y: 1}
            : {translation_x: off[0], translation_y: off[1], opacity: 0, scale_x: 0.97, scale_y: 0.97};
        if (!animate_) {
            bar.remove_all_transitions();
            bar.set(props);
            return;
        }
        animate(bar, props, on ? Motion.NORMAL : Motion.FAST, on ? Curve.OUT : Curve.IN);
    }

    _scheduleHide() {
        if (!this._enabled || this.hideMode === 'always') return;
        this._hideTimer = this._cancel(this._hideTimer);
        this._hideTimer = this._later(HIDE_DELAY_MS, () => {
            this._hideTimer = 0;
            this._updateAutohide();
        });
    }

    _queueAutohide() {
        if (this._autohideIdle || !this._enabled) return;
        this._autohideIdle = this._later(50, () => {
            this._autohideIdle = 0;
            this._updateAutohide();
        });
    }

    _updateAutohide(force = false) {
        if (!this._enabled) return;
        let show;
        if (this._keepVisible()) show = true;
        else if (this.hideMode === 'always') show = true;
        else if (this.hideMode === 'autohide') show = false;
        else show = !this._windowOverlaps();
        if (force) this._revealed = !show;
        this._reveal(show);
    }

    _windowOverlaps() {
        const r = this._restRect();
        if (r.width <= 0 || r.height <= 0) return false;
        const ws = global.workspace_manager.get_active_workspace();
        return ws.list_windows().some(w => {
            if (isDesktopWindow(w)) return false;
            if (w.minimized || !w.showing_on_its_workspace() || w.skip_taskbar) return false;
            if (!APP_WINDOW_TYPES.includes(w.get_window_type())) return false;
            const f = w.get_frame_rect();
            return f.x < r.x + r.width && f.x + f.width > r.x && f.y < r.y + r.height && f.y + f.height > r.y;
        });
    }

    _trackFocusWindow() {
        this._focusWindow?.disconnectObject(this);
        this._focusWindow = global.display.focus_window;
        this._focusWindow?.connectObject(
            'position-changed', () => this._queueAutohide(),
            'size-changed', () => this._queueAutohide(),
            this);
        this._queueAutohide();
    }

    /* ——— clicks ——— */

    _onItemClicked(item, button) {
        this._hideTooltip();
        if (item.kind === 'trash') {
            this._openTrash();
            return;
        }
        const app = item.app;
        if (button === Clutter.BUTTON_MIDDLE) {
            app.open_new_window(-1);
            item.bounce();
            return;
        }
        if (button !== Clutter.BUTTON_PRIMARY) return;
        const wins = appWindows(app);
        if (wins.length === 0) {
            item.bounce();
            app.activate();
            this._onLaunch?.(app);
            return;
        }
        if (wins.length === 1) {
            Main.activateWindow(wins[0]);
            return;
        }
        this._showPreviews(item, true);
    }

    _onItemHover(item) {
        this._tooltipTimer = this._cancel(this._tooltipTimer);
        this._previewTimer = this._cancel(this._previewTimer);
        if (item.actor.hover && !this._dragging) {
            if (this._settings.get_boolean('dock-show-tooltips') && !this._previews)
                this._tooltipTimer = this._later(TOOLTIP_DELAY_MS, () => this._showTooltip(item));
            if (item.kind === 'app' && this._settings.get_boolean('dock-show-previews') &&
                appWindows(item.app).length > 0) {
                this._previewTimer = this._later(PREVIEW_DELAY_MS, () => {
                    if (item.actor.hover) this._showPreviews(item, false);
                });
            } else if (this._previews && this._previews._item !== item) {
                this._hidePreviews();
            }
        } else {
            this._hideTooltip();
            if (this._previews) this._schedulePreviewHide();
        }
    }

    /* ——— tooltip ——— */

    _showTooltip(item) {
        this._hideTooltip();
        if (!item.actor.hover || this._previews) return;
        let text = item.title;
        if (item.kind === 'trash' && this.trashCount > 0)
            text = `Trash — ${this.trashCount} item${this.trashCount === 1 ? '' : 's'}`;
        const tip = new St.Label({text, style_class: `notchex-dock-tooltip ${this.theme}`, opacity: 0});
        Main.layoutManager.uiGroup.add_child(tip);
        this._tooltip = tip;
        this._placeFloating(tip, item, 10 + this.basePx * this.mag);
        animate(tip, {opacity: 255}, Motion.HOVER);
    }

    _hideTooltip() {
        this._tooltipTimer = this._cancel(this._tooltipTimer);
        this._tooltip?.destroy();
        this._tooltip = null;
    }

    /* position a floating actor next to an item, on the inner side */
    _placeFloating(actor, item, gap) {
        const [ix, iy] = item.actor.get_transformed_position();
        const [iw, ih] = item.actor.get_transformed_size();
        const [, natW] = actor.get_preferred_width(-1);
        const [, natH] = actor.get_preferred_height(natW);
        const mon = Main.layoutManager.primaryMonitor;
        let x, y;
        /* measure against the bar's resting place — it may still be
           sliding in */
        const r = this._restRect();
        if (this.side === 'bottom') {
            x = ix - this._bar.translation_x + iw / 2 - natW / 2;
            y = r.y - natH - gap;
        } else {
            y = iy - this._bar.translation_y + ih / 2 - natH / 2;
            x = this.side === 'left' ? r.x + r.width + gap : r.x - natW - gap;
        }
        x = Math.max(mon.x + 8, Math.min(mon.x + mon.width - natW - 8, x));
        y = Math.max(mon.y + 8, Math.min(mon.y + mon.height - natH - 8, y));
        actor.set_position(Math.round(x), Math.round(y));
    }

    /* ——— window previews ——— */

    _showPreviews(item, sticky) {
        this._hidePreviews(true);
        this._hideTooltip();
        const wins = appWindows(item.app);
        if (!wins.length) return;
        const box = boxLayout({
            vertical: this.side !== 'bottom',
            style_class: `notchex-dock-previews ${this.theme}`,
            reactive: true, track_hover: true, opacity: 0,
        });
        box.set_style(this._surfaceStyle());
        const maxW = Math.round(220 * this._uiScale), maxH = Math.round(140 * this._uiScale);
        for (const win of wins.slice(0, 8)) {
            const actor = win.get_compositor_private();
            if (!actor) continue;
            const btn = new St.Button({style_class: 'notchex-dock-preview', can_focus: true,
                reactive: true, track_hover: true});
            const col = boxLayout({vertical: true, style_class: 'notchex-dock-preview-col'});
            const [aw, ah] = actor.get_size();
            const f = Math.min(maxW / Math.max(1, aw), maxH / Math.max(1, ah), 1);
            const frame = new St.Widget({style_class: 'notchex-dock-preview-frame',
                width: Math.round(aw * f), height: Math.round(ah * f)});
            const clone = new Clutter.Clone({source: actor, width: Math.round(aw * f), height: Math.round(ah * f)});
            frame.add_child(clone);
            col.add_child(frame);
            const title = new St.Label({text: win.get_title() ?? item.title, style_class: 'notchex-dock-preview-title'});
            title.clutter_text.ellipsize = 3;
            title.set_style(`max-width: ${Math.round(maxW / this._uiScale)}px;`);
            col.add_child(title);
            btn.set_child(col);
            btn.connect('clicked', () => {
                this._hidePreviews();
                Main.activateWindow(win);
            });
            box.add_child(btn);
        }
        box._item = item;
        box.connect('notify::hover', () => {
            if (box.hover) this._previewHide = this._cancel(this._previewHide);
            else if (!sticky || !item.actor.hover) this._schedulePreviewHide();
        });
        Main.layoutManager.addTopChrome(box);
        this._previews = box;
        this._placeFloating(box, item, 12 + this.basePx * this.mag * 0.5);
        animate(box, {opacity: 255}, Motion.FAST);
    }

    _schedulePreviewHide() {
        this._previewHide = this._cancel(this._previewHide);
        this._previewHide = this._later(PREVIEW_LINGER_MS, () => {
            this._previewHide = 0;
            const p = this._previews;
            if (p && !p.hover && !p._item.actor.hover) this._hidePreviews();
        });
    }

    _hidePreviews(immediate = false) {
        this._previewHide = this._cancel(this._previewHide);
        const p = this._previews;
        if (!p) return;
        this._previews = null;
        const done = () => {
            try { Main.layoutManager.removeChrome(p); } catch (_) {}
            p.destroy();
        };
        if (immediate || reducedMotion()) done();
        else p.ease({opacity: 0, duration: Motion.FAST, mode: Curve.IN, onComplete: done});
        this._scheduleHide();
    }

    /* ——— menus ——— */

    _menuSide() {
        return {bottom: St.Side.BOTTOM, left: St.Side.LEFT, right: St.Side.RIGHT}[this.side];
    }

    _openMenu(menu) {
        this._hideTooltip();
        this._hidePreviews(true);
        this._menu?.destroy();
        this._menu = menu;
        this._menuManager.addMenu(menu);
        Main.uiGroup.add_child(menu.actor);
        menu.connect('open-state-changed', (_m, open) => {
            if (open) return;
            this._later(0, () => {
                if (this._menu === menu) this._menu = null;
                menu.destroy();
                this._updateAutohide();
            });
        });
        menu.open(BoxPointer.PopupAnimation.FULL);
    }

    _openItemMenu(item) {
        if (item.kind === 'trash') {
            const menu = new PopupMenu.PopupMenu(item.actor, 0.5, this._menuSide());
            menu.addAction('Open Trash', () => this._openTrash());
            const empty = menu.addAction('Empty Trash…', () => this._confirmEmptyTrash());
            empty.setSensitive(this.trashCount > 0);
            this._openMenu(menu);
            return;
        }
        /* GNOME's own app menu: app actions (New Window, New Private
           Window…), open windows, Pin/Unpin, Show Details, Quit */
        const menu = new AppMenu(item.actor, this._menuSide(), {
            favoritesSection: true,
            showSingleWindows: true,
        });
        menu.setApp(item.app);
        this._addIconItems(menu, item.app);
        this._openMenu(menu);
    }

    /* "Customize Icon…" plus, for downloaded artwork, the creator credit
       (attribution lives here and in preferences, never on the Dock) */
    _addIconItems(menu, app) {
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const id = app.get_id();
        const icon = this.icons?.getAppIcon(app);
        if (icon?.source === 'macosicons') {
            const meta = this.icons.metaFor(id) ?? {};
            const credit = menu.addAction(
                `Icon by ${meta.credit || 'unknown creator'} · macOSicons.com`, () => {
                    const url = meta.creditUrl || 'https://macosicons.com';
                    try { Gio.AppInfo.launch_default_for_uri(url, launchContext()); } catch (_) {}
                });
            credit.label.add_style_class_name('notchex-dock-credit');
        }
        menu.addAction('Customize Icon…', () => {
            this._settings.set_string('icon-customize-request', id);
            try {
                Main.extensionManager.openExtensionPrefs('notchex@adityatakuli', '', {});
            } catch (e) { logError(e, 'notchex:dock:prefs'); }
        });
    }

    _openDockMenu(event) {
        const [x, y] = event.get_coords();
        this._menuAnchor ??= new St.Widget({width: 1, height: 1, opacity: 0});
        if (!this._menuAnchor.get_parent()) Main.uiGroup.add_child(this._menuAnchor);
        this._menuAnchor.set_position(x, y);
        const menu = new PopupMenu.PopupMenu(this._menuAnchor, 0.5, this._menuSide());
        const s = this._settings;
        const autohide = new PopupMenu.PopupSwitchMenuItem('Auto-hide', s.get_string('dock-autohide') !== 'always');
        autohide.connect('toggled', (_i, on) => s.set_string('dock-autohide', on ? 'intelligent' : 'always'));
        menu.addMenuItem(autohide);
        const magnify = new PopupMenu.PopupSwitchMenuItem('Magnification', s.get_boolean('dock-magnify'));
        magnify.connect('toggled', (_i, on) => s.set_boolean('dock-magnify', on));
        menu.addMenuItem(magnify);
        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        menu.addAction('Show Applications', () => Main.overview.showApps());
        menu.addAction('Dock Settings…', () => {
            try {
                Main.extensionManager.openExtensionPrefs('notchex@adityatakuli', '', {});
            } catch (e) { logError(e, 'notchex:dock:prefs'); }
        });
        this._openMenu(menu);
    }

    /* ——— trash ——— */

    _watchTrash() {
        this.trashCount = 0;
        const trash = Gio.File.new_for_uri('trash:///');
        try {
            this._trashMonitor = trash.monitor_directory(Gio.FileMonitorFlags.NONE, null);
            this._trashMonitor.connect('changed', () => this._refreshTrash());
        } catch (_) {}
        this._refreshTrash();
    }

    _refreshTrash() {
        this._trashCancel?.cancel();
        this._trashCancel = new Gio.Cancellable();
        Gio.File.new_for_uri('trash:///').query_info_async('trash::item-count',
            Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, this._trashCancel, (f, res) => {
                let count = 0;
                try { count = f.query_info_finish(res).get_attribute_uint32('trash::item-count'); } catch (_) { return; }
                if (!this._enabled || count === this.trashCount) return;
                this.trashCount = count;
                this._trashItem?.refreshIcon();
                this._trashItem?.syncRunning();
            });
    }

    _openTrash() {
        try {
            Gio.AppInfo.launch_default_for_uri('trash:///', launchContext());
        } catch (e) { logError(e, 'notchex:dock:trash'); }
    }

    _confirmEmptyTrash() {
        const dialog = new ModalDialog.ModalDialog({destroyOnClose: true});
        dialog.contentLayout.add_child(new Dialog.MessageDialogContent({
            title: 'Empty Trash?',
            description: `${this.trashCount} item${this.trashCount === 1 ? '' : 's'} will be permanently deleted.`,
        }));
        dialog.addButton({label: 'Cancel', action: () => dialog.close(), key: Clutter.KEY_Escape});
        dialog.addButton({
            label: 'Empty Trash',
            action: () => {
                dialog.close();
                const gio = GLib.find_program_in_path('gio');
                if (!gio) return;
                try {
                    Gio.Subprocess.new([gio, 'trash', '--empty'], Gio.SubprocessFlags.STDERR_SILENCE);
                } catch (e) { logError(e, 'notchex:dock:empty-trash'); }
            },
            default: true,
        });
        dialog.open();
    }

    /* ——— drag & drop ——— */

    _onItemDragBegin(item) {
        this._dragging = item;
        this._dropAccepted = false;
        this._hideTooltip();
        this._hidePreviews(true);
        this._resetMagnification();
        item.actor.opacity = 80;
        this._addDragMonitor();
    }

    _onItemDragCancelled(item) {
        item.actor.opacity = 255;
    }

    _onItemDragEnd(item) {
        item.actor.opacity = 255;
        this._dragging = null;
        this._removeDragMonitor();
        this._clearPlaceholder();
        if (!this._dropAccepted && this._favorites.isFavorite(item.id) && this._farFromDock())
            this._favorites.removeFavorite(item.id);
        this._updateAutohide();
    }

    _onExternalDragBegin() {
        this._externalDrag = true;
        this._reveal(true);
        this._addDragMonitor();
    }

    _onExternalDragEnd() {
        this._externalDrag = false;
        this._removeDragMonitor();
        this._clearPlaceholder();
        this._updateAutohide();
    }

    _addDragMonitor() {
        if (this._dragMonitor) return;
        this._dragMonitor = {
            dragMotion: event => {
                const target = event.targetActor;
                if (!target || !this._bar?.contains(target)) this._clearPlaceholder();
                return DND.DragMotionResult.CONTINUE;
            },
        };
        DND.addDragMonitor(this._dragMonitor);
    }

    _removeDragMonitor() {
        if (!this._dragMonitor) return;
        DND.removeDragMonitor(this._dragMonitor);
        this._dragMonitor = null;
    }

    _farFromDock() {
        const [px, py] = global.get_pointer();
        const r = this._restRect();
        const dx = Math.max(r.x - px, 0, px - (r.x + r.width));
        const dy = Math.max(r.y - py, 0, py - (r.y + r.height));
        return Math.hypot(dx, dy) > UNPIN_DISTANCE * this._uiScale;
    }

    _dragApp(source) {
        const app = source?.app ?? null;
        return app && typeof app.get_id === 'function' ? app : null;
    }

    /* index among pinned apps where a drop at stage point (x, y) lands */
    _dropIndex(x, y) {
        const favs = this._favorites.getFavorites();
        const pinned = this._allItems().filter(it => it.kind === 'app' && this._favorites.isFavorite(it.id));
        const p = this.side === 'bottom' ? x : y;
        let idx = 0;
        for (const it of pinned) {
            if (p > it.mainCenter()) idx++;
        }
        return Math.min(idx, favs.length);
    }

    /* DND delegate API (called by GNOME's DND for the bar) */
    handleDragOver(source) {
        const app = this._dragApp(source);
        if (!app) return DND.DragMotionResult.NO_DROP;
        /* x/y are relative to the target actor; the index math is in stage space */
        const [sx, sy] = global.get_pointer();
        this._showPlaceholder(this._dropIndex(sx, sy));
        return this._favorites.isFavorite(app.get_id())
            ? DND.DragMotionResult.MOVE_DROP : DND.DragMotionResult.COPY_DROP;
    }

    acceptDrop(source) {
        const app = this._dragApp(source);
        if (!app) return false;
        const pos = this._placeholderIndex ?? this._favorites.getFavorites().length;
        const id = app.get_id();
        this._clearPlaceholder();
        this._dropAccepted = true;
        const favs = this._favorites.getFavorites().map(a => a.get_id());
        if (favs.includes(id)) {
            const from = favs.indexOf(id);
            this._favorites.moveFavoriteToPos(id, from < pos ? pos - 1 : pos);
        } else {
            this._favorites.addFavoriteAtPos(id, pos);
        }
        return true;
    }

    _showPlaceholder(index) {
        if (this._placeholderIndex === index && this._placeholder) return;
        this._clearPlaceholder();
        this._placeholderIndex = index;
        const ph = new St.Widget({style_class: 'notchex-dock-placeholder'});
        if (this.side === 'bottom') ph.set_size(0, this.basePx);
        else ph.set_size(this.basePx, 0);
        const pinned = this._allItems().filter(it => it.kind === 'app' && this._favorites.isFavorite(it.id));
        const before = pinned[index]?.actor ?? null;
        if (before) this._bar.insert_child_below(ph, before);
        else if (pinned.length) this._bar.insert_child_above(ph, pinned[pinned.length - 1].actor);
        else this._bar.insert_child_at_index(ph, 0);
        this._placeholder = ph;
        const size = this.basePx + Math.round(8 * this._uiScale);
        animate(ph, this.side === 'bottom' ? {width: size} : {height: size}, Motion.FAST);
        this._baseline = null;
    }

    _clearPlaceholder() {
        this._placeholderIndex = null;
        this._placeholder?.destroy();
        this._placeholder = null;
    }
}
