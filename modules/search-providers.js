import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {launchContext} from './compat.js';

/* Unified ranking: how well the query matches the title dominates; the
   provider bonus only breaks ties between similar matches. */
export const Bonus = {app: 30, system: 26, settings: 20, file: 5};

/* Spotlight providers. Each returns results shaped as
     {id, kind, category, title, subtitle, gicon, score, activate()}
   `score` ranks across providers (exact > prefix > word > substring,
   plus provider priority); only the Spotlight UI sorts and groups. */

export function matchScore(query, text) {
    if (!text) return 0;
    const q = query.toLowerCase();
    const t = text.toLowerCase();
    if (t === q) return 100;
    if (t.startsWith(q)) return 80;
    if (t.split(/[\s\-_.]+/).some(w => w.startsWith(q))) return 60;
    if (t.includes(q)) return 40;
    return 0;
}

function spawn(argv) {
    const path = GLib.find_program_in_path(argv[0]);
    if (!path) return;
    try {
        Gio.Subprocess.new([path, ...argv.slice(1)], Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) { logError(e, 'notchex:search'); }
}

/* ——— applications ——— */

export class AppProvider {
    constructor({icons, onLaunch}) {
        this._icons = icons;
        this._onLaunch = onLaunch;
        this._appSys = Shell.AppSystem.get_default();
    }

    resultFor(app, score = 0) {
        let subtitle = 'Application';
        const wins = app.get_windows().filter(w => !w.skip_taskbar);
        if (app.state === Shell.AppState.RUNNING && wins.length) {
            const ws = wins[0].get_workspace()?.index();
            subtitle = ws === undefined ? 'Running' : `Running · Workspace ${ws + 1}`;
        } else {
            const desc = app.get_description?.();
            if (desc) subtitle = desc.split('\n')[0];
        }
        return {
            id: app.get_id(),
            kind: 'app',
            category: 'Applications',
            title: app.get_name(),
            subtitle,
            gicon: this._icons?.getAppIcon(app).gicon ?? app.get_icon(),
            score,
            activate: () => {
                const running = app.state === Shell.AppState.RUNNING;
                app.activate();
                if (!running) this._onLaunch?.(app);
            },
        };
    }

    lookup(id) {
        const app = this._appSys.lookup_app(id);
        return app ? this.resultFor(app) : null;
    }

    search(query) {
        /* GNOME's own app search (names, keywords, executables), grouped
           best-first; refine with our own name match */
        const groups = Shell.AppSystem.search(query);
        const out = [];
        groups.forEach((ids, g) => {
            ids.forEach((id, i) => {
                /* Settings panels are apps too; SettingsProvider owns them */
                if (/^gnome-.*-panel\.desktop$/.test(id)) return;
                const app = this._appSys.lookup_app(id);
                if (!app) return;
                const name = matchScore(query, app.get_name());
                /* keyword-only matches still rank by GNOME's own grouping */
                const fallback = Math.max(0, 25 - g * 6) - i * 0.5;
                out.push(this.resultFor(app, name * 3 + Bonus.app + fallback));
            });
        });
        return out.slice(0, 12);
    }
}

/* ——— GNOME Settings panels ——— */

export class SettingsProvider {
    constructor() {
        this._panels = null;
    }

    _load() {
        if (this._panels) return this._panels;
        this._panels = Gio.AppInfo.get_all()
            .filter(info => /^gnome-.*-panel\.desktop$/.test(info.get_id() ?? ''))
            .map(info => ({info, keywords: info.get_keywords?.() ?? []}));
        return this._panels;
    }

    _result(p, score) {
        return {
            id: p.info.get_id(),
            kind: 'settings',
            category: 'Settings',
            title: p.info.get_name(),
            subtitle: 'Settings',
            gicon: p.info.get_icon(),
            score,
            activate: () => {
                try { p.info.launch([], launchContext()); } catch (e) { logError(e, 'notchex:search'); }
            },
        };
    }

    lookup(id) {
        const p = this._load().find(x => x.info.get_id() === id);
        return p ? this._result(p, 0) : null;
    }

    search(query) {
        const out = [];
        for (const p of this._load()) {
            const s = Math.max(matchScore(query, p.info.get_name()),
                ...p.keywords.map(k => matchScore(query, k) * 0.85));
            if (s >= 40) out.push(this._result(p, s * 3 + Bonus.settings));
        }
        return out;
    }
}

/* ——— system actions ——— */

const SYSTEM_ACTIONS = [
    {id: 'lock', title: 'Lock Screen', icon: 'system-lock-screen-symbolic', words: ['lock', 'lock screen'],
        run: () => spawn(['loginctl', 'lock-session'])},
    {id: 'suspend', title: 'Suspend', icon: 'media-playback-pause-symbolic', words: ['suspend', 'sleep'],
        run: () => spawn(['systemctl', 'suspend'])},
    /* restart / shut down / log out go through GNOME's confirmation dialog */
    {id: 'restart', title: 'Restart…', icon: 'system-reboot-symbolic', words: ['restart', 'reboot'],
        run: () => spawn(['gnome-session-quit', '--reboot'])},
    {id: 'shutdown', title: 'Shut Down…', icon: 'system-shutdown-symbolic', words: ['shutdown', 'shut down', 'power off', 'poweroff'],
        run: () => spawn(['gnome-session-quit', '--power-off'])},
    {id: 'logout', title: 'Log Out…', icon: 'system-log-out-symbolic', words: ['log out', 'logout', 'sign out'],
        run: () => spawn(['gnome-session-quit', '--logout'])},
    {id: 'screenshot', title: 'Take Screenshot', icon: 'camera-photo-symbolic', words: ['screenshot', 'screen shot', 'capture'],
        run: ctx => ctx.screenshot?.()},
    {id: 'screenshot-ui', title: 'Screenshot Area or Window…', icon: 'camera-photo-symbolic', words: ['screenshot', 'screen shot', 'capture', 'area'],
        run: () => Main.screenshotUI?.open()},
    {id: 'settings', title: 'Settings', icon: 'emblem-system-symbolic', words: ['settings', 'preferences', 'control center'],
        run: () => spawn(['gnome-control-center'])},
    {id: 'notchex', title: 'Notchex Settings', icon: 'preferences-desktop-apps-symbolic', words: ['notchex', 'dock settings', 'island'],
        run: () => Main.extensionManager.openExtensionPrefs('notchex@adityatakuli', '', {})},
];

export class SystemProvider {
    constructor(ctx) {
        this._ctx = ctx;
    }

    _result(a, score) {
        return {
            id: a.id,
            kind: 'system',
            category: 'System',
            title: a.title,
            subtitle: 'System action',
            gicon: Gio.ThemedIcon.new(a.icon),
            score,
            activate: () => a.run(this._ctx),
        };
    }

    lookup(id) {
        const a = SYSTEM_ACTIONS.find(x => x.id === id);
        return a ? this._result(a, 0) : null;
    }

    search(query) {
        const out = [];
        for (const a of SYSTEM_ACTIONS) {
            const s = Math.max(matchScore(query, a.title), ...a.words.map(w => matchScore(query, w)));
            if (s >= 60) out.push(this._result(a, s * 3 + Bonus.system));
        }
        return out;
    }
}

/* ——— calculator ——— */

/* A small recursive-descent evaluator — no eval(). Supports + - * / % ^,
   parentheses, unary minus, pi/e and a few functions. */
function evaluate(src) {
    const tokens = src.toLowerCase().replace(/×/g, '*').replace(/÷/g, '/')
        .match(/\d+(\.\d+)?(e[+-]?\d+)?|\.\d+|[a-z]+|[-+*/%^()]/g);
    if (!tokens || tokens.join('') !== src.toLowerCase().replace(/\s+/g, '').replace(/×/g, '*').replace(/÷/g, '/'))
        return null;
    let pos = 0;
    const peek = () => tokens[pos];
    const next = () => tokens[pos++];
    const FUNCS = {sqrt: Math.sqrt, sin: Math.sin, cos: Math.cos, tan: Math.tan, abs: Math.abs,
        log: Math.log10, ln: Math.log, round: Math.round, floor: Math.floor, ceil: Math.ceil};
    const CONSTS = {pi: Math.PI, e: Math.E};
    const expr = () => {
        let v = term();
        while (peek() === '+' || peek() === '-') v = next() === '+' ? v + term() : v - term();
        return v;
    };
    const term = () => {
        let v = power();
        while (['*', '/', '%'].includes(peek())) {
            const op = next();
            const r = power();
            v = op === '*' ? v * r : op === '/' ? v / r : v % r;
        }
        return v;
    };
    const power = () => {
        const b = unary();
        return peek() === '^' ? (next(), b ** power()) : b;
    };
    const unary = () => {
        if (peek() === '-') { next(); return -unary(); }
        if (peek() === '+') { next(); return unary(); }
        return atom();
    };
    const atom = () => {
        const t = next();
        if (t === undefined) throw new Error('eof');
        if (t === '(') {
            const v = expr();
            if (next() !== ')') throw new Error('paren');
            return v;
        }
        if (/^[\d.]/.test(t)) return Number(t);
        if (t in CONSTS) return CONSTS[t];
        if (t in FUNCS) {
            if (next() !== '(') throw new Error('call');
            const v = expr();
            if (next() !== ')') throw new Error('paren');
            return FUNCS[t](v);
        }
        throw new Error(`unexpected ${t}`);
    };
    try {
        const v = expr();
        return pos === tokens.length && Number.isFinite(v) ? v : null;
    } catch (_) {
        return null;
    }
}

export class CalculatorProvider {
    search(query) {
        const q = query.replace(/^=/, '').trim();
        /* needs an operator or function, not just a number */
        if (!/\d/.test(q) || !/[-+*/%^()×÷]|sqrt|sin|cos|tan|log|ln|abs/.test(q)) return [];
        const v = evaluate(q);
        if (v === null) return [];
        const text = Number.isInteger(v) ? String(v) : String(Number(v.toPrecision(12)));
        return [{
            id: `calc:${q}`,
            kind: 'calculator',
            category: 'Calculator',
            title: text,
            subtitle: `${q} =  ·  Enter copies the result`,
            gicon: Gio.ThemedIcon.new('accessories-calculator-symbolic'),
            score: 1000,
            noHistory: true,
            activate: () => {
                St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
            },
        }];
    }
}

/* ——— files (via Nautilus' search provider, which uses the Tracker index) ——— */

const SEARCH_PROVIDER_XML = `
<node>
  <interface name="org.gnome.Shell.SearchProvider2">
    <method name="GetInitialResultSet">
      <arg type="as" direction="in"/><arg type="as" direction="out"/>
    </method>
    <method name="GetResultMetas">
      <arg type="as" direction="in"/><arg type="aa{sv}" direction="out"/>
    </method>
  </interface>
</node>`;
const SearchProviderProxy = Gio.DBusProxy.makeProxyWrapper(SEARCH_PROVIDER_XML);

export class FileProvider {
    constructor() {
        this._proxy = null;
    }

    _getProxy() {
        this._proxy ??= new SearchProviderProxy(Gio.DBus.session, 'org.gnome.Nautilus',
            '/org/gnome/Nautilus/SearchProvider', null, null,
            Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES | Gio.DBusProxyFlags.DO_NOT_CONNECT_SIGNALS);
        return this._proxy;
    }

    _result(id, meta, score) {
        const unpack = v => (v && typeof v.deepUnpack === 'function' ? v.deepUnpack() : v);
        let gicon = null;
        try {
            if (meta.icon) gicon = Gio.icon_deserialize(meta.icon);
            else if (meta.gicon) gicon = Gio.icon_new_for_string(unpack(meta.gicon));
        } catch (_) {}
        const name = unpack(meta.name) ?? id;
        let desc = unpack(meta.description) ?? '';
        try {
            if (!desc && id.startsWith('file://')) desc = GLib.path_get_dirname(Gio.File.new_for_uri(id).get_path());
        } catch (_) {}
        return {
            id,
            kind: 'file',
            category: 'Files',
            title: name,
            subtitle: desc.replace(GLib.get_home_dir(), '~'),
            gicon: gicon ?? Gio.ThemedIcon.new('text-x-generic'),
            score,
            activate: () => {
                try { Gio.AppInfo.launch_default_for_uri(id, launchContext()); } catch (e) { logError(e, 'notchex:search'); }
            },
        };
    }

    lookup(id, title) {
        if (!id.startsWith('file://')) return null;
        const f = Gio.File.new_for_uri(id);
        if (!f.query_exists(null)) return null;
        return this._result(id, {name: title ?? f.get_basename()}, 0);
    }

    /* async; resolves to results (at most 5) */
    async search(query, cancellable) {
        if (query.length < 3) return [];
        const terms = query.split(/\s+/).filter(Boolean);
        const proxy = this._getProxy();
        const [ids] = await proxy.GetInitialResultSetAsync(terms, cancellable);
        const top = ids.slice(0, 5);
        if (!top.length) return [];
        const [metas] = await proxy.GetResultMetasAsync(top, cancellable);
        return metas.map((m, i) => {
            const id = m.id?.deepUnpack?.() ?? top[i];
            const r = this._result(id, m, 0);
            r.score = matchScore(query, r.title) * 2 + Bonus.file - i;
            return r;
        });
    }
}
