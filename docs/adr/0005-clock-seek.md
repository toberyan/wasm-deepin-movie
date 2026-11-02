# ADR-0005: Clock, seek and epoch semantics

- Status: accepted
- Date: 2026-11-02

## Decision

- Audio is the master clock when an audio output exists: the AudioWorklet
  reports consumed source frames and the media time derived from the first PCM
  timestamp. The main thread uses that clock for video scheduling and position.
- Without audio, `MediaClock` provides a pausable, rate-aware monotonic clock.
- Every open, seek and decoder reset increments an epoch. Demux reads, decoded
  frames, PCM and worker callbacks from an older epoch are discarded.
- Seek clears the video queue and PCM buffer, resets both decoders, asks the
  demux worker to seek to the preceding keyframe, feeds the returned packets,
  and drops decoded frames before the requested target.
- The returned seek result includes requested/actual time and error. Exact
  visual accuracy is enforced by dropping pre-target frames; the demux seek is
  keyframe-based with `AVSEEK_FLAG_BACKWARD`.

## Consequences

- Pause/resume/rate changes do not use wall-clock position increments.
- Seeking while the pump is reading is safe because worker requests are
  serialized and stale packets are epoch-filtered.
- Reverse stepping and continuous negative rates remain P3.
