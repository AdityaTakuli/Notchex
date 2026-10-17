import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {IconProvider, CACHE_DIR, CUSTOM_DIR, appKey} from './icon-provider.js';

/* Icons that already live on disk:
     1. user overrides (icon-custom-map: app id → image path)
     2. previously downloaded macOS-style icons in ~/.cache/notchex/icons
   Both are plain stats, so this is safe on the shell thread. */
export class LocalIconProvider extends IconProvider {
    constructor(settings) {
        super('local');
        this._settings = settings;
    }

    /* explicit per-app override first, then a drop-in file named after the
       app in ~/.local/share/notchex/icons (e.g. org.mozilla.firefox.png) */
    customPath(appId) {
        const map = this._settings.get_value('icon-custom-map').deepUnpack();
        const path = map[appId] ?? map[appKey(appId)];
        if (path && GLib.file_test(path, GLib.FileTest.EXISTS)) return path;
        for (const ext of ['png', 'svg']) {
            const p = GLib.build_filenamev([CUSTOM_DIR, `${appKey(appId)}.${ext}`]);
            if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p;
        }
        return null;
    }

    cachedPath(appId) {
        const path = GLib.build_filenamev([CACHE_DIR, `${appKey(appId)}.png`]);
        return GLib.file_test(path, GLib.FileTest.EXISTS) ? path : null;
    }

    /* metadata written next to a cached icon (attribution, timestamps) */
    readMeta(appId) {
        try {
            const [ok, bytes] = GLib.file_get_contents(
                GLib.build_filenamev([CACHE_DIR, `${appKey(appId)}.json`]));
            return ok ? JSON.parse(new TextDecoder().decode(bytes)) : null;
        } catch (_) {
            return null;
        }
    }

    lookupSync(request) {
        if (!request.app) return null;
        const id = request.app.get_id();
        const custom = this.customPath(id);
        if (custom) return {gicon: Gio.FileIcon.new(Gio.File.new_for_path(custom)), source: 'custom', path: custom};
        if (!request.allowCached) return null;
        const cached = this.cachedPath(id);
        if (cached) {
            return {
                gicon: Gio.FileIcon.new(Gio.File.new_for_path(cached)),
                source: 'macosicons',
                path: cached,
            };
        }
        return null;
    }
}
