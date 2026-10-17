import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import St from 'gi://St';

/* Shared motion language for the island, Dock and Spotlight, so every
   surface moves with the same timing and curves. All animation goes
   through Clutter's implicit animations (actor.ease) or frame-clock
   timelines — never busy loops — and collapses to instant changes when
   the desktop's "reduce animation" preference is on. */

export const Motion = {
    HOVER:  120,
    FAST:   150,
    NORMAL: 200,
    SLOW:   300,
    LAUNCH: 360,
};

export const Curve = {
    OUT:    Clutter.AnimationMode.EASE_OUT_QUINT,
    IN:     Clutter.AnimationMode.EASE_IN_QUAD,
    SOFT:   Clutter.AnimationMode.EASE_OUT_CUBIC,
    SPRING: Clutter.AnimationMode.EASE_OUT_BACK,
};

export function reducedMotion() {
    try {
        return !St.Settings.get().enable_animations;
    } catch (_) {
        return false;
    }
}

/* ease() wrapper: stops running transitions first so a new animation
   always starts from the current on-screen value. */
export function animate(actor, props, duration = Motion.NORMAL, mode = Curve.OUT) {
    actor.remove_all_transitions();
    actor.ease({...props, duration: reducedMotion() ? 0 : duration, mode});
}

/* Frame-driven interpolation helper: calls step(dtSeconds) on every frame
   of the stage clock until step() returns false. Used for continuous
   effects (Dock magnification) so they are frame-rate independent and
   stop costing anything once settled. */
export class FrameLoop {
    constructor(actor, step) {
        this._timeline = new Clutter.Timeline({actor, duration: 1000, repeat_count: -1});
        this._step = step;
        this._last = 0;
        this._timeline.connect('new-frame', () => {
            const now = GLib.get_monotonic_time();
            const dt = this._last ? Math.min(0.05, (now - this._last) / 1e6) : 1 / 60;
            this._last = now;
            if (!this._step(dt)) this.stop();
        });
    }

    start() {
        if (!this._timeline || this._timeline.is_playing()) return;
        this._last = 0;
        this._timeline.start();
    }

    stop() {
        if (this._timeline?.is_playing()) this._timeline.stop();
    }

    destroy() {
        this.stop();
        this._timeline = null;
    }
}
