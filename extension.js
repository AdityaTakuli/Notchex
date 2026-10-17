import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {Notch} from './notch.js';
import {Dock} from './modules/dock.js';
import {IconManager} from './modules/icon-manager.js';
import {Spotlight} from './modules/search.js';
import {TrackpadZoom} from './modules/zoom.js';
import {PanelGlass} from './modules/glass.js';

export default class NotchexExtension extends Extension {
    enable() {
        this._settings = this.getSettings('org.gnome.shell.extensions.notchex');

        /* Evolution Data Server's source-registry D-Bus service sometimes
           doesn't auto-activate on login; when that happens Calendar and
           Tasks come up empty. If the binary is discoverable via $PATH or
           the standard libexec prefixes, kick it once — idempotent. This
           replaces the previous hard-coded /usr/libexec/... path so the
           extension stays portable across distros. */
        try {
            const candidates = [
                GLib.find_program_in_path('evolution-source-registry'),
                '/usr/libexec/evolution-source-registry',
                '/usr/lib/evolution-data-server/evolution-source-registry',
                '/usr/lib64/evolution-data-server/evolution-source-registry',
            ].filter(p => p && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE));
            if (candidates.length) {
                Gio.Subprocess.new([candidates[0]],
                    Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
            }
        } catch (_) {}

        this._icons = new IconManager(this._settings);

        /* The notch can be switched off on its own (Features page), so it
           is created and destroyed by _syncNotch rather than here. */
        this._notchSig = this._settings.connect('changed::notch-enabled', () => this._syncNotch());
        this._syncNotch();

        this._dock = new Dock(this._settings, {
            onLaunch: app => this._notch?.showAppLaunch(app),
            icons: this._icons,
        });

        /* Spotlight draws inside the notch. The host forwards to whichever
           notch currently exists, so search keeps working across toggles. */
        this._search = new Spotlight(this._settings, {
            icons: this._icons,
            onLaunch: app => this._notch?.showAppLaunch(app),
            screenshot: () => this._notch?.takeScreenshot(),
            host: {
                openSearch: (view, onDismiss) => this._notch?.openSearch(view, onDismiss) ?? false,
                closeSearch: immediate => this._notch?.closeSearch(immediate),
                resizeSearch: () => this._notch?.resizeSearch(),
            },
        });

        this._zoom = new TrackpadZoom(this._settings);
        this._glass = new PanelGlass(this._settings);
    }

    _syncNotch() {
        const want = this._settings.get_boolean('notch-enabled');
        if (want && !this._notch) {
            this._notch = new Notch(this);

            /* Mount the notch into the top chrome layer — OUTSIDE the panel's
               actor tree. This keeps any Shell.BlurEffect that blur-my-shell
               attaches to the panel from bleeding through the notch.
               The notch positions itself (centred on the primary monitor) as
               part of every size animation and on monitor/scale changes, so no
               allocation-driven repositioning is needed here. */
            Main.layoutManager.addTopChrome(this._notch, {
                trackFullscreen: true,
                affectsStruts: false,
                affectsInputRegion: true,
            });

            this._notch.start();
        } else if (!want && this._notch) {
            this._search?.close(true);
            this._destroyNotch();
        }
    }

    _destroyNotch() {
        if (!this._notch) return;
        this._notch.stop();
        try { Main.layoutManager.removeChrome(this._notch); } catch (_) {}
        this._notch.destroy();
        this._notch = null;
    }

    disable() {
        if (this._notchSig) this._settings.disconnect(this._notchSig);
        this._notchSig = 0;
        this._glass?.destroy();
        this._glass = null;
        this._zoom?.destroy();
        this._zoom = null;
        this._dock?.destroy();
        this._dock = null;
        this._search?.destroy();
        this._search = null;
        this._destroyNotch();
        this._icons?.destroy();
        this._icons = null;
        this._settings = null;
    }
}
