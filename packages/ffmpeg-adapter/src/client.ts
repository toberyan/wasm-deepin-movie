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

  open(
    source: WorkerSource,
    options?: {
      name?: string;
      libavBase?: string;
      libavVariant?: string;
      libavThreads?: "st" | "mt";
    }
  ): Promise<ProbeResult> {
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

  configureWasm(streamIndexes: number[]): Promise<number[]> {
    return this.request<number[]>(
      { type: "configure-wasm", requestId: 0, streamIndexes },
      20_000
    );
  }

  extractSubtitles(streamIndexes: number[]): Promise<import("./protocol").SubtitleExtractResult[]> {
    return this.request<import("./protocol").SubtitleExtractResult[]>(
      { type: "extract-subtitles", requestId: 0, streamIndexes },
      60_000
    );
  }

  extractAttachments(): Promise<import("./protocol").AttachmentExtractResult[]> {
    return this.request<import("./protocol").AttachmentExtractResult[]>(
      { type: "extract-attachments", requestId: 0 },
      30_000
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
    // Reject in-flight reads before posting close. A read can be waiting on a
    // blocked source; waiting for the close reply would leave it hanging until
    // terminate(). The close message is still sent so a healthy worker can
    // release FFmpeg resources, followed by terminate as a hard stop.
    const closedError = new PlayerError("SESSION_CLOSED", "demux worker closed");
    this.rejectAll(closedError);
    try {
      this.worker.postMessage({ type: "close", requestId: this.nextRequestId++ });
      await new Promise((resolve) => setTimeout(resolve, 50));
    } catch {
      // A worker that is already gone needs no close handshake.
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
