import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {IconProvider, CACHE_DIR, appKey} from './icon-provider.js';

/* macOS-style app icons from the official macOSicons.com API.

   - Opt-in: only used when the icon source is "macOS-style" AND the user
     has stored their own API key (in the GNOME keyring via preferences —
     no key ships with Notchex).
   - Looks up one app at a time (max 2 in flight), only for apps that have
     no cached icon, and downloads a single PNG per app into
     ~/.cache/notchex/icons with the attribution metadata next to it.
   - Misses are remembered for a week so the API isn't asked again on
     every login. Never bulk-downloads the library. */

const API_URL = 'https://api.macosicons.com/api/v1/search';
const MAX_CONCURRENT = 2;
const MISS_TTL_S = 7 * 24 * 3600;
const GOOD_ENOUGH = 100;
const MAX_BYTES = 8 * 1024 * 1024;

const SECRET_SCHEMA_NAME = 'org.notchex.MacOSIcons';

let _Secret = null;
async function secretApi() {
    _Secret ??= (await import('gi://Secret')).default;
    return _Secret;
}

export function secretSchema(Secret) {
    return new Secret.Schema(SECRET_SCHEMA_NAME, Secret.SchemaFlags.NONE,
        {service: Secret.SchemaAttributeType.STRING});
}

function norm(s) {
    return (s ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '');
}

export class MacOSIconsProvider extends IconProvider {
    constructor(settings) {
        super('macosicons');
        this._settings = settings;
        this._session = null;
        this._cancellable = new Gio.Cancellable();
        this._queue = [];
        this._active = 0;
        this._key = undefined;
        this._keySig = settings.connect('changed::macosicons-key-version', () => { this._key = undefined; });
    }

    destroy() {
        this._cancellable.cancel();
        this._session?.abort();
        this._session = null;
        this._queue = [];
        if (this._keySig) this._settings.disconnect(this._keySig);
        this._keySig = 0;
    }

    async _apiKey() {
        /* a missing key (keyring still locked at login, or not set yet) is
           re-checked every few minutes instead of disabling icons for the
           whole session */
        if (this._key === null && Date.now() - (this._keyCheckedAt ?? 0) > 5 * 60 * 1000)
            this._key = undefined;
        if (this._key !== undefined) return this._key;
        this._keyCheckedAt = Date.now();
        try {
            const Secret = await secretApi();
            this._key = await new Promise(resolve => {
                Secret.password_lookup(secretSchema(Secret), {service: 'macosicons'}, this._cancellable,
                    (_s, res) => {
                        try { resolve(Secret.password_lookup_finish(res) || null); } catch (_) { resolve(null); }
                    });
            });
        } catch (_) {
            this._key = null;
        }
        return this._key;
    }

    /* Queue a lookup; resolves to an IconResult or null. */
    lookupAsync(request) {
        if (!request.app) return Promise.resolve(null);
        return new Promise(resolve => {
            this._queue.push({app: request.app, resolve});
            this._pump();
        });
    }

    _pump() {
        while (this._active < MAX_CONCURRENT && this._queue.length) {
            const job = this._queue.shift();
            this._active++;
            this._fetchFor(job.app)
                .catch(e => {
                    console.warn(`[Notchex] macOSicons lookup failed for ${job.app.get_name()}: ${e.message}`);
                    return null;
                })
                .then(result => {
                    this._active--;
                    job.resolve(result);
                    this._pump();
                });
        }
    }

    _recentMiss(appId) {
        try {
            const path = GLib.build_filenamev([CACHE_DIR, `${appKey(appId)}.json`]);
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok) return false;
            const meta = JSON.parse(new TextDecoder().decode(bytes));
            return meta.notFound && (Date.now() / 1000 - meta.fetchedAt) < MISS_TTL_S;
        } catch (_) {
            return false;
        }
    }

    /* Identity: the app's display name and its desktop-file Name only.
       Generic names ("Mail", "Music Player") and id fragments ("yelp",
       "snap-store") match unrelated icons, so they are never queried. */
    _queries(app) {
        const info = app.get_app_info?.();
        const names = [app.get_name(), info?.get_string?.('Name')];
        const seen = new Set();
        return names.filter(n => {
            const k = norm(n);
            if (!k || seen.has(k)) return false;
            seen.add(k);
            return true;
        });
    }

    /* 0 = reject. A hit must be the same name, or one name must contain
       the other and cover most of it ("Thunderbird" ⊂ "Thunderbird Mail"
       is fine; "Snap" for "Snap Store" or "Preferences" for "Terminal
       Preferences" is not). */
    _score(hit, app) {
        const name = norm(hit.appName ?? hit.name);
        if (!name) return 0;
        const targets = this._queries(app).map(norm);
        let best = 0;
        for (const t of targets) {
            if (name === t) best = Math.max(best, 100);
            else if (t.includes(name) || name.includes(t)) {
                const ratio = Math.min(name.length, t.length) / Math.max(name.length, t.length);
                if (ratio >= 0.7) best = Math.max(best, 60 + Math.round(ratio * 30));
            }
        }
        if (!best) return 0;
        const downloads = Number(hit.downloads ?? 0);
        return best + (downloads > 0 ? Math.min(8, Math.log10(downloads + 1) * 2) : 0);
    }

    async _fetchFor(app) {
        const appId = app.get_id();
        /* window-backed apps ("window:3") have no real identity */
        if (!appId || appId.startsWith('window:')) return null;
        if (this._recentMiss(appId)) return null;
        const key = await this._apiKey();
        if (!key) return null;

        let best = null;
        for (const query of this._queries(app)) {
            const hits = await this._search(query, key);
            for (const hit of hits) {
                const url = hit.lowResPngUrl ?? hit.pngUrl;
                if (!url) continue;
                const score = this._score(hit, app);
                if (!score) continue;
                if (!best || score > best.score) best = {hit, url, score};
            }
            if (best && best.score >= GOOD_ENOUGH) break;
        }
        if (!best) {
            this._writeMeta(appId, {appId, appName: app.get_name(), notFound: true,
                fetchedAt: Math.floor(Date.now() / 1000)});
            return null;
        }
        const path = GLib.build_filenamev([CACHE_DIR, `${appKey(appId)}.png`]);
        await this._download(best.url, path);
        const meta = {
            appId,
            appName: app.get_name(),
            matchedName: best.hit.appName ?? '',
            iconPath: path,
            source: 'macosicons',
            /* the API reports the uploader as usersName/uploadedBy; `credit`,
               when set, is the original artist — sometimes as a URL */
            credit: (!/^https?:/.test(best.hit.credit ?? '') && best.hit.credit) || best.hit.usersName || '',
            creditUrl: (/^https?:/.test(best.hit.credit ?? '') && best.hit.credit) ||
                best.hit.creditUrl || best.hit.uploadedBy || '',
            uploadedBy: best.hit.usersName ?? '',
            category: best.hit.category ?? '',
            fetchedAt: Math.floor(Date.now() / 1000),
        };
        this._writeMeta(appId, meta);
        return {gicon: Gio.FileIcon.new(Gio.File.new_for_path(path)), source: 'macosicons', path, meta};
    }

    _sessionGet() {
        this._session ??= new Soup.Session({timeout: 15, user_agent: 'Notchex (GNOME Shell extension)'});
        return this._session;
    }

    _search(query, key) {
        return new Promise((resolve, reject) => {
            const msg = Soup.Message.new('POST', API_URL);
            msg.request_headers.append('x-api-key', key);
            msg.request_headers.append('Accept', 'application/json');
            msg.set_request_body_from_bytes('application/json',
                new GLib.Bytes(new TextEncoder().encode(JSON.stringify({query, searchOptions: {hitsPerPage: 10}}))));
            this._sessionGet().send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
                let bytes;
                try { bytes = s.send_and_read_finish(res); } catch (e) { reject(e); return; }
                const status = msg.get_status();
                if (status === 401 || status === 403) {
                    this._key = null; /* invalid key: stop asking until it changes */
                    reject(new Error(`API key rejected (${status})`));
                    return;
                }
                if (status === 429) { reject(new Error('rate limited')); return; }
                if (status < 200 || status >= 300) { reject(new Error(`HTTP ${status}`)); return; }
                try {
                    const data = JSON.parse(new TextDecoder().decode(bytes.get_data()));
                    resolve(data.hits ?? data.results ?? data.data ?? (Array.isArray(data) ? data : []));
                } catch (e) { reject(e); }
            });
        });
    }

    _download(url, path) {
        return new Promise((resolve, reject) => {
            if (!/^https:\/\//.test(url)) { reject(new Error('non-https icon url')); return; }
            const msg = Soup.Message.new('GET', url);
            this._sessionGet().send_and_read_async(msg, GLib.PRIORITY_LOW, this._cancellable, (s, res) => {
                let bytes;
                try { bytes = s.send_and_read_finish(res); } catch (e) { reject(e); return; }
                const size = bytes?.get_size() ?? 0;
                if (msg.get_status() !== 200 || size === 0 || size > MAX_BYTES) {
                    reject(new Error(`icon download failed (${msg.get_status()})`));
                    return;
                }
                GLib.mkdir_with_parents(CACHE_DIR, 0o755);
                /* write to a temp name and rename, so a half-written file is
                   never picked up as a cached icon */
                const tmp = Gio.File.new_for_path(`${path}.part`);
                tmp.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                    this._cancellable, (f, r) => {
                        try {
                            f.replace_contents_finish(r);
                            f.move(Gio.File.new_for_path(path), Gio.FileCopyFlags.OVERWRITE, null, null);
                            resolve(path);
                        } catch (e) { reject(e); }
                    });
            });
        });
    }

    _writeMeta(appId, meta) {
        try {
            GLib.mkdir_with_parents(CACHE_DIR, 0o755);
            const file = Gio.File.new_for_path(GLib.build_filenamev([CACHE_DIR, `${appKey(appId)}.json`]));
            const bytes = new GLib.Bytes(new TextEncoder().encode(JSON.stringify(meta, null, 2)));
            file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.REPLACE_DESTINATION,
                null, (f, r) => { try { f.replace_contents_finish(r); } catch (_) {} });
        } catch (_) {}
    }
}
