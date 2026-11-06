import type { PersistedPlayerState, PlayerStorage } from "@wasm-player/contracts";

export type { PersistedPlayerState, PlayerStorage } from "@wasm-player/contracts";

/**
 * Serializes asynchronous writes while staying usable after a failure. A plain
 * `chain = chain.then(...)` keeps the rejected promise forever, so one failed
 * write would silently disable every later save.
 */
export class SerialQueue {
  private tail: Promise<void> = Promise.resolve();

  run<T>(task: () => Promise<T> | T): Promise<T> {
    const result = this.tail.then(task, task);
    this.tail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  /** Resolves once every queued task has settled. */
  idle(): Promise<void> {
    return this.tail;
  }
}

const DB_NAME = "wasm-player";
const DB_VERSION = 1;
const STORE_NAME = "state";
const STATE_KEY = "player";

function emptyState(): PersistedPlayerState {
  return {
    version: 1,
    globalSettings: {},
    history: [],
    bookmarks: [],
    playlist: [],
    presets: []
  };
}

function cloneState(state: PersistedPlayerState): PersistedPlayerState {
  return structuredClone(state);
}

function isPersistedState(value: unknown): value is PersistedPlayerState {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<PersistedPlayerState>;
  return (
    record.version === 1 &&
    typeof record.globalSettings === "object" &&
    Array.isArray(record.history) &&
    Array.isArray(record.bookmarks) &&
    Array.isArray(record.playlist) &&
    Array.isArray(record.presets)
  );
}

export class MemoryPlayerStorage implements PlayerStorage {
  private state: PersistedPlayerState | null = null;
  private readonly queue = new SerialQueue();

  async load(): Promise<PersistedPlayerState | null> {
    await this.queue.idle();
    return this.state ? cloneState(this.state) : null;
  }

  save(state: PersistedPlayerState): Promise<void> {
    return this.queue.run(() => {
      this.state = cloneState(state);
    });
  }

  async clear(): Promise<void> {
    await this.queue.run(() => {
      this.state = null;
    });
  }
}

export interface IndexedDbFactory {
  open(name: string, version?: number): IDBOpenDBRequest;
}

/**
 * Resolves only when the surrounding transaction commits. A successful request
 * is not a durable write: the transaction can still abort afterwards, so
 * resolving on `request.onsuccess` reports success too early.
 */
export function transactionResult<T>(
  transaction: IDBTransaction,
  request: IDBRequest<T>
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let result: T;
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      reject(error instanceof Error ? error : new Error(String(error)));
    };
    request.onsuccess = () => {
      result = request.result;
    };
    request.onerror = () => fail(request.error ?? new Error("IndexedDB request failed"));
    transaction.oncomplete = () => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    transaction.onerror = () =>
      fail(transaction.error ?? new Error("IndexedDB transaction failed"));
    transaction.onabort = () =>
      fail(transaction.error ?? new Error("IndexedDB transaction aborted"));
  });
}

export class IndexedDbPlayerStorage implements PlayerStorage {
  private db: Promise<IDBDatabase> | null = null;
  private readonly queue = new SerialQueue();

  constructor(private readonly factory?: IndexedDbFactory) {}

  private get indexedDb(): IndexedDbFactory | undefined {
    return this.factory ?? (typeof indexedDB === "undefined" ? undefined : indexedDB);
  }

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      const factory = this.indexedDb;
      if (!factory) {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = factory.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB open failed"));
      request.onblocked = () => reject(new Error("IndexedDB open blocked"));
    });
    return this.db;
  }

  private async run<T>(
    mode: IDBTransactionMode,
    operation: (store: IDBObjectStore) => IDBRequest<T>
  ): Promise<T> {
    const db = await this.open();
    const transaction = db.transaction(STORE_NAME, mode);
    const request = operation(transaction.objectStore(STORE_NAME));
    return transactionResult(transaction, request);
  }

  async load(): Promise<PersistedPlayerState | null> {
    await this.queue.idle();
    try {
      const value = await this.run<unknown>("readonly", (store) => store.get(STATE_KEY));
      return isPersistedState(value) ? value : null;
    } catch {
      return null;
    }
  }

  save(state: PersistedPlayerState): Promise<void> {
    return this.queue.run(async () => {
      await this.run("readwrite", (store) => store.put(state, STATE_KEY));
    });
  }

  async clear(): Promise<void> {
    await this.queue.run(async () => {
      await this.run("readwrite", (store) => store.delete(STATE_KEY));
    });
  }
}

export function createPlayerStorage(): PlayerStorage {
  if (typeof indexedDB === "undefined") return new MemoryPlayerStorage();
  return new IndexedDbPlayerStorage();
}

export { emptyState as createEmptyPersistedState };
