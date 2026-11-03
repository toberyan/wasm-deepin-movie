import { existsSync, readFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { expect, test, type Page } from "@playwright/test";

interface PlayerState {
  phase: string;
  media: {
    name: string;
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
  stats: {
    decodedVideoFrames: number;
    renderedFrames: number;
    decodedAudioFrames: number;
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
    invoke(request: {
      requestId: string;
      sessionId: string;
      action: string;
      params: Record<string, unknown>;
    }): Promise<{ status: string; output?: unknown; error?: { code: string; message: string } }>;
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
  expect(afterSettings.settings["video.hueDeg"]?.effective).toBe(120);
  expect(afterSettings.settings["video.rotationDeg"]?.effective).toBe(90);
  expect(afterSettings.settings["video.crop"]?.effective).toMatchObject({ left: 0.1 });
  expect(afterSettings.settings["video.sharpness"]?.effective).toBe(0.5);
  expect(afterSettings.settings["video.scaleMode"]?.effective).toBe("nearest");

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

  const diagnostics = await invoke(page, "diagnostics.get");
  expect(diagnostics.status).toBe("applied");
  const output = diagnostics.output as { warnings: string[] };
  expect(output.warnings.some((warning) => warning.includes("ASS renderer unavailable"))).toBe(false);

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

test.fixme("loads the threaded custom libav build when requested", async ({ page }) => {
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
  expect(warnings.some((warning) => warning === "libav thread target: thr")).toBe(true);
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
    const file = new File([bytes], "sample-h264-aac.mp4", { type: "video/mp4" });
    return player.invoke({
      requestId: `library-open-${Date.now()}`,
      sessionId: player.sessionId,
      action: "media.open",
      params: { source: { kind: "file", file, name: "sample-h264-aac.mp4" } }
    });
  });
  expect(opened.status).toBe("applied");
  await waitForMedia(page);

  await page.getByRole("button", { name: "列表" }).click();
  await page.getByRole("tab", { name: "书签" }).click();
  await page.getByRole("button", { name: "在当前位置添加书签" }).click();
  await expect(page.locator(".library-item").filter({ hasText: "0:00" }).first()).toBeVisible();

  await page.getByRole("tab", { name: "播放列表" }).click();
  await page.getByPlaceholder("输入视频 URL").fill("https://example.com/movie.mp4");
  await page.getByRole("button", { name: "添加" }).click();
  await expect(page.locator(".library-item").filter({ hasText: "movie.mp4" })).toBeVisible();

  await page.getByRole("tab", { name: "历史" }).click();
  await expect(page.locator(".library-main").filter({ hasText: "sample-h264-aac.mp4" })).toBeVisible();
  await page.waitForTimeout(700);

  await page.reload();
  await page.waitForFunction(() => Boolean((window as unknown as PlayerWindow).__player));
  expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
  await page.getByRole("button", { name: "列表" }).click();
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

  await page.getByRole("button", { name: "设置" }).click();
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
