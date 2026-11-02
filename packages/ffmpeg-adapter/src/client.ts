import {
  PLAYER_ERROR_CODES,
  PlayerError,
  type PlayerErrorCode
} from "@wasm-player/contracts";
import type {
  DemuxRequest,
  DemuxResponse,
  ProbeResult,
  ReadResult,
  SeekResult,
  SerializedError,
  WorkerSource
} from "./protocol";

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function isPlayerErrorCode(code: string): code is PlayerErrorCode {
  return (PLAYER_ERROR_CODES as readonly string[]).includes(code);
}

function toPlayerError(error: SerializedError): PlayerError {
  return new PlayerError(
    isPlayerErrorCode(error.code) ? error.code : "INTERNAL",
    error.message,
    {
      recoverable: error.recoverable,
      details: error.details
    }
  );
}

export class DemuxWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, PendingRequest>();
  private nextRequestId = 1;
  private closed = false;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<DemuxResponse>) => {
      const message = event.data;
      if (message.type !== "result") return;
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.requestId);
      if (message.ok) pending.resolve(message.value);
      else pending.reject(toPlayerError(message.error));
    };
    this.worker.onerror = (event) => {
      const error = new PlayerError("INTERNAL", event.message || "demux worker crashed", {
        recoverable: true
      });
      this.rejectAll(error);
    };
    this.worker.onmessageerror = () => {
      this.rejectAll(
        new PlayerError("INTERNAL", "demux worker message could not be deserialized", {
          recoverable: true
        })
      );
    };
  }

  open(source: WorkerSource, options?: { name?: string; libavBase?: string }): Promise<ProbeResult> {
    return this.request<ProbeResult>(
      { type: "open", requestId: 0, source, options },
      30_000
    );
  }

  read(maxBytes = 512 * 1024, maxPackets = 256): Promise<ReadResult> {
    return this.request<ReadResult>(
      { type: "read", requestId: 0, maxBytes, maxPackets },
      15_000
    );
  }

  seek(positionUs: number): Promise<SeekResult> {
    return this.request<SeekResult>(
      { type: "seek", requestId: 0, positionUs },
      20_000
    );
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.request<{ closed: true }>({ type: "close", requestId: 0 }, 10_000);
    } finally {
      this.worker.terminate();
    }
  }

  terminate(): void {
    this.closed = true;
    this.worker.terminate();
    this.rejectAll(new PlayerError("CANCELLED", "demux worker terminated"));
  }

  private request<T>(message: DemuxRequest, timeoutMs: number): Promise<T> {
    if (this.closed) {
      return Promise.reject(new PlayerError("SESSION_CLOSED", "demux worker is closed"));
    }
    const requestId = this.nextRequestId;
    this.nextRequestId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<T>();
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      reject(new PlayerError("TIMEOUT", `demux request ${message.type} timed out`));
    }, timeoutMs);
    this.pending.set(requestId, {
      resolve: (value) => resolve(value as T),
      reject,
      timer
    });
    this.worker.postMessage({ ...message, requestId });
    return promise;
  }

  private rejectAll(error: unknown): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
