import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const adapterRequire = createRequire(join(dirname(fileURLToPath(import.meta.url)), "..", "packages/ffmpeg-adapter/package.json"));
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const variantEntry = adapterRequire.resolve("@libav.js/variant-webcodecs");
const variantDir = resolve(dirname(variantEntry), "..");
const variant = JSON.parse(await readFile(join(variantDir, "package.json"), "utf8"));
const build = "6.10.9.0";
const publicDir = join(root, "apps/web/public/libav");
const manifestDir = join(root, "native/builds/manifests");
await mkdir(publicDir, { recursive: true });
await mkdir(manifestDir, { recursive: true });

const files = [
  `libav-${build}-webcodecs.mjs`,
  `libav-${build}-webcodecs.wasm.mjs`,
  `libav-${build}-webcodecs.wasm.wasm`
];

const artifacts = [];
for (const file of files) {
  const source = join(variantDir, "dist", file);
  const target = join(publicDir, file);
  await copyFile(source, target);
  const data = await readFile(target);
  const info = await stat(target);
  artifacts.push({
    path: `apps/web/public/libav/${file}`,
    source: `node_modules/@libav.js/variant-webcodecs/dist/${file}`,
    bytes: info.size,
    sha256: createHash("sha256").update(data).digest("hex")
  });
}

const manifest = {
  schemaVersion: 1,
  abi: "wasm-player-1",
  variant: {
    name: "webcodecs",
    threads: "st",
    simd: false
  },
  libavjs: {
    package: variant.name,
    version: variant.version,
    build
  },
  ffmpeg: {
    version: "bundled by libav.js 6.10.9.0",
    license: "LGPL-2.1-or-later"
  },
  bridge: {
    package: "libavjs-webcodecs-bridge",
    version: "0.3.2"
  },
  demuxers: ["mov", "matroska", "ogg", "flac", "wav"],
  parsers: ["h264", "hevc", "vp8", "vp9", "av1", "aac", "opus", "flac"],
  decoders: ["opus", "flac", "pcm_s16le", "pcm_s24le"],
  filters: ["aresample", "format", "scale"],
  artifacts,
  license: {
    spdx: "LGPL-2.1-or-later",
    notice: "docs/legal/third-party.md",
    sources: "node_modules/@libav.js/variant-webcodecs/sources is not present in the npm artifact; source release must accompany distribution"
  },
  limitations: [
    "No AVI demuxer or MPEG-4 Part 2 / MP3 decoders in this prebuilt variant.",
    "No WASM H.264/HEVC/VP8/VP9/AV1 decoders; WebCodecs is the only video path for those codecs with this artifact.",
    "Project-owned demux-common/decode-* builds and their manifests remain a P0-03 exit item."
  ]
};
await writeFile(join(manifestDir, "webcodecs.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`copied ${files.length} libav.js artifacts to apps/web/public/libav`);
console.log(`wrote native/builds/manifests/webcodecs.json`);
