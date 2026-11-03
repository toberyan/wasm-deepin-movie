import { describe, expect, it } from "vitest";
import { MemoryPlayerStorage, createEmptyPersistedState } from "../src/index";

describe("MemoryPlayerStorage", () => {
  it("round-trips state without sharing references", async () => {
    const storage = new MemoryPlayerStorage();
    expect(await storage.load()).toBeNull();
    const state = createEmptyPersistedState();
    state.globalSettings["audio.volume"] = 0.4;
    state.history.push({
      id: "media-1",
      name: "sample.mp4",
      lastPlayedAt: 1,
      positionUs: 2,
      durationUs: 10,
      completed: false
    });
    await storage.save(state);
    state.globalSettings["audio.volume"] = 0.9;
    const loaded = await storage.load();
    expect(loaded?.globalSettings["audio.volume"]).toBe(0.4);
    expect(loaded?.history[0]?.name).toBe("sample.mp4");
    await storage.clear();
    expect(await storage.load()).toBeNull();
  });

  it("serializes concurrent saves", async () => {
    const storage = new MemoryPlayerStorage();
    const first = createEmptyPersistedState();
    first.globalSettings["audio.volume"] = 0.1;
    const second = createEmptyPersistedState();
    second.globalSettings["audio.volume"] = 0.2;
    await Promise.all([storage.save(first), storage.save(second)]);
    expect((await storage.load())?.globalSettings["audio.volume"]).toBe(0.2);
  });
});
