import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import {cachedArt, resolveArt} from './artwork.js';

/* Rounded album-art tile. St clips background-image to border-radius, so
   this gives properly rounded artwork without any custom painting. Until
   remote art has downloaded (or when there is none) the player's app icon
   is shown instead; the tile swaps itself in place once the file lands. */
export function artTile(info, size, radius, styleClass = 'notchex-art') {
    const tile = new St.Bin({
        style_class: styleClass,
        y_align: Clutter.ActorAlign.CENTER,
        x_align: Clutter.ActorAlign.CENTER,
    });
    const base = `width: ${size}px; height: ${size}px; border-radius: ${radius}px;`;
    const setPath = path => {
        tile.set_child(null);
        tile.set_style(`${base} background-image: url("${path.replace(/"/g, '\\"')}"); background-size: cover;`);
        tile.add_style_class_name('has-art');
    };
    const url = info?.artUrl ?? '';
    const local = cachedArt(url);
    if (local && GLib.file_test(local, GLib.FileTest.EXISTS)) {
        setPath(local);
        return tile;
    }
    tile.set_style(base);
    tile.set_child(new St.Icon({
        gicon: appIcon(info?.icon),
        icon_size: Math.round(size * 0.55),
        style_class: 'notchex-art-fallback',
    }));
    if (url) {
        resolveArt(url).then(path => {
            /* the tile may have been destroyed by a re-render meanwhile */
            if (path && !tile._destroyed) setPath(path);
        }).catch(() => {});
        tile.connect('destroy', () => { tile._destroyed = true; });
    }
    return tile;
}

export function appIcon(desktopEntry) {
    if (desktopEntry && !desktopEntry.endsWith('-symbolic')) {
        try {
            const app = Gio.DesktopAppInfo.new(`${desktopEntry}.desktop`);
            const gicon = app?.get_icon();
            if (gicon) return gicon;
        } catch (_) {}
    }
    return Gio.ThemedIcon.new('audio-x-generic-symbolic');
}

function fmtTime(usec) {
    if (!Number.isFinite(usec) || usec < 0) return '0:00';
    const total = Math.floor(usec / 1e6);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = String(total % 60).padStart(2, '0');
    return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/* Expanded "Media" tab: artwork, title/artist, seekable progress bar and
   transport controls. The progress timer only runs while this view is on
   screen and the player is playing; it is removed with the actor. */
export function renderMediaView(mpris) {
    const info = mpris.info();
    const box = new St.BoxLayout({style_class: 'notchex-media', vertical: false, x_expand: true});

    if (!info || (!info.playing && !info.paused)) {
        const empty = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'notchex-media-empty'});
        empty.add_child(new St.Icon({icon_name: 'audio-x-generic-symbolic', icon_size: 28,
            style_class: 'notchex-media-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        empty.add_child(new St.Label({text: 'Nothing playing', style_class: 'notchex-empty-title',
            x_align: Clutter.ActorAlign.CENTER}));
        empty.add_child(new St.Label({
            text: 'Start music in Spotify, a browser or any MPRIS player',
            style_class: 'notchex-empty', x_align: Clutter.ActorAlign.CENTER,
        }));
        box.add_child(empty);
        return box;
    }

    box.add_child(artTile(info, 116, 16, 'notchex-art notchex-media-art'));

    const col = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'notchex-media-col',
        y_align: Clutter.ActorAlign.CENTER});

    const src = new St.BoxLayout({style_class: 'notchex-media-source'});
    src.add_child(new St.Icon({gicon: appIcon(info.icon), icon_size: 12}));
    src.add_child(new St.Label({text: (info.identity || info.icon || 'Media').toUpperCase(),
        style_class: 'notchex-media-source-label', y_align: Clutter.ActorAlign.CENTER}));
    col.add_child(src);

    const title = new St.Label({text: info.title || 'Unknown track', style_class: 'notchex-media-title'});
    title.clutter_text.ellipsize = 3; /* Pango.EllipsizeMode.END */
    col.add_child(title);
    const artist = new St.Label({text: [info.artist, info.album].filter(Boolean).join(' — '),
        style_class: 'notchex-media-artist'});
    artist.clutter_text.ellipsize = 3;
    col.add_child(artist);

    /* progress */
    const length = info.length > 0 ? info.length : 0;
    const progRow = new St.BoxLayout({style_class: 'notchex-media-progress-row', x_expand: true});
    const elapsed = new St.Label({text: '0:00', style_class: 'notchex-media-time', y_align: Clutter.ActorAlign.CENTER});
    const remain = new St.Label({text: length ? fmtTime(length) : '', style_class: 'notchex-media-time',
        y_align: Clutter.ActorAlign.CENTER});
    const track = new St.Widget({
        style_class: 'notchex-media-track' + (info.canSeek ? ' seekable' : ''),
        x_expand: true, y_align: Clutter.ActorAlign.CENTER,
        reactive: info.canSeek, track_hover: info.canSeek,
    });
    const fill = new St.Widget({style_class: 'notchex-media-fill'});
    track.add_child(fill);
    progRow.add_child(elapsed);
    progRow.add_child(track);
    progRow.add_child(remain);
    if (length) col.add_child(progRow);

    let posUs = 0;
    let posAt = GLib.get_monotonic_time();
    const paint = () => {
        if (track._destroyed) return;
        let cur = posUs;
        if (info.playing) cur += GLib.get_monotonic_time() - posAt;
        cur = Math.max(0, Math.min(length, cur));
        elapsed.text = fmtTime(cur);
        remain.text = `-${fmtTime(length - cur)}`;
        const w = track.width;
        if (w > 0) fill.set_size(Math.round(w * (length ? cur / length : 0)), track.height);
    };
    const sync = () => {
        mpris.fetchPosition().then(p => {
            if (p === null || track._destroyed) return;
            posUs = p;
            posAt = GLib.get_monotonic_time();
            paint();
        });
    };
    track.connect('notify::allocation', () => {
        /* fill must follow the track size; defer to avoid relayout inside allocation */
        if (track._paintQueued) return;
        track._paintQueued = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            track._paintQueued = 0;
            paint();
            return GLib.SOURCE_REMOVE;
        });
    });
    if (info.canSeek) {
        track.connect('button-release-event', (actor, event) => {
            const [x] = event.get_coords();
            const [ax] = actor.get_transformed_position();
            const frac = Math.max(0, Math.min(1, (x - ax) / Math.max(1, actor.width)));
            posUs = frac * length;
            posAt = GLib.get_monotonic_time();
            paint();
            mpris.setPosition(posUs);
            return Clutter.EVENT_STOP;
        });
    }
    let timer = 0;
    if (length) {
        sync();
        if (info.playing) {
            timer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 1, () => {
                paint();
                /* resync every few seconds to absorb drift/seeks from the app */
                if (++track._ticks % 5 === 0) sync();
                return GLib.SOURCE_CONTINUE;
            });
            track._ticks = 0;
        }
    }
    const seekedId = mpris.connect('seeked', () => sync());
    track.connect('destroy', () => {
        track._destroyed = true;
        if (timer) { GLib.source_remove(timer); timer = 0; }
        if (track._paintQueued) { GLib.source_remove(track._paintQueued); track._paintQueued = 0; }
        mpris.disconnect(seekedId);
    });

    /* controls */
    const ctrls = new St.BoxLayout({style_class: 'notchex-media-ctrls', x_align: Clutter.ActorAlign.CENTER});
    const mk = (icon, cb, name, enabled, primary = false) => {
        const b = new St.Button({
            style_class: 'notchex-media-btn' + (primary ? ' primary' : ''),
            child: new St.Icon({icon_name: icon, icon_size: primary ? 22 : 16}),
            accessible_name: name, can_focus: true, reactive: enabled,
        });
        if (!enabled) b.add_style_class_name('disabled');
        else b.connect('clicked', cb);
        return b;
    };
    ctrls.add_child(mk('media-skip-backward-symbolic', () => mpris.previous(), 'Previous track', info.canPrev));
    ctrls.add_child(mk(info.playing ? 'media-playback-pause-symbolic' : 'media-playback-start-symbolic',
        () => mpris.playPause(), 'Play/pause', info.canPlay || info.canPause, true));
    ctrls.add_child(mk('media-skip-forward-symbolic', () => mpris.next(), 'Next track', info.canNext));
    col.add_child(ctrls);

    box.add_child(col);
    return box;
}

/* Compact "now playing" equalizer for the pill.

   When possible the bars follow the actual sound: a helper process
   (spectrum-helper.js) reads the default output's monitor (what you hear,
   never the microphone), runs it through GStreamer's spectrum analyser and
   reports four frequency bands — bass, low-mid, high-mid, treble — which
   drive the four bars. It is out of process so the audio pipeline can
   never stall GNOME Shell.
   If GStreamer or its plugins are missing, or audio-following is turned
   off, the bars fall back to a gentle random motion.

   Nothing runs unless the bars are on screen (mapped) and a track is
   playing, so a hidden or paused island costs no CPU. */

const EQ_BARS = 4;
const EQ_REST = 0.22;
const EQ_FLOOR_DB = -62;
const EQ_RANGE_DB = 46;
const HELPER = GLib.build_filenamev([
    GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]), 'spectrum-helper.js']);

export class Equalizer {
    /* opts: animationsEnabled(), followAudio(), sinkName() */
    constructor(opts) {
        this._opts = opts;
        this.actor = new St.BoxLayout({
            style_class: 'notchex-eq',
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this._bars = [];
        for (let i = 0; i < EQ_BARS; i++) {
            const bar = new St.Widget({style_class: 'notchex-eq-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.set_pivot_point(0.5, 0.5);
            bar.scale_y = EQ_REST;
            this.actor.add_child(bar);
            this._bars.push(bar);
        }
        this._playing = false;
        this._level = new Array(EQ_BARS).fill(0);
        this._peak = new Array(EQ_BARS).fill(0.35);
        this.actor.connect('notify::mapped', () => this._sync());
        this.actor.connect('destroy', () => this._stopAll());
    }

    setPlaying(playing) {
        if (this._playing === playing) return;
        this._playing = playing;
        this._sync();
    }

    /* output device or preference changed — rebuild the audio source */
    restart() {
        this._stopAll();
        this._audioFailed = false;
        this._sync();
    }

    _sync() {
        const run = this._playing && this.actor.mapped && this._opts.animationsEnabled();
        if (!run) {
            this._stopAll();
            for (const bar of this._bars) {
                bar.remove_all_transitions();
                bar.scale_y = this._playing ? 0.5 : EQ_REST;
            }
            return;
        }
        if (this._proc || this._timer) return;
        if (this._opts.followAudio() && !this._audioFailed && this._startAudio()) return;
        this._startFallback();
    }

    _stopAll() {
        if (this._timer) {
            GLib.source_remove(this._timer);
            this._timer = 0;
        }
        if (this._proc) {
            const proc = this._proc;
            this._proc = null;
            this._cancel?.cancel();
            this._cancel = null;
            try { proc.force_exit(); } catch (_) {}
        }
    }

    /* Spawns the analyser (see spectrum-helper.js). Returns false if it
       can't be started, so the caller falls back to the animation. */
    _startAudio() {
        const sink = this._opts.sinkName();
        const gjs = GLib.find_program_in_path('gjs');
        if (!sink || !gjs || !/^[\w.:-]+$/.test(sink)) return false;
        let proc;
        try {
            proc = Gio.Subprocess.new([gjs, '-m', HELPER, `${sink}.monitor`],
                Gio.SubprocessFlags.STDIN_PIPE | Gio.SubprocessFlags.STDOUT_PIPE |
                Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            logError(e, 'notchex:eq');
            return false;
        }
        this._proc = proc;
        this._cancel = new Gio.Cancellable();
        const cancel = this._cancel;
        const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe(), close_base_stream: true});
        const readNext = () => {
            stdout.read_line_async(GLib.PRIORITY_LOW, cancel, (s, res) => {
                let line = null;
                try { [line] = s.read_line_finish_utf8(res); } catch (_) { return; }
                if (line === null) return;
                this._onLevels(line);
                readNext();
            });
        };
        readNext();
        proc.wait_async(cancel, (p, res) => {
            try { p.wait_finish(res); } catch (_) { return; }
            if (this._proc !== p) return;
            /* helper died on its own (no GStreamer plugin, device gone…) */
            this._proc = null;
            this._audioFailed = true;
            console.warn('notchex: audio visualizer unavailable, using animation');
            this._sync();
        });
        return true;
    }

    _onLevels(line) {
        const dbs = line.trim().split(' ').map(Number);
        if (dbs.length !== EQ_BARS || dbs.some(Number.isNaN)) return;
        dbs.forEach((db, i) => {
            const raw = Math.max(0, Math.min(1, (db - EQ_FLOOR_DB) / EQ_RANGE_DB));
            /* per-bar auto-gain so quiet tracks and treble still move */
            this._peak[i] = Math.max(raw, this._peak[i] * 0.992, 0.35);
            const target = raw / this._peak[i];
            /* fast attack, slower release */
            const k = target > this._level[i] ? 0.75 : 0.35;
            this._level[i] += (target - this._level[i]) * k;
            this._setBar(i, EQ_REST + (1 - EQ_REST) * this._level[i], 40);
        });
    }

    _startFallback() {
        const tick = () => {
            this._bars.forEach((_, i) => this._setBar(i, EQ_REST + Math.random() * (1 - EQ_REST), 150));
            return GLib.SOURCE_CONTINUE;
        };
        tick();
        this._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 160, tick);
    }

    _setBar(i, scale, ms) {
        const bar = this._bars[i];
        bar.remove_all_transitions();
        bar.ease({scale_y: scale, duration: ms, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    destroy() {
        this._stopAll();
        this.actor.destroy();
    }
}
