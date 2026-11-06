#!/usr/bin/env bash
# Install a normal (non-Chrome-for-Testing) Chromium into the app's data
# directory without root privileges. Deepin/Debian only.
set -euo pipefail

DEST="${1:-${XDG_DATA_HOME:-$HOME/.local/share}/wasm-player/browser}"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! command -v apt-get >/dev/null 2>&1 || ! command -v dpkg-deb >/dev/null 2>&1; then
  echo "This helper needs apt-get and dpkg-deb (Deepin/Debian)." >&2
  exit 1
fi

cd "$TMP"
echo "Downloading Chromium packages..."
apt-get download chromium chromium-common chromium-sandbox libxnvctrl0

mkdir -p root
for package in ./*.deb; do
  dpkg-deb -x "$package" root
done

rm -rf "$DEST"
mkdir -p "$DEST/lib"
cp -a root/usr/lib/chromium/. "$DEST/"
cp -a root/usr/lib/*/libXNVCtrl.so.0* "$DEST/lib/" 2>/dev/null || true
chmod 0755 "$DEST/chromium" 2>/dev/null || true
chmod 0755 "$DEST/chrome-sandbox" 2>/dev/null || true

echo "Installed bundled Chromium: $DEST/chromium"
echo "The desktop launcher will prefer it over Chrome for Testing."
