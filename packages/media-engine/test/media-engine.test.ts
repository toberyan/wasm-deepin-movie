import { describe, expect, it } from "vitest";
import { MediaClock, VideoFrameQueue, routeTracks } from "../src/index";
import type { MediaStreamInfo } from "@wasm-player/contracts";

describe("MediaClock", () => {
  it("advances media time at the anchored rate", () => {
    const clock = new MediaClock("monotonic");
    clock.anchorAt(5_000_000, 10);
    clock.play(10);
    expect(clock.now(10)).toBe(5_000_000);
    expect(clock.now(12)).toBe(7_000_000);
    clock.setRate(2, 12);
    expect(clock.now(13)).toBe(9_000_000);
  });

  it("freezes while paused and resumes from the frozen position", () => {
    const clock = new MediaClock("monotonic");
    clock.anchorAt(0, 0);
    clock.play(0);
    expect(clock.now(3)).toBe(3_000_000);
    clock.pause(3);
    expect(clock.now(10)).toBe(3_000_000);
    clock.play(10);
    expect(clock.now(11)).toBe(4_000_000);
  });

  it("applies seek without leaking elapsed time", () => {
    const clock = new MediaClock("monotonic");
    clock.anchorAt(0, 0);
    clock.play(0);
    clock.seek(30_000_000, 5);
    expect(clock.now(5)).toBe(30_000_000);
    expect(clock.now(7)).toBe(32_000_000);
  });

  it("compensates audio clock messages for callback latency", () => {
    const clock = new MediaClock("audio");
    clock.anchorAt(0, 0);
    clock.play(0);
    clock.syncFromAudio(1_000_000, 10, 10.05);
    expect(clock.now(10.05)).toBe(1_050_000);
  });

  it("ignores audio sync while using the monotonic source", () => {
    const clock = new MediaClock("monotonic");
    clock.anchorAt(0, 0);
    clock.play(0);
    clock.syncFromAudio(10_000_000, 1, 1.1);
    expect(clock.now(1)).toBe(1_000_000);
  });

  it("rejects invalid rates", () => {
    const clock = new MediaClock();
    expect(() => clock.setRate(0, 0)).toThrow(RangeError);
    expect(() => clock.setRate(-1, 0)).toThrow(RangeError);
  });
});

interface TestFrame {
  timestampUs: number;
  durationUs?: number;
  byteLength: number;
}

describe("VideoFrameQueue", () => {
  const limits = { maxFrames: 4, maxBytes: 1000, maxDurationUs: 200_000 };

  it("returns the newest due frame and counts expired frames", () => {
    const queue = new VideoFrameQueue<TestFrame>(limits);
    queue.push({ timestampUs: 0, durationUs: 33_333, byteLength: 100 });
    queue.push({ timestampUs: 33_333, durationUs: 33_333, byteLength: 100 });
    queue.push({ timestampUs: 66_666, durationUs: 33_333, byteLength: 100 });
    const due = queue.takeDue(70_000);
    expect(due?.timestampUs).toBe(66_666);
    expect(queue.droppedFrames).toBe(2);
    expect(queue.size).toBe(0);
  });

  it("releases every expired frame through the callback", () => {
    const released: number[] = [];
    const queue = new VideoFrameQueue<TestFrame>(limits, (frame) => {
      released.push(frame.timestampUs);
    });
    queue.push({ timestampUs: 0, durationUs: 33_333, byteLength: 100 });
    queue.push({ timestampUs: 33_333, durationUs: 33_333, byteLength: 100 });
    queue.push({ timestampUs: 66_666, durationUs: 33_333, byteLength: 100 });
    const due = queue.takeDue(70_000);
    expect(due?.timestampUs).toBe(66_666);
    // Both expired frames are released; the returned frame stays owned by the
    // caller until it is rendered.
    expect(released).toEqual([0, 33_333]);
  });

  it("does not return future frames", () => {
    const queue = new VideoFrameQueue<TestFrame>(limits);
    queue.push({ timestampUs: 100_000, byteLength: 100 });
    expect(queue.takeDue(99_999)).toBeUndefined();
    expect(queue.size).toBe(1);
  });

  it("enforces frame count limits", () => {
    const queue = new VideoFrameQueue<TestFrame>({ ...limits, maxFrames: 2 });
    queue.push({ timestampUs: 0, byteLength: 10 });
    queue.push({ timestampUs: 1, byteLength: 10 });
    const result = queue.push({ timestampUs: 2, byteLength: 10 });
    expect(result.overLimit).toBe(true);
    expect(result.dropped).toHaveLength(1);
    expect(queue.size).toBe(2);
    expect(queue.droppedFrames).toBe(1);
  });

  it("enforces byte limits", () => {
    const queue = new VideoFrameQueue<TestFrame>({ ...limits, maxBytes: 150 });
    queue.push({ timestampUs: 0, byteLength: 100 });
    const result = queue.push({ timestampUs: 1, byteLength: 100 });
    expect(result.overLimit).toBe(true);
    expect(queue.byteLength).toBe(100);
  });

  it("enforces duration limits", () => {
    const queue = new VideoFrameQueue<TestFrame>({ ...limits, maxDurationUs: 50_000 });
    queue.push({ timestampUs: 0, durationUs: 30_000, byteLength: 10 });
    queue.push({ timestampUs: 30_000, durationUs: 30_000, byteLength: 10 });
    const result = queue.push({ timestampUs: 60_000, durationUs: 30_000, byteLength: 10 });
    expect(result.overLimit).toBe(true);
    expect(queue.durationUs).toBeLessThanOrEqual(50_000);
  });

  it("clears all accounted bytes", () => {
    const queue = new VideoFrameQueue<TestFrame>(limits);
    queue.push({ timestampUs: 0, byteLength: 100 });
    queue.clear();
    expect(queue.size).toBe(0);
    expect(queue.byteLength).toBe(0);
  });
});

const streams: MediaStreamInfo[] = [
  {
    index: 0,
    type: "video",
    codec: "h264",
    codecId: 27,
    width: 640,
    height: 360,
    default: true,
    forced: false
  },
  {
    index: 1,
    type: "audio",
    codec: "aac",
    codecId: 86018,
    sampleRate: 48000,
    channels: 2,
    default: true,
    forced: false
  },
  {
    index: 2,
    type: "subtitle",
    codec: "ass",
    codecId: 0,
    default: false,
    forced: false
  }
];

describe("decode routing", () => {
  it("prefers WebCodecs independently per track", () => {
    const result = routeTracks(streams, {
      "video:0": { webcodecs: true, wasm: true },
      "audio:1": { webcodecs: false, wasm: true }
    });
    expect(result.decodePaths).toEqual({
      "video:0": "webcodecs",
      "audio:1": "wasm"
    });
    expect(result.unsupported).toHaveLength(0);
  });

  it("reports tracks with no decoder", () => {
    const result = routeTracks(streams, {
      "video:0": { webcodecs: true, wasm: false },
      "audio:1": { webcodecs: false, wasm: false, reason: "no AAC decoder" }
    });
    expect(result.unsupported).toHaveLength(1);
    expect(result.unsupported[0]?.key).toBe("audio:1");
    expect(result.unsupported[0]?.reason).toBe("no AAC decoder");
  });

  it("honors a forced path and falls back with a reason", () => {
    const forcedWasm = routeTracks(
      streams,
      {
        "video:0": { webcodecs: true, wasm: true },
        "audio:1": { webcodecs: true, wasm: true }
      },
      { force: { video: "wasm" } }
    );
    expect(forcedWasm.decodePaths["video:0"]).toBe("wasm");
    expect(forcedWasm.playbackTracks.find((track) => track.key === "video:0")?.forced).toBe(true);

    const forcedWebCodecs = routeTracks(
      streams,
      {
        "video:0": { webcodecs: false, wasm: true },
        "audio:1": { webcodecs: true, wasm: true }
      },
      { force: { video: "webcodecs" } }
    );
    expect(forcedWebCodecs.decodePaths["video:0"]).toBe("wasm");
    expect(forcedWebCodecs.playbackTracks[0]?.reason).toContain("fell back");
  });
});
