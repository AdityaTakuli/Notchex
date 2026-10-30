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
            if (key === 'search-enabled' || key === 'notch-enabled' || key === 'shortcut-search') this._syncKeybinding();
            if (key === 'search-enabled' || key === 'notch-enabled' || key === 'search-replace-overview') this._syncOverview();
        });
        this._syncKeybinding();
        this._syncOverview();
    }

    /* Typing in the Overview starts our search instead of GNOME's, and
       GNOME's "Type to search" bar is folded away. Restored on disable. */
    _syncOverview() {
        const want = this._enabled() &&
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
        this._panel?.destroy();
        this._panel = null;
    }

    /* Spotlight draws inside the notch, so it needs the notch to be on. */
    _enabled() {
        return this._settings.get_boolean('search-enabled') &&
            this._settings.get_boolean('notch-enabled');
    }

    _syncKeybinding() {
        this._unbind();
        if (!this._enabled()) return;
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

    /* Two surfaces, like Spotlight in the macOS Dynamic Island: the
       island holds just the search line (with inline completion and the
       top hit's icon), and the results float below it in a separate
       frosted-glass panel that the notch hosts. */
    _build() {
        if (this._view) return;
        this._view = boxLayout({style_class: 'notchex-spot-bar', x_expand: true});
        this._view.add_child(new St.Icon({icon_name: 'edit-find-symbolic', style_class: 'notchex-spot-search-icon',
            y_align: Clutter.ActorAlign.CENTER}));

        this._entry = new St.Entry({
            style_class: 'notchex-spot-entry',
            hint_text: 'Spotlight Search',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        /* typed text and the greyed rest of the top hit's name, with no gap */
        const phrase = boxLayout({style_class: 'notchex-spot-phrase', y_align: Clutter.ActorAlign.CENTER});
        phrase.add_child(this._entry);
        this._ghost = new St.Label({style_class: 'notchex-spot-ghost', y_align: Clutter.ActorAlign.CENTER});
        phrase.add_child(this._ghost);
        this._view.add_child(phrase);
        this._view.add_child(new St.Widget({x_expand: true}));
        this._topIcon = new St.Icon({icon_size: 30, style_class: 'notchex-spot-top-icon', visible: false,
            y_align: Clutter.ActorAlign.CENTER});
        this._view.add_child(this._topIcon);

        const text = this._entry.clutter_text;
        text.connect('text-changed', () => { this._fitEntry(); this._queueSearch(); });
        text.connect('key-press-event', (_a, event) => this._onKey(event));
        text.connect('activate', () => this._activateSelected());

        this._panel = boxLayout({vertical: true, style_class: 'notchex-spot-panel', visible: false});
        this._chips = boxLayout({style_class: 'notchex-spot-chips'});
        this._panel.add_child(this._chips);
        this._list = boxLayout({vertical: true, style_class: 'notchex-spotlight-results'});
        this._panel.add_child(this._list);
    }

    open(initialText = '') {
        if (this._isOpen) {
            if (initialText) this._entry.text += initialText;
            return;
        }
        this._build();
        this._entry.text = '';
        this._ghost.text = '';
        this._topIcon.hide();
        this._list.destroy_all_children();
        this._chips.destroy_all_children();
        this._results = [];
        if (!this._host?.openSearch(this._view, () => this.close(), this._panel)) return;
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
        const query = this._entry.text.trim();
        let arranged = isHistory
            ? results.map((r, i) => (i === 0 ? {...r, header: 'Recent'} : r))
            : this._arrange(results);

        /* apps (beyond the top hit) become chips across the top of the panel */
        const top = arranged[0] ?? null;
        const chipApps = isHistory ? [] : results
            .filter(r => r.kind === 'app' && r !== top && r.id !== top?.id)
            .sort((x, y) => y.score - x.score).slice(0, 3);
        const chipIds = new Set(chipApps.map(r => r.id));
        if (chipApps.length) {
            arranged = arranged.filter((r, i) => i === 0 || !(r.kind === 'app' && chipIds.has(r.id)));
            /* keep a header on the first row of each category */
            let lastCat = null;
            arranged = arranged.map((r, i) => {
                if (i === 0) return r;
                const {header: _h, ...rest} = r;
                if (r.category !== lastCat) { lastCat = r.category; return {...rest, header: r.category}; }
                return rest;
            });
        }
        this._results = arranged;
        this._renderBar(query, top);
        this._renderChips(chipApps);

        this._list.destroy_all_children();
        this._rows = [];
        if (!this._results.length) {
            if (query) {
                this._list.add_child(new St.Label({text: 'No Results', style_class: 'notchex-spotlight-empty',
                    x_align: Clutter.ActorAlign.CENTER}));
            }
            this._panel.visible = !!query || chipApps.length > 0;
            this._host?.resizeSearch();
            return;
        }
        this._panel.visible = true;
        this._rows = this._results.map((r, i) => {
            if (r.header) this._list.add_child(new St.Label({text: r.header, style_class: 'notchex-spotlight-header'}));
            const row = new St.Button({style_class: 'notchex-spotlight-row', can_focus: false,
                reactive: true, track_hover: true, x_expand: true});
            const box = boxLayout({style_class: 'notchex-spotlight-row-box', x_expand: true});
            box.add_child(new St.Icon({gicon: r.gicon, icon_size: r.kind === 'app' ? 32 : 26,
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
            /* what Enter does, shown on the selected row */
            const hint = boxLayout({style_class: 'notchex-spot-hint', y_align: Clutter.ActorAlign.CENTER});
            hint.add_child(new St.Label({text: r.kind === 'calculator' ? 'Copy' : 'Open',
                style_class: 'notchex-spot-hint-text', y_align: Clutter.ActorAlign.CENTER}));
            hint.add_child(new St.Label({text: '↵', style_class: 'notchex-spot-key', y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(hint);
            row._hint = hint;
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

    /* the entry hugs what's typed so the completion reads as one phrase
       ("tide pool" + "s — Open"); empty, it shows the full hint */
    _fitEntry() {
        const text = this._entry.clutter_text;
        if (!this._entry.text) {
            this._entry.width = -1;
            return;
        }
        const [w] = text.get_layout().get_pixel_size();
        this._entry.width = w + 4;
    }

    /* the island's line: inline completion of the top hit, its icon on the right */
    _renderBar(query, top) {
        this._completion = null;
        let ghost = '';
        if (query && top) {
            if (top.kind === 'calculator') {
                ghost = `  ${top.title}`;
            } else if (top.title.toLowerCase().startsWith(query.toLowerCase())) {
                this._completion = top.title;
                ghost = `${top.title.slice(query.length)} — Open`;
            } else {
                ghost = `  — ${top.title}`;
            }
        }
        this._ghost.text = ghost;
        if (top?.gicon && query) {
            this._topIcon.gicon = top.gicon;
            this._topIcon.show();
        } else {
            this._topIcon.hide();
        }
    }

    _renderChips(apps) {
        this._chips.destroy_all_children();
        this._chips.visible = apps.length > 0;
        for (const r of apps) {
            const chip = new St.Button({style_class: 'notchex-spot-chip', can_focus: false, reactive: true,
                track_hover: true, accessible_name: r.title});
            const box = boxLayout({style_class: 'notchex-spot-chip-box'});
            box.add_child(new St.Icon({gicon: r.gicon, icon_size: 18, y_align: Clutter.ActorAlign.CENTER}));
            box.add_child(new St.Label({text: r.title, y_align: Clutter.ActorAlign.CENTER}));
            chip.set_child(box);
            chip.connect('clicked', () => this._activate(r));
            this._chips.add_child(chip);
        }
    }

    _select(i) {
        if (!this._rows?.length) return;
        this._selected = (i + this._rows.length) % this._rows.length;
        this._rows.forEach((row, j) => {
            const on = j === this._selected;
            if (on) row.add_style_pseudo_class('selected');
            else row.remove_style_pseudo_class('selected');
            row._hint.opacity = on ? 255 : 0;
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
        /* Tab or → at the end takes the inline completion */
        const atEnd = this._entry.clutter_text.get_cursor_position() === -1 ||
            this._entry.clutter_text.get_cursor_position() === this._entry.text.length;
        if (this._completion && atEnd &&
            (sym === Clutter.KEY_Tab || sym === Clutter.KEY_Right) &&
            this._completion.toLowerCase() !== this._entry.text.toLowerCase()) {
            this._entry.text = this._completion;
            this._entry.clutter_text.set_cursor_position(-1);
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
        this._activate(this._results[this._selected]);
    }

    _activate(r) {
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
