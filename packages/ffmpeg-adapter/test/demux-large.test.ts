import { createServer, type Server } from "node:http";
import { createReadStream } from "node:fs";
import { copyFile, stat, truncate } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DemuxSession } from "../src/index";
import { HttpSourceReader } from "@wasm-player/source-readers";

const FIVE_GIB = 5 * 1024 * 1024 * 1024;
const small = resolve("tests/fixtures/generated/sample-h264-aac.mp4");
const large = resolve("tests/fixtures/generated/large-sparse.mp4");
let server: Server;
let port = 0;
let fileSize = 0;

beforeAll(async () => {
  await copyFile(small, large);
  await truncate(large, FIVE_GIB);
  fileSize = (await stat(large)).size;
  server = createServer(async (request, response) => {
    const range = request.headers.range;
    const headers = {
      "Accept-Ranges": "bytes",
      ETag: '"large-v1"',
      "Content-Type": "video/mp4"
    };
    if (!range) {
      response.writeHead(200, { ...headers, "Content-Length": String(fileSize) });
      createReadStream(large).pipe(response);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range);
    if (!match) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${fileSize}` });
      response.end();
      return;
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] === "" ? fileSize - 1 : Number(match[2]);
    const end = Math.min(requestedEnd, fileSize - 1);
    if (start >= fileSize) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${fileSize}` });
      response.end();
      return;
    }
    response.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${fileSize}`,
      "Content-Length": String(end - start + 1)
    });
    createReadStream(large, { start, end }).pipe(response);
  });
  await new Promise<void>((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  port = (server.address() as AddressInfo).port;
}, 30_000);

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

describe(">4 GiB source", () => {
  it("serves a 5 GiB MP4 through Range and demuxes/seeks it", async () => {
    expect(fileSize).toBe(FIVE_GIB);
    const url = `http://127.0.0.1:${port}/large-sparse.mp4`;
    const tailReader = new HttpSourceReader({ url, blockSize: 1024 * 1024 });
    const caps = await tailReader.whenReady();
    expect(caps.size).toBe(FIVE_GIB);
    expect(caps.randomAccess).toBe(true);
    const tail = await tailReader.readAt(FIVE_GIB - 16, 16);
    expect([...tail]).toEqual(new Array(16).fill(0));
    await tailReader.close();

    const session = new DemuxSession();
    try {
      const probe = await session.open(
        { kind: "url", url, name: "large-sparse.mp4" },
        { name: "large-sparse.mp4" }
      );
      expect(probe.media.sizeBytes).toBe(FIVE_GIB);
      expect(probe.media.container).toBe("mp4");
      expect(probe.media.seekable).toBe(true);
      expect(probe.media.streams.some((stream) => stream.type === "video")).toBe(true);

      let videoPackets = 0;
      let eof = false;
      while (!eof) {
        const result = await session.read(128 * 1024, 16);
        videoPackets += result.packets.filter((packet) => packet.streamType === "video").length;
        eof = result.eof;
      }
      expect(videoPackets).toBe(60);

      const seek = await session.seek(1_000_000);
      expect(seek.positionUs).toBeGreaterThanOrEqual(950_000);
      expect(seek.packets.length).toBeGreaterThan(0);
    } finally {
      await session.close();
    }
  }, 60_000);
});
