import { createRequire } from "node:module";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const companionRequire = createRequire(resolve("apps/companion/package.json"));
const { Client } = await import(
  companionRequire.resolve("@modelcontextprotocol/sdk/client/index.js")
);
const { StdioClientTransport } = await import(
  companionRequire.resolve("@modelcontextprotocol/sdk/client/stdio.js")
);

test("Companion MCP controls the browser session end-to-end", async ({ page }) => {
  test.setTimeout(120_000);
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [
      resolve("node_modules/tsx/dist/cli.mjs"),
      resolve("apps/companion/src/cli.ts"),
      "--stdio",
      "--port",
      "0",
      "--allow-root",
      resolve("tests/fixtures/generated"),
      "--web-root",
      resolve("apps/web/dist"),
      "--token",
      "e2e-token"
    ],
    cwd: process.cwd(),
    stderr: "pipe"
  });
  const listening = Promise.withResolvers<string>();
  transport.stderr?.on("data", (chunk: Buffer) => {
    const text = chunk.toString();
    const match = /listening on (http:\/\/[^\s]+)/.exec(text);
    if (match?.[1]) listening.resolve(match[1]);
  });
  const client = new Client({ name: "e2e-companion", version: "1.0.0" });
  await client.connect(transport);
  const baseUrl = await listening.promise;

  const tool = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.find((item: { type: string; text?: string }) => item.type === "text")?.text ?? "";
    if (result.isError) throw new Error(`${name}: ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const waitFor = async (label: string, predicate: () => Promise<boolean>, timeout = 15_000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await page.waitForTimeout(100);
    }
    throw new Error(`timeout: ${label}`);
  };

  try {
    await page.goto(baseUrl);
    await page.waitForFunction(() => Boolean((window as unknown as { __player?: unknown }).__player));
    await waitFor("agent connection", async () =>
      Boolean((await page.locator(".agent-status").textContent())?.includes("已连接"))
    );

    const tools = await client.listTools();
    expect(tools.tools.map((toolItem: { name: string }) => toolItem.name)).toEqual(
      expect.arrayContaining(["state_get", "settings_apply", "capture_create", "sources_list"])
    );

    const sessions = await tool("sessions_list");
    expect(sessions.sessions).toHaveLength(1);
    const sessionId = sessions.sessions[0].sessionId as string;
    const attached = await tool("sessions_attach", { sessionId });
    expect(attached.session.sessionId).toBe(sessionId);

    const sources = await tool("sources_list");
    const source = sources.sources.find(
      (item: { sourceId: string }) => item.sourceId === "sample-h264-aac.mp4"
    );
    expect(source).toBeTruthy();

    await tool("media_open", {
      source: { kind: "sourceId", sourceId: source.sourceId, name: source.name }
    });
    await waitFor("media open", async () => {
      const state = await tool("state_get");
      return state.media?.name === "sample-h264-aac.mp4";
    });

    const applied = await tool("settings_apply", {
      scope: "session",
      patch: { video: { brightness: 0.15 }, audio: { volume: 0.5 } }
    });
    expect(applied.effective["video.brightness"]).toMatchObject({
      status: "applied",
      requested: 0.15,
      effective: 0.15
    });

    const seek = await tool("playback_seek", { positionUs: 1_000_000 });
    expect(seek).toMatchObject({ positionUs: 1_000_000, requestedUs: 1_000_000, errorUs: 0 });
    const state = await tool("state_get");
    expect(state.phase).toBe("paused");
    expect(state.positionUs).toBeGreaterThanOrEqual(900_000);
    expect(state.settings["audio.volume"].effective).toBe(0.5);

    const capture = await tool("capture_create", { includeSubtitles: false, format: "png" });
    expect(capture.status).toBe("accepted");
    expect(typeof capture.jobId).toBe("string");
    const jobState: {
      value: { status: string; result?: { width: number; height: number } } | null;
    } = { value: null };
    await waitFor("capture job", async () => {
      jobState.value = await tool("jobs_get", { jobId: capture.jobId });
      return jobState.value?.status === "applied" || jobState.value?.status === "failed";
    });
    expect(jobState.value?.status).toBe("applied");
    expect(jobState.value?.result?.width).toBeGreaterThan(0);

    const diagnostics = await tool("diagnostics_get");
    expect(diagnostics.phase).toBe("paused");
    expect(diagnostics.decodePaths).toMatchObject({
      "video:0": "webcodecs",
      "audio:1": "webcodecs"
    });
    expect(diagnostics.warnings).toEqual([]);

    const bootstrap = await fetch(`${baseUrl}/api/bootstrap`);
    expect(bootstrap.status).toBe(200);
    const bootstrapBody = (await bootstrap.json()) as { wsUrl: string; token: string };
    const badTokenResult = await page.evaluate(
      async ({ wsUrl }: { wsUrl: string }) => {
        return new Promise<string>((resolveResult) => {
          const socket = new WebSocket(`${wsUrl}?token=bad-token`);
          socket.onopen = () => resolveResult("open");
          socket.onclose = () => resolveResult("closed");
          socket.onerror = () => resolveResult("error");
          setTimeout(() => resolveResult("timeout"), 3000);
        });
      },
      { wsUrl: bootstrapBody.wsUrl }
    );
    expect(badTokenResult).not.toBe("open");

    const badOrigin = await fetch(`${baseUrl}/api/bootstrap`, {
      headers: { Origin: "http://evil.example" }
    });
    expect(badOrigin.status).toBe(403);
    const traversal = await fetch(
      `${baseUrl}/broker/media?path=${encodeURIComponent("../package.json")}`
    );
    expect(traversal.status).toBe(404);
    const good = await fetch(`${baseUrl}/broker/media?path=sample-h264-aac.mp4`, {
      headers: { Range: "bytes=0-15" }
    });
    expect(good.status).toBe(206);
    expect(good.headers.get("content-range")).toMatch(/^bytes 0-15\//);
  } finally {
    await client.close();
  }
});
