// Out-of-process audio analyser for the pill's music bars.
//
// Run by modules/media.js as:  gjs -m spectrum-helper.js <pulse-monitor-source>
// Captures the given monitor (the speaker output — never a microphone),
// and prints one line per frame with the peak level in dB of four
// frequency bands: bass, low-mid, high-mid, treble. Exits when its stdin
// closes, so it never outlives GNOME Shell.
//
// It runs as a separate process on purpose: a stalled audio pipeline must
// never be able to block the compositor.

import Gst from 'gi://Gst?version=1.0';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import System from 'system';

/* GLib ≥ 2.80 moved the Unix streams to GioUnix */
const GioUnix = await import('gi://GioUnix').then(m => m.default).catch(() => null);
const UnixOutputStream = GioUnix?.OutputStream ?? Gio.UnixOutputStream;
const UnixInputStream = GioUnix?.InputStream ?? Gio.UnixInputStream;

/* 64 bands over 0–8 kHz (16 kHz capture) = 125 Hz per band */
const GROUPS = [[1, 2], [3, 7], [8, 23], [24, 56]];

const device = System.programArgs[0] ?? '';
if (!/^[\w.:-]+$/.test(device)) {
    printerr('invalid device');
    System.exit(2);
}

Gst.init(null);
const loop = new GLib.MainLoop(null, false);
const out = new Gio.DataOutputStream({
    base_stream: new UnixOutputStream({fd: 1, close_fd: false}),
});

let pipeline;
try {
    pipeline = Gst.parse_launch(
        /* tagged so the privacy dot doesn't count reading the speakers as a mic */
        `pulsesrc device=${device} client-name=Notchex ` +
        'stream-properties="props,application.id=(string)io.notchex.Spectrum" ' +
        'buffer-time=60000 latency-time=20000 ! ' +
        'audioconvert ! audioresample ! audio/x-raw,rate=16000,channels=1 ! ' +
        'spectrum bands=64 threshold=-80 interval=40000000 post-messages=true message-magnitude=true ! ' +
        'fakesink sync=false');
} catch (e) {
    printerr(e.message);
    System.exit(1);
}

const quit = code => {
    pipeline.set_state(Gst.State.NULL);
    loop.quit();
    System.exit(code);
};

const bus = pipeline.get_bus();
bus.add_signal_watch();
bus.connect('message', (_b, msg) => {
    if (msg.type === Gst.MessageType.ERROR || msg.type === Gst.MessageType.EOS) {
        quit(1);
        return;
    }
    if (msg.type !== Gst.MessageType.ELEMENT) return;
    const st = msg.get_structure();
    if (st?.get_name() !== 'spectrum') return;
    const m = st.to_string().match(/magnitude=\(float\)\{([^}]*)\}/);
    if (!m) return;
    const mags = m[1].split(',').map(Number);
    const levels = GROUPS.map(([from, to]) => {
        let db = -80;
        for (let b = from; b <= to && b < mags.length; b++) db = Math.max(db, mags[b]);
        return db.toFixed(1);
    });
    try {
        out.put_string(`${levels.join(' ')}\n`, null);
        out.flush(null);
    } catch (_) {
        quit(0); // reader went away
    }
});

/* stdin EOF = parent gone */
const stdin = new UnixInputStream({fd: 0, close_fd: false});
stdin.read_bytes_async(1, GLib.PRIORITY_DEFAULT, null, () => quit(0));

pipeline.set_state(Gst.State.PLAYING);
loop.run();
