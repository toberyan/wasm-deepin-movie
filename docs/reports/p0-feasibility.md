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
| Browser e2e | Playwright system Chrome: open MP4, first frame, play, audio PCM, pause, seek, settings, subtitles, screenshot | verified locally |
| Legacy/WASM fallback | AVI demuxer and H.264/AAC WASM decoders absent from prebuilt variant; typed `UNSUPPORTED`/`DECODE_FAILED` | not delivered |
| MCP/Companion | Design/contract placeholders only | not delivered |

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
   The architecture and epoch/drop paths exist; runtime failure injection and
   100-open/close accounting are not yet run.
4. **Color, ASS, audio and seek together** — Color/seek/audio work in the MP4
   slice. ASS styling (JASSUB/libass) is not integrated; only text extraction.
5. **Deepin/Linux WebCodecs/GPU behavior** — Chrome 156 on the P0 workstation
   reports WebCodecs + WebGL2; hardware decode is deliberately reported as
   `unknown` without diagnostics evidence.
6. **Agent via Companion equals UI** — Not delivered; the controller registry
   and dedupe/revision semantics are ready for the SDK/MCP adapter.

## Current blockers / risks

- **Custom WASM build**: no Emscripten/clang/Docker on the workstation. Without
  this, P0-03/P0-14 and honest WASM fallback claims are blocked.
- **HEVC/AC-3**: the prebuilt webcodecs variant has no AC-3 decoder. The MKV
  sample is a video-only path until `decode-audio-common` lands.
- **ASS styling**: text extraction is not a substitute for libass layout. The
  design requires JASSUB/libass for P0-11.
- **Performance evidence**: no 10-minute playback, 100-open/close, memory
  accounting or real >4 GiB run has been executed. Headless e2e is functional
  evidence only, not a performance gate.
- **Companion/MCP**: not implemented; no security/Origin/token evidence yet.

## Next actions

1. Install/pin Emscripten and produce `demux-common` + `decode-*` artifacts with
   manifests (P0-02/P0-03).
2. Add AVI/MPEG-4/MP3 and AC-3 WASM decode paths; wire `MediaEngine` WASM
   decode fallback and forced-failure tests (P0-07/P0-09/P0-14).
3. Integrate JASSUB/libass for ASS with player-clock rendering (P0-11).
4. Implement Companion stdio/loopback + SDK e2e (P0-13).
5. Run benchmark/soak evidence on the physical machine and write
   `docs/reports/performance-*.md` / `soak-*.md`.
