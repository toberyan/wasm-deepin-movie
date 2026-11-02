import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFile, realpath, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import {
  PlayerError,
  type ActionId,
  type InvokeResult
} from "@wasm-player/contracts";
import type { ControlBridge, McpSessionInfo, McpSourceInfo } from "@wasm-player/mcp-server";
import { MediaBroker } from "./broker";
import { tokenMatches } from "./token";

export interface CompanionServerOptions {
  host: string;
  port: number;
  token: string;
  webRoot: string;
  broker: MediaBroker;
}

interface PendingRequest {
  resolve: (result: InvokeResult) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface Session {
  sessionId: string;
  socket: WebSocket;
  connectedAt: number;
  info: McpSessionInfo;
  pending: Map<string, PendingRequest>;
}

interface HelloMessage {
  type: "hello";
  sessionId: string;
  state?: {
    phase?: string;
    media?: { name?: string };
  };
}

interface ResponseMessage {
  type: "response";
  id: string;
  result: InvokeResult;
}

type ClientMessage = HelloMessage | ResponseMessage;

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".wasm": "application/wasm",
  ".woff2": "font/woff2",
  ".woff": "font/woff",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8"
};

const SECURITY_HEADERS: Record<string, string> = {
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Embedder-Policy": "require-corp",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "Content-Security-Policy": [
    "default-src 'self'",
    "script-src 'self' 'wasm-unsafe-eval' blob:",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob:",
    "media-src 'self' blob:",
    "font-src 'self' data:",
    "connect-src 'self' ws://127.0.0.1:* ws://localhost:*",
    "worker-src 'self' blob:",
    "child-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'none'"
  ].join("; ")
};

export class CompanionServer implements ControlBridge {
  private readonly options: CompanionServerOptions;
  private readonly httpServer: Server;
  private readonly wss: WebSocketServer;
  private readonly sessions = new Map<string, Session>();
  private activeSessionId: string | null = null;
  private requestSeq = 0;
  private baseUrl = "";
  private ready = false;

  constructor(options: CompanionServerOptions) {
    this.options = options;
    this.httpServer = createServer((request, response) => {
      void this.handleHttp(request, response);
    });
    this.wss = new WebSocketServer({ noServer: true, maxPayload: 512 * 1024 });
    this.httpServer.on("upgrade", (request, socket, head) => {
      void this.handleUpgrade(request, socket, head);
    });
  }

  get url(): string {
    return this.baseUrl;
  }

  async start(): Promise<void> {
    await this.options.broker.init();
    await new Promise<void>((resolveListen, reject) => {
      this.httpServer.once("error", reject);
      this.httpServer.listen(this.options.port, this.options.host, () => {
        this.httpServer.off("error", reject);
        resolveListen();
      });
    });
    const address = this.httpServer.address();
    if (!address || typeof address === "string") {
      throw new Error("companion failed to obtain a TCP address");
    }
    this.baseUrl = `http://${this.options.host}:${address.port}`;
    this.ready = true;
  }

  async close(): Promise<void> {
    this.ready = false;
    for (const session of this.sessions.values()) {
      for (const pending of session.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new PlayerError("SESSION_CLOSED", "companion is closing"));
      }
      session.socket.close();
    }
    this.sessions.clear();
    this.wss.close();
    await new Promise<void>((resolveClose) => {
      if (!this.httpServer.listening) {
        resolveClose();
        return;
      }
      this.httpServer.close(() => resolveClose());
    });
  }

  async listSessions(): Promise<McpSessionInfo[]> {
    const sessions: McpSessionInfo[] = [];
    for (const session of this.sessions.values()) {
      try {
        const result = await this.invokeOnSession(session, "state.get", {}, 4_000);
        const state = result.output as {
          phase?: string;
          media?: { name?: string };
        } | undefined;
        if (state) {
          session.info = {
            ...session.info,
            phase: state.phase,
            mediaName: state.media?.name
          };
        }
      } catch {
        // Keep the last known info if the page is busy.
      }
      sessions.push({ ...session.info });
    }
    return sessions;
  }

  async attachSession(sessionId: string): Promise<McpSessionInfo | null> {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    this.activeSessionId = sessionId;
    return { ...session.info };
  }

  async listSources(): Promise<McpSourceInfo[]> {
    return this.options.broker.list(this.baseUrl);
  }

  async invoke(action: ActionId, params: unknown): Promise<InvokeResult> {
    const session = this.currentSession();
    return this.invokeOnSession(session, action, params, 30_000);
  }

  private currentSession(): Session {
    if (this.activeSessionId) {
      const active = this.sessions.get(this.activeSessionId);
      if (active) return active;
    }
    const first = this.sessions.values().next().value as Session | undefined;
    if (!first) {
      throw new PlayerError("SESSION_CLOSED", "no browser session is connected");
    }
    this.activeSessionId = first.sessionId;
    return first;
  }

  private async invokeOnSession(
    session: Session,
    action: ActionId,
    rawParams: unknown,
    timeoutMs: number
  ): Promise<InvokeResult> {
    const params = await this.resolveSourceId(action, rawParams);
    const id = `mcp-${++this.requestSeq}`;
    return new Promise<InvokeResult>((resolveResult, reject) => {
      const timer = setTimeout(() => {
        session.pending.delete(id);
        reject(new PlayerError("TIMEOUT", `page did not answer ${action} in time`));
      }, timeoutMs);
      session.pending.set(id, {
        resolve: (result) => {
          clearTimeout(timer);
          resolveResult(result);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
        timer
      });
      session.socket.send(
        JSON.stringify({
          type: "request",
          id,
          action,
          params,
          expectedRevision: undefined
        })
      );
    });
  }

  private async resolveSourceId(action: ActionId, rawParams: unknown): Promise<unknown> {
    if (action !== "media.open" || !rawParams || typeof rawParams !== "object") return rawParams;
    const params = rawParams as { source?: { kind?: string; sourceId?: string; name?: string } };
    if (params.source?.kind !== "sourceId") return rawParams;
    const sourceId = params.source.sourceId;
    if (!sourceId) throw new PlayerError("INVALID_REQUEST", "sourceId is required");
    const media = await this.options.broker.resolve(sourceId);
    if (!media) {
      throw new PlayerError("SOURCE_NOT_AUTHORIZED", `source is not authorized: ${sourceId}`);
    }
    return {
      ...params,
      source: {
        kind: "url",
        url: `${this.baseUrl}/broker/media?path=${encodeURIComponent(sourceId)}`,
        name: params.source.name ?? media.name,
        sizeBytes: media.size
      }
    };
  }

  private async handleHttp(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (!this.validHost(request)) {
        sendText(response, 403, "invalid host");
        return;
      }
      const url = new URL(request.url ?? "/", this.baseUrl || "http://127.0.0.1");
      if (url.pathname === "/health") {
        sendJson(response, 200, { ok: true, sessions: this.sessions.size });
        return;
      }
      if (url.pathname === "/api/bootstrap") {
        if (!this.validOrigin(request)) {
          sendText(response, 403, "invalid origin");
          return;
        }
        const sessionId = `session-${randomBytes(8).toString("hex")}`;
        sendJson(
          response,
          200,
          {
            wsUrl: `ws://${this.options.host}:${this.port}/control`,
            token: this.options.token,
            sessionId,
            brokerUrl: `${this.baseUrl}/broker/media`
          },
          { "Cache-Control": "no-store" }
        );
        return;
      }
      if (url.pathname === "/broker/media") {
        const sourceId = url.searchParams.get("path") ?? "";
        await this.options.broker.serve(request, response, sourceId);
        return;
      }
      await this.serveStatic(url.pathname, response);
    } catch (error) {
      sendText(response, 500, error instanceof Error ? error.message : "internal error");
    }
  }

  private async serveStatic(pathname: string, response: ServerResponse): Promise<void> {
    const root = await realpath(this.options.webRoot).catch(() => null);
    if (!root) {
      sendText(response, 503, "web build is missing; run pnpm build");
      return;
    }
    let relativePath = decodeURIComponent(pathname);
    if (relativePath === "/" || relativePath === "") relativePath = "/index.html";
    if (!extname(relativePath)) relativePath = "/index.html";
    const candidate = resolve(root, "." + relativePath);
    if (!candidate.startsWith(root + sep) && candidate !== root) {
      sendText(response, 403, "invalid path");
      return;
    }
    const real = await realpath(candidate).catch(() => null);
    if (!real || (real !== root && !real.startsWith(root + sep))) {
      sendText(response, 404, "not found");
      return;
    }
    const info = await stat(real).catch(() => null);
    if (!info || !info.isFile()) {
      sendText(response, 404, "not found");
      return;
    }
    const content = await readFile(real);
    const extension = extname(real).toLowerCase();
    response.writeHead(200, {
      ...SECURITY_HEADERS,
      "Content-Type": MIME[extension] ?? "application/octet-stream",
      "Content-Length": String(content.length),
      "Cache-Control": extension === ".html" ? "no-store" : "public, max-age=31536000, immutable"
    });
    response.end(content);
  }

  private async handleUpgrade(
    request: IncomingMessage,
    socket: import("node:stream").Duplex,
    head: Buffer
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.baseUrl || "http://127.0.0.1");
    if (url.pathname !== "/control") {
      socket.destroy();
      return;
    }
    if (!this.validOrigin(request) || !tokenMatches(this.options.token, url.searchParams.get("token"))) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    this.wss.handleUpgrade(request, socket, head, (ws) => {
      this.handleConnection(ws);
    });
  }

  private handleConnection(socket: WebSocket): void {
    let session: Session | null = null;
    const helloTimer = setTimeout(() => {
      if (!session) socket.close(1008, "hello timeout");
    }, 5_000);
    socket.on("message", (data) => {
      let message: ClientMessage;
      try {
        message = JSON.parse(data.toString()) as ClientMessage;
      } catch {
        socket.close(1003, "invalid JSON");
        return;
      }
      if (message.type === "hello") {
        if (session) return;
        if (!/^session-[a-zA-Z0-9-]+$/.test(message.sessionId)) {
          socket.close(1008, "invalid session");
          return;
        }
        clearTimeout(helloTimer);
        session = {
          sessionId: message.sessionId,
          socket,
          connectedAt: Date.now(),
          info: {
            sessionId: message.sessionId,
            title: message.state?.media?.name,
            mediaName: message.state?.media?.name,
            phase: message.state?.phase,
            connectedAt: Date.now()
          },
          pending: new Map()
        };
        this.sessions.set(message.sessionId, session);
        if (!this.activeSessionId) this.activeSessionId = message.sessionId;
        socket.send(JSON.stringify({ type: "welcome", sessionId: message.sessionId }));
        return;
      }
      if (message.type === "response" && session) {
        const pending = session.pending.get(message.id);
        if (!pending) return;
        session.pending.delete(message.id);
        pending.resolve(message.result);
      }
    });
    socket.on("close", () => {
      clearTimeout(helloTimer);
      if (!session) return;
      this.sessions.delete(session.sessionId);
      if (this.activeSessionId === session.sessionId) {
        this.activeSessionId = this.sessions.keys().next().value ?? null;
      }
      for (const pending of session.pending.values()) {
        pending.reject(new PlayerError("SESSION_CLOSED", "browser session disconnected"));
      }
      session.pending.clear();
    });
    socket.on("error", () => {
      socket.close();
    });
  }

  private get port(): number {
    const address = this.httpServer.address();
    return address && typeof address !== "string" ? address.port : this.options.port;
  }

  private validHost(request: IncomingMessage): boolean {
    const host = request.headers.host;
    if (!host) return false;
    const port = this.port;
    return new Set([
      `${this.options.host}:${port}`,
      `127.0.0.1:${port}`,
      `localhost:${port}`,
      `[::1]:${port}`
    ]).has(host);
  }

  private validOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    if (!origin) return true;
    const port = this.port;
    return new Set([
      `http://${this.options.host}:${port}`,
      `http://127.0.0.1:${port}`,
      `http://localhost:${port}`,
      `http://[::1]:${port}`
    ]).has(origin);
  }
}

function sendText(response: ServerResponse, status: number, text: string): void {
  response.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store"
  });
  response.end(text);
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {}
): void {
  const body = JSON.stringify(value);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": String(Buffer.byteLength(body)),
    "Cache-Control": "no-store",
    ...headers
  });
  response.end(body);
}
