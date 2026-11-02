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
| libav.js lock | `native/builds/toolchain.lock.json`, prebuilt WebCodecs manifest, custom ST/MT manifests and hashes | done |
| Demux/probe | `packages/ffmpeg-adapter` worker; real MP4 H.264/AAC, MKV HEVC/AC-3, WebM VP9/Opus, MKV subtitle streams; seek | done for supported containers |
| Browser decode | WebCodecs video/audio workers, WASM decode fallback, AudioWorklet, WebGL2 renderer, SRT/VTT and JASSUB ASS | done |
| Browser e2e | Playwright system Chrome: open MP4, first frame, play, audio PCM, pause, seek, settings, SRT/ASS subtitles, screenshot, HTTP Range, 100 cycles | verified locally |
| ASS/SSA | JASSUB/libass canvas-only renderer on the player clock; visual screenshot archived | verified locally |
| Large file | 5 GiB sparse-extended valid MP4 through HTTP Range: probe, read, seek, tail read | verified locally (not movie-length) |
| Resource release | 100 open/close cycles; invalid media rejected then recovery; final queue 0 | verified locally |
| MCP/Companion | stdio MCP → loopback WS → browser; sessions/sources/open/settings/seek/state/capture/jobs/diagnostics; Host/Origin/token/traversal checks | verified locally |
| Custom WASM variant | Emscripten 6.0.13 + libav.js 6.8.8 + FFmpeg 8.0; ST/MT artifacts + manifests; AVI/MPEG-4/MP3 and H.264/AAC/HEVC/AC-3 forced WASM playback verified in Chrome | done |

## Evidence paths

- `packages/contracts/schema/*.json`
- `tests/fixtures/manifest.json`
- `tests/e2e/playback.spec.ts`
- `native/builds/manifests/webcodecs.json`
- `native/builds/manifests/wasm-player-p0-st.json` / `-mt.json`
- `docs/reports/wasm-build-2026-11-02.md`
- `docs/reports/environment-baseline.md`
- `docs/adr/0001..0008`

## G0 questions: current evidence

1. **>4 GiB random read / bounded buffers** — SparseSourceReader tests cover a
   6 GiB size and tail offsets. A real >4 GiB media file and memory curve are
   still external-environment work.
2. **Four sample families decode/sync in a real browser** — MP4 H.264/AAC
   (WebCodecs and forced WASM), MKV HEVC/AC-3 (forced WASM), AVI MPEG-4/MP3
   (WASM), and WebM VP9/Opus (probe/route) are covered. WebM browser playback
   remains `experimental`.
3. **Fallback and resource release on unsupported/runtime failure/no-SAB** —
   100 open/close cycles, invalid media, WASM seek/decoder reset, bad
   Origin/token and broker traversal are verified. Decoder runtime failure
   injection and no-SAB fallback still need dedicated runs.
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

- **WASM packaging**: the custom variant is monolithic. The planned
  `demux-common`/`decode-*` split and on-demand loading are not done.
- **MT runtime**: MT artifacts exist, but the browser still uses the ST loader;
  MT needs a COOP/COEP/SAB runtime and performance pass.
- **Performance evidence**: 100-open/close and a 5 GiB sparse file are done,
  but no 1080p30 10-minute/2-hour run, real movie-length 4 GiB file, process
  memory accounting or physical-GPU performance gate exists.
- **Runtime failure injection**: decoder crash/recovery and GPU context loss
  are not yet exercised.
- **Companion distribution**: the local stdio/loopback bridge works, but a
  signed/standalone package and remote relay are not part of this slice.

## Next actions

1. Split the custom variant into `demux-common`/`decode-*` packages and wire
   on-demand loading; verify the MT artifact under COOP/COEP.
2. Run 1080p30 10-minute/2-hour benchmark and memory/soak evidence on the
   physical machine; repeat the HTTP/Companion matrix on Windows/macOS.
3. Add decoder runtime-failure injection and GPU context-loss recovery tests.
4. Extend the browser matrix to Windows/macOS and decide HLS/DASH at G2.
