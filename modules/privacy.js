import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

import * as Volume from 'resource:///org/gnome/shell/ui/status/volume.js';

/* Is any app using the camera or the microphone right now? Same sources as
   GNOME's own privacy indicators (Shell.CameraMonitor, and recording
   streams on the mixer), so it's event-driven and needs no polling. */

/* streams that "record" without being a microphone: level meters, and our
   own audio-reactive bars (they read the speaker monitor) */
const IGNORED_APPS = [
    'org.gnome.VolumeControl',
    'org.PulseAudio.pavucontrol',
    'io.notchex.Spectrum',
];

export const PrivacyWatcher = GObject.registerClass({
    Signals: {'changed': {}},
}, class PrivacyWatcher extends GObject.Object {
    _init() {
        super._init();
        this.mic = false;
        this.camera = false;
    }

    start() {
        try {
            this._cameraMonitor = new Shell.CameraMonitor();
            this._cameraMonitor.connectObject('notify::cameras-in-use', () => this._sync(), this);
        } catch (e) {
            /* older Shells have no camera monitor; the mic still works */
            this._cameraMonitor = null;
        }
        this._control = Volume.getMixerControl();
        this._control.connectObject(
            'stream-added', () => this._sync(),
            'stream-removed', () => this._sync(),
            this);
        this._sync();
    }

    stop() {
        this._cameraMonitor?.disconnectObject(this);
        this._cameraMonitor = null;
        this._control?.disconnectObject(this);
        this._control = null;
    }

    destroy() { this.stop(); }

    _sync() {
        const camera = !!this._cameraMonitor?.cameras_in_use;
        let mic = false;
        try {
            mic = this._control.get_source_outputs()
                .some(o => !IGNORED_APPS.includes(o.get_application_id()));
        } catch (_) {}
        if (mic === this.mic && camera === this.camera) return;
        this.mic = mic;
        this.camera = camera;
        this.emit('changed');
    }
});
