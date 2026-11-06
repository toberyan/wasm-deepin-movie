import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

interface PlayerState {
  phase: string;
  media: {
    name: string;
    sourceId?: string;
    durationUs: number;
    decodePaths: Record<string, string>;
    sourceKind?: string;
    seekable?: boolean;
    etag?: string;
  } | null;
  tracks: { type: string; codec: string; selected: boolean }[];
  selected: { video: number | null; audio: number | null; subtitle: number | null };
  positionUs: number;
  durationUs: number;
  rate: number;
  volume: number;
  playlistIndex: number | null;
  stats: {
    decodedVideoFrames: number;
    renderedFrames: number;
    decodedAudioFrames: number;
    audioBufferMs: number;
    droppedVideoFrames: number;
    videoQueueFrames: number;
    videoQueueBytes: number;
  };
  settings: Record<string, { status: string; effective: unknown; requested: unknown }>;
  error: { code: string; message: string } | null;
}

interface PlayerWindow {
  __player?: {
    sessionId: string;
    getState(): PlayerState;
    getJobBlob(jobId: string): Blob | undefined;
    releaseJob(jobId: string): boolean;
    invoke(request: {
      requestId: string;
      sessionId: string;
      action: string;
      params: Record<string, unknown>;
    }): Promise<{
      status: string;
      jobId?: string;
      output?: unknown;
      error?: { code: string; message: string };
    }>;
  };
}

async function state(page: Page): Promise<PlayerState> {
  return page.evaluate(() => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    return player.getState();
  });
}

const customVariantAvailable = existsSync(
  resolve("apps/web/public/libav/libav-wasm-player-p0.mjs")
);

async function openWasmFixture(
  page: Page,
  fixture: string,
  mimeType: string,
  name: string
): Promise<void> {
  const data = readFileSync(resolve("tests/fixtures/generated", fixture));
  await page.route(`**/fixtures/${fixture}`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": mimeType, "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/?libav=wasm-player-p0");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const opened = await page.evaluate(
    async ({ fixture, name, mimeType }) => {
      const player = (window as unknown as PlayerWindow).__player;
      if (!player) throw new Error("player is not ready");
      const bytes = await (await fetch(`/fixtures/${fixture}`)).arrayBuffer();
      const file = new File([bytes], name, { type: mimeType });
      return player.invoke({
        requestId: `wasm-open-${Date.now()}`,
        sessionId: player.sessionId,
        action: "media.open",
        params: {
          source: { kind: "file", file, name },
          forceDecodePath: { video: "wasm", audio: "wasm" }
        }
      });
    },
    { fixture, name, mimeType }
  );
  expect(opened.status).toBe("applied");
  await waitForMedia(page);
}

async function waitForWasmFirstFrame(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.stats.decodedVideoFrames > 0 && snapshot.stats.renderedFrames > 0);
  });
}

async function playAndPause(page: Page): Promise<void> {
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
  // The clock is a leaf component subscribed to the snapshot store; it must
  // follow playback without the app shell re-reading the whole state.
  const clockBefore = await page.locator(".time-current").innerText();
  await expect
    .poll(async () => page.locator(".time-current").innerText())
    .not.toBe(clockBefore);
  // The buffer figure comes from the AudioWorklet ring. An estimate that
  // subtracts the same interval on every animation frame collapses to zero
  // within one stats tick, so this would fail with the old accounting.
  await expect
    .poll(async () => (await state(page)).stats.audioBufferMs)
    .toBeGreaterThan(100);
  await page.locator(".play-button").click();
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return snapshot?.phase === "paused";
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

async function waitForCanvasToFit(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const frame = document.querySelector(".video-frame")?.getBoundingClientRect();
    const canvas = document.querySelector("canvas.video-canvas") as HTMLCanvasElement | null;
    if (!frame || !canvas) return false;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(Math.max(devicePixelRatio, 1), 1.5);
    return (
      Math.abs(canvas.width - frame.width * dpr) <= 1 &&
      Math.abs(canvas.height - frame.height * dpr) <= 1 &&
      Math.abs(rect.width - frame.width) <= 1 &&
      Math.abs(rect.height - frame.height) <= 1
    );
  });
}

async function canvasSignature(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas.video-canvas") as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (!context) return 0;
    context.drawImage(canvas, 0, 0);
    const data = context.getImageData(0, 0, copy.width, copy.height).data;
    let hash = 2166136261;
    for (let index = 0; index < data.length; index += 16) {
      hash ^= data[index] ?? 0;
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash;
  });
}

async function canvasRedSum(page: Page): Promise<number> {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas.video-canvas") as HTMLCanvasElement | null;
    if (!canvas) return 0;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (!context) return 0;
    context.drawImage(canvas, 0, 0);
    const data = context.getImageData(0, 0, Math.min(200, copy.width), Math.min(120, copy.height)).data;
    let sum = 0;
    for (let i = 0; i < data.length; i += 4) sum += data[i] ?? 0;
    return sum;
  });
}

test("keeps the paused frame and canvas size when settings overlay the video", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await invoke(page, "playback.seek", { positionUs: 1_000_000 });
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.stats.renderedFrames > 0);
  });
  await page.waitForTimeout(200);
  const before = await canvasRedSum(page);
  const beforeWidth = await page.evaluate(
    () => (document.querySelector("canvas.video-canvas") as HTMLCanvasElement).width
  );
  expect(before).toBeGreaterThan(0);

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "设置", exact: true })).toBeVisible();
  expect(await page.locator("canvas.video-canvas").evaluate((canvas) => (canvas as HTMLCanvasElement).width)).toBe(beforeWidth);
  await page.waitForTimeout(200);
  expect(await canvasRedSum(page)).toBeGreaterThan(0);
});

test("keeps the video area when fullscreen chrome is hidden", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const before = await page.evaluate(
    () => document.querySelector(".stage")?.getBoundingClientRect().height ?? 0
  );
  await page.evaluate(() => document.querySelector(".app-shell")?.classList.add("chrome-hidden"));
  const after = await page.evaluate(
    () => document.querySelector(".stage")?.getBoundingClientRect().height ?? 0
  );
  expect(after).toBeGreaterThan(0);
  expect(after).toBeGreaterThanOrEqual(before);
  await page.evaluate(() =>
    document.querySelector(".app-shell")?.classList.remove("chrome-hidden")
  );
});

test("opens a folder, plays adjacent items and reorders the queue", async ({ page }) => {
  const folder = mkdtempSync(join(tmpdir(), "wasm-player-folder-"));
  try {
    copyFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"), join(folder, "01.mp4"));
    copyFileSync(resolve("tests/fixtures/generated/sample-h264-cropped.mp4"), join(folder, "02.mp4"));
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
    await page.locator('input[type="file"]').nth(2).setInputFiles(folder);
    await page.waitForFunction(
      () => (window as unknown as PlayerWindow).__player?.getState().media?.name === "01.mp4"
    );

    await page.getByRole("button", { name: "下一个", exact: true }).click();
    await page.waitForFunction(
      () => (window as unknown as PlayerWindow).__player?.getState().media?.name === "02.mp4"
    );
    await page.getByRole("button", { name: "上一个", exact: true }).click();
    await page.waitForFunction(
      () => (window as unknown as PlayerWindow).__player?.getState().media?.name === "01.mp4"
    );

    await page.getByRole("button", { name: "媒体库", exact: true }).click();
    const names = page.locator(".library-item .library-main span");
    await expect(names).toHaveText(["01.mp4", "02.mp4"]);
    await page.locator(".library-item").nth(1).dragTo(page.locator(".library-item").nth(0));
    await expect(names).toHaveText(["02.mp4", "01.mp4"]);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("shows film info and applies audio and subtitle settings", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);

  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.getByRole("menuitem", { name: "影片信息", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "影片信息" });
  await expect(dialog).toContainText("mp4");
  await expect(dialog).toContainText("video");
  await page.getByRole("button", { name: "关闭影片信息" }).click();

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "声音", exact: true }).click();
  await page.getByLabel("声道").selectOption("left");
  await page.waitForFunction(
    () =>
      (window as unknown as PlayerWindow).__player?.getState().settings["audio.channel"]
        ?.effective === "left"
  );

  await page.getByRole("tab", { name: "字幕", exact: true }).click();
  await page.getByLabel("字体").selectOption("serif");
  await page.getByLabel("外挂字幕编码").selectOption("gb18030");
  expect(await page.evaluate(() => localStorage.getItem("wasm-player-subtitle-encoding"))).toBe(
    "gb18030"
  );
  await page.waitForFunction(
    () =>
      (window as unknown as PlayerWindow).__player?.getState().settings["subtitle.fontFamily"]
        ?.effective === "serif"
  );
});

test("adjusts speed and steps frames from the keyboard", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await page.locator(".video-frame").click({ position: { x: 120, y: 120 } });

  await page.keyboard.press("Control+ArrowRight");
  await page.keyboard.press("Control+ArrowRight");
  await expect.poll(async () => (await state(page)).rate).toBe(1.2);
  await page.keyboard.press("r");
  await expect.poll(async () => (await state(page)).rate).toBe(1);

  const before = (await state(page)).positionUs;
  await page.keyboard.press(".");
  await expect
    .poll(async () => (await state(page)).positionUs)
    .toBeGreaterThan(before);
});

test("steps by decoded frame timestamps in both directions", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  // 24 fps fixture: one frame is 41.7 ms, so a fixed 30 fps step (33.3 ms)
  // would be visibly wrong here.
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-cropped.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-cropped.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await invoke(page, "playback.pause");
  await invoke(page, "playback.seek", { positionUs: 500_000 });
  await expect
    .poll(async () => (await state(page)).positionUs)
    .toBe(500_000);

  await invoke(page, "playback.step", { frames: 1, direction: "forward" });
  const forward = (await state(page)).positionUs;
  const delta = forward - 500_000;
  expect(delta).toBeGreaterThan(38_000);
  expect(delta).toBeLessThan(45_000);

  await invoke(page, "playback.step", { frames: 1, direction: "backward" });
  const backward = (await state(page)).positionUs;
  expect(Math.abs(backward - 500_000)).toBeLessThan(2_000);
  expect(backward).toBeLessThan(forward);
});

test("steps backward across a variable-frame-rate gap", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  // Frames at 0 s, 0.2 s and 1.2 s: the previous frame is one second behind the
  // playhead, so a 30 fps estimate cannot find it.
  const video = readFileSync(resolve("tests/fixtures/generated/sample-vfr-gap.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-vfr-gap.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await invoke(page, "playback.pause");
  await invoke(page, "playback.seek", { positionUs: 1_200_000 });
  await expect.poll(async () => (await state(page)).positionUs).toBe(1_200_000);
  await page.waitForTimeout(300);
  const before = await canvasSignature(page);

  await invoke(page, "playback.step", { frames: 1, direction: "backward" });
  await expect.poll(async () => (await state(page)).positionUs).toBe(200_000);
  await page.waitForTimeout(250);
  // The playhead and the picture must both move; stopping on the same frame
  // while reporting success was the bug.
  expect(await canvasSignature(page)).not.toBe(before);

  await invoke(page, "playback.step", { frames: 1, direction: "forward" });
  await expect.poll(async () => (await state(page)).positionUs).toBe(1_200_000);

  // Two frames back must land on the frame at 0 s, not stop at 0.2 s.
  await invoke(page, "playback.step", { frames: 2, direction: "backward" });
  await expect.poll(async () => (await state(page)).positionUs).toBe(0);
  await page.waitForTimeout(250);
  expect(await canvasSignature(page)).not.toBe(before);
});

test("navigates same-named files from different folders independently", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "wasm-player-same-name-"));
  try {
    for (const directory of ["a", "b", "c"]) {
      mkdirSync(join(root, directory));
      copyFileSync(
        resolve("tests/fixtures/generated/sample-h264-aac.mp4"),
        join(root, directory, "episode.mp4")
      );
    }
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
    await page.locator('input[type="file"]').nth(2).setInputFiles(root);
    await waitForMedia(page);

    const first = (await state(page)).media?.sourceId;
    expect(first).toBeTruthy();
    await page.getByRole("button", { name: "下一个", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).media?.sourceId)
      .not.toBe(first);
    const second = (await state(page)).media?.sourceId;
    await page.getByRole("button", { name: "下一个", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).media?.sourceId)
      .not.toBe(second);
    const third = (await state(page)).media?.sourceId;
    // Three distinct files, three distinct media identities.
    expect(new Set([first, second, third]).size).toBe(3);

    await page.getByRole("button", { name: "媒体库", exact: true }).click();
    await expect(page.locator(".library-item .library-main span")).toHaveText([
      "episode.mp4",
      "episode.mp4",
      "episode.mp4"
    ]);
    // Only the entry that is actually playing is highlighted.
    await expect(page.locator(".library-main.active")).toHaveCount(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("manual navigation follows the auto-advanced playlist index", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "wasm-player-advance-"));
  try {
    for (const directory of ["a", "b", "c"]) {
      mkdirSync(join(root, directory));
      copyFileSync(
        resolve("tests/fixtures/generated/sample-h264-aac.mp4"),
        join(root, directory, "episode.mp4")
      );
    }
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
    await page.locator('input[type="file"]').nth(2).setInputFiles(root);
    await waitForMedia(page);
    // Autoplay can be deferred; `playback.play` is idempotent, unlike the
    // play/pause button which would toggle a race-winning autoplay to paused.
    await invoke(page, "playback.play");
    await page.waitForFunction(
      () => (window as unknown as PlayerWindow).__player?.getState().phase === "playing"
    );
    await invoke(page, "loop.set", { mode: "order" });
    expect((await state(page)).playlistIndex).toBe(0);

    // Let the first episode end; the controller advances to the second one.
    const duration = (await state(page)).durationUs;
    await invoke(page, "playback.seek", { positionUs: Math.max(0, duration - 50_000) });
    await expect.poll(async () => (await state(page)).playlistIndex).toBe(1);
    const secondId = (await state(page)).media?.sourceId;

    // "Next" must continue from the auto-advanced entry, i.e. open the third.
    await page.getByRole("button", { name: "下一个", exact: true }).click();
    await expect.poll(async () => (await state(page)).playlistIndex).toBe(2);
    expect((await state(page)).media?.sourceId).not.toBe(secondId);

    await page.getByRole("button", { name: "媒体库", exact: true }).click();
    await expect(page.locator(".library-main.active")).toHaveCount(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("keeps history and bookmarks per file when file names collide", async ({ page }) => {
  const root = mkdtempSync(join(tmpdir(), "wasm-player-bookmarks-"));
  try {
    for (const directory of ["a", "c"]) {
      mkdirSync(join(root, directory));
      copyFileSync(
        resolve("tests/fixtures/generated/sample-h264-aac.mp4"),
        join(root, directory, "episode.mp4")
      );
    }
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
    await page.locator('input[type="file"]').nth(2).setInputFiles(root);
    await waitForMedia(page);

    const first = (await state(page)).media;
    await invoke(page, "bookmarks.add", { name: "A-only", positionUs: 1_000 });
    const firstBookmarks = await invoke(page, "bookmarks.list");
    expect((firstBookmarks.output as { items: unknown[] }).items).toHaveLength(1);

    await page.getByRole("button", { name: "下一个", exact: true }).click();
    await expect
      .poll(async () => (await state(page)).media?.sourceId)
      .not.toBe(first?.sourceId);

    // bookmarks.list requires an open media, so wait until the second file is
    // fully opened instead of racing its open request.
    await expect
      .poll(async () => (await invoke(page, "bookmarks.list")).status)
      .toBe("applied");
    const secondBookmarks = await invoke(page, "bookmarks.list");
    expect((secondBookmarks.output as { items: unknown[] }).items).toHaveLength(0);

    const secondId = (await state(page)).media?.sourceId;
    await expect
      .poll(async () => {
        const history = await invoke(page, "history.list", { limit: 50 });
        return (history.output as { items: { id: string }[] }).items.map((item) => item.id);
      })
      .toEqual(expect.arrayContaining([first?.sourceId, secondId]));
    const history = await invoke(page, "history.list", { limit: 50 });
    const ids = (history.output as { items: { id: string }[] }).items.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restores local playlist entries after reload and relinks them by identity", async ({ page }) => {
  const base64 = readFileSync(
    resolve("tests/fixtures/generated/sample-h264-aac.mp4")
  ).toString("base64");
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));

  const added = await page.evaluate(async (encoded) => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const file = new File([bytes], "persisted.mp4", {
      type: "video/mp4",
      lastModified: 1_700_000_000_000
    });
    return player.invoke({
      requestId: `e2e-add-${Date.now()}`,
      sessionId: player.sessionId,
      action: "playlist.add",
      params: { sources: [{ kind: "file", file, name: file.name }] }
    });
  }, base64);
  expect(added.status).toBe("applied");
  // The controller persists with a 250 ms debounce.
  await page.waitForTimeout(800);

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const listed = await invoke(page, "playlist.list");
  const items = (listed.output as { items: Record<string, unknown>[] }).items;
  expect(items).toHaveLength(1);
  expect(items[0]).toMatchObject({
    name: "persisted.mp4",
    kind: "file",
    available: false
  });

  const blocked = await invoke(page, "playlist.play", { index: 0 });
  expect(blocked.status).toBe("rejected");
  expect(blocked.error?.code).toBe("SOURCE_NOT_AUTHORIZED");

  const relinked = await page.evaluate(async (encoded) => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const file = new File([bytes], "persisted.mp4", {
      type: "video/mp4",
      lastModified: 1_700_000_000_000
    });
    return player.invoke({
      requestId: `e2e-relink-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: file.name } }
    });
  }, base64);
  expect(relinked.status).toBe("applied");
  const after = await invoke(page, "playlist.list");
  const afterItems = (after.output as { items: Record<string, unknown>[] }).items;
  expect(afterItems).toHaveLength(1);
  expect(afterItems[0]?.available).toBe(true);
});

test("keeps the canvas inside the playback area after shrinking and restoring the window", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await waitForCanvasToFit(page);

  await page.setViewportSize({ width: 320, height: 844 });
  await waitForCanvasToFit(page);
  await page.setViewportSize({ width: 1280, height: 800 });
  await waitForCanvasToFit(page);

  const metrics = await page.evaluate(() => {
    const frame = document.querySelector(".video-frame")?.getBoundingClientRect();
    const canvas = document.querySelector("canvas.video-canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    return {
      frame: frame ? { width: frame.width, height: frame.height } : null,
      rect: { width: rect.width, height: rect.height },
      bitmap: { width: canvas.width, height: canvas.height }
    };
  });
  expect(metrics.frame).not.toBeNull();
  expect(metrics.rect.width).toBeCloseTo(metrics.frame?.width ?? 0, 0);
  expect(metrics.rect.height).toBeCloseTo(metrics.frame?.height ?? 0, 0);
  expect(Math.abs(metrics.bitmap.width - (metrics.frame?.width ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs(metrics.bitmap.height - (metrics.frame?.height ?? 0))).toBeLessThanOrEqual(1);
});

test("keeps the canvas inside the playback area when chrome returns from fullscreen", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await waitForCanvasToFit(page);

  await page.evaluate(() => document.querySelector(".app-shell")?.classList.add("chrome-hidden"));
  await page.waitForTimeout(200);
  await page.evaluate(() =>
    document.querySelector(".app-shell")?.classList.remove("chrome-hidden")
  );
  await waitForCanvasToFit(page);

  const metrics = await page.evaluate(() => {
    const frame = document.querySelector(".video-frame")?.getBoundingClientRect();
    const canvas = document.querySelector("canvas.video-canvas") as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const dpr = Math.min(Math.max(devicePixelRatio, 1), 1.5);
    return {
      frameBottom: frame ? frame.bottom : 0,
      canvasBottom: rect.bottom,
      bitmapHeight: canvas.height,
      expectedBitmapHeight: (frame?.height ?? 0) * dpr
    };
  });
  expect(metrics.canvasBottom).toBeLessThanOrEqual(metrics.frameBottom + 1);
  expect(Math.abs(metrics.bitmapHeight - metrics.expectedBitmapHeight)).toBeLessThanOrEqual(1);
});

test("focused controls keep their native keyboard behavior", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);

  await page.getByRole("button", { name: "更多", exact: true }).focus();
  await page.keyboard.press("Space");
  await expect(page.locator(".more-menu")).toBeVisible();
  await page.keyboard.press("Escape");

  await page.getByRole("button", { name: "播放速度", exact: true }).focus();
  const before = await state(page);
  await page.keyboard.press("ArrowDown");
  await page.waitForTimeout(100);
  const after = await state(page);
  expect(after.rate).toBe(before.rate);
  expect(after.volume).toBe(before.volume);

  await page.locator(".video-frame").click({ position: { x: 120, y: 120 } });
  await page.keyboard.press("ArrowDown");
  await expect.poll(async () => (await state(page)).volume).toBeLessThan(before.volume);
});

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
  // The clock is a leaf component subscribed to the snapshot store; it must
  // follow playback without the app shell re-reading the whole state.
  const clockBefore = await page.locator(".time-current").innerText();
  await expect
    .poll(async () => page.locator(".time-current").innerText())
    .not.toBe(clockBefore);
  // The buffer figure comes from the AudioWorklet ring. An estimate that
  // subtracts the same interval on every animation frame collapses to zero
  // within one stats tick, so this would fail with the old accounting.
  await expect
    .poll(async () => (await state(page)).stats.audioBufferMs)
    .toBeGreaterThan(100);

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

test("changes rate with the pitch-preserving audio path", async ({ page }) => {
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await page.getByRole("button", { name: "播放/暂停" }).click();
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return snapshot?.phase === "playing";
  });
  const changed = await invoke(page, "playback.setRate", { rate: 1.5 });
  expect(changed.status).toBe("applied");
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(
      snapshot &&
        snapshot.rate === 1.5 &&
        snapshot.positionUs > 400_000 &&
        snapshot.stats.decodedAudioFrames > 0
    );
  });
  const snapshot = await state(page);
  expect(snapshot.phase).toBe("playing");
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
      video: {
        brightness: 0.2,
        contrast: 1.2,
        saturation: 1.1,
        gamma: 1.1,
        hueDeg: 120,
        rotationDeg: 90,
        crop: { left: 0.1, top: 0, right: 0, bottom: 0 },
        sharpness: 0.5,
        scaleMode: "nearest"
      },
      audio: {
        volume: 0.4,
        eq: [1, 2, 3, 4, 5, 4, 3, 2, 1, 0],
        delayMs: 100
      },
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
  expect(afterSettings.settings["video.hueDeg"]?.effective).toBe(120);
  expect(afterSettings.settings["video.rotationDeg"]?.effective).toBe(90);
  expect(afterSettings.settings["video.crop"]?.effective).toMatchObject({ left: 0.1 });
  expect(afterSettings.settings["video.sharpness"]?.effective).toBe(0.5);
  expect(afterSettings.settings["video.scaleMode"]?.effective).toBe("nearest");
  expect(afterSettings.settings["audio.eq"]?.effective).toEqual([
    1, 2, 3, 4, 5, 4, 3, 2, 1, 0
  ]);
  expect(afterSettings.settings["audio.delayMs"]?.effective).toBe(100);

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
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "截图" }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toMatch(/screenshot-.*\.png$/);

  const boardPromise = page.waitForEvent("download", { timeout: 30_000 });
  await page.getByRole("button", { name: "更多" }).click();
  await page.getByRole("menuitem", { name: "剧情连拍（15 帧）", exact: true }).click();
  const board = await boardPromise;
  expect(board.suggestedFilename()).toMatch(/storyboard-.*\.png$/);
});

test("builds a storyboard without interrupting playback", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await invoke(page, "playback.play");
  await page.waitForFunction(
    () => (window as unknown as PlayerWindow).__player?.getState().phase === "playing"
  );
  const before = (await state(page)).positionUs;

  const accepted = await invoke(page, "storyboard.create", {
    count: 6,
    columns: 3,
    tileWidth: 160,
    tileHeight: 90
  });
  expect(accepted.status).toBe("accepted");
  const jobId = accepted.jobId as string;

  // Sampling runs in its own engine: the playhead keeps moving and the phase
  // stays "playing" instead of pausing for the capture.
  await page.waitForTimeout(600);
  const during = await state(page);
  expect(during.phase).toBe("playing");
  expect(during.positionUs).toBeGreaterThan(before);

  await expect
    .poll(async () => {
      const job = await invoke(page, "jobs.get", { jobId });
      return (job.output as { status?: string } | undefined)?.status;
    })
    .toBe("applied");
  const blob = await page.evaluate(
    (id) => (window as unknown as PlayerWindow).__player?.getJobBlob(id)?.size ?? 0,
    jobId
  );
  expect(blob).toBeGreaterThan(1_000);
  await page.evaluate(
    (id) => (window as unknown as PlayerWindow).__player?.releaseJob(id),
    jobId
  );
  expect(
    await page.evaluate(
      (id) => (window as unknown as PlayerWindow).__player?.getJobBlob(id) ?? null,
      jobId
    )
  ).toBeNull();
});

test("cancels a storyboard when the media session changes", async ({ page }) => {
  const base64 = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4")).toString(
    "base64"
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const result = await page.evaluate(async (encoded) => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0));
    const makeFile = (name: string, lastModified: number) =>
      new File([bytes], name, { type: "video/mp4", lastModified });
    const call = (action: string, params: Record<string, unknown> = {}) =>
      player.invoke({
        requestId: `e2e-${action}-${Math.random()}`,
        sessionId: player.sessionId,
        action,
        params
      });
    await call("media.open", {
      source: { kind: "file", file: makeFile("a.mp4", 1_700_000_000_000), name: "a.mp4" },
      autoPlay: true
    });
    const accepted = await call("storyboard.create", { count: 15, columns: 5 });
    const jobId = accepted.jobId as string;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const job = await call("jobs.get", { jobId });
      const progress = (job.output as { progress?: { completed: number } } | undefined)?.progress;
      if ((progress?.completed ?? 0) > 0) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // A -> B -> A: the old task must stay cancelled and never publish a result.
    await call("media.open", {
      source: { kind: "file", file: makeFile("b.mp4", 1_700_000_000_001), name: "b.mp4" },
      autoPlay: false
    });
    const afterB = (await call("jobs.get", { jobId })).output as { status?: string } | undefined;
    await call("media.open", {
      source: { kind: "file", file: makeFile("a.mp4", 1_700_000_000_000), name: "a.mp4" },
      autoPlay: false
    });
    await new Promise((resolve) => setTimeout(resolve, 800));
    const afterA = (await call("jobs.get", { jobId })).output as { status?: string } | undefined;
    return {
      afterB: afterB?.status,
      afterA: afterA?.status,
      blob: player.getJobBlob(jobId) ?? null,
      media: player.getState().media?.name
    };
  }, base64);
  expect(result.afterB).toBe("cancelled");
  expect(result.afterA).toBe("cancelled");
  expect(result.blob).toBeNull();
  expect(result.media).toBe("a.mp4");
});

test("controls storyboard concurrency and cancellation", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);

  const first = await invoke(page, "storyboard.create", { count: 15, columns: 5 });
  expect(first.status).toBe("accepted");
  const jobId = first.jobId as string;
  const second = await invoke(page, "storyboard.create", { count: 5 });
  expect(second.status).toBe("rejected");
  expect(second.error?.code).toBe("BUSY");

  await expect
    .poll(async () => {
      const job = await invoke(page, "jobs.get", { jobId });
      return (job.output as { progress?: { completed: number } } | undefined)?.progress
        ?.completed;
    })
    .toBeGreaterThan(0);
  const cancelled = await invoke(page, "jobs.cancel", { jobId });
  expect(cancelled.status).toBe("applied");
  const completedAtCancel = (
    (await invoke(page, "jobs.get", { jobId })).output as { progress?: { completed: number } }
  ).progress?.completed;
  await expect
    .poll(async () => {
      const job = await invoke(page, "jobs.get", { jobId });
      return (job.output as { status?: string } | undefined)?.status;
    })
    .toBe("cancelled");
  await page.waitForTimeout(600);
  const completedLater = (
    (await invoke(page, "jobs.get", { jobId })).output as { progress?: { completed: number } }
  ).progress?.completed;
  expect(completedLater).toBe(completedAtCancel);
  expect(
    await page.evaluate(
      (id) => (window as unknown as PlayerWindow).__player?.getJobBlob(id) ?? null,
      jobId
    )
  ).toBeNull();
});

test("renders embedded SubRip subtitles from Matroska", async ({ page }) => {
  const data = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac-subs.mkv"));
  await page.route("**/fixtures/sample-h264-aac-subs.mkv", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/x-matroska", "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac-subs.mkv"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac-subs.mkv",
    mimeType: "video/x-matroska",
    buffer: video
  });
  await waitForMedia(page);
  const snapshot = await state(page);
  expect(
    snapshot.tracks.some(
      (track) => track.type === "subtitle" && ["srt", "subrip"].includes(track.codec)
    )
  ).toBe(true);
  await invoke(page, "playback.seek", { positionUs: 1_000_000 });
  await page.waitForFunction(() => {
    const overlay = document.querySelector(".subtitle-overlay");
    return overlay?.textContent?.includes("Hello WASM player") ?? false;
  });
});

test("renders embedded ASS subtitles from Matroska", async ({ page }) => {
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac-ass.mkv"));
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac-ass.mkv",
    mimeType: "video/x-matroska",
    buffer: video
  });
  await waitForMedia(page);
  const snapshot = await state(page);
  expect(snapshot.tracks.some((track) => track.type === "subtitle" && track.codec === "ass")).toBe(true);
  await invoke(page, "playback.seek", { positionUs: 800_000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".ass-subtitle-canvas") as HTMLCanvasElement | null;
    if (!canvas) return false;
    return getComputedStyle(canvas).display !== "none" && canvas.width > 0 && canvas.height > 0;
  });
  const diagnostics = await invoke(page, "diagnostics.get", {});
  const output = diagnostics.output as { warnings: string[] };
  expect(output.warnings.some((warning) => warning.includes("ASS renderer unavailable"))).toBe(false);
});

test("renders ASS subtitles through JASSUB/libass", async ({ page }) => {
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);

  const ass = readFileSync(resolve("tests/fixtures/generated/subtitle.ass"));
  await page.locator('input[type="file"]').nth(1).setInputFiles({
    name: "subtitle.ass",
    mimeType: "text/x-ssa",
    buffer: ass
  });
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(
      snapshot?.tracks.some((track) => track.type === "subtitle" && track.codec === "ass")
    );
  });

  await invoke(page, "playback.seek", { positionUs: 800_000 });
  await page.waitForFunction(() => {
    const canvas = document.querySelector(".ass-subtitle-canvas") as HTMLCanvasElement | null;
    if (!canvas) return false;
    return getComputedStyle(canvas).display !== "none" && canvas.width > 0 && canvas.height > 0;
  });

  const forced = await invoke(page, "settings.apply", {
    scope: "session",
    patch: { subtitle: { forceStyle: true } }
  });
  expect(forced.status).toBe("applied");
  const forcedValue = (
    forced as {
      effective?: Record<string, { status: string; reason?: string }>;
    }
  ).effective?.["subtitle.forceStyle"];
  expect(forcedValue?.status).toBe("applied");

  const diagnostics = await invoke(page, "diagnostics.get");
  expect(diagnostics.status).toBe("applied");
  const output = diagnostics.output as { warnings: string[] };
  expect(output.warnings.some((warning) => warning.includes("ASS renderer unavailable"))).toBe(false);
  expect(output.warnings.some((warning) => warning.includes("style override failed"))).toBe(false);

  await page.screenshot({ path: "test-results/ass-subtitles.png", fullPage: true });
});


interface RangeFixtureServer {
  server: Server;
  port: number;
  ranges: number;
  etag: string;
  close(): Promise<void>;
}

async function startRangeFixture(): Promise<RangeFixtureServer> {
  const data = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  const etag = '"e2e-v1"';
  const state = { ranges: 0 };
  const server = createServer((request, response) => {
    const cors: Record<string, string> = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
      "Access-Control-Allow-Headers": "Range",
      "Access-Control-Expose-Headers": "Content-Range, Content-Length, ETag, Last-Modified, Accept-Ranges",
      "Access-Control-Max-Age": "600"
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const range = request.headers.range;
    const headers: Record<string, string> = {
      ...cors,
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Content-Type": "video/mp4"
    };
    if (!range) {
      response.writeHead(200, { ...headers, "Content-Length": String(data.length) });
      response.end(data);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${data.length}` });
      response.end();
      return;
    }
    state.ranges += 1;
    const start = Number(match[1]);
    const requestedEnd = match[2] === "" ? data.length - 1 : Number(match[2]);
    const end = Math.min(requestedEnd, data.length - 1);
    if (start >= data.length) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${data.length}` });
      response.end();
      return;
    }
    const body = data.subarray(start, end + 1);
    response.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${data.length}`,
      "Content-Length": String(body.length)
    });
    response.end(body);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const port = (server.address() as AddressInfo).port;
  return {
    server,
    port,
    get ranges() {
      return state.ranges;
    },
    etag,
    async close() {
      await new Promise<void>((resolveClose, reject) => {
        server.close((error) => (error ? reject(error) : resolveClose()));
      });
    }
  };
}

test("opens HTTP Range media with 206 validation", async ({ page }) => {
  const fixture = await startRangeFixture();
  try {
    await page.goto("/");
    await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
    const opened = await invoke(page, "media.open", {
      source: {
        kind: "url",
        url: `http://127.0.0.1:${fixture.port}/sample-h264-aac.mp4`,
        name: "remote-sample.mp4"
      }
    });
    expect(opened.status).toBe("applied");
    await waitForMedia(page);
    const stateAfterOpen = await state(page);
    expect(stateAfterOpen.media?.name).toBe("remote-sample.mp4");
    expect(stateAfterOpen.media?.sourceKind).toBe("http");
    expect(stateAfterOpen.media?.seekable).toBe(true);
    expect(stateAfterOpen.media?.etag).toBe(fixture.etag);

    await page.waitForFunction(() => {
      const snapshot = (window as unknown as PlayerWindow).__player?.getState();
      return Boolean(snapshot && snapshot.stats.decodedVideoFrames > 0);
    });
    const seek = await invoke(page, "playback.seek", { positionUs: 1_000_000 });
    expect(seek.status).toBe("applied");
    await page.waitForFunction(() => {
      const snapshot = (window as unknown as PlayerWindow).__player?.getState();
      return Boolean(snapshot && snapshot.positionUs >= 900_000);
    });
    expect(fixture.ranges).toBeGreaterThan(0);
  } finally {
    await fixture.close();
  }
});

test("survives 100 open/close cycles and invalid media", async ({ page }) => {
  test.setTimeout(180_000);
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.route("**/fixtures/sample-h264-aac.mp4", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/mp4", "Access-Control-Allow-Origin": "*" },
      body: video
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));

  const result = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-h264-aac.mp4")).arrayBuffer();
    const file = new File([bytes], "cycle.mp4", { type: "video/mp4" });
    const errors: string[] = [];
    const invoke = async (requestId: string, action: string, params: Record<string, unknown>) =>
      player.invoke({ requestId, sessionId: player.sessionId, action, params });

    const junk = new File([new Uint8Array(2048)], "junk.mp4", { type: "video/mp4" });
    const invalid = await invoke("invalid", "media.open", {
      source: { kind: "file", file: junk, name: "junk.mp4" }
    });
    if (invalid.status !== "rejected") errors.push("invalid media was not rejected");
    const afterInvalid = player.getState();
    if (afterInvalid.media !== null) errors.push("invalid media left a live media object");

    let completed = 0;
    for (let index = 0; index < 100; index += 1) {
      const opened = await invoke(`open-${index}`, "media.open", {
        source: { kind: "file", file, name: "cycle.mp4" },
        autoPlay: false
      });
      if (opened.status !== "applied") {
        errors.push(`open ${index}: ${opened.error?.code ?? opened.status}`);
        break;
      }
      const closed = await invoke(`close-${index}`, "media.close", {});
      if (closed.status !== "applied") {
        errors.push(`close ${index}: ${closed.error?.code ?? closed.status}`);
        break;
      }
      completed += 1;
    }

    const finalOpen = await invoke("final-open", "media.open", {
      source: { kind: "file", file, name: "cycle.mp4" },
      autoPlay: false
    });
    if (finalOpen.status !== "applied") errors.push("final open failed");
    const finalClose = await invoke("final-close", "media.close", {});
    if (finalClose.status !== "applied") errors.push("final close failed");

    const diagnostics = await invoke("diagnostics", "diagnostics.get", {});
    return {
      completed,
      errors,
      state: player.getState(),
      diagnostics: diagnostics.output as { queues: Record<string, number>; warnings: string[] }
    };
  });

  expect(result.errors).toEqual([]);
  expect(result.completed).toBe(100);
  expect(result.state.phase).toBe("idle");
  expect(result.state.media).toBeNull();
  expect(result.state.stats.videoQueueFrames).toBe(0);
  expect(result.state.stats.videoQueueBytes).toBe(0);
  expect(result.diagnostics.queues.videoFrames).toBe(0);
});

test("falls back from a broken threaded libav runtime to ST", async ({ page }) => {
  test.skip(!customVariantAvailable, "custom wasm-player-p0 artifacts are not built");
  test.skip(
    !existsSync(resolve("apps/web/public/libav/libav-6.8.8.0-wasm-player-p0.thr.mjs")),
    "threaded custom libav artifacts are not built"
  );
  test.setTimeout(120_000);
  const avi = readFileSync(resolve("tests/fixtures/generated/sample-mpeg4-mp3.avi"));
  await page.route("**/fixtures/sample-mpeg4-mp3.avi", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/x-msvideo", "Access-Control-Allow-Origin": "*" },
      body: avi
    })
  );
  await page.goto("/?libav=wasm-player-p0&libavThreads=mt");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const opened = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-mpeg4-mp3.avi")).arrayBuffer();
    const file = new File([bytes], "sample-mpeg4-mp3.avi", { type: "video/x-msvideo" });
    return player.invoke({
      requestId: `mt-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: "sample-mpeg4-mp3.avi" } }
    });
  });
  if (opened.status !== "applied") throw new Error(JSON.stringify(opened.error));
  await waitForMedia(page);
  const diagnostics = await invoke(page, "diagnostics.get", {});
  const warnings = (diagnostics.output as { warnings: string[] }).warnings;
  expect(
    warnings.some((warning) => warning.includes("fell back to the single-threaded build"))
  ).toBe(true);
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.stats.renderedFrames > 0);
  });
});

test("auto-selects the custom WASM variant for AVI", async ({ page }) => {
  test.skip(!customVariantAvailable, "custom wasm-player-p0 artifacts are not built");
  test.setTimeout(120_000);
  const avi = readFileSync(resolve("tests/fixtures/generated/sample-mpeg4-mp3.avi"));
  await page.route("**/fixtures/sample-mpeg4-mp3.avi", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/x-msvideo", "Access-Control-Allow-Origin": "*" },
      body: avi
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const openedResult = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-mpeg4-mp3.avi")).arrayBuffer();
    const file = new File([bytes], "sample-mpeg4-mp3.avi", { type: "video/x-msvideo" });
    return player.invoke({
      requestId: `avi-auto-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: {
        source: { kind: "file", file, name: "sample-mpeg4-mp3.avi" }
      }
    });
  });
  expect(openedResult.status).toBe("applied");
  await waitForMedia(page);
  const opened = await state(page);
  expect(opened.media?.decodePaths["video:0"]).toBe("wasm");
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.stats.renderedFrames > 0);
  });
});

test("library UI manages history, playlist, bookmarks and theme", async ({ page }) => {
  const data = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.route("**/fixtures/sample-h264-aac.mp4", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/mp4", "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  await invoke(page, "settings.apply", {
    scope: "global",
    patch: { app: { theme: "light" } }
  });
  await page.waitForFunction(() => document.documentElement.dataset.theme === "light");

  const opened = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-h264-aac.mp4")).arrayBuffer();
    // A fixed modification time keeps the file identity stable across the
    // separate File objects this test creates.
    const file = new File([bytes], "sample-h264-aac.mp4", {
      type: "video/mp4",
      lastModified: 1_700_000_000_000
    });
    return player.invoke({
      requestId: `library-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: "sample-h264-aac.mp4" } }
    });
  });
  expect(opened.status).toBe("applied");
  await waitForMedia(page);
  await invoke(page, "playlist.add", {
    sources: [
      {
        kind: "url",
        url: "https://example.invalid/sample-h264-aac.mp4",
        name: "sample-h264-aac.mp4"
      }
    ]
  });
  await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-h264-aac.mp4")).arrayBuffer();
    const file = new File([bytes], "sample-h264-aac.mp4", {
      type: "video/mp4",
      lastModified: 1_700_000_000_000
    });
    await player.invoke({
      requestId: `library-playlist-${Date.now()}`,
      sessionId: player.sessionId,
      action: "playlist.add",
      params: { sources: [{ kind: "file", file, name: file.name }] }
    });
  });

  await page.getByRole("button", { name: "媒体库" }).click();
  await page.getByRole("tab", { name: "书签" }).click();
  await page.getByRole("button", { name: "在当前位置添加书签" }).click();
  await expect(page.locator(".library-item").filter({ hasText: "0:00" }).first()).toBeVisible();

  await page.getByRole("tab", { name: "播放列表" }).click();
  // The file entry is highlighted through its identity; the URL entry with the
  // same name must not claim to be the playing item.
  await expect(page.locator(".library-main.active")).toHaveCount(1);
  await expect(
    page.locator(".library-main.active").filter({ hasText: "sample-h264-aac.mp4" })
  ).toBeVisible();
  await expect(
    page.locator(".library-item").filter({
      has: page.locator("small", { hasText: "https://example.invalid" })
    })
  ).not.toHaveClass(/active/);
  await page.getByPlaceholder("输入视频 URL").fill("https://example.com/movie.mp4");
  await page.getByRole("button", { name: "添加" }).click();
  await expect(page.locator(".library-item").filter({ hasText: "movie.mp4" })).toBeVisible();

  await page.getByRole("tab", { name: "历史" }).click();
  await expect(page.locator(".library-main").filter({ hasText: "sample-h264-aac.mp4" })).toBeVisible();
  await page.waitForTimeout(700);

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.getByRole("button", { name: "媒体库" }).click();
  await expect(page.locator(".library-item").filter({ hasText: "movie.mp4" })).toBeVisible();
  await page.getByRole("tab", { name: "历史" }).click();
  await expect(page.locator(".library-main").filter({ hasText: "sample-h264-aac.mp4" })).toBeVisible();
});

test("persists global settings and history across reloads", async ({ page }) => {
  const data = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.route("**/fixtures/sample-h264-aac.mp4", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/mp4", "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const applied = await invoke(page, "settings.apply", {
    scope: "global",
    patch: { audio: { volume: 0.37 } }
  });
  expect(applied.status).toBe("applied");
  const opened = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-h264-aac.mp4")).arrayBuffer();
    const file = new File([bytes], "sample-h264-aac.mp4", { type: "video/mp4" });
    return player.invoke({
      requestId: `persist-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: "sample-h264-aac.mp4" } }
    });
  });
  expect(opened.status).toBe("applied");
  await waitForMedia(page);
  await page.waitForTimeout(700);

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const snapshot = await state(page);
  expect(snapshot.settings["audio.volume"]?.effective).toBeCloseTo(0.37, 5);
  const history = await invoke(page, "history.list", {});
  expect(history.status).toBe("applied");
  const items = (history.output as { items: { name: string }[] }).items;
  expect(items.some((item) => item.name === "sample-h264-aac.mp4")).toBe(true);

  const playlist = await invoke(page, "playlist.add", {
    sources: [{ kind: "url", url: "https://example.invalid/movie.mp4", name: "movie.mp4" }]
  });
  expect(playlist.status).toBe("applied");
  await page.waitForTimeout(500);
  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const reloadedPlaylist = await invoke(page, "playlist.list", {});
  expect(reloadedPlaylist.status).toBe("applied");
  const playlistItems = (reloadedPlaylist.output as { items: { name: string; url?: string }[] }).items;
  expect(playlistItems[0]?.url).toBe("https://example.invalid/movie.mp4");
});

test("reopens the current file through the force-WASM UI", async ({ page }) => {
  test.skip(!customVariantAvailable, "custom wasm-player-p0 artifacts are not built");
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac.mp4"));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-aac.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "播放", exact: true }).click();
  await page.getByText("高级选项").click();
  await page.getByLabel("优先 WASM 解码").check();
  await page.getByRole("button", { name: "重新以 WASM 解码" }).click();
  await page.waitForFunction(() => {
    const current = (window as unknown as PlayerWindow).__player?.getState();
    return current?.media?.decodePaths["video:0"] === "wasm";
  });
  const snapshot = await state(page);
  expect(snapshot.media?.decodePaths["video:0"]).toBe("wasm");
  expect(snapshot.media?.decodePaths["audio:1"]).toBe("wasm");
  await page.waitForFunction(() => {
    const current = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(current && current.stats.renderedFrames > 0);
  });
});

test("plays H.264 with non-macroblock-aligned dimensions", async ({ page }) => {
  const video = readFileSync(resolve("tests/fixtures/generated/sample-h264-cropped.mp4"));
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  await page.locator('input[type="file"]').first().setInputFiles({
    name: "sample-h264-cropped.mp4",
    mimeType: "video/mp4",
    buffer: video
  });
  await waitForMedia(page);
  const snapshot = await state(page);
  // Either path is valid for MP4: WebCodecs handles the cropped surface, and a
  // decoder failure falls back to the custom WASM decoder at runtime. What must
  // hold is that the real 1254x898 frame renders instead of a padded/tiled one.
  expect(["webcodecs", "wasm"]).toContain(snapshot.media?.decodePaths["video:0"]);
  const stream = await page.evaluate(() => {
    const media = (window as unknown as PlayerWindow).__player?.getState().media as
      | { streams?: { type: string; width?: number; height?: number }[] }
      | null;
    return media?.streams?.find((entry) => entry.type === "video") ?? null;
  });
  expect(stream?.width).toBe(1254);
  expect(stream?.height).toBe(898);
  await page.getByRole("button", { name: "播放/暂停" }).click();
  await page.waitForFunction(() => {
    const current = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(current && current.stats.renderedFrames > 3 && !current.error);
  });
});

test("recovers H.264 MKV WebCodecs failures automatically", async ({ page }) => {
  test.setTimeout(120_000);
  const data = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac-subs.mkv"));
  await page.route("**/fixtures/sample-h264-aac-subs.mkv", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/x-matroska", "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const opened = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-h264-aac-subs.mkv")).arrayBuffer();
    const file = new File([bytes], "sample-h264-aac-subs.mkv", { type: "video/x-matroska" });
    return player.invoke({
      requestId: `mkv-auto-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: "sample-h264-aac-subs.mkv" } }
    });
  });
  if (opened.status !== "applied") throw new Error(JSON.stringify(opened.error));
  await waitForMedia(page);
  const snapshot = await state(page);
  expect(snapshot.media?.decodePaths["video:0"]).toBe("wasm");
  await page.waitForFunction(() => {
    const current = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(current && current.stats.renderedFrames > 0);
  });
});

test("opens H.264 MKV through the custom WASM decoder", async ({ page }) => {
  test.skip(!customVariantAvailable, "custom wasm-player-p0 artifacts are not built");
  const data = readFileSync(resolve("tests/fixtures/generated/sample-h264-aac-subs.mkv"));
  await page.route("**/fixtures/sample-h264-aac-subs.mkv", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/x-matroska", "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/?libav=wasm-player-p0");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const opened = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-h264-aac-subs.mkv")).arrayBuffer();
    const file = new File([bytes], "sample-h264-aac-subs.mkv", { type: "video/x-matroska" });
    return player.invoke({
      requestId: `mkv-h264-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: {
        source: { kind: "file", file, name: "sample-h264-aac-subs.mkv" },
        forceDecodePath: { video: "wasm", audio: "wasm" }
      }
    });
  });
  if (opened.status !== "applied") throw new Error(JSON.stringify(opened.error));
  await waitForMedia(page);
  const snapshot = await state(page);
  expect(snapshot.media?.decodePaths["video:0"]).toBe("wasm");
  await page.waitForFunction(() => {
    const current = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(current && current.stats.renderedFrames > 0);
  });
});

test("switches between multiple video tracks", async ({ page }) => {
  const data = readFileSync(resolve("tests/fixtures/generated/sample-multi-video.webm"));
  await page.route("**/fixtures/sample-multi-video.webm", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/webm", "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const opened = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-multi-video.webm")).arrayBuffer();
    const file = new File([bytes], "sample-multi-video.webm", { type: "video/webm" });
    return player.invoke({
      requestId: `multi-video-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: "sample-multi-video.webm" } }
    });
  });
  if (opened.status !== "applied") throw new Error(JSON.stringify(opened.error));
  await waitForMedia(page);
  let snapshot = await state(page);
  expect(snapshot.selected.video).toBe(0);
  expect(snapshot.tracks.filter((track) => track.type === "video")).toHaveLength(2);
  const switched = await invoke(page, "tracks.select", { type: "video", index: 1 });
  expect(switched.status).toBe("applied");
  await waitForMedia(page);
  snapshot = await state(page);
  expect(snapshot.selected.video).toBe(1);
  expect(snapshot.media?.decodePaths["video:1"]).toBe("webcodecs");
  await page.waitForFunction(() => {
    const current = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(current && current.stats.renderedFrames > 0);
  });
});

test("switches between multiple audio tracks and preserves position", async ({ page }) => {
  const data = readFileSync(resolve("tests/fixtures/generated/sample-multi-audio.mp4"));
  await page.route("**/fixtures/sample-multi-audio.mp4", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/mp4", "Access-Control-Allow-Origin": "*" },
      body: data
    })
  );
  await page.goto("/");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const opened = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-multi-audio.mp4")).arrayBuffer();
    const file = new File([bytes], "sample-multi-audio.mp4", { type: "video/mp4" });
    return player.invoke({
      requestId: `multi-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: "sample-multi-audio.mp4" } }
    });
  });
  expect(opened.status).toBe("applied");
  await waitForMedia(page);
  let snapshot = await state(page);
  expect(snapshot.selected.audio).toBe(1);
  expect(snapshot.tracks.filter((track) => track.type === "audio")).toHaveLength(2);
  await invoke(page, "playback.seek", { positionUs: 1_000_000 });
  const before = await state(page);
  expect(before.positionUs).toBeGreaterThan(900_000);

  const switched = await invoke(page, "tracks.select", { type: "audio", index: 2 });
  expect(switched.status).toBe("applied");
  await waitForMedia(page);
  snapshot = await state(page);
  expect(snapshot.selected.audio).toBe(2);
  expect(snapshot.positionUs).toBeGreaterThan(900_000);
  expect(snapshot.media?.decodePaths["audio:2"]).toBe("webcodecs");

  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("tab", { name: "声音", exact: true }).click();
  const german = page.locator(".track-item").filter({ hasText: "deu" });
  await expect(german).toHaveClass(/selected/);
});

test("plays AVI through the custom WASM video/audio path", async ({ page }) => {
  test.skip(!customVariantAvailable, "custom wasm-player-p0 artifacts are not built");
  test.setTimeout(120_000);
  const avi = readFileSync(resolve("tests/fixtures/generated/sample-mpeg4-mp3.avi"));
  await page.route("**/fixtures/sample-mpeg4-mp3.avi", (route) =>
    route.fulfill({
      status: 200,
      headers: { "Content-Type": "video/x-msvideo", "Access-Control-Allow-Origin": "*" },
      body: avi
    })
  );
  await page.goto("/?libav=wasm-player-p0");
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  const openedResult = await page.evaluate(async () => {
    const player = (window as unknown as PlayerWindow).__player;
    if (!player) throw new Error("player is not ready");
    const bytes = await (await fetch("/fixtures/sample-mpeg4-mp3.avi")).arrayBuffer();
    const file = new File([bytes], "sample-mpeg4-mp3.avi", { type: "video/x-msvideo" });
    return player.invoke({
      requestId: `avi-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: {
        source: { kind: "file", file, name: "sample-mpeg4-mp3.avi" },
        forceDecodePath: { audio: "wasm" }
      }
    });
  });
  expect(openedResult.status).toBe("applied");
  await waitForMedia(page);
  const opened = await state(page);
  expect(opened.media?.decodePaths).toMatchObject({
    "video:0": "wasm",
    "audio:1": "wasm"
  });
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return Boolean(snapshot && snapshot.stats.decodedVideoFrames > 0 && snapshot.stats.renderedFrames > 0);
  });
  const lit = await page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return 0;
    const copy = document.createElement("canvas");
    copy.width = canvas.width;
    copy.height = canvas.height;
    const context = copy.getContext("2d");
    if (!context) return 0;
    context.drawImage(canvas, 0, 0);
    const data = context.getImageData(0, 0, Math.min(120, copy.width), Math.min(90, copy.height)).data;
    let sum = 0;
    for (let index = 0; index < data.length; index += 4) sum += data[index] ?? 0;
    return sum;
  });
  expect(lit).toBeGreaterThan(0);

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
  // The clock is a leaf component subscribed to the snapshot store; it must
  // follow playback without the app shell re-reading the whole state.
  const clockBefore = await page.locator(".time-current").innerText();
  await expect
    .poll(async () => page.locator(".time-current").innerText())
    .not.toBe(clockBefore);
  // The buffer figure comes from the AudioWorklet ring. An estimate that
  // subtracts the same interval on every animation frame collapses to zero
  // within one stats tick, so this would fail with the old accounting.
  await expect
    .poll(async () => (await state(page)).stats.audioBufferMs)
    .toBeGreaterThan(100);
  await page.locator(".play-button").click();
  await page.waitForFunction(() => {
    const snapshot = (window as unknown as PlayerWindow).__player?.getState();
    return snapshot?.phase === "paused";
  });
});

test("forces H.264/AAC through the WASM fallback", async ({ page }) => {
  test.skip(!customVariantAvailable, "custom wasm-player-p0 artifacts are not built");
  test.setTimeout(120_000);
  await openWasmFixture(page, "sample-h264-aac.mp4", "video/mp4", "sample-h264-aac.mp4");
  const opened = await state(page);
  expect(opened.media?.decodePaths).toMatchObject({
    "video:0": "wasm",
    "audio:1": "wasm"
  });
  await waitForWasmFirstFrame(page);
  await playAndPause(page);
});

test("forces HEVC/AC-3 through the WASM fallback", async ({ page }) => {
  test.skip(!customVariantAvailable, "custom wasm-player-p0 artifacts are not built");
  test.setTimeout(180_000);
  await openWasmFixture(page, "sample-hevc-ac3.mkv", "video/x-matroska", "sample-hevc-ac3.mkv");
  const opened = await state(page);
  expect(opened.media?.decodePaths).toMatchObject({
    "video:0": "wasm",
    "audio:1": "wasm"
  });
  await waitForWasmFirstFrame(page);
  await playAndPause(page);
});
