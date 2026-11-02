import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

interface PlayerState {
  phase: string;
  media: { name: string; durationUs: number; decodePaths: Record<string, string> } | null;
  positionUs: number;
  durationUs: number;
  stats: {
    decodedVideoFrames: number;
    renderedFrames: number;
    decodedAudioFrames: number;
    droppedVideoFrames: number;
  };
  settings: Record<string, { status: string; effective: unknown; requested: unknown }>;
}

interface PlayerWindow {
  __player?: {
    sessionId: string;
    getState(): PlayerState;
    invoke(request: {
      requestId: string;
      sessionId: string;
      action: string;
      params: Record<string, unknown>;
    }): Promise<{ status: string; error?: { code: string; message: string } }>;
  };
}

async function state(page: Page): Promise<PlayerState> {
  return page.evaluate(() => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    return player.getState();
  });
}

async function waitForMedia(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const player = (window as unknown as PlayerWindow).__player;
    const snapshot = player?.getState();
    return Boolean(
      snapshot?.media &&
        ["ready", "paused", "playing"].includes(snapshot.phase)
    );
  });
}

async function invoke(page: Page, action: string, params: Record<string, unknown> = {}) {
  return page.evaluate(
    async ({ action, params }) => {
      const player = (window as unknown as PlayerWindow).__player;
      if (!player) throw new Error("player is not ready");
      return player.invoke({
        requestId: `e2e-${Date.now()}-${Math.random().toString(36).slice(2)}`,
        sessionId: player.sessionId,
        action,
        params
      });
    },
    { action, params }
  );
}

test("opens MP4, renders the first frame, plays audio and pauses", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));

  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);

  const opened = await state(page);
  expect(opened.media?.name).toBe("sample-h264-aac.mp4");
  expect(opened.media?.decodePaths).toMatchObject({
    "video:0": "webcodecs",
    "audio:1": "webcodecs"
  });
  expect(opened.durationUs).toBeGreaterThan(1_900_000);

  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.stats.decodedVideoFrames > 0 && snapshot.stats.renderedFrames > 0);
  });

  const litPixels = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return 0;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (!context) return 0;
    context.drawImage(canvas, 0, 0);
    const width = Math.min(160, copy.width);
    const height = Math.min(120, copy.height);
    const data = context.getImageData(0, 0, width, height).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) {
      sum += data[i] ?? 0;
    }
    return sum;
  });
  expect(litPixels).toBeGreaterThan(0);

  await page.locator(".play-button").click();
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return snapshot?.phase === "playing";
  });
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.positionUs > 300_000);
  });
  const playing = await state(page);
  expect(playing.stats.decodedAudioFrames).toBeGreaterThan(0);

  await page.locator(".play-button").click();
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return snapshot?.phase === "paused";
  });
  const pausedAt = (await state(page)).positionUs;
  await page.waitForTimeout(400);
  const stillPausedAt = (await state(page)).positionUs;
  expect(Math.abs(stillPausedAt - pausedAt)).toBeLessThan(120_000);
});

test("seeks, applies picture settings, loads subtitles and captures a screenshot", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);

  const seek = await invoke(page, "playback.seek", { positionUs: 1_000_000 });
  expect(seek.status).toBe("applied");
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.positionUs >= 900_000);
  });

  const applied = await invoke(page, "settings.apply", {
    scope: "session",
    patch: {
      video: { brightness: 0.2, contrast: 1.2, saturation: 1.1, gamma: 1.1 },
      audio: { volume: 0.4 },
      subtitle: { delayMs: 100 }
    }
  });
  expect(applied.status).toBe("applied");
  const afterSettings = await state(page);
  expect(afterSettings.settings["video.brightness"]).toMatchObject({
    status: "applied",
    requested: 0.2,
    effective: 0.2
  });

  const subtitle = readFileSync(resolve("tests/fixtures/generated/subtitle.srt"));
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "subtitle.srt",
    mimeType: "application/x-subrip",
    buffer: subtitle
  });
  await invoke(page, "playback.seek", { positionUs: 800_000 });
  await page.waitForFunction(() => {
    const overlay = document.querySelector(".subtitle-overlay");
    return overlay?.textContent?.includes("Hello WASM player") ?? false;
  });

  const downloadPromise = page.waitForEvent("download");
  await page.getByRole("button", { name: "截图" }).first().click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/screenshot-.*\.png$/);
});
