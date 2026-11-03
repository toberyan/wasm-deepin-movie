import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const generated = join(root, "tests/fixtures/generated");
const files = (await readdir(generated))
  .filter((name) => /\.(mp4|mkv|webm|avi)$/.test(name) && name !== "large-sparse.mp4")
  .sort();

const ids = {
  "sample-h264-aac.mp4": "S1",
  "sample-hevc-ac3.mkv": "S2",
  "sample-vp9-opus.webm": "S3",
  "sample-mpeg4-mp3.avi": "S4",
  "sample-h264-aac-subs.mkv": "S5",
  "sample-multi-audio.mp4": "S6",
  "sample-multi-video.webm": "S7"
};

const expected = {
  "sample-h264-aac.mp4": { video: "webcodecs", audio: "webcodecs" },
  "sample-hevc-ac3.mkv": { video: "webcodecs", audio: "wasm" },
  "sample-vp9-opus.webm": { video: "webcodecs", audio: "webcodecs" },
  "sample-mpeg4-mp3.avi": null,
  "sample-h264-aac-subs.mkv": { video: "webcodecs", audio: "webcodecs" },
  "sample-multi-audio.mp4": { video: "webcodecs", audio: "webcodecs" },
  "sample-multi-video.webm": { video: "webcodecs", audio: "webcodecs" }
};

const fixtures = [];
for (const name of files) {
  const path = join(generated, name);
  const data = await readFile(path);
  const info = await stat(path);
  const probe = JSON.parse(
    execFileSync(
      "ffprobe",
      [
        "-hide_banner",
        "-v",
        "error",
        "-show_entries",
        "format=format_name,duration,size:stream=index,codec_type,codec_name,profile,width,height,sample_rate,channels,channel_layout,pix_fmt,bits_per_raw_sample",
        "-of",
        "json",
        path
      ],
      { encoding: "utf8" }
    )
  );
  const video = probe.streams.find((stream) => stream.codec_type === "video");
  const audio = probe.streams.find((stream) => stream.codec_type === "audio");
  const subtitle = probe.streams.find((stream) => stream.codec_type === "subtitle");
  const fixture = {
    id: ids[name] ?? name,
    path: `generated/${name}`,
    sha256: createHash("sha256").update(data).digest("hex"),
    bytes: info.size,
    container: probe.format.format_name,
    durationSec: Number(probe.format.duration),
    video: video
      ? {
          codec: video.codec_name,
          profile: video.profile,
          width: video.width,
          height: video.height,
          pixelFormat: video.pix_fmt,
          bitDepth: Number(video.bits_per_raw_sample) || (video.pix_fmt?.includes("10") ? 10 : 8)
        }
      : null,
    audio: audio
      ? {
          codec: audio.codec_name,
          sampleRate: Number(audio.sample_rate),
          channels: audio.channels,
          channelLayout: audio.channel_layout
        }
      : null,
    subtitle: subtitle ? { codec: subtitle.codec_name } : null,
    expectedDecodePath: expected[name] ?? null,
    license: "Generated locally for tests; not distributed as a product asset.",
    notes:
      name === "sample-mpeg4-mp3.avi"
        ? "Requires the project legacy/WASM build; the prebuilt webcodecs variant has no AVI demuxer."
        : name === "sample-hevc-ac3.mkv"
          ? "AC-3 has no WebCodecs config; WASM decoding requires the custom decode-audio-common build."
          : undefined
  };
  fixtures.push(fixture);
}

const manifest = {
  schemaVersion: 1,
  generatedBy:
    "ffmpeg 6.1.5-0deepin4 (system GPL build; used only to create test fixtures, not shipped)",
  generatedAt: new Date().toISOString(),
  note:
    "Synthetic lavfi sources. H.264/HEVC/AAC/AC-3 are test assets; review distribution/licensing before publishing binaries.",
  fixtures
};
await writeFile(
  join(root, "tests/fixtures/manifest.json"),
  JSON.stringify(manifest, null, 2) + "\n",
  "utf8"
);
console.log(`wrote tests/fixtures/manifest.json (${fixtures.length} fixtures)`);
