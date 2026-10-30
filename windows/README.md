# Notchex for Windows

The same notch, now on Windows 10 (2004 or later) and Windows 11. It sits at the top of your screen as a notch or a floating pill.

## What it does

- **While music plays:** album art on the left, the time in the middle and moving bars on the right. It works with anything that shows up in Windows' own media controls: Spotify, browsers, Media Player, VLC.
- **Hover to open the hub:** the song with play, pause and skip, a progress bar, a volume slider and your battery.
- **Small alerts:** volume changes, charger plugged in or out, low battery and new songs show briefly in the notch.
- **Scroll on the notch** to change the volume.
- **Right-click it** to switch between notch and pill, open settings, hide it or quit.
- **Out of the way:** it hides itself during full-screen games, videos and presentations.

## Install

1. Download `Notchex-…-win-x64.exe` from the [latest release](https://github.com/AdityaTakuli/Notchex/releases/latest). Use `win-arm64` on Arm PCs such as Snapdragon laptops.
2. Put it somewhere it can stay, such as `Documents\Notchex`, and run it.

It installs nothing system-wide and needs no admin rights. Notchex adds "Notchex" and "Notchex Settings" to the Start menu, and you can have it start when you sign in.

Windows may show "Windows protected your PC" because the app isn't signed yet. Click **More info**, then **Run anyway**.

## Shortcuts

| Keys | Does |
| --- | --- |
| Ctrl + Alt + N | Open or close the notch |
| Ctrl + Alt + , | Open settings |

## Settings

Open them from the Start menu ("Notchex Settings"), the tray icon, the gear in the hub, or Ctrl + Alt + ,. They're saved in `%APPDATA%\Notchex\settings.json`.

## Privacy and security

- **No network at all.** The Windows app never goes online: no telemetry, no update checks, no accounts.
- **No admin rights.** Everything is per user: the Start menu shortcuts, the "start when you sign in" entry and the settings file.
- **Files it writes:** `%APPDATA%\Notchex\settings.json` (your settings; out-of-range values are reset, and a damaged file is kept as `settings.json.broken`) and `%LOCALAPPDATA%\Notchex\notchex.log` (error types and stack traces only, never song titles, capped at 256 KB).
- **Other apps' data stays small:** song titles are cut to 300 characters, and album art over 8 MB is ignored.
- **Verify your download:** each release has a `SHA256SUMS` file. In PowerShell, compare its line with `Get-FileHash .\Notchex-…-win-x64.exe`.

## Uninstall

Quit Notchex from its tray icon. Then turn off "Start Notchex when you sign in" first, or delete the `Notchex` value under `HKCU\Software\Microsoft\Windows\CurrentVersion\Run`. Delete the exe, the `Notchex` folder in the Start menu and `%APPDATA%\Notchex`.

## Build it yourself

You need the [.NET 8 SDK](https://dotnet.microsoft.com/download/dotnet/8.0).

```
dotnet publish windows/Notchex/Notchex.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -p:EnableCompressionInSingleFile=true -o out
```

The project also builds on Linux and macOS (`EnableWindowsTargeting`), but the app only runs on Windows.

## How it's built

Plain C# and WPF, with no extra packages:

| File | Job |
| --- | --- |
| `IslandWindow.xaml(.cs)` | The notch: idle, alerts and the hub, morphing between them |
| `SettingsWindow.xaml(.cs)` | Settings |
| `Services/MediaService.cs` | What's playing, from Windows' media sessions |
| `Services/VolumeService.cs` | Speaker volume through Core Audio |
| `Services/PowerService.cs` | Battery and charger |
| `Services/Hotkeys.cs` | System-wide shortcuts |
| `Services/ShellIntegration.cs` | Start menu shortcuts and starting with Windows |
| `Tray.cs` | The tray icon and its menu |
