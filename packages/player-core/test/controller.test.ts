import { describe, expect, it, vi } from "vitest";
import {
  ACTION_IDS,
  PlayerError,
  fileIdentityOf,
  type ActionId,
  type InvokeResult,
  type PersistedPlayerState,
  type PlayerEvent,
  type PlayerStorage
} from "@wasm-player/contracts";
import { FakeMediaEngine } from "@wasm-player/media-engine";
import { PlayerController, type PlayerHost } from "../src/index";

/**
 * Local test double. The dependency rules forbid player-core (including its
 * tests) from importing a concrete storage adapter, so persistence is exercised
 * through this in-memory implementation of the `PlayerStorage` port.
 */
class TestPlayerStorage implements PlayerStorage {
  private state: PersistedPlayerState | null = null;

  async load(): Promise<PersistedPlayerState | null> {
    return this.state === null ? null : structuredClone(this.state);
  }

  async save(state: PersistedPlayerState): Promise<void> {
    this.state = structuredClone(state);
  }

  async clear(): Promise<void> {
    this.state = null;
  }
}

function sampleFile(name = "sample.mp4"): File {
  return new File([new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112])], name, {
    type: "video/mp4"
  });
}

function playlistNames(output: unknown): string[] {
  if (!output || typeof output !== "object" || !("items" in output)) {
    throw new Error("playlist output is missing items");
  }
  const items: unknown = output.items;
  if (!Array.isArray(items)) throw new Error("playlist items is not an array");
  return items.map((item) => {
    if (!item || typeof item !== "object" || !("name" in item) || typeof item.name !== "string") {
      throw new Error("playlist item is missing a name");
    }
    return item.name;
  });
}

function createController(host?: PlayerHost, storage?: PlayerStorage) {
  const engine = new FakeMediaEngine();
  const controller = new PlayerController({
    engine,
    sessionId: "test-session",
    host,
    storage,
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

  it("advances the playlist when playback.loop is playlist", async () => {
    const pair = createController();
    const first = sampleFile("first.mp4");
    const second = sampleFile("second.mp4");
    await pair.invoke(ACTION_IDS.playlistAdd, {
      sources: [
        { kind: "file", file: first, name: "first.mp4" },
        { kind: "file", file: second, name: "second.mp4" }
      ]
    });
    const loopResult = await pair.invoke(ACTION_IDS.loopSet, { mode: "playlist" });
    expect(loopResult.status).toBe("applied");
    expect((await pair.invoke(ACTION_IDS.playlistPlay, { index: 0 })).status).toBe("applied");
    expect(pair.controller.getState().media?.name).toBe("first.mp4");
    expect(pair.controller.getState().settings["playback.loop"]?.effective).toBe("playlist");
    const seekResult = await pair.invoke(ACTION_IDS.playbackSeek, { positionUs: 120_000_000 });
    expect(seekResult.status).toBe("applied");
    await new Promise((resolve) => setTimeout(resolve, 20));
    const state = pair.controller.getState();
    expect(state.media?.name).toBe("second.mp4");
    expect(state.phase).toBe("playing");
  });

  it("plays the playlist in order and stops after the last item", async () => {
    const pair = createController();
    await pair.invoke(ACTION_IDS.playlistAdd, {
      sources: [
        { kind: "file", file: sampleFile("first.mp4"), name: "first.mp4" },
        { kind: "file", file: sampleFile("second.mp4"), name: "second.mp4" }
      ]
    });
    expect((await pair.invoke(ACTION_IDS.loopSet, { mode: "order" })).status).toBe("applied");
    await pair.invoke(ACTION_IDS.playlistPlay, { index: 0 });
    await pair.invoke(ACTION_IDS.playbackSeek, { positionUs: 120_000_000 });
    await vi.waitFor(() => {
      expect(pair.controller.getState().media?.name).toBe("second.mp4");
    });

    await pair.invoke(ACTION_IDS.playbackSeek, { positionUs: 120_000_000 });
    await vi.waitFor(() => {
      expect(pair.controller.getState().phase).toBe("ended");
    });
    expect(pair.controller.getState().media?.name).toBe("second.mp4");
  });

  it("reorders playlist entries without losing the current index", async () => {
    const pair = createController();
    await pair.invoke(ACTION_IDS.playlistAdd, {
      sources: [
        { kind: "file", file: sampleFile("a.mp4"), name: "a.mp4" },
        { kind: "file", file: sampleFile("b.mp4"), name: "b.mp4" },
        { kind: "file", file: sampleFile("c.mp4"), name: "c.mp4" }
      ]
    });
    expect((await pair.invoke(ACTION_IDS.playlistMove, { from: 2, to: 0 })).status).toBe(
      "applied"
    );
    const list = await pair.invoke(ACTION_IDS.playlistList);
    expect(playlistNames(list.output)).toEqual(["c.mp4", "a.mp4", "b.mp4"]);
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

  it("executes a duplicate in-flight request once", async () => {
    const pair = createController();
    await open(pair.controller, pair.invoke);
    const request = {
      requestId: "duplicate-in-flight",
      sessionId: "test-session",
      action: ACTION_IDS.bookmarksAdd,
      params: { name: "once", positionUs: 1_000 }
    };
    const results = await Promise.all([
      pair.controller.invoke(request),
      pair.controller.invoke(request)
    ]);
    expect(results.map((result) => result.status)).toEqual(["applied", "applied"]);
    const listed = await pair.invoke(ACTION_IDS.bookmarksList);
    expect((listed.output as { items: unknown[] }).items).toHaveLength(1);
  });

  it("rejects the second write that expects the same revision", async () => {
    const pair = createController();
    await open(pair.controller, pair.invoke);
    const revision = pair.controller.getState().revision;
    const write = (requestId: string, name: string) =>
      pair.controller.invoke({
        requestId,
        sessionId: "test-session",
        action: ACTION_IDS.bookmarksAdd,
        params: { name, positionUs: 1_000 },
        expectedRevision: revision
      });
    const results = await Promise.all([write("write-a", "a"), write("write-b", "b")]);
    const statuses = results.map((result) => result.status).sort();
    expect(statuses).toEqual(["applied", "rejected"]);
    const rejected = results.find((result) => result.status === "rejected");
    expect(rejected?.error?.code).toBe("REVISION_CONFLICT");
    // Only the winning write took effect.
    const listed = await pair.invoke(ACTION_IDS.bookmarksList);
    expect((listed.output as { items: unknown[] }).items).toHaveLength(1);
  });

  it("releases capture results and bounds the finished job list", async () => {
    let clock = 1_700_000_000_000;
    const engine = new FakeMediaEngine();
    const controller = new PlayerController({
      engine,
      sessionId: "jobs-session",
      now: () => clock,
      jobRetention: { maxEntries: 1, ttlMs: 50 }
    });
    let seq = 0;
    const invoke = (action: ActionId, params: Record<string, unknown> = {}) =>
      controller.invoke<unknown, Record<string, unknown>>({
        requestId: `job-req-${(seq += 1)}`,
        sessionId: "jobs-session",
        action,
        params
      });
    const waitForBlob = async (jobId: string): Promise<Blob | undefined> => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const blob = controller.getJobBlob(jobId);
        if (blob) return blob;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return undefined;
    };

    await invoke(ACTION_IDS.mediaOpen, {
      source: { kind: "file", file: sampleFile() },
      autoPlay: false
    });
    const first = await invoke(ACTION_IDS.captureCreate, { format: "png" });
    const firstId = first.jobId as string;
    expect(await waitForBlob(firstId)).toBeDefined();
    expect(controller.releaseJob(firstId)).toBe(true);
    expect(controller.getJobBlob(firstId)).toBeUndefined();

    // Entry budget: the second finished job evicts the first one.
    const second = await invoke(ACTION_IDS.captureCreate, { format: "png" });
    expect(await waitForBlob(second.jobId as string)).toBeDefined();
    clock += 10;
    const third = await invoke(ACTION_IDS.captureCreate, { format: "png" });
    expect(await waitForBlob(third.jobId as string)).toBeDefined();
    expect(controller.getJobBlob(second.jobId as string)).toBeUndefined();

    // Expiry: finished jobs older than the TTL are dropped on the next prune.
    clock += 1_000;
    const fourth = await invoke(ACTION_IDS.captureCreate, { format: "png" });
    expect(await waitForBlob(fourth.jobId as string)).toBeDefined();
    expect(controller.getJobBlob(third.jobId as string)).toBeUndefined();
    await controller.dispose();
  });

  it("keeps the current playlist entry in sync with auto-advance and direct opens", async () => {
    const pair = createController();
    const first = sampleFile("first.mp4");
    const second = sampleFile("second.mp4");
    await pair.invoke(ACTION_IDS.playlistAdd, {
      sources: [
        { kind: "file", file: first, name: "first.mp4" },
        { kind: "file", file: second, name: "second.mp4" }
      ]
    });
    await pair.invoke(ACTION_IDS.loopSet, { mode: "order" });
    await pair.invoke(ACTION_IDS.playlistPlay, { index: 0 });
    expect(pair.controller.getState().playlistIndex).toBe(0);

    // Auto-advance on end of media moves the controller's current entry; the
    // UI and SDK read this instead of tracking their own copy.
    await pair.invoke(ACTION_IDS.playbackSeek, { positionUs: 120_000_000 });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(pair.controller.getState().media?.name).toBe("second.mp4");
    expect(pair.controller.getState().playlistIndex).toBe(1);

    // Opening the same file directly makes its entry current again.
    await pair.invoke(ACTION_IDS.mediaOpen, {
      source: { kind: "file", file: first, name: "first.mp4" }
    });
    expect(pair.controller.getState().playlistIndex).toBe(0);

    // Adding the file that is already playing marks the new entry current.
    const third = sampleFile("third.mp4");
    await pair.invoke(ACTION_IDS.mediaOpen, {
      source: { kind: "file", file: third, name: "third.mp4" }
    });
    expect(pair.controller.getState().playlistIndex).toBeNull();
    const added = await pair.invoke(ACTION_IDS.playlistAdd, {
      sources: [{ kind: "file", file: third, name: "third.mp4" }]
    });
    const items = (added.output as { items: { index: number; name: string }[] }).items;
    const thirdIndex = items.find((item) => item.name === "third.mp4")?.index;
    expect(thirdIndex).toBeGreaterThanOrEqual(0);
    expect(pair.controller.getState().playlistIndex).toBe(thirdIndex);
  });

  it("steps backward through decoded frames", async () => {
    const pair = createController();
    await open(pair.controller, pair.invoke);
    await pair.invoke(ACTION_IDS.playbackSeek, { positionUs: 10_000_000 });
    const backward = await pair.invoke(ACTION_IDS.playbackStep, {
      frames: 2,
      direction: "backward"
    });
    expect(backward.status).toBe("applied");
    expect(pair.controller.getState().positionUs).toBeLessThan(10_000_000);
  });

  it("deduplicates local playlist entries by file identity", async () => {
    const pair = createController();
    const file = new File([new Uint8Array([1, 2, 3])], "movie.mkv", {
      lastModified: 1_700_000_000_000
    });
    const sameNameDifferentFile = new File([new Uint8Array([4, 5, 6, 7])], "movie.mkv", {
      lastModified: 1_700_000_050_000
    });
    await pair.invoke(ACTION_IDS.playlistAdd, {
      sources: [{ kind: "file", file, name: "movie.mkv" }]
    });
    await pair.invoke(ACTION_IDS.playlistAdd, {
      sources: [
        { kind: "file", file, name: "movie.mkv" },
        { kind: "file", file: sameNameDifferentFile, name: "movie.mkv" }
      ]
    });
    const listed = await pair.invoke(ACTION_IDS.playlistList);
    const items = (listed.output as { items: { identity?: string }[] }).items;
    // The identical file is refreshed in place; the other movie.mkv stays a
    // separate entry instead of being merged by name.
    expect(items).toHaveLength(2);
    expect(new Set(items.map((item) => item.identity)).size).toBe(2);
  });

  it("restores local playlist entries by identity and relinks them", async () => {
    const storage = new TestPlayerStorage();
    const bytes = new Uint8Array([0, 0, 0, 24, 102, 116, 121, 112]);
    const file = new File([bytes], "movie.mkv", {
      type: "video/x-matroska",
      lastModified: 1_700_000_000_000
    });
    const identity = fileIdentityOf(file);
    expect(identity).toBeTruthy();

    const first = createController(undefined, storage);
    await first.controller.ready;
    expect(
      (
        await first.invoke(ACTION_IDS.playlistAdd, {
          sources: [{ kind: "file", file, name: file.name }]
        })
      ).status
    ).toBe("applied");
    await first.controller.dispose();

    const second = createController(undefined, storage);
    await second.controller.ready;
    const listed = await second.invoke(ACTION_IDS.playlistList);
    const items = (
      listed.output as {
        items: { name: string; kind: string; available: boolean; identity?: string }[];
      }
    ).items;
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      name: "movie.mkv",
      kind: "file",
      available: false,
      identity
    });

    const blocked = await second.invoke(ACTION_IDS.playlistPlay, { index: 0 });
    expect(blocked.status).toBe("rejected");
    expect(blocked.error?.code).toBe("SOURCE_NOT_AUTHORIZED");

    // Selecting the same file again relinks the entry instead of adding a new one.
    const reopened = new File([bytes], "movie.mkv", {
      type: "video/x-matroska",
      lastModified: 1_700_000_000_000
    });
    expect(
      (
        await second.invoke(ACTION_IDS.mediaOpen, {
          source: { kind: "file", file: reopened, name: "movie.mkv" }
        })
      ).status
    ).toBe("applied");
    const relinked = await second.invoke(ACTION_IDS.playlistList);
    const relinkedItems = (relinked.output as { items: { available: boolean }[] }).items;
    expect(relinkedItems).toHaveLength(1);
    expect(relinkedItems[0]?.available).toBe(true);
    expect((await second.invoke(ACTION_IDS.playlistPlay, { index: 0 })).status).toBe(
      "applied"
    );
    await second.controller.dispose();
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
