#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
PKG=wasm-player-linux-x64
OUT="dist"
STAGE="$OUT/$PKG"
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
mkdir -p "$STAGE/web"
cp -a apps/web/dist/. "$STAGE/web/"
find "$STAGE/web/libav" -maxdepth 1 -name '*.thr.*' -delete 2>/dev/null || true
find "$STAGE/web/assets" -maxdepth 1 -name '*.map' -delete 2>/dev/null || true
cp "$DESKTOP/wasm-player" "$STAGE/wasm-player"
cp "$DESKTOP/wasm-player.svg" "$STAGE/wasm-player.svg"
cp "$DESKTOP/wasm-player.desktop.in" "$STAGE/wasm-player.desktop.in"
cp "$DESKTOP/install-user.sh" "$STAGE/install-user.sh"
chmod 0755 "$STAGE/wasm-player" "$STAGE/install-user.sh"
mkdir -p "$OUT"
rm -f "$OUT/${PKG}-${VERSION}.tar.gz"
tar -C "$OUT" -czf "$OUT/${PKG}-${VERSION}.tar.gz" "$PKG"
echo "built $OUT/${PKG}-${VERSION}.tar.gz"
