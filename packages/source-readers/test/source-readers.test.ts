import { describe, expect, it } from "vitest";
import {
  FileSourceReader,
  HttpSourceReader,
  MemorySourceReader,
  SourceError,
  SparseSourceReader,
  type SourceCapabilities
} from "../src/index";

function bytes(length: number, seed = 0): Uint8Array<ArrayBuffer> {
  const data = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) data[i] = (i * 7 + seed) & 0xff;
  return data;
}

interface RangeServerOptions {
  ignoreRange?: boolean;
  etag?: string;
  omitContentRange?: boolean;
  status?: number;
  hang?: boolean;
}

function rangeServer(data: Uint8Array<ArrayBuffer>, options: RangeServerOptions = {}) {
  const requests: { range: string | null; method: string }[] = [];
  let etag = options.etag ?? '"v1"';
  const fetchImpl: typeof fetch = async (_input, init) => {
    const headers = new Headers(init?.headers);
    const range = headers.get("range");
    requests.push({ range, method: init?.method ?? "GET" });
    const signal = init?.signal;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    if (options.hang) {
      const { promise, reject } = Promise.withResolvers<void>();
      signal?.addEventListener(
        "abort",
        () => reject(new DOMException("Aborted", "AbortError")),
        { once: true }
      );
      await promise;
    }
    if (options.status !== undefined) {
      return new Response(null, { status: options.status, headers: { etag } });
    }
    if (options.ignoreRange) {
      return new Response(data, {
        status: 200,
        headers: {
          "Content-Length": String(data.length),
          "Content-Type": "video/mp4",
          etag
        }
      });
    }
    if (!range) {
      return new Response(data, {
        status: 200,
        headers: { "Content-Length": String(data.length), etag }
      });
    }
    const match = /^bytes=(\d+)-(\d+)$/.exec(range);
    if (!match) return new Response(null, { status: 400 });
    const start = Number(match[1]);
    const requestedEnd = Number(match[2]);
    if (start >= data.length) {
      return new Response(null, {
        status: 416,
        headers: { "Content-Range": `bytes */${data.length}`, etag }
      });
    }
    const end = Math.min(requestedEnd, data.length - 1);
    const body = data.slice(start, end + 1);
    const responseHeaders: Record<string, string> = {
      "Content-Length": String(body.length),
      "Content-Type": "video/mp4",
      etag
    };
    if (!options.omitContentRange) responseHeaders["Content-Range"] = `bytes ${start}-${end}/${data.length}`;
    return new Response(body, { status: 206, headers: responseHeaders });
  };
  return {
    fetchImpl,
    requests,
    setEtag(value: string) {
      etag = value;
    }
  };
}

describe("FileSourceReader", () => {
  it("reads exact ranges and clamps at EOF", async () => {
    const source = new FileSourceReader(new Blob([bytes(10)]));
    expect(source.getSize()).toBe(10);
    expect(await source.readAt(2, 3)).toEqual(bytes(10).slice(2, 5));
    expect(await source.readAt(8, 10)).toEqual(bytes(10).slice(8));
    expect(await source.readAt(10, 5)).toHaveLength(0);
    expect(source.getCapabilities().randomAccess).toBe(true);
  });

  it("rejects invalid offsets and reads after close", async () => {
    const source = new FileSourceReader(new Blob([bytes(10)]));
    await expect(source.readAt(-1, 1)).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
    await expect(source.readAt(0, 1.5)).rejects.toMatchObject({ code: "OUT_OF_RANGE" });
    source.cancel();
    expect(await source.readAt(0, 1)).toHaveLength(1);
    await source.close();
    await expect(source.readAt(0, 1)).rejects.toMatchObject({ code: "CLOSED" });
  });
});

describe("MemorySourceReader", () => {
  it("serves random offsets", async () => {
    const data = bytes(12);
    const source = new MemorySourceReader(data);
    expect(await source.readAt(3, 4)).toEqual(data.slice(3, 7));
    await source.close();
    await expect(source.readAt(0, 1)).rejects.toMatchObject({ code: "CLOSED" });
  });
});

describe("SparseSourceReader", () => {
  it("supports offsets beyond 4 GiB without allocating the file", async () => {
    const sixGiB = 6 * 1024 * 1024 * 1024;
    const source = new SparseSourceReader(sixGiB);
    expect(source.getSize()).toBe(sixGiB);
    const offset = sixGiB - 4096;
    const data = await source.readAt(offset, 4096);
    expect(data).toHaveLength(4096);
    for (let i = 0; i < data.length; i += 1) {
      expect(data[i]).toBe(((offset + i) * 31 + 17) & 0xff);
    }
    const tail = await source.readAt(sixGiB - 16, 100);
    expect(tail).toHaveLength(16);
    expect(await source.readAt(sixGiB, 10)).toHaveLength(0);
  });

  it("supports custom fill functions", async () => {
    const source = new SparseSourceReader(4096, (offset, target) => {
      target.fill((offset / 1024) & 0xff);
    });
    const data = await source.readAt(2048, 4);
    expect([...data]).toEqual([2, 2, 2, 2]);
  });

  it("rejects unsafe sizes", () => {
    expect(() => new SparseSourceReader(Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError);
  });
});

describe("HttpSourceReader", () => {
  it("validates 206 responses and serves random access from block cache", async () => {
    const data = bytes(32);
    const server = rangeServer(data);
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: server.fetchImpl,
      blockSize: 8,
      cacheBlocks: 4
    });
    const caps = await source.whenReady();
    expect(caps).toMatchObject({
      kind: "http",
      size: 32,
      randomAccess: true,
      seekable: true,
      rangeRequests: true,
      etag: '"v1"'
    });
    expect(await source.readAt(7, 10)).toEqual(data.slice(7, 17));
    const requestCount = server.requests.length;
    expect(await source.readAt(7, 10)).toEqual(data.slice(7, 17));
    expect(server.requests.length).toBe(requestCount);
    expect(await source.readAt(30, 10)).toEqual(data.slice(30));
  });

  it("falls back to bounded forward-only reads when Range is ignored", async () => {
    const data = bytes(64);
    const server = rangeServer(data, { ignoreRange: true });
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: server.fetchImpl,
      sequentialCacheBytes: 8
    });
    const caps = await source.whenReady();
    expect(caps.randomAccess).toBe(false);
    expect(caps.seekable).toBe(false);
    expect(caps.reason).toContain("forward-only");
    expect(await source.readAt(0, 4)).toEqual(data.slice(0, 4));
    expect(await source.readAt(10, 4)).toEqual(data.slice(10, 14));
    expect(await source.readAt(20, 4)).toEqual(data.slice(20, 24));
    await expect(source.readAt(0, 4)).rejects.toMatchObject({ code: "SOURCE_NOT_SEEKABLE" });
  });

  it("detects ETag changes between range requests", async () => {
    const data = bytes(32);
    const server = rangeServer(data, { etag: '"v1"' });
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: server.fetchImpl,
      blockSize: 8
    });
    await source.whenReady();
    server.setEtag('"v2"');
    await expect(source.readAt(8, 4)).rejects.toMatchObject({ code: "SOURCE_CHANGED" });
  });

  it("rejects 206 responses without Content-Range", async () => {
    const data = bytes(16);
    const server = rangeServer(data, { omitContentRange: true });
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: server.fetchImpl
    });
    await expect(source.whenReady()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
  });

  it("maps authorization failures to SOURCE_NOT_AUTHORIZED", async () => {
    const server = rangeServer(bytes(8), { status: 403 });
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: server.fetchImpl
    });
    await expect(source.whenReady()).rejects.toMatchObject({ code: "SOURCE_NOT_AUTHORIZED" });
  });

  it("cancels in-flight initialization", async () => {
    const server = rangeServer(bytes(8), { hang: true });
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: server.fetchImpl
    });
    const pending = source.readAt(0, 1);
    source.cancel("test cancel");
    await expect(pending).rejects.toMatchObject({ code: "CANCELLED" });
  });

  it("reports unsupported sizes and short responses as protocol errors", async () => {
    const data = bytes(8);
    const fetchImpl: typeof fetch = async () =>
      new Response(new Uint8Array([1, 2]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-2/8" }
      });
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: fetchImpl
    });
    await expect(source.whenReady()).rejects.toMatchObject({ code: "PROTOCOL_ERROR" });
    void data;
  });

  it("keeps capability fields stable after close", async () => {
    const server = rangeServer(bytes(8));
    const source = new HttpSourceReader({
      url: "https://example.com/video.mp4",
      fetch: server.fetchImpl
    });
    const caps: SourceCapabilities = await source.whenReady();
    await source.close();
    expect(source.getCapabilities()).toMatchObject(caps);
    await expect(source.readAt(0, 1)).rejects.toMatchObject({ code: "CLOSED" });
  });
});

describe("SourceError", () => {
  it("carries a stable code", () => {
    const error = new SourceError("SOURCE_CHANGED", "changed", { expected: "a" });
    expect(error.code).toBe("SOURCE_CHANGED");
    expect(error.details).toEqual({ expected: "a" });
  });
});
