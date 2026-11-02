import {
  SourceError,
  abortedError,
  assertReadRange,
  combinedSignal,
  type SourceCapabilities,
  type SourceReader
} from "./types";

export interface HttpSourceOptions {
  url: string;
  headers?: Record<string, string>;
  fetch?: typeof fetch;
  blockSize?: number;
  cacheBlocks?: number;
  name?: string;
  /** Maximum bytes retained in the sequential (no-Range) fallback. */
  sequentialCacheBytes?: number;
}

interface CachedBlock {
  start: number;
  data: Uint8Array;
}

interface SequentialState {
  reader: ReadableStreamDefaultReader<Uint8Array>;
  bufferStart: number;
  buffer: Uint8Array;
  eof: boolean;
}

const DEFAULT_BLOCK_SIZE = 1024 * 1024;
const DEFAULT_CACHE_BLOCKS = 16;
const DEFAULT_SEQUENTIAL_CACHE = 16 * 1024 * 1024;

function parseContentRange(value: string | null): {
  start: number;
  end: number;
  size: number | null;
} {
  if (!value) {
    throw new SourceError("PROTOCOL_ERROR", "response is missing Content-Range");
  }
  const match = /^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i.exec(value.trim());
  if (!match) {
    throw new SourceError("PROTOCOL_ERROR", `invalid Content-Range: ${value}`);
  }
  const start = Number(match[1]);
  const end = Number(match[2]);
  const size = match[3] === "*" ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
    throw new SourceError("PROTOCOL_ERROR", `invalid Content-Range: ${value}`);
  }
  if (size !== null && (!Number.isSafeInteger(size) || end >= size)) {
    throw new SourceError("PROTOCOL_ERROR", `invalid Content-Range size: ${value}`);
  }
  return { start, end, size };
}

function parseUnsatisfiedRange(value: string | null): number | null {
  if (!value) return null;
  const match = /^bytes\s+\*\/(\d+)$/i.exec(value.trim());
  if (!match) return null;
  const size = Number(match[1]);
  return Number.isSafeInteger(size) ? size : null;
}

function responseEtag(response: Response): string | undefined {
  return response.headers.get("etag") ?? undefined;
}

function responseLastModified(response: Response): string | undefined {
  return response.headers.get("last-modified") ?? undefined;
}

/**
 * HTTP source with a strict Range path and a bounded sequential fallback.
 *
 * A 206 response is mandatory for random access. `Accept-Ranges` is never
 * trusted; the actual status and Content-Range are validated. Servers that
 * answer Range requests with 200 are treated as forward-only sources.
 */
export class HttpSourceReader implements SourceReader {
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly blockSize: number;
  private readonly maxCacheBlocks: number;
  private readonly sequentialCacheBytes: number;
  private readonly name: string;
  private readonly cache = new Map<number, CachedBlock>();
  readonly ready: Promise<void>;
  private initializeResult = {
    size: 0,
    randomAccess: false,
    etag: undefined as string | undefined,
    lastModified: undefined as string | undefined,
    contentType: undefined as string | undefined
  };
  private sequential: SequentialState | null = null;
  private closed = false;
  private controller = new AbortController();
  private cancelReason: string | undefined;

  constructor(options: HttpSourceOptions) {
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.fetchImpl = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.blockSize = options.blockSize ?? DEFAULT_BLOCK_SIZE;
    this.maxCacheBlocks = options.cacheBlocks ?? DEFAULT_CACHE_BLOCKS;
    this.sequentialCacheBytes = options.sequentialCacheBytes ?? DEFAULT_SEQUENTIAL_CACHE;
    this.name = options.name ?? options.url;
    if (this.blockSize <= 0) throw new RangeError("blockSize must be positive");
    if (this.maxCacheBlocks <= 0) throw new RangeError("cacheBlocks must be positive");
    this.ready = this.initialize();
  }

  async whenReady(): Promise<SourceCapabilities> {
    await this.ready;
    return this.getCapabilities();
  }

  getSize(): number {
    return this.initializeResult.size;
  }

  getCapabilities(): SourceCapabilities {
    return {
      kind: "http",
      size: this.initializeResult.size,
      randomAccess: this.initializeResult.randomAccess,
      seekable: this.initializeResult.randomAccess,
      rangeRequests: this.initializeResult.randomAccess,
      etag: this.initializeResult.etag,
      lastModified: this.initializeResult.lastModified,
      contentType: this.initializeResult.contentType,
      reason: this.initializeResult.randomAccess ? undefined : "server ignored Range; forward-only reads"
    };
  }

  async readAt(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    await this.ready;
    if (this.closed) throw new SourceError("CLOSED", `source ${this.name} is closed`);
    assertReadRange(offset, length);
    if (signal?.aborted) throw abortedError(signal);
    if (this.controller.signal.aborted) {
      throw new SourceError("CANCELLED", this.cancelReason ?? "source read cancelled");
    }
    if (length === 0 || offset >= this.getSize()) return new Uint8Array(0);
    if (!this.initializeResult.randomAccess) {
      return this.readSequential(offset, length, signal);
    }
    return this.readRanged(offset, length, signal);
  }

  private async initialize(): Promise<void> {
    const { signal, dispose } = combinedSignal(this.controller.signal);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        headers: { ...this.headers, Range: "bytes=0-0" },
        signal
      });
      if (response.status === 206) {
        const range = parseContentRange(response.headers.get("content-range"));
        const buffer = new Uint8Array(await response.arrayBuffer());
        const expectedLength = Math.min(1, range.size === null ? 1 : range.size);
        if (buffer.length !== expectedLength) {
          throw new SourceError(
            "PROTOCOL_ERROR",
            `short first range: expected ${expectedLength}, got ${buffer.length}`
          );
        }
        const size = range.size;
        if (size === null) {
          throw new SourceError("PROTOCOL_ERROR", "Content-Range is missing total size");
        }
        this.initializeResult = {
          size,
          randomAccess: true,
          etag: responseEtag(response),
          lastModified: responseLastModified(response),
          contentType: response.headers.get("content-type") ?? undefined
        };
        return;
      }
      if (response.status === 200) {
        const length = response.headers.get("content-length");
        if (length === null) {
          throw new SourceError("PROTOCOL_ERROR", "200 response is missing Content-Length");
        }
        const size = Number(length);
        if (!Number.isSafeInteger(size) || size < 0) {
          throw new SourceError("PROTOCOL_ERROR", `invalid Content-Length: ${length}`);
        }
        this.initializeResult = {
          size,
          randomAccess: false,
          etag: responseEtag(response),
          lastModified: responseLastModified(response),
          contentType: response.headers.get("content-type") ?? undefined
        };
        if (!response.body) {
          throw new SourceError("PROTOCOL_ERROR", "200 response has no readable body");
        }
        this.sequential = {
          reader: response.body.getReader(),
          bufferStart: 0,
          buffer: new Uint8Array(0),
          eof: false
        };
        return;
      }
      if (response.status === 416) {
        const size = parseUnsatisfiedRange(response.headers.get("content-range"));
        if (size === null) {
          throw new SourceError("PROTOCOL_ERROR", "416 response is missing a valid Content-Range");
        }
        this.initializeResult = {
          size,
          randomAccess: true,
          etag: responseEtag(response),
          lastModified: responseLastModified(response),
          contentType: response.headers.get("content-type") ?? undefined
        };
        return;
      }
      if (response.status === 401 || response.status === 403) {
        throw new SourceError(
          "SOURCE_NOT_AUTHORIZED",
          `HTTP ${response.status} for ${this.name}`
        );
      }
      throw new SourceError("READ_FAILED", `HTTP ${response.status} for ${this.name}`);
    } catch (error) {
      if (this.closed) throw new SourceError("CLOSED", `source ${this.name} is closed`);
      if (this.cancelReason !== undefined) {
        throw new SourceError("CANCELLED", this.cancelReason);
      }
      if (error instanceof SourceError) throw error;
      throw new SourceError("READ_FAILED", `failed to initialize ${this.name}`, {
        cause: error instanceof Error ? error.message : String(error)
      });
    } finally {
      dispose();
    }
  }

  private async readRanged(
    offset: number,
    length: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const size = this.getSize();
    const end = Math.min(size, offset + length);
    const firstBlock = Math.floor(offset / this.blockSize);
    const lastBlock = Math.floor((end - 1) / this.blockSize);
    const output = new Uint8Array(end - offset);
    let written = 0;
    for (let blockIndex = firstBlock; blockIndex <= lastBlock; blockIndex += 1) {
      const block = await this.getBlock(blockIndex, signal);
      const blockStart = blockIndex * this.blockSize;
      const copyStart = Math.max(offset, blockStart);
      const copyEnd = Math.min(end, blockStart + block.data.length);
      if (copyEnd <= copyStart) continue;
      const sourceStart = copyStart - blockStart;
      const targetStart = copyStart - offset;
      output.set(block.data.subarray(sourceStart, sourceStart + (copyEnd - copyStart)), targetStart);
      written += copyEnd - copyStart;
      if (block.data.length < this.blockSize) break;
    }
    return written === output.length ? output : output.slice(0, written);
  }

  private async getBlock(index: number, signal?: AbortSignal): Promise<CachedBlock> {
    const cached = this.cache.get(index);
    if (cached) {
      this.cache.delete(index);
      this.cache.set(index, cached);
      return cached;
    }
    const size = this.getSize();
    const start = index * this.blockSize;
    const end = Math.min(size, start + this.blockSize) - 1;
    if (start >= size || end < start) {
      return { start, data: new Uint8Array(0) };
    }
    const { signal: combined, dispose } = combinedSignal(this.controller.signal, signal);
    try {
      const response = await this.fetchImpl(this.url, {
        method: "GET",
        headers: { ...this.headers, Range: `bytes=${start}-${end}` },
        signal: combined
      });
      if (response.status === 416) {
        throw new SourceError("OUT_OF_RANGE", `range ${start}-${end} is not satisfiable`);
      }
      if (response.status === 401 || response.status === 403) {
        throw new SourceError("SOURCE_NOT_AUTHORIZED", `HTTP ${response.status} for ${this.name}`);
      }
      if (response.status !== 206) {
        if (response.status === 200) {
          throw new SourceError(
            "RANGE_NOT_SUPPORTED",
            `server stopped honoring Range requests for ${this.name}`
          );
        }
        throw new SourceError("READ_FAILED", `HTTP ${response.status} for ${this.name}`);
      }
      const range = parseContentRange(response.headers.get("content-range"));
      if (range.start !== start || range.end > end || range.size !== size) {
        throw new SourceError(
          "PROTOCOL_ERROR",
          `unexpected Content-Range ${response.headers.get("content-range")}`
        );
      }
      this.assertResourceIdentity(response);
      const data = new Uint8Array(await response.arrayBuffer());
      const expected = range.end - range.start + 1;
      if (data.length !== expected) {
        throw new SourceError(
          "PROTOCOL_ERROR",
          `short range response: expected ${expected}, got ${data.length}`
        );
      }
      const block = { start, data };
      this.cache.set(index, block);
      while (this.cache.size > this.maxCacheBlocks) {
        const oldest = this.cache.keys().next().value as number | undefined;
        if (oldest === undefined) break;
        this.cache.delete(oldest);
      }
      return block;
    } catch (error) {
      if (combined.aborted) throw abortedError(combined);
      if (error instanceof SourceError) throw error;
      throw new SourceError("READ_FAILED", `failed to read ${this.name}`, {
        cause: error instanceof Error ? error.message : String(error)
      });
    } finally {
      dispose();
    }
  }

  private assertResourceIdentity(response: Response): void {
    const etag = responseEtag(response);
    if (this.initializeResult.etag && etag && etag !== this.initializeResult.etag) {
      throw new SourceError("SOURCE_CHANGED", "ETag changed while reading", {
        expected: this.initializeResult.etag,
        actual: etag
      });
    }
    const lastModified = responseLastModified(response);
    if (
      this.initializeResult.lastModified &&
      lastModified &&
      lastModified !== this.initializeResult.lastModified
    ) {
      throw new SourceError("SOURCE_CHANGED", "Last-Modified changed while reading", {
        expected: this.initializeResult.lastModified,
        actual: lastModified
      });
    }
  }

  private async readSequential(
    offset: number,
    length: number,
    signal?: AbortSignal
  ): Promise<Uint8Array> {
    const state = this.sequential;
    if (!state) throw new SourceError("SOURCE_NOT_SEEKABLE", "sequential source is not initialized");
    const end = Math.min(this.getSize(), offset + length);
    const { signal: combined, dispose } = combinedSignal(this.controller.signal, signal);
    try {
      while (!state.eof && state.bufferStart + state.buffer.length < end) {
        if (combined.aborted) throw abortedError(combined);
        const { value, done } = await state.reader.read();
        if (done) {
          state.eof = true;
          break;
        }
        if (value && value.length > 0) {
          const next = new Uint8Array(state.buffer.length + value.length);
          next.set(state.buffer, 0);
          next.set(value, state.buffer.length);
          state.buffer = next;
        }
      }
      const retainFrom = Math.max(state.bufferStart, offset - this.sequentialCacheBytes);
      if (state.bufferStart < retainFrom) {
        const drop = retainFrom - state.bufferStart;
        state.buffer = state.buffer.slice(drop);
        state.bufferStart = retainFrom;
      }
    } finally {
      dispose();
    }
    if (offset < state.bufferStart) {
      throw new SourceError(
        "SOURCE_NOT_SEEKABLE",
        `offset ${offset} was discarded from the forward-only window`
      );
    }
    const relative = offset - state.bufferStart;
    if (relative > state.buffer.length) {
      throw new SourceError(
        "SOURCE_NOT_SEEKABLE",
        `offset ${offset} is ahead of the forward-only stream`
      );
    }
    return state.buffer.slice(relative, Math.min(state.buffer.length, relative + (end - offset)));
  }

  cancel(reason = "cancelled"): void {
    this.cancelReason = reason;
    this.controller.abort(reason);
    this.controller = new AbortController();
    if (this.sequential) {
      void this.sequential.reader.cancel(reason).catch(() => undefined);
      this.sequential = null;
    }
    this.cache.clear();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort("closed");
    if (this.sequential) {
      await this.sequential.reader.cancel("closed").catch(() => undefined);
      this.sequential = null;
    }
    this.cache.clear();
  }
}
