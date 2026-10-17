import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Shell from 'gi://Shell';
import St from 'gi://St';

/* macOS-style instant full-screen screenshot (⌘⇧3): captures the whole
   screen with GNOME's own compositor capture, copies the PNG to the
   clipboard and saves it to ~/Pictures/Screenshots like GNOME does.
   Resolves to the saved path (or null if saving to disk is locked down). */

function screenshotsDir() {
    const pics = GLib.get_user_special_dir(GLib.UserDirectory.DIRECTORY_PICTURES) || GLib.get_home_dir();
    return GLib.build_filenamev([pics, 'Screenshots']);
}

function capture(shooter, stream) {
    /* GNOME's screenshot module promisifies this; don't rely on it */
    return new Promise((resolve, reject) => {
        shooter.screenshot(false, stream, (s, res) => {
            try { resolve(s.screenshot_finish(res)); } catch (e) { reject(e); }
        });
    });
}

export async function takeScreenshot() {
    const shooter = new Shell.Screenshot();
    const stream = Gio.MemoryOutputStream.new_resizable();
    await capture(shooter, stream);
    stream.close(null);
    const bytes = stream.steal_as_bytes();

    global.display.get_sound_player().play_from_theme('screen-capture', 'Screenshot taken', null);
    St.Clipboard.get_default().set_content(St.ClipboardType.CLIPBOARD, 'image/png', bytes);

    try {
        const lockdown = new Gio.Settings({schema_id: 'org.gnome.desktop.lockdown'});
        if (lockdown.get_boolean('disable-save-to-disk')) return null;
    } catch (_) {}

    const dir = screenshotsDir();
    GLib.mkdir_with_parents(dir, 0o755);
    const stamp = GLib.DateTime.new_now_local().format('%Y-%m-%d %H-%M-%S');
    let path = GLib.build_filenamev([dir, `Screenshot from ${stamp}.png`]);
    for (let i = 1; GLib.file_test(path, GLib.FileTest.EXISTS); i++)
        path = GLib.build_filenamev([dir, `Screenshot from ${stamp}-${i}.png`]);

    const file = Gio.File.new_for_path(path);
    await new Promise((resolve, reject) => {
        file.replace_contents_bytes_async(bytes, null, false, Gio.FileCreateFlags.NONE, null, (f, res) => {
            try { f.replace_contents_finish(res); resolve(); } catch (e) { reject(e); }
        });
    });
    return path;
}
