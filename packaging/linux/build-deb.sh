#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
PKG=wasm-player
OUT="dist"
STAGE="$OUT/${PKG}_${VERSION}_all"
ROOT="$STAGE"
DESKTOP=packaging/linux

if [ "${1:-}" != "--no-build" ]; then
  export PATH="$HOME/.local/bin:$PATH"
  pnpm libav:sync
  pnpm --filter @wasm-player/web build
fi
if [ ! -f apps/web/dist/index.html ]; then
  echo "apps/web/dist/index.html is missing; run without --no-build" >&2
  exit 1
fi

rm -rf "$STAGE"
mkdir -p "$ROOT/DEBIAN" "$ROOT/opt/$PKG/web" "$ROOT/usr/share/applications" \
  "$ROOT/usr/share/icons/hicolor/scalable/apps"
cp -a apps/web/dist/. "$ROOT/opt/$PKG/web/"
# The packaged ST build is the supported path. Drop MT artifacts (upstream
# threaded runtime is broken) and source maps to keep the package smaller.
find "$ROOT/opt/$PKG/web/libav" -maxdepth 1 -name '*.thr.*' -delete 2>/dev/null || true
find "$ROOT/opt/$PKG/web/assets" -maxdepth 1 -name '*.map' -delete 2>/dev/null || true
cp "$DESKTOP/wasm-player" "$ROOT/opt/$PKG/wasm-player"
cp "$DESKTOP/wasm-player.svg" "$ROOT/opt/$PKG/wasm-player.svg"
chmod 0755 "$ROOT/opt/$PKG/wasm-player"
sed -e "s#@EXEC@#/opt/$PKG/wasm-player#g" -e "s#@ICON@#$PKG#g" \
  "$DESKTOP/wasm-player.desktop.in" > "$ROOT/usr/share/applications/$PKG.desktop"
cp "$DESKTOP/wasm-player.svg" "$ROOT/usr/share/icons/hicolor/scalable/apps/$PKG.svg"

cat > "$ROOT/DEBIAN/control" <<CONTROL
Package: $PKG
Version: $VERSION
Section: video
Priority: optional
Architecture: all
Depends: python3 (>= 3.10)
Recommends: google-chrome-stable | chromium | microsoft-edge-stable
Installed-Size: $(du -sk "$ROOT" | cut -f1)
Maintainer: WASM Player <toberyan@localhost>
Description: WASM-first local video player
 Browser-first video player with FFmpeg/WASM demuxing, WebCodecs decoding,
 WebGL2 rendering, AudioWorklet output and a local-first desktop launcher.
CONTROL

cat > "$ROOT/DEBIAN/postinst" <<'POSTINST'
#!/bin/sh
set -e
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database -q /usr/share/applications || true
fi
if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  gtk-update-icon-cache -q -t -f /usr/share/icons/hicolor || true
fi
POSTINST
chmod 0755 "$ROOT/DEBIAN/postinst"

mkdir -p "$OUT"
rm -f "$OUT/${PKG}_${VERSION}_all.deb"
fakeroot dpkg-deb --build --root-owner-group "$STAGE" "$OUT/${PKG}_${VERSION}_all.deb"
echo "built $OUT/${PKG}_${VERSION}_all.deb"
