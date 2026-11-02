# P0 Environment Baseline

Date: 2026-11-02. All values below are measured on the P0 workstation unless
marked as a plan assumption.

## Host

| Item | Measured value |
| --- | --- |
| OS | Deepin 25 (crimson) |
| Kernel | 7.3.0-mkcustom-scx |
| CPU | Intel Core Ultra 9 285H, 16 cores / 16 threads, 1 socket |
| Memory | 30 GiB total, ~17 GiB available at measurement |
| Disk | `/dev/nvme0n1p9`, 387 GiB total, 107 GiB free on `/home` |
| GPU | Intel Arc Pro 130T/140T (Arrow Lake-P, `0x7d51`) |
| Mesa | 26.2.6, direct rendering, OpenGL core 4.6 |
| Chrome | Google Chrome 156.0.8078.47 (`/usr/bin/google-chrome`) |
| Node | v24.21.0 |
| npm | 12.1.0 |
| pnpm | 11.28.9 (via Corepack, user-local shim) |
| System FFmpeg | 6.1.5-0deepin4 (GPL build; reference/fixtures only, never shipped) |

## Missing tools at P0 start

| Tool | Status | Impact |
| --- | --- | --- |
| Emscripten (`emcc`) | missing | Project-owned FFmpeg/WASM builds are not yet produced; P0 uses the locked prebuilt libav.js variant. |
| clang | missing | Same as above. |
| Docker | missing | Optional reproducible build path not available yet. |

## Locked artifacts

- `native/builds/toolchain.lock.json`
- `native/builds/manifests/webcodecs.json`
- `@libav.js/variant-webcodecs@6.10.9` (`libav.js` build `6.10.9.0`)
- `libavjs-webcodecs-bridge@0.3.2`
- Browser primary target: Chrome 156 on Deepin/Linux.

## Notes / limitations

- The prebuilt `webcodecs` variant provides MP4/Matroska/Ogg/FLAC/WAV demuxing
  and WebCodecs parsers. It has no AVI demuxer and no WASM H.264/HEVC/VP8/VP9/AV1
  decoders. The legacy/AVI path and project-owned `demux-common` /
  `decode-*` builds remain P0-03/P0-14 work.
- Headless Chrome uses SwiftShader for WebGL2 in CI. Performance and hardware
  decode conclusions must be measured on the physical GPU, not headless CI.
- Audio verification in headless Chrome covers decode/PCM production; audible
  output and device clock behaviour require a physical machine run.
