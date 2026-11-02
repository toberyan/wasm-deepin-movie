# ADR-0002: Package boundaries and dependency direction

- Status: accepted
- Date: 2026-11-02

## Decision

- `contracts` is the single source of action/settings/error/event schemas. It
  has no runtime dependencies on other workspace packages.
- `player-core` owns playback state, revisions, request deduplication, layered
  settings and jobs. It depends only on `contracts` and the `media-engine` port.
- Concrete adapters (`ffmpeg-adapter`, `webcodecs-adapter`, `source-readers`,
  `renderer`, `audio`, `subtitles`) must not import `player-core` or the app.
- `apps/web` is the composition root. It wires the BrowserMediaEngine to the
  controller and UI, and does not import libav.js or the WebCodecs bridge
  directly.
- `dependency-cruiser` runs in CI and enforces these rules.

## Consequences

- UI, SDK and MCP can be generated from one registry.
- Swapping the media engine (test double, native adapter, future desktop host)
  does not require UI changes.
- The app composition root may import adapter public APIs, but not adapter
  internals or third-party media libraries.
