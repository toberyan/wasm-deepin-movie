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
packages/storage         IndexedDB persistence for settings/history/library
packages/host            browser PlayerHost implementation
packages/agent-sdk       typed in-process agent client over the action registry
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
  hue/rotation/crop/sharpness/scale modes, external SRT and JASSUB ASS subtitles,
  screenshot.
- Project-owned ST/MT variants: AVI/MPEG-4/MP3, forced H.264/AAC, HEVC/AC-3,
  FLAC/Opus; AVI auto-selects the custom variant by container extension.
- Audio/video track switching by rebuilding the pipeline at the current position.
- IndexedDB persistence for global settings, history, playlist, bookmarks and
  presets; library drawer and light/system theme.
- Playlist loop, audio gain/balance, HTTP Range e2e, 5 GiB sparse offsets,
  100 open/close cycles, MCP Companion, typed Agent SDK.
- Contracts/core tests, JSON Schema snapshots, dependency-cruiser rules.

Not yet delivered:

- Physical-GPU 1080p30 10-minute/2-hour soak, process-memory evidence and a real
  >4 GiB movie (sparse-extension only so far).
- `demux-common`/`decode-*` on-demand package split; MT runtime is blocked by a
  libav.js threaded artifact error (`AVFormatContext_nb_streams` in a Worker).
- Embedded subtitle packet extraction and font attachments; PGS/VobSub.
- H.264 Matroska WebCodecs is experimental in this Chrome build; the stable
  H.264 MKV test uses the custom WASM decoder. Runtime per-track fallback is
  still pending.
- HDR/WebGPU, HLS/DASH, 10-bit/tone mapping; full compatibility matrix and
  Windows/macOS runners; audio delay/EQ and device selection.
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

Legacy container extensions (`.avi`, `.flv`, `.ts`, `.mpg`, `.wmv`, `.rmvb`,
raw `.mp3`/`.aac`) select the custom variant automatically. `?libav=wasm-player-p0`
still forces it for any source, and `?libavThreads=mt` requests the threaded
artifact (currently experimental; see the remaining-work report). The custom
AVI and forced-WASM tests skip automatically when the artifacts are not built.
See `docs/reports/wasm-build-2026-11-02.md`.
