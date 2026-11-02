# ADR-0001: Monorepo, package manager and P0 toolchain

- Status: accepted
- Date: 2026-11-02

## Context

The plan requires a pnpm workspace, TypeScript strict, Vite/React, Vitest,
Playwright with system Chrome, dependency-cruiser, and pinned FFmpeg/libav.js
artifacts. The P0 workstation does not have Emscripten, clang or Docker, so a
project-owned FFmpeg WASM build cannot be produced in the first slice.

## Decision

- pnpm 11.28.9 workspace, Node 24.21.0, TypeScript 5.9.3.
- Vite 7.3.7 + React 19.3.1 for the web app; Vitest 3.2.7 for unit/contract
  tests; Playwright 1.64.1 with `channel: "chrome"` for browser verification.
- Use `@libav.js/variant-webcodecs@6.10.9` and
  `libavjs-webcodecs-bridge@0.3.2` as the locked P0 demux/prebuilt artifact.
- Copy only the required ST loader/target/WASM files into
  `apps/web/public/libav/` at build time via `scripts/sync-libav-assets.mjs`.
- Keep the custom Emscripten/FFmpeg build path as an explicit P0-03 gap; do not
  claim the prebuilt variant is the final product build.

## Consequences

- The first vertical slice is testable now, but AVI/MPEG-4/MP3 and WASM video
  decode fallback are not available until the custom build lands.
- Distribution of the prebuilt variant requires LGPL source availability and
  the locked manifest; see `docs/legal/third-party.md`.
- Version upgrades are explicit lockfile/ADR changes, never floating `latest`.
