import { readFileSync } from "node:fs";
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
