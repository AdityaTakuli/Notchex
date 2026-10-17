import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {boxLayout} from './compat.js';
import {AppProvider, SettingsProvider, SystemProvider, CalculatorProvider, FileProvider} from './search-providers.js';

const DEBOUNCE_MS = 40;
const MAX_RESULTS = 9;
const PER_CATEGORY = 4;
const HISTORY_MAX = 8;
const CATEGORY_ORDER = ['Calculator', 'Applications', 'Settings', 'System', 'Files'];

/* Spotlight-style global search (Super+Space by default), shown inside
   the Dynamic Island: the notch grows into a wide search surface (the
   island hosts the view; see Notch.openSearch). Typing in the Overview
   opens it too, replacing GNOME's own search bar.

   Results come from a set of providers (apps, Settings panels, system
   actions, a calculator and — asynchronously — files via Nautilus' Tracker
   search provider). Typing is debounced, stale async searches are
   cancelled, and everything is keyboard driven: ↑/↓ move, Tab jumps
   between categories, Enter opens, Esc closes. */
export class Spotlight {
    constructor(settings, {icons, onLaunch, screenshot, host} = {}) {
        this._settings = settings;
        this._host = host;
        this._ctx = {screenshot};
        this._providers = {
            app: new AppProvider({icons, onLaunch}),
            settings: new SettingsProvider(),
            system: new SystemProvider(this._ctx),
            calculator: new CalculatorProvider(),
            file: new FileProvider(),
        };
        this._results = [];
        this._selected = 0;
        this._isOpen = false;
        this._gen = 0;
        this._settingsId = settings.connect('changed', (_s, key) => {
            if (key === 'search-enabled' || key === 'shortcut-search') this._syncKeybinding();
            if (key === 'search-enabled' || key === 'search-replace-overview') this._syncOverview();
        });
        this._syncKeybinding();
        this._syncOverview();
    }

    /* Typing in the Overview starts our search instead of GNOME's, and
       GNOME's "Type to search" bar is folded away. Restored on disable. */
    _syncOverview() {
        const want = this._settings.get_boolean('search-enabled') &&
            this._settings.get_boolean('search-replace-overview');
        const ctrl = Main.overview.searchController;
        const bin = Main.overview._overview?._controls?._searchEntryBin ?? null;
        if (want && ctrl && !this._origStartSearch) {
            this._origStartSearch = ctrl.startSearch;
            const self = this;
            ctrl.startSearch = function (event) {
                const ch = event?.get_key_unicode?.() ?? '';
                self.open(/\S/.test(ch) ? ch : '');
            };
            if (bin) {
                this._overviewBin = bin;
                bin.hide();
                bin.set_height(0);
            }
        } else if (!want && this._origStartSearch) {
            if (ctrl) ctrl.startSearch = this._origStartSearch;
            this._origStartSearch = null;
            this._overviewBin?.set_height(-1);
            this._overviewBin?.show();
            this._overviewBin = null;
        }
    }

    destroy() {
        this.close(true);
        this._unbind();
        if (this._origStartSearch) {
            const ctrl = Main.overview.searchController;
            if (ctrl) ctrl.startSearch = this._origStartSearch;
            this._origStartSearch = null;
            this._overviewBin?.set_height(-1);
            this._overviewBin?.show();
            this._overviewBin = null;
        }
        if (this._settingsId) this._settings.disconnect(this._settingsId);
        this._settingsId = 0;
        if (this._debounce) GLib.source_remove(this._debounce);
        this._debounce = 0;
        this._view?.destroy();
        this._view = null;
    }

    _syncKeybinding() {
        this._unbind();
        if (!this._settings.get_boolean('search-enabled')) return;
        try {
            Main.wm.addKeybinding('shortcut-search', this._settings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW, () => this.toggle());
            this._bound = true;
        } catch (e) { logError(e, 'notchex:search:keybinding'); }
    }

    _unbind() {
        if (!this._bound) return;
        try { Main.wm.removeKeybinding('shortcut-search'); } catch (_) {}
        this._bound = false;
    }

    toggle() {
        if (this._isOpen) this.close();
        else this.open();
    }

    /* ——— UI ——— */

    _build() {
        if (this._view) return;
        this._view = boxLayout({vertical: true, style_class: 'notchex-search-view', x_expand: true});

        this._entry = new St.Entry({
            style_class: 'notchex-spotlight-entry',
            hint_text: 'Search apps, files, settings…',
            can_focus: true,
            x_expand: true,
            primary_icon: new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'notchex-spotlight-search-icon'}),
        });
        this._view.add_child(this._entry);
        const text = this._entry.clutter_text;
        text.connect('text-changed', () => this._queueSearch());
        text.connect('key-press-event', (_a, event) => this._onKey(event));
        text.connect('activate', () => this._activateSelected());

        this._list = boxLayout({vertical: true, style_class: 'notchex-spotlight-results'});
        this._view.add_child(this._list);
    }

    open(initialText = '') {
        if (this._isOpen) {
            if (initialText) this._entry.text += initialText;
            return;
        }
        this._build();
        this._entry.text = '';
        this._list.destroy_all_children();
        this._results = [];
        if (!this._host?.openSearch(this._view, () => this.close())) return;
        this._isOpen = true;
        if (initialText) {
            this._entry.text = initialText;
            this._entry.clutter_text.set_cursor_position(-1);
        } else {
            this._render(this._historyResults(), true);
        }
        this._entry.grab_key_focus();
    }

    close(immediate = false) {
        if (!this._isOpen) return;
        this._isOpen = false;
        this._gen++;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._debounce) { GLib.source_remove(this._debounce); this._debounce = 0; }
        this._host?.closeSearch(immediate);
    }

    /* ——— search ——— */

    _queueSearch() {
        if (this._debounce) GLib.source_remove(this._debounce);
        this._debounce = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DEBOUNCE_MS, () => {
            this._debounce = 0;
            this._search(this._entry.text.trim());
            return GLib.SOURCE_REMOVE;
        });
    }

    _search(query) {
        const gen = ++this._gen;
        this._cancellable?.cancel();
        this._cancellable = null;
        if (!query) {
            this._render(this._historyResults(), true);
            return;
        }
        let results = [];
        for (const key of ['calculator', 'app', 'settings', 'system']) {
            try { results.push(...this._providers[key].search(query)); } catch (e) { logError(e, `notchex:search:${key}`); }
        }
        this._render(results);

        if (this._settings.get_boolean('search-files') && query.length >= 3) {
            this._cancellable = new Gio.Cancellable();
            this._providers.file.search(query, this._cancellable).then(files => {
                if (gen !== this._gen || !this._isOpen || !files.length) return;
                results = results.concat(files);
                this._render(results, false, true);
            }).catch(() => {});
        }
    }

    /* Rank, keep a few per category, show the best as "Top Hit". */
    _arrange(results) {
        results.sort((a, b) => b.score - a.score);
        const out = [];
        const seen = new Set();
        const top = results[0];
        if (top) {
            out.push({...top, header: top.kind === 'calculator' ? 'Calculator' : 'Top Hit'});
            seen.add(`${top.kind}:${top.id}`);
        }
        for (const cat of CATEGORY_ORDER) {
            const inCat = results.filter(r => r.category === cat && !seen.has(`${r.kind}:${r.id}`))
                .slice(0, PER_CATEGORY);
            inCat.forEach((r, i) => {
                seen.add(`${r.kind}:${r.id}`);
                out.push(i === 0 ? {...r, header: cat} : r);
            });
        }
        return out.slice(0, MAX_RESULTS);
    }

    _render(results, isHistory = false, keepSelection = false) {
        const prevId = keepSelection ? this._results[this._selected]?.id : null;
        this._results = isHistory
            ? results.map((r, i) => (i === 0 ? {...r, header: 'Recent'} : r))
            : this._arrange(results);
        this._list.destroy_all_children();
        const query = this._entry.text.trim();
        if (!this._results.length) {
            if (query) {
                this._list.add_child(new St.Label({text: 'No Results', style_class: 'notchex-spotlight-empty',
                    x_align: Clutter.ActorAlign.CENTER}));
            }
            this._list.visible = !!query;
            this._host?.resizeSearch();
            return;
        }
        this._list.visible = true;
        this._rows = this._results.map((r, i) => {
            if (r.header) this._list.add_child(new St.Label({text: r.header, style_class: 'notchex-spotlight-header'}));
            const row = new St.Button({style_class: 'notchex-spotlight-row', can_focus: false,
                reactive: true, track_hover: true, x_expand: true});
            const box = boxLayout({style_class: 'notchex-spotlight-row-box', x_expand: true});
            box.add_child(new St.Icon({gicon: r.gicon, icon_size: r.kind === 'app' ? 30 : 24,
                style_class: 'notchex-spotlight-icon', y_align: Clutter.ActorAlign.CENTER}));
            const col = boxLayout({vertical: true, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
            const title = new St.Label({text: r.title, style_class: 'notchex-spotlight-title'});
            title.clutter_text.ellipsize = 3;
            col.add_child(title);
            if (r.subtitle) {
                const sub = new St.Label({text: r.subtitle, style_class: 'notchex-spotlight-subtitle'});
                sub.clutter_text.ellipsize = 3;
                col.add_child(sub);
            }
            box.add_child(col);
            row.set_child(box);
            row.connect('clicked', () => {
                this._selected = i;
                this._activateSelected();
            });
            row.connect('notify::hover', () => { if (row.hover) this._select(i); });
            this._list.add_child(row);
            return row;
        });
        const keep = prevId ? this._results.findIndex(r => r.id === prevId) : -1;
        this._select(keep >= 0 ? keep : 0);
        this._host?.resizeSearch();
    }

    _select(i) {
        if (!this._rows?.length) return;
        this._selected = (i + this._rows.length) % this._rows.length;
        this._rows.forEach((row, j) => {
            if (j === this._selected) row.add_style_pseudo_class('selected');
            else row.remove_style_pseudo_class('selected');
        });
    }

    _onKey(event) {
        const sym = event.get_key_symbol();
        if (sym === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Down) {
            this._select(this._selected + 1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Up) {
            this._select(this._selected - 1);
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Tab || sym === Clutter.KEY_ISO_Left_Tab) {
            /* jump to the first result of the next/previous category */
            const back = sym === Clutter.KEY_ISO_Left_Tab;
            const heads = this._results.map((r, i) => (r.header ? i : -1)).filter(i => i >= 0);
            if (heads.length) {
                const cur = heads.filter(h => h <= this._selected).pop() ?? 0;
                const idx = heads.indexOf(cur);
                this._select(heads[(idx + (back ? -1 : 1) + heads.length) % heads.length]);
            }
            return Clutter.EVENT_STOP;
        }
        if (sym === Clutter.KEY_Return || sym === Clutter.KEY_KP_Enter || sym === Clutter.KEY_ISO_Enter) {
            this._activateSelected();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    _activateSelected() {
        const r = this._results[this._selected];
        if (!r) return;
        this._remember(r);
        this.close();
        /* run after the modal grab is gone so launched apps / dialogs get focus */
        GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            try { r.activate(); } catch (e) { logError(e, 'notchex:search:activate'); }
            return GLib.SOURCE_REMOVE;
        });
    }

    /* ——— history ——— */

    _remember(r) {
        if (r.noHistory || !this._settings.get_boolean('search-remember-history')) return;
        const entry = JSON.stringify({kind: r.kind, id: r.id, title: r.title});
        const list = this._settings.get_strv('search-history').filter(e => {
            try {
                const o = JSON.parse(e);
                return !(o.kind === r.kind && o.id === r.id);
            } catch (_) { return false; }
        });
        this._settings.set_strv('search-history', [entry, ...list].slice(0, HISTORY_MAX));
    }

    _historyResults() {
        if (!this._settings.get_boolean('search-remember-history')) return [];
        const out = [];
        for (const e of this._settings.get_strv('search-history')) {
            try {
                const o = JSON.parse(e);
                const provider = this._providers[o.kind];
                const r = provider?.lookup?.(o.id, o.title);
                if (r) out.push(r);
            } catch (_) {}
        }
        return out;
    }
}
