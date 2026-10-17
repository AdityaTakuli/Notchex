import GObject from 'gi://GObject';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

export const SystemMonitor = GObject.registerClass({
    Signals: {
        'updated': {param_types: [GObject.TYPE_JSOBJECT]},
    },
}, class SystemMonitor extends GObject.Object {
    _init(settings) {
        super._init();
        this._settings = settings;
        this._timer = 0;
        this._lastCpu = null;
        this._lastNet = null;
        this._lastNetTime = 0;
        this._lastDisk = null;
        this._lastDiskTime = 0;
        this._cpuCores = GLib.get_num_processors();
        this._thermalZones = this._findThermalZones();
        this._hwmonInputs = this._findHwmonInputs();
        this._batteryPath = this._findBattery();
        this._gpuPath = this._findGpuBusy();
        this._stats = this._emptyStats();
        this._diskCapTimer = 0;
        this._focused = false;
        this._background = false;
    }

    _emptyStats() {
        return {
            cpu: 0, ram: 0, swap: 0,
            net_rx: 0, net_tx: 0,
            disk_r: 0, disk_w: 0,
            disk_used: 0, disk_total: 0,
            temp: 0, temp_cpu: 0,
            gpu: null,
            load: [0, 0, 0],
            uptime: 0,
            battery: null,
        };
    }

    start() {
        this._tick();
        this._restartTimer();
        this._settingsSig = this._settings.connect('changed::poll-interval', () => this._restartTimer());
        /* Disk capacity barely changes — poll it far less often than the
           rest of the stats instead of doing filesystem-info syscalls on
           every fast tick. */
        this._tickDiskCapacity();
        this._diskCapTimer = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 60, () => {
            this._tickDiskCapacity();
            return GLib.SOURCE_CONTINUE;
        });
    }

    /* called by notch when expanded+system-tab visible vs collapsed/other.
       Polls at the user-configured rate only while the System tab is on
       screen; at 3x that while the pill shows the compact CPU/RAM chip;
       and not at all otherwise (the pill's battery icon comes from UPower,
       see battery.js), so an idle island costs no /proc reads. */
    setFocused(focused) {
        if (this._focused === focused) return;
        this._focused = focused;
        if (focused) this._tick();
        this._restartTimer();
    }

    setBackground(on) {
        if (this._background === on) return;
        this._background = on;
        this._restartTimer();
    }

    _restartTimer() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (!this._focused && !this._background) return;
        const base = Math.max(1, this._settings.get_int('poll-interval')) * 1000;
        const interval = this._focused ? base : base * 3;
        this._timer = GLib.timeout_add(GLib.PRIORITY_LOW, interval, () => {
            this._tick();
            return GLib.SOURCE_CONTINUE;
        });
    }

    stop() {
        if (this._timer) { GLib.source_remove(this._timer); this._timer = 0; }
        if (this._diskCapTimer) { GLib.source_remove(this._diskCapTimer); this._diskCapTimer = 0; }
        if (this._settingsSig) { this._settings.disconnect(this._settingsSig); this._settingsSig = 0; }
    }

    destroy() { this.stop(); }

    _tick() {
        try {
            this._stats.cpu       = this._cpuUsage();
            const mem             = this._memUsage();
            this._stats.ram       = mem.ram;
            this._stats.swap      = mem.swap;
            const net             = this._netRate();
            this._stats.net_rx    = net.rx; this._stats.net_tx = net.tx;
            const disk            = this._diskRate();
            this._stats.disk_r    = disk.r; this._stats.disk_w = disk.w;
            this._stats.temp      = this._temperature();
            this._stats.gpu       = this._gpuUsage();
            this._stats.load      = this._loadAvg();
            this._stats.uptime    = this._uptime();
            this._stats.battery   = this._battery();
            this.emit('updated', this._stats);
        } catch (e) { logError(e, 'notchex:system'); }
    }

    _readFile(path) {
        try {
            const [ok, bytes] = GLib.file_get_contents(path);
            if (!ok) return '';
            return new TextDecoder().decode(bytes);
        } catch (_) { return ''; }
    }

    _cpuUsage() {
        const line = this._readFile('/proc/stat').split('\n')[0];
        const p = line.split(/\s+/).slice(1).map(Number);
        const idle = p[3] + (p[4] ?? 0);
        const total = p.reduce((a, b) => a + b, 0);
        if (!this._lastCpu) { this._lastCpu = {idle, total}; return 0; }
        const dIdle = idle - this._lastCpu.idle;
        const dTotal = total - this._lastCpu.total;
        this._lastCpu = {idle, total};
        return dTotal > 0 ? (1 - dIdle / dTotal) * 100 : 0;
    }

    _memUsage() {
        const text = this._readFile('/proc/meminfo');
        const get = k => {
            const m = text.match(new RegExp(`^${k}:\\s+(\\d+)`, 'm'));
            return m ? Number(m[1]) : 0;
        };
        const memTotal = get('MemTotal');
        const memAvail = get('MemAvailable');
        const swapTotal = get('SwapTotal');
        const swapFree  = get('SwapFree');
        return {
            ram:  memTotal  > 0 ? ((memTotal  - memAvail) / memTotal)  * 100 : 0,
            swap: swapTotal > 0 ? ((swapTotal - swapFree) / swapTotal) * 100 : 0,
        };
    }

    _netRate() {
        const lines = this._readFile('/proc/net/dev').split('\n').slice(2);
        let rx = 0, tx = 0;
        for (const line of lines) {
            const m = line.trim().match(/^([^:]+):\s+(.+)$/);
            if (!m) continue;
            const iface = m[1].trim();
            if (iface === 'lo' || iface.startsWith('docker') || iface.startsWith('veth') ||
                iface.startsWith('br-') || iface.startsWith('virbr') || iface.startsWith('tun')) continue;
            const cols = m[2].split(/\s+/).map(Number);
            rx += cols[0]; tx += cols[8];
        }
        const now = GLib.get_monotonic_time() / 1000;
        if (!this._lastNet) { this._lastNet = {rx, tx}; this._lastNetTime = now; return {rx: 0, tx: 0}; }
        const dt = (now - this._lastNetTime) / 1000;
        const drx = rx - this._lastNet.rx;
        const dtx = tx - this._lastNet.tx;
        this._lastNet = {rx, tx}; this._lastNetTime = now;
        return dt > 0 ? {rx: (drx / 1024) / dt, tx: (dtx / 1024) / dt} : {rx: 0, tx: 0};
    }

    _diskRate() {
        const lines = this._readFile('/proc/diskstats').split('\n');
        let r = 0, w = 0;
        for (const line of lines) {
            const parts = line.trim().split(/\s+/);
            if (parts.length < 14) continue;
            const name = parts[2];
            if (/^(loop|ram|dm-|sr)/.test(name)) continue;
            if (/\d+$/.test(name) && !/^nvme\d+n\d+$/.test(name)) continue;
            r += Number(parts[5]);
            w += Number(parts[9]);
        }
        const now = GLib.get_monotonic_time() / 1000;
        if (!this._lastDisk) { this._lastDisk = {r, w}; this._lastDiskTime = now; return {r: 0, w: 0}; }
        const dt = (now - this._lastDiskTime) / 1000;
        const dr = (r - this._lastDisk.r) * 512 / 1024;
        const dw = (w - this._lastDisk.w) * 512 / 1024;
        this._lastDisk = {r, w}; this._lastDiskTime = now;
        return dt > 0 ? {r: dr / dt, w: dw / dt} : {r: 0, w: 0};
    }

    _tickDiskCapacity() {
        try {
            const cap = this._diskCapacity();
            this._stats.disk_used  = cap.used;
            this._stats.disk_total = cap.total;
            this.emit('updated', this._stats);
        } catch (e) { logError(e, 'notchex:system:diskcap'); }
    }

    /* Sums real block-device filesystems (root disk, other internal
       drives) into one used/total figure — like macOS's "About This Mac"
       storage bar. Dedupes by source device so bind mounts / multiple
       mountpoints of the same partition aren't double-counted. */
    _diskCapacity() {
        const SKIP_FS = new Set([
            'tmpfs', 'devtmpfs', 'overlay', 'squashfs', 'proc', 'sysfs',
            'cgroup', 'cgroup2', 'devpts', 'ramfs', 'fuse.portal',
            'autofs', 'binfmt_misc', 'tracefs', 'debugfs', 'mqueue',
        ]);
        const seen = new Set();
        let total = 0, free = 0;
        const lines = this._readFile('/proc/mounts').split('\n');
        for (const line of lines) {
            const parts = line.split(' ');
            if (parts.length < 3) continue;
            const [source, mount, fstype] = parts;
            if (!source.startsWith('/dev/')) continue;
            if (SKIP_FS.has(fstype)) continue;
            if (seen.has(source)) continue;
            seen.add(source);
            try {
                const file = Gio.File.new_for_path(mount);
                const info = file.query_filesystem_info('filesystem::size,filesystem::free', null);
                total += info.get_attribute_uint64('filesystem::size');
                free  += info.get_attribute_uint64('filesystem::free');
            } catch (_) {}
        }
        return {total, free, used: total - free};
    }

    /* AMD (and some Intel Xe) drivers expose a utilisation counter; other
       GPUs are simply omitted rather than spawning nvidia-smi per tick. */
    _findGpuBusy() {
        try {
            const dir = Gio.File.new_for_path('/sys/class/drm');
            const iter = dir.enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                if (!/^card\d+$/.test(n)) continue;
                const p = `/sys/class/drm/${n}/device/gpu_busy_percent`;
                if (GLib.file_test(p, GLib.FileTest.EXISTS)) return p;
            }
        } catch (_) {}
        return null;
    }

    _gpuUsage() {
        if (!this._gpuPath) return null;
        const v = Number(this._readFile(this._gpuPath).trim());
        return Number.isFinite(v) ? v : null;
    }

    _findThermalZones() {
        const zones = [];
        try {
            const dir = Gio.File.new_for_path('/sys/class/thermal');
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                if (n.startsWith('thermal_zone')) zones.push(`/sys/class/thermal/${n}/temp`);
            }
        } catch (_) {}
        return zones;
    }

    _findHwmonInputs() {
        const inputs = [];
        try {
            const dir = Gio.File.new_for_path('/sys/class/hwmon');
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const base = `/sys/class/hwmon/${info.get_name()}`;
                const nameText = this._readFile(`${base}/name`).trim();
                const subdir = Gio.File.new_for_path(base);
                const subIter = subdir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
                let sub;
                while ((sub = subIter.next_file(null))) {
                    const n = sub.get_name();
                    if (/^temp\d+_input$/.test(n)) inputs.push({path: `${base}/${n}`, name: nameText});
                }
            }
        } catch (_) {}
        return inputs;
    }

    _temperature() {
        let max = 0;
        for (const p of this._thermalZones) {
            const v = Number(this._readFile(p).trim());
            if (v > max) max = v;
        }
        for (const h of this._hwmonInputs) {
            const v = Number(this._readFile(h.path).trim());
            if (v > max) max = v;
        }
        return max / 1000;
    }

    _loadAvg() {
        return this._readFile('/proc/loadavg').trim().split(' ').slice(0, 3).map(Number);
    }

    _uptime() {
        const text = this._readFile('/proc/uptime').trim().split(' ')[0];
        return Number(text);
    }

    _findBattery() {
        try {
            const dir = Gio.File.new_for_path('/sys/class/power_supply');
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                const type = this._readFile(`/sys/class/power_supply/${n}/type`).trim();
                if (type === 'Battery') return `/sys/class/power_supply/${n}`;
            }
        } catch (_) {}
        return null;
    }

    _acOnline() {
        try {
            const dir = Gio.File.new_for_path('/sys/class/power_supply');
            const iter = dir.enumerate_children('standard::*', Gio.FileQueryInfoFlags.NONE, null);
            let info;
            while ((info = iter.next_file(null))) {
                const n = info.get_name();
                const type = this._readFile(`/sys/class/power_supply/${n}/type`).trim();
                if (type === 'Mains' || type === 'USB' || type === 'USB_PD') {
                    const online = this._readFile(`/sys/class/power_supply/${n}/online`).trim();
                    if (online === '1') return true;
                }
            }
        } catch (_) {}
        return false;
    }

    _battery() {
        if (!this._batteryPath) return null;
        const capacity = Number(this._readFile(`${this._batteryPath}/capacity`).trim());
        const status = this._readFile(`${this._batteryPath}/status`).trim();
        const plugged = this._acOnline();

        /* Remaining time estimate (like Vitals): energy_now / power_now,
           or charge_now / current_now depending on driver. */
        const readNum = (f) => {
            const v = Number(this._readFile(`${this._batteryPath}/${f}`).trim());
            return Number.isFinite(v) ? v : 0;
        };
        const energyNow = readNum('energy_now') || readNum('charge_now');
        const powerNow  = readNum('power_now')  || readNum('current_now');
        const energyFull = readNum('energy_full') || readNum('charge_full');

        let minutes = null;
        if (powerNow > 0 && energyNow > 0) {
            if (status === 'Discharging') {
                minutes = Math.round((energyNow / powerNow) * 60);
            } else if (status === 'Charging' && energyFull > energyNow) {
                minutes = Math.round(((energyFull - energyNow) / powerNow) * 60);
            }
        }
        return {capacity, status, minutes, plugged};
    }

    render() {
        const s = this._stats;
        const box = new St.BoxLayout({style_class: 'notchex-sys', vertical: true, x_expand: true, y_expand: true});

        /* headline: CPU · Memory · Temperature · Battery */
        const headline = new St.BoxLayout({style_class: 'notchex-sys-headline', x_expand: true});
        const hcell = (label, value, cls) => {
            const c = new St.BoxLayout({style_class: 'notchex-sys-headline-cell', vertical: true, x_expand: true});
            c.add_child(new St.Label({text: label, style_class: 'notchex-sys-headline-label'}));
            const val = new St.Label({text: value, style_class: 'notchex-sys-headline-value'});
            if (cls) val.add_style_class_name(cls);
            c.add_child(val);
            return c;
        };
        headline.add_child(hcell('CPU', `${s.cpu.toFixed(0)}%`, this._level(s.cpu, 65, 85)));
        headline.add_child(hcell('MEMORY', `${s.ram.toFixed(0)}%`, this._level(s.ram, 75, 90)));
        if (s.temp > 0) headline.add_child(hcell('TEMP', `${s.temp.toFixed(0)}°C`, this._level(s.temp, 75, 90)));
        if (s.battery) {
            const timeStr = s.battery.minutes
                ? (s.battery.status === 'Charging' ? `${this._timeFmt(s.battery.minutes)} to full` : `${this._timeFmt(s.battery.minutes)} left`)
                : s.battery.status;
            headline.add_child(hcell('BATTERY', `${s.battery.capacity}%`, null));
            headline.get_last_child().add_child(new St.Label({text: timeStr, style_class: 'notchex-sys-headline-sub'}));
        }
        box.add_child(headline);

        const body = new St.BoxLayout({style_class: 'notchex-sys-body', x_expand: true, y_expand: true});

        /* left: utilisation bars */
        const bars = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'notchex-sys-bars'});
        const bar = (label, pct, value) => {
            const row = new St.BoxLayout({style_class: 'notchex-sys-bar-row', x_expand: true});
            row.add_child(new St.Label({text: label, style_class: 'notchex-sys-inline-label', y_align: Clutter.ActorAlign.CENTER}));
            const track = new St.BoxLayout({style_class: 'notchex-bar', y_align: Clutter.ActorAlign.CENTER});
            const clamped = Math.max(0, Math.min(100, pct));
            const fill = new St.Widget({style_class: 'notchex-bar-fill', x_expand: false});
            const lvl = this._level(clamped, 70, 88);
            if (lvl) fill.add_style_class_name(lvl);
            fill.set_style(`width: ${Math.round(1.6 * clamped)}px;`);
            track.add_child(fill);
            row.add_child(track);
            row.add_child(new St.Label({text: value, style_class: 'notchex-sys-inline-value', x_expand: true,
                x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER}));
            bars.add_child(row);
        };
        bar('CPU', s.cpu, `${s.cpu.toFixed(0)}%`);
        bar('Memory', s.ram, `${s.ram.toFixed(0)}%`);
        if (s.gpu !== null && s.gpu !== undefined) bar('GPU', s.gpu, `${s.gpu.toFixed(0)}%`);
        if (s.swap > 0) bar('Swap', s.swap, `${s.swap.toFixed(0)}%`);
        if (s.disk_total > 0) {
            const pct = (s.disk_used / s.disk_total) * 100;
            bar('Storage', pct, `${this._gbFmt(s.disk_used)} / ${this._gbFmt(s.disk_total)}`);
        }
        body.add_child(bars);

        /* right: rates + misc */
        const info = new St.BoxLayout({vertical: true, x_expand: true, style_class: 'notchex-sys-left'});
        const rows = [
            ['Network', `↓ ${this._kbFmt(s.net_rx)}   ↑ ${this._kbFmt(s.net_tx)}`],
            ['Disk',    `R ${this._kbFmt(s.disk_r)}   W ${this._kbFmt(s.disk_w)}`],
            ['Uptime',  this._upFmt(s.uptime)],
            ['Load',    s.load.map(x => x.toFixed(2)).join('  ')],
        ];
        for (const [label, value] of rows) {
            const row = new St.BoxLayout({style_class: 'notchex-sys-inline-row', x_expand: true});
            row.add_child(new St.Label({text: label, style_class: 'notchex-sys-inline-label'}));
            row.add_child(new St.Label({text: value, style_class: 'notchex-sys-inline-value', x_expand: true, x_align: Clutter.ActorAlign.END}));
            info.add_child(row);
        }
        body.add_child(info);
        box.add_child(body);

        return box;
    }

    _level(v, warn, danger) {
        if (v > danger) return 'danger';
        if (v > warn) return 'warn';
        return null;
    }

    _timeFmt(minutes) {
        if (minutes < 60) return `${minutes}m`;
        const h = Math.floor(minutes / 60);
        const m = minutes % 60;
        return m > 0 ? `${h}h ${m}m` : `${h}h`;
    }

    _gbFmt(bytes) {
        return `${(bytes / (1024 ** 3)).toFixed(0)} GB`;
    }

    _kbFmt(kb) {
        if (kb < 1)        return `${(kb * 1024).toFixed(0)} B/s`;
        if (kb < 1024)     return `${kb.toFixed(1)} KB/s`;
        return `${(kb / 1024).toFixed(2)} MB/s`;
    }

    _upFmt(sec) {
        const d = Math.floor(sec / 86400);
        const h = Math.floor((sec % 86400) / 3600);
        const m = Math.floor((sec % 3600) / 60);
        if (d > 0) return `${d}d ${h}h`;
        if (h > 0) return `${h}h ${m}m`;
        return `${m}m`;
    }
});
