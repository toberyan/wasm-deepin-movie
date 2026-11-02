import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

const aliases = {
  "@wasm-player/contracts": resolve("packages/contracts/src/index.ts"),
  "@wasm-player/player-core": resolve("packages/player-core/src/index.ts"),
  "@wasm-player/source-readers": resolve("packages/source-readers/src/index.ts"),
  "@wasm-player/media-engine": resolve("packages/media-engine/src/index.ts"),
  "@wasm-player/ffmpeg-adapter": resolve("packages/ffmpeg-adapter/src/index.ts"),
  "@wasm-player/webcodecs-adapter": resolve("packages/webcodecs-adapter/src/index.ts"),
  "@wasm-player/renderer": resolve("packages/renderer/src/index.ts"),
  "@wasm-player/audio": resolve("packages/audio/src/index.ts"),
  "@wasm-player/subtitles": resolve("packages/subtitles/src/index.ts"),
  "@wasm-player/storage": resolve("packages/storage/src/index.ts"),
  "@wasm-player/host": resolve("packages/host/src/index.ts"),
  "@wasm-player/agent-sdk": resolve("packages/agent-sdk/src/index.ts"),
  "@wasm-player/mcp-server": resolve("packages/mcp-server/src/index.ts")
};

export default defineConfig({
  resolve: { alias: aliases },
  test: {
    include: ["packages/**/test/**/*.test.ts", "apps/**/test/**/*.test.ts", "tests/unit/**/*.test.ts"],
    environment: "node",
    testTimeout: 15000,
    hookTimeout: 15000
  }
});
