import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  timeout: 90_000,
  expect: { timeout: 15_000 },
  workers: 1,
  reporter: "list",
  use: {
    channel: "chrome",
    headless: true,
    baseURL: "http://127.0.0.1:5173",
    viewport: { width: 1280, height: 800 },
    launchOptions: {
      args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader"]
    }
  },
  webServer: {
    command: "pnpm --filter @wasm-player/web dev",
    url: "http://127.0.0.1:5173",
    reuseExistingServer: true,
    timeout: 120_000
  }
});
