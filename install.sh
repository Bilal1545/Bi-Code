#!/usr/bin/env bash
#
# Bi-Code installer for Linux (Arch and others).
#
# Downloads the latest released "binary + ui" tarball for your CPU
# architecture from GitHub and installs it under /opt/Bi-Code, with a
# launcher in /usr/local/bin and a desktop menu entry.
#
#   Install latest:   ./install.sh
#   Install a tag:    ./install.sh v0.1.0
#   Uninstall:        ./install.sh uninstall
#
set -euo pipefail

REPO="Bilal1545/Bi-Code"
APP_NAME="Bi-Code"
# The launched binary's basename becomes the Wayland app_id / X11 WM_CLASS,
# so the desktop file is named (and StartupWMClass set) to match it -> the
# desktop environment can map the running window to this entry's icon.
WM_CLASS="bi-code"
PREFIX="${PREFIX:-/opt/Bi-Code}"
BIN_LINK="${BIN_LINK:-/usr/local/bin/$WM_CLASS}"
DESKTOP_FILE="/usr/share/applications/$WM_CLASS.desktop"

info() { printf '\033[1;34m::\033[0m %s\n' "$*"; }
ok()   { printf '\033[1;32m✓\033[0m %s\n'  "$*"; }
die()  { printf '\033[1;31merror:\033[0m %s\n' "$*" >&2; exit 1; }

# Run privileged commands with sudo unless we're already root.
if [ "$(id -u)" -eq 0 ]; then SUDO=""; else
  command -v sudo >/dev/null 2>&1 || die "this script needs root (install sudo, or run as root)."
  SUDO="sudo"
fi

uninstall() {
  info "Removing $APP_NAME..."
  $SUDO rm -rf "$PREFIX"
  $SUDO rm -f  "$BIN_LINK"
  $SUDO rm -f  "$DESKTOP_FILE"
  for sz in 32 64 128 256; do
    $SUDO rm -f "/usr/share/icons/hicolor/${sz}x${sz}/apps/$WM_CLASS.png"
  done
  command -v gtk-update-icon-cache >/dev/null 2>&1 \
    && $SUDO gtk-update-icon-cache -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
  command -v update-desktop-database >/dev/null 2>&1 \
    && $SUDO update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
  ok "$APP_NAME uninstalled."
  exit 0
}

[ "${1:-}" = "uninstall" ] && uninstall

command -v curl >/dev/null 2>&1 || die "'curl' is required but not installed."
command -v tar  >/dev/null 2>&1 || die "'tar' is required but not installed."

# ---- pick the asset for this architecture --------------------------------
case "$(uname -m)" in
  x86_64|amd64)   ARCH_RE='x86_64|amd64' ;;
  aarch64|arm64)  ARCH_RE='arm64|aarch64' ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

TAG="${1:-}"
if [ -n "$TAG" ]; then
  API="https://api.github.com/repos/$REPO/releases/tags/$TAG"
else
  API="https://api.github.com/repos/$REPO/releases/latest"
fi

info "Looking up release from $REPO..."
JSON="$(curl -fsSL -H 'Accept: application/vnd.github+json' "$API")" \
  || die "could not fetch release info (does the tag exist? rate-limited?)"

# Find the linux .tar.gz download URL matching this arch (no jq dependency).
URL="$(printf '%s\n' "$JSON" \
  | grep -oE '"browser_download_url": *"[^"]+"' \
  | sed -E 's/.*"(https[^"]+)"/\1/' \
  | grep -iE 'linux' \
  | grep -iE '\.tar\.gz$' \
  | grep -iE "$ARCH_RE" \
  | head -n1 || true)"

[ -n "$URL" ] || die "no matching linux tarball found for $(uname -m). The release may still be building — try again shortly."

# ---- download & extract ---------------------------------------------------
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

info "Downloading $(basename "$URL")..."
curl -fL --progress-bar "$URL" -o "$TMP/bi-code.tar.gz"

info "Extracting..."
tar -xzf "$TMP/bi-code.tar.gz" -C "$TMP"
SRC="$TMP/Bi-Code"
[ -x "$SRC/bi-code" ] || die "archive layout unexpected: $SRC/bi-code not found."

# ---- install to /opt ------------------------------------------------------
info "Installing to $PREFIX (may ask for your password)..."
$SUDO rm -rf "$PREFIX"
$SUDO mkdir -p "$PREFIX"
$SUDO cp "$SRC/bi-code" "$PREFIX/bi-code"
$SUDO chmod +x "$PREFIX/bi-code"
[ -d "$SRC/ui" ]    && $SUDO cp -r "$SRC/ui" "$PREFIX/ui"
[ -d "$SRC/icons" ] && $SUDO cp -r "$SRC/icons" "$PREFIX/icons"
ok "Installed -> $PREFIX/bi-code (+ ui/)"

# ---- launcher symlink -----------------------------------------------------
$SUDO ln -sf "$PREFIX/bi-code" "$BIN_LINK"
ok "Launcher -> $BIN_LINK"

# ---- install icons into the hicolor theme as "$WM_CLASS" ------------------
# Theme icons (named after the app_id) let the desktop match the running
# window to its icon. Falls back to the bundled SVG path if PNGs are absent.
ICON="$PREFIX/ui/icon.svg"
for sz in 32 64 128 256; do
  src="$SRC/icons/${sz}x${sz}.png"
  [ "$sz" = 256 ] && src="$SRC/icons/128x128@2x.png"
  if [ -f "$src" ]; then
    dst="/usr/share/icons/hicolor/${sz}x${sz}/apps"
    $SUDO mkdir -p "$dst"
    $SUDO cp "$src" "$dst/$WM_CLASS.png"
    ICON="$WM_CLASS"   # resolved from the theme by name
  fi
done
command -v gtk-update-icon-cache >/dev/null 2>&1 \
  && $SUDO gtk-update-icon-cache -f /usr/share/icons/hicolor >/dev/null 2>&1 || true
[ "$ICON" = "$WM_CLASS" ] && ok "Installed theme icons ($WM_CLASS)"
[ "$ICON" = "$PREFIX/ui/icon.svg" ] && [ ! -f "$ICON" ] && ICON="$APP_NAME"
$SUDO tee "$DESKTOP_FILE" >/dev/null <<EOF
[Desktop Entry]
Type=Application
Name=$APP_NAME
Comment=A small, fast desktop code editor
Exec=$PREFIX/bi-code %F
Icon=$ICON
Terminal=false
Categories=Development;IDE;TextEditor;
StartupWMClass=$WM_CLASS
MimeType=text/plain;inode/directory;
EOF
command -v update-desktop-database >/dev/null 2>&1 \
  && $SUDO update-desktop-database /usr/share/applications >/dev/null 2>&1 || true
ok "Created menu entry."

ok "Done. Launch '$APP_NAME' from your app menu or run: bi-code"
