import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Readable } from "node:stream";
import type { IncomingMessage, ServerResponse } from "node:http";
import { PlayerError } from "@wasm-player/contracts";

export interface RemoteProxyOptions {
  /** Exact host or suffix allow-list; empty allows any public http(s) host. */
  allowDomains: string[];
  /** Dev escape hatch: allow loopback/private targets (tests only). */
  allowPrivateNetwork: boolean;
  userAgent?: string;
}

const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 3;

/**
 * Same-origin media proxy. The player page runs on the companion origin, so
 * remote media without CORS can still be opened through this endpoint with
 * Range requests preserved.
 */
export class RemoteProxy {
  private readonly options: RemoteProxyOptions;

  constructor(options: RemoteProxyOptions) {
    this.options = { ...options, userAgent: options.userAgent ?? "wasm-player/0.1" };
  }

  /** Validate only (used by /api/source before media.open). */
  async validate(raw: string): Promise<URL> {
    const url = this.parse(raw);
    if (this.options.allowDomains.length > 0) {
      const host = url.hostname.toLowerCase();
      const allowed = this.options.allowDomains.some(
        (domain) => host === domain || host.endsWith(`.${domain}`)
      );
      if (!allowed) {
        throw new PlayerError("SOURCE_NOT_AUTHORIZED", `remote host is not allowed: ${host}`);
      }
    }
    if (!this.options.allowPrivateNetwork) {
      const addresses = await this.resolveAddresses(url.hostname);
      if (addresses.some(isPrivateAddress)) {
        throw new PlayerError("SOURCE_NOT_AUTHORIZED", "private network targets are not allowed");
      }
    }
    return url;
  }

  /** Stream a GET/HEAD with Range passthrough and redirect re-validation. */
  async serve(request: IncomingMessage, response: ServerResponse, rawUrl: string): Promise<void> {
    const method = request.method === "HEAD" ? "HEAD" : "GET";
    const headers: Record<string, string> = {
      "user-agent": this.options.userAgent!,
      accept: request.headers.accept ?? "*/*"
    };
    if (request.headers.range) headers.range = request.headers.range;

    let url = await this.validate(rawUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      const upstream = await fetch(url, { method, headers, redirect: "manual" });
      if (REDIRECT_STATUS.has(upstream.status)) {
        const location = upstream.headers.get("location");
        if (!location) throw new PlayerError("UNSUPPORTED", "redirect without location");
        url = await this.validate(new URL(location, url).toString());
        await upstream.body?.cancel().catch(() => undefined);
        continue;
      }
      const pass = [
        "content-type",
        "content-length",
        "content-range",
        "accept-ranges",
        "etag",
        "last-modified"
      ];
      const out: Record<string, string> = {
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff"
      };
      for (const name of pass) {
        const value = upstream.headers.get(name);
        if (value) out[name] = value;
      }
      response.writeHead(upstream.status, out);
      if (method === "HEAD" || !upstream.body) {
        response.end();
        return;
      }
      Readable.fromWeb(upstream.body as never).pipe(response);
      return;
    }
    throw new PlayerError("UNSUPPORTED", "too many redirects");
  }

  private parse(raw: string): URL {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw new PlayerError("INVALID_REQUEST", "invalid url");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      throw new PlayerError("INVALID_REQUEST", "only http(s) sources are supported");
    }
    if (url.username || url.password) {
      throw new PlayerError("INVALID_REQUEST", "credentials in url are not allowed");
    }
    return url;
  }

  private async resolveAddresses(hostname: string): Promise<string[]> {
    const host = hostname.replace(/^\[|\]$/g, "");
    if (isIP(host)) return [host];
    try {
      const entries = await lookup(host, { all: true, verbatim: true });
      return entries.map((entry) => entry.address);
    } catch {
      throw new PlayerError("UNSUPPORTED", `cannot resolve host: ${host}`);
    }
  }
}

function isPrivateAddress(address: string): boolean {
  if (isIP(address) === 4) return isPrivateV4(address);
  const ip = address.toLowerCase();
  if (ip === "::1" || ip === "::") return true;
  if (ip.startsWith("fe80:") || ip.startsWith("fc") || ip.startsWith("fd")) return true;
  if (ip.startsWith("::ffff:")) return isPrivateV4(ip.slice("::ffff:".length));
  return false;
}

function isPrivateV4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return true;
  }
  const a = parts[0] ?? 0;
  const b = parts[1] ?? 0;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}
