# Third-party licenses and distribution notes

Date: 2026-11-02. This is an engineering inventory, not legal advice. Publish a
release only after the license review in the development plan is complete.

## Runtime / build dependencies

| Component | Version | License | Notes |
| --- | --- | --- | --- |
| `@libav.js/variant-webcodecs` | 6.10.9 | LGPL-2.1-or-later | Prebuilt Emscripten artifact; includes FFmpeg-derived code. The NPM artifact does not ship the `sources/` directory. Distribution requires corresponding source and build scripts for the exact artifact. |
| `libavjs-webcodecs-bridge` | 0.3.2 | ISC | Type shim is local; packet conversion is implemented in `ffmpeg-adapter` to handle negative PTS correctly. |
| React / React DOM | 19.3.1 | MIT | Web UI. |
| Vite / Vitest / TypeScript | pinned | MIT / Apache-2.0 | Build and test tooling, not distributed as runtime. |
| Zod | 4.6.7 | MIT | Contracts and schema generation. |
| System FFmpeg | 6.1.5-0deepin4 | GPL build | Used only for test fixture generation and reference output. It must not enter a distributed WASM build or product artifact. |
| JASSUB | 2.5.23 | MIT | ASS/SSA rendering wrapper; bundles libass WASM. Libass is ISC-licensed; verify the bundled notice/source requirements before distribution. |
| `@modelcontextprotocol/sdk` | 1.32.2 | MIT | MCP server/client transport. |
| `ws` | 8.22.1 | MIT | Loopback WebSocket control bridge. |

## Test fixtures

The MP4/MKV/WebM/AVI fixtures under `tests/fixtures/generated/` are synthetic
lavfi outputs generated locally. They are test assets, not product media. H.264,
HEVC, AAC and AC-3 are patent-encumbered technologies; review distribution before
publishing binaries or sample packs.

## Release gate

- Confirm the final FFmpeg configure flags do not enable GPL/nonfree components.
- Ship the LGPL source/notice for every distributed libav.js/FFmpeg artifact.
- Record hashes and build parameters in `native/builds/manifests/*.json`.
- Keep the system GPL FFmpeg out of `apps/web/dist` and WASM artifacts.
- Record subtitle/font/test-asset licenses before publishing.
