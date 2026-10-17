import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/* Lets the island replace GNOME's volume / brightness OSD popup.
   GNOME 46 exposes OsdWindowManager.show(monitorIndex, icon, …); 47+
   split it into showOne(monitorIndex, icon, …) and showAll(icon, …). We
   wrap whichever exist and locate the icon argument by type, so the same
   code works across versions. `shouldSuppress(kind)` decides per call —
   the native OSD still appears whenever the island can't show the event
   (expanded, hidden by a fullscreen app, a more important event on screen). */
export class OsdInterceptor {
    constructor(shouldSuppress) {
        this._shouldSuppress = shouldSuppress;
        this._originals = new Map();
    }

    enable() {
        const mgr = Main.osdWindowManager;
        if (!mgr || this._originals.size) return;
        const self = this;
        for (const name of ['show', 'showOne', 'showAll']) {
            const orig = mgr[name];
            if (typeof orig !== 'function') continue;
            this._originals.set(name, orig);
            mgr[name] = function (...args) {
                try {
                    const kind = OsdInterceptor.classify(args.find(a => a instanceof Gio.Icon));
                    if (kind && self._shouldSuppress(kind)) return undefined;
                } catch (e) { logError(e, 'notchex:osd'); }
                return orig.apply(this, args);
            };
        }
    }

    disable() {
        const mgr = Main.osdWindowManager;
        for (const [name, orig] of this._originals) {
            if (mgr) mgr[name] = orig;
        }
        this._originals.clear();
    }

    static classify(icon) {
        if (!icon) return null;
        let name = '';
        try {
            name = icon.get_names?.()?.[0] ?? icon.to_string?.() ?? '';
        } catch (_) {}
        if (/^audio-(volume|headphones|headset|speakers|card)/.test(name)) return 'volume';
        if (/^display-brightness/.test(name)) return 'brightness';
        return null;
    }
}
