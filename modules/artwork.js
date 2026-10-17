import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

/* Album-art resolver. MPRIS players hand us either a local file:// URI
   (Firefox, Chromium, VLC, Rhythmbox) or an https:// URL (Spotify). Remote
   art is downloaded asynchronously once into ~/.cache/notchex/art and
   reused by URL hash; everything here is non-blocking. */

const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchex', 'art']);
const MAX_CACHED = 64;
const MAX_BYTES = 4 * 1024 * 1024;

let _session = null;
let _cancellable = null;
const _pending = new Map();

function _cachePath(url) {
    return GLib.build_filenamev([CACHE_DIR,
        GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, url, -1)]);
}

/* Resolves to a local file path, or null. */
export function resolveArt(url) {
    if (!url) return Promise.resolve(null);
    if (url.startsWith('file://')) {
        try {
            const path = Gio.File.new_for_uri(url).get_path();
            return Promise.resolve(path && GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null);
        } catch (_) { return Promise.resolve(null); }
    }
    if (url.startsWith('/'))
        return Promise.resolve(GLib.file_test(url, GLib.FileTest.EXISTS) ? url : null);
    if (!/^https?:\/\//.test(url)) return Promise.resolve(null);

    const path = _cachePath(url);
    if (GLib.file_test(path, GLib.FileTest.EXISTS)) return Promise.resolve(path);
    if (_pending.has(url)) return _pending.get(url);

    const promise = _download(url, path).finally(() => _pending.delete(url));
    _pending.set(url, promise);
    return promise;
}

/* Returns the cached path synchronously if the art is already local. */
export function cachedArt(url) {
    if (!url) return null;
    if (url.startsWith('file://')) {
        try { return Gio.File.new_for_uri(url).get_path(); } catch (_) { return null; }
    }
    if (/^https?:\/\//.test(url)) {
        const path = _cachePath(url);
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }
    return null;
}

function _download(url, path) {
    _session ??= new Soup.Session({timeout: 10, user_agent: 'notchex/1.1'});
    _cancellable ??= new Gio.Cancellable();
    const cancellable = _cancellable;
    return new Promise(resolve => {
        let msg;
        try { msg = Soup.Message.new('GET', url); } catch (_) { resolve(null); return; }
        if (!msg) { resolve(null); return; }
        _session.send_and_read_async(msg, GLib.PRIORITY_LOW, cancellable, (session, res) => {
            let bytes;
            try {
                bytes = session.send_and_read_finish(res);
            } catch (_) { resolve(null); return; }
            const size = bytes?.get_size() ?? 0;
            if (msg.get_status() !== Soup.Status.OK || size === 0 || size > MAX_BYTES) {
                resolve(null);
                return;
            }
            try {
                GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            } catch (_) {}
            const file = Gio.File.new_for_path(path);
            file.replace_contents_bytes_async(bytes, null, false,
                Gio.FileCreateFlags.REPLACE_DESTINATION, cancellable, (f, r) => {
                    try {
                        f.replace_contents_finish(r);
                        resolve(path);
                        _scheduledPrune();
                    } catch (_) { resolve(null); }
                });
        });
    });
}

let _pruneQueued = false;
function _scheduledPrune() {
    if (_pruneQueued) return;
    _pruneQueued = true;
    const dir = Gio.File.new_for_path(CACHE_DIR);
    dir.enumerate_children_async('standard::name,time::modified',
        Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, _cancellable, (d, res) => {
            let iter;
            try { iter = d.enumerate_children_finish(res); } catch (_) { _pruneQueued = false; return; }
            iter.next_files_async(MAX_CACHED * 4, GLib.PRIORITY_LOW, _cancellable, (it, r) => {
                _pruneQueued = false;
                let infos = [];
                try { infos = it.next_files_finish(r); } catch (_) { return; }
                if (infos.length <= MAX_CACHED) return;
                infos.sort((a, b) =>
                    a.get_attribute_uint64('time::modified') - b.get_attribute_uint64('time::modified'));
                for (const info of infos.slice(0, infos.length - MAX_CACHED))
                    d.get_child(info.get_name()).delete_async(GLib.PRIORITY_LOW, null, () => {});
            });
        });
}

export function shutdownArtwork() {
    _cancellable?.cancel();
    _cancellable = null;
    _session?.abort();
    _session = null;
    _pending.clear();
    _pruneQueued = false;
}
