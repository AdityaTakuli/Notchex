import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {CACHE_DIR} from './icon-provider.js';
import {SystemIconProvider} from './system-icon-provider.js';
import {LocalIconProvider} from './local-icon-provider.js';
import {MacOSIconsProvider} from './macosicons-provider.js';

/* One icon system for the Dock, Spotlight and the island.

   Resolution order for applications:
     1. user custom icon          (always honoured)
     2. cached macOS-style icon   (icon source "macos")
     3. macOSicons API            (async, only if a key is configured)
     4. native GNOME icon         (always available)
   A caller always gets an icon immediately (steps 1, 2 or 4); when a
   better one arrives later the manager emits 'icon-changed' with the app
   id so consumers can swap it in. Concurrent requests for the same app
   share one lookup. */
export const IconManager = GObject.registerClass({
    Signals: {
        /* app id, or '*' when every icon may have changed */
        'icon-changed': {param_types: [GObject.TYPE_STRING]},
    },
}, class IconManager extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._system = new SystemIconProvider();
        this._local = new LocalIconProvider(settings);
        this._macos = null;
        this._pending = new Map();
        this._refreshChecked = new Set();
        this._settingsId = settings.connect('changed', (_s, key) => {
            if (key === 'icon-source' || key === 'icon-custom-map' || key === 'macosicons-key-version') {
                this._refreshChecked.clear();
                this.emit('icon-changed', '*');
            }
        });
    }

    destroy() {
        if (this._settingsId) this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        this._macos?.destroy();
        this._macos = null;
        this._pending.clear();
    }

    get source() {
        return this._settings.get_string('icon-source');
    }

    /* → {gicon, source, path?} — never null, never blocks on I/O */
    getAppIcon(app) {
        if (!app) return this._system.lookupSync({iconName: 'application-x-executable'});
        const mode = this.source;
        const local = this._local.lookupSync({app, allowCached: mode === 'macos'});
        if (local) {
            if (local.source === 'macosicons') this._maybeRefresh(app);
            return local;
        }
        if (mode === 'macos') this._fetch(app);
        return this._system.lookupSync({app});
    }

    prefetchIcon(app) {
        this.getAppIcon(app);
    }

    /* attribution for a downloaded icon, or null */
    metaFor(appId) {
        return this._local.readMeta(appId);
    }

    setCustomIcon(appId, path) {
        const map = this._settings.get_value('icon-custom-map').deepUnpack();
        map[appId] = path;
        this._settings.set_value('icon-custom-map', new GLib.Variant('a{ss}', map));
    }

    removeCustomIcon(appId) {
        const map = this._settings.get_value('icon-custom-map').deepUnpack();
        delete map[appId];
        this._settings.set_value('icon-custom-map', new GLib.Variant('a{ss}', map));
    }

    clearCache() {
        const dir = Gio.File.new_for_path(CACHE_DIR);
        dir.enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE, GLib.PRIORITY_LOW, null,
            (d, res) => {
                let iter;
                try { iter = d.enumerate_children_finish(res); } catch (_) { return; }
                iter.next_files_async(1000, GLib.PRIORITY_LOW, null, (it, r) => {
                    let infos = [];
                    try { infos = it.next_files_finish(r); } catch (_) {}
                    let left = infos.length;
                    const done = () => { if (--left <= 0) this.emit('icon-changed', '*'); };
                    if (!left) done();
                    for (const info of infos)
                        d.get_child(info.get_name()).delete_async(GLib.PRIORITY_LOW, null, done);
                });
            });
    }

    _provider() {
        this._macos ??= new MacOSIconsProvider(this._settings);
        return this._macos;
    }

    _fetch(app) {
        const id = app.get_id();
        if (this._pending.has(id)) return this._pending.get(id);
        const p = this._provider().lookupAsync({app}).then(result => {
            this._pending.delete(id);
            if (result) this.emit('icon-changed', id);
            return result;
        });
        this._pending.set(id, p);
        return p;
    }

    /* once per session, re-fetch cached icons older than the refresh age */
    _maybeRefresh(app) {
        const id = app.get_id();
        if (this._refreshChecked.has(id)) return;
        this._refreshChecked.add(id);
        const days = this._settings.get_int('icon-refresh-days');
        if (days <= 0) return;
        const meta = this._local.readMeta(id);
        if (meta?.fetchedAt && Date.now() / 1000 - meta.fetchedAt > days * 86400)
            this._fetch(app);
    }
});
