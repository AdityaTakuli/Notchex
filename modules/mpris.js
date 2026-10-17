import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const MPRIS_PREFIX = 'org.mpris.MediaPlayer2.';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_IFACE = 'org.mpris.MediaPlayer2.Player';
const ROOT_IFACE = 'org.mpris.MediaPlayer2';

const PLAYER_IFACE_XML = `
<node>
  <interface name="org.mpris.MediaPlayer2.Player">
    <property name="PlaybackStatus" type="s" access="read"/>
    <property name="Metadata"       type="a{sv}" access="read"/>
    <property name="CanGoNext"      type="b" access="read"/>
    <property name="CanGoPrevious"  type="b" access="read"/>
    <property name="CanPlay"        type="b" access="read"/>
    <property name="CanPause"       type="b" access="read"/>
    <property name="CanSeek"        type="b" access="read"/>
    <property name="Rate"           type="d" access="read"/>
    <method name="PlayPause"/>
    <method name="Next"/>
    <method name="Previous"/>
    <method name="Play"/>
    <method name="Pause"/>
    <method name="Stop"/>
    <method name="SetPosition">
      <arg type="o" direction="in" name="TrackId"/>
      <arg type="x" direction="in" name="Position"/>
    </method>
    <signal name="Seeked">
      <arg type="x" name="Position"/>
    </signal>
  </interface>
</node>`;

/* makeProxyWrapper only binds the FIRST interface of the XML, so the
   root org.mpris.MediaPlayer2 interface (Identity, DesktopEntry, Raise)
   is read with explicit calls instead of being declared here. */
const PlayerProxy = Gio.DBusProxy.makeProxyWrapper(PLAYER_IFACE_XML);

function _unwrap(v) {
    return (v && typeof v.deep_unpack === 'function') ? v.deep_unpack() : v;
}

function _extractMeta(metadata) {
    if (!metadata) return {};
    const get = (key) => {
        const v = metadata[key];
        if (!v) return null;
        return _unwrap(v);
    };
    const artist = get('xesam:artist');
    return {
        title:   get('xesam:title')  ?? '',
        artist:  Array.isArray(artist) ? artist.join(', ') : (artist ?? ''),
        album:   get('xesam:album')  ?? '',
        artUrl:  get('mpris:artUrl') ?? '',
        length:  Number(get('mpris:length') ?? 0),
        trackId: get('mpris:trackid') ?? '',
    };
}

/* Watches every MPRIS player on the session bus (Spotify, browsers, VLC,
   Rhythmbox, …) and reports the most relevant one — the first Playing,
   otherwise the first Paused.
   Signals:
     'changed'       — full info object whenever anything changes
     'track-changed' — info when a *new* track starts playing (drives the
                       "Now Playing" island event; not emitted for players
                       that were already playing when the watcher started)
     'seeked'        — position jumped (seek) on the active player */
export const MprisWatcher = GObject.registerClass({
    Signals: {
        'changed':       {param_types: [GObject.TYPE_JSOBJECT]},
        'track-changed': {param_types: [GObject.TYPE_JSOBJECT]},
        'seeked':        {},
    },
}, class MprisWatcher extends GObject.Object {
    _init() {
        super._init();
        this._players = new Map();
        this._active   = null;
        this._info     = {playing: false, paused: false};
    }

    start() {
        this._stopped = false;
        this._startedAt = GLib.get_monotonic_time();
        this._nameOwnerId = Gio.DBus.session.signal_subscribe(
            'org.freedesktop.DBus',
            'org.freedesktop.DBus',
            'NameOwnerChanged',
            '/org/freedesktop/DBus',
            null,
            Gio.DBusSignalFlags.NONE,
            (conn, sender, path, iface, signal, params) => {
                const [name, oldOwner, newOwner] = params.deepUnpack();
                if (!name.startsWith(MPRIS_PREFIX)) return;
                if (newOwner && !oldOwner) this._addPlayer(name);
                if (oldOwner && !newOwner) this._removePlayer(name);
            });
        this._listExistingPlayers().catch(e => logError(e, 'notchex:mpris'));
    }

    stop() {
        this._stopped = true;
        if (this._nameOwnerId) {
            try { Gio.DBus.session.signal_unsubscribe(this._nameOwnerId); } catch (_) {}
            this._nameOwnerId = 0;
        }
        for (const [, proxy] of this._players) this._disconnectProxy(proxy);
        this._players.clear();
        this._active = null;
        this._lastTrackKey = null;
    }

    destroy() { this.stop(); }

    async _listExistingPlayers() {
        const reply = await new Promise((resolve, reject) => {
            Gio.DBus.session.call(
                'org.freedesktop.DBus',
                '/org/freedesktop/DBus',
                'org.freedesktop.DBus',
                'ListNames',
                null, null,
                Gio.DBusCallFlags.NONE,
                -1, null,
                (_, res) => {
                    try { resolve(Gio.DBus.session.call_finish(res)); }
                    catch (e) { reject(e); }
                });
        });
        const [names] = reply.deepUnpack();
        for (const n of names) if (n.startsWith(MPRIS_PREFIX)) this._addPlayer(n);
    }

    _addPlayer(busName) {
        if (this._stopped || this._players.has(busName)) return;
        /* Async construction: a hung player must never block the shell. */
        PlayerProxy(Gio.DBus.session, busName, MPRIS_PATH, (proxy, error) => {
            if (error || this._stopped || this._players.has(busName)) return;
            proxy._propChangedId = proxy.connect('g-properties-changed', () => {
                if (!this._stopped) this._recompute();
            });
            proxy._seekedId = proxy.connectSignal('Seeked', () => {
                if (!this._stopped && this._active?.proxy === proxy) this.emit('seeked');
            });
            proxy._root = {};
            this._players.set(busName, proxy);
            this._recompute();
            this._fetchRootProps(proxy);
        });
    }

    _fetchRootProps(proxy) {
        proxy.g_connection.call(
            proxy.g_name, MPRIS_PATH,
            'org.freedesktop.DBus.Properties', 'GetAll',
            new GLib.Variant('(s)', [ROOT_IFACE]),
            new GLib.VariantType('(a{sv})'),
            Gio.DBusCallFlags.NONE, 2000, null,
            (conn, res) => {
                try {
                    const [props] = conn.call_finish(res).recursiveUnpack();
                    proxy._root = props ?? {};
                } catch (_) { return; }
                if (!this._stopped && this._players.has(proxy.g_name)) this._recompute();
            });
    }

    _removePlayer(busName) {
        const proxy = this._players.get(busName);
        if (!proxy) return;
        this._disconnectProxy(proxy);
        this._players.delete(busName);
        this._recompute();
    }

    _disconnectProxy(proxy) {
        try { if (proxy._propChangedId) proxy.disconnect(proxy._propChangedId); } catch (_) {}
        try { if (proxy._seekedId) proxy.disconnectSignal(proxy._seekedId); } catch (_) {}
        proxy._propChangedId = 0;
        proxy._seekedId = 0;
    }

    _recompute() {
        let best = null;
        for (const [name, proxy] of this._players) {
            try {
                const status = proxy.PlaybackStatus;
                if (status === 'Playing') { best = {name, proxy, status}; break; }
                if (!best && status === 'Paused') best = {name, proxy, status};
            } catch (_) {}
        }
        if (!best) {
            this._active = null;
            this._info = {playing: false, paused: false};
            this.emit('changed', this._info);
            return;
        }
        const desktop = best.proxy._root?.DesktopEntry ?? '';
        const identity = best.proxy._root?.Identity ?? '';
        let meta = {};
        try { meta = _extractMeta(best.proxy.Metadata); } catch (_) {}
        const flag = (prop, dflt) => {
            try {
                const v = best.proxy[prop];
                return v === null || v === undefined ? dflt : !!v;
            } catch (_) { return dflt; }
        };
        this._active = best;
        this._info = {
            playing: best.status === 'Playing',
            paused:  best.status === 'Paused',
            icon: desktop || 'audio-x-generic-symbolic',
            identity,
            bus: best.name,
            title:   meta.title,
            artist:  meta.artist,
            album:   meta.album,
            artUrl:  meta.artUrl,
            length:  meta.length,
            trackId: meta.trackId,
            canNext:  flag('CanGoNext', true),
            canPrev:  flag('CanGoPrevious', true),
            canPlay:  flag('CanPlay', true),
            canPause: flag('CanPause', true),
            canSeek:  flag('CanSeek', false) && meta.length > 0 && !!meta.trackId,
        };
        this.emit('changed', this._info);

        const trackKey = `${best.name}|${meta.title}|${meta.artist}`;
        if (this._info.playing && meta.title && trackKey !== this._lastTrackKey) {
            const first = this._lastTrackKey === undefined || this._lastTrackKey === null;
            this._lastTrackKey = trackKey;
            /* Players already playing when the watcher starts (login, or
               extension reload) are not "new" — skip the event for them. */
            const settled = GLib.get_monotonic_time() - this._startedAt > 3 * GLib.USEC_PER_SEC;
            if (!first || settled) this.emit('track-changed', this._info);
        }
    }

    info() { return this._info; }
    isActive() { return !!this._active; }

    playPause() { this._callActive('PlayPauseRemote'); }
    next()      { this._callActive('NextRemote'); }
    previous()  { this._callActive('PreviousRemote'); }
    raise() {
        const proxy = this._active?.proxy;
        if (!proxy) return;
        proxy.g_connection.call(proxy.g_name, MPRIS_PATH, ROOT_IFACE, 'Raise',
            null, null, Gio.DBusCallFlags.NONE, -1, null, () => {});
    }

    /* microseconds */
    setPosition(usec) {
        const info = this._info;
        if (!this._active?.proxy || !info?.canSeek) return;
        const pos = Math.max(0, Math.min(info.length, Math.round(usec)));
        try {
            this._active.proxy.SetPositionRemote(info.trackId, pos, () => {});
        } catch (e) { logError(e, 'notchex:mpris:seek'); }
    }

    /* Position is not announced via PropertiesChanged, so it has to be
       read explicitly. Async; resolves to microseconds or null. */
    fetchPosition() {
        const proxy = this._active?.proxy;
        if (!proxy) return Promise.resolve(null);
        return new Promise(resolve => {
            proxy.g_connection.call(
                proxy.g_name, MPRIS_PATH,
                'org.freedesktop.DBus.Properties', 'Get',
                new GLib.Variant('(ss)', [PLAYER_IFACE, 'Position']),
                new GLib.VariantType('(v)'),
                Gio.DBusCallFlags.NONE, 1000, null,
                (conn, res) => {
                    try {
                        const [v] = conn.call_finish(res).deepUnpack();
                        resolve(Number(v.deepUnpack()));
                    } catch (_) { resolve(null); }
                });
        });
    }

    _callActive(method) {
        if (!this._active?.proxy) return;
        try { this._active.proxy[method](() => {}); } catch (e) { logError(e, 'notchex:mpris:call'); }
    }
});
