# P0 Feasibility Report (in progress)

Date: 2026-11-02. This report records only evidence produced in this repository.
It is not a G0 go/no-go decision yet.

## What was built

| Area | Evidence | Status |
| --- | --- | --- |
| Monorepo / toolchain | `pnpm-workspace.yaml`, strict TypeScript, ESLint, Vitest, dependency-cruiser, Playwright, CI skeleton | done |
| Contracts | `packages/contracts`, committed JSON Schema snapshots, registry/action/settings/error tests | done |
| Controller | `packages/player-core`, state machine, revisions, requestId dedupe, layered settings, jobs; 16 unit tests | done |
| Source readers | `packages/source-readers`, File/HTTP/sparse, Range/ETag/200 fallback/cancel; 15 tests including 6 GiB offsets | done |
| libav.js lock | `native/builds/toolchain.lock.json`, `native/builds/manifests/webcodecs.json`, hashed assets | partial (prebuilt ST only) |
| Demux/probe | `packages/ffmpeg-adapter` worker; real MP4 H.264/AAC, MKV HEVC/AC-3, WebM VP9/Opus, MKV subtitle streams; seek | done for supported containers |
| Browser decode | WebCodecs video/audio workers, AudioWorklet, WebGL2 renderer, external SRT/VTT/ASS text | done for MP4 slice |
| Browser e2e | Playwright system Chrome: open MP4, first frame, play, audio PCM, pause, seek, settings, SRT/ASS subtitles, screenshot, HTTP Range, 100 cycles | verified locally |
| ASS/SSA | JASSUB/libass canvas-only renderer on the player clock; visual screenshot archived | verified locally |
| Large file | 5 GiB sparse-extended valid MP4 through HTTP Range: probe, read, seek, tail read | verified locally (not movie-length) |
| Resource release | 100 open/close cycles; invalid media rejected then recovery; final queue 0 | verified locally |
| MCP/Companion | stdio MCP → loopback WS → browser; sessions/sources/open/settings/seek/state/capture/jobs/diagnostics; Host/Origin/token/traversal checks | verified locally |
| Legacy/WASM fallback | AVI demuxer and H.264/AAC/AC-3 WASM decoders absent from prebuilt variant; typed `UNSUPPORTED`/`DECODE_FAILED` | not delivered |

## Evidence paths

- `packages/contracts/schema/*.json`
- `tests/fixtures/manifest.json`
- `tests/e2e/playback.spec.ts`
- `native/builds/manifests/webcodecs.json`
- `docs/reports/environment-baseline.md`
- `docs/adr/0001..0006`

## G0 questions: current evidence

1. **>4 GiB random read / bounded buffers** — SparseSourceReader tests cover a
   6 GiB size and tail offsets. A real >4 GiB media file and memory curve are
   still external-environment work.
2. **Four sample families decode/sync in a real browser** — MP4 H.264/AAC is
   verified end-to-end. MKV HEVC/AC-3 and WebM VP9/Opus are verified at
   demux/probe level; AC-3 needs the custom WASM audio build, and VP9 is
   WebCodecs-only in this variant.
3. **Fallback and resource release on unsupported/runtime failure/no-SAB** —
   100 open/close cycles, invalid media, bad Origin/token and broker traversal
   are verified. Decoder runtime failure injection and no-SAB fallback still
   need dedicated runs.
4. **Color, ASS, audio and seek together** — Color/seek/audio/SRT work, and
   ASS/SSA is rendered by JASSUB/libass with the player clock; screenshot
   evidence exists. Font attachment/forced-style override remains P2.
5. **Deepin/Linux WebCodecs/GPU behavior** — Chrome 156 on the P0 workstation
   reports WebCodecs + WebGL2; hardware decode is deliberately reported as
   `unknown` without diagnostics evidence.
6. **Agent via Companion equals UI** — Verified end-to-end: MCP client lists
   sessions/sources, opens a broker source, applies settings, seeks, reads
   state, creates/polls a screenshot job and reads diagnostics.

## Current blockers / risks

- **Custom WASM build**: no Emscripten/clang/Docker on the workstation. Without
  this, P0-03/P0-14 and honest WASM fallback claims are blocked.
- **HEVC/AC-3**: the prebuilt webcodecs variant has no AC-3 decoder. The MKV
  sample is a video-only path until `decode-audio-common` lands.
- **Performance evidence**: 100-open/close and a 5 GiB sparse file are done,
  but no 1080p30 10-minute/2-hour run, real movie-length 4 GiB file, process
  memory accounting or physical-GPU performance gate exists.
- **Runtime failure injection**: decoder crash/recovery and GPU context loss
  are not yet exercised.
- **Companion distribution**: the local stdio/loopback bridge works, but a
  signed/standalone package and remote relay are not part of this slice.

## Next actions

1. Install/pin Emscripten and produce `demux-common` + `decode-*` artifacts with
   manifests (P0-02/P0-03).
2. Add AVI/MPEG-4/MP3 and AC-3 WASM decode paths; wire `MediaEngine` WASM
   decode fallback and forced-failure tests (P0-07/P0-09/P0-14).
3. Build the project-owned Emscripten variant with AVI + MPEG-4 + MP3 +
   H.264/AAC/AC-3 decoders and wire the WASM fallback.
4. Run 1080p30 10-minute/2-hour benchmark and memory/soak evidence on the
   physical machine; repeat the HTTP/Companion matrix on Windows/macOS.
