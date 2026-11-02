import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { DemuxSession } from "../src/index";

const fixtureRoot = resolve("tests/fixtures/generated");

async function fileSource(name: string): Promise<{ name: string; file: File }> {
  const data = await readFile(resolve(fixtureRoot, name));
  return {
    name,
    file: new File([new Uint8Array(data)], name, { type: "application/octet-stream" })
  };
}

describe("DemuxSession", () => {
  it("probes MP4 and reads H.264/AAC packets", async () => {
    const source = await fileSource("sample-h264-aac.mp4");
    const session = new DemuxSession();
    try {
      const probe = await session.open({ kind: "file", file: source.file, name: source.name });
      expect(probe.media.container).toBe("mp4");
      expect(probe.media.durationUs).toBeGreaterThan(1_900_000);
      expect(probe.media.sizeBytes).toBe(source.file.size);
      expect(probe.media.streams).toHaveLength(2);
      const video = probe.media.streams.find((stream) => stream.type === "video");
      const audio = probe.media.streams.find((stream) => stream.type === "audio");
      expect(video).toMatchObject({ codec: "h264", width: 640, height: 360 });
      expect(video?.color?.bitDepth).toBe(8);
      expect(audio).toMatchObject({ codec: "aac", sampleRate: 48000, channels: 1 });
      const videoConfig = probe.configs[video!.index];
      expect(videoConfig).toMatchObject({ type: "video", codec: expect.stringMatching(/^avc1\./) });
      expect(probe.configs[audio!.index]).toMatchObject({
        type: "audio",
        codec: "mp4a.40.2",
        sampleRate: 48000
      });
      const videoRoute = probe.routes.find((route) => route.type === "video");
      expect(videoRoute?.webcodecs).toBe(true);
      expect(probe.media.decodePaths["video:0"]).toBe("webcodecs");

      let videoPackets = 0;
      let audioPackets = 0;
      let firstVideoPts: number | null = null;
      let eof = false;
      while (!eof) {
        const result = await session.read(256 * 1024, 128);
        for (const packet of result.packets) {
          if (packet.streamType === "video") {
            videoPackets += 1;
            if (firstVideoPts === null) firstVideoPts = packet.ptsUs;
            expect(packet.data.byteLength).toBeGreaterThan(0);
          } else {
            audioPackets += 1;
          }
        }
        eof = result.eof;
      }
      expect(videoPackets).toBe(60);
      expect(audioPackets).toBeGreaterThan(80);
      expect(firstVideoPts).toBe(0);
    } finally {
      await session.close();
    }
  }, 30_000);

  it("seeks to a keyframe and returns a usable first batch", async () => {
    const source = await fileSource("sample-h264-aac.mp4");
    const session = new DemuxSession();
    try {
      await session.open({ kind: "file", file: source.file, name: source.name });
      const result = await session.seek(1_000_000);
      expect(result.requestedUs).toBe(1_000_000);
      expect(result.positionUs).toBeGreaterThanOrEqual(950_000);
      expect(result.positionUs).toBeLessThanOrEqual(1_100_000);
      expect(result.packets.length).toBeGreaterThan(0);
      const video = result.packets.find((packet) => packet.streamType === "video");
      expect(video?.keyframe).toBe(true);
      expect(video?.ptsUs).toBe(result.positionUs);
    } finally {
      await session.close();
    }
  }, 30_000);

  it("probes MKV HEVC/AC-3 and reports independent routing", async () => {
    const source = await fileSource("sample-hevc-ac3.mkv");
    const session = new DemuxSession();
    try {
      const probe = await session.open({ kind: "file", file: source.file, name: source.name });
      expect(probe.media.container).toBe("matroska");
      const video = probe.media.streams.find((stream) => stream.type === "video");
      const audio = probe.media.streams.find((stream) => stream.type === "audio");
      expect(video?.codec).toBe("hevc");
      expect(audio?.codec).toBe("ac3");
      expect(audio?.channels).toBe(6);
      expect(probe.configs[video!.index]).toBeDefined();
      expect(probe.configs[audio!.index]).toBeUndefined();
      const audioRoute = probe.routes.find((route) => route.type === "audio");
      expect(audioRoute?.webcodecs).toBe(false);
      expect(probe.media.decodePaths[`audio:${audio!.index}`]).toBe("wasm");
      const first = await session.read(256 * 1024, 64);
      expect(first.packets.some((packet) => packet.streamType === "video")).toBe(true);
      expect(first.packets.some((packet) => packet.streamType === "audio")).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  it("probes WebM VP9/Opus with both WebCodecs and WASM audio", async () => {
    const source = await fileSource("sample-vp9-opus.webm");
    const session = new DemuxSession();
    try {
      const probe = await session.open({ kind: "file", file: source.file, name: source.name });
      expect(probe.media.container).toBe("webm");
      const video = probe.media.streams.find((stream) => stream.type === "video");
      const audio = probe.media.streams.find((stream) => stream.type === "audio");
      expect(video?.codec).toBe("vp9");
      expect(audio?.codec).toBe("opus");
      const audioRoute = probe.routes.find((route) => route.type === "audio");
      expect(audioRoute?.webcodecs).toBe(true);
      expect(audioRoute?.wasm).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  it("exposes subtitle tracks from Matroska", async () => {
    const source = await fileSource("sample-h264-aac-subs.mkv");
    const session = new DemuxSession();
    try {
      const probe = await session.open({ kind: "file", file: source.file, name: source.name });
      const subtitle = probe.media.streams.find((stream) => stream.type === "subtitle");
      expect(subtitle?.codec).toBe("subrip");
      expect(subtitle?.language).toBe("eng");
      expect(probe.tracks.some((track) => track.type === "subtitle")).toBe(true);
    } finally {
      await session.close();
    }
  }, 30_000);

  it("reports unsupported containers as a typed error", async () => {
    const source = await fileSource("sample-mpeg4-mp3.avi");
    const session = new DemuxSession();
    try {
      await expect(
        session.open({ kind: "file", file: source.file, name: source.name })
      ).rejects.toMatchObject({ code: "DECODE_FAILED" });
    } finally {
      await session.close();
    }
  }, 30_000);
});
