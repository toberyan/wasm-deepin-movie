# Performance and Resource Report (P0 slice)

Date: 2026-11-02. Environment: Deepin 25, Chrome 156.0.8078.47 headless with
SwiftShader, Intel Core Ultra 9 285H, 30 GiB RAM. These are functional
measurements, not the G0 benchmark gate.

## Results

| Scenario | Result | Notes |
| --- | --- | --- |
| Full e2e suite | 6 tests / 24.1 s | MP4 playback, seek/settings/SRT screenshot, ASS/JASSUB, HTTP Range, 100 cycles, MCP Companion |
| 100 open/close cycles | 16.4 s, 0 errors | Same 2 s MP4; final state idle; video queue 0; engine workers recreated each cycle |
| MP4 demux/probe (2 s, 640×360) | ~107 ms | Node/Vitest, includes libav WASM init |
| 5 GiB sparse MP4 probe + seek | 84 ms test body | HTTP Range server over a sparse-extended valid MP4; moov at start |
| Demux samples | MP4 H.264/AAC, MKV HEVC/AC-3, WebM VP9/Opus, MKV subtitle | Probe/read/seek; AVI intentionally unsupported by the prebuilt variant |
| Web build | ~2.2 s | Main bundle ~498 kB, demux worker ~186 kB, JASSUB WASM ~2.1/2.2 MB |

## Limitations

- The 2 s synthetic clip is not a 1080p30 10-minute playback benchmark.
- Headless SwiftShader is not a hardware decode/GPU performance environment.
- No 2-hour soak, background resume, GPU device loss or real movie-length
  benchmark has been run.
- `acceleration` remains `unknown`; no hardware-decode evidence is claimed.
- The 5 GiB file is a sparse-extended valid MP4 (trailing zero padding), which
  proves >4 GiB file size/offset/Range handling but not a 4 GiB movie duration.
