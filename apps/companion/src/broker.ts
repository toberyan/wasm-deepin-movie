import { createReadStream, type Dirent } from "node:fs";
import { readdir, realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { basename, extname, relative, resolve, sep } from "node:path";

const MEDIA_EXTENSIONS = new Set([
  ".mp4",
  ".m4v",
  ".mov",
  ".mkv",
  ".webm",
  ".avi",
  ".flv",
  ".ts",
  ".m2ts",
  ".mts",
  ".mpg",
  ".mpeg",
  ".vob",
  ".ogv",
  ".ogg",
  ".wav",
  ".flac",
  ".mp3",
  ".m4a",
  ".aac",
  ".opus"
]);

const MIME_BY_EXTENSION: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".mkv": "video/x-matroska",
  ".webm": "video/webm",
  ".avi": "video/x-msvideo",
  ".flv": "video/x-flv",
  ".ts": "video/mp2t",
  ".m2ts": "video/mp2t",
  ".mts": "video/mp2t",
  ".mpg": "video/mpeg",
  ".mpeg": "video/mpeg",
  ".vob": "video/mpeg",
  ".ogv": "video/ogg",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".flac": "audio/flac",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".aac": "audio/aac",
  ".opus": "audio/ogg"
};

export interface BrokerSource {
  sourceId: string;
  name: string;
  sizeBytes: number;
  url: string;
}

interface ResolvedMedia {
  path: string;
  name: string;
  size: number;
  mtimeMs: number;
  mimeType: string;
}

/**
 * Read-only media broker for explicitly allowed roots. Paths are resolved with
 * realpath before the root check, so `..` and symlink escapes are rejected.
 */
export class MediaBroker {
  private readonly roots: string[];

  constructor(roots: string[]) {
    this.roots = roots;
  }

  async init(): Promise<void> {
    if (this.roots.length === 0) return;
    for (const root of this.roots) {
      const real = await realpath(root);
      const info = await stat(real);
      if (!info.isDirectory()) throw new Error(`not a directory: ${root}`);
    }
  }

  async list(baseUrl: string): Promise<BrokerSource[]> {
    const results: Omit<BrokerSource, "url">[] = [];
    const seen = new Set<string>();
    for (const root of this.roots) {
      await this.walk(root, root, results, seen, 0);
      if (results.length >= 500) break;
    }
    return results
      .sort((a, b) => a.sourceId.localeCompare(b.sourceId))
      .map((source) => ({
        ...source,
        url: `${baseUrl}/broker/media?path=${encodeURIComponent(source.sourceId)}`
      }));
  }

  async resolve(sourceId: string): Promise<ResolvedMedia | null> {
    if (!sourceId || sourceId.includes("\0") || sourceId.startsWith("/")) return null;
    const normalized = sourceId.replace(/\\/g, "/");
    for (const root of this.roots) {
      let realRoot: string;
      try {
        realRoot = await realpath(root);
      } catch {
        continue;
      }
      const candidate = resolve(realRoot, normalized);
      if (candidate !== realRoot && !candidate.startsWith(realRoot + sep)) continue;
      let realCandidate: string;
      try {
        realCandidate = await realpath(candidate);
      } catch {
        continue;
      }
      if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + sep)) continue;
      try {
        const info = await stat(realCandidate);
        if (!info.isFile()) continue;
        const extension = extname(realCandidate).toLowerCase();
        if (!MEDIA_EXTENSIONS.has(extension)) continue;
        return {
          path: realCandidate,
          name: basename(realCandidate),
          size: info.size,
          mtimeMs: info.mtimeMs,
          mimeType: MIME_BY_EXTENSION[extension] ?? "application/octet-stream"
        };
      } catch {
        continue;
      }
    }
    return null;
  }

  async serve(request: IncomingMessage, response: ServerResponse, sourceId: string): Promise<void> {
    const media = await this.resolve(sourceId);
    if (!media) {
      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("not found");
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { Allow: "GET, HEAD" });
      response.end();
      return;
    }
    const etag = `"${media.size.toString(16)}-${Math.floor(media.mtimeMs).toString(16)}"`;
    const headers: Record<string, string> = {
      "Accept-Ranges": "bytes",
      ETag: etag,
      "Last-Modified": new Date(media.mtimeMs).toUTCString(),
      "Content-Type": media.mimeType,
      "Cache-Control": "no-store"
    };
    if (request.headers["if-none-match"] === etag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    const range = request.headers.range;
    if (!range) {
      response.writeHead(200, { ...headers, "Content-Length": String(media.size) });
      if (request.method === "HEAD") {
        response.end();
        return;
      }
      const stream = createReadStream(media.path);
      stream.on("error", () => response.destroy());
      stream.pipe(response);
      return;
    }
    const match = /^bytes=(\d+)-(\d*)$/.exec(range.trim());
    if (!match) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${media.size}` });
      response.end();
      return;
    }
    const start = Number(match[1]);
    const requestedEnd = match[2] === "" ? media.size - 1 : Number(match[2]);
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(requestedEnd) ||
      start >= media.size ||
      requestedEnd < start
    ) {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${media.size}` });
      response.end();
      return;
    }
    const end = Math.min(requestedEnd, media.size - 1);
    response.writeHead(206, {
      ...headers,
      "Content-Range": `bytes ${start}-${end}/${media.size}`,
      "Content-Length": String(end - start + 1)
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = createReadStream(media.path, { start, end });
    stream.on("error", () => response.destroy());
    stream.pipe(response);
  }

  private async walk(
    root: string,
    current: string,
    results: Omit<BrokerSource, "url">[],
    seen: Set<string>,
    depth: number
  ): Promise<void> {
    if (depth > 4 || results.length >= 500) return;
    let entries: Dirent[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (results.length >= 500) return;
      if (entry.name.startsWith(".")) continue;
      const full = resolve(current, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await this.walk(root, full, results, seen, depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      const extension = extname(entry.name).toLowerCase();
      if (!MEDIA_EXTENSIONS.has(extension)) continue;
      const sourceId = relative(root, full).split(sep).join("/");
      if (seen.has(sourceId)) continue;
      seen.add(sourceId);
      try {
        const info = await stat(full);
        results.push({
          sourceId,
          name: entry.name,
          sizeBytes: info.size
        });
      } catch {
        // ignore vanished files
      }
    }
  }
}
