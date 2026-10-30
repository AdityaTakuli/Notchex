import GLib from 'gi://GLib';

import {getMixerControl} from 'resource:///org/gnome/shell/ui/status/volume.js';

/* Which speaker output belongs to a Bluetooth device, and moving sound to
   it. PipeWire and PulseAudio both name Bluetooth sinks after the device
   address ("bluez_output.AA_BB_CC_DD_EE_FF.1"), and BlueZ puts the same
   address in the device path ("/org/bluez/hci0/dev_AA_BB_CC_DD_EE_FF"). */

function addressOf(path) {
    return /dev_([0-9A-Fa-f_]{17})/.exec(path ?? '')?.[1]?.toUpperCase() ?? null;
}

export function sinkFor(path) {
    const addr = addressOf(path);
    if (!addr) return null;
    try {
        return getMixerControl().get_sinks()
            .find(s => (s.get_name() ?? '').toUpperCase().includes(addr)) ?? null;
    } catch (_) {
        return null;
    }
}

/* null: no output for this device (yet); true/false: is it the one in use */
export function isRouted(path) {
    const sink = sinkFor(path);
    if (!sink) return null;
    try {
        return getMixerControl().get_default_sink()?.get_id() === sink.get_id();
    } catch (_) {
        return null;
    }
}

export function routeTo(path) {
    const sink = sinkFor(path);
    if (!sink) return false;
    try {
        getMixerControl().set_default_sink(sink);
        return true;
    } catch (e) {
        logError(e, 'notchex:audio-route');
        return false;
    }
}

/* Calls cb() whenever outputs come and go or the default changes, for at
   most `ms`. A Bluetooth headset's output shows up a moment after it
   connects. Returns a function that stops watching early. */
export function watchOutputs(cb, ms) {
    let control;
    try { control = getMixerControl(); } catch (_) { return () => {}; }
    const owner = {};
    control.connectObject(
        'stream-added', () => cb(),
        'stream-removed', () => cb(),
        'default-sink-changed', () => cb(),
        owner);
    let id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        id = 0;
        stop();
        return GLib.SOURCE_REMOVE;
    });
    const stop = () => {
        control.disconnectObject(owner);
        if (id) GLib.source_remove(id);
        id = 0;
    };
    return stop;
}
