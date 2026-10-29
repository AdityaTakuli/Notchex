import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Slider} from 'resource:///org/gnome/shell/ui/slider.js';

const RFKILL_XML = `
<node>
  <interface name="org.gnome.SettingsDaemon.Rfkill">
    <property name="BluetoothAirplaneMode"         type="b" access="readwrite"/>
    <property name="BluetoothHasAirplaneMode"      type="b" access="read"/>
    <property name="BluetoothHardwareAirplaneMode" type="b" access="read"/>
  </interface>
</node>`;
const RfkillProxy = Gio.DBusProxy.makeProxyWrapper(RFKILL_XML);

const NIGHT_LIGHT_SCHEMA = 'org.gnome.settings-daemon.plugins.color';

const UPOWER_XML = `
<node>
  <interface name="org.freedesktop.DBus.ObjectManager">
    <method name="GetManagedObjects">
      <arg type="a{oa{sa{sv}}}" direction="out"/>
    </method>
  </interface>
</node>`;

export const QuickHub = GObject.registerClass({
    Signals: {
        'updated': {},
        'request-collapse': {},
        'request-screenshot': {},
        'request-resize': {},
    },
}, class QuickHub extends GObject.Object {
    _init(settings, deps = {}) {
        super._init();
        this._settings = settings;
        this._volume = deps.volume ?? null;
        this._brightness = deps.brightness ?? null;
        this._bluetooth = deps.bluetooth ?? null;
        this._privacy = deps.privacy ?? null;
        this._mic = false;
        this._cam = false;
        this._btDevices = [];
        this._kbLayout = '';
        this._poller = 0;
        this._armedTimers = new Set();
        try {
            this._dndSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        } catch (_) { this._dndSettings = null; }
    }

    start() {
        this._stopped = false;
        this._focused = false;
        this._refresh();
    }

    /* Mic/cam/BT status only matters while the Quick tab is actually on
       screen — each refresh spawns up to 3 subprocesses (pactl/fuser/
       upower). Only run the poller while focused, so a background Quick
       module costs nothing. */
    setFocused(focused) {
        if (this._focused === focused) return;
        this._focused = focused;
        if (focused) {
            /* Wi-Fi / Bluetooth-radio state is only needed once the Quick
               tab has been opened — create those clients lazily. */
            this._ensureNM();
            this._ensureRfkill();
            this._refresh();
            if (!this._poller) {
                this._poller = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 15, () => {
                    if (this._stopped) return GLib.SOURCE_REMOVE;
                    this._refresh();
                    return GLib.SOURCE_CONTINUE;
                });
            }
        } else if (this._poller) {
            GLib.source_remove(this._poller);
            this._poller = 0;
        }
    }

    stop() {
        this._stopped = true;
        if (this._poller) { GLib.source_remove(this._poller); this._poller = 0; }
        this._nm?.disconnectObject(this);
        this._nm = null;
        if (this._rfkill && this._rfkillSig) this._rfkill.disconnect(this._rfkillSig);
        this._rfkillSig = 0;
        this._rfkill = null;
        this._rfkillCancel?.cancel();
        this._rfkillCancel = null;
        this._nightSettings = null;
        for (const id of this._armedTimers) {
            try { GLib.source_remove(id); } catch (_) {}
        }
        this._armedTimers.clear();
    }

    destroy() { this.stop(); }

    async _refresh() {
        try {
            /* the privacy watcher knows without spawning pactl/fuser (and
               fuser also counted PipeWire holding the camera as "in use") */
            if (!this._privacy) {
                this._mic = await this._anyAppUsing('Audio/Source');
                this._cam = await this._anyCameraUsing();
            }
            this._btDevices = await this._btBatteries();
            this._kbLayout  = this._currentLayout();
            this.emit('updated');
        } catch (e) { logError(e, 'notchex:quick:refresh'); }
    }

    async _anyAppUsing(_role) {
        return await new Promise(resolve => {
            if (!GLib.find_program_in_path('pactl')) { resolve(false); return; }
            try {
                const proc = Gio.Subprocess.new(
                    ['pactl', '-f', 'json', 'list', 'source-outputs'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        const data = JSON.parse(out || '[]');
                        resolve(Array.isArray(data) && data.length > 0);
                    } catch (_) { resolve(false); }
                });
            } catch (_) { resolve(false); }
        });
    }

    async _anyCameraUsing() {
        /* Avoid `sh -c` entirely — enumerate /dev/video* ourselves and spawn
           fuser directly with an explicit absolute path. Portable and the
           spawn matches the guarded binary. */
        const fuserPath = GLib.find_program_in_path('fuser');
        if (!fuserPath) return false;
        const devs = [];
        try {
            const dir = Gio.File.new_for_path('/dev');
            const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                if (/^video\d+$/.test(n)) devs.push(`/dev/${n}`);
            }
        } catch (_) { return false; }
        if (devs.length === 0) return false;
        return new Promise(resolve => {
            try {
                const proc = Gio.Subprocess.new(
                    [fuserPath, ...devs],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        resolve(out.trim().length > 0);
                    } catch (_) { resolve(false); }
                });
            } catch (_) { resolve(false); }
        });
    }

    async _btBatteries() {
        return await new Promise(resolve => {
            if (!GLib.find_program_in_path('upower')) { resolve([]); return; }
            try {
                const proc = Gio.Subprocess.new(
                    ['upower', '-d'],
                    Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
                );
                proc.communicate_utf8_async(null, null, (p, res) => {
                    try {
                        const [, out] = p.communicate_utf8_finish(res);
                        const devs = [];
                        const blocks = out.split(/\n\s*\n/);
                        for (const b of blocks) {
                            if (!/model:/i.test(b)) continue;
                            if (!/battery/i.test(b) && !/headset|headphones|keyboard|mouse|phone/i.test(b)) continue;
                            const model = (b.match(/model:\s+([^\n]+)/) || [])[1];
                            const pctRaw = (b.match(/percentage:\s+(\d+)/) || [])[1];
                            const pct   = Number(pctRaw);
                            /* keep 0% devices — they're the ones that need alerting */
                            if (model && Number.isFinite(pct)) devs.push({model: model.trim(), pct});
                        }
                        resolve(devs);
                    } catch (_) { resolve([]); }
                });
            } catch (_) { resolve([]); }
        });
    }

    _currentLayout() {
        try {
            const src = new Gio.Settings({schema_id: 'org.gnome.desktop.input-sources'});
            const srcs = src.get_value('sources').deep_unpack();
            const cur  = src.get_uint('current');
            if (srcs[cur]) return srcs[cur][1];
        } catch (_) {}
        return '';
    }

    async _ensureNM() {
        if (this._nm || this._nmLoading) return;
        this._nmLoading = true;
        try {
            const NM = (await import('gi://NM')).default;
            const client = await new Promise((resolve, reject) => {
                NM.Client.new_async(null, (_o, res) => {
                    try { resolve(NM.Client.new_finish(res)); } catch (e) { reject(e); }
                });
            });
            if (this._stopped) return;
            this._nm = client;
            client.connectObject(
                'notify::wireless-enabled',   () => this.emit('updated'),
                'notify::primary-connection', () => this.emit('updated'),
                this);
            this.emit('updated');
        } catch (e) {
            logError(e, 'notchex:quick:nm');
        } finally {
            this._nmLoading = false;
        }
    }

    _wifiState() {
        const c = this._nm;
        if (!c) return null;
        let ssid = '';
        try {
            const ac = c.get_primary_connection();
            if (ac && ac.get_connection_type() === '802-11-wireless') ssid = ac.get_id();
        } catch (_) {}
        return {on: !!c.wireless_enabled, hw: c.wireless_hardware_enabled !== false, ssid};
    }

    _setWifi(on) {
        this._nm?.dbus_set_property('/org/freedesktop/NetworkManager',
            'org.freedesktop.NetworkManager', 'WirelessEnabled',
            GLib.Variant.new_boolean(on), -1, null, (c, res) => {
                try { c.dbus_set_property_finish(res); } catch (e) { logError(e, 'notchex:quick:wifi'); }
            });
    }

    _ensureRfkill() {
        if (this._rfkill || this._rfkillCancel) return;
        this._rfkillCancel = new Gio.Cancellable();
        new RfkillProxy(Gio.DBus.session, 'org.gnome.SettingsDaemon.Rfkill',
            '/org/gnome/SettingsDaemon/Rfkill', (proxy, error) => {
                if (error || this._stopped) return;
                this._rfkill = proxy;
                this._rfkillSig = proxy.connect('g-properties-changed', () => this.emit('updated'));
                this.emit('updated');
            }, this._rfkillCancel, Gio.DBusProxyFlags.NONE);
    }

    _btState() {
        const p = this._rfkill;
        if (!p || !p.BluetoothHasAirplaneMode) return null;
        return {on: !p.BluetoothAirplaneMode, hwBlocked: !!p.BluetoothHardwareAirplaneMode};
    }

    _nightLight() {
        if (this._nightSettings === undefined || this._nightSettings === null) {
            const src = Gio.SettingsSchemaSource.get_default();
            this._nightSettings = src?.lookup(NIGHT_LIGHT_SCHEMA, true)
                ? new Gio.Settings({schema_id: NIGHT_LIGHT_SCHEMA}) : false;
        }
        return this._nightSettings || null;
    }

    _tile(icon, label, state, active, onClick, enabled = true) {
        const b = new St.Button({
            style_class: 'notchex-tile' + (active ? ' active' : '') + (enabled ? '' : ' disabled'),
            can_focus: true, reactive: enabled, x_expand: true,
            accessible_name: label,
        });
        const inner = new St.BoxLayout({style_class: 'notchex-tile-inner'});
        const iconBin = new St.Bin({style_class: 'notchex-tile-icon-bin', y_align: Clutter.ActorAlign.CENTER});
        iconBin.set_child(new St.Icon({icon_name: icon, icon_size: 16}));
        inner.add_child(iconBin);
        const col = new St.BoxLayout({vertical: true, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        col.add_child(new St.Label({text: label, style_class: 'notchex-tile-label'}));
        const st = new St.Label({text: state, style_class: 'notchex-tile-state'});
        st.clutter_text.ellipsize = 3;
        col.add_child(st);
        inner.add_child(col);
        b.set_child(inner);
        if (enabled) b.connect('clicked', onClick);
        return b;
    }

    _sliderRow(icon, value, onChange, onIcon, watcher, readLevel) {
        const row = new St.BoxLayout({style_class: 'notchex-quick-slider-row', x_expand: true});
        const iconBtn = new St.Button({style_class: 'notchex-quick-slider-icon', can_focus: true,
            child: new St.Icon({icon_name: icon, icon_size: 16}), y_align: Clutter.ActorAlign.CENTER});
        if (onIcon) iconBtn.connect('clicked', onIcon);
        else iconBtn.reactive = false;
        row.add_child(iconBtn);
        const slider = new Slider(Math.max(0, Math.min(1, value)));
        slider.x_expand = true;
        slider.y_align = Clutter.ActorAlign.CENTER;
        const pct = new St.Label({text: `${Math.round(value * 100)}%`, style_class: 'notchex-quick-slider-value',
            y_align: Clutter.ActorAlign.CENTER});
        const sliderId = slider.connect('notify::value', () => {
            pct.text = `${Math.round(slider.value * 100)}%`;
            onChange(slider.value);
        });
        row.add_child(slider);
        row.add_child(pct);
        /* follow external changes (keys, other UIs) while on screen */
        if (watcher) {
            const wid = watcher.connect('changed', () => {
                const v = readLevel();
                if (v === null || slider._dragging) return;
                slider.block_signal_handler(sliderId);
                slider.value = Math.max(0, Math.min(1, v));
                slider.unblock_signal_handler(sliderId);
                pct.text = `${Math.round(v * 100)}%`;
            });
            slider.connect('destroy', () => watcher.disconnect(wid));
        }
        return row;
    }

    render() {
        const box = new St.BoxLayout({style_class: 'notchex-quick', vertical: true, x_expand: true, y_expand: true});

        /* ——— toggles ——— */
        const tiles = new St.BoxLayout({style_class: 'notchex-tiles', x_expand: true});
        const wifi = this._wifiState();
        tiles.add_child(this._tile(
            wifi?.on ? 'network-wireless-signal-excellent-symbolic' : 'network-wireless-offline-symbolic',
            'Wi-Fi', wifi ? (wifi.on ? (wifi.ssid || 'On') : 'Off') : '…',
            !!wifi?.on, () => this._setWifi(!wifi.on), !!wifi && wifi.hw));
        const bt = this._btState();
        const btCount = this._bluetooth?.connectedDevices?.().length ?? 0;
        tiles.add_child(this._tile(
            bt?.on ? 'bluetooth-active-symbolic' : 'bluetooth-disabled-symbolic',
            'Bluetooth', bt ? (bt.on ? (btCount ? `${btCount} connected` : 'On') : 'Off') : '…',
            !!bt?.on, () => { this._rfkill.BluetoothAirplaneMode = bt.on; }, !!bt && !bt.hwBlocked));
        const night = this._nightLight();
        if (night) {
            const on = night.get_boolean('night-light-enabled');
            tiles.add_child(this._tile('night-light-symbolic', 'Night Light', on ? 'On' : 'Off', on, () => {
                night.set_boolean('night-light-enabled', !on);
                this.emit('updated');
            }));
        }
        const dndOn = this._dndSettings ? !this._dndSettings.get_boolean('show-banners') : false;
        tiles.add_child(this._tile('notifications-disabled-symbolic', 'Focus', dndOn ? 'Do Not Disturb' : 'Off',
            dndOn, () => {
                if (!this._dndSettings) return;
                this._dndSettings.set_boolean('show-banners', dndOn);
                this.emit('updated');
            }, !!this._dndSettings));
        box.add_child(tiles);

        /* ——— sliders ——— */
        const vol = this._volume?.state?.();
        if (vol) {
            box.add_child(this._sliderRow(
                vol.muted ? 'audio-volume-muted-symbolic' : 'audio-volume-high-symbolic',
                vol.muted ? 0 : vol.level,
                v => this._volume.setLevel(v),
                () => { this._volume.toggleMute(); this.emit('updated'); },
                this._volume, () => {
                    const st = this._volume.state();
                    return st ? (st.muted ? 0 : st.level) : null;
                }));
        }
        const bri = this._brightness?.level?.();
        if (bri !== null && bri !== undefined) {
            box.add_child(this._sliderRow('display-brightness-symbolic', bri,
                v => this._brightness.setLevel(v), null,
                this._brightness, () => this._brightness.level()));
        }

        const privacyRow = new St.BoxLayout({style_class: 'notchex-quick-row'});
        const mic = this._privacy ? this._privacy.mic : this._mic;
        const cam = this._privacy ? this._privacy.camera : this._cam;
        privacyRow.add_child(this._pill('Microphone', mic ? 'In use' : 'Off', mic));
        privacyRow.add_child(this._pill('Camera', cam ? 'In use' : 'Off', cam));
        privacyRow.add_child(this._pill('Layout', this._kbLayout || '—', false));
        box.add_child(privacyRow);

        if (this._btDevices.length > 0) {
            box.add_child(new St.Label({text: 'Bluetooth', style_class: 'notchex-quick-section'}));
            for (const d of this._btDevices) {
                const r = new St.BoxLayout({style_class: 'notchex-quick-bt-row'});
                r.add_child(new St.Label({text: d.model, style_class: 'notchex-quick-bt-name', x_expand: true}));
                const pctLbl = new St.Label({text: `${d.pct}%`, style_class: 'notchex-quick-bt-pct'});
                if (d.pct < 20) pctLbl.add_style_class_name('low');
                r.add_child(pctLbl);
                box.add_child(r);
            }
        }

        /* icon-only actions (their name shows in the hint on hover) and one
           Power button that reveals the destructive actions on demand */
        const actions = new St.BoxLayout({style_class: 'notchex-quick-actions'});
        const hint = new St.Label({text: '', style_class: 'notchex-quick-hint',
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const iconAction = (label, icon, cb) => {
            const b = this._actionButton(label, cb, icon, true);
            b.connect('notify::hover', () => { hint.text = b.hover ? label : ''; });
            b.connect('key-focus-in', () => { hint.text = label; });
            b.connect('key-focus-out', () => { hint.text = ''; });
            actions.add_child(b);
        };
        /* instant full-screen shot (the island folds away first); the
           area/window picker is GNOME's own screenshot tool */
        iconAction('Screenshot', 'camera-photo-symbolic', () => this.emit('request-screenshot'));
        iconAction('Capture Area', 'selection-mode-symbolic', () => {
            this.emit('request-collapse');
            const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 350, () => {
                this._armedTimers.delete(id);
                try { Main.screenshotUI?.open(); } catch (e) { logError(e, 'notchex:quick:screenshot'); }
                return GLib.SOURCE_REMOVE;
            });
            this._armedTimers.add(id);
        });
        iconAction('Settings', 'emblem-system-symbolic', () => {
            this.emit('request-collapse');
            try { Gio.DesktopAppInfo.new('org.gnome.Settings.desktop')?.launch([], null); }
            catch (e) { logError(e, 'notchex:quick:settings'); }
        });
        iconAction('Lock', 'system-lock-screen-symbolic', () => this._run(['loginctl', 'lock-session']));
        iconAction('Suspend', 'weather-clear-night-symbolic', () => this._run(['systemctl', 'suspend']));
        actions.add_child(hint);

        /* Log out / Restart / Shut Down stay one level down, and each still
           needs a confirming second click ("Really?" arm state) so a stray
           click in a hover panel can't kill work. */
        const power = new St.BoxLayout({style_class: 'notchex-quick-power', visible: false});
        power.add_child(this._armedActionButton('Log Out',   ['gnome-session-quit', '--logout', '--no-prompt']));
        power.add_child(this._armedActionButton('Restart',   ['systemctl', 'reboot']));
        power.add_child(this._armedActionButton('Shut Down', ['systemctl', 'poweroff']));
        const powerBtn = this._actionButton('Power', () => {
            power.visible = !power.visible;
            powerBtn.checked = power.visible;
            this.emit('request-resize');
        }, 'system-shutdown-symbolic');
        powerBtn.toggle_mode = false;
        powerBtn.accessible_name = 'Power options';
        actions.add_child(powerBtn);
        box.add_child(actions);
        box.add_child(power);

        return box;
    }

    _pill(label, value, active) {
        const p = new St.BoxLayout({style_class: 'notchex-quick-pill' + (active ? ' active' : '')});
        p.add_child(new St.Label({text: label, style_class: 'notchex-quick-pill-label'}));
        p.add_child(new St.Label({text: value, style_class: 'notchex-quick-pill-value'}));
        return p;
    }

    _actionButton(label, cb, icon = null, iconOnly = false) {
        const b = new St.Button({style_class: 'notchex-quick-action', accessible_name: label, can_focus: true,
            track_hover: true});
        if (icon && iconOnly) {
            b.add_style_class_name('icon-only');
            b.set_child(new St.Icon({icon_name: icon, icon_size: 16}));
        } else if (icon) {
            const inner = new St.BoxLayout({style_class: 'notchex-quick-action-inner'});
            inner.add_child(new St.Icon({icon_name: icon, icon_size: 13, y_align: Clutter.ActorAlign.CENTER}));
            inner.add_child(new St.Label({text: label, y_align: Clutter.ActorAlign.CENTER}));
            b.set_child(inner);
        } else {
            b.label = label;
        }
        b.connect('clicked', cb);
        return b;
    }

    _armedActionButton(label, argv) {
        const b = new St.Button({
            style_class: 'notchex-quick-action',
            label,
            accessible_name: `${label} (click twice to confirm)`,
            can_focus: true,
        });
        let armed = false;
        let armTimer = 0;
        const disarm = () => {
            armed = false;
            if (armTimer) {
                this._armedTimers.delete(armTimer);
                try { GLib.source_remove(armTimer); } catch (_) {}
                armTimer = 0;
            }
            try { b.label = label; b.remove_style_class_name('armed'); } catch (_) {}
        };
        b.connect('clicked', () => {
            if (this._stopped) return;
            if (armed) { disarm(); this._run(argv); return; }
            armed = true;
            b.label = 'Really?';
            b.add_style_class_name('armed');
            if (armTimer) { this._armedTimers.delete(armTimer); GLib.source_remove(armTimer); }
            armTimer = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                this._armedTimers.delete(armTimer);
                armTimer = 0;
                disarm();
                return GLib.SOURCE_REMOVE;
            });
            this._armedTimers.add(armTimer);
        });
        /* if the whole tab rerenders while armed, the button is destroyed —
           make sure we also drop the pending timer rather than touching a
           dead actor. */
        b.connect('destroy', () => disarm());
        return b;
    }

    _run(argv) {
        if (!GLib.find_program_in_path(argv[0])) {
            logError(new Error(`${argv[0]} not in PATH`), 'notchex:quick:run');
            return;
        }
        try {
            Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) { logError(e, 'notchex:quick:run'); }
    }
});
