#!/usr/bin/env bash
# Notchex installer — a working notch and macOS-style desktop for GNOME.
#
#   curl -fsSL https://raw.githubusercontent.com/AdityaTakuli/Notchex/main/install.sh | bash
#
# Options (pass after `bash -s --` when piping, e.g. `| bash -s -- --uninstall`):
#   --version vX.Y.Z   install a specific release instead of the latest
#   --zip FILE         install from a local zip instead of downloading
#   --no-enable        install only, don't turn the extension on
#   --uninstall        remove Notchex
#   -h, --help         show this help
#
# Installs per user into ~/.local/share/gnome-shell/extensions; never needs sudo.

# Everything runs inside this block, so a download cut short can't run half a script.
{
set -euo pipefail

UUID="notchex@adityatakuli"
REPO="AdityaTakuli/Notchex"
ZIP_NAME="$UUID.shell-extension.zip"
MIN_SHELL=46
MAX_SHELL=50
EXT_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/gnome-shell/extensions/$UUID"

VERSION=""
LOCAL_ZIP=""
ENABLE=1
ACTION="install"

if [ -t 1 ]; then
    BOLD=$'\e[1m'; DIM=$'\e[2m'; RED=$'\e[31m'; GREEN=$'\e[32m'; YELLOW=$'\e[33m'; RESET=$'\e[0m'
else
    BOLD=""; DIM=""; RED=""; GREEN=""; YELLOW=""; RESET=""
fi

info() { printf '%s==>%s %s\n' "$BOLD" "$RESET" "$*"; }
ok()   { printf '%s✓%s %s\n' "$GREEN" "$RESET" "$*"; }
warn() { printf '%s!%s %s\n' "$YELLOW" "$RESET" "$*" >&2; }
die()  { printf '%s✗ %s%s\n' "$RED" "$*" "$RESET" >&2; exit 1; }

usage() {
    cat <<EOF
Notchex installer

  curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- [options]

  --version vX.Y.Z   install a specific release instead of the latest
  --zip FILE         install from a local zip instead of downloading
  --no-enable        install only, don't turn the extension on
  --uninstall        remove Notchex
  -h, --help         show this help
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --version)   VERSION="${2:?--version needs a value, e.g. v3.0.0}"; shift 2
                     [[ "$VERSION" =~ ^v[0-9]+(\.[0-9]+){0,2}$ ]] || die "--version should look like v3.0.0" ;;
        --zip)       LOCAL_ZIP="${2:?--zip needs a file}"; shift 2 ;;
        --no-enable) ENABLE=0; shift ;;
        --uninstall) ACTION="uninstall"; shift ;;
        -h|--help)   usage; exit 0 ;;
        *)           die "Unknown option: $1 (try --help)" ;;
    esac
done

[ "$(id -u)" -ne 0 ] || die "Don't run this with sudo — Notchex installs for your user only."
[ "$(uname -s)" = "Linux" ] || die "Notchex is a GNOME Shell extension and only runs on Linux."

# ---- enabled-extensions list helpers (work before the shell knows the extension) ----

gsettings_list_has() {   # key uuid
    gsettings get org.gnome.shell "$1" 2>/dev/null | grep -q "'$2'"
}

gsettings_list_add() {   # key uuid
    local cur
    cur="$(gsettings get org.gnome.shell "$1" 2>/dev/null)" || return 1
    gsettings_list_has "$1" "$2" && return 0
    case "$cur" in
        "@as []"|"[]") gsettings set org.gnome.shell "$1" "['$2']" ;;
        *)             gsettings set org.gnome.shell "$1" "${cur%]}, '$2']" ;;
    esac
}

gsettings_list_remove() {   # key uuid
    local cur new
    cur="$(gsettings get org.gnome.shell "$1" 2>/dev/null)" || return 0
    gsettings_list_has "$1" "$2" || return 0
    new="$(printf '%s' "$cur" | sed -e "s/'$2'//" -e 's/\[, */[/' -e 's/, *\]/]/' -e 's/, *, */, /')"
    [ "$new" = "[]" ] && new="@as []"
    gsettings set org.gnome.shell "$1" "$new"
}

# ---- uninstall ----

if [ "$ACTION" = "uninstall" ]; then
    info "Removing Notchex"
    gnome-extensions disable "$UUID" >/dev/null 2>&1 || true
    gsettings_list_remove enabled-extensions "$UUID" || true
    rm -f "$HOME/.local/share/applications/notchex-settings.desktop"
    if [ -d "$EXT_DIR" ]; then
        rm -rf "$EXT_DIR"
        ok "Removed $EXT_DIR"
    else
        warn "Notchex wasn't installed at $EXT_DIR"
    fi
    if grep -qs "Notchex macOS window buttons" "$HOME/.config/gtk-3.0/gtk.css" "$HOME/.config/gtk-4.0/gtk.css"; then
        warn "Traffic-light window buttons are still in your gtk.css. Reinstall, turn them off in"
        warn "Preferences → Appearance → Windows, then uninstall — or delete the marked block by hand."
    fi
    echo "Log out and back in to finish."
    exit 0
fi

# ---- preflight ----

command -v gnome-shell >/dev/null 2>&1 || die "GNOME Shell isn't installed. Notchex needs GNOME $MIN_SHELL–$MAX_SHELL."

SHELL_VERSION="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+(\.[0-9]+)*' | head -n1)"
SHELL_MAJOR="${SHELL_VERSION%%.*}"
if [ -z "$SHELL_MAJOR" ]; then
    warn "Couldn't detect the GNOME Shell version; continuing anyway."
elif [ "$SHELL_MAJOR" -lt "$MIN_SHELL" ]; then
    die "GNOME Shell $SHELL_VERSION is too old. Notchex needs GNOME $MIN_SHELL or newer."
elif [ "$SHELL_MAJOR" -gt "$MAX_SHELL" ]; then
    warn "GNOME Shell $SHELL_VERSION is newer than Notchex has been tested on ($MIN_SHELL–$MAX_SHELL)."
    warn "GNOME may refuse to load it until a new release adds support."
else
    ok "GNOME Shell $SHELL_VERSION"
fi

case "${XDG_CURRENT_DESKTOP:-}" in
    *GNOME*|*gnome*|"") ;;
    *) warn "Your desktop is '${XDG_CURRENT_DESKTOP}', not GNOME. Notchex only works in a GNOME session." ;;
esac

command -v glib-compile-schemas >/dev/null 2>&1 || die "glib-compile-schemas is missing (package: libglib2.0-bin / glib2)."

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# ---- get the zip ----

if [ -n "$LOCAL_ZIP" ]; then
    [ -f "$LOCAL_ZIP" ] || die "No such file: $LOCAL_ZIP"
    cp "$LOCAL_ZIP" "$TMP/$ZIP_NAME"
    ok "Using $LOCAL_ZIP"
else
    if [ -n "$VERSION" ]; then
        URL="https://github.com/$REPO/releases/download/$VERSION/$ZIP_NAME"
    else
        URL="https://github.com/$REPO/releases/latest/download/$ZIP_NAME"
    fi
    info "Downloading ${VERSION:-latest release}"
    # https only, including redirects
    fetch() {   # url file [quiet]
        if command -v curl >/dev/null 2>&1; then
            if [ -n "${3:-}" ]; then curl -fsL --proto '=https' --proto-redir '=https' --tlsv1.2 -o "$2" "$1"
            else curl -fL --proto '=https' --proto-redir '=https' --tlsv1.2 --progress-bar -o "$2" "$1"; fi
        elif command -v wget >/dev/null 2>&1; then
            if [ -n "${3:-}" ]; then wget -q --https-only -O "$2" "$1"
            else wget -q --https-only --show-progress -O "$2" "$1"; fi
        else
            die "Need curl or wget to download Notchex."
        fi
    }
    fetch "$URL" "$TMP/$ZIP_NAME" || die "Download failed: $URL"

    # check the zip against the release's published SHA-256 checksums
    if fetch "${URL%/*}/SHA256SUMS" "$TMP/SHA256SUMS" quiet; then
        want="$(grep -E "[[:space:]]\*?$ZIP_NAME\$" "$TMP/SHA256SUMS" | awk '{print $1}' | head -n1)"
        if command -v sha256sum >/dev/null 2>&1; then
            have="$(sha256sum "$TMP/$ZIP_NAME" | awk '{print $1}')"
        else
            have="$(shasum -a 256 "$TMP/$ZIP_NAME" | awk '{print $1}')"
        fi
        [ -n "$want" ] || die "The release's SHA256SUMS doesn't list $ZIP_NAME."
        [ "$want" = "$have" ] || die "Checksum mismatch: the download is damaged or was changed. Nothing was installed."
        ok "Checksum verified"
    else
        warn "This release has no SHA256SUMS file, so the download couldn't be verified."
    fi
fi

# ---- unpack and install ----

mkdir -p "$TMP/x"
if command -v unzip >/dev/null 2>&1; then
    unzip -q "$TMP/$ZIP_NAME" -d "$TMP/x"
elif command -v python3 >/dev/null 2>&1; then
    python3 -I -m zipfile -e "$TMP/$ZIP_NAME" "$TMP/x"
else
    die "Need unzip or python3 to unpack Notchex."
fi

[ -f "$TMP/x/metadata.json" ] && [ -f "$TMP/x/notch.js" ] || die "The zip doesn't look like a Notchex release."
grep -q "\"$UUID\"" "$TMP/x/metadata.json" || die "The zip is for a different extension."

UPGRADE=0
[ -d "$EXT_DIR" ] && UPGRADE=1
rm -rf "$EXT_DIR"
mkdir -p "$(dirname "$EXT_DIR")"
cp -r "$TMP/x" "$EXT_DIR"
glib-compile-schemas "$EXT_DIR/schemas"

# a "Notchex Settings" app in the app grid, so settings never need Extension Manager
if [ -f "$EXT_DIR/data/notchex-settings.desktop" ]; then
    mkdir -p "$HOME/.local/share/applications"
    cp "$EXT_DIR/data/notchex-settings.desktop" "$HOME/.local/share/applications/"
fi

INSTALLED_VERSION="$(grep -oE '"version-name"[^"]*"[^"]+"' "$EXT_DIR/metadata.json" | grep -oE '"[^"]+"$' | tr -d '"')"
ok "Installed Notchex ${INSTALLED_VERSION} to $EXT_DIR"

# ---- enable ----

if [ "$ENABLE" -eq 1 ]; then
    # Turn on user extensions globally in case they were switched off.
    gsettings set org.gnome.shell disable-user-extensions false 2>/dev/null || true
    gsettings_list_remove disabled-extensions "$UUID" || true
    if gnome-extensions enable "$UUID" >/dev/null 2>&1; then
        ok "Enabled"
    elif gsettings_list_add enabled-extensions "$UUID"; then
        ok "Enabled (takes effect after you log back in)"
    else
        warn "Couldn't enable automatically. After logging back in, run: gnome-extensions enable $UUID"
    fi
fi

# ---- overlapping extensions ----

for other in ubuntu-dock@ubuntu.com dash-to-dock@micxgx.gmail.com; do
    if gsettings_list_has enabled-extensions "$other"; then
        warn "$other is enabled — you'll see two docks. Disable it with:"
        warn "    gnome-extensions disable $other"
    fi
done

# ---- next steps ----

echo
if [ "$UPGRADE" -eq 1 ]; then
    printf '%sUpdated.%s ' "$BOLD" "$RESET"
else
    printf '%sDone.%s ' "$BOLD" "$RESET"
fi
if [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then
    echo "Press Alt+F2, type r and press Enter to reload GNOME Shell."
else
    echo "Log out and log back in to start Notchex."
fi
echo "${DIM}Settings:  gnome-extensions prefs $UUID${RESET}"
echo "${DIM}Uninstall: curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh | bash -s -- --uninstall${RESET}"

exit 0
}
