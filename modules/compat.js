import Clutter from 'gi://Clutter';
import Meta from 'gi://Meta';
import Mtk from 'gi://Mtk';
import St from 'gi://St';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

/* The one place for GNOME-version differences, so the rest of the code
   doesn't sprinkle version checks. Developed against GNOME 46; written so
   47–50 keep working. */

export const SHELL_MAJOR = Number.parseInt(PACKAGE_VERSION.split('.')[0], 10) || 46;

/* St.BoxLayout's `vertical` became `orientation` in GNOME 48. */
export function boxLayout(params = {}) {
    const {vertical, ...rest} = params;
    if (vertical === undefined) return new St.BoxLayout(rest);
    if (SHELL_MAJOR >= 48) {
        return new St.BoxLayout({
            ...rest,
            orientation: vertical ? Clutter.Orientation.VERTICAL : Clutter.Orientation.HORIZONTAL,
        });
    }
    return new St.BoxLayout({...rest, vertical});
}

/* Actor that received a pointer event. */
export function eventActor(event) {
    try {
        return global.stage.get_event_actor(event);
    } catch (_) {
        return event.get_source?.() ?? null;
    }
}

export function launchContext() {
    return global.create_app_launch_context(0, -1);
}

/* Windows that are part of the desktop rather than an app: GNOME's
   desktop type, and the Desktop Icons (DING) extension's full-screen
   window, which it marks with `customJS_ding` on the MetaWindow. */
export function isDesktopWindow(win) {
    if (!win) return true;
    if (win.get_window_type() === Meta.WindowType.DESKTOP) return true;
    if (win.customJS_ding) return true;
    try {
        if (win.get_gtk_application_id?.() === 'com.rastersoft.ding') return true;
    } catch (_) {}
    return false;
}

/* Mtk.Rectangle replaced Meta.Rectangle in GNOME 45 (we support 46+). */
export function makeRect(x, y, width, height) {
    return new Mtk.Rectangle({x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height)});
}
