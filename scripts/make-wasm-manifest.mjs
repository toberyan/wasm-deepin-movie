import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const [tree, variant, threads = "st"] = process.argv.slice(2);
if (!tree || !variant) {
  console.error("usage: make-wasm-manifest.mjs <libav.js-build-tree> <variant> [st|mt]");
  process.exit(1);
}
const buildTree = resolve(tree);
const config = JSON.parse(
  await readFile(join(buildTree, "configs/configs", variant, "config.json"), "utf8")
);
const version = "6.8.8.0";
const names =
  threads === "mt"
    ? [`libav-${version}-${variant}.thr.mjs`, `libav-${version}-${variant}.thr.wasm`]
    : [`libav-${version}-${variant}.wasm.mjs`, `libav-${version}-${variant}.wasm.wasm`];
names.push(`libav-${variant}.mjs`);
const outDir = join(repoRoot, "native/builds/artifacts", variant);
await mkdir(outDir, { recursive: true });
const artifacts = [];
for (const name of names) {
  const source = join(buildTree, "dist", name);
  const target = join(outDir, name);
  await copyFile(source, target);
  const data = await readFile(target);
  const info = await stat(target);
  artifacts.push({
    path: `native/builds/artifacts/${variant}/${name}`,
    bytes: info.size,
    sha256: createHash("sha256").update(data).digest("hex")
  });
}
const demuxers = config.filter((part) => part.startsWith("demuxer-")).map((part) => part.slice(8));
const decoders = config.filter((part) => part.startsWith("decoder-")).map((part) => part.slice(8));
const parsers = config.filter((part) => part.startsWith("parser-")).map((part) => part.slice(7));
const manifest = {
  schemaVersion: 1,
  abi: "wasm-player-1",
  variant: { name: variant, threads, simd: false },
  libavjs: { version: "6.8.8", build: version },
  ffmpeg: { version: "8.0", license: "LGPL-2.1-or-later" },
  components: config,
  demuxers,
  decoders,
  parsers,
  artifacts,
  license: {
    spdx: "LGPL-2.1-or-later",
    notice: "docs/legal/third-party.md"
  },
  builtAt: new Date().toISOString()
};
const manifestPath = join(repoRoot, "native/builds/manifests", `${variant}-${threads}.json`);
await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
console.log(`wrote ${manifestPath}`);
