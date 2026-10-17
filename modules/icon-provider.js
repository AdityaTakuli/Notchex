import GLib from 'gi://GLib';

/* Shared pieces of the icon subsystem (see icon-manager.js).

   An icon request is either an application ({app}) or a named system
   icon ({name, state, weight}). Providers answer with an IconResult:
     {gicon, source, path?, meta?}
   where `source` is 'custom' | 'macosicons' | 'system' | 'fallback' and
   `meta` keeps attribution for downloaded artwork. */

export const CACHE_DIR = GLib.build_filenamev([GLib.get_user_cache_dir(), 'notchex', 'icons']);
export const CUSTOM_DIR = GLib.build_filenamev([GLib.get_user_data_dir(), 'notchex', 'icons']);

/* file-name-safe key for an app id: "org.mozilla.firefox.desktop" → "org.mozilla.firefox" */
export function appKey(appId) {
    return (appId ?? '').replace(/\.desktop$/, '').replace(/[^\w.-]/g, '_');
}

export class IconProvider {
    constructor(id) {
        this.id = id;
    }

    /* Synchronous, cheap answer (no I/O beyond a stat) or null. */
    lookupSync(_request) {
        return null;
    }

    /* Optional slow path (network, disk scans). Resolves to IconResult|null. */
    lookupAsync(_request) {
        return Promise.resolve(null);
    }

    destroy() {}
}
