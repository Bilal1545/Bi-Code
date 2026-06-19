#!/usr/bin/env bash
#
# Bi-Code uninstaller for Linux — removes whatever install.sh installed:
# the /opt/Bi-Code tree, the launcher symlink, the desktop entry and the
# theme icons.
#
#   ./uninstall.sh
#
set -euo pipefail

APP_NAME="Bi-Code"
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

info "Removing $APP_NAME (may ask for your password)..."
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
