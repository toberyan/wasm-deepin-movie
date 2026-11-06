import { describe, expect, it } from "vitest";
import {
  MemoryPlayerStorage,
  SerialQueue,
  createEmptyPersistedState,
  transactionResult
} from "../src/index";

interface FakeTransaction {
  error: DOMException | null;
  oncomplete: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
}

function fakeTransaction(): FakeTransaction & IDBTransaction {
  return {
    error: null,
    oncomplete: null,
    onerror: null,
    onabort: null
  } as unknown as FakeTransaction & IDBTransaction;
}

function fakeRequest(result: unknown): IDBRequest<unknown> {
  const request: Record<string, unknown> = { result, error: null, onsuccess: null, onerror: null };
  return request as unknown as IDBRequest<unknown>;
}

describe("SerialQueue", () => {
  it("keeps running tasks after a failure", async () => {
    const queue = new SerialQueue();
    const calls: string[] = [];
    const failed = queue.run(async () => {
      calls.push("first");
      throw new Error("disk full");
    });
    const recovered = queue.run(async () => {
      calls.push("second");
      return "ok";
    });
    await expect(failed).rejects.toThrow("disk full");
    await expect(recovered).resolves.toBe("ok");
    expect(calls).toEqual(["first", "second"]);
  });

  it("runs tasks in submission order", async () => {
    const queue = new SerialQueue();
    const order: number[] = [];
    const tasks = [0, 1, 2].map((value) =>
      queue.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 3 - value));
        order.push(value);
      })
    );
    await Promise.all(tasks);
    expect(order).toEqual([0, 1, 2]);
  });
});

describe("transactionResult", () => {
  it("resolves only after the transaction commits", async () => {
    const transaction = fakeTransaction();
    const request = fakeRequest({ saved: true });
    let settled = false;
    const promise = transactionResult(transaction, request).finally(() => {
      settled = true;
    });
    request.onsuccess?.(new Event("success"));
    await Promise.resolve();
    expect(settled).toBe(false);
    transaction.oncomplete?.();
    await expect(promise).resolves.toEqual({ saved: true });
  });

  it("rejects when the transaction aborts after a successful request", async () => {
    const transaction = fakeTransaction();
    const request = fakeRequest(undefined);
    const promise = transactionResult(transaction, request);
    request.onsuccess?.(new Event("success"));
    transaction.error = new DOMException("quota exceeded", "QuotaExceededError");
    transaction.onabort?.();
    await expect(promise).rejects.toThrow("quota exceeded");
  });

  it("rejects when the request itself fails", async () => {
    const transaction = fakeTransaction();
    const request = fakeRequest(undefined);
    (request as { error: DOMException | null }).error = new DOMException(
      "bad key",
      "DataError"
    );
    const promise = transactionResult(transaction, request);
    request.onerror?.(new Event("error"));
    await expect(promise).rejects.toThrow("bad key");
  });
});

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
