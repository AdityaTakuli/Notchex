import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

/* macOS-style frosted glass ("vibrancy") for shell surfaces.

   GNOME 46's Shell.BlurEffect can blur what's behind an actor, but only
   as a rectangle — there is no corner radius, so rounded menus would get
   square smudges at the corners. Instead each surface gets a GlassLayer:
   a sibling placed right below it that holds a clone of the windows,
   blurred, then masked to the surface's rounded shape by a small shader.
   The surface itself keeps only a translucent tint (stylesheet), so the
   result is blur + tint + hairline border like macOS.

   Privacy: the clone never paints while windows are hidden (lock screen,
   no-windows session modes) — the surface falls back to a solid tint. */

const SNIPPET_FRAGMENT = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;

const MASK_DECL = `
uniform vec3 nn_bounds;
float nn_rbox(vec2 p, vec2 b, float r) {
    vec2 q = abs(p) - b + vec2(r);
    return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
}`;
const MASK_CODE = `
vec2 nn_p = cogl_tex_coord_in[0].xy * nn_bounds.xy;
float nn_d = nn_rbox(nn_p - nn_bounds.xy * 0.5, nn_bounds.xy * 0.5, nn_bounds.z);
cogl_color_out *= clamp(0.5 - nn_d, 0.0, 1.0);`;

const RoundedMask = GObject.registerClass(
class NotchexRoundedMask extends Shell.GLSLEffect {
    vfunc_build_pipeline() {
        this.add_glsl_snippet(SNIPPET_FRAGMENT, MASK_DECL, MASK_CODE, false);
    }

    setBounds(w, h, r) {
        if (this._w === w && this._h === h && this._r === r) return;
        this._w = w; this._h = h; this._r = r;
        this.set_uniform_float(this.get_uniform_location('nn_bounds'), 3, [w, h, Math.min(r, w / 2, h / 2)]);
        this.queue_repaint();
    }
});

/* Mirror of the window group (wallpaper + windows) built from one clone
   per child. Mutter's MetaWindowGroup paints nothing when it is cloned as
   a whole, but its children clone fine (it's how the Overview and window
   previews work). Shared by every GlassLayer; kept in step with windows
   moving, restacking, fading, minimizing, opening and closing. Lives in
   the stage at opacity 0 so it gets laid out but never drawn itself —
   a clone draws its source at the clone's own opacity. */
const SOURCE_PROPS = ['x', 'y', 'visible', 'opacity', 'translation-x', 'translation-y', 'scale-x', 'scale-y'];

class WindowMirror {
    static acquire() {
        WindowMirror._instance ??= new WindowMirror();
        WindowMirror._instance._refs++;
        return WindowMirror._instance;
    }

    static release() {
        const m = WindowMirror._instance;
        if (m && --m._refs <= 0) {
            m._destroy();
            WindowMirror._instance = null;
        }
    }

    constructor() {
        this._refs = 0;
        this._entries = new Map(); /* source actor → {clone, ids} */
        this.actor = new Clutter.Actor({name: 'notchexWindowMirror', opacity: 0, reactive: false});
        Main.layoutManager.uiGroup.insert_child_at_index(this.actor, 0);
        const wg = global.window_group;
        this._wgIds = [
            wg.connect('child-added', () => this._queueRebuild()),
            wg.connect('child-removed', () => this._queueRebuild()),
        ];
        this._restackId = global.display.connect('restacked', () => this._queueRebuild());
        this._rebuild();
    }

    _destroy() {
        const l = laters();
        if (this._later && l) l.remove(this._later);
        this._later = 0;
        for (const id of this._wgIds) global.window_group.disconnect(id);
        global.display.disconnect(this._restackId);
        for (const source of [...this._entries.keys()]) this._drop(source);
        this.actor.destroy();
        this.actor = null;
    }

    _queueRebuild() {
        if (this._later || !this.actor) return;
        const l = laters();
        if (!l) { this._rebuild(); return; }
        this._later = l.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            this._rebuild();
            return false;
        });
    }

    _rebuild() {
        if (!this.actor) return;
        const kids = global.window_group.get_children();
        const live = new Set(kids);
        for (const source of [...this._entries.keys()]) {
            if (!live.has(source)) this._drop(source);
        }
        kids.forEach((source, i) => {
            let e = this._entries.get(source);
            if (!e) {
                const clone = new Clutter.Clone({source, reactive: false});
                const ids = SOURCE_PROPS.map(p => source.connect(`notify::${p}`, () => this._syncClone(source)));
                ids.push(source.connect('destroy', () => this._drop(source)));
                e = {clone, ids};
                this._entries.set(source, e);
                this.actor.add_child(clone);
                this._syncClone(source);
            }
            if (this.actor.get_child_at_index(i) !== e.clone) this.actor.set_child_at_index(e.clone, i);
        });
    }

    _drop(source) {
        const e = this._entries.get(source);
        if (!e) return;
        this._entries.delete(source);
        for (const id of e.ids) {
            try { source.disconnect(id); } catch (_) {}
        }
        e.clone.destroy();
    }

    _syncClone(source) {
        const e = this._entries.get(source);
        if (!e) return;
        const c = e.clone;
        c.visible = source.visible;
        c.opacity = source.opacity;
        c.set_position(source.x, source.y);
        c.set_pivot_point(...source.get_pivot_point());
        c.set_translation(source.translation_x, source.translation_y, 0);
        c.set_scale(source.scale_x, source.scale_y);
    }
}

const WATCHED = ['allocation', 'translation-x', 'translation-y', 'scale-x', 'scale-y', 'opacity', 'visible'];

function laters() {
    return global.compositor?.get_laters?.() ?? null;
}

/* Frosted backdrop for one surface. `target` is the actor that paints the
   (translucent, rounded) background; the layer is inserted into `parent`
   just below `below`, and follows the target through every move, resize
   and fade by watching the actors between the two. */
export class GlassLayer {
    constructor(target, {parent, below, blur = 30, brightness = 1.0}) {
        this._target = target;
        this._parent = parent;
        this._pad = blur;
        this._later = 0;

        this.actor = new St.Widget({
            name: 'notchexGlass',
            reactive: false,
            clip_to_allocation: true,
            visible: false,
            x_align: Clutter.ActorAlign.START,
            y_align: Clutter.ActorAlign.START,
        });
        this._mask = new RoundedMask();
        this.actor.add_effect_with_name('notchex-glass-mask', this._mask);

        this._blurBox = new St.Widget({clip_to_allocation: true});
        this._blur = new Shell.BlurEffect({mode: Shell.BlurMode.ACTOR, radius: blur, brightness});
        this._blurBox.add_effect_with_name('notchex-glass-blur', this._blur);
        this._mirror = WindowMirror.acquire();
        this._clone = new Clutter.Clone();
        this._blurBox.add_child(this._clone);
        this.actor.add_child(this._blurBox);

        if (below?.get_parent() === parent) parent.insert_child_below(this.actor, below);
        else parent.add_child(this.actor);

        /* every actor from the target up to (not including) our parent can
           move/fade it: the menu's slide-in, the Dock's auto-hide, … */
        this._watched = [];
        for (let a = target; a && a !== parent; a = a.get_parent()) {
            const ids = WATCHED.map(p => a.connect(`notify::${p}`, () => this.queueSync()));
            this._watched.push([a, ids]);
        }
        this._watched.push([target, [target.connect('notify::mapped', () => this.queueSync())]]);
        this._watched.push([global.window_group, [global.window_group.connect('notify::visible', () => this.queueSync())]]);
        this._targetDestroy = target.connect('destroy', () => this.destroy());
        this.queueSync();
    }

    setBlur(radius) {
        this._pad = radius;
        this._blur.radius = radius;
        this.queueSync();
    }

    destroy() {
        if (!this.actor) return;
        const l = laters();
        if (this._later && l) l.remove(this._later);
        this._later = 0;
        for (const [a, ids] of this._watched) {
            for (const id of ids) {
                try { a.disconnect(id); } catch (_) {}
            }
        }
        this._watched = [];
        try { this._target.disconnect(this._targetDestroy); } catch (_) {}
        try { this._target.remove_style_class_name('notchex-glass-solid'); } catch (_) {}
        this.actor.destroy();
        this.actor = null;
        this._mirror = null;
        WindowMirror.release();
    }

    /* Geometry is read before the next frame is laid out and painted, never
       from inside an allocation (moving actors there is not allowed). */
    queueSync() {
        if (!this.actor || this._later) return;
        const l = laters();
        if (!l) { this._sync(); return; }
        this._later = l.add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._later = 0;
            this._sync();
            return false;
        });
    }

    _source() {
        if (Main.overview.visible || Main.overview.animationInProgress)
            return Main.layoutManager.overviewGroup;
        return global.window_group.visible ? this._mirror.actor : null;
    }

    _sync() {
        if (!this.actor) return;
        const t = this._target;
        const source = this._source();
        const opacity = t.mapped ? t.get_paint_opacity() : 0;
        if (!t.mapped || opacity === 0) {
            this.actor.hide();
            return;
        }
        /* no windows to show (e.g. locked): solid tint instead of glass */
        if (!source) {
            this.actor.hide();
            t.add_style_class_name('notchex-glass-solid');
            return;
        }
        t.remove_style_class_name('notchex-glass-solid');

        const ext = t.get_transformed_extents();
        const x = Math.round(ext.origin.x), y = Math.round(ext.origin.y);
        const w = Math.round(ext.size.width), h = Math.round(ext.size.height);
        /* not laid out yet (NaN extents) or collapsed */
        if (!(w >= 1 && h >= 1 && Number.isFinite(x) && Number.isFinite(y))) {
            this.actor.hide();
            return;
        }
        const [px, py] = this._parent.get_transformed_position();
        const scale = t.width > 0 ? w / t.width : 1;
        let radius = 0;
        try { radius = t.get_theme_node().get_border_radius(St.Corner.TOPLEFT) * scale; } catch (_) {}

        const pad = this._pad;
        this._set(this.actor, x - px, y - py, w, h);
        this._set(this._blurBox, -pad, -pad, w + 2 * pad, h + 2 * pad);
        if (this._clone.source !== source) this._clone.source = source;
        /* the sources sit at the stage origin */
        this._set(this._clone, -(x - pad), -(y - pad));
        this._mask.setBounds(w, h, radius);
        this.actor.opacity = opacity;
        this.actor.show();
    }

    _set(actor, x, y, w, h) {
        if (actor.x !== x || actor.y !== y) actor.set_position(x, y);
        if (w !== undefined && (actor.width !== w || actor.height !== h)) actor.set_size(w, h);
    }
}

/* Glass + macOS Control Center styling for the top bar and its menus
   (Quick Settings, calendar, indicator menus). */
export class PanelGlass {
    constructor(settings) {
        this._settings = settings;
        this._layers = new Map();   /* target actor → GlassLayer */
        this._styled = new Set();
        this._sigs = [
            'glass-enabled', 'glass-menus', 'glass-panel', 'glass-blur', 'control-center-style',
        ].map(k => settings.connect(`changed::${k}`, () => this._rebuild()));
        this._iface = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        this._ifaceSig = this._iface.connect('changed::color-scheme', () => this._rebuild());
        this._overviewSigs = ['showing', 'shown', 'hiding', 'hidden']
            .map(s => Main.overview.connect(s, () => this._syncAll()));
        this._patchMenuManager();
        this._rebuild();
    }

    destroy() {
        for (const id of this._sigs) this._settings.disconnect(id);
        this._sigs = [];
        this._iface.disconnect(this._ifaceSig);
        for (const id of this._overviewSigs) Main.overview.disconnect(id);
        this._overviewSigs = [];
        this._unpatchMenuManager();
        this._clear();
    }

    _theme() {
        return this._iface.get_string('color-scheme') === 'prefer-light' ? 'light' : 'dark';
    }

    _menus() {
        return (Main.panel.menuManager?._menus ?? []).filter(m => m?.box instanceof St.Widget && m.actor);
    }

    _patchMenuManager() {
        const mgr = Main.panel.menuManager;
        if (!mgr) return;
        const orig = mgr.addMenu;
        this._origAddMenu = orig;
        mgr.addMenu = (menu, position) => {
            orig.call(mgr, menu, position);
            if (menu?.box instanceof St.Widget && menu.actor) this._decorateMenu(menu);
        };
    }

    _unpatchMenuManager() {
        const mgr = Main.panel.menuManager;
        if (mgr && this._origAddMenu) delete mgr.addMenu;
        this._origAddMenu = null;
    }

    _clear() {
        for (const layer of this._layers.values()) layer.destroy();
        this._layers.clear();
        for (const a of this._styled) {
            try {
                a.remove_style_class_name('notchex-glass');
                a.remove_style_class_name('notchex-glass-dark');
                a.remove_style_class_name('notchex-glass-light');
                a.remove_style_class_name('notchex-cc');
                a.remove_style_class_name('notchex-glass-solid');
            } catch (_) {}
        }
        this._styled.clear();
    }

    _rebuild() {
        this._clear();
        const s = this._settings;
        if (!s.get_boolean('glass-enabled')) return;
        if (s.get_boolean('glass-panel')) this._decorate(Main.panel, Main.layoutManager.panelBox);
        if (s.get_boolean('glass-menus')) {
            for (const menu of this._menus()) this._decorateMenu(menu);
        }
    }

    _decorateMenu(menu) {
        const s = this._settings;
        if (!s.get_boolean('glass-enabled') || !s.get_boolean('glass-menus')) return;
        const parent = menu.actor.get_parent();
        if (!parent) return;
        this._decorate(menu.box, menu.actor);
        if (menu === Main.panel.statusArea.quickSettings?.menu && s.get_boolean('control-center-style')) {
            menu.box.add_style_class_name('notchex-cc');
        }
    }

    _decorate(target, below) {
        if (this._layers.has(target)) return;
        const parent = below.get_parent();
        if (!parent) return;
        target.add_style_class_name('notchex-glass');
        target.add_style_class_name(`notchex-glass-${this._theme()}`);
        this._styled.add(target);
        const layer = new GlassLayer(target, {parent, below, blur: this._settings.get_int('glass-blur')});
        this._layers.set(target, layer);
        target.connect('destroy', () => {
            this._layers.delete(target);
            this._styled.delete(target);
        });
    }

    _syncAll() {
        for (const layer of this._layers.values()) layer.queueSync();
    }
}
