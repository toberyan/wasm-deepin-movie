import { describe, expect, it } from "vitest";
import {
  ACTION_IDS,
  PlayerError,
  type ActionId,
  type InvokeResult,
  type PlayerEvent
} from "@wasm-player/contracts";
import { FakeMediaEngine } from "@wasm-player/media-engine";
import { PlayerController, type PlayerHost } from "../src/index";

function sampleFile(name = "sample.mp4"): File {
  return new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, {
    type: "video/mp4"
  });
}

function createController(host?: PlayerHost) {
  const engine = new FakeMediaEngine();
  const controller = new PlayerController({
    engine,
    sessionId: "test-session",
    host,
    now: () => 1_700_000_000_000
  });
  let requestSeq = 0;
  const invoke = (
    action: ActionId,
    params: Record<string, unknown> = {},
    expectedRevision?: number
  ): Promise<InvokeResult> => {
    requestSeq += 1;
    const request: {
      requestId: string;
      sessionId: string;
      action: ActionId;
      params: Record<string, unknown>;
      expectedRevision?: number;
    } = {
      requestId: `req-${requestSeq}`,
      sessionId: "test-session",
      action,
      params
    };
    if (expectedRevision !== undefined) request.expectedRevision = expectedRevision;
    return controller.invoke(request);
  };
  return { controller, engine, invoke };
}

async function open(controller: PlayerController, request: (action: ActionId, params?: Record<string, unknown>, expectedRevision?: number) => Promise<InvokeResult>, autoPlay = false) {
  return request(ACTION_IDS.mediaOpen, {
    source: { kind: "file", file: sampleFile() },
    autoPlay
  });
}

describe("PlayerController", () => {
  it("opens media and exposes the engine state through state.get", async () => {
    const { controller, invoke } = createController();
    const result = await open(controller, invoke, true);
    expect(result.status).toBe("applied");
    expect(result.revision).toBe(1);
    expect(result.output).toHaveProperty("media");

    const state = await invoke(ACTION_IDS.stateGet);
    expect(state.status).toBe("applied");
    const snapshot = state.output as {
      phase: string;
      media: { streams: unknown[] };
      tracks: unknown[];
      rate: number;
      durationUs: number;
    };
    expect(snapshot.phase).toBe("playing");
    expect(snapshot.media.streams).toHaveLength(2);
    expect(snapshot.tracks).toHaveLength(2);
    expect(snapshot.durationUs).toBe(120_000_000);
  });

  it("play, pause, seek and step produce consistent state", async () => {
    const pair = createController();
    await open(pair.controller, pair.invoke);

    expect((await pair.invoke(ACTION_IDS.playbackPlay)).status).toBe("applied");
    expect(pair.controller.getState().phase).toBe("playing");
    expect((await pair.invoke(ACTION_IDS.playbackPause)).status).toBe("applied");
    expect(pair.controller.getState().phase).toBe("paused");
    const seek = await pair.invoke(ACTION_IDS.playbackSeek, { positionUs: 30_000_000 });
    expect(seek.status).toBe("applied");
    expect(pair.controller.getState().positionUs).toBe(30_000_000);
    const step = await pair.invoke(ACTION_IDS.playbackStep, { frames: 2 });
    expect(step.status).toBe("applied");
    expect(pair.controller.getState().positionUs).toBeGreaterThan(30_000_000);
  });

  it("rejects stale expectedRevision without changing state", async () => {
    const pair = createController();
    await open(pair.controller, pair.invoke);
    const before = pair.controller.getState();
    const result = await pair.invoke(ACTION_IDS.playbackPause, {}, 0);
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("REVISION_CONFLICT");
    expect(pair.controller.getState().revision).toBe(before.revision);
  });

  it("deduplicates requestId and does not repeat side effects", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    const events: PlayerEvent[] = [];
    controller.subscribe((event) => events.push(event));
    const before = controller.getState().revision;
    const requestId = "dedupe-request";

    const first = await controller.invoke({
      requestId,
      sessionId: "test-session",
      action: ACTION_IDS.settingsApply,
      params: { scope: "session", patch: { video: { brightness: 0.25 } } }
    });
    const afterFirst = controller.getState().revision;
    const countAfterFirst = events.length;

    const duplicate = await controller.invoke({
      requestId,
      sessionId: "test-session",
      action: ACTION_IDS.settingsApply,
      params: { scope: "session", patch: { video: { brightness: 0.75 } } }
    });
    expect(duplicate.status).toBe("applied");
    expect(first.revision).toBe(afterFirst);
    expect(afterFirst).toBeGreaterThan(before);
    expect(controller.getState().revision).toBe(afterFirst);
    expect(events.length).toBe(countAfterFirst);
    expect(controller.getState().settings["video.brightness"]).toMatchObject({
      requested: 0.25
    });
  });

  it("returns requested and effective values, including unsupported settings", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    const result = await invoke(ACTION_IDS.settingsApply, {
      scope: "session",
      patch: {
        video: { brightness: 0.2, gamma: 1.5 },
        audio: { volume: 0.4 },
        playback: { rate: 1.5 }
      }
    });
    expect(result.status).toBe("applied");
    const effective = result.effective as Record<string, { status: string; requested: unknown; effective: unknown }>;
    expect(effective["video.brightness"]).toMatchObject({ status: "applied", requested: 0.2, effective: 0.2 });
    expect(effective["video.gamma"]).toMatchObject({ status: "unsupported", requested: 1.5, effective: 1 });
    expect(effective["audio.volume"]).toMatchObject({ status: "applied", effective: 0.4 });
    expect(effective["playback.rate"]).toMatchObject({ status: "applied", effective: 1.5 });
    expect(controller.getState().rate).toBe(1.5);
    expect(controller.getState().volume).toBe(0.4);
  });

  it("merges settings layers and resets to the next layer", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    await invoke(ACTION_IDS.settingsApply, {
      scope: "global",
      patch: { video: { brightness: 0.2 } }
    });
    await invoke(ACTION_IDS.settingsApply, {
      scope: "session",
      patch: { video: { brightness: 0.4 } }
    });
    expect(controller.getState().settings["video.brightness"]).toMatchObject({
      requested: 0.4,
      layer: "session"
    });

    await invoke(ACTION_IDS.settingsReset, {
      scope: "session",
      ids: ["video.brightness"]
    });
    expect(controller.getState().settings["video.brightness"]).toMatchObject({
      requested: 0.2,
      layer: "global"
    });

    await invoke(ACTION_IDS.settingsReset, {
      scope: "global",
      ids: ["video.brightness"]
    });
    expect(controller.getState().settings["video.brightness"]).toMatchObject({
      requested: 0,
      layer: "default"
    });
  });

  it("returns NEEDS_MEDIA for actions that require media", async () => {
    const { invoke } = createController();
    const result = await invoke(ACTION_IDS.playbackPlay);
    expect(result.status).toBe("rejected");
    expect(result.error?.code).toBe("NEEDS_MEDIA");
  });

  it("rejects invalid params and unknown actions", async () => {
    const { invoke } = createController();
    const invalid = await invoke(ACTION_IDS.playbackSeek, { positionUs: -1 });
    expect(invalid.status).toBe("rejected");
    expect(invalid.error?.code).toBe("INVALID_REQUEST");

    const unknown = await invoke("nope.nope" as ActionId);
    expect(unknown.status).toBe("rejected");
    expect(unknown.error?.code).toBe("INVALID_REQUEST");
  });

  it("creates a capture job and exposes its result", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    const { promise: applied, resolve: resolveApplied } = Promise.withResolvers<PlayerEvent>();
    const unsubscribe = controller.subscribe((event) => {
      if (event.type === "jobUpdated" && (event.payload as { status?: string }).status === "applied") {
        unsubscribe();
        resolveApplied(event);
      }
    });
    const result = await invoke(ACTION_IDS.captureCreate, {
      includeSubtitles: true,
      format: "png"
    });
    expect(result.status).toBe("accepted");
    expect(result.jobId).toBeDefined();
    const event = await applied;
    expect((event.payload as { jobId: string }).jobId).toBe(result.jobId);

    const job = await invoke(ACTION_IDS.jobsGet, { jobId: result.jobId });
    expect(job.status).toBe("applied");
    const jobOutput = job.output as { status: string; result: { width: number; height: number } };
    expect(jobOutput.status).toBe("applied");
    expect(jobOutput.result.width).toBe(640);
    expect(controller.getJobBlob(result.jobId!)).toBeInstanceOf(Blob);
  });

  it("reads events by cursor and keeps sequence stable", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    await invoke(ACTION_IDS.playbackPlay);
    const first = await invoke(ACTION_IDS.eventsRead, { afterSeq: 0, limit: 100 });
    const output = first.output as { events: PlayerEvent[]; nextSeq: number };
    expect(output.events.length).toBeGreaterThan(0);
    expect(output.nextSeq).toBe(controller.getEventSeq());
    const second = await invoke(ACTION_IDS.eventsRead, {
      afterSeq: output.nextSeq,
      limit: 100
    });
    expect((second.output as { events: PlayerEvent[] }).events).toHaveLength(0);
  });

  it("applies core-owned UI settings and reports missing host APIs", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    const ui = await invoke(ACTION_IDS.uiSet, { theme: "light", panel: "settings" });
    expect(ui.status).toBe("applied");
    expect(controller.getState().settings["app.theme"]).toMatchObject({
      effective: "light",
      status: "applied"
    });
    expect(controller.getState().settings["app.panel"]).toMatchObject({
      effective: "settings",
      status: "applied"
    });
    const fullscreen = await invoke(ACTION_IDS.uiSet, { fullscreen: true });
    expect(fullscreen.status).toBe("rejected");
    expect(fullscreen.error?.code).toBe("UNSUPPORTED");
  });

  it("delegates host requests to the host port", async () => {
    let fullscreenValue: boolean | null = null;
    const host: PlayerHost = {
      async fullscreen(enabled) {
        fullscreenValue = enabled;
      }
    };
    const { invoke } = createController(host);
    const result = await invoke(ACTION_IDS.hostRequest, { operation: "fullscreen" });
    expect(result.status).toBe("applied");
    expect(fullscreenValue).toBe(true);
  });

  it("exports and imports versioned configuration", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    await invoke(ACTION_IDS.settingsApply, {
      scope: "global",
      patch: { audio: { volume: 0.6 } }
    });
    const exported = await invoke(ACTION_IDS.configExport);
    const exportedOutput = exported.output as {
      version: number;
      settings: Record<string, unknown>;
    };
    expect(exportedOutput.version).toBe(1);
    expect(exportedOutput.settings["audio.muted"]).toBeUndefined();

    const imported = await invoke(ACTION_IDS.configImport, {
      version: 1,
      settings: { "audio.volume": 0.3 }
    });
    expect(imported.status).toBe("applied");
    expect(controller.getState().settings["audio.volume"]).toMatchObject({
      requested: 0.3,
      layer: "global"
    });
  });

  it("supports playlist and bookmark state", async () => {
    const { controller, invoke } = createController();
    await open(controller, invoke);
    const added = await invoke(ACTION_IDS.playlistAdd, {
      sources: [{ kind: "url", url: "https://example.com/second.mp4", name: "Second" }]
    });
    expect(added.status).toBe("applied");
    const list = await invoke(ACTION_IDS.playlistList);
    const items = (list.output as { items: { name: string }[] }).items;
    expect(items).toHaveLength(1);
    expect(items[0]?.name).toBe("Second");

    await invoke(ACTION_IDS.playbackSeek, { positionUs: 5_000_000 });
    const bookmark = await invoke(ACTION_IDS.bookmarksAdd, {
      name: "Interesting",
      positionUs: 5_000_000
    });
    expect(bookmark.status).toBe("applied");
    const bookmarks = await invoke(ACTION_IDS.bookmarksList);
    expect((bookmarks.output as { items: unknown[] }).items).toHaveLength(1);
  });

  it("throws a typed error when disposed", async () => {
    const { controller } = createController();
    await controller.dispose();
    await expect(
      controller.invoke({
        requestId: "after-dispose",
        sessionId: "test-session",
        action: ACTION_IDS.stateGet,
        params: {}
      })
    ).resolves.toMatchObject({ status: "rejected" });
  });
});

describe("PlayerError", () => {
  it("serializes stable error codes", () => {
    const error = new PlayerError("REVISION_CONFLICT", "stale", {
      details: { revision: 2 }
    });
    expect(error.toJSON()).toEqual({
      code: "REVISION_CONFLICT",
      message: "stale",
      recoverable: true,
      details: { revision: 2 }
    });
  });
});
