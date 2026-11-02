# Custom WASM Build Evidence

Date: 2026-11-02.

## Toolchain

| Item | Value |
| --- | --- |
| Emscripten | 6.0.13 (emsdk `sdk-releases-eb132757325583b787fe9414b09afea9442b72ad-64bit`) |
| libav.js | 6.8.8 (source tarball from `libav.js@6.8.8` npm package) |
| FFmpeg | 8.0 |
| Build script | `scripts/build-wasm.sh --variant wasm-player-p0 --threads st --clean` |
| Fragments | `native/builds/fragments-p0.json` |
| Manifest | `native/builds/manifests/wasm-player-p0-st.json` |

## Components

- Demuxers: matroska, avi, flv, mpegts, mpeg, mp3; MP4/WebM/Ogg/FLAC/WAV formats.
- Decoders: h264, hevc, aac, ac3, mpeg4, mp3, flac, libopus.
- Parsers: h264, hevc, vp8, vp9, av1, aac, mp3, mpeg4video, mpegaudio, ac3, opus, flac.
- Filters: swscale, swresample.

## Artifacts (ST)

| File | Bytes | SHA-256 prefix |
| --- | --- | --- |
| `libav-6.8.8.0-wasm-player-p0.wasm.mjs` | 234,404 | `c6f847b18208` |
| `libav-6.8.8.0-wasm-player-p0.wasm.wasm` | 4,039,298 | `22a7c9b8f608` |
| `libav-wasm-player-p0.mjs` | 26,848 | `ff2a51ffd2e9` |

## Artifacts (MT)

| File | Bytes | Notes |
| --- | --- | --- |
| `libav-6.8.8.0-wasm-player-p0.thr.mjs` | 250,754 | threaded frontend |
| `libav-6.8.8.0-wasm-player-p0.thr.wasm` | 4,234,268 | pthread/emfiberthreads build |
| `libav-wasm-player-p0.mjs` | 26,848 | shared loader |

MT manifest: `native/builds/manifests/wasm-player-p0-mt.json`. The browser currently
uses the ST artifact; MT runtime selection/verification is still pending.

Artifacts are copied to `apps/web/public/libav/` by
`scripts/sync-libav-assets.mjs` and are gitignored. The manifest is committed.

## Verification

- Node `DemuxSession` with the custom variant probes AVI/MPEG-4/MP3 and routes
  both tracks to `wasm`.
- Node WASM decode: 60 video frames, 78 MP3 PCM chunks (89,856 frames), seek to
  1 s returns 35 video + 45 audio chunks.
- Browser e2e (system Chrome 156):
  - AVI with forced WASM video+audio: first frame, play, position, audio PCM, pause.
  - H.264/AAC forced WASM and HEVC/AC-3 forced WASM: pass
    (`tests/e2e/playback.spec.ts`; skipped automatically when artifacts are absent).
- The browser worker must restore its `onmessage` dispatcher after libav.js
  6.8.8 direct mode; see `DemuxSessionOptions.onLibavReady`.

## Notes / limitations

- Build was compiled with `-Oz`. ST and MT artifacts were produced; only ST is
  runtime-verified in the browser. MT requires COOP/COEP and SAB and still needs
  a dedicated compatibility/performance run.
- The custom build uses FFmpeg 8.0 and libav.js 6.8.8; it is ABI-compatible
  with the current adapter but is not the same artifact as the prebuilt 6.10.9
  WebCodecs variant. The app loads it explicitly via `?libav=wasm-player-p0`.
- Distribution remains blocked on LGPL source/notice and codec patent/license
  review. The source tarballs are retained in the build cache; the repository
  commits only scripts, fragments, and the manifest.
