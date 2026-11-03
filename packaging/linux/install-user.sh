#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
PREFIX="${XDG_DATA_HOME:-$HOME/.local/share}/wasm-player"
DESKTOP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$PREFIX" "$DESKTOP_DIR" "$HOME/Desktop"
rm -rf "$PREFIX/web"
cp -a "$ROOT/web" "$PREFIX/web"
cp "$ROOT/wasm-player" "$PREFIX/wasm-player"
cp "$ROOT/wasm-player.svg" "$PREFIX/wasm-player.svg"
chmod 0755 "$PREFIX/wasm-player"
mkdir -p "$HOME/.local/bin"
ln -sfn "$PREFIX/wasm-player" "$HOME/.local/bin/wasm-player"
sed -e "s#@EXEC@#$PREFIX/wasm-player#g" -e "s#@ICON@#$PREFIX/wasm-player.svg#g" \
  "$ROOT/wasm-player.desktop.in" > "$DESKTOP_DIR/wasm-player.desktop"
cp "$DESKTOP_DIR/wasm-player.desktop" "$HOME/Desktop/WASM Player.desktop"
chmod 0755 "$DESKTOP_DIR/wasm-player.desktop" "$HOME/Desktop/WASM Player.desktop"
gio set "$HOME/Desktop/WASM Player.desktop" metadata::trusted true 2>/dev/null || true
command -v update-desktop-database >/dev/null && update-desktop-database "$DESKTOP_DIR" || true
echo "Installed WASM Player to $PREFIX"
echo "Desktop shortcut: $HOME/Desktop/WASM Player.desktop"
