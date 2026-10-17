import GLib from 'gi://GLib';

/* Lower number = more important. Mirrors the PRD priority table. */
export const Priority = {
    CRITICAL:     1,
    NOTIFICATION: 2,
    MEDIA:        3,
    BLUETOOTH:    4,
    VOLUME:       5,
    BRIGHTNESS:   6,
    CALENDAR:     7,
    SYSTEM:       8,
};

/* Central arbiter for transient "live activity" events (media change,
   volume, battery, notifications …). Sources push events; the manager
   decides which one the island shows, for how long, and what waits.

   Rules:
   - an event with the same `key` as the one on screen updates it in place
     (holding the volume key doesn't re-animate the island every step);
   - a more important event preempts the current one;
   - equal/less important events wait in a small queue (if `queueable`)
     and expire after `ttl` ms so stale events never surface late;
   - while the island is expanded the manager is suspended.

   The host must implement canShowEvents(), showEvent(ev, replacing),
   updateEvent(ev) and hideEvent(immediate). */
export class EventManager {
    constructor(host) {
        this._host = host;
        this._current = null;
        this._queue = [];
        this._timer = 0;
        this._held = false;
        this._suspended = false;
        this._seq = 0;
    }

    get current() { return this._current; }

    /* Would an event with this key/priority be put on screen right now?
       Used by the OSD interceptor to decide whether hiding the native
       GNOME OSD is safe. */
    wouldShow(key, priority) {
        if (this._destroyed || this._suspended || !this._host.canShowEvents()) return false;
        const cur = this._current;
        return !cur || cur.key === key || priority < cur.priority;
    }

    push(ev) {
        if (this._destroyed) return false;
        ev = {priority: Priority.SYSTEM, duration: 3000, ttl: 12000, queueable: true, ...ev};
        ev.seq = ++this._seq;
        ev.expiresAt = this._now() + ev.ttl;

        const cur = this._current;
        if (cur && ev.key && cur.key === ev.key) {
            this._current = ev;
            this._host.updateEvent(ev);
            if (!this._held) this._arm(ev.duration);
            return true;
        }
        if (this._suspended || !this._host.canShowEvents()) {
            if (ev.queueable) this._enqueue(ev);
            return false;
        }
        if (!cur) {
            this._display(ev, false);
            return true;
        }
        if (ev.priority < cur.priority) {
            if (cur.queueable) this._enqueue(cur);
            this._display(ev, true);
            return true;
        }
        if (ev.queueable) this._enqueue(ev);
        return false;
    }

    /* Pointer is over the event — keep it on screen. */
    hold() {
        if (!this._current || this._held) return;
        this._held = true;
        this._clearTimer();
    }

    release() {
        if (!this._held) return;
        this._held = false;
        if (this._current) this._arm(1500);
    }

    dismiss() {
        if (!this._current) return;
        this._clearTimer();
        this._advance();
    }

    /* Island expanded: whatever was showing has been "seen". */
    suspend() {
        this._suspended = true;
        this._held = false;
        this._clearTimer();
        if (this._current) {
            this._current = null;
            this._host.hideEvent(true);
        }
    }

    resume() {
        this._suspended = false;
        if (this._current) return;
        const next = this._takeNext();
        if (next && this._host.canShowEvents()) this._display(next, false);
    }

    destroy() {
        this._destroyed = true;
        this._clearTimer();
        this._queue = [];
        this._current = null;
    }

    _display(ev, replacing) {
        this._current = ev;
        this._held = false;
        this._host.showEvent(ev, replacing);
        this._arm(ev.duration);
    }

    _advance() {
        this._current = null;
        this._held = false;
        const next = this._suspended ? null : this._takeNext();
        if (next && this._host.canShowEvents()) this._display(next, true);
        else this._host.hideEvent(false);
    }

    _enqueue(ev) {
        if (ev.key) this._queue = this._queue.filter(e => e.key !== ev.key);
        this._queue.push(ev);
        this._queue.sort((a, b) => (a.priority - b.priority) || (a.seq - b.seq));
        if (this._queue.length > 6) this._queue.length = 6;
    }

    _takeNext() {
        const now = this._now();
        this._queue = this._queue.filter(e => e.expiresAt > now);
        return this._queue.shift() ?? null;
    }

    _arm(ms) {
        this._clearTimer();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(250, ms), () => {
            this._timer = 0;
            this._advance();
            return GLib.SOURCE_REMOVE;
        });
    }

    _clearTimer() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
    }

    _now() { return GLib.get_monotonic_time() / 1000; }
}
