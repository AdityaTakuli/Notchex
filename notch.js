import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import Meta from 'gi://Meta';
import Shell from 'gi://Shell';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {SystemMonitor}     from './modules/system.js';
import {NotificationPeek}  from './modules/notifications.js';
import {CalendarPeek}      from './modules/calendar.js';
import {MprisWatcher}      from './modules/mpris.js';
import {Notes}             from './modules/notes.js';
import {Weather}           from './modules/weather.js';
import {Pomodoro}          from './modules/pomodoro.js';
import {QuickHub}          from './modules/quick.js';
import {Stats}             from './modules/stats.js';
import {ClaudeUsage}       from './modules/claudeusage.js';
import {VolumeWatcher}     from './modules/volume.js';
import {BrightnessWatcher} from './modules/brightness.js';
import {BatteryWatcher}    from './modules/battery.js';
import {BluetoothWatcher}  from './modules/bluetooth.js';
import {EventManager, Priority} from './modules/events.js';
import {OsdInterceptor}    from './modules/osd.js';
import {renderMediaView, artTile, Equalizer} from './modules/media.js';
import {resolveArt, shutdownArtwork} from './modules/artwork.js';
import * as Activities     from './modules/activities.js';
import {TopBarAutoHide}    from './modules/topbar.js';
import {takeScreenshot}    from './modules/screenshot.js';

const SPEED = {slow: 1.45, normal: 1.0, fast: 0.65};
const MAX_EXPANDED_H = 640;
const HOVER_EXTRA_MAX_W = 460;
const ELLIPSIZE_END = 3; /* Pango.EllipsizeMode.END */

/* Concave fillet joining the notch to the top screen edge (logical px). */
const EAR_SIZE = 8;

function parseColor(str) {
    const m = str.match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)/);
    if (m) return [m[1] / 255, m[2] / 255, m[3] / 255, m[4] === undefined ? 1 : Number(m[4])];
    const h = str.match(/^#([0-9a-f]{6})([0-9a-f]{2})?$/i);
    if (h) {
        const n = parseInt(h[1], 16);
        return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255, h[2] ? parseInt(h[2], 16) / 255 : 1];
    }
    return [0, 0, 0, 1];
}

const TAB_IDS = ['system', 'media', 'calendar', 'tasks', 'weather', 'pomodoro', 'notes', 'stats', 'quick', 'claude'];

/* Settings that only change geometry / styling. */
const APPEARANCE_KEYS = new Set([
    'collapsed-width', 'collapsed-height', 'expanded-width', 'expanded-height',
    'corner-radius', 'border-width', 'top-margin', 'island-style',
    'bg-color', 'text-color', 'accent-color', 'border-color', 'shadow-color', 'enable-shadow',
    'battery-charging-color', 'battery-normal-color', 'battery-low-color',
]);

/* The island is one rounded surface (`_bg`) whose size and position are
   animated directly. Content layers live in `_clip`, which clips them to
   the island's box while the surface grows/shrinks; content widths are
   fixed at their *target* width so nothing reflows mid-animation.

   States: idle pill → (hover preview) → expanded dashboard, plus
   transient "events" (media, volume, battery, …) arbitrated by
   EventManager. The root actor itself paints nothing — that is what
   removes the rectangular corners the old design had. */
export const Notch = GObject.registerClass(
class Notch extends St.Widget {
    _init(extension) {
        super._init({
            name: 'notchex',
            style_class: 'notchex',
            reactive: true,
            track_hover: true,
            can_focus: false,
            layout_manager: new Clutter.BinLayout(),
        });

        this._extension = extension;
        this._settings  = extension.getSettings();
        this._themeContext = St.ThemeContext.get_for_stage(global.stage);

        this._expanded    = false;
        this._hoverState  = false;
        this._eventActive = false;
        this._hoverTimeout    = 0;
        this._collapseTimeout = 0;
        this._clockTimer      = 0;
        this._phaseTimers = new Set();
        this._activeTab = 'system';
        this._calNotified = new Map();

        this._loadDims();
        this._buildLayers();
        this._setupKeybinding();
        this._hideDateMenuIfRequested();

        const volume     = new VolumeWatcher();
        const brightness = new BrightnessWatcher();
        const bluetooth  = new BluetoothWatcher();
        this._modules = {
            system:        new SystemMonitor(this._settings),
            notifications: new NotificationPeek(this._settings),
            calendar:      new CalendarPeek(this._settings),
            mpris:         new MprisWatcher(),
            notes:         new Notes(this._settings),
            weather:       new Weather(this._settings),
            pomodoro:      new Pomodoro(this._settings),
            quick:         new QuickHub(this._settings, {volume, brightness, bluetooth}),
            stats:         new Stats(this._settings),
            claude:        new ClaudeUsage(this._settings),
            volume,
            brightness,
            battery:       new BatteryWatcher(),
            bluetooth,
        };
        this._events = new EventManager(this);
        this._osd = new OsdInterceptor(kind => this._onOsd(kind));

        this._modules.notes.setGrabActor(this);
        this._pomoUpdateId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._pomoUpdateId = 0;
            if (!this._stopped) this._updatePomodoroIndicator();
            return GLib.SOURCE_REMOVE;
        });

        /* Module signals are routed through _on() so they are disconnected
           in stop() and can never reach a stopped island (async replies
           such as a weather fetch can land after disable). */
        const m = this._modules;
        this._moduleSigs = [];
        this._on(m.system,        'updated',          (_, s)      => this._onSystemUpdated(s));
        this._on(m.notifications, 'peek',             (_, src, n) => this._peekNotification(src, n));
        this._on(m.calendar,      'updated',          ()          => this._rerenderIf('calendar', 'tasks'));
        this._on(m.mpris,         'changed',          (_, info)   => this._updateMedia(info));
        this._on(m.mpris,         'track-changed',    (_, info)   => this._onTrackChanged(info));
        this._on(m.weather,       'updated',          ()          => { this._rerenderIf('weather'); this._updateWeatherChip(); });
        this._on(m.pomodoro,      'tick',             ()          => { this._rerenderIf('pomodoro'); this._updatePomodoroIndicator(); });
        this._on(m.pomodoro,      'state',            ()          => { this._rerenderIf('pomodoro'); this._updatePomodoroIndicator(); });
        this._on(m.quick,         'updated',          ()          => this._rerenderIf('quick'));
        this._on(m.quick,         'request-collapse', ()          => this._collapse());
        this._on(m.quick,         'request-screenshot', ()        => this.takeScreenshot());
        this._on(m.claude,        'updated',          ()          => this._rerenderIf('claude'));
        this._on(m.notes,         'updated',          ()          => this._rerenderIf('notes'));
        this._on(m.volume,        'changed',          (_, st)     => this._onVolume(st));
        this._on(m.volume,        'sink-changed',     ()          => this._eq.restart());
        this._on(m.brightness,    'changed',          (_, st)     => this._onBrightness(st.level));
        this._on(m.battery,       'updated',          (_, snap)   => { this._batteryState = snap; this._updateBatteryIcon(); });
        this._on(m.battery,       'event',            (_, ev)     => this._onBatteryEvent(ev));
        this._on(m.bluetooth,     'device',           (_, dev)    => this._onBluetooth(dev));

        this.connect('notify::hover', () => this._onHoverChanged());
        this.connect('button-release-event', (_a, event) => this._onRelease(event));
        this.connect('destroy', () => this._onDestroy());

        this._settingsSig = this._settings.connect('changed', (_, key) => this._onSettingChanged(key));
        this._monitorsSig = Main.layoutManager.connect('monitors-changed', () => this.relayout());
        this._scaleSig = this._themeContext.connect('notify::scale-factor', () => this.relayout());

        this._applyStyle();
    }

    _on(obj, signal, handler) {
        const id = obj.connect(signal, (...args) => {
            if (!this._stopped) handler(...args);
        });
        this._moduleSigs.push([obj, id]);
    }

    /* ——— dimensions & style ——— */

    _loadDims() {
        const s = this._settings;
        this._cwMin     = s.get_int('collapsed-width');
        this._ch        = s.get_int('collapsed-height');
        this._ew        = s.get_int('expanded-width');
        this._eh        = s.get_int('expanded-height');
        this._radius    = s.get_int('corner-radius');
        this._borderW   = s.get_int('border-width');
        this._topMargin = s.get_int('top-margin');
        this._notchStyle = s.get_string('island-style') !== 'floating';
    }

    _scale() { return this._themeContext.scale_factor || 1; }
    _px(v)   { return Math.round(v * this._scale()); }

    _dur(ms) {
        if (!this._settings.get_boolean('enable-animations')) return 0;
        return Math.round(ms * (SPEED[this._settings.get_string('animation-speed')] ?? 1));
    }

    _color(key, fallback) {
        const v = (this._settings.get_string(key) || '').trim();
        return /^(rgba?\(|#)/.test(v) ? v : fallback;
    }

    _applyStyle() {
        const bg      = this._color('bg-color', 'rgba(0, 0, 0, 1)');
        const text    = this._color('text-color', 'rgba(255, 255, 255, 0.96)');
        const border  = this._color('border-color', 'rgba(255, 255, 255, 0.08)');
        const shadowC = this._color('shadow-color', 'rgba(0, 0, 0, 0.45)');
        const shadow  = this._settings.get_boolean('enable-shadow')
            ? `box-shadow: 0 6px 22px 0 ${shadowC};` : '';
        const bw = Math.max(0, this._borderW);
        this._bgBase = `
            background-color: ${bg};
            border: ${bw}px solid ${bw > 0 ? border : 'transparent'};
            ${this._notchStyle ? 'border-top-width: 0;' : ''}
            ${shadow}
        `;
        this._bgRadius = null;
        this._setRadiusFor(this._target?.h ?? this._px(this._ch));
        this._clip.set_style(`color: ${text};`);
        this._accentColor = this._color('accent-color', 'rgba(120, 170, 255, 0.32)');
        this._pillRow.height = this._px(this._ch);
        this._updateEars(bg);
        this._highlightTab();
        this._updateBatteryIcon();
    }

    /* Floating: one radius everywhere — St shrinks radii that exceed half
       the box, so the pill is a capsule and the dashboard gets rounded
       corners. Notch: only the bottom corners are rounded (the top stays
       attached to the screen edge), capped at half the target height so
       the small pill doesn't turn into a bowl. */
    _setRadiusFor(heightPx) {
        if (!this._bgBase) return;
        let r = this._radius;
        if (this._notchStyle) r = Math.min(r, Math.floor(heightPx / this._scale() / 2));
        if (r === this._bgRadius) return;
        this._bgRadius = r;
        const radius = this._notchStyle ? `0 0 ${r}px ${r}px` : `${r}px`;
        this._bg.set_style(`${this._bgBase} border-radius: ${radius};`);
    }

    _updateEars(bg) {
        const show = this._notchStyle && this._topMargin >= 0;
        const size = this._px(EAR_SIZE);
        this._earColor = parseColor(bg ?? this._color('bg-color', 'rgba(0, 0, 0, 1)'));
        for (const [ear, x] of [[this._earL, -size], [this._earR, 0]]) {
            ear.visible = show;
            ear.set_position(x, 0);
            ear.set_size(size, size);
            ear.queue_repaint();
        }
    }

    _paintEar(area, left) {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const e = Math.min(w, h);
        const [r, g, b, a] = this._earColor ?? [0, 0, 0, 1];
        cr.setSourceRGBA(r, g, b, a);
        if (left) {
            /* filled corner between the top edge and the island's left side */
            cr.moveTo(0, 0);
            cr.lineTo(e, 0);
            cr.lineTo(e, e);
            cr.arcNegative(0, e, e, 0, -Math.PI / 2);
        } else {
            cr.moveTo(e, 0);
            cr.lineTo(0, 0);
            cr.lineTo(0, e);
            cr.arc(e, e, e, Math.PI, 1.5 * Math.PI);
        }
        cr.closePath();
        cr.fill();
        cr.$dispose();
    }

    _animateTo(w, h, ms, mode = Clutter.AnimationMode.EASE_OUT_QUINT, delay = 0) {
        const mon = Main.layoutManager.primaryMonitor;
        w = Math.round(w);
        h = Math.round(h);
        if (mon) {
            w = Math.min(w, mon.width - this._px(16));
            h = Math.min(h, mon.height - this._px(16));
        }
        const x = mon ? mon.x + Math.floor((mon.width - w) / 2) : this.x;
        const y = mon ? mon.y + (this._notchStyle ? 0 : this._px(this._topMargin)) : this.y;
        const t = this._target;
        if (t && t.w === w && t.h === h && t.x === x && t.y === y) return;
        this._target = {w, h, x, y};
        this._setRadiusFor(h);
        this.remove_all_transitions();
        const dur = this._dur(ms);
        if (dur <= 0) {
            this.set_position(x, y);
            this.set_size(w, h);
            return;
        }
        this.ease({x, y, width: w, height: h, duration: dur, delay, mode});
    }

    _fade(actor, opacity, ms, delay = 0, hideAfter = false) {
        actor.remove_all_transitions();
        if (opacity > 0) actor.show();
        const dur = this._dur(ms);
        if (dur <= 0) {
            actor.opacity = opacity;
            if (hideAfter && opacity === 0) actor.hide();
            return;
        }
        actor.ease({
            opacity, duration: dur, delay,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: hideAfter ? () => { if (actor.opacity === 0) actor.hide(); } : undefined,
        });
    }

    _phaseTimer(ms, cb) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, ms), () => {
            this._phaseTimers.delete(id);
            if (!this._stopped) cb();
            return GLib.SOURCE_REMOVE;
        });
        this._phaseTimers.add(id);
    }

    _clearPhaseTimers() {
        for (const id of this._phaseTimers) GLib.source_remove(id);
        this._phaseTimers.clear();
    }

    /* Re-apply geometry for the current state without animation
       (monitor / scale / settings change). */
    relayout() {
        if (this._stopped) return;
        this._topbar?.relayout();
        this._target = null;
        this._pillRow.height = this._px(this._ch);
        if (this._searching) {
            this._searchLayer.width = this._searchW();
            this._target = null;
            this.resizeSearch();
        } else if (this._expanded) {
            this._expandedLayer.width = this._expW();
            this._animateTo(this._expW(), this._expandedTargetHeight(), 0);
        } else if (this._eventActive && this._events.current) {
            const [w, h] = this._eventSize(this._events.current);
            this._animateTo(w, h, 0);
        } else {
            const [w, h] = this._idleSize();
            this._animateTo(w, h, 0);
        }
    }

    _expW() {
        const mon = Main.layoutManager.primaryMonitor;
        const w = this._px(this._ew);
        return mon ? Math.min(w, mon.width - this._px(24)) : w;
    }

    _expandedTargetHeight() {
        let natH = 0;
        try { [, natH] = this._expandedLayer.get_preferred_height(this._expW()); } catch (_) {}
        const mon = Main.layoutManager.primaryMonitor;
        const cap = Math.min(this._px(MAX_EXPANDED_H), mon ? Math.round(mon.height * 0.8) : Infinity);
        return Math.min(cap, Math.max(this._px(this._eh), natH));
    }

    /* Idle pill size. Side clusters get equal widths so the clock stays
       centred on the screen whatever sits left/right of it. */
    _idleSize() {
        const left = this._leftCluster, right = this._rightCluster;
        left.set_width(-1);
        right.set_width(-1);
        if (this._centerCluster.visible) {
            const [, lw] = left.get_preferred_width(-1);
            const [, rw] = right.get_preferred_width(-1);
            const side = Math.max(lw, rw);
            left.set_width(side);
            right.set_width(side);
        }
        const [, rowW] = this._pillRow.get_preferred_width(-1);
        let w = Math.max(this._px(this._cwMin), rowW);
        let h = this._px(this._ch);
        if (this._hoverState) {
            const [, subW] = this._subtitle.get_preferred_width(-1);
            w = Math.min(Math.max(w, subW + this._px(40)), Math.max(w, this._px(HOVER_EXTRA_MAX_W)));
            const [, subH] = this._subtitle.get_preferred_height(w);
            h += subH + this._px(6);
        }
        return [w, h];
    }

    _resizeCollapsed(animate = true) {
        if (this._expanded || this._eventActive || this._stopped) return;
        const [w, h] = this._idleSize();
        this._animateTo(w, h, animate ? 240 : 0);
    }

    _hideDateMenuIfRequested() {
        const wantHide = this._settings.get_boolean('hide-datemenu');
        const dm = Main.panel.statusArea?.dateMenu;
        if (!dm?.container) return;
        if (wantHide) {
            if (this._dmWasVisible === undefined) this._dmWasVisible = dm.container.visible;
            dm.container.visible = false;
        } else if (this._dmWasVisible !== undefined) {
            dm.container.visible = this._dmWasVisible;
        }
    }

    _restoreDateMenu() {
        const dm = Main.panel.statusArea?.dateMenu;
        if (dm?.container && this._dmWasVisible !== undefined) {
            dm.container.visible = this._dmWasVisible;
        }
    }

    _onSettingChanged(key) {
        if (APPEARANCE_KEYS.has(key)) {
            this._loadDims();
            this._applyStyle();
            this.relayout();
            return;
        }
        switch (key) {
        case 'hide-datemenu':
            this._hideDateMenuIfRequested();
            return;
        case 'clock-format': case 'show-seconds': case 'show-date':
            this._updateClocks();
            this._resizeCollapsed();
            return;
        case 'always-show-clock': case 'always-show-media':
            this._updateMedia(this._modules.mpris.info());
            return;
        case 'pill-show-weather':
            this._updateWeatherChip();
            return;
        case 'pill-show-system':
            this._reconcileModulesWithPrefs();
            this._updateSystemChip();
            return;
        case 'eq-follow-audio':
        case 'enable-animations':
            this._eq.restart();
            return;
        case 'autohide-top-bar':
            this._syncTopBar();
            return;
        case 'fill-top-strip':
            this._topbar?.relayout();
            return;
        case 'replace-system-osd':
            this._syncOsd();
            return;
        }
        if (key.startsWith('show-') || key === 'event-volume' || key === 'event-brightness' ||
            key === 'event-battery' || key === 'event-bluetooth') {
            for (const [id, btn] of Object.entries(this._tabButtons ?? {}))
                btn.visible = this._tabEnabled(id);
            if (!this._tabEnabled(this._activeTab)) this._switchTab('system');
            this._reconcileModulesWithPrefs();
            this._syncOsd();
            if (key === 'show-media') this._updateMedia(this._modules.mpris.info());
        }
    }

    /* ——— actors ——— */

    _buildLayers() {
        this._bg = new St.Widget({style_class: 'notchex-bg', x_expand: true, y_expand: true});
        this.add_child(this._bg);

        /* notch style: concave "ears" that blend the island into the top
           edge, drawn just outside the island's left and right sides */
        this._earL = new St.DrawingArea();
        this._earR = new St.DrawingArea();
        this._earL.connect('repaint', area => this._paintEar(area, true));
        this._earR.connect('repaint', area => this._paintEar(area, false));
        /* zero-width anchors pinned to the island's left and right edges;
           each ear hangs outside its anchor */
        const earRow = new St.BoxLayout({x_expand: true, y_expand: true});
        const anchorL = new St.Widget({width: 0});
        const anchorR = new St.Widget({width: 0});
        anchorL.add_child(this._earL);
        anchorR.add_child(this._earR);
        earRow.add_child(anchorL);
        earRow.add_child(new St.Widget({x_expand: true}));
        earRow.add_child(anchorR);
        this.add_child(earRow);

        this._clip = new St.Widget({style_class: 'notchex-clip', x_expand: true, y_expand: true,
            clip_to_allocation: true});
        this.add_child(this._clip);

        /* ——— collapsed pill:  [pomo][media]   clock   [weather][sys][date][battery] ——— */
        this._collapsed = new St.BoxLayout({style_class: 'notchex-collapsed', vertical: true});
        this._collapsed.add_constraint(new Clutter.BindConstraint({
            source: this._clip, coordinate: Clutter.BindCoordinate.WIDTH,
        }));
        this._clip.add_child(this._collapsed);

        this._pillRow = new St.BoxLayout({style_class: 'notchex-pill-row', x_expand: true});
        this._collapsed.add_child(this._pillRow);

        this._subtitle = new St.Label({style_class: 'notchex-subtitle', x_align: Clutter.ActorAlign.CENTER,
            visible: false});
        this._subtitle.clutter_text.ellipsize = ELLIPSIZE_END;
        this._collapsed.add_child(this._subtitle);

        this._leftCluster = new St.BoxLayout({style_class: 'notchex-cluster notchex-left',
            y_align: Clutter.ActorAlign.CENTER});
        this._pomoChip = new St.BoxLayout({style_class: 'notchex-chip notchex-pomo-chip', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._pomoChip.add_child(new St.Widget({style_class: 'notchex-pomo-dot', y_align: Clutter.ActorAlign.CENTER}));
        this._pomoLabel = new St.Label({text: '', style_class: 'notchex-pomo-mini', y_align: Clutter.ActorAlign.CENTER});
        this._pomoChip.add_child(this._pomoLabel);
        this._leftCluster.add_child(this._pomoChip);

        this._mediaChip = new St.BoxLayout({style_class: 'notchex-chip notchex-media-chip', visible: false,
            reactive: true, y_align: Clutter.ActorAlign.CENTER});
        this._mediaArtSlot = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._musicTitle = new St.Label({style_class: 'notchex-music-title', y_align: Clutter.ActorAlign.CENTER});
        this._musicTitle.clutter_text.ellipsize = ELLIPSIZE_END;
        this._mediaChip.add_child(this._mediaArtSlot);
        this._mediaChip.add_child(this._musicTitle);
        this._leftCluster.add_child(this._mediaChip);
        this._dateLabelC = new St.Label({text: '', style_class: 'notchex-date-mini', y_align: Clutter.ActorAlign.CENTER});
        this._leftCluster.add_child(this._dateLabelC);

        this._centerCluster = new St.BoxLayout({
            style_class: 'notchex-cluster notchex-center',
            x_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._clockLabel = new St.Label({text: '', style_class: 'notchex-clock', y_align: Clutter.ActorAlign.CENTER});
        this._centerCluster.add_child(this._clockLabel);

        this._rightCluster = new St.BoxLayout({style_class: 'notchex-cluster notchex-right',
            y_align: Clutter.ActorAlign.CENTER});
        this._rightInner = new St.BoxLayout({style_class: 'notchex-cluster', x_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._rightCluster.add_child(this._rightInner);
        this._weatherChip = new St.BoxLayout({style_class: 'notchex-chip notchex-weather-chip', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._weatherIcon = new St.Icon({icon_size: 13, style_class: 'notchex-weather-chip-icon'});
        this._weatherTemp = new St.Label({style_class: 'notchex-date-mini', y_align: Clutter.ActorAlign.CENTER});
        this._weatherChip.add_child(this._weatherIcon);
        this._weatherChip.add_child(this._weatherTemp);
        this._sysLabel = new St.Label({style_class: 'notchex-sys-mini', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._batteryIcon = new St.Icon({
            icon_name: 'battery-full-symbolic', icon_size: 15,
            style_class: 'notchex-battery-icon', visible: false,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._rightInner.add_child(this._weatherChip);
        this._rightInner.add_child(this._sysLabel);
        this._rightInner.add_child(this._batteryIcon);
        /* while music plays the battery gives way to a live equalizer */
        this._eq = new Equalizer({
            animationsEnabled: () => this._settings.get_boolean('enable-animations'),
            followAudio: () => this._settings.get_boolean('eq-follow-audio'),
            sinkName: () => this._modules?.volume?.sinkName() ?? null,
        });
        this._rightInner.add_child(this._eq.actor);

        this._pillRow.add_child(this._leftCluster);
        this._pillRow.add_child(this._centerCluster);
        this._pillRow.add_child(this._rightCluster);

        /* ——— expanded dashboard ——— */
        this._expandedLayer = new St.BoxLayout({
            style_class: 'notchex-expanded',
            vertical: true,
            opacity: 0,
            visible: false,
        });
        this._expandedLayer.add_constraint(new Clutter.AlignConstraint({
            source: this._clip, align_axis: Clutter.AlignAxis.X_AXIS, factor: 0.5,
        }));
        this._clip.add_child(this._expandedLayer);

        this._header = new St.BoxLayout({style_class: 'notchex-header', reactive: true});
        this._bigClock = new St.Label({text: '', style_class: 'notchex-big-clock', y_align: Clutter.ActorAlign.CENTER});
        const dateCol = new St.BoxLayout({vertical: true, x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._dateLabel  = new St.Label({text: '', style_class: 'notchex-date', x_align: Clutter.ActorAlign.END});
        this._monthLabel = new St.Label({text: '', style_class: 'notchex-date-month', x_align: Clutter.ActorAlign.END});
        dateCol.add_child(this._dateLabel);
        dateCol.add_child(this._monthLabel);
        this._header.add_child(this._bigClock);
        this._header.add_child(new St.Widget({x_expand: true}));
        this._header.add_child(dateCol);
        /* clicking the header folds the island back up */
        this._header.connect('button-release-event', (_a, event) => {
            if (event.get_button() !== 1) return Clutter.EVENT_PROPAGATE;
            this._collapse();
            return Clutter.EVENT_STOP;
        });
        this._expandedLayer.add_child(this._header);

        this._tabs = new St.BoxLayout({style_class: 'notchex-tabs'});
        this._content = new St.Bin({style_class: 'notchex-content', x_expand: true, y_expand: true,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
        this._expandedLayer.add_child(this._tabs);
        this._expandedLayer.add_child(this._content);

        this._tabButtons = {};
        for (const id of TAB_IDS) {
            const btn = new St.Button({
                style_class: 'notchex-tab',
                label: this._tabLabel(id),
                can_focus: true,
                x_expand: true,
                track_hover: true,
                visible: this._tabEnabled(id),
            });
            btn.connect('clicked', () => this._switchTab(id));
            this._tabs.add_child(btn);
            this._tabButtons[id] = btn;
        }

        /* ——— transient event ("live activity") layer ——— */
        this._activity = new St.Bin({style_class: 'notchex-activity', visible: false,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.FILL});
        this._activity.add_constraint(new Clutter.AlignConstraint({
            source: this._clip, align_axis: Clutter.AlignAxis.X_AXIS, factor: 0.5,
        }));
        this._activity.add_constraint(new Clutter.AlignConstraint({
            source: this._clip, align_axis: Clutter.AlignAxis.Y_AXIS, factor: 0.5,
        }));
        this._clip.add_child(this._activity);

        /* ——— Spotlight search (hosted view, see modules/search.js) ——— */
        this._searchLayer = new St.Bin({style_class: 'notchex-search-layer', visible: false,
            x_align: Clutter.ActorAlign.FILL, y_align: Clutter.ActorAlign.START});
        this._searchLayer.add_constraint(new Clutter.AlignConstraint({
            source: this._clip, align_axis: Clutter.AlignAxis.X_AXIS, factor: 0.5,
        }));
        this._clip.add_child(this._searchLayer);
    }

    _setupKeybinding() {
        try {
            Main.wm.addKeybinding('shortcut-toggle',
                this._settings,
                Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW,
                () => {
                    if (this._searching) return;
                    if (this._expanded) this._collapse();
                    else this._expand();
                });
            this._keybindings = ['shortcut-toggle'];
        } catch (e) { logError(e, 'notchex:keybinding'); }
    }

    _tabLabel(id) {
        return {
            system: 'System', media: 'Media', calendar: 'Cal', tasks: 'Tasks',
            notes:  'Notes',  weather:  'Weather', pomodoro: 'Timer',
            stats:  'Stats',  quick: 'Quick', claude: 'Limits',
        }[id] ?? id;
    }

    _tabEnabled(id) {
        const key = {
            system:   'show-system',
            media:    'show-media',
            calendar: 'show-calendar',
            tasks:    'show-tasks',
            claude:   'show-claude-usage',
        }[id];
        if (!key) return true;
        return this._settings.get_boolean(key);
    }

    /* ——— lifecycle ——— */

    start() {
        this._topbar = new TopBarAutoHide({
            reservedHeight: () => this._px(this._ch) + (this._notchStyle ? 0 : this._px(this._topMargin)),
            isOverNotch: (x, y) => {
                const [ax, ay] = this.get_transformed_position();
                const [aw, ah] = this.get_transformed_size();
                return x >= ax && x <= ax + aw && y >= ay && y <= ay + ah;
            },
            fillColor: () => this._settings.get_boolean('fill-top-strip')
                ? this._color('bg-color', 'rgba(0, 0, 0, 1)') : null,
        });
        this._syncTopBar();
        this._startEnabledModules();
        this._modules.system.setBackground?.(this._settings.get_boolean('pill-show-system'));
        this._syncOsd();
        this._startClock();
        this._updateBatteryIcon();
        this._updateWeatherChip();
        this.relayout();
    }

    _startEnabledModules() {
        for (const [name, mod] of Object.entries(this._modules)) {
            if (this._moduleEnabled(name)) {
                try { mod.start?.(); mod._running = true; } catch (e) { logError(e, `notchex:${name}`); }
            } else {
                mod._running = false;
            }
        }
    }

    _reconcileModulesWithPrefs() {
        for (const [name, mod] of Object.entries(this._modules)) {
            const enabled = this._moduleEnabled(name);
            const running = !!mod._running;
            if (enabled && !running)  { try { mod.start?.(); mod._running = true;  } catch (e) { logError(e); } }
            if (!enabled && running)  { try { mod.stop?.();  mod._running = false; } catch (e) { logError(e); } }
        }
        if (this._modules.system._running)
            this._modules.system.setBackground?.(this._settings.get_boolean('pill-show-system'));
    }

    _moduleEnabled(name) {
        const s = this._settings;
        switch (name) {
        case 'calendar':      return this._tabEnabled('calendar') || this._tabEnabled('tasks');
        case 'system':        return s.get_boolean('show-system') || s.get_boolean('pill-show-system');
        case 'notifications': return s.get_boolean('show-notifications');
        case 'claude':        return s.get_boolean('show-claude-usage');
        case 'bluetooth':     return s.get_boolean('event-bluetooth');
        case 'brightness':    return true;   /* also drives the Quick tab slider */
        case 'volume':        return true;
        default:              return true;
        }
    }

    _syncTopBar() {
        try {
            if (this._settings.get_boolean('autohide-top-bar')) this._topbar.enable();
            else this._topbar.disable();
        } catch (e) { logError(e, 'notchex:topbar'); }
    }

    _syncOsd() {
        const want = this._settings.get_boolean('replace-system-osd') &&
            (this._settings.get_boolean('event-volume') || this._settings.get_boolean('event-brightness'));
        if (want) this._osd.enable();
        else this._osd.disable();
    }

    stop() {
        if (this._searching) {
            this._searching = false;
            if (this._searchGrab) Main.popModal(this._searchGrab);
            this._searchGrab = null;
            this._searchLayer.set_child(null);
        }
        this._stopped = true;
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        this._clearPhaseTimers();
        this._stopClock();
        this._osd.disable();
        try { this._topbar?.disable(); } catch (e) { logError(e, 'notchex:topbar'); }
        this._events.destroy();
        if (this._wakeSigId && this._wakeProxy) { try { this._wakeProxy.disconnectSignal(this._wakeSigId); } catch (_) {} this._wakeSigId = 0; }
        this._wakeProxy = null;
        if (this._pomoUpdateId) { GLib.source_remove(this._pomoUpdateId); this._pomoUpdateId = 0; }
        if (this._renderIdle)   { GLib.source_remove(this._renderIdle);   this._renderIdle   = 0; }
        if (this._resizeIdle)   { GLib.source_remove(this._resizeIdle);   this._resizeIdle   = 0; }
        for (const id of this._bannerKillTimers ?? []) {
            try { GLib.source_remove(id); } catch (_) {}
        }
        this._bannerKillTimers?.clear();
        this._eq.setPlaying(false);
        for (const [obj, id] of this._moduleSigs ?? []) {
            try { obj.disconnect(id); } catch (_) {}
        }
        this._moduleSigs = [];
        for (const mod of Object.values(this._modules)) {
            try { mod.stop?.(); } catch (e) { logError(e); }
            mod._running = false;
        }
        shutdownArtwork();
        this._restoreDateMenu();
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = 0; }
        if (this._monitorsSig) { Main.layoutManager.disconnect(this._monitorsSig); this._monitorsSig = 0; }
        if (this._scaleSig)    { this._themeContext.disconnect(this._scaleSig); this._scaleSig = 0; }
        for (const key of this._keybindings ?? []) {
            try { Main.wm.removeKeybinding(key); } catch (_) {}
        }
        this._keybindings = [];
    }

    _onDestroy() {
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        this._clearPhaseTimers();
        this._stopClock();
        for (const m of Object.values(this._modules ?? {})) m.destroy?.();
        this._modules = {};
    }

    /* ——— clock ——— */

    _startClock() {
        this._updateClocks();
        this._scheduleClockTick();
        this._watchWake();
    }

    /* GLib timers are driven by the monotonic clock, which stops advancing
       during suspend. On resume the pending tick fires late and shows a
       stale time for the rest of that period (up to a full minute) — this
       is the "clock is 1-2 min behind" symptom on laptops. Force an
       immediate resync when logind reports the system woke up. */
    _watchWake() {
        try {
            this._wakeProxy = new Gio.DBusProxy({
                g_connection: Gio.DBus.system,
                g_name: 'org.freedesktop.login1',
                g_object_path: '/org/freedesktop/login1',
                g_interface_name: 'org.freedesktop.login1.Manager',
                g_flags: Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES,
            });
            this._wakeProxy.init_async(GLib.PRIORITY_DEFAULT, null, (p, res) => {
                try { p.init_finish(res); } catch (e) { logError(e, 'notchex:wake-watch'); return; }
                if (this._stopped) return;
                this._wakeSigId = p.connectSignal('PrepareForSleep', (_p, _s, [starting]) => {
                    if (!starting) { this._stopClock(); this._updateClocks(); this._scheduleClockTick(); }
                });
            });
        } catch (e) { logError(e, 'notchex:wake-watch'); }
    }

    _scheduleClockTick() {
        const showSec = this._settings.get_boolean('show-seconds');
        const period  = showSec ? 1000 : 60000;
        const delay = Math.max(20, period - (Date.now() % period));
        this._clockTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delay, () => {
            this._clockTimer = 0;
            this._updateClocks();
            this._scheduleClockTick();
            return GLib.SOURCE_REMOVE;
        });
    }

    _stopClock() {
        if (this._clockTimer) { GLib.source_remove(this._clockTimer); this._clockTimer = 0; }
    }

    _updateClocks() {
        const now = new Date();
        const showSec   = this._settings.get_boolean('show-seconds');
        const showDate  = this._settings.get_boolean('show-date');
        const h12       = this._settings.get_string('clock-format') === '12h';
        const time = now.toLocaleTimeString([], {
            hour: '2-digit', minute: '2-digit', hour12: h12,
            ...(showSec ? {second: '2-digit'} : {}),
        });
        this._clockLabel.text = time;
        this._bigClock.text   = time;
        this._dateLabelC.text = this._formatCompactDate(now);
        this._dateLabelC.visible = showDate && !this._mediaChip.visible;
        this._dateLabel.text  = now.toLocaleDateString([], {weekday: 'long'});
        this._monthLabel.text = now.toLocaleDateString([], {day: 'numeric', month: 'long', year: 'numeric'});

        const minute = Math.floor(now.getTime() / 60000);
        if (minute !== this._lastMinute) {
            this._lastMinute = minute;
            this._checkUpcomingEvents();
        }
    }

    _formatCompactDate(d) {
        return d.toLocaleDateString([], {month: 'short', day: 'numeric'});
    }

    /* ——— hover / click / expand / collapse ——— */

    _expandOnHover() { return this._settings.get_boolean('expand-on-hover'); }
    _expandOnClick() { return this._settings.get_boolean('expand-on-click'); }

    _clearHoverTimeout()    { if (this._hoverTimeout)    { GLib.source_remove(this._hoverTimeout);    this._hoverTimeout = 0; } }
    _clearCollapseTimeout() { if (this._collapseTimeout) { GLib.source_remove(this._collapseTimeout); this._collapseTimeout = 0; } }

    _onHoverChanged() {
        if (this._stopped || this._searching) return;
        if (this.hover) {
            this._clearCollapseTimeout();
            if (this._expanded) return;
            if (this._eventActive) {
                const ev = this._events.current;
                if (ev?.holdOnHover || ev?.blocksExpand || !this._expandOnHover()) {
                    this._events.hold();
                    return;
                }
            }
            if (this._expandOnHover()) this._scheduleExpand();
            else this._scheduleHoverState();
        } else {
            this._clearHoverTimeout();
            if (this._expanded) {
                if (this._settings.get_boolean('auto-collapse')) this._scheduleCollapse();
                return;
            }
            if (this._eventActive) this._events.release();
            this._setHoverState(false);
        }
    }

    _onRelease(event) {
        if (this._searching) {
            /* with the search grab, clicks outside the island land here */
            const [x, y] = event.get_coords();
            const [ax, ay] = this.get_transformed_position();
            const [aw, ah] = this.get_transformed_size();
            if (x < ax || x > ax + aw || y < ay || y > ay + ah) this._onSearchDismiss?.();
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== 1 || this._expanded) return Clutter.EVENT_PROPAGATE;
        if (this._eventActive) {
            const ev = this._events.current;
            if (ev?.onClick) {
                ev.onClick();
                return Clutter.EVENT_STOP;
            }
        }
        if (!this._expandOnClick() && !this._expandOnHover()) return Clutter.EVENT_PROPAGATE;
        let tab = null;
        try {
            const src = global.stage.get_event_actor?.(event);
            if (src && this._mediaChip.visible && this._mediaChip.contains(src)) tab = 'media';
        } catch (_) {}
        this._expand(tab);
        return Clutter.EVENT_STOP;
    }

    _pointerInside() {
        try {
            const [px, py] = global.get_pointer();
            const [ax, ay] = this.get_transformed_position();
            const [aw, ah] = this.get_transformed_size();
            const margin = this._px(8);
            return px >= ax - margin && px <= ax + aw + margin &&
                   py >= ay - margin && py <= ay + ah + margin;
        } catch (_) { return this.hover; }
    }

    _scheduleExpand() {
        if (this._expanded) { this._clearCollapseTimeout(); return; }
        this._clearHoverTimeout();
        const delay = Math.max(0, this._settings.get_int('hover-delay'));
        this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, delay), () => {
            this._hoverTimeout = 0;
            const ev = this._events.current;
            if (this._eventActive && (ev?.blocksExpand || ev?.holdOnHover)) return GLib.SOURCE_REMOVE;
            if (this.hover || this._pointerInside()) this._expand();
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleHoverState() {
        this._clearHoverTimeout();
        const delay = Math.min(160, Math.max(0, this._settings.get_int('hover-delay')));
        this._hoverTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, delay), () => {
            this._hoverTimeout = 0;
            if (this.hover && !this._expanded && !this._eventActive) this._setHoverState(true);
            return GLib.SOURCE_REMOVE;
        });
    }

    _scheduleCollapse() {
        this._clearHoverTimeout();
        if (!this._expanded) return;
        this._clearCollapseTimeout();
        const delay = Math.max(0, this._settings.get_int('collapse-delay'));
        this._collapseTimeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(1, delay), () => {
            this._collapseTimeout = 0;
            if (this.hover || this._pointerInside() || this._notesFocused) {
                this._scheduleCollapse();
                return GLib.SOURCE_REMOVE;
            }
            this._collapse();
            return GLib.SOURCE_REMOVE;
        });
    }

    /* Hover preview (used when expand-on-hover is off): the pill grows a
       second line with contextual info; a click then expands fully. */
    _setHoverState(on) {
        if (on && (this._expanded || this._eventActive)) return;
        if (this._hoverState === on) return;
        this._hoverState = on;
        if (on) {
            this._subtitle.text = this._subtitleText();
            this._subtitle.opacity = 0;
            this._subtitle.show();
            this._fade(this._subtitle, 255, 180, this._dur(70));
        } else {
            this._fade(this._subtitle, 0, 100, 0, true);
        }
        this._resizeCollapsed(true);
    }

    _subtitleText() {
        const m = this._modules.mpris.info();
        if ((m?.playing || m?.paused) && m.title)
            return `${m.title}${m.artist ? ` — ${m.artist}` : ''}  ·  ${m.playing ? 'Playing' : 'Paused'}`;
        const p = this._modules.pomodoro;
        if (p?.getState?.() && p.getState() !== 'idle')
            return `${p._stateLabel?.() ?? 'Timer'}  ·  ${p.formatRemain()} left`;
        const next = this._modules.calendar?._running ? this._modules.calendar.upcoming?.(12 * 3600)?.[0] : null;
        if (next) {
            const t = new Date(next.start * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
            return `Next: ${next.summary}  ·  ${t}`;
        }
        return new Date().toLocaleDateString([], {weekday: 'long', day: 'numeric', month: 'long'});
    }

    _expand(tab = null) {
        if (this._stopped || this._searching) return;
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        this._clearPhaseTimers();
        if (tab && this._tabEnabled(tab)) {
            if (this._expanded) { this._switchTab(tab); return; }
            this._activeTab = tab;
        }
        if (this._expanded) return;
        if (!this._tabEnabled(this._activeTab)) this._activeTab = 'system';

        this._events.suspend();
        this._expanded = true;
        this._hoverState = false;
        this._subtitle.hide();
        this._fade(this._collapsed, 0, 90, 0, true);

        const layer = this._expandedLayer;
        layer.remove_all_transitions();
        layer.width = this._expW();
        layer.opacity = 0;
        layer.translation_y = -this._px(8);
        layer.show();
        this._updateClocks();
        this._switchTab(this._activeTab);

        this._animateTo(this._expW(), this._expandedTargetHeight(), 320);
        layer.ease({
            opacity: 255, translation_y: 0,
            duration: this._dur(240), delay: this._dur(70),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    _collapse() {
        if (!this._expanded || this._stopped) return;
        this._clearCollapseTimeout();
        this._clearHoverTimeout();
        this._modules?.notes?._releaseGrab?.();
        this._expanded = false;
        this._modules?.system?.setFocused?.(false);
        this._modules?.quick?.setFocused?.(false);

        const layer = this._expandedLayer;
        layer.remove_all_transitions();
        layer.ease({
            opacity: 0, translation_y: -this._px(6),
            duration: this._dur(120), mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                if (this._expanded) return;
                layer.hide();
                /* drop the tab content so its timers/listeners go away */
                const child = this._content.get_child();
                this._content.set_child(null);
                child?.destroy();
            },
        });

        this._collapsed.opacity = 0;
        this._collapsed.show();
        const [w, h] = this._idleSize();
        this._animateTo(w, h, 300, Clutter.AnimationMode.EASE_OUT_QUINT, this._dur(70));
        this._fade(this._collapsed, 255, 200, this._dur(170));
        this._phaseTimer(this._dur(400), () => {
            if (!this._expanded) this._events.resume();
        });
    }

    _switchTab(id) {
        if (this._activeTab === 'notes' && id !== 'notes') this._modules?.notes?._releaseGrab?.();
        this._activeTab = id;
        this._modules?.system?.setFocused?.(this._expanded && id === 'system');
        this._modules?.quick?.setFocused?.(this._expanded && id === 'quick');
        this._highlightTab();
        this._renderTab();
    }

    _highlightTab() {
        for (const [tid, btn] of Object.entries(this._tabButtons ?? {})) {
            if (tid === this._activeTab) {
                btn.add_style_pseudo_class('active');
                btn.set_style(`background-color: ${this._accentColor ?? 'rgba(255,255,255,0.14)'}; color: white;`);
            } else {
                btn.remove_style_pseudo_class('active');
                btn.set_style(null);
            }
        }
    }

    _resizeExpanded() {
        if (!this._expanded) return;
        this._animateTo(this._expW(), this._expandedTargetHeight(), 240);
    }

    _rerenderIf(...tabs) {
        if (this._expanded && tabs.includes(this._activeTab)) this._queueRender();
    }

    /* Coalesce bursts of module updates (MPRIS sends several property
       changes per track switch) into one re-render. */
    _queueRender() {
        if (this._renderIdle) return;
        this._renderIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._renderIdle = 0;
            if (!this._stopped) this._renderTab();
            return GLib.SOURCE_REMOVE;
        });
    }

    _renderTab() {
        if (!this._expanded) return;
        const id = this._activeTab;
        let child = null;
        try {
            if (id === 'media') {
                child = renderMediaView(this._modules.mpris);
            } else {
                const mod = {
                    system:   this._modules.system,
                    calendar: this._modules.calendar,
                    tasks:    this._modules.calendar,
                    notes:    this._modules.notes,
                    weather:  this._modules.weather,
                    pomodoro: this._modules.pomodoro,
                    stats:    this._modules.stats,
                    quick:    this._modules.quick,
                    claude:   this._modules.claude,
                }[id];
                child = mod?.render?.(id);
            }
        } catch (e) {
            logError(e, `notchex:render:${id}`);
        }
        const old = this._content.get_child();
        this._content.set_child(child ?? new St.Label({text: '—', style_class: 'notchex-empty',
            x_align: Clutter.ActorAlign.CENTER}));
        if (old && old !== child) old.destroy();
        /* content may still be settling its size (async images, fonts) */
        if (!this._resizeIdle) {
            this._resizeIdle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._resizeIdle = 0;
                if (!this._stopped) this._resizeExpanded();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /* ——— Spotlight host ——— */

    _searchW() {
        const mon = Main.layoutManager.primaryMonitor;
        const w = this._px(640);
        return mon ? Math.min(w, mon.width - this._px(24)) : w;
    }

    /* Grow the island into the search surface. Returns false if the
       keyboard grab can't be taken (e.g. another modal is up). */
    openSearch(view, onDismiss) {
        if (this._stopped) return false;
        if (this._searching) return true;
        const grab = Main.pushModal(this, {actionMode: Shell.ActionMode.POPUP});
        if (!grab) return false;
        this._searchGrab = grab;
        this._searching = true;
        this._onSearchDismiss = onDismiss;
        this._clearHoverTimeout();
        this._clearCollapseTimeout();
        this._clearPhaseTimers();
        if (this._expanded) {
            this._expanded = false;
            this._expandedLayer.remove_all_transitions();
            this._expandedLayer.hide();
            const child = this._content.get_child();
            this._content.set_child(null);
            child?.destroy();
        }
        this._events.suspend();
        this._hoverState = false;
        this._subtitle.hide();
        this._fade(this._collapsed, 0, 90, 0, true);

        const layer = this._searchLayer;
        layer.remove_all_transitions();
        if (view.get_parent() && view.get_parent() !== layer) view.get_parent().remove_child(view);
        layer.set_child(view);
        layer.width = this._searchW();
        layer.opacity = 0;
        layer.translation_y = -this._px(6);
        layer.show();
        layer.ease({
            opacity: 255, translation_y: 0,
            duration: this._dur(220), delay: this._dur(60),
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
        this.resizeSearch();
        return true;
    }

    resizeSearch() {
        if (!this._searching) return;
        let natH = 0;
        try { [, natH] = this._searchLayer.get_preferred_height(this._searchW()); } catch (_) {}
        this._animateTo(this._searchW(), Math.max(this._px(this._ch + 20), natH), 300);
    }

    closeSearch(immediate = false) {
        if (!this._searching) return;
        this._searching = false;
        this._onSearchDismiss = null;
        if (this._searchGrab) {
            Main.popModal(this._searchGrab);
            this._searchGrab = null;
        }
        const layer = this._searchLayer;
        const detach = () => {
            if (this._searching) return;
            layer.hide();
            layer.set_child(null);
        };
        layer.remove_all_transitions();
        if (immediate || this._stopped) {
            detach();
        } else {
            layer.ease({
                opacity: 0, translation_y: -this._px(4), duration: this._dur(110),
                mode: Clutter.AnimationMode.EASE_IN_QUAD, onComplete: detach,
            });
        }
        if (this._stopped) return;
        this._collapsed.opacity = 0;
        this._collapsed.show();
        const [w, h] = this._idleSize();
        this._animateTo(w, h, 300, Clutter.AnimationMode.EASE_OUT_QUINT, this._dur(60));
        this._fade(this._collapsed, 255, 200, this._dur(160));
        this._phaseTimer(this._dur(380), () => {
            if (!this._searching && !this._expanded) this._events.resume();
        });
    }

    /* ——— events (EventManager host) ——— */

    canShowEvents() {
        return !this._stopped && !this._expanded && !this._searching;
    }

    _eventSize(ev) {
        const w = this._px(ev.width ?? 360);
        let natH = 0;
        try { [, natH] = this._activity.get_preferred_height(w); } catch (_) {}
        return [w, Math.max(this._px(this._ch + 10), natH)];
    }

    _buildEventActor(ev) {
        try {
            return ev.build(ev);
        } catch (e) {
            logError(e, `notchex:event:${ev.key}`);
            return null;
        }
    }

    _setActivityChild(actor) {
        const old = this._activity.get_child();
        this._activity.set_child(actor);
        if (old && old !== actor) old.destroy();
    }

    showEvent(ev, replacing) {
        const content = this._buildEventActor(ev);
        if (!content) {
            this._events.dismiss();
            return;
        }
        this._eventActive = true;
        this._clearHoverTimeout();
        if (this._hoverState) {
            this._hoverState = false;
            this._subtitle.hide();
        }
        this._fade(this._collapsed, 0, 90, 0, true);

        this._activity.remove_all_transitions();
        this._activity.opacity = 255;
        this._activity.width = this._px(ev.width ?? 360);
        this._setActivityChild(content);
        this._activity.show();
        content.opacity = 0;
        content.ease({
            opacity: 255,
            duration: this._dur(200),
            delay: this._dur(replacing ? 40 : 90),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });

        const [w, h] = this._eventSize(ev);
        this._animateTo(w, h, 360, Clutter.AnimationMode.EASE_OUT_QUINT);
    }

    updateEvent(ev) {
        if (!this._eventActive) return;
        const content = this._activity.get_child();
        if (content?._nnUpdate) {
            content._nnUpdate(ev);
        } else {
            const fresh = this._buildEventActor(ev);
            if (fresh) this._setActivityChild(fresh);
        }
        this._activity.width = this._px(ev.width ?? 360);
        const [w, h] = this._eventSize(ev);
        this._animateTo(w, h, 220);
    }

    hideEvent(immediate) {
        this._eventActive = false;
        const child = this._activity.get_child();
        const drop = () => {
            if (this._activity.get_child() === child) {
                this._activity.set_child(null);
                child?.destroy();
            }
        };
        this._activity.remove_all_transitions();
        if (immediate || this._expanded || this._stopped) {
            this._activity.hide();
            drop();
            return;
        }
        this._activity.ease({
            opacity: 0, duration: this._dur(110),
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onComplete: () => {
                if (this._eventActive) return;
                this._activity.hide();
                this._activity.opacity = 255;
                drop();
            },
        });
        this._collapsed.opacity = 0;
        this._collapsed.show();
        const [w, h] = this._idleSize();
        this._animateTo(w, h, 320, Clutter.AnimationMode.EASE_OUT_QUINT, this._dur(60));
        this._fade(this._collapsed, 255, 200, this._dur(150));
    }

    _eventDuration() {
        return Math.max(1, this._settings.get_int('event-duration')) * 1000;
    }

    /* Instant full-screen screenshot: fold the island away first so it
       isn't in the picture, then show the result as an island event. */
    takeScreenshot() {
        if (this._stopped || this._shooting) return;
        this._shooting = true;
        this._collapse();
        this._phaseTimer(this._expanded ? 450 : 250, () => {
            takeScreenshot().then(path => {
                this._events.push(Activities.screenshotEvent(path, () => {
                    this._events.dismiss();
                    if (!path) return;
                    try {
                        Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(path).get_uri(),
                            global.create_app_launch_context(0, -1));
                    } catch (e) { logError(e, 'notchex:screenshot:open'); }
                }));
            }).catch(e => logError(e, 'notchex:screenshot')).finally(() => {
                this._shooting = false;
            });
        });
    }

    showAppLaunch(app) {
        if (this._stopped || !app) return;
        this._events.push(Activities.appLaunchEvent(app));
    }

    _onVolume(state) {
        if (!this._settings.get_boolean('event-volume')) return;
        this._events.push(Activities.volumeEvent(state, this._scale()));
    }

    _onBrightness(level) {
        if (!this._settings.get_boolean('event-brightness')) return;
        this._events.push(Activities.brightnessEvent(level, this._scale()));
    }

    /* Native OSD about to be shown. If the island can present it instead,
       show our version (from live mixer/backlight state, so repeated key
       presses at 0 %/100 % still give feedback) and swallow the OSD. */
    _onOsd(kind) {
        if (this._stopped || !this.mapped) return false;
        if (!this._settings.get_boolean('replace-system-osd')) return false;
        if (kind === 'volume') {
            if (!this._settings.get_boolean('event-volume')) return false;
            const st = this._modules.volume.state();
            if (!st || !this._events.wouldShow('volume', Priority.VOLUME)) return false;
            this._events.push(Activities.volumeEvent(st, this._scale()));
            return true;
        }
        if (kind === 'brightness') {
            if (!this._settings.get_boolean('event-brightness')) return false;
            const level = this._modules.brightness.level();
            if (level === null || !this._events.wouldShow('brightness', Priority.BRIGHTNESS)) return false;
            this._events.push(Activities.brightnessEvent(level, this._scale()));
            return true;
        }
        return false;
    }

    _onBatteryEvent(ev) {
        if (!this._settings.get_boolean('event-battery')) return;
        const e = Activities.batteryEvent(ev, this._eventDuration());
        if (e) this._events.push(e);
    }

    _onBluetooth(dev) {
        if (!this._settings.get_boolean('event-bluetooth')) return;
        this._events.push(Activities.bluetoothEvent(dev, this._eventDuration()));
    }

    _onTrackChanged(info) {
        if (!this._settings.get_boolean('event-media')) return;
        if (this._expanded && this._activeTab === 'media') return;
        /* give remote artwork a moment to download so the event shows it */
        const timeout = new Promise(resolve => this._phaseTimer(1200, resolve));
        Promise.race([resolveArt(info.artUrl), timeout]).then(() => {
            if (this._stopped) return;
            const cur = this._modules.mpris.info();
            if (!cur?.playing || cur.title !== info.title) return;
            this._events.push(Activities.mediaEvent(cur, Math.max(2500, this._eventDuration() - 500),
                () => this._expand('media')));
        }).catch(() => {});
    }

    _checkUpcomingEvents() {
        if (!this._settings.get_boolean('event-calendar')) return;
        const cal = this._modules.calendar;
        if (!cal?._running || !cal.upcoming) return;
        const lead = this._settings.get_int('calendar-lead-minutes');
        const now = Date.now() / 1000;
        for (const [k, t] of this._calNotified) {
            if (now - t > 86400) this._calNotified.delete(k);
        }
        let upcoming = [];
        try { upcoming = cal.upcoming(lead * 60 + 30); } catch (e) { logError(e, 'notchex:calendar:upcoming'); }
        for (const ev of upcoming) {
            const mins = Math.max(0, Math.round((ev.start - now) / 60));
            const stage = mins <= 0 ? 'now' : 'soon';
            const k = `${ev.id}|${ev.start}|${stage}`;
            if (this._calNotified.has(k)) continue;
            this._calNotified.set(k, now);
            if (stage === 'soon' && this._calNotified.has(`${ev.id}|${ev.start}|now`)) continue;
            this._events.push(Activities.calendarEvent(ev, mins, this._eventDuration(),
                () => this._expand('calendar')));
        }
    }

    /* ——— pill contents ——— */

    _onSystemUpdated(stats) {
        this._latestStats = stats;
        if (!this._batteryState?.present) this._updateBatteryIcon();
        this._updateSystemChip();
        this._rerenderIf('system');
    }

    _updateSystemChip() {
        const want = this._settings.get_boolean('pill-show-system');
        const s = this._latestStats;
        const was = this._sysLabel.visible;
        if (want && s) {
            const parts = [`CPU ${Math.round(s.cpu)}%`, `RAM ${Math.round(s.ram)}%`];
            if (s.temp > 0) parts.push(`${Math.round(s.temp)}°`);
            this._sysLabel.text = parts.join('  ');
            this._sysLabel.visible = true;
        } else {
            this._sysLabel.visible = false;
        }
        if (this._sysLabel.visible !== was) this._resizeCollapsed();
    }

    _updateWeatherChip() {
        const want = this._settings.get_boolean('pill-show-weather');
        const sum = want ? this._modules?.weather?.summary?.() : null;
        const was = this._weatherChip.visible;
        if (sum) {
            this._weatherIcon.icon_name = sum.icon;
            this._weatherTemp.text = sum.temp;
        }
        this._weatherChip.visible = !!sum;
        if (this._weatherChip.visible !== was) this._resizeCollapsed();
    }

    _updateBatteryIcon() {
        if (!this._batteryIcon) return;
        let battery = null;
        if (this._batteryState?.present) battery = this._batteryState;
        else if (this._latestStats?.battery) battery = this._latestStats.battery;
        const wasVisible = this._batteryIcon.visible;
        if (!battery) {
            this._batteryIcon.visible = false;
            if (wasVisible) this._resizeCollapsed();
            return;
        }
        const cap = battery.capacity;
        const status = (battery.status ?? '').toLowerCase();
        const plugged = !!battery.plugged;
        const draining = status === 'discharging';
        const charging = status === 'charging' || (plugged && !draining && cap < 100);
        const low = draining && cap < 20;

        /* Desktop with no real battery drain: hide icon entirely. Also make
           room for the equalizer while music is shown — unless the battery
           is low, which stays visible. */
        if ((!draining && !plugged && cap === 0) || (this._mediaChip.visible && !low)) {
            this._batteryIcon.visible = false;
            if (wasVisible) this._resizeCollapsed();
            return;
        }

        let iconName;
        if (charging)         iconName = cap >= 95 ? 'battery-full-charging-symbolic' : 'battery-good-charging-symbolic';
        else if (cap >= 90)   iconName = 'battery-full-symbolic';
        else if (cap >= 55)   iconName = 'battery-good-symbolic';
        else if (cap >= 25)   iconName = 'battery-low-symbolic';
        else                  iconName = 'battery-caution-symbolic';

        let color;
        if (charging || plugged) color = this._settings.get_string('battery-charging-color');
        else if (low)            color = this._settings.get_string('battery-low-color');
        else if (draining)       color = this._settings.get_string('battery-normal-color');
        else                     color = 'rgba(255, 255, 255, 0.78)';

        this._batteryIcon.icon_name = iconName;
        this._batteryIcon.set_style(`color: ${color};`);
        this._batteryIcon.visible = true;
        if (!wasVisible) this._resizeCollapsed();
    }

    _updateMedia(info) {
        this._latestMedia = info;
        const active = info?.playing || (info?.paused && this._settings.get_boolean('always-show-media'));
        const visible = !!(active && info.title) && this._settings.get_boolean('show-media');
        const wasVisible = this._mediaChip.visible;
        const wasClock = this._centerCluster.visible;
        if (visible) {
            const artKey = `${info.artUrl}|${info.icon}`;
            if (artKey !== this._mediaArtKey) {
                this._mediaArtKey = artKey;
                const old = this._mediaArtSlot.get_child();
                this._mediaArtSlot.set_child(artTile(info, 18, 5, 'notchex-art notchex-pill-art'));
                old?.destroy();
            }
            this._musicTitle.text = info.title;
            this._mediaChip.opacity = info.playing ? 255 : 150;
        }
        this._mediaChip.visible = visible;
        this._eq.actor.visible = visible;
        this._eq.setPlaying(!!(visible && info.playing));
        this._updateBatteryIcon();
        this._centerCluster.visible = this._settings.get_boolean('always-show-clock') || !visible;
        this._dateLabelC.visible = this._settings.get_boolean('show-date') && !visible;
        if (visible !== wasVisible || wasClock !== this._centerCluster.visible || visible)
            this._resizeCollapsed();
        if (this._hoverState) this._subtitle.text = this._subtitleText();
        this._rerenderIf('media');
    }

    _updatePomodoroIndicator() {
        const p = this._modules?.pomodoro;
        if (!this._pomoLabel) return;
        const wasVisible = this._pomoChip.visible;
        this._pomoChip.remove_style_class_name('break');
        this._pomoChip.remove_style_class_name('paused');
        if (!p || (!p.isActive() && p.getState() !== 'paused')) {
            this._pomoChip.visible = false;
        } else {
            this._pomoLabel.text = p.formatRemain();
            this._pomoChip.visible = true;
            if (p.getState() === 'paused') this._pomoChip.add_style_class_name('paused');
            else if (p.getState() === 'break' || p.getState() === 'longbreak') this._pomoChip.add_style_class_name('break');
        }
        if (this._pomoChip.visible !== wasVisible) this._resizeCollapsed();
    }

    /* ——— notifications ——— */

    _dndActive() {
        try {
            this._dndSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            return !this._dndSettings.get_boolean('show-banners');
        } catch (_) { return false; }
    }

    _peekNotification(source, notif) {
        if (this._expanded) return;
        if (!this._settings.get_boolean('show-notifications')) return;
        if (this._dndActive()) return;

        const title = notif?.title ?? source?.title ?? 'Notification';
        let body  = notif?.bannerBodyText ?? notif?.body ?? '';
        const lines = body.split('\n');
        if (lines.length > 6) body = `${lines.slice(0, 6).join('\n')}\n…`;
        if (body.length > 360) body = `${body.slice(0, 360)}…`;

        const ev = Activities.notificationEvent({
            gicon: this._resolveNotifIcon(source, notif),
            title, body,
            critical: notif?.urgency === 3,
            onActivate: () => {
                try {
                    if (typeof notif?.activate === 'function') notif.activate();
                    else if (typeof source?.open === 'function') source.open();
                } catch (e) { logError(e, 'notchex:peek:activate'); }
                this._events.dismiss();
            },
            onDismiss: () => this._events.dismiss(),
        });
        this._events.push(ev);
        if (this._settings.get_boolean('notif-suppress-native')) {
            this._killBanner(0); this._killBanner(60); this._killBanner(220);
        }
    }

    _killBanner(delayMs) {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this._bannerKillTimers?.delete(id);
            try { Main.messageTray._banner?.close?.(); } catch (_) {}
            try { Main.messageTray._bannerBin?.hide?.(); } catch (_) {}
            return GLib.SOURCE_REMOVE;
        });
        (this._bannerKillTimers ??= new Set()).add(id);
    }

    _resolveNotifIcon(source, notif) {
        try {
            if (notif?.gicon)    return notif.gicon;
            if (source?.getIcon) return source.getIcon();
            if (source?.icon)    return source.icon;
        } catch (_) {}
        return Gio.ThemedIcon.new('dialog-information-symbolic');
    }
});
