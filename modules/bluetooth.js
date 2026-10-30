import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const BLUEZ = 'org.bluez';
const DEVICE_IFACE = 'org.bluez.Device1';
const BATTERY_IFACE = 'org.bluez.Battery1';

/* How long after a connect a late-arriving battery reading still updates
   the connection event on screen. */
const BATTERY_GRACE_MS = 6000;

/* Tracks BlueZ devices over the system bus with signal subscriptions only
   (PropertiesChanged + InterfacesAdded/Removed) — no polling, no
   subprocesses. Emits 'device' {path, name, icon, connected, battery}
   whenever a device connects or disconnects (and when its battery level
   shows up shortly after connecting). */
export const BluetoothWatcher = GObject.registerClass({
    Signals: {
        'device': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class BluetoothWatcher extends GObject.Object {
    _init() {
        super._init();
        this._devices = new Map();
        this._subs = [];
    }

    start() {
        if (this._subs.length) return;
        const bus = Gio.DBus.system;
        const sub = (iface, signal, cb) => this._subs.push(bus.signal_subscribe(
            BLUEZ, iface, signal, null, null, Gio.DBusSignalFlags.NONE,
            (_c, _sender, path, _i, _s, params) => {
                try { cb(path, params); } catch (e) { logError(e, 'notchex:bluetooth'); }
            }));
        sub('org.freedesktop.DBus.Properties', 'PropertiesChanged', (path, params) => {
            const [iface, changed] = params.recursiveUnpack();
            this._apply(path, iface, changed, true);
        });
        sub('org.freedesktop.DBus.ObjectManager', 'InterfacesAdded', (_path, params) => {
            const [objPath, ifaces] = params.recursiveUnpack();
            for (const [iface, props] of Object.entries(ifaces))
                this._apply(objPath, iface, props, true);
        });
        sub('org.freedesktop.DBus.ObjectManager', 'InterfacesRemoved', (_path, params) => {
            const [objPath, ifaces] = params.recursiveUnpack();
            if (ifaces.includes(DEVICE_IFACE)) this._devices.delete(objPath);
            else if (ifaces.includes(BATTERY_IFACE) && this._devices.has(objPath))
                this._devices.get(objPath).battery = null;
        });

        this._cancellable = new Gio.Cancellable();
        bus.call(BLUEZ, '/', 'org.freedesktop.DBus.ObjectManager', 'GetManagedObjects',
            null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (conn, res) => {
                try {
                    const [objects] = conn.call_finish(res).recursiveUnpack();
                    for (const [path, ifaces] of Object.entries(objects)) {
                        for (const [iface, props] of Object.entries(ifaces))
                            this._apply(path, iface, props, false);
                    }
                } catch (_) { /* bluetoothd not running — signals will catch it later */ }
            });
    }

    stop() {
        for (const id of this._subs) {
            try { Gio.DBus.system.signal_unsubscribe(id); } catch (_) {}
        }
        this._subs = [];
        this._cancellable?.cancel();
        this._cancellable = null;
        this._devices.clear();
    }

    destroy() { this.stop(); }

    /* asks BlueZ to reconnect a known device; cb(ok) when it answers */
    reconnect(path, cb = () => {}) {
        Gio.DBus.system.call(BLUEZ, path, DEVICE_IFACE, 'Connect',
            null, null, Gio.DBusCallFlags.NONE, 20000, null, (conn, res) => {
                let ok = true;
                try { conn.call_finish(res); } catch (_) { ok = false; }
                cb(ok);
            });
    }

    connectedDevices() {
        return [...this._devices.values()].filter(d => d.connected);
    }

    _apply(path, iface, props, live) {
        if (iface !== DEVICE_IFACE && iface !== BATTERY_IFACE) return;
        let dev = this._devices.get(path);
        if (!dev) {
            dev = {path, name: '', icon: '', connected: false, battery: null, connectedAt: 0};
            this._devices.set(path, dev);
        }
        if (iface === DEVICE_IFACE) {
            if ('Alias' in props || 'Name' in props)
                dev.name = props.Alias || props.Name || dev.name;
            if (!dev.name && 'Address' in props) dev.name = props.Address;
            if ('Icon' in props) dev.icon = props.Icon ?? '';
            if ('Connected' in props && !!props.Connected !== dev.connected) {
                dev.connected = !!props.Connected;
                if (live) {
                    dev.connectedAt = dev.connected ? this._now() : 0;
                    this._emit(dev);
                }
            }
        } else if ('Percentage' in props) {
            const before = dev.battery;
            dev.battery = Number(props.Percentage);
            /* Headsets usually publish Battery1 a moment after Connected —
               refresh the connect event so the level appears on it. */
            if (live && dev.connected && before === null &&
                this._now() - dev.connectedAt < BATTERY_GRACE_MS)
                this._emit(dev);
        }
    }

    _emit(dev) {
        this.emit('device', {
            path: dev.path,
            name: dev.name || 'Bluetooth device',
            icon: dev.icon,
            connected: dev.connected,
            battery: dev.battery,
        });
    }

    _now() { return GLib.get_monotonic_time() / 1000; }
});
