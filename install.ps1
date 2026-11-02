# Notchex installer for Windows 10 and 11.
#
#   irm https://raw.githubusercontent.com/AdityaTakuli/Notchex/main/install.ps1 | iex
#
# With options:
#
#   & ([scriptblock]::Create((irm https://raw.githubusercontent.com/AdityaTakuli/Notchex/main/install.ps1))) -Uninstall
#
#   -Version v3.0.0   install a specific release instead of the latest
#   -NoStart          install only, don't start Notchex
#   -Uninstall        remove Notchex, its shortcuts and its settings
#
# Installs for your user only, into %LOCALAPPDATA%\Programs\Notchex. Never needs admin rights.
# Works in Windows PowerShell 5.1 and PowerShell 7.

param(
    [string]$Version = '',
    [switch]$NoStart,
    [switch]$Uninstall
)

function Install-Notchex {
    param([string]$Version, [switch]$NoStart, [switch]$Uninstall)

    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'   # the progress bar makes downloads very slow in PowerShell 5.1

    $Repo       = 'AdityaTakuli/Notchex'
    $ScriptUrl  = "https://raw.githubusercontent.com/$Repo/main/install.ps1"
    $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Notchex'
    $Exe        = Join-Path $InstallDir 'Notchex.exe'
    $SettingsDir = Join-Path $env:APPDATA 'Notchex'
    $LogDir     = Join-Path $env:LOCALAPPDATA 'Notchex'
    $RunKey     = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Run'
    $Programs   = [Environment]::GetFolderPath('Programs')
    if (-not $Programs) { $Programs = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs' }
    $StartMenu  = Join-Path $Programs 'Notchex'

    function Say([string]$m)  { Write-Host "==> $m" }
    function Ok([string]$m)   { Write-Host "    $m" -ForegroundColor Green }
    function Warn([string]$m) { Write-Host "  ! $m" -ForegroundColor Yellow }
    function Fail([string]$m) { Write-Host "  x $m" -ForegroundColor Red }

    # Closes any running copy, including one started from a downloaded Notchex-x.y.z-win-x64.exe.
    function Stop-Notchex {
        $running = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -like 'Notchex*' })
        if ($running.Count -gt 0) {
            # Ask it to close first, so "Keep a bar" gives its screen space back;
            # force it only if it doesn't.
            foreach ($p in $running) { try { [void]$p.CloseMainWindow() } catch { } }
            $running | Wait-Process -Timeout 5 -ErrorAction SilentlyContinue
            $left = @($running | Where-Object { -not $_.HasExited })
            if ($left.Count -gt 0) {
                $left | Stop-Process -Force -ErrorAction SilentlyContinue
                $left | Wait-Process -Timeout 10 -ErrorAction SilentlyContinue
            }
            Ok 'Closed the running Notchex'
        }
    }

    if ($env:OS -ne 'Windows_NT') {
        Fail 'This installer is for Windows. On Linux, run:'
        Write-Host "    curl -fsSL https://raw.githubusercontent.com/$Repo/main/install.sh | bash"
        return
    }

    # ---- uninstall ----

    if ($Uninstall) {
        Say 'Removing Notchex'
        Stop-Notchex
        if (Test-Path $RunKey) {
            $run = (Get-ItemProperty -Path $RunKey -ErrorAction SilentlyContinue).Notchex
            if ($run) {
                Remove-ItemProperty -Path $RunKey -Name 'Notchex' -ErrorAction SilentlyContinue
                Ok 'Removed the sign-in entry'
                $runExe = $run.Trim('"')
                if ($runExe -ne $Exe -and (Test-Path $runExe)) {
                    Warn "Notchex was also run from $runExe. Delete that file if you don't need it."
                }
            }
        }
        foreach ($dir in @($StartMenu, $InstallDir, $SettingsDir, $LogDir)) {
            if (Test-Path $dir) {
                Remove-Item -Path $dir -Recurse -Force
                Ok "Removed $dir"
            }
        }
        Write-Host ''
        Write-Host 'Notchex is uninstalled.'
        return
    }

    # ---- preflight ----

    $os = [Environment]::OSVersion
    if ($os.Platform -eq 'Win32NT' -and $os.Version.Build -lt 19041) {
        Fail "Notchex needs Windows 10 version 2004 (build 19041) or later. This PC has build $($os.Version.Build)."
        return
    }

    # The native architecture, even when this PowerShell runs under x64 emulation on an Arm PC.
    $arch = $null
    try {
        $arch = (Get-ItemProperty 'HKLM:\SYSTEM\CurrentControlSet\Control\Session Manager\Environment' -ErrorAction Stop).PROCESSOR_ARCHITECTURE
    } catch { }
    if (-not $arch) {
        try { $arch = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString() } catch { }
    }
    if (-not $arch) { $arch = $env:PROCESSOR_ARCHITECTURE }
    switch -Regex ($arch) {
        '^(ARM64)$'     { $rid = 'win-arm64'; break }
        '^(AMD64|X64)$' { $rid = 'win-x64'; break }
        default {
            Fail "Notchex runs on 64-bit Windows (x64 or Arm64). This PC reports '$arch'."
            return
        }
    }

    if ($Version) {
        if ($Version -notmatch '^v\d+(\.\d+){0,2}$') { Fail '-Version should look like v3.0.0'; return }
        $base = "https://github.com/$Repo/releases/download/$Version"
    } else {
        $base = "https://github.com/$Repo/releases/latest/download"
    }

    # GitHub needs TLS 1.2, which older Windows PowerShell doesn't turn on by default.
    try {
        [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
    } catch { }

    $tmp = Join-Path ([IO.Path]::GetTempPath()) ('notchex-' + [guid]::NewGuid().ToString('N'))
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
        # ---- find the right build in the release's checksums ----

        if ($Version) { Say "Looking up Notchex $Version" } else { Say 'Looking up the latest release' }
        $sums = Join-Path $tmp 'SHA256SUMS'
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/SHA256SUMS" -OutFile $sums
        } catch {
            Fail "Couldn't reach the release ($base). Check your connection and the version number."
            return
        }

        $want = $null; $name = $null
        foreach ($line in Get-Content -Path $sums) {
            if ($line -match "^([0-9a-fA-F]{64})\s+\*?(Notchex-[0-9A-Za-z.\-]+-$rid\.exe)\s*$") {
                $want = $Matches[1].ToLower()
                $name = $Matches[2]
                break
            }
        }
        if (-not $name) { Fail "This release has no Windows build for $rid."; return }
        $ver = $name -replace '^Notchex-(.+)-win-[^-]+\.exe$', '$1'

        # ---- download and verify ----

        Say "Downloading Notchex $ver ($rid)"
        $download = Join-Path $tmp $name
        try {
            Invoke-WebRequest -UseBasicParsing -Uri "$base/$name" -OutFile $download
        } catch {
            Fail "Download failed: $base/$name"
            return
        }
        $have = (Get-FileHash -Algorithm SHA256 -Path $download).Hash.ToLower()
        if ($have -ne $want) {
            Fail 'Checksum mismatch: the download is damaged or was changed. Nothing was installed.'
            return
        }
        Ok 'Checksum verified'

        # ---- install ----

        $upgrade = Test-Path $Exe
        Stop-Notchex
        New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null
        Move-Item -Force -Path $download -Destination $Exe
        Ok "Installed Notchex $ver to $InstallDir"

        # ---- start ----
        # On first run Notchex adds itself to the Start menu, and on every run it points
        # the Start menu and the sign-in entry at this copy.

        if (-not $NoStart) {
            $elevated = $false
            try {
                $me = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
                $elevated = $me.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
            } catch { }
            if ($elevated) {
                # started through Explorer, so Notchex doesn't run as administrator
                Start-Process -FilePath 'explorer.exe' -ArgumentList "`"$Exe`""
            } else {
                Start-Process -FilePath $Exe
            }
            Ok 'Started'
        }

        Write-Host ''
        if ($upgrade) { Write-Host 'Updated.' -NoNewline } else { Write-Host 'Done.' -NoNewline }
        if ($NoStart) {
            Write-Host ' Open Notchex from the Start menu or run:'
            Write-Host "    & `"$Exe`""
        } else {
            Write-Host ' Notchex is at the top of your screen. Hover over it to open the hub.'
        }
        Write-Host '    Settings:  Ctrl+Alt+,  or "Notchex Settings" in the Start menu' -ForegroundColor DarkGray
        Write-Host '    Update:    run the same command again' -ForegroundColor DarkGray
        Write-Host "    Uninstall: & ([scriptblock]::Create((irm $ScriptUrl))) -Uninstall" -ForegroundColor DarkGray
    } finally {
        Remove-Item -Path $tmp -Recurse -Force -ErrorAction SilentlyContinue
    }
}

Install-Notchex -Version $Version -NoStart:$NoStart -Uninstall:$Uninstall
