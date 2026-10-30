import Clutter from 'gi://Clutter';
import St from 'gi://St';

import {renderMediaView} from './media.js';

/* The "Now" view: what is happening right now, in one glance. The music
   card leads when something is playing; under it, small cards for the next
   meeting, the focus timer and the weather. Each card opens its full view.
   Cards with nothing to say are left out rather than shown empty. */

function card({icon, caption, title, detail, tint, onClick}) {
    const btn = new St.Button({
        style_class: 'notchex-now-card',
        can_focus: true,
        x_expand: true,
        track_hover: true,
        accessible_name: [caption, title, detail].filter(Boolean).join(', '),
    });
    const col = new St.BoxLayout({vertical: true, x_expand: true, y_expand: true,
        style_class: 'notchex-now-card-col'});
    const top = new St.BoxLayout({style_class: 'notchex-now-card-top'});
    const ic = new St.Icon({icon_name: icon, icon_size: 14, style_class: 'notchex-now-card-icon',
        y_align: Clutter.ActorAlign.CENTER});
    const cap = new St.Label({text: caption, style_class: 'notchex-now-card-caption',
        y_align: Clutter.ActorAlign.CENTER});
    if (tint) {
        ic.set_style(`color: ${tint};`);
        cap.set_style(`color: ${tint};`);
    }
    top.add_child(ic);
    top.add_child(cap);
    col.add_child(top);
    const t = new St.Label({text: title, style_class: 'notchex-now-card-title'});
    t.clutter_text.ellipsize = 3;
    col.add_child(t);
    if (detail) {
        const d = new St.Label({text: detail, style_class: 'notchex-now-card-detail'});
        d.clutter_text.ellipsize = 3;
        col.add_child(d);
    }
    /* fills the rest, so cards with and without a detail line start level */
    col.add_child(new St.Widget({y_expand: true}));
    btn.set_child(col);
    btn._title = t;
    if (onClick) btn.connect('clicked', onClick);
    return btn;
}

export function joinButton(onJoin) {
    const b = new St.Button({label: 'Join', style_class: 'notchex-join-btn', can_focus: true,
        y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Join video call'});
    b.connect('clicked', () => onJoin());
    return b;
}

function minutesUntil(startSec) {
    return Math.round((startSec - Date.now() / 1000) / 60);
}

function relTime(startSec) {
    const m = minutesUntil(startSec);
    if (m <= 0) return 'Now';
    if (m < 60) return `In ${m} min`;
    const h = Math.floor(m / 60), r = m % 60;
    return r ? `In ${h} h ${r} min` : `In ${h} h`;
}

/* mods: {mpris, calendar, pomodoro, weather}; open(viewId) switches view;
   showMedia: false when the media player is turned off in preferences */
export function renderNowView(mods, open, {showMedia = true} = {}) {
    const box = new St.BoxLayout({style_class: 'notchex-now', vertical: true, x_expand: true});

    const info = mods.mpris?.info?.();
    if (showMedia && info && (info.playing || info.paused))
        box.add_child(renderMediaView(mods.mpris));

    const cards = new St.BoxLayout({style_class: 'notchex-now-cards', x_expand: true});

    /* next meeting */
    const cal = mods.calendar;
    if (cal?._running) {
        const next = cal.upcoming?.(12 * 3600)?.[0];
        if (next) {
            const soon = minutesUntil(next.start) <= 10;
            const at = new Date(next.start * 1000).toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'});
            const evCard = card({
                icon: 'x-office-calendar-symbolic',
                caption: relTime(next.start),
                title: next.summary || 'Event',
                detail: at,
                tint: soon ? 'rgb(255, 120, 110)' : null,
                onClick: () => open('calendar'),
            });
            /* a Join button once the call is close (15 min) */
            if (cal.meetingLink?.(next) && minutesUntil(next.start) <= 15) {
                const wrap = new St.BoxLayout({style_class: 'notchex-now-join-wrap', x_expand: true});
                wrap.add_child(evCard);
                wrap.add_child(joinButton(() => cal.joinMeeting(next)));
                cards.add_child(wrap);
            } else {
                cards.add_child(evCard);
            }
        } else {
            cards.add_child(card({
                icon: 'x-office-calendar-symbolic',
                caption: 'Calendar',
                title: 'No more events',
                detail: 'Next 12 hours are free',
                onClick: () => open('calendar'),
            }));
        }
    }

    /* focus timer */
    const p = mods.pomodoro;
    if (p) {
        const st = p.getState?.() ?? 'idle';
        const live = st !== 'idle';
        const timer = card({
            icon: 'alarm-symbolic',
            caption: live ? p._stateLabel?.() ?? 'Timer' : 'Timer',
            title: live ? `${p.formatRemain()} left` : 'Start a focus session',
            detail: live ? (st === 'paused' ? 'Paused' : null) : null,
            tint: live && st !== 'paused' ? 'rgb(255, 150, 120)' : null,
            onClick: () => open('pomodoro'),
        });
        cards.add_child(timer);
        box._timerTitle = timer._title;
    }

    /* weather */
    const w = mods.weather?._running ? mods.weather.summary?.() : null;
    if (w) {
        cards.add_child(card({
            icon: w.icon,
            caption: 'Weather',
            title: w.temp,
            detail: w.desc ?? null,
            onClick: () => open('weather'),
        }));
    }

    if (cards.get_n_children())
        box.add_child(cards);
    else if (!box.get_n_children())
        box.add_child(new St.Label({text: 'Nothing happening right now', style_class: 'notchex-empty',
            x_align: Clutter.ActorAlign.CENTER}));
    return box;
}
