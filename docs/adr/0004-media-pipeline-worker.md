# ADR-0004: P0 media pipeline and worker boundaries

- Status: accepted for P0; renderer worker remains an open option
- Date: 2026-11-02

## Decision

- `demux.worker` owns libav.js, SourceReader, probe, packet reading and seeking.
  Requests are serialized so `read` and `seek` never race on the FFmpeg format
  context.
- `video-decoder.worker` owns WebCodecs `VideoDecoder` and transfers
  `VideoFrame` objects to the main thread.
- `audio-decoder.worker` owns WebCodecs `AudioDecoder`, converts `AudioData` to
  planar f32 PCM and transfers buffers to the main thread.
- The AudioWorklet owns the bounded PCM ring, rate-adjusted consumption and the
  audio-consumed clock. The main thread never advances audio by wall clock.
- The renderer is WebGL2 on the main thread in P0. The design's optional
  `render.worker`/OffscreenCanvas path remains a decision for G0; the current
  P0 slice prioritizes a working, observable pipeline and screenshot path.
- All cross-worker messages carry an epoch; stale frames/PCM/packets are
  dropped after open/seek/reset.

## Consequences

- The media data plane stays out of React; the UI only sees the controller
  snapshot and events.
- Renderer worker migration is a contained change behind the renderer package.
- The demux worker serialization adds latency when a seek arrives during a
  read, but prevents FFmpeg context corruption. Reads are bounded to ~256 KiB
  per request in the current slice.

## Known P0 deviation

The plan prefers `render.worker` with OffscreenCanvas. This slice uses the main
thread because VideoFrame transfer + WebGL2 screenshot and the title/subtitle
overlay are simpler to verify. It is recorded as a G0 decision input, not a
claim that the final architecture is settled.
