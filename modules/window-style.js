import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

/* macOS-style window buttons for every app: traffic-light close /
   minimize / zoom on the left.

   Two parts, both fully reversible:
   - GNOME's button layout setting (buttons on the left, Mac order); the
     previous layout is remembered and restored.
   - a marked block of CSS appended to ~/.config/gtk-3.0/gtk.css and
     ~/.config/gtk-4.0/gtk.css (GTK 3 apps such as Terminal, GTK 4 /
     libadwaita apps, and title bars mutter draws with the GTK 3 theme).
     Only the text between the markers is ever touched.
   Apps pick up the change when they are restarted. Sandboxed snaps and
   Flatpaks that don't read ~/.config/gtk-* keep their own buttons. */

const BEGIN = '/* >>> Notchex macOS window buttons (managed by Notchex — edit in its preferences) >>> */';
const END = '/* <<< Notchex macOS window buttons <<< */';
const MAC_LAYOUT = 'close,minimize,maximize:';

const COLORS = {close: '#ff5f57', minimize: '#febc2e', maximize: '#28c840'};

const GTK4_CSS = `
windowcontrols { border-spacing: 8px; }
windowcontrols > button,
windowcontrols > button:hover,
windowcontrols > button:active {
    min-width: 14px; min-height: 14px;
    padding: 0; margin: 0;
    background: none; box-shadow: none; border: none;
}
windowcontrols > button > image {
    min-width: 14px; min-height: 14px;
    padding: 0;
    border-radius: 100%;
    -gtk-icon-size: 10px;
    color: transparent;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
}
windowcontrols > button.close > image { background-color: ${COLORS.close}; }
windowcontrols > button.minimize > image { background-color: ${COLORS.minimize}; }
windowcontrols > button.maximize > image { background-color: ${COLORS.maximize}; }
windowcontrols:hover > button > image { color: rgba(0, 0, 0, 0.55); }
windowcontrols > button:active > image { filter: brightness(0.85); }
windowcontrols > button:backdrop > image { background-color: alpha(currentColor, 0.18); color: transparent; }
`;

const GTK3_CSS = `
button.titlebutton.close,
button.titlebutton.minimize,
button.titlebutton.maximize {
    min-width: 14px; min-height: 14px;
    padding: 0; margin: 0 4px;
    border: none; border-radius: 100%;
    background-image: none;
    box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.12);
    color: transparent;
    -gtk-icon-shadow: none;
}
button.titlebutton.close { background-color: ${COLORS.close}; }
button.titlebutton.minimize { background-color: ${COLORS.minimize}; }
button.titlebutton.maximize { background-color: ${COLORS.maximize}; }
button.titlebutton.close:hover,
button.titlebutton.minimize:hover,
button.titlebutton.maximize:hover { color: rgba(0, 0, 0, 0.55); }
button.titlebutton.close:backdrop,
button.titlebutton.minimize:backdrop,
button.titlebutton.maximize:backdrop { background-color: rgba(128, 128, 128, 0.35); }
button.titlebutton image { -gtk-icon-transform: scale(0.65); }
`;

function cssPath(gtk) {
    return GLib.build_filenamev([GLib.get_user_config_dir(), gtk, 'gtk.css']);
}

function readText(path) {
    try {
        const [ok, bytes] = GLib.file_get_contents(path);
        return ok ? new TextDecoder().decode(bytes) : '';
    } catch (_) {
        return '';
    }
}

/* blocks written before the project was renamed from NexNotch */
const LEGACY_MARKERS = [[
    '/* >>> NexNotch macOS window buttons (managed by NexNotch — edit in its preferences) >>> */',
    '/* <<< NexNotch macOS window buttons <<< */',
]];

function stripOne(text, begin, end) {
    const a = text.indexOf(begin);
    const b = text.indexOf(end);
    if (a < 0 || b < a) return text;
    return (text.slice(0, a).replace(/\n+$/, '\n') + text.slice(b + end.length).replace(/^\n+/, '')).trimEnd() + '\n';
}

function stripBlock(text) {
    for (const [begin, end] of [[BEGIN, END], ...LEGACY_MARKERS])
        text = stripOne(text, begin, end);
    return text;
}

function writeCss(gtk, css) {
    const path = cssPath(gtk);
    let text = stripBlock(readText(path));
    if (css) text = `${text.trim() ? `${text.trimEnd()}\n\n` : ''}${BEGIN}\n${css.trim()}\n${END}\n`;
    if (!text.trim()) {
        /* we created this file and nothing else is in it: remove it */
        try { Gio.File.new_for_path(path).delete(null); } catch (_) {}
        return;
    }
    GLib.mkdir_with_parents(GLib.path_get_dirname(path), 0o755);
    GLib.file_set_contents(path, text);
}

export function isApplied() {
    return readText(cssPath('gtk-4.0')).includes(BEGIN) || readText(cssPath('gtk-3.0')).includes(BEGIN);
}

/* settings: Notchex settings (to remember the previous layout) */
export function applyMacWindowButtons(settings, enable) {
    const wm = new Gio.Settings({schema_id: 'org.gnome.desktop.wm.preferences'});
    if (enable) {
        const cur = wm.get_string('button-layout');
        if (cur !== MAC_LAYOUT) settings.set_string('saved-button-layout', cur);
        wm.set_string('button-layout', MAC_LAYOUT);
        writeCss('gtk-4.0', GTK4_CSS);
        writeCss('gtk-3.0', GTK3_CSS);
    } else {
        const saved = settings.get_string('saved-button-layout');
        if (wm.get_string('button-layout') === MAC_LAYOUT)
            wm.set_string('button-layout', saved || 'appmenu:minimize,maximize,close');
        writeCss('gtk-4.0', null);
        writeCss('gtk-3.0', null);
    }
    /* make sure dconf has the change before a short-lived caller exits */
    Gio.Settings.sync();
}
