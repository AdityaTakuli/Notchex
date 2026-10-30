import Adw from 'gi://Adw';
import Gtk from 'gi://Gtk';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {listGoogleAccounts} from './modules/goa.js';
import {CACHE_DIR} from './modules/icon-provider.js';
import {applyMacWindowButtons, isApplied as macButtonsApplied} from './modules/window-style.js';

export default class NotchexPrefs extends ExtensionPreferences {
    async fillPreferencesWindow(window) {
        const settings = this.getSettings('org.gnome.shell.extensions.notchex');
        window.set_default_size(720, 720);

        const generalPage = this._generalPage(settings);
        const appearancePage = this._appearancePage(settings);
        const activitiesPage = this._activitiesPage(settings);
        const dockPage = this._dockPage(settings);
        const iconsPage = this._iconsPage(settings, window);
        const searchPage = this._searchPage(settings);

        /* Features comes first: one place to pick which parts of Notchex
           you want, with links to each part's detailed page. */
        window.add(this._featuresPage(settings, window, {
            notch: appearancePage,
            dock: dockPage,
            search: searchPage,
            look: appearancePage,
        }));
        window.add(generalPage);
        window.add(appearancePage);
        window.add(activitiesPage);
        window.add(dockPage);
        window.add(iconsPage);
        window.add(searchPage);
        window.add(this._clockPage(settings));
        window.add(this._notifPage(settings));
        window.add(this._weatherPage(settings));
        window.add(this._claudePage(settings));
        window.add(this._notesPage(settings));
        window.add(this._pomodoroPage(settings));
        window.add(await this._accountsPage(settings));
        window.add(this._keybindPage(settings));

        /* "Customize Icon…" in the Dock menu opens us with an app queued */
        const pending = settings.get_string('icon-customize-request');
        if (pending) {
            settings.set_string('icon-customize-request', '');
            window.set_visible_page(iconsPage);
            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this._pickIcon(settings, window, pending, () => iconsPage._refresh?.());
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    /* ——— Features ——— */

    _featuresPage(settings, window, pages) {
        const page = new Adw.PreferencesPage({title: 'Features', icon_name: 'view-grid-symbolic'});

        const intro = new Adw.PreferencesGroup({
            title: 'Choose what Notchex changes',
            description: 'Each part works on its own. Start from a preset, then switch individual parts on or off. Changes apply right away.',
        });
        const presets = [
            ['Everything', 'The notch, Dock, Spotlight and the full macOS look', 'starred-symbolic', {
                'notch-enabled': true, 'show-notifications': true, 'search-enabled': true,
                'dock-enabled': true, 'glass-enabled': true, 'control-center-style': true, 'zoom-gestures': true,
            }],
            ['Notch only', 'Just the notch, with notifications and Spotlight. GNOME looks the same otherwise.', 'view-reveal-symbolic', {
                'notch-enabled': true, 'show-notifications': true, 'search-enabled': true,
                'dock-enabled': false, 'glass-enabled': false, 'control-center-style': false,
            }],
            ['Dock only', 'Just the magnifying Dock. GNOME keeps its own clock.', 'view-app-grid-symbolic', {
                'notch-enabled': false, 'dock-enabled': true,
                'glass-enabled': false, 'control-center-style': false,
            }],
            ['Look only', 'Frosted glass and the Control Center style, with no notch or Dock', 'applications-graphics-symbolic', {
                'notch-enabled': false, 'dock-enabled': false,
                'glass-enabled': true, 'control-center-style': true,
            }],
        ];
        for (const [title, subtitle, icon, values] of presets) {
            const row = new Adw.ActionRow({title, subtitle});
            row.add_prefix(new Gtk.Image({icon_name: icon}));
            const btn = new Gtk.Button({label: 'Use', valign: Gtk.Align.CENTER, css_classes: ['pill']});
            btn.connect('clicked', () => {
                for (const [key, value] of Object.entries(values))
                    settings.set_boolean(key, value);
            });
            row.add_suffix(btn);
            row.set_activatable_widget(btn);
            intro.add(row);
        }
        page.add(intro);

        const more = target => {
            const btn = new Gtk.Button({
                label: 'More',
                valign: Gtk.Align.CENTER,
                css_classes: ['flat'],
                tooltip_text: `Open the ${target.title} page`,
            });
            btn.connect('clicked', () => window.set_visible_page(target));
            return btn;
        };
        const needsNotch = row => {
            settings.bind('notch-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            return row;
        };

        /* the notch and what lives inside it */
        const notch = new Adw.PreferencesGroup({
            title: 'Notch',
            description: 'Spotlight and the auto-hiding top bar live inside the notch, so they need it on.',
            header_suffix: more(pages.notch),
        });
        notch.add(this._boolRow(settings, 'notch-enabled', 'Notch',
            'Replaces the top-bar clock. Shows music, timers and events, and opens into the hub.'));
        notch.add(needsNotch(this._boolRow(settings, 'show-notifications', 'Notifications in the notch',
            'New notifications appear in the notch instead of a banner')));
        notch.add(needsNotch(this._boolRow(settings, 'search-enabled', 'Spotlight search',
            'Super+Space turns the notch into a search bar')));
        notch.add(needsNotch(this._boolRow(settings, 'autohide-top-bar', 'Auto-hide the top bar',
            'The top bar slides away and comes back at the top edge')));
        page.add(notch);

        /* the Dock */
        const dock = new Adw.PreferencesGroup({
            title: 'Dock',
            header_suffix: more(pages.dock),
        });
        dock.add(this._boolRow(settings, 'dock-enabled', 'Dock',
            'macOS-style Dock with magnifying icons, at the bottom or side of the screen'));
        page.add(dock);

        /* changes to GNOME's own look and apps */
        const look = new Adw.PreferencesGroup({
            title: 'App and desktop look',
            header_suffix: more(pages.look),
        });
        look.add(this._boolRow(settings, 'glass-enabled', 'Frosted glass',
            'Blur behind the top bar, its menus and the Dock'));
        look.add(this._boolRow(settings, 'control-center-style', 'Control Center look',
            'Quick Settings styled like macOS Control Center'));
        look.add(this._macButtonsRow(settings,
            'Red, yellow and green buttons on the left of app windows. Apps pick this up after a restart.'));
        look.add(this._boolRow(settings, 'zoom-gestures', 'Zoom gestures',
            'Pinch with three fingers to zoom the screen'));
        page.add(look);

        return page;
    }

    /* The window-button switch appears on two pages; keep them in step. */
    _macButtonsRow(settings, subtitle = 'Red / yellow / green close, minimize and zoom on the left') {
        this._macRows ??= [];
        const row = new Adw.SwitchRow({
            title: 'macOS window buttons',
            subtitle,
            active: macButtonsApplied(),
        });
        row.connect('notify::active', () => {
            if (this._syncingMac) return;
            try { applyMacWindowButtons(settings, row.active); } catch (e) { console.error(e); }
            this._syncingMac = true;
            for (const other of this._macRows)
                if (other !== row) other.active = row.active;
            this._syncingMac = false;
        });
        this._macRows.push(row);
        return row;
    }

    _generalPage(settings) {
        const page = new Adw.PreferencesPage({title: 'General', icon_name: 'preferences-system-symbolic'});

        const modGroup = new Adw.PreferencesGroup({title: 'Modules'});
        modGroup.add(this._boolRow(settings, 'show-system',        'System monitor'));
        modGroup.add(this._boolRow(settings, 'show-media',         'Media player (MPRIS)'));
        modGroup.add(this._boolRow(settings, 'show-notifications', 'Dynamic notification peek'));
        modGroup.add(this._boolRow(settings, 'show-calendar',      'Google Calendar'));
        modGroup.add(this._boolRow(settings, 'show-tasks',         'Google Tasks'));
        modGroup.add(this._boolRow(settings, 'show-weather',       'Weather',
            'From wttr.in. With no location set, it guesses yours from your IP address.'));
        modGroup.add(this._boolRow(settings, 'show-claude-usage',  'Claude Code usage',
            'Reads your Claude Code sign-in and asks Anthropic for your usage every few minutes.'));
        page.add(modGroup);

        const perfGroup = new Adw.PreferencesGroup({title: 'Performance'});
        perfGroup.add(this._intRow(settings, 'poll-interval', 'System poll interval (s)', 1, 30, 1,
            '1s = real-time like Vitals; 3s = lighter.'));
        page.add(perfGroup);

        const panelGroup = new Adw.PreferencesGroup({title: 'Panel integration'});
        panelGroup.add(this._boolRow(settings, 'hide-datemenu',
            'Hide built-in GNOME clock (replace with notch)'));
        page.add(panelGroup);

        const zoomGroup = new Adw.PreferencesGroup({
            title: 'Zoom',
            description: 'Mac-style screen zoom. Keyboard: Alt+Super+8 on/off, Alt+Super+= / Alt+Super+- to zoom in/out.',
        });
        zoomGroup.add(this._boolRow(settings, 'zoom-gestures', 'Trackpad zoom gestures',
            'Pinch with three fingers to zoom the screen; double-tap with three fingers to toggle zoom.'));
        page.add(zoomGroup);

        return page;
    }

    _appearancePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Appearance', icon_name: 'applications-graphics-symbolic'});

        const shape = new Adw.PreferencesGroup({
            title: 'Shape',
            description: 'Notch keeps the top edge attached to the screen and rounds the bottom corners, like a MacBook notch. Floating is a fully rounded pill.',
        });
        shape.add(this._choiceRow(settings, 'island-style', 'Style',
            [['notch', 'Notch — attached to the top edge'], ['floating', 'Floating pill']]));
        shape.add(this._intRow(settings, 'corner-radius',    'Corner radius',            0,  40, 1));
        shape.add(this._intRow(settings, 'collapsed-width',  'Collapsed width (minimum)', 120, 480, 5));
        shape.add(this._intRow(settings, 'collapsed-height', 'Collapsed height',        22,  56, 1));
        shape.add(this._intRow(settings, 'expanded-width',   'Expanded width',         420, 960, 10));
        shape.add(this._intRow(settings, 'expanded-height',  'Expanded height (minimum)', 200, 480, 10));
        shape.add(this._intRow(settings, 'border-width',     'Outline thickness',        0,   3, 1));
        shape.add(this._intRow(settings, 'top-margin',       'Distance from top edge',   0,  24, 1,
            'Floating style only.'));
        page.add(shape);

        const colorGroup = new Adw.PreferencesGroup({
            title: 'Colors',
            description: 'Pick any color + opacity. A translucent background gives a glassy look.',
        });
        colorGroup.add(this._colorRow(settings, 'bg-color',     'Background'));
        colorGroup.add(this._colorRow(settings, 'text-color',   'Text'));
        colorGroup.add(this._colorRow(settings, 'accent-color', 'Accent (active tab)'));
        colorGroup.add(this._colorRow(settings, 'border-color', 'Outline'));
        colorGroup.add(this._colorRow(settings, 'shadow-color', 'Shadow'));
        colorGroup.add(this._boolRow(settings, 'enable-shadow', 'Shadow', 'Soft shadow that follows the rounded shape'));

        const presetRow = new Adw.ActionRow({title: 'Presets', subtitle: 'One-click theme swap'});
        const presetBox = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 4, halign: Gtk.Align.END, valign: Gtk.Align.CENTER});
        for (const [label, bg, ac, border] of [
            ['Notch',    'rgba(0, 0, 0, 1.00)',    'rgba(255, 255, 255, 0.14)', 'rgba(255, 255, 255, 0.08)'],
            ['Glass',    'rgba(12, 12, 14, 0.78)', 'rgba(255, 255, 255, 0.16)', 'rgba(255, 255, 255, 0.14)'],
            ['Graphite', 'rgba(22, 22, 26, 0.94)', 'rgba(180, 180, 190, 0.22)', 'rgba(255, 255, 255, 0.07)'],
            ['Nord',     'rgba(46, 52, 64, 0.94)', 'rgba(136, 192, 208, 0.30)', 'rgba(136, 192, 208, 0.18)'],
            ['Dracula',  'rgba(40, 42, 54, 0.94)', 'rgba(189, 147, 249, 0.32)', 'rgba(189, 147, 249, 0.20)'],
        ]) {
            const btn = new Gtk.Button({label, css_classes: ['flat']});
            btn.connect('clicked', () => {
                settings.set_string('bg-color', bg);
                settings.set_string('accent-color', ac);
                settings.set_string('border-color', border);
            });
            presetBox.append(btn);
        }
        presetRow.add_suffix(presetBox);
        colorGroup.add(presetRow);
        page.add(colorGroup);

        const anim = new Adw.PreferencesGroup({title: 'Animation'});
        anim.add(this._boolRow(settings, 'enable-animations', 'Smooth animations'));
        anim.add(this._choiceRow(settings, 'animation-speed', 'Animation speed',
            [['slow', 'Slow'], ['normal', 'Normal'], ['fast', 'Fast']]));
        anim.add(this._intRow(settings, 'hover-delay',    'Hover delay (ms)',    0, 1500, 10));
        anim.add(this._intRow(settings, 'collapse-delay', 'Collapse delay (ms)', 0, 5000, 50));
        page.add(anim);

        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        behavior.add(this._boolRow(settings, 'expand-on-hover', 'Expand on hover',
            'When off, hovering shows a compact preview and clicking expands.'));
        behavior.add(this._boolRow(settings, 'expand-on-click', 'Expand on click'));
        behavior.add(this._boolRow(settings, 'pill-gestures', 'Scroll and swipe on the notch',
            'Scroll to change the volume, swipe sideways to skip tracks'));
        behavior.add(this._boolRow(settings, 'auto-collapse', 'Auto-collapse',
            'When off, click the clock header or use the shortcut to collapse.'));
        behavior.add(this._boolRow(settings, 'always-show-clock', 'Always show clock',
            'Keep the clock visible while media is shown in the pill.'));
        behavior.add(this._boolRow(settings, 'always-show-media', 'Always show media',
            'Keep paused media in the pill (otherwise only while playing).'));
        behavior.add(this._boolRow(settings, 'pill-media-title', 'Song title in the pill',
            'Off: only the album art shows while music plays. Hover the pill to see the title.'));
        behavior.add(this._boolRow(settings, 'autohide-top-bar', 'Hide the top bar (Mac style)',
            'The top bar reappears when you push the pointer to the top edge. Windows start right below the notch.'));
        behavior.add(this._boolRow(settings, 'fill-top-strip', 'Fill the strip beside the notch',
            'With the top bar hidden, cover the space beside the notch with its color while a window is maximized or full screen. The pill gets a light rim so it stays visible. Otherwise the wallpaper shows.'));
        behavior.add(this._boolRow(settings, 'eq-follow-audio', 'Music bars follow the audio',
            'Reads what your speakers play (never the microphone). GNOME may show its recording indicator while it runs.'));
        behavior.add(this._boolRow(settings, 'pill-show-weather', 'Temperature in the pill'));
        behavior.add(this._boolRow(settings, 'pill-show-system', 'CPU / RAM in the pill',
            'Polls system stats in the background (every 3× the poll interval).'));
        page.add(behavior);

        const windows = new Adw.PreferencesGroup({
            title: 'Windows',
            description: 'Applies to all apps (Terminal, Files, Settings…). Apps pick it up when restarted. Sandboxed snap/Flatpak apps may keep their own buttons.',
        });
        windows.add(this._macButtonsRow(settings));
        page.add(windows);

        const battGroup = new Adw.PreferencesGroup({
            title: 'Battery icon colors',
            description: 'Colour of the battery indicator in the collapsed pill.',
        });
        battGroup.add(this._colorRow(settings, 'battery-charging-color', 'Charging'));
        battGroup.add(this._colorRow(settings, 'battery-normal-color',   'Discharging'));
        battGroup.add(this._colorRow(settings, 'battery-low-color',      'Low battery'));
        page.add(battGroup);

        const glassGroup = new Adw.PreferencesGroup({
            title: 'Glass',
            description: 'macOS-style frosted glass: what\'s behind shows through, blurred.',
        });
        glassGroup.add(this._boolRow(settings, 'glass-enabled', 'Frosted glass'));
        glassGroup.add(this._boolRow(settings, 'control-center-style', 'Control Center look',
            'Quick Settings (Wi-Fi, Bluetooth, sound…) styled like macOS Control Center.'));
        glassGroup.add(this._boolRow(settings, 'glass-menus', 'Top bar menus',
            'Quick Settings, calendar and indicator menus.'));
        glassGroup.add(this._boolRow(settings, 'glass-panel', 'Top bar'));
        glassGroup.add(this._boolRow(settings, 'glass-dock', 'Dock'));
        glassGroup.add(this._boolRow(settings, 'glass-island', 'Open notch and Spotlight results',
            'The compact notch stays solid black'));
        glassGroup.add(this._intRow(settings, 'glass-blur', 'Blur strength', 0, 80, 2));
        page.add(glassGroup);

        return page;
    }

    _activitiesPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Live Activities', icon_name: 'emblem-important-symbolic'});

        const group = new Adw.PreferencesGroup({
            title: 'Notch events',
            description: 'Short-lived events the notch expands for, then folds back. When several happen at once the most important wins: critical battery › notifications › media › Bluetooth › volume › brightness › calendar.',
        });
        group.add(this._boolRow(settings, 'event-media',      'Now Playing', 'When the track changes in any MPRIS player'));
        group.add(this._boolRow(settings, 'show-notifications', 'Notifications', 'Show incoming notifications in the notch'));
        group.add(this._boolRow(settings, 'event-volume',     'Volume'));
        group.add(this._boolRow(settings, 'event-brightness', 'Screen brightness'));
        group.add(this._boolRow(settings, 'event-battery',    'Battery', 'Charger connected / removed, low and critical battery'));
        group.add(this._boolRow(settings, 'event-bluetooth',  'Bluetooth devices', 'Connect / disconnect with battery level when available'));
        group.add(this._boolRow(settings, 'event-focus',      'Focus', 'Do Not Disturb turning on or off'));
        group.add(this._boolRow(settings, 'event-calendar',   'Upcoming calendar events'));
        group.add(this._intRow(settings, 'calendar-lead-minutes', 'Announce events this many minutes ahead', 1, 60, 1));
        group.add(this._intRow(settings, 'event-duration', 'Event duration (s)', 1, 15, 1,
            'Volume and brightness always use a short 1.8 s display.'));
        page.add(group);

        const osd = new Adw.PreferencesGroup({title: 'System popups'});
        osd.add(this._boolRow(settings, 'replace-system-osd', 'Replace GNOME volume / brightness popup',
            'The GNOME popup still appears whenever the notch cannot show the change (expanded, fullscreen app, or a more important event on screen).'));
        page.add(osd);

        return page;
    }

    /* ——— Dock ——— */

    _dockPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Dock', icon_name: 'view-app-grid-symbolic'});

        const main = new Adw.PreferencesGroup({title: 'Dock'});
        main.add(this._boolRow(settings, 'dock-enabled', 'Show the Notchex Dock'));
        main.add(this._choiceRow(settings, 'dock-position', 'Position',
            [['bottom', 'Bottom'], ['left', 'Left'], ['right', 'Right']]));
        main.add(this._choiceRow(settings, 'dock-autohide', 'Visibility', [
            ['intelligent', 'Hide when a window overlaps or after a few idle seconds'],
            ['autohide', 'Auto-hide (show at the screen edge)'],
            ['always', 'Always visible'],
        ]));
        page.add(main);

        /* another dock extension would sit on top of ours */
        const others = ['ubuntu-dock@ubuntu.com', 'dash-to-dock@micxgx.gmail.com']
            .filter(uuid => this._extensionEnabled(uuid));
        if (others.length) {
            const warn = new Adw.PreferencesGroup();
            const row = new Adw.ActionRow({
                title: 'Another dock is enabled',
                subtitle: `${others.join(', ')} will show a second dock.`,
            });
            const btn = new Gtk.Button({label: 'Disable It', css_classes: ['destructive-action', 'pill'],
                valign: Gtk.Align.CENTER});
            btn.connect('clicked', () => {
                for (const uuid of others) {
                    try {
                        Gio.Subprocess.new(['gnome-extensions', 'disable', uuid], Gio.SubprocessFlags.NONE);
                    } catch (e) { console.error(e); }
                }
                row.set_subtitle('Disabled.');
                btn.sensitive = false;
            });
            row.add_suffix(btn);
            warn.add(row);
            page.add(warn);
        }

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(this._intRow(settings, 'dock-icon-size', 'Icon size', 32, 96, 2));
        look.add(this._boolRow(settings, 'dock-magnify', 'Magnification'));
        look.add(this._intRow(settings, 'dock-magnification', 'Magnification strength (%)', 10, 120, 5));
        look.add(this._intRow(settings, 'dock-opacity', 'Background opacity (%)', 0, 100, 5));
        look.add(this._choiceRow(settings, 'dock-theme', 'Surface',
            [['auto', 'Follow system style'], ['dark', 'Dark'], ['light', 'Light']]));
        look.add(this._intRow(settings, 'dock-corner-radius', 'Corner radius', 0, 32, 1));
        look.add(this._intRow(settings, 'dock-edge-margin', 'Distance from screen edge', 0, 40, 1));
        page.add(look);

        const behavior = new Adw.PreferencesGroup({title: 'Behavior'});
        behavior.add(this._boolRow(settings, 'dock-show-running', 'Running indicators'));
        behavior.add(this._boolRow(settings, 'dock-show-previews', 'Window previews on hover'));
        behavior.add(this._boolRow(settings, 'dock-show-tooltips', 'App name tooltips'));
        behavior.add(this._boolRow(settings, 'dock-launch-animation', 'Bounce when launching'));
        behavior.add(this._boolRow(settings, 'dock-separators', 'Separators'));
        behavior.add(this._boolRow(settings, 'dock-show-trash', 'Trash'));
        page.add(behavior);

        const apps = new Adw.PreferencesGroup({
            title: 'Apps',
            description: 'The Dock shows GNOME\'s pinned apps (the same list as the Overview). Pin or unpin from an icon\'s right-click menu, drag icons to reorder, or drag an app from the app grid onto the Dock.',
        });
        page.add(apps);
        return page;
    }

    _extensionEnabled(uuid) {
        try {
            const shell = new Gio.Settings({schema_id: 'org.gnome.shell'});
            return shell.get_strv('enabled-extensions').includes(uuid) &&
                !shell.get_strv('disabled-extensions').includes(uuid);
        } catch (_) { return false; }
    }

    /* ——— Spotlight ——— */

    _searchPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Search', icon_name: 'system-search-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Spotlight search',
            description: 'Search apps, files, settings and system actions, or type a calculation. ↑/↓ to move, Tab to jump between groups, Enter to open, Esc to close.',
        });
        group.add(this._boolRow(settings, 'search-enabled', 'Enable Spotlight'));
        const sc = new Adw.EntryRow({title: 'Shortcut (e.g. <Super>space or <Control>space)', use_markup: false});
        sc.set_text(settings.get_strv('shortcut-search')[0] ?? '');
        sc.connect('changed', () => {
            const t = sc.get_text().trim();
            if (!t || Gtk.accelerator_parse(t)[0]) settings.set_strv('shortcut-search', t ? [t] : []);
        });
        group.add(sc);
        group.add(this._boolRow(settings, 'search-replace-overview', 'Replace the Overview search bar',
            'Typing in the Overview opens search in the notch instead.'));
        group.add(this._boolRow(settings, 'search-files', 'Include files',
            'Uses the Files app\'s search index (Tracker).'));
        group.add(this._boolRow(settings, 'search-remember-history', 'Remember recent searches'));
        const clear = new Adw.ActionRow({title: 'Search history'});
        const btn = new Gtk.Button({label: 'Clear', css_classes: ['pill'], valign: Gtk.Align.CENTER});
        btn.connect('clicked', () => settings.set_strv('search-history', []));
        clear.add_suffix(btn);
        group.add(clear);
        page.add(group);
        try {
            const layouts = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'})
                .get_value('sources').deepUnpack();
            if (layouts.length > 1 && (settings.get_strv('shortcut-search')[0] ?? '').toLowerCase() === '<super>space') {
                const warn = new Adw.PreferencesGroup();
                warn.add(new Adw.ActionRow({
                    title: 'Super+Space also switches keyboard layouts',
                    subtitle: 'You have several layouts; choose another Spotlight shortcut to keep layout switching.',
                }));
                page.add(warn);
            }
        } catch (_) {}
        return page;
    }

    /* ——— Icons ——— */

    _iconsPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Icons', icon_name: 'preferences-desktop-appearance-symbolic'});

        const source = new Adw.PreferencesGroup({
            title: 'App icons',
            description: 'Used by the Dock and Spotlight. A custom icon you pick for an app always wins.',
        });
        source.add(this._choiceRow(settings, 'icon-source', 'Icon source', [
            ['system', 'GNOME icons'],
            ['macos', 'macOS-style (macOSicons.com)'],
            ['custom', 'Custom icons only'],
        ]));
        page.add(source);

        const api = new Adw.PreferencesGroup({
            title: 'macOSicons.com',
            description: 'macOS-style icons are looked up one app at a time with your own API key (get one at macosicons.com/developers), downloaded once and cached in ~/.cache/notchex/icons. The key is stored in your GNOME keyring, not in settings.',
        });
        const keyRow = new Adw.PasswordEntryRow({title: 'API key', show_apply_button: true});
        const status = new Adw.ActionRow({title: 'Key status', subtitle: 'Checking…'});
        const refreshStatus = () => {
            this._secret().then(({Secret, schema}) => {
                Secret.password_lookup(schema, {service: 'macosicons'}, null, (_s, res) => {
                    let k = null;
                    try { k = Secret.password_lookup_finish(res); } catch (_) {}
                    status.set_subtitle(k ? `Saved in keyring (…${k.slice(-4)})` : 'No key saved');
                });
            }).catch(() => status.set_subtitle('Keyring unavailable'));
        };
        keyRow.connect('apply', () => {
            const key = keyRow.get_text().trim();
            if (!key) return;
            this._secret().then(({Secret, schema}) => {
                Secret.password_store(schema, {service: 'macosicons'}, Secret.COLLECTION_DEFAULT,
                    'Notchex — macOSicons API key', key, null, (_s, res) => {
                        try { Secret.password_store_finish(res); } catch (e) { console.error(e); }
                        keyRow.set_text('');
                        settings.set_int('macosicons-key-version', settings.get_int('macosicons-key-version') + 1);
                        refreshStatus();
                    });
            });
        });
        api.add(keyRow);
        const removeBtn = new Gtk.Button({label: 'Remove', css_classes: ['flat'], valign: Gtk.Align.CENTER});
        removeBtn.connect('clicked', () => {
            this._secret().then(({Secret, schema}) => {
                Secret.password_clear(schema, {service: 'macosicons'}, null, () => {
                    settings.set_int('macosicons-key-version', settings.get_int('macosicons-key-version') + 1);
                    refreshStatus();
                });
            });
        });
        status.add_suffix(removeBtn);
        api.add(status);
        api.add(this._intRow(settings, 'icon-refresh-days', 'Refresh cached icons after (days, 0 = never)', 0, 365, 5));
        const cacheRow = new Adw.ActionRow({title: 'Icon cache', subtitle: CACHE_DIR.replace(GLib.get_home_dir(), '~')});
        const clearBtn = new Gtk.Button({label: 'Clear', css_classes: ['pill'], valign: Gtk.Align.CENTER});
        cacheRow.add_suffix(clearBtn);
        api.add(cacheRow);
        page.add(api);
        refreshStatus();

        const custom = new Adw.PreferencesGroup({
            title: 'Custom icons',
            description: 'Pick an image for any pinned app. You can also drop files named after the app id (e.g. org.mozilla.firefox.png) into ~/.local/share/notchex/icons.',
        });
        page.add(custom);
        const credits = new Adw.PreferencesGroup({
            title: 'Icon credits',
            description: 'Downloaded icons are provided by macOSicons.com and their creators.',
        });
        page.add(credits);

        const rows = [];
        const refresh = () => {
            for (const [group, row] of rows) group.remove(row);
            rows.length = 0;
            const map = settings.get_value('icon-custom-map').deepUnpack();
            let favs = [];
            try { favs = new Gio.Settings({schema_id: 'org.gnome.shell'}).get_strv('favorite-apps'); } catch (_) {}
            for (const id of favs) {
                const info = Gio.DesktopAppInfo.new(id);
                if (!info) continue;
                const row = new Adw.ActionRow({title: info.get_name(), subtitle: map[id] ? map[id].replace(GLib.get_home_dir(), '~') : 'Default'});
                const img = new Gtk.Image({pixel_size: 32});
                const cached = this._cachedIconPath(id);
                if (map[id]) img.set_from_file(map[id]);
                else if (cached && settings.get_string('icon-source') === 'macos') img.set_from_file(cached);
                else img.set_from_gicon(info.get_icon());
                row.add_prefix(img);
                const choose = new Gtk.Button({label: 'Choose…', css_classes: ['flat'], valign: Gtk.Align.CENTER});
                choose.connect('clicked', () => this._pickIcon(settings, window, id, refresh));
                row.add_suffix(choose);
                if (map[id]) {
                    const reset = new Gtk.Button({icon_name: 'edit-undo-symbolic', css_classes: ['flat'],
                        valign: Gtk.Align.CENTER, tooltip_text: 'Reset to default'});
                    reset.connect('clicked', () => {
                        const m = settings.get_value('icon-custom-map').deepUnpack();
                        delete m[id];
                        settings.set_value('icon-custom-map', new GLib.Variant('a{ss}', m));
                        refresh();
                    });
                    row.add_suffix(reset);
                }
                custom.add(row);
                rows.push([custom, row]);
            }
            const metas = this._iconCredits();
            if (!metas.length) {
                const none = new Adw.ActionRow({title: 'No downloaded icons yet'});
                credits.add(none);
                rows.push([credits, none]);
            }
            for (const meta of metas) {
                const row = new Adw.ActionRow({
                    title: meta.appName ?? meta.appId,
                    subtitle: `by ${meta.credit || 'unknown creator'} · macOSicons.com`,
                });
                if (meta.iconPath) row.add_prefix(new Gtk.Image({file: meta.iconPath, pixel_size: 32}));
                const url = meta.creditUrl || 'https://macosicons.com';
                const link = new Gtk.LinkButton({label: 'View source', uri: url, valign: Gtk.Align.CENTER});
                row.add_suffix(link);
                credits.add(row);
                rows.push([credits, row]);
            }
        };
        clearBtn.connect('clicked', () => {
            this._clearIconCache();
            settings.set_int('macosicons-key-version', settings.get_int('macosicons-key-version') + 1);
            refresh();
        });
        page._refresh = refresh;
        refresh();
        return page;
    }

    async _secret() {
        const Secret = (await import('gi://Secret')).default;
        const schema = new Secret.Schema('org.notchex.MacOSIcons', Secret.SchemaFlags.NONE,
            {service: Secret.SchemaAttributeType.STRING});
        return {Secret, schema};
    }

    _cachedIconPath(appId) {
        const key = appId.replace(/\.desktop$/, '').replace(/[^\w.-]/g, '_');
        const p = GLib.build_filenamev([CACHE_DIR, `${key}.png`]);
        return GLib.file_test(p, GLib.FileTest.EXISTS) ? p : null;
    }

    _iconCredits() {
        const out = [];
        try {
            const dir = Gio.File.new_for_path(CACHE_DIR);
            const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const name = info.get_name();
                if (!name.endsWith('.json')) continue;
                try {
                    const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([CACHE_DIR, name]));
                    const meta = JSON.parse(new TextDecoder().decode(bytes));
                    if (meta.source === 'macosicons' && !meta.notFound) out.push(meta);
                } catch (_) {}
            }
        } catch (_) {}
        return out.sort((a, b) => (a.appName ?? '').localeCompare(b.appName ?? ''));
    }

    _clearIconCache() {
        try {
            const dir = Gio.File.new_for_path(CACHE_DIR);
            const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) dir.get_child(info.get_name()).delete(null);
        } catch (_) {}
    }

    _pickIcon(settings, window, appId, done) {
        const filter = new Gtk.FileFilter({name: 'Images'});
        for (const t of ['image/png', 'image/svg+xml', 'image/jpeg', 'image/webp']) filter.add_mime_type(t);
        const filters = new Gio.ListStore({item_type: Gtk.FileFilter});
        filters.append(filter);
        const info = Gio.DesktopAppInfo.new(appId);
        const dialog = new Gtk.FileDialog({title: `Icon for ${info?.get_name() ?? appId}`, filters, modal: true});
        dialog.open(window, null, (d, res) => {
            let file = null;
            try { file = d.open_finish(res); } catch (_) { return; }
            const path = file?.get_path();
            if (!path) return;
            const m = settings.get_value('icon-custom-map').deepUnpack();
            m[appId] = path;
            settings.set_value('icon-custom-map', new GLib.Variant('a{ss}', m));
            done?.();
        });
    }

    _choiceRow(settings, key, title, choices) {
        const row = new Adw.ComboRow({title});
        const model = new Gtk.StringList();
        for (const [, label] of choices) model.append(label);
        row.set_model(model);
        const sync = () => {
            const idx = choices.findIndex(([v]) => v === settings.get_string(key));
            row.set_selected(Math.max(0, idx));
        };
        sync();
        row.connect('notify::selected', () => {
            const v = choices[row.get_selected()]?.[0];
            if (v && v !== settings.get_string(key)) settings.set_string(key, v);
        });
        settings.connect(`changed::${key}`, sync);
        return row;
    }

    _weatherPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Weather', icon_name: 'weather-few-clouds-symbolic'});

        const primary = new Adw.PreferencesGroup({
            title: 'Primary location',
            description: 'Powered by wttr.in — no API key. Accepts: city ("Istanbul"), district ("Kadıköy, Istanbul"), neighbourhood ("Beşiktaş, Istanbul"), coordinates ("41.02,28.99"), airport code ("IST"), or a ~-prefixed place name ("~Eiffel Tower"). Empty = IP geolocation.',
        });
        const loc = new Adw.EntryRow({title: 'Location (city / district / coords)'});
        settings.bind('weather-location', loc, 'text', 0);
        primary.add(loc);
        const lbl = new Adw.EntryRow({title: 'Friendly label (e.g. "Home")'});
        settings.bind('weather-location-label', lbl, 'text', 0);
        primary.add(lbl);
        page.add(primary);

        const secondary = new Adw.PreferencesGroup({
            title: 'Secondary location',
            description: 'For people splitting their week between two cities (or neighbourhoods). Same format as primary. Empty = disabled.',
        });
        const loc2 = new Adw.EntryRow({title: 'Location (city / district / coords)'});
        settings.bind('weather-location-2', loc2, 'text', 0);
        secondary.add(loc2);
        const lbl2 = new Adw.EntryRow({title: 'Friendly label (e.g. "Work")'});
        settings.bind('weather-location-2-label', lbl2, 'text', 0);
        secondary.add(lbl2);
        page.add(secondary);

        const opts = new Adw.PreferencesGroup({title: 'Options'});
        const unit = new Adw.ComboRow({title: 'Units'});
        const unitModel = new Gtk.StringList();
        unitModel.append('Metric (°C, km/h)');
        unitModel.append('Imperial (°F, mph)');
        unit.set_model(unitModel);
        unit.set_selected(settings.get_string('weather-unit') === 'imperial' ? 1 : 0);
        unit.connect('notify::selected', () => {
            settings.set_string('weather-unit', unit.get_selected() === 1 ? 'imperial' : 'metric');
        });
        opts.add(unit);
        opts.add(this._intRow(settings, 'weather-refresh', 'Refresh interval (min)', 5, 240, 5));
        page.add(opts);
        return page;
    }

    _claudePage(settings) {
        const page = new Adw.PreferencesPage({title: 'Claude', icon_name: 'preferences-system-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Claude Code usage',
            description: 'Reads the local Claude Code CLI session (the same login `claude` already uses) and shows session/weekly quota utilization. Requires having run `claude` at least once to sign in.',
        });
        group.add(this._boolRow(settings, 'show-claude-usage', 'Show Claude usage (System → Claude)'));
        group.add(this._intRow(settings, 'claude-usage-refresh', 'Refresh interval (min)', 5, 120, 5));
        page.add(group);
        return page;
    }

    _notesPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Notes', icon_name: 'text-editor-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Storage',
            description: 'Notes are saved as markdown files (title from the note, or the body if untitled), one dated subfolder per day (DD-MM-YY).',
        });

        const folderRow = new Adw.ActionRow({
            title: 'Notes folder',
            subtitle: settings.get_string('notes-folder') || '~/Documents/Notchex Notes (default)',
        });
        const browseBtn = new Gtk.Button({label: 'Browse…', css_classes: ['flat']});
        browseBtn.connect('clicked', () => {
            const dialog = new Gtk.FileDialog({title: 'Pick notes folder'});
            dialog.select_folder(browseBtn.get_root(), null, (dlg, res) => {
                try {
                    const f = dlg.select_folder_finish(res);
                    if (f) {
                        const path = f.get_path();
                        settings.set_string('notes-folder', path);
                        folderRow.set_subtitle(path);
                    }
                } catch (_) {}
            });
        });
        folderRow.add_suffix(browseBtn);
        group.add(folderRow);

        const openBtn = new Adw.ActionRow({title: 'Open notes folder'});
        const open = new Gtk.Button({label: 'Open', css_classes: ['pill']});
        open.connect('clicked', () => {
            const dir = settings.get_string('notes-folder') || GLib.build_filenamev([
                GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_DOCUMENTS) || GLib.get_home_dir(),
                'Notchex Notes',
            ]);
            GLib.mkdir_with_parents(dir, 0o755);
            Gio.AppInfo.launch_default_for_uri(Gio.File.new_for_path(dir).get_uri(), null);
        });
        openBtn.add_suffix(open);
        group.add(openBtn);

        page.add(group);
        return page;
    }

    _pomodoroPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Pomodoro', icon_name: 'alarm-symbolic'});

        const presetGroup = new Adw.PreferencesGroup({
            title: 'Presets',
            description: 'Each preset is "work/break" minutes. Click × to remove, + to add a new one.',
        });

        /* Adw.PreferencesGroup wraps rows in internal boxes, so track the
           rows we add ourselves instead of walking its children. */
        let rows = [];
        const rebuild = () => {
            for (const r of rows) presetGroup.remove(r);
            rows = [];
            const add = r => { rows.push(r); presetGroup.add(r); };

            const presets = settings.get_strv('pomodoro-presets');
            const active  = settings.get_string('pomodoro-active-preset');

            for (const p of presets) {
                const r = new Adw.ActionRow({title: p});
                if (p === active) r.set_subtitle('active');
                const activate = new Gtk.Button({label: 'Use', css_classes: ['pill']});
                activate.connect('clicked', () => {
                    settings.set_string('pomodoro-active-preset', p);
                    rebuild();
                });
                const remove = new Gtk.Button({icon_name: 'user-trash-symbolic', css_classes: ['flat']});
                remove.connect('clicked', () => {
                    const next = presets.filter(x => x !== p);
                    if (next.length === 0) return;
                    settings.set_strv('pomodoro-presets', next);
                    if (p === active) settings.set_string('pomodoro-active-preset', next[0]);
                    rebuild();
                });
                r.add_suffix(activate);
                r.add_suffix(remove);
                add(r);
            }

            const addRow = new Adw.ActionRow({title: 'New preset'});
            const workEntry = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower: 1, upper: 180, step_increment: 1, value: 25}),
                width_chars: 4,
            });
            const breakEntry = new Gtk.SpinButton({
                adjustment: new Gtk.Adjustment({lower: 1, upper: 60, step_increment: 1, value: 5}),
                width_chars: 4,
            });
            const addBtn = new Gtk.Button({label: 'Add', css_classes: ['suggested-action', 'pill']});
            addBtn.connect('clicked', () => {
                const w = workEntry.get_value_as_int();
                const b = breakEntry.get_value_as_int();
                const key = `${w}/${b}`;
                const cur = settings.get_strv('pomodoro-presets');
                if (!cur.includes(key)) {
                    settings.set_strv('pomodoro-presets', [...cur, key]);
                    rebuild();
                }
            });
            addRow.add_suffix(workEntry);
            addRow.add_suffix(new Gtk.Label({label: '/'}));
            addRow.add_suffix(breakEntry);
            addRow.add_suffix(addBtn);
            add(addRow);
        };
        rebuild();
        page.add(presetGroup);

        const longGroup = new Adw.PreferencesGroup({title: 'Long break'});
        longGroup.add(this._intRow(settings, 'pomodoro-long',   'Long break (min)',          1, 60, 1));
        longGroup.add(this._intRow(settings, 'pomodoro-cycles', 'Cycles before long break',  1, 10, 1));
        page.add(longGroup);

        return page;
    }

    async _accountsPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Calendar & Tasks', icon_name: 'x-office-calendar-symbolic'});

        const flow = new Adw.PreferencesGroup({
            title: 'How it works',
            description: 'Calendar events come from the shell\'s CalendarServer (the same source GNOME uses for the top-bar calendar). Tasks come from Evolution Data Server\'s task sources. Both are populated automatically once a Google account is added to GNOME Online Accounts — you do NOT log in from inside this extension, GOA handles it. If events/tasks are empty, run "Open GNOME Settings" below and confirm Calendar + To Do are toggled on for your account.',
        });
        page.add(flow);

        const group = new Adw.PreferencesGroup({
            title: 'Google accounts',
            description: 'Toggle which connected accounts this notch should read.',
        });

        let accounts = [];
        let loadErr = null;
        try {
            accounts = await listGoogleAccounts();
        } catch (e) {
            loadErr = e;
            console.error('notchex prefs: listGoogleAccounts failed', e?.message ?? e);
        }
        const enabled = settings.get_strv('calendar-enabled-sources');

        if (loadErr) {
            const err = new Adw.ActionRow({
                title: 'Could not read GOA accounts',
                subtitle: String(loadErr?.message ?? loadErr),
            });
            group.add(err);
        }

        if (accounts.length === 0) {
            const empty = new Adw.ActionRow({
                title: 'No Google accounts connected',
                subtitle: 'Click below to open GNOME Online Accounts and add one',
            });
            const btn = new Gtk.Button({label: 'Open GNOME Settings', css_classes: ['suggested-action', 'pill']});
            btn.connect('clicked', () => {
                const gcc = GLib.find_program_in_path('gnome-control-center');
                if (gcc) Gio.Subprocess.new([gcc, 'online-accounts'], 0);
            });
            empty.add_suffix(btn);
            group.add(empty);
        } else {
            for (const a of accounts) {
                const row = new Adw.SwitchRow({
                    title: a.email,
                    subtitle: `Calendar ${a.calendarDisabled ? 'off' : 'on'} · Tasks ${a.todoDisabled ? 'off' : 'on'}`,
                });
                row.set_active(enabled.length === 0 || enabled.includes(a.email));
                row.connect('notify::active', () => {
                    const cur = new Set(settings.get_strv('calendar-enabled-sources'));
                    if (row.get_active()) cur.add(a.email);
                    else                  cur.delete(a.email);
                    /* empty = all (legacy). if user disables some, emit explicit list */
                    if (cur.size === accounts.length) settings.set_strv('calendar-enabled-sources', []);
                    else settings.set_strv('calendar-enabled-sources', Array.from(cur));
                });
                group.add(row);
            }
            const manageBtn = new Adw.ActionRow({title: 'Manage accounts'});
            const open = new Gtk.Button({label: 'GNOME Settings', css_classes: ['pill']});
            open.connect('clicked', () => {
                const gcc = GLib.find_program_in_path('gnome-control-center');
                if (gcc) Gio.Subprocess.new([gcc, 'online-accounts'], 0);
            });
            manageBtn.add_suffix(open);
            group.add(manageBtn);
        }

        page.add(group);

        const tasksGroup = new Adw.PreferencesGroup({
            title: 'Google Tasks lists',
            description: 'Comma-separated list of task-list names to include. Empty shows all.',
        });
        const tasksEntry = new Adw.EntryRow({title: 'Allowed lists (comma-separated)'});
        tasksEntry.set_text(settings.get_strv('tasks-enabled-lists').join(', '));
        tasksEntry.connect('changed', () => {
            const raw = tasksEntry.get_text() ?? '';
            const arr = raw.split(',').map(s => s.trim()).filter(Boolean);
            settings.set_strv('tasks-enabled-lists', arr);
        });
        tasksGroup.add(tasksEntry);
        page.add(tasksGroup);

        return page;
    }

    _keybindPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Shortcuts', icon_name: 'input-keyboard-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Global shortcuts',
            description: 'Edit with accelerator syntax, e.g. &lt;Super&gt;&lt;Shift&gt;d',
        });

        const tg = new Adw.EntryRow({title: 'Toggle notch (expand / collapse)'});
        tg.set_text((settings.get_strv('shortcut-toggle')[0]) ?? '');
        tg.connect('changed', () => {
            settings.set_strv('shortcut-toggle', [tg.get_text()]);
        });
        group.add(tg);

        const st = new Adw.EntryRow({title: 'Open these settings', use_markup: false});
        st.set_text((settings.get_strv('shortcut-settings')[0]) ?? '');
        st.connect('changed', () => {
            const t = st.get_text().trim();
            if (!t || Gtk.accelerator_parse(t)[0]) settings.set_strv('shortcut-settings', t ? [t] : []);
        });
        group.add(st);

        const tip = new Adw.PreferencesGroup({
            title: 'Other ways in',
            description: 'Right-click the notch, search “Notchex Settings” in Spotlight, or open the Notchex Settings app. No Extension Manager needed.',
        });
        page.add(group);
        page.add(tip);
        return page;
    }

    _clockPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Clock', icon_name: 'alarm-symbolic'});

        const group = new Adw.PreferencesGroup({title: 'Clock'});
        group.add(this._boolRow(settings, 'show-date',    'Show date in collapsed pill'));
        group.add(this._boolRow(settings, 'show-seconds', 'Show seconds (updates every second)'));

        const fmt = new Adw.ComboRow({title: '12h / 24h format'});
        const fmtModel = new Gtk.StringList();
        fmtModel.append('24h'); fmtModel.append('12h');
        fmt.set_model(fmtModel);
        fmt.set_selected(settings.get_string('clock-format') === '12h' ? 1 : 0);
        fmt.connect('notify::selected', () => {
            settings.set_string('clock-format', fmt.get_selected() === 1 ? '12h' : '24h');
        });
        group.add(fmt);

        page.add(group);
        return page;
    }

    _notifPage(settings) {
        const page = new Adw.PreferencesPage({title: 'Notifications', icon_name: 'preferences-system-notifications-symbolic'});
        const group = new Adw.PreferencesGroup({
            title: 'Notifications',
            description: 'Notchex shows a dynamic peek inside the notch AND force-closes non-critical banners. Fixes the Fedora-45+ bug where banners never auto-dismiss.',
        });
        group.add(this._intRow(settings, 'notif-auto-dismiss', 'Auto-dismiss after (s, 0 = off)', 0, 120, 1));
        group.add(this._boolRow(settings, 'notif-suppress-native',
            'Suppress the native banner when notch peek shows',
            'Your eyes only need to watch the notch.'));
        page.add(group);

        const dndGroup = new Adw.PreferencesGroup({
            title: 'Do Not Disturb',
            description: 'Toggle from the notch (System → Controls). This mirrors the GNOME "Show banners" setting, so it also affects other apps.',
        });
        const dndRow = new Adw.ActionRow({
            title: 'System DND state',
            subtitle: 'Read-only reflection of org.gnome.desktop.notifications.show-banners',
        });
        try {
            const ns = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            const lbl = new Gtk.Label({label: ns.get_boolean('show-banners') ? 'OFF (banners shown)' : 'ON (banners hidden)'});
            ns.connect('changed::show-banners', () => {
                lbl.label = ns.get_boolean('show-banners') ? 'OFF (banners shown)' : 'ON (banners hidden)';
            });
            dndRow.add_suffix(lbl);
        } catch (_) {}
        dndGroup.add(dndRow);
        page.add(dndGroup);

        return page;
    }

    /* —— row builders —— */

    _boolRow(settings, key, title, subtitle) {
        const row = new Adw.SwitchRow({title});
        if (subtitle) row.set_subtitle(subtitle);
        settings.bind(key, row, 'active', 0);
        return row;
    }

    _intRow(settings, key, title, min, max, step, subtitle) {
        const row = new Adw.SpinRow({
            title,
            adjustment: new Gtk.Adjustment({lower: min, upper: max, step_increment: step}),
        });
        if (subtitle) row.set_subtitle(subtitle);
        settings.bind(key, row, 'value', 0);
        return row;
    }

    _colorRow(settings, key, title) {
        const row = new Adw.ActionRow({title, subtitle: settings.get_string(key)});
        const btn = new Gtk.ColorDialogButton({
            dialog: new Gtk.ColorDialog({title, with_alpha: true}),
        });
        btn.set_rgba(this._parseRgba(settings.get_string(key)));
        btn.connect('notify::rgba', () => {
            const rgba = btn.get_rgba();
            const s = this._rgbaToString(rgba);
            settings.set_string(key, s);
            row.set_subtitle(s);
        });
        settings.connect(`changed::${key}`, () => {
            btn.set_rgba(this._parseRgba(settings.get_string(key)));
            row.set_subtitle(settings.get_string(key));
        });
        row.add_suffix(btn);
        return row;
    }

    _parseRgba(str) {
        const rgba = new Gdk.RGBA();
        rgba.parse(str);
        return rgba;
    }

    _rgbaToString(rgba) {
        const r = Math.round(rgba.red   * 255);
        const g = Math.round(rgba.green * 255);
        const b = Math.round(rgba.blue  * 255);
        const a = rgba.alpha.toFixed(2);
        return `rgba(${r}, ${g}, ${b}, ${a})`;
    }
}
