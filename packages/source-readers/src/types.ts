export type SourceErrorCode =
  | "SOURCE_NOT_SEEKABLE"
  | "SOURCE_CHANGED"
  | "SOURCE_NOT_AUTHORIZED"
  | "RANGE_NOT_SUPPORTED"
  | "READ_FAILED"
  | "CANCELLED"
  | "CLOSED"
  | "OUT_OF_RANGE"
  | "PROTOCOL_ERROR";

export class SourceError extends Error {
  readonly code: SourceErrorCode;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: SourceErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "SourceError";
    this.code = code;
    this.details = details;
  }
}

export type SourceKind = "file" | "http" | "sparse" | "memory";

export interface SourceCapabilities {
  kind: SourceKind;
  size: number;
  /** True when arbitrary offsets can be served without downloading the prefix. */
  randomAccess: boolean;
  /** True when the demuxer may seek. Independent of randomAccess in theory. */
  seekable: boolean;
  /** True when the transport honors HTTP Range requests. */
  rangeRequests: boolean;
  etag?: string;
  lastModified?: string;
  contentType?: string;
  reason?: string;
}

export interface SourceReader {
  getSize(): number;
  getCapabilities(): SourceCapabilities;
  readAt(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array>;
  cancel(reason?: string): void;
  close(): Promise<void>;
}

export function assertReadRange(offset: number, length: number): void {
  if (!Number.isSafeInteger(offset) || offset < 0) {
    throw new SourceError("OUT_OF_RANGE", `invalid offset: ${offset}`);
  }
  if (!Number.isSafeInteger(length) || length < 0) {
    throw new SourceError("OUT_OF_RANGE", `invalid length: ${length}`);
  }
}

export function combinedSignal(...signals: (AbortSignal | undefined)[]): {
  signal: AbortSignal;
  dispose: () => void;
} {
  const controller = new AbortController();
  const listeners: { signal: AbortSignal; listener: () => void }[] = [];
  for (const signal of signals) {
    if (!signal) continue;
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    listeners.push({ signal, listener });
  }
  return {
    signal: controller.signal,
    dispose: () => {
      for (const { signal, listener } of listeners) {
        signal.removeEventListener("abort", listener);
      }
    }
  };
}

export function abortedError(signal: AbortSignal): SourceError {
  return new SourceError("CANCELLED", "source read cancelled", {
    reason: signal.reason
  });
}
