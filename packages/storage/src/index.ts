import type { PersistedPlayerState, PlayerStorage } from "@wasm-player/contracts";

export type { PersistedPlayerState, PlayerStorage } from "@wasm-player/contracts";

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
  private chain: Promise<void> = Promise.resolve();

  async load(): Promise<PersistedPlayerState | null> {
    await this.chain;
    return this.state ? cloneState(this.state) : null;
  }

  save(state: PersistedPlayerState): Promise<void> {
    this.chain = this.chain.then(() => {
      this.state = cloneState(state);
    });
    return this.chain;
  }

  async clear(): Promise<void> {
    await this.chain;
    this.state = null;
  }
}

export class IndexedDbPlayerStorage implements PlayerStorage {
  private db: Promise<IDBDatabase> | null = null;
  private chain: Promise<void> = Promise.resolve();

  private open(): Promise<IDBDatabase> {
    if (this.db) return this.db;
    this.db = new Promise((resolve, reject) => {
      if (typeof indexedDB === "undefined") {
        reject(new Error("IndexedDB is unavailable"));
        return;
      }
      const request = indexedDB.open(DB_NAME, DB_VERSION);
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

  private async run<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
    const db = await this.open();
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, mode);
      const request = operation(transaction.objectStore(STORE_NAME));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error ?? new Error("IndexedDB request failed"));
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB transaction aborted"));
    });
  }

  async load(): Promise<PersistedPlayerState | null> {
    await this.chain;
    try {
      const value = await this.run<unknown>("readonly", (store) => store.get(STATE_KEY));
      return isPersistedState(value) ? value : null;
    } catch {
      return null;
    }
  }

  save(state: PersistedPlayerState): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.run("readwrite", (store) => store.put(state, STATE_KEY));
    });
    return this.chain;
  }

  async clear(): Promise<void> {
    this.chain = this.chain.then(async () => {
      await this.run("readwrite", (store) => store.delete(STATE_KEY));
    });
    await this.chain;
  }
}

export function createPlayerStorage(): PlayerStorage {
  if (typeof indexedDB === "undefined") return new MemoryPlayerStorage();
  return new IndexedDbPlayerStorage();
}

export { emptyState as createEmptyPersistedState };
