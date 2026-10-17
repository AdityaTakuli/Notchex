import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

const DEVICE_XML = `
<node>
  <interface name="org.freedesktop.UPower.Device">
    <property name="Type"        type="u" access="read"/>
    <property name="State"       type="u" access="read"/>
    <property name="Percentage"  type="d" access="read"/>
    <property name="IsPresent"   type="b" access="read"/>
    <property name="TimeToEmpty" type="x" access="read"/>
    <property name="TimeToFull"  type="x" access="read"/>
  </interface>
</node>`;

const DeviceProxy = Gio.DBusProxy.makeProxyWrapper(DEVICE_XML);

/* UPower device states */
const CHARGING = 1, DISCHARGING = 2, FULL = 4, PENDING_CHARGE = 5, PENDING_DISCHARGE = 6;
const TYPE_BATTERY = 2;

const LOW_PCT = 20;
const CRITICAL_PCT = 10;

/* Battery state from UPower's aggregated DisplayDevice — property-change
   driven, so no sysfs polling is needed for the pill's battery icon.
   Emits:
     'updated' {present, pct, charging, plugged, full, status, minutes}
     'event'   {kind: plugged|unplugged|full|low|critical, ...snapshot} */
export const BatteryWatcher = GObject.registerClass({
    Signals: {
        'updated': {param_types: [GObject.TYPE_JSOBJECT]},
        'event':   {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class BatteryWatcher extends GObject.Object {
    start() {
        if (this._proxy || this._starting) return;
        this._starting = true;
        this._cancellable = new Gio.Cancellable();
        new DeviceProxy(Gio.DBus.system,
            'org.freedesktop.UPower', '/org/freedesktop/UPower/devices/DisplayDevice',
            (proxy, error) => {
                this._starting = false;
                if (error) {
                    if (!error.matches?.(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.debug(`notchex: UPower unavailable: ${error.message}`);
                    return;
                }
                this._proxy = proxy;
                this._prev = this.snapshot();
                this._propsId = proxy.connect('g-properties-changed', () => this._onChanged());
                this.emit('updated', this._prev);
            }, this._cancellable, Gio.DBusProxyFlags.NONE);
    }

    stop() {
        this._cancellable?.cancel();
        this._cancellable = null;
        this._starting = false;
        if (this._proxy && this._propsId) this._proxy.disconnect(this._propsId);
        this._propsId = 0;
        this._proxy = null;
        this._prev = null;
    }

    destroy() { this.stop(); }

    available() { return !!this.snapshot()?.present; }

    snapshot() {
        const p = this._proxy;
        if (!p) return null;
        const state = p.State ?? 0;
        const pct = Math.round(p.Percentage ?? 0);
        const present = !!p.IsPresent && p.Type === TYPE_BATTERY;
        const charging = state === CHARGING;
        const full = state === FULL;
        const plugged = charging || full || state === PENDING_CHARGE;
        const secs = charging ? Number(p.TimeToFull ?? 0) : Number(p.TimeToEmpty ?? 0);
        let status = 'Unknown';
        if (charging) status = 'Charging';
        else if (full) status = 'Full';
        else if (state === PENDING_CHARGE) status = 'Not charging';
        else if (state === DISCHARGING || state === PENDING_DISCHARGE) status = 'Discharging';
        return {
            present, pct, charging, full, plugged, status,
            /* shape consumed by the pill's battery icon */
            capacity: pct,
            minutes: secs > 0 ? Math.round(secs / 60) : null,
        };
    }

    _onChanged() {
        const now = this.snapshot();
        if (!now) return;
        const prev = this._prev;
        this._prev = now;
        this.emit('updated', now);
        if (!prev || !now.present) return;

        if (!prev.plugged && now.plugged) {
            this.emit('event', {kind: now.full ? 'full' : 'plugged', ...now});
        } else if (prev.plugged && !now.plugged) {
            this.emit('event', {kind: 'unplugged', ...now});
        } else if (now.full && !prev.full && now.plugged) {
            this.emit('event', {kind: 'full', ...now});
        } else if (!now.plugged && prev.pct > CRITICAL_PCT && now.pct <= CRITICAL_PCT) {
            this.emit('event', {kind: 'critical', ...now});
        } else if (!now.plugged && prev.pct > LOW_PCT && now.pct <= LOW_PCT) {
            this.emit('event', {kind: 'low', ...now});
        }
    }
});
