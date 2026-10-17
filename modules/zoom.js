import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FrameLoop} from './animations.js';

/* macOS-style screen Zoom (System Settings → Accessibility → Zoom) on top
   of GNOME's own magnifier:

   - three-finger pinch: spread to zoom in, pinch to zoom out, live
   - three-finger double-tap: toggle between 1× and the last zoom level

   Touchpad gestures always reach the shell (unlike clicks and scrolls,
   which Mutter hands straight to the window under the pointer), so this
   works over any app. The keyboard side needs nothing from us: GNOME's
   defaults are already the Mac ones (⌥⌘8 / ⌥⌘= / ⌥⌘- = Alt+Super+8/=/-).

   The magnifier is driven directly while a gesture runs (no dconf write
   per frame); the result is saved to its settings when the gesture ends,
   so the Accessibility menu and Settings stay in sync. */

const FINGERS = 3;
const MIN_FACTOR = 1.0;
const MAX_FACTOR = 12.0;
const OFF_BELOW = 1.08;       /* releasing a pinch under this turns zoom off */
const DEFAULT_FACTOR = 2.0;
const PINCH_EXPONENT = 1.6;   /* >1 = faster than the fingers, like macOS */
const TAP_MAX_MS = 400;
const DOUBLE_TAP_MS = 500;
const TAP_SETTLE_MS = 140;    /* wait this long for a swipe/pinch before acting */
const TOGGLE_SPEED = 9;       /* 1/s, exponential approach for the toggle animation */

const A11Y_SCHEMA = 'org.gnome.desktop.a11y.applications';
const MAG_SCHEMA = 'org.gnome.desktop.a11y.magnifier';

export class TrackpadZoom {
    constructor(settings) {
        this._settings = settings;
        this._a11y = new Gio.Settings({schema_id: A11Y_SCHEMA});
        this._mag = new Gio.Settings({schema_id: MAG_SCHEMA});
        this._pinch = null;
        this._holdStart = 0;
        this._lastTap = 0;
        this._tapTimer = 0;
        this._target = 0;
        this._loop = new FrameLoop(global.stage, dt => this._stepToggle(dt));

        this._enabledSig = settings.connect('changed::zoom-gestures', () => this._sync());
        this._sync();
    }

    destroy() {
        this._settings.disconnect(this._enabledSig);
        this._disconnect();
        this._loop.destroy();
        this._loop = null;
    }

    _sync() {
        const on = this._settings.get_boolean('zoom-gestures');
        if (on && !this._eventSig)
            this._eventSig = global.stage.connect('captured-event::touchpad', (_a, ev) => this._onEvent(ev));
        else if (!on)
            this._disconnect();
    }

    _disconnect() {
        if (this._eventSig) global.stage.disconnect(this._eventSig);
        this._eventSig = 0;
        if (this._tapTimer) GLib.source_remove(this._tapTimer);
        this._tapTimer = 0;
        if (this._pinch) this._finish();
        this._loop?.stop();
    }

    get _region() {
        return Main.magnifier?.getZoomRegions?.()[0] ?? null;
    }

    _factor() {
        if (!Main.magnifier?.isActive()) return 1;
        return this._region?.getMagFactor()[0] ?? 1;
    }

    /* Show the magnifier at `f` (or hide it at ~1×) without touching dconf */
    _apply(f) {
        const region = this._region;
        if (!region) return;
        f = Math.min(MAX_FACTOR, Math.max(MIN_FACTOR, f));
        const active = Main.magnifier.isActive();
        if (f > 1.001) {
            region.setMagFactor(f, f);
            if (!active) Main.magnifier.setActive(true);
        } else if (active) {
            Main.magnifier.setActive(false);
            /* leave the region at the saved level, so ⌥⌘8 (which doesn't
               re-read the setting) still zooms in to something useful */
            const saved = Math.max(DEFAULT_FACTOR, this._mag.get_double('mag-factor'));
            region.setMagFactor(saved, saved);
        }
    }

    /* Persist the final state so GNOME's magnifier settings agree with
       what's on screen (and a later login/unlock restores it). */
    _commit(f) {
        const on = f >= OFF_BELOW;
        if (on) {
            const rounded = Math.round(f * 100) / 100;
            if (Math.abs(this._mag.get_double('mag-factor') - rounded) > 0.005)
                this._mag.set_double('mag-factor', rounded);
        } else {
            this._apply(1);
        }
        if (this._a11y.get_boolean('screen-magnifier-enabled') !== on)
            this._a11y.set_boolean('screen-magnifier-enabled', on);
    }

    _onEvent(event) {
        const type = event.type();
        const phase = event.get_gesture_phase();
        const fingers = event.get_touchpad_gesture_finger_count();
        const P = Clutter.TouchpadGesturePhase;

        if (type === Clutter.EventType.TOUCHPAD_PINCH) {
            this._cancelTap();
            if (fingers !== FINGERS) return Clutter.EVENT_PROPAGATE;
            switch (phase) {
            case P.BEGIN:
                this._loop.stop();
                this._pinch = {start: this._factor()};
                break;
            case P.UPDATE:
                if (!this._pinch) this._pinch = {start: this._factor()};
                this._apply(this._pinch.start * Math.pow(event.get_gesture_pinch_scale(), PINCH_EXPONENT));
                break;
            default:
                this._finish();
            }
            /* ours: don't also send a 3-finger pinch to the app */
            return Clutter.EVENT_STOP;
        }

        if (type === Clutter.EventType.TOUCHPAD_SWIPE) {
            this._cancelTap();
            return Clutter.EVENT_PROPAGATE;
        }

        if (type === Clutter.EventType.TOUCHPAD_HOLD) {
            if (fingers !== FINGERS) {
                this._cancelTap();
                return Clutter.EVENT_PROPAGATE;
            }
            if (phase === P.BEGIN) {
                this._holdStart = GLib.get_monotonic_time();
            } else if (phase === P.END && this._holdStart) {
                /* END = fingers lifted; CANCEL = they started moving */
                const ms = (GLib.get_monotonic_time() - this._holdStart) / 1000;
                this._holdStart = 0;
                if (ms <= TAP_MAX_MS) this._onTap();
            } else if (phase === P.CANCEL) {
                this._holdStart = 0;
            }
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _finish() {
        const f = this._factor();
        this._pinch = null;
        this._commit(f);
    }

    _onTap() {
        const now = GLib.get_monotonic_time() / 1000;
        if (now - this._lastTap > DOUBLE_TAP_MS) {
            this._lastTap = now;
            return;
        }
        this._lastTap = 0;
        /* a swipe or pinch starting right after means the "tap" was just
           fingers landing — give it a moment to show up */
        if (this._tapTimer) GLib.source_remove(this._tapTimer);
        this._tapTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, TAP_SETTLE_MS, () => {
            this._tapTimer = 0;
            this.toggle();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelTap() {
        this._lastTap = 0;
        if (this._tapTimer) GLib.source_remove(this._tapTimer);
        this._tapTimer = 0;
    }

    /* Double-tap: zoom to the last level, or back out to 1× */
    toggle() {
        const zoomed = this._factor() >= OFF_BELOW;
        let last = this._mag.get_double('mag-factor');
        if (!(last >= OFF_BELOW)) last = DEFAULT_FACTOR;
        this._target = zoomed ? 1 : Math.min(MAX_FACTOR, last);
        this._loop.start();
    }

    _stepToggle(dt) {
        const cur = this._factor();
        const next = cur + (this._target - cur) * (1 - Math.exp(-TOGGLE_SPEED * dt));
        if (Math.abs(next - this._target) < 0.01) {
            this._apply(this._target);
            this._commit(this._target);
            return false;
        }
        this._apply(next);
        return true;
    }
}
