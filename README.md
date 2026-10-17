<div align="center">

# Notchex

**A Dynamic Island and a macOS-style desktop for GNOME.**

[![GNOME Shell 46–50](https://img.shields.io/badge/GNOME%20Shell-46%20%E2%80%93%2050-4A86CF?logo=gnome&logoColor=white)](https://www.gnome.org/)
[![License: GPL-3.0+](https://img.shields.io/badge/License-GPL--3.0%2B-blue.svg)](LICENSE)
[![Wayland](https://img.shields.io/badge/Wayland-ready-success)](#compatibility)
[![X11](https://img.shields.io/badge/X11-compatible-success)](#compatibility)
[![No build step](https://img.shields.io/badge/build%20step-none-lightgrey)](#development)

</div>

Notchex puts an iPhone-style **Dynamic Island** at the top of your GNOME screen. It replaces the top-bar clock, shows what's going on (music, timers, meetings), briefly grows for events such as a track change, a volume change, a Bluetooth device connecting or a notification arriving, and expands into a tabbed hub when you hover over it.

Around the island, Notchex adds the rest of the macOS feel: a **magnifying Dock**, **Spotlight search** inside the island, **frosted-glass** top bar and menus, a **Control Center** look for Quick Settings, an **auto-hiding top bar**, **three-finger zoom** gestures and optional **traffic-light window buttons**.

It's plain GJS on top of St/Clutter. There's no Electron, no npm and no build step. Everything in the idle island is driven by signals, so it does almost nothing until something actually changes.

<!--
  Screenshots: drop images into docs/ and uncomment.
  <p align="center"><img src="docs/island.png" width="720" alt="The island expanded on the System tab"></p>
  <p align="center"><img src="docs/dock-spotlight.png" width="720" alt="Dock and Spotlight search"></p>
-->

---

## Contents

- [Features](#features)
  - [The island](#the-island)
  - [Live activities](#live-activities)
  - [Hub tabs](#hub-tabs)
  - [Dock](#dock)
  - [Spotlight search](#spotlight-search)
  - [Desktop polish](#desktop-polish)
- [Installation](#installation)
- [Keyboard shortcuts and gestures](#keyboard-shortcuts-and-gestures)
- [Configuration](#configuration)
- [Setting up integrations](#setting-up-integrations)
- [Privacy and network access](#privacy-and-network-access)
- [Performance](#performance)
- [Compatibility](#compatibility)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Project layout](#project-layout)
- [Migrating from NexNotch](#migrating-from-nexnotch)
- [Credits](#credits)
- [License](#license)

---

## Features

### The island

One rounded surface sits at the top center of your primary monitor and changes shape to show what's relevant.

| State | What you see |
|---|---|
| **Idle** | A capsule showing date, time and battery. While music plays it adds album art, the track and **audio-reactive equalizer bars**. While a Pomodoro runs it shows the countdown. It can also show the temperature or CPU/RAM. |
| **Hover** | Expands into the hub (the default). With *Expand on hover* turned off, hovering shows a compact second line instead (track, next meeting, timer) and a click expands it. |
| **Expanded** | A tabbed dashboard. The island resizes to fit each tab. Click the clock header or press `Super + N` to fold it. |
| **Event** | Briefly grows for a live activity, then goes back to what it was showing. |

There are two shapes: **notch**, which attaches to the top screen edge with rounded bottom corners like a MacBook, and **floating**, a fully rounded pill with a configurable gap from the edge.

### Live activities

Every source is signal-driven. None of them poll.

| Event | Source |
|---|---|
| **Now Playing**: album art, title, artist | MPRIS: Spotify, Firefox/Chromium (YouTube, YT Music…), VLC, Rhythmbox and any other MPRIS player |
| **Volume**: level bar, mute | The Shell's PulseAudio/PipeWire mixer (default sink) |
| **Brightness**: level bar | gnome-settings-daemon `Power.Screen` |
| **Battery**: charging, on battery, full, low (20 %), critical (10 %) | UPower `DisplayDevice` |
| **Bluetooth**: device connected or disconnected, with its battery level | BlueZ `Device1` / `Battery1` |
| **Notifications**: icon, title and body; click to open, ✕ to dismiss | GNOME message tray (respects Do Not Disturb) |
| **Upcoming meeting**: "In 10 min", then "Starting now" | Shell `CalendarServer` (GNOME Online Accounts calendars) |
| **App launch** | Launches from the Dock or Spotlight |
| **Screenshot**: thumbnail, click to open | Notchex's instant full-screen capture |

When several events arrive at once, the most important one wins: critical battery, then notification, media, Bluetooth, volume, brightness and calendar. Less important events wait briefly and are dropped if they go stale. Repeated events of the same kind, such as holding a volume key, update in place instead of animating again.

GNOME's own volume and brightness popup is hidden while the island shows the change. It still appears whenever the island can't show it, for example when the island is expanded, a fullscreen app is open, or a more important event is on screen.

### Hub tabs

| Tab | What it does |
|---|---|
| **System** | CPU, memory, GPU (AMD and Intel Xe through `gpu_busy_percent`), swap and storage bars; temperature, battery, network, disk I/O, uptime and load. |
| **Media** | Large album art, title, artist and album, a seekable progress bar, and previous / play-pause / next. |
| **Calendar** | Google Calendar events through your existing GNOME Online Accounts setup, with no extra login. You can filter by account. |
| **Tasks** | Google Tasks (through the Tasks REST API with your GOA token). You can add tasks from the island and filter by list. |
| **Weather** | Two locations, condition icons and a 3-day forecast. Uses the free wttr.in backend and accepts city names, districts, GPS coordinates and airport codes. |
| **Timer** | Pomodoro with presets (50/10, 25/5, 10/2, or your own), a progress ring and cycle tracking. Sessions are logged to JSONL. |
| **Notes** | Sticky notes saved as Markdown files, one dated folder per day. Fully keyboard-accessible. |
| **Stats** | Pomodoro dashboard: today, a weekly chart and your current streak. |
| **Quick** | Wi-Fi, Bluetooth, Night Light and Focus (Do Not Disturb) toggles; volume and brightness sliders; microphone, camera and keyboard-layout indicators; Bluetooth battery levels; Screenshot, Settings, Lock and Suspend; and Log out / Reboot / Shutdown, which need **two taps** to confirm. |
| **Limits** | Claude Code session and weekly usage rings. |

You can turn each tab on or off in preferences.

### Dock

A macOS-style Dock built on GNOME's own favorites, so it uses the same pinned apps as the Overview dash.

- Icons **magnify** under the pointer, with adjustable strength
- Can sit at the **bottom, left or right**
- Three visibility modes: **always** shown (windows make room), **autohide** (appears when the pointer reaches the edge) and **intelligent** (hides when a window overlaps it)
- Running indicators, window previews on hover, app-name tooltips and a bounce on launch
- Drag an icon out of the Dock to unpin it
- **Trash** with a full/empty state, and separators between pinned apps, running apps and the Trash
- Auto, dark or light surface, adjustable opacity, corner radius and edge gap
- Frosted-glass background (see [Desktop polish](#desktop-polish))

If Ubuntu Dock or Dash to Dock is also enabled, preferences shows a warning so you don't end up with two docks.

### Spotlight search

Press `Super + Space` and the island grows into a wide search field.

- Searches **apps**, **Settings panels**, **system actions** (lock, suspend, restart, shut down, log out, screenshot) and **files** (through the Files app's Tracker index)
- Includes a **calculator**: type `12*7+3` to get the answer
- Can keep a **history** of recently opened results
- Fully keyboard-driven: `↑` / `↓` move, `Tab` jumps between categories, `Enter` opens, `Esc` closes
- Optionally **replaces the Overview's search bar**, so typing in the Overview opens Spotlight instead
- Typing is debounced and stale file searches are cancelled, so it stays responsive

### Desktop polish

All of these can be turned off individually.

- **Frosted glass.** The top bar, its menus (Quick Settings, calendar, indicators) and the Dock blur whatever is behind them, with rounded corners and a hairline border. GNOME's blur has no corner radius, so Notchex masks a blurred clone of the windows to each rounded shape with a small shader. The blur is off on the lock screen, so it never shows windows there.
- **Control Center.** Quick Settings is restyled to look like macOS Control Center: rounded tiles with a round icon that turns blue when on, wide sliders in their own modules, and round buttons.
- **Auto-hiding top bar.** The GNOME top bar slides away and comes back when the pointer touches the top edge outside the island, while a panel menu is open, or in the Overview. Maximized windows stop just below the island. Optionally, the strip beside the island is painted black while a window is open, so the top looks like one continuous MacBook bar.
- **Screen zoom.** Pinch with three fingers to zoom in and out, or double-tap with three fingers to toggle zoom. This drives GNOME's own magnifier, so the Accessibility settings stay in sync.
- **Traffic-light window buttons.** Red, yellow and green close / minimize / zoom buttons on the left of every GTK 3 and GTK 4 app. Notchex remembers your previous button layout and restores it when you turn the option off. Apps pick up the change after a restart.
- **macOS-style app icons (optional).** The Dock, Spotlight and the island can use macOS-style icons from [macOSicons.com](https://macosicons.com) (this needs your own API key), or your own icon for any app. Native GNOME icons are always the fallback.

---

## Installation

### Requirements

- GNOME Shell **46, 47, 48, 49 or 50**
- Wayland or X11

See [Optional dependencies](#optional-dependencies) for features that rely on extra packages.

### One-line install (recommended)

```sh
curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/Notchex/main/install.sh | bash
```

Then **log out and log back in**. On X11 you can press `Alt + F2`, type `r` and press `Enter` instead.

The script checks your GNOME version, downloads the latest release, installs it for your user only (no `sudo`) and turns it on. Run the same command again to update. Prefer to read it first? [`install.sh`](install.sh) is short.

```sh
# a specific version
curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/Notchex/main/install.sh | bash -s -- --version v2.0.0
```

### From a release zip

Download `notchex@adityatakuli.shell-extension.zip` from [Releases](https://github.com/AdityaTakuli/Notchex/releases/latest), then:

```sh
gnome-extensions install --force notchex@adityatakuli.shell-extension.zip
```

Log out and back in, then run `gnome-extensions enable notchex@adityatakuli`.

### From source

```sh
git clone https://github.com/AdityaTakuli/Notchex.git
cd Notchex
make install
```

Log out and back in, then:

```sh
gnome-extensions enable notchex@adityatakuli
gnome-extensions prefs notchex@adityatakuli     # open preferences
```

### Uninstall

```sh
curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/Notchex/main/install.sh | bash -s -- --uninstall
```

Or, from a source checkout: `gnome-extensions disable notchex@adityatakuli && make uninstall`.

If you turned on traffic-light window buttons, turn them off in preferences **before** uninstalling so your original button layout and `gtk.css` are restored.

### Recommended: disable overlapping extensions

Notchex covers what several popular extensions do. Running both can cause visual conflicts:

```sh
gnome-extensions disable ubuntu-dock@ubuntu.com          # the Notchex Dock replaces it
gnome-extensions disable dash-to-dock@micxgx.gmail.com
gnome-extensions disable Vitals@CoreCoding.com           # covered by the System tab
```

---

## Keyboard shortcuts and gestures

| Input | Action |
|---|---|
| `Super + N` | Expand or collapse the island |
| `Super + Space` | Open Spotlight search |
| `↑` `↓` / `Tab` / `Enter` / `Esc` | Navigate, switch category, open and close in Spotlight |
| `Alt + Super + 8` | Toggle screen zoom (GNOME default) |
| `Alt + Super + =` / `-` | Zoom in or out (GNOME default) |
| Three-finger pinch | Zoom the screen in or out |
| Three-finger double-tap | Toggle zoom |

You can remap both Notchex shortcuts on the **Shortcuts** page in preferences.

> **Note:** `Super + Space` is also GNOME's keyboard-layout switcher. If you have more than one input layout, preferences warns you so you can pick a different Spotlight shortcut.

---

## Configuration

Open preferences with `gnome-extensions prefs notchex@adityatakuli`, from the Extensions app, or by searching **"Notchex Settings"** in Spotlight.

| Page | What you can change |
|---|---|
| **General** | Which modules are on, the system-monitor poll interval, hiding GNOME's clock, zoom gestures |
| **Appearance** | Shape (notch or floating), corner radius, sizes, outline, top margin; background, text, accent, outline and shadow colors with presets (Island, Glass, Graphite, Nord, Dracula); animation speed and hover/collapse delays; behavior (expand on hover or click, auto-collapse, pill contents, auto-hiding top bar, painting the strip beside the island, audio-reactive bars); traffic-light window buttons; battery icon colors; glass blur strength and which surfaces use it; Control Center style |
| **Live Activities** | A toggle for each event, how long ahead to announce meetings, how long events stay on screen, and whether the island replaces GNOME's volume/brightness popup |
| **Dock** | On or off, position, icon size, magnification, visibility mode, theme, opacity, corner radius, edge gap, Trash, running indicators, previews, tooltips, launch bounce, separators |
| **Search** | On or off, shortcut, replacing the Overview search, including files, history (and clearing it) |
| **Icons** | Icon source (GNOME, macOS-style or custom), your macOSicons.com API key, how often cached icons refresh, custom icons for each app, icon credits |
| **Weather** | Primary and secondary location with friendly labels, units, refresh interval |
| **Claude** | Usage refresh interval |
| **Notes** | Notes folder (default `~/Documents/Notchex Notes`) |
| **Pomodoro** | Presets, long break length, cycles before a long break |
| **Calendar & Tasks** | Which GOA accounts and task lists to show |
| **Shortcuts** | Toggle and search shortcuts |
| **Clock** | Date, seconds, 12h or 24h |
| **Notifications** | Auto-dismiss time, suppressing GNOME's own banner, Do Not Disturb mirroring |

All settings live in GSettings under `org.gnome.shell.extensions.notchex`, so you can also script them:

```sh
gsettings --schemadir ~/.local/share/gnome-shell/extensions/notchex@adityatakuli/schemas \
  set org.gnome.shell.extensions.notchex island-style 'floating'
```

---

## Setting up integrations

### Google Calendar and Tasks

1. Open **Settings → Online Accounts** and add your Google account.
2. Make sure **Calendar** is switched on for that account.
3. That's it. The Calendar and Tasks tabs pick the account up automatically. Use the **Calendar & Tasks** page in preferences to limit which accounts or lists are shown.

### Weather

Set a location on the **Weather** page. You can use a city (`Berlin`), a district (`Kadıköy`), coordinates (`52.52,13.40`) or an airport code (`SFO`). Leave it empty to detect your location from your IP address. You can add a second location, for example for work.

### Claude Code usage

Install the [Claude Code](https://docs.claude.com/en/docs/claude-code) CLI and run `claude` once to sign in. The **Limits** tab reads the login that the CLI stores in `~/.claude/.credentials.json` and shows your current session and weekly usage. If it says the session expired, run `claude` again.

### macOS-style icons

1. Get a free API key at [macosicons.com](https://macosicons.com).
2. On the **Icons** page, paste the key and set *Icon source* to **macOS-style**.
3. Icons are looked up one app at a time and cached in `~/.cache/notchex/icons`. The key is stored in your **GNOME keyring**, not in settings.

To use your own icon for any app, pick a custom icon on the same page, or drop an image into `~/.local/share/notchex/icons/`.

---

## Privacy and network access

Notchex runs locally. It only connects to the network for features you use:

| Destination | When | What is sent |
|---|---|---|
| `wttr.in` | Weather tab is on | Your configured location (or your IP, if no location is set) |
| `tasks.googleapis.com` | Tasks tab is on | Your GOA OAuth token, to read and create tasks |
| `api.anthropic.com` | Limits tab is on | Your local Claude Code OAuth token, to read usage |
| `api.macosicons.com` | Only if you set an API key and chose macOS-style icons | App names, one at a time |
| Album-art hosts | When a player provides remote art (e.g. Spotify) | A download of the art URL the player reports |

Calendar events come from GNOME's local CalendarServer. Access tokens are kept in memory only and never written to disk. Spotlight file results come from the local Tracker index. Notchex has **no telemetry**.

Files Notchex writes:

| Path | Contents |
|---|---|
| `~/.cache/notchex/art` | Album-art cache (capped at 64 files) |
| `~/.cache/notchex/icons` | Downloaded macOS-style icons and their attribution |
| `~/.local/share/notchex/` | Pomodoro session log, custom icons |
| `~/Documents/Notchex Notes/` | Your notes (configurable) |
| `~/.config/gtk-{3,4}.0/gtk.css` | Only when traffic-light buttons are on: a clearly marked block that is removed when you turn them off |

---

## Performance

- **Idle:** the clock ticks once a minute, aligned to the minute. The only other timers are slow refreshes: weather every 30 minutes, the calendar range every 5 minutes, tasks every 10 minutes and Claude usage every 15 minutes. Everything else in the idle island reacts to signals.
- **System stats** are polled only while the System tab is on screen (every second by default), or at three times the interval if CPU/RAM is shown in the pill. Otherwise they aren't polled at all.
- **Media progress** uses a one-second timer that exists only while the Media tab is visible and a track is playing.
- **Audio-reactive bars** run in a **separate process** (`spectrum-helper.js`) that reads the speaker output, never the microphone. It runs only while music plays and the pill is visible, so a stalled audio pipeline can never freeze the compositor.
- **Quick tab** checks run every 15 seconds, only while the tab is visible. Its NetworkManager and rfkill clients are created the first time the tab opens.
- **Animations** move only the island itself. Tab content is laid out once at its final width, so nothing reflows on every frame.
- All async work runs through `Gio.Cancellable`, so disabling the extension never leaves calls pending on destroyed objects. Modules you turn off stop completely.

---

## Compatibility

| | Status |
|---|---|
| GNOME Shell 46, 47, 48, 49, 50 | Supported. Version differences are isolated in `modules/compat.js` |
| Wayland | Fully supported |
| X11 | Fully supported |
| Multi-monitor | The island and Dock live on the primary monitor |
| HiDPI / fractional scaling | Supported |
| Ubuntu, Fedora, Arch, Debian, openSUSE | Any distro with a supported GNOME version |

### Optional dependencies

Features that need these turn themselves off if they're missing:

| Package | Used for |
|---|---|
| `libsoup3` (`gir1.2-soup-3.0`) | Weather, Tasks, Claude usage, macOS-style icons |
| `libsecret` (`gir1.2-secret-1`) | Storing the macOSicons API key in the keyring |
| GStreamer + PulseAudio/PipeWire-Pulse plugins | Audio-reactive equalizer bars |
| `evolution-data-server` | Calendar events (usually already installed with GNOME) |
| Nautilus / Tracker | File results in Spotlight |

---

## Troubleshooting

**The extension doesn't show up after `make install`.**
On Wayland you have to log out and back in. Then run `gnome-extensions list | grep notchex` to check that it's detected.

**The Calendar tab is empty.**
Make sure the Google account in Online Accounts has *Calendar* switched on. On some distros the Evolution source registry doesn't start by itself, so Notchex starts `evolution-source-registry` once when it's enabled. If the tab is still empty, log out and back in.

**There are two docks.**
Disable Ubuntu Dock or Dash to Dock (see [Recommended: disable overlapping extensions](#recommended-disable-overlapping-extensions)), or turn off the Notchex Dock under **Dock**.

**`Super + Space` doesn't open Spotlight.**
You probably have several keyboard layouts, and GNOME uses that shortcut to switch between them. Set another shortcut on the **Search** page.

**Automatic brightness changes keep popping up.**
Turn off *Screen brightness* under **Live Activities**.

**There's no GPU usage.**
GPU usage only appears where the kernel driver exposes `gpu_busy_percent` (AMD and some Intel). NVIDIA would need `nvidia-smi` on every tick, which Notchex deliberately avoids.

**Window buttons didn't change.**
Restart the app. Sandboxed Flatpak and Snap apps that don't read `~/.config/gtk-*` keep their own buttons.

**Something else is wrong.**
Watch the logs while you reproduce it, then [open an issue](https://github.com/AdityaTakuli/Notchex/issues) and include the output:

```sh
make logs      # journalctl -f -o cat /usr/bin/gnome-shell
```

---

## Development

There's no build step. GNOME Shell loads the `.js` files directly.

```sh
make                  # compile the GSettings schema
make install          # copy into ~/.local/share/gnome-shell/extensions/notchex@adityatakuli
make pack             # build notchex@adityatakuli.shell-extension.zip (with gnome-extensions)
make dist             # build the same zip with plain zip (used by the release workflow)
make logs             # follow GNOME Shell logs
make uninstall
make clean
```

To test without logging out, run a nested GNOME Shell session:

```sh
# GNOME 46–48
dbus-run-session -- gnome-shell --nested --wayland
# GNOME 49+
dbus-run-session -- gnome-shell --devkit --wayland
```

### Conventions

- Pure ES modules. No npm, no `node_modules`, no transpiler.
- Each module owns its own `start()` / `stop()` (or `destroy()`) lifecycle and cancels its own async work.
- Settings keys go in `schemas/org.gnome.shell.extensions.notchex.gschema.xml` and are read through `Gio.Settings`.
- GNOME-version differences go in `modules/compat.js` and nowhere else.
- Async I/O uses GLib async primitives, never synchronous calls on the shell thread.
- External programs are looked up with `GLib.find_program_in_path()` first.
- Animations go through `modules/animations.js`, so the island, Dock and Spotlight share one style of motion.

### Contributing

1. Fork the repo and create a branch: `git checkout -b feature/my-change`.
2. Test on at least one supported GNOME version, on Wayland if you can.
3. Keep PRs focused and describe what you tested.
4. Open a pull request.

---

## Project layout

```
notchex@adityatakuli/
├── metadata.json             # UUID, supported shell versions
├── extension.js              # enable/disable; mounts the island, Dock, Spotlight, zoom, glass
├── notch.js                  # the island: geometry, animation, hover/click, tabs, events
├── prefs.js                  # Adwaita preferences window
├── stylesheet.css
├── Makefile
├── schemas/
│   └── org.gnome.shell.extensions.notchex.gschema.xml
└── modules/
    ├── events.js             # event queue: priorities, expiry, in-place updates
    ├── activities.js         # event builders (volume, media, battery, launch, …)
    ├── osd.js                # optional takeover of GNOME's volume/brightness popup
    ├── animations.js         # shared motion language
    ├── compat.js             # GNOME 46–50 differences
    │
    ├── mpris.js              # MPRIS watcher: metadata, position, seek
    ├── media.js              # Media tab, album-art tiles, equalizer bars
    ├── spectrum-helper.js    # out-of-process audio analyser for the bars
    ├── artwork.js            # async album-art resolver and cache
    ├── volume.js             # default sink through the Shell's mixer
    ├── brightness.js         # gnome-settings-daemon screen brightness
    ├── battery.js            # UPower state and transitions
    ├── bluetooth.js          # BlueZ devices and battery
    ├── notifications.js      # message tray hook
    │
    ├── system.js             # CPU/mem/net/disk from /proc, hwmon thermals, GPU
    ├── calendar.js           # CalendarServer events, Google Tasks REST
    ├── goa.js                # GNOME Online Accounts and OAuth tokens
    ├── weather.js            # wttr.in, two locations
    ├── pomodoro.js           # timer, presets, JSONL log
    ├── stats.js              # Pomodoro dashboard
    ├── notes.js              # Markdown notes
    ├── quick.js              # toggles, sliders, privacy indicators, power actions
    ├── claudeusage.js        # Claude Code usage rings
    ├── screenshot.js         # instant full-screen capture
    │
    ├── dock.js               # the Dock
    ├── search.js             # Spotlight UI
    ├── search-providers.js   # apps, settings, actions, calculator, files
    ├── icon-manager.js       # one icon pipeline for Dock, Spotlight and island
    ├── icon-provider.js      #   shared paths and base
    ├── system-icon-provider.js
    ├── local-icon-provider.js
    ├── macosicons-provider.js
    ├── glass.js              # frosted glass with a rounded blur mask
    ├── topbar.js             # auto-hiding top bar
    ├── window-style.js       # traffic-light window buttons
    └── zoom.js               # three-finger zoom gestures
```

---

## Migrating from NexNotch

Notchex started as a fork of [NexNotch](https://github.com/NexVar/NexNotch) and has a new UUID and settings schema, so the two can be installed side by side. Coming from NexNotch:

- Disable NexNotch first: `gnome-extensions disable nexnotch@nexvar`.
- Settings don't carry over automatically. To copy them across, run:
  ```sh
  dconf dump /org/gnome/shell/extensions/nexnotch/ | dconf load /org/gnome/shell/extensions/notchex/
  ```
- Enter your macOSicons API key again (it's stored in the keyring under a new name).
- If NexNotch's traffic-light buttons were on, Notchex recognizes and replaces their `gtk.css` block.

---

## Credits

Notchex is built and maintained by **[Aditya Takuli](https://github.com/AdityaTakuli)**.

It's based on **[NexNotch](https://github.com/NexVar/NexNotch)** by [NexVar](https://nexvar.io) and [Mert Ali Dalkır](https://mertdlkr.com), which provided the original island, hub tabs and live activities. Notchex adds the Dock, Spotlight search, frosted glass, Control Center styling, the auto-hiding top bar, zoom gestures, window buttons, the icon system, audio-reactive bars and many other changes.

Thanks also to:
- [wttr.in](https://wttr.in) for the free weather API
- [macOSicons.com](https://macosicons.com) for the community icon library (each icon's credits are shown in preferences)
- The GNOME Shell and GJS developers

---

## License

[GPL-3.0-or-later](LICENSE).

Copyright © 2026 Aditya Takuli.
Portions copyright © 2026 NexVar and Mert Ali Dalkır (original NexNotch).

Notchex is not affiliated with Apple. "Dynamic Island", "Spotlight", "Dock" and "macOS" are used only to describe the look and feel.

<div align="center">

**If Notchex makes your desktop better, consider giving it a ⭐.**

</div>
