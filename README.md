# WASM Player

Browser-first video player with a hybrid media pipeline:

- FFmpeg/libav.js in a worker for demux, probe and block-device I/O.
- WebCodecs for H.264/AAC (and other browser-supported codecs) decode.
- WebGL2 for rendering and SDR picture controls.
- AudioWorklet for bounded PCM output and the audio-consumed master clock.
- A controller-owned action registry shared by UI, SDK and the future MCP layer.

The design and development baseline live in:

- `docs/superpowers/specs/2026-11-02-wasm-player-design.md`
- `docs/superpowers/plans/2026-11-02-wasm-player-development-plan.md`

## Quick start

```bash
corepack enable
pnpm install
pnpm libav:sync        # copies the locked ST libav.js assets to public/libav
pnpm dev               # http://127.0.0.1:5173
```

Open a local MP4/MOV/MKV/WebM file from the UI or drag it onto the stage. The
P0 prebuilt variant supports MP4/Matroska/WebM/Ogg/FLAC/WAV demuxing; H.264/H.265/
VP8/VP9/AV1 use WebCodecs. See the support matrix in the P0 report before
assuming a format works.

## Companion / Agent

```bash
pnpm build
node apps/companion/dist/cli.js --stdio --port 4178 \
  --allow-root tests/fixtures/generated
# open http://127.0.0.1:4178/ so the browser session connects
```

MCP client config:

```json
{
  "mcpServers": {
    "wasm-player": {
      "command": "node",
      "args": [
        "apps/companion/dist/cli.js",
        "--stdio",
        "--allow-root",
        "tests/fixtures/generated"
      ]
    }
  }
}
```

The Companion binds loopback only, validates Host/Origin/token, brokers only
explicitly allowed roots, and keeps MCP protocol output on stdout. See
`docs/adr/0007-companion-security.md`.

## Checks

```bash
pnpm lint
pnpm typecheck
pnpm schema:check
pnpm test
pnpm depcruise
pnpm test:e2e          # system Chrome; needs the P0 fixtures
pnpm build
```

`pnpm fixtures` regenerates the committed synthetic test fixtures and
`tests/fixtures/manifest.json`.

## Repository layout

```text
apps/web                 React UI + BrowserMediaEngine composition
apps/companion           MCP stdio + loopback control bridge + media broker
packages/contracts       actions, settings, events, errors, JSON Schema
packages/player-core     Controller, revisions, jobs, layered settings
packages/media-engine    ports, clock, frame queue, codec routing
packages/source-readers  File, HTTP Range, sparse readers
packages/ffmpeg-adapter  libav.js demux worker, probe, seek, block I/O
packages/webcodecs-adapter  VideoDecoder/AudioDecoder workers
packages/renderer       WebGL2 shader pipeline
packages/audio          AudioWorklet PCM output and clock
packages/subtitles      SRT/VTT/ASS text parsing and DOM overlay
native/builds           toolchain lock + artifact manifests
tests/fixtures          synthetic samples + manifest
tests/e2e               Playwright playback flows
docs/adr                architecture decisions
docs/reports            environment/P0 evidence
```

## Current P0 status (honest scope)

Working and verified:

- MP4/MKV/WebM probe with real libav.js; MP4 H.264/AAC playback in Chrome.
- First frame, video decode/render, audio decode/PCM, pause/resume, seek, rate,
  brightness/contrast/saturation/gamma, external SRT subtitles, screenshot.
- SourceReader tests including a 6 GiB sparse offset and HTTP `206`/ETag/200
  fallback behavior.
- Contracts/core tests, JSON Schema snapshots, dependency-cruiser rules.

Not yet delivered:

- Project-owned Emscripten/FFmpeg builds (`demux-common`, `decode-*` ST/MT).
- AVI/MPEG-4/MP3 legacy path and WASM decode fallback for H.264/AAC.
- JASSUB/libass ASS styling; P0 only extracts ASS text.
- MCP Companion, HTTP e2e, real >4 GiB media, performance/soak reports,
  Windows/macOS matrix.
- Desktop shell (P4).

## Custom WASM fallback

The project-owned variant adds AVI/MPEG-4/MP3 and H.264/HEVC/AAC/AC-3/FLAC/
Opus decoder candidates:

```bash
source ~/tools/emsdk/emsdk_env.sh
pnpm wasm:build
pnpm libav:sync
pnpm dev
# open http://127.0.0.1:5173/?libav=wasm-player-p0
```

`?libav=wasm-player-p0` selects the built variant for the demux/decode worker;
the default page keeps using the prebuilt WebCodecs variant. The custom AVI and
forced-WASM tests skip automatically when the artifacts are not built. See
`docs/reports/wasm-build-2026-11-02.md`.
