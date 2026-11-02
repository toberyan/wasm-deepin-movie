import { PlayerError } from "@wasm-player/contracts";
import { DemuxSession } from "./demux-session";
import type { DemuxRequest, DemuxResponse, SerializedError } from "./protocol";
import { SourceError } from "@wasm-player/source-readers";

interface WorkerScope {
  location: Location;
  onmessage: ((event: MessageEvent<DemuxRequest>) => void) | null;
  postMessage(message: DemuxResponse, transfer?: Transferable[]): void;
}

const scope = self as unknown as WorkerScope;
const params = new URL(scope.location.href).searchParams;
const libavBase = params.get("libavBase") ??
  (scope.location.origin !== "null" ? new URL("/libav/", scope.location.origin).href : undefined);
const session = new DemuxSession(libavBase ? { libavBase } : {});

function serializeError(error: unknown): SerializedError {
  if (error instanceof PlayerError) return error.toJSON();
  if (error instanceof SourceError) {
    return {
      code: "DECODE_FAILED",
      message: error.message,
      recoverable: true,
      details: { sourceCode: error.code, ...(error.details ?? {}) }
    };
  }
  if (error instanceof Error) {
    return {
      code: "INTERNAL",
      message: error.message,
      recoverable: false
    };
  }
  return {
    code: "INTERNAL",
    message: String(error),
    recoverable: false
  };
}

function transferablesFor(value: unknown): Transferable[] {
  if (!value || typeof value !== "object") return [];
  const packets = (value as { packets?: { data: ArrayBuffer }[] }).packets;
  if (!Array.isArray(packets)) return [];
  return packets.map((packet) => packet.data);
}

let queue: Promise<void> = Promise.resolve();

scope.onmessage = (event) => {
  const request = event.data;
  queue = queue.then(() => handle(request)).catch(() => undefined);
};

async function handle(request: DemuxRequest): Promise<void> {
  try {
    switch (request.type) {
      case "open": {
        if (request.options?.libavBase) session.setLibavBase(request.options.libavBase);
        const value = await session.open(request.source, request.options);
        scope.postMessage({ type: "result", requestId: request.requestId, ok: true, value });
        return;
      }
      case "read": {
        const value = await session.read(request.maxBytes, request.maxPackets);
        scope.postMessage(
          { type: "result", requestId: request.requestId, ok: true, value },
          transferablesFor(value)
        );
        return;
      }
      case "seek": {
        const value = await session.seek(request.positionUs);
        scope.postMessage(
          { type: "result", requestId: request.requestId, ok: true, value },
          transferablesFor(value)
        );
        return;
      }
      case "close": {
        await session.close();
        scope.postMessage({
          type: "result",
          requestId: request.requestId,
          ok: true,
          value: { closed: true }
        });
        return;
      }
    }
  } catch (error) {
    scope.postMessage({
      type: "result",
      requestId: request.requestId,
      ok: false,
      error: serializeError(error)
    });
  }
}
