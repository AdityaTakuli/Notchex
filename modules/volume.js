import GObject from 'gi://GObject';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

/* Watches the default PulseAudio/PipeWire output through the Shell's own
   Gvc mixer control (shared, already connected — no extra client). Purely
   signal driven: emits 'changed' only when the sink's volume or mute state
   actually changes, never on (re)binding to a new default sink. */
export const VolumeWatcher = GObject.registerClass({
    Signals: {
        'changed': {param_types: [GObject.TYPE_JSOBJECT]},
        'sink-changed': {},
    },
}, class VolumeWatcher extends GObject.Object {
    start() {
        if (this._control) return;
        try {
            this._control = getMixerControl();
        } catch (e) {
            logError(e, 'notchex:volume');
            return;
        }
        this._control.connectObject(
            'default-sink-changed', () => this._bindSink(),
            'state-changed',        () => this._bindSink(),
            this);
        this._bindSink();
    }

    stop() {
        this._stream?.disconnectObject(this);
        this._control?.disconnectObject(this);
        this._stream = null;
        this._control = null;
        this._last = null;
    }

    destroy() { this.stop(); }

    _bindSink() {
        let sink = null;
        try { sink = this._control?.get_default_sink() ?? null; } catch (_) {}
        if (sink === this._stream) return;
        this._stream?.disconnectObject(this);
        this._stream = sink;
        this._last = this.state();
        sink?.connectObject(
            'notify::volume',   () => this._onChanged(),
            'notify::is-muted', () => this._onChanged(),
            this);
        this.emit('sink-changed');
    }

    /* PulseAudio/PipeWire name of the default output, e.g. for its monitor */
    sinkName() {
        try { return this._stream?.get_name() ?? null; } catch (_) { return null; }
    }

    _onChanged() {
        const st = this.state();
        if (!st) return;
        const last = this._last;
        this._last = st;
        if (last && Math.round(last.level * 100) === Math.round(st.level * 100) && last.muted === st.muted)
            return;
        this.emit('changed', st);
    }

    available() { return !!this._stream; }

    state() {
        const s = this._stream, c = this._control;
        if (!s || !c) return null;
        const norm = c.get_vol_max_norm();
        if (!norm) return null;
        return {
            level: s.volume / norm,
            max:   c.get_vol_max_amplified() / norm,
            muted: !!s.is_muted,
        };
    }

    setLevel(frac) {
        const s = this._stream, c = this._control;
        if (!s || !c) return;
        const norm = c.get_vol_max_norm();
        const v = Math.max(0, Math.min(1, frac)) * norm;
        s.volume = Math.round(v);
        if (s.is_muted && v > 0) s.change_is_muted(false);
        s.push_volume();
    }

    toggleMute() {
        const s = this._stream;
        if (s) s.change_is_muted(!s.is_muted);
    }
});
