#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
REPO_ROOT="$PWD"
VARIANT="wasm-player-p0"
THREADS="st"
CLEAN="0"
CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/wasm-player/libav.js-6.8.8"
TREE="$CACHE/tree"
EMSDK="${EMSDK:-$HOME/tools/emsdk}"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --variant) VARIANT="$2"; shift 2 ;;
    --threads) THREADS="$2"; shift 2 ;;
    --clean) CLEAN="1"; shift ;;
    --source) CACHE="$2"; TREE="$CACHE/tree"; shift 2 ;;
    --help)
      echo "usage: scripts/build-wasm.sh [--variant NAME] [--threads st|mt] [--source CACHE]"
      exit 0
      ;;
    *) echo "unknown argument: $1" >&2; exit 1 ;;
  esac
done

if ! command -v emcc >/dev/null 2>&1; then
  if [ -f "$EMSDK/emsdk_env.sh" ]; then
    # shellcheck disable=SC1091
    source "$EMSDK/emsdk_env.sh" >/dev/null 2>&1
  fi
fi
if ! command -v emcc >/dev/null 2>&1; then
  echo "emcc is not available; install/activate Emscripten first" >&2
  exit 2
fi
echo "[wasm] emcc: $(emcc --version | head -1)"

mkdir -p "$CACHE"
if [ ! -f "$TREE/Makefile" ]; then
  echo "[wasm] fetching libav.js 6.8.8 sources"
  npm pack libav.js@6.8.8 --pack-destination "$CACHE" >/dev/null
  rm -rf "$CACHE/package"
  tar xf "$CACHE/libav.js-6.8.8.tgz" -C "$CACHE"
  rm -rf "$TREE"
  mkdir -p "$TREE"
  tar xf "$CACHE/package/sources/libav.js.tar.xz" -C "$TREE"
  mkdir -p "$TREE/build"
  cp "$CACHE"/package/sources/*.tar.* "$TREE/build/"
fi
if [ ! -d "$TREE/node_modules/terser" ]; then
  echo "[wasm] installing libav.js build tooling"
  (cd "$TREE" && npm install --no-audit --no-fund --ignore-scripts >/dev/null)
fi
if [ ! -f "$TREE/configs/configs/$VARIANT/config.json" ]; then
  echo "[wasm] generating variant $VARIANT"
  FRAGMENTS="$(cat "$REPO_ROOT/native/builds/fragments-p0.json")"
  (cd "$TREE/configs" && node mkconfig.js "$VARIANT" "$FRAGMENTS")
fi

if [ "$CLEAN" = "1" ]; then
  echo "[wasm] cleaning previous build outputs"
  rm -rf "$TREE/build/ffmpeg-8.0" "$TREE/build/inst" "$TREE/dist"
  rm -rf "$TREE"/build/opus-*/build-* "$TREE"/build/emfiberthreads/build-*
fi

if [ "$THREADS" = "mt" ]; then
  TARGETS=("dist/libav-6.8.8.0-$VARIANT.thr.mjs" "dist/libav-$VARIANT.mjs")
else
  TARGETS=("dist/libav-6.8.8.0-$VARIANT.wasm.mjs" "dist/libav-$VARIANT.mjs")
fi
echo "[wasm] building: ${TARGETS[*]}"
( cd "$TREE" && make -j"$(nproc)" "${TARGETS[@]}" )
node "$REPO_ROOT/scripts/make-wasm-manifest.mjs" "$TREE" "$VARIANT" "$THREADS"
