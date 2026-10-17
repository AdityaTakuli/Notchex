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
     onClick    — optional, pointer release on the island */

const LEVEL_TRACK_PX = 168;

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
    const pct = `${ev.pct}%`;
    const spec = {
        plugged:   {title: 'Charging',        icon: 'battery-good-charging-symbolic', cls: 'charging', prio: Priority.BLUETOOTH},
        full:      {title: 'Fully Charged',   icon: 'battery-full-charged-symbolic',  cls: 'charging', prio: Priority.BLUETOOTH},
        unplugged: {title: 'On Battery',      icon: 'battery-good-symbolic',          cls: '',         prio: Priority.VOLUME},
        low:       {title: 'Battery Low',     icon: 'battery-low-symbolic',           cls: 'low',      prio: Priority.NOTIFICATION},
        critical:  {title: 'Battery Critical', icon: 'battery-caution-symbolic',      cls: 'critical', prio: Priority.CRITICAL},
    }[ev.kind];
    if (!spec) return null;
    let subtitle = null;
    if (ev.kind === 'plugged' && ev.minutes) subtitle = `${_dur(ev.minutes)} until full`;
    if ((ev.kind === 'low' || ev.kind === 'critical' || ev.kind === 'unplugged') && ev.minutes)
        subtitle = `${_dur(ev.minutes)} remaining`;
    return {
        key: 'battery', priority: spec.prio,
        duration: ev.kind === 'critical' ? Math.max(duration, 6000) : duration,
        width: 300,
        build() {
            const row = _row(`notchex-act-battery ${spec.cls}`);
            row.add_child(_icon(spec.icon, 'battery', 20));
            row.add_child(_textCol(null, spec.title, subtitle));
            row.add_child(new St.Label({text: pct, style_class: 'notchex-act-value strong',
                y_align: Clutter.ActorAlign.CENTER}));
            return row;
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

export function bluetoothEvent(dev, duration) {
    const icon = BT_ICONS[dev.icon] ?? 'bluetooth-active-symbolic';
    return {
        key: `bt:${dev.path}`, priority: Priority.BLUETOOTH, duration, width: 320,
        build() {
            const row = _row('notchex-act-bt' + (dev.connected ? ' connected' : ''));
            row.add_child(_icon(icon, 'bt', 20));
            row.add_child(_textCol(null, dev.name, dev.connected ? 'Connected' : 'Disconnected'));
            if (dev.connected && Number.isFinite(dev.battery)) {
                const bat = new St.BoxLayout({style_class: 'notchex-act-bt-battery', y_align: Clutter.ActorAlign.CENTER});
                bat.add_child(_icon(dev.battery <= 20 ? 'battery-low-symbolic' : 'battery-good-symbolic',
                    dev.battery <= 20 ? 'low' : '', 14));
                bat.add_child(new St.Label({text: `${dev.battery}%`, style_class: 'notchex-act-value strong',
                    y_align: Clutter.ActorAlign.CENTER}));
                row.add_child(bat);
            }
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

export function calendarEvent(ev, minutesAway, duration, onClick) {
    const when = new Date(ev.start * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
    const caption = minutesAway <= 0 ? 'Starting now' : `In ${minutesAway} min`;
    return {
        key: `cal:${ev.id}`, priority: Priority.CALENDAR, duration: Math.max(duration, 5000), width: 360,
        ttl: 60000,
        onClick,
        build() {
            const row = _row('notchex-act-cal');
            row.add_child(_icon('x-office-calendar-symbolic', 'cal', 20));
            row.add_child(_textCol(caption, ev.summary || 'Untitled event'));
            row.add_child(new St.Label({text: when, style_class: 'notchex-act-value',
                y_align: Clutter.ActorAlign.CENTER}));
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
