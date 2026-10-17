import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

const SCREEN_XML = `
<node>
  <interface name="org.gnome.SettingsDaemon.Power.Screen">
    <property name="Brightness" type="i" access="readwrite"/>
  </interface>
</node>`;

const ScreenProxy = Gio.DBusProxy.makeProxyWrapper(SCREEN_XML);

/* Screen backlight via gnome-settings-daemon's Power.Screen interface —
   the same one the Quick Settings slider drives. Brightness is -1 (or the
   interface is missing) on displays without a controllable backlight. */
export const BrightnessWatcher = GObject.registerClass({
    Signals: {
        'changed': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class BrightnessWatcher extends GObject.Object {
    start() {
        if (this._proxy || this._starting) return;
        this._starting = true;
        this._cancellable = new Gio.Cancellable();
        new ScreenProxy(Gio.DBus.session,
            'org.gnome.SettingsDaemon.Power', '/org/gnome/SettingsDaemon/Power',
            (proxy, error) => {
                this._starting = false;
                if (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`notchex: brightness unavailable: ${error.message}`);
                    return;
                }
                this._proxy = proxy;
                this._last = this._read();
                this._propsId = proxy.connect('g-properties-changed', (_p, changed) => {
                    if (!changed.lookup_value('Brightness', null)) return;
                    const v = this._read();
                    if (v === null || v === this._last) return;
                    this._last = v;
                    this.emit('changed', {level: v / 100});
                });
            }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._starting = false;
        if (this._proxy && this._propsId) this._proxy.disconnect(this._propsId);
        this._propsId = 0;
        this._proxy = null;
    }

    destroy() { this.stop(); }

    _read() {
        const v = this._proxy?.Brightness;
        return Number.isInteger(v) && v >= 0 ? v : null;
    }

    available() { return this._read() !== null; }

    level() {
        const v = this._read();
        return v === null ? null : v / 100;
    }

    setLevel(frac) {
        if (!this.available()) return;
        this._proxy.Brightness = Math.round(Math.max(0, Math.min(1, frac)) * 100);
    }
});
