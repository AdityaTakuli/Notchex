import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';

import {Priority} from './events.js';
import {artTile, appIcon} from './media.js';

/* Builders for the transient island events ("live activities"). Each
   returns a plain event object for EventManager.push():
     key        — events with the same key update in place
     priority   — see events.js
     duration   — ms on screen
     width      — logical px of the island while showing it
     build(ev)  — returns the content actor; may set actor._nnUpdate(ev)
                  to update itself in place when an event with the same
                  key arrives
     onClick    — optional, pointer release on the island
     compact    — true: Dynamic Island "compact" look, the island keeps
                  its idle height and holds a leading and a trailing
                  element (see _compact) */

const LEVEL_TRACK_PX = 168;

/* status colors, one meaning each */
const GREEN  = [48, 209, 88];
const RED    = [255, 69, 58];
const PURPLE = [191, 90, 242];
const css = c => `rgb(${c.join(', ')})`;

/* ——— compact building blocks ——— */

/* leading element on the left, trailing on the right, with the island's
   middle left empty. The notch animates both out from the centre. */
function _compact(leading, trailing, cls = '') {
    const row = new St.BoxLayout({style_class: `notchex-act compact ${cls}`, x_expand: true});
    const lead = new St.BoxLayout({style_class: 'notchex-compact-lead', y_align: Clutter.ActorAlign.CENTER});
    const trail = new St.BoxLayout({style_class: 'notchex-compact-trail', y_align: Clutter.ActorAlign.CENTER,
        x_expand: true, x_align: Clutter.ActorAlign.END});
    for (const a of [].concat(leading)) lead.add_child(a);
    for (const a of [].concat(trailing)) trail.add_child(a);
    row.add_child(lead);
    row.add_child(trail);
    row._leading = lead;
    row._trailing = trail;
    return row;
}

function _label(text, cls, color = null) {
    const l = new St.Label({text, style_class: cls, y_align: Clutter.ActorAlign.CENTER});
    if (color) l.set_style(`color: ${css(color)};`);
    return l;
}

/* a ring that fills to `frac` when shown (battery level, progress) */
function _ring(frac, color, sizeLogical = 22) {
    /* actor sizes are in physical pixels: scale for HiDPI */
    const px = Math.round(sizeLogical * St.ThemeContext.get_for_stage(global.stage).scale_factor);
    const ring = new St.DrawingArea({style_class: 'notchex-ring', y_align: Clutter.ActorAlign.CENTER,
        width: px, height: px});
    ring._t = 0;
    ring.connect('repaint', area => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const lw = Math.max(2, w * 0.13);
        const r = Math.min(w, h) / 2 - lw / 2;
        cr.setLineWidth(lw);
        cr.setSourceRGBA(color[0] / 255, color[1] / 255, color[2] / 255, 0.25);
        cr.arc(w / 2, h / 2, r, 0, 2 * Math.PI);
        cr.stroke();
        const f = Math.max(0, Math.min(1, frac)) * ring._t;
        if (f > 0) {
            cr.setSourceRGBA(color[0] / 255, color[1] / 255, color[2] / 255, 1);
            cr.setLineCap(1); /* ROUND */
            cr.arc(w / 2, h / 2, r, -Math.PI / 2, -Math.PI / 2 + f * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    });
    /* the notch calls this once the island has opened */
    ring._reveal = duration => {
        if (duration <= 0) { ring._t = 1; ring.queue_repaint(); return; }
        const tl = new Clutter.Timeline({actor: ring, duration});
        tl.set_progress_mode(Clutter.AnimationMode.EASE_OUT_CUBIC);
        tl.connect('new-frame', () => { ring._t = tl.get_progress(); ring.queue_repaint(); });
        tl.connect('completed', () => { ring._t = 1; ring.queue_repaint(); });
        tl.start();
    };
    return ring;
}

/* a small battery outline filled to `frac` */
function _battery(frac, color) {
    const box = new St.BoxLayout({style_class: 'notchex-batt-glyph', y_align: Clutter.ActorAlign.CENTER});
    const shell = new St.Widget({style_class: 'notchex-batt-shell', layout_manager: new Clutter.BinLayout()});
    shell.set_style(`border-color: rgba(${color.join(', ')}, 0.55); background-color: rgba(${color.join(', ')}, 0.22);`);
    const fill = new St.Widget({style_class: 'notchex-batt-fill', x_align: Clutter.ActorAlign.START,
        y_expand: true, y_align: Clutter.ActorAlign.FILL});
    fill.set_style(`background-color: ${css(color)}; width: ${Math.max(2, Math.round(22 * Math.max(0, Math.min(1, frac))))}px;`);
    shell.add_child(fill);
    const nub = new St.Widget({style_class: 'notchex-batt-nub', y_align: Clutter.ActorAlign.CENTER});
    nub.set_style(`background-color: rgba(${color.join(', ')}, 0.55);`);
    box.add_child(shell);
    box.add_child(nub);
    return box;
}

/* ——— focus (do not disturb) ——— */

export function focusEvent(on) {
    return {
        key: 'focus', priority: Priority.VOLUME, duration: 2200, width: 300, compact: true,
        build() {
            const moon = _icon('weather-clear-night-symbolic', 'focus', 20);
            moon.set_style(`color: ${css(on ? PURPLE : [174, 174, 178])};`);
            return _compact(moon, _label(on ? 'On' : 'Off', 'notchex-compact-value', on ? PURPLE : [174, 174, 178]),
                'focus');
        },
    };
}

function _row(styleClass = '') {
    return new St.BoxLayout({style_class: `notchex-act ${styleClass}`, x_expand: true});
}

function _textCol(caption, title, subtitle) {
    const col = new St.BoxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        style_class: 'notchex-act-text'});
    const mk = (text, cls) => {
        const l = new St.Label({text, style_class: cls});
        l.clutter_text.ellipsize = 3; /* END */
        col.add_child(l);
        return l;
    };
    col._caption = caption ? mk(caption, 'notchex-act-caption') : null;
    col._title = mk(title ?? '', 'notchex-act-title');
    col._subtitle = subtitle ? mk(subtitle, 'notchex-act-subtitle') : null;
    return col;
}

function _icon(name, cls = '', size = 18) {
    return new St.Icon({
        gicon: name instanceof Gio.Icon ? name : Gio.ThemedIcon.new(name),
        icon_size: size,
        style_class: `notchex-act-icon ${cls}`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/* ——— volume / brightness ——— */

function _volumeIcon(level, muted) {
    if (muted || level <= 0) return 'audio-volume-muted-symbolic';
    if (level > 1.0) return 'audio-volume-overamplified-symbolic';
    if (level < 0.34) return 'audio-volume-low-symbolic';
    if (level < 0.67) return 'audio-volume-medium-symbolic';
    return 'audio-volume-high-symbolic';
}

function _levelEvent({key, priority, icon, level, valueText, muted, scale, duration}) {
    return {
        key, priority, duration,
        width: 300,
        queueable: false,
        level, icon, valueText, muted,
        build(ev) {
            const row = _row('notchex-act-level');
            const ic = _icon(ev.icon, '', 17);
            const track = new St.Widget({style_class: 'notchex-level-track', y_align: Clutter.ActorAlign.CENTER});
            const fill = new St.Widget({style_class: 'notchex-level-fill'});
            track.add_child(fill);
            const val = new St.Label({style_class: 'notchex-act-value', y_align: Clutter.ActorAlign.CENTER,
                x_expand: true, x_align: Clutter.ActorAlign.END});
            row.add_child(ic);
            row.add_child(track);
            row.add_child(val);
            const trackPx = Math.round(LEVEL_TRACK_PX * scale);
            const apply = (e, animate) => {
                ic.gicon = Gio.ThemedIcon.new(e.icon);
                val.text = e.valueText;
                row[e.muted ? 'add_style_class_name' : 'remove_style_class_name']('muted');
                const w = Math.round(trackPx * Math.max(0, Math.min(1, e.muted ? 0 : e.level)));
                fill.remove_all_transitions();
                if (animate) fill.ease({width: w, duration: 140, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
                else fill.width = w;
            };
            apply(ev, false);
            row._nnUpdate = e => apply(e, true);
            return row;
        },
    };
}

export function volumeEvent(state, scale) {
    return _levelEvent({
        key: 'volume', priority: Priority.VOLUME, duration: 1800, scale,
        level: state.level, muted: state.muted,
        icon: _volumeIcon(state.level, state.muted),
        valueText: state.muted ? 'Muted' : `${Math.round(state.level * 100)}%`,
    });
}

export function brightnessEvent(level, scale) {
    return _levelEvent({
        key: 'brightness', priority: Priority.BRIGHTNESS, duration: 1800, scale,
        level, muted: false,
        icon: 'display-brightness-symbolic',
        valueText: `${Math.round(level * 100)}%`,
    });
}

/* ——— battery ——— */

export function batteryEvent(ev, duration) {
    const spec = {
        plugged:   {title: 'Charging',         color: GREEN,           prio: Priority.BLUETOOTH},
        full:      {title: 'Fully Charged',    color: GREEN,           prio: Priority.BLUETOOTH},
        unplugged: {title: 'On Battery',       color: [255, 255, 255], prio: Priority.VOLUME},
        low:       {title: 'Low Battery',      color: RED,             prio: Priority.NOTIFICATION},
        critical:  {title: 'Battery Critical', color: RED,             prio: Priority.CRITICAL},
    }[ev.kind];
    if (!spec) return null;
    return {
        key: 'battery', priority: spec.prio, compact: true,
        duration: ev.kind === 'critical' ? Math.max(duration, 6000) : duration,
        width: 340,
        build() {
            const trailing = [_label(`${ev.pct}%`, 'notchex-compact-value', spec.color),
                _battery(ev.pct / 100, spec.color)];
            return _compact(_label(spec.title, 'notchex-compact-title'), trailing, `battery ${ev.kind}`);
        },
    };
}

function _dur(min) {
    if (min < 60) return `${min} min`;
    const h = Math.floor(min / 60), m = min % 60;
    return m ? `${h} h ${m} min` : `${h} h`;
}

/* ——— bluetooth ——— */

const BT_ICONS = {
    'audio-headphones': 'audio-headphones-symbolic',
    'audio-headset':    'audio-headset-symbolic',
    'audio-card':       'audio-speakers-symbolic',
    'input-mouse':      'input-mouse-symbolic',
    'input-keyboard':   'input-keyboard-symbolic',
    'input-gaming':     'input-gaming-symbolic',
    'input-tablet':     'input-tablet-symbolic',
    'phone':            'phone-symbolic',
    'computer':         'computer-symbolic',
};

/* a blue action button on the right of a compact pill. onClick(btn) does
   the work; the button shows `busy` while it runs. */
function _action(label, accessible, onClick, busy = null) {
    const b = new St.Button({label, style_class: 'notchex-compact-action', can_focus: true,
        y_align: Clutter.ActorAlign.CENTER, accessible_name: accessible});
    b.connect('clicked', () => {
        if (busy) {
            b.label = busy;
            b.reactive = false;
            b.add_style_pseudo_class('insensitive');
        }
        onClick(b);
    });
    return b;
}

/* swaps a trailing part for a green check that pops in */
function _confirm(trailing, text) {
    trailing.remove_all_children();
    const ic = _icon('object-select-symbolic', 'done', 16);
    ic.set_style(`color: ${css(GREEN)};`);
    trailing.add_child(ic);
    trailing.add_child(_label(text, 'notchex-compact-value', GREEN));
    trailing.set_pivot_point(1, 0.5);
    trailing.scale_x = trailing.scale_y = 0.7;
    trailing.ease({scale_x: 1, scale_y: 1, duration: 320, mode: Clutter.AnimationMode.EASE_OUT_BACK});
}

/* actions (both optional):
     route()            — moves sound to this device; returns true if it did
     reconnect(done)    — asks the device to connect again; done(ok) */
export function bluetoothEvent(dev, duration, actions = {}) {
    const icon = BT_ICONS[dev.icon] ?? 'bluetooth-active-symbolic';
    const {route = null, reconnect = null} = actions;
    const hasAction = !!(dev.connected ? route : reconnect);
    return {
        key: `bt:${dev.path}`, priority: Priority.BLUETOOTH, width: hasAction ? 380 : 340, compact: true,
        /* long enough to reach the button */
        duration: hasAction ? Math.max(duration, 8000) : duration,
        build() {
            const ic = _icon(icon, 'bt', 20);
            const name = _label(dev.name, 'notchex-compact-name');
            name.clutter_text.ellipsize = 3;
            let trailing;
            if (!dev.connected) {
                ic.opacity = 150;
                trailing = reconnect
                    ? _action('Reconnect', `Reconnect ${dev.name}`, b => reconnect(ok => {
                        if (ok || !b.get_stage()) return;
                        b.label = 'Try Again';
                        b.reactive = true;
                        b.remove_style_pseudo_class('insensitive');
                    }), 'Connecting…')
                    : _label('Disconnected', 'notchex-compact-value', [174, 174, 178]);
            } else {
                const low = Number.isFinite(dev.battery) && dev.battery <= 20;
                trailing = [];
                if (Number.isFinite(dev.battery)) {
                    trailing.push(_label(`${dev.battery}%`, 'notchex-compact-value', low ? RED : GREEN));
                    if (!route) trailing.push(_ring(dev.battery / 100, low ? RED : GREEN));
                } else if (!route) {
                    trailing.push(_label('Connected', 'notchex-compact-value', GREEN));
                }
                if (route) {
                    trailing.push(_action('Play Here', `Play sound on ${dev.name}`, () => {
                        if (route()) _confirm(row._trailing, 'Playing');
                    }));
                }
            }
            const row = _compact([ic, name], trailing, 'bt');
            return row;
        },
    };
}

/* ——— media ——— */

export function mediaEvent(info, duration, onClick) {
    return {
        key: 'media', priority: Priority.MEDIA, duration, width: 380,
        ttl: 6000,
        onClick,
        build() {
            const row = _row('notchex-act-media');
            row.add_child(artTile(info, 36, 9));
            row.add_child(_textCol('Now Playing', info.title, info.artist || null));
            row.add_child(new St.Icon({gicon: appIcon(info.icon), icon_size: 16,
                style_class: 'notchex-act-app', y_align: Clutter.ActorAlign.CENTER}));
            return row;
        },
    };
}

/* ——— calendar ——— */

export function calendarEvent(ev, minutesAway, duration, onClick, onJoin = null) {
    const when = new Date(ev.start * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const caption = minutesAway <= 0 ? 'Starting now' : `In ${minutesAway} min`;
    return {
        key: `cal:${ev.id}`, priority: Priority.CALENDAR, width: onJoin ? 420 : 360,
        /* with a Join button, stay up long enough to reach it */
        duration: Math.max(duration, onJoin ? 12000 : 5000),
        ttl: 60000,
        onClick,
        build() {
            const row = _row('notchex-act-cal');
            row.add_child(_icon('x-office-calendar-symbolic', 'cal', 20));
            row.add_child(_textCol(caption, ev.summary || 'Untitled event'));
            row.add_child(new St.Label({text: when, style_class: 'notchex-act-value',
                y_align: Clutter.ActorAlign.CENTER}));
            if (onJoin) {
                const b = new St.Button({label: 'Join', style_class: 'notchex-join-btn', can_focus: true,
                    y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Join video call'});
                b.connect('clicked', () => onJoin());
                row.add_child(b);
            }
            return row;
        },
    };
}

/* ——— notifications ——— */

export function notificationEvent({gicon, title, body, critical, onActivate, onDismiss}) {
    const timeStr = new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    return {
        key: 'notification',
        priority: critical ? Priority.CRITICAL : Priority.NOTIFICATION,
        duration: 5500, width: 520, ttl: 20000,
        holdOnHover: true,
        blocksExpand: true,
        onClick: onActivate,
        build() {
            const row = _row('notchex-act-notif');
            const iconBin = new St.Bin({style_class: 'notchex-peek-icon-bin', y_align: Clutter.ActorAlign.CENTER});
            iconBin.set_child(new St.Icon({gicon, icon_size: 28, style_class: 'notchex-peek-icon'}));
            row.add_child(iconBin);

            const textCol = new St.BoxLayout({vertical: true, x_expand: true,
                y_align: Clutter.ActorAlign.CENTER, style_class: 'notchex-peek-text'});
            const titleRow = new St.BoxLayout();
            const t = new St.Label({text: title, style_class: 'notchex-peek-title', x_expand: true});
            t.clutter_text.ellipsize = 3;
            titleRow.add_child(t);
            titleRow.add_child(new St.Label({text: timeStr, style_class: 'notchex-peek-time'}));
            textCol.add_child(titleRow);
            if (body) {
                const b = new St.Label({text: body, style_class: 'notchex-peek-body'});
                b.clutter_text.line_wrap = true;
                textCol.add_child(b);
            }
            row.add_child(textCol);

            const dismiss = new St.Button({
                style_class: 'notchex-peek-dismiss',
                child: new St.Icon({icon_name: 'window-close-symbolic', icon_size: 12}),
                y_align: Clutter.ActorAlign.CENTER,
                accessible_name: 'Dismiss notification',
                can_focus: true,
            });
            dismiss.connect('clicked', () => onDismiss());
            row.add_child(dismiss);
            return row;
        },
    };
}

/* ——— app launch (from the Dock / Spotlight) ——— */

export function appLaunchEvent(app) {
    return {
        key: 'launch', priority: Priority.SYSTEM, duration: 1800, width: 300,
        queueable: false,
        build() {
            const row = _row('notchex-act-launch');
            row.add_child(new St.Icon({gicon: app.get_icon(), icon_size: 26,
                y_align: Clutter.ActorAlign.CENTER}));
            row.add_child(_textCol(null, app.get_name(), 'Opening…'));
            return row;
        },
    };
}

/* ——— screenshot taken ——— */

export function screenshotEvent(path, onClick) {
    return {
        key: 'screenshot', priority: Priority.NOTIFICATION, duration: 3500, width: 340,
        queueable: false,
        onClick,
        build() {
            const row = _row('notchex-act-shot');
            const thumb = new St.Bin({style_class: 'notchex-act-shot-thumb', y_align: Clutter.ActorAlign.CENTER});
            if (path) {
                thumb.set_style(`width: 58px; height: 36px; background-image: url("${path.replace(/"/g, '\\"')}"); background-size: cover;`);
            } else {
                thumb.set_child(_icon('camera-photo-symbolic', '', 20));
            }
            row.add_child(thumb);
            row.add_child(_textCol(null, 'Screenshot Taken',
                path ? 'Copied · Saved to Pictures/Screenshots' : 'Copied to clipboard'));
            return row;
        },
    };
}
