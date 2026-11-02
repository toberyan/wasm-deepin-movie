# ADR-0008: Project-owned WASM fallback and direct-worker loading

- Status: accepted
- Date: 2026-11-02

## Decision

- Build a project-owned libav.js 6.8.8 / FFmpeg 8.0 variant with SWScale,
  SWResample, AVI/MPEG-4/MP3 and H.264/HEVC/AAC/AC-3/FLAC/Opus decoders.
- Publish ST and MT artifacts plus manifests; the browser uses ST by default.
- Route each track independently: WebCodecs when supported, otherwise a WASM
  decoder in the demux worker. WASM video is converted to RGBA ImageData by
  SWScale and transferred as `VideoFrame` buffers; WASM audio is converted to
  planar f32 PCM and fed to the same AudioWorklet.
- The custom loader is selected with `?libav=wasm-player-p0`; the prebuilt
  WebCodecs variant remains the default.
- libav.js 6.8.8 direct mode installs a global `onmessage`; the worker restores
  its own dispatcher via `onLibavReady`, otherwise post-open requests are lost.

## Consequences

- AVI/MPEG-4/MP3 now play in Chrome without MSE/native support.
- Forced H.264/AAC and HEVC/AC-3 fallback paths are testable and verified.
- The monolithic variant is large (~4 MB wasm) and currently loaded as one
  package; splitting `demux-common`/`decode-*` and on-demand loading remains a
  follow-up.
- The RGBA ImageData path costs a YUV→RGBA conversion and buffer copy; a direct
  YUV texture path is a future optimization.
- MT artifacts exist but still need a runtime/COOP/COEP verification pass.
