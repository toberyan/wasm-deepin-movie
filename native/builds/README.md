# WASM build artifacts

## Locked prebuilt P0 slice

`@libav.js/variant-webcodecs@6.10.9` is used for the first browser slice. Its
manifest is `manifests/webcodecs.json`; assets are copied by
`scripts/sync-libav-assets.mjs`.

## Project-owned variant

`scripts/build-wasm.sh` builds the custom `wasm-player-p0` variant from the
libav.js 6.8.8 source tarball (FFmpeg 8.0). It requires Emscripten.

```bash
source ~/tools/emsdk/emsdk_env.sh
scripts/build-wasm.sh --variant wasm-player-p0 --threads st
scripts/build-wasm.sh --variant wasm-player-p0 --threads mt
```

Fragments are in `fragments-p0.json`: MP4/MKV/WebM/AVI/FLV/TS/PS/MP3/AAC/Ogg/
FLAC/WAV demuxing plus MPEG-4, MP3, H.264, HEVC, AAC, AC-3, FLAC and Opus
decoding candidates. `native/builds/manifests/<variant>-<threads>.json` records
the exact component list, artifact hashes and licenses. `artifacts/` is
gitignored; copy the required JS/WASM to `apps/web/public/libav/` for runtime
experiments.

Do not distribute these artifacts until the LGPL source/notice and codec
patent/license review is complete. The prebuilt variant is not a substitute for
this manifest.
