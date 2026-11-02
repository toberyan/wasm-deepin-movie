import {
  SourceError,
  abortedError,
  assertReadRange,
  type SourceCapabilities,
  type SourceReader
} from "./types";

export interface FileSourceOptions {
  name?: string;
}

/**
 * Local File/Blob source. `Blob.slice()` gives random access without copying the
 * whole file into memory or MEMFS.
 */
export class FileSourceReader implements SourceReader {
  private readonly blob: Blob;
  private readonly name: string;
  private closed = false;
  private controller = new AbortController();
  private cancelReason: string | undefined;

  constructor(blob: Blob, options: FileSourceOptions = {}) {
    this.blob = blob;
    this.name = options.name ?? (blob instanceof File ? blob.name : "local-file");
  }

  getSize(): number {
    return this.blob.size;
  }

  getCapabilities(): SourceCapabilities {
    return {
      kind: "file",
      size: this.blob.size,
      randomAccess: true,
      seekable: true,
      rangeRequests: false
    };
  }

  async readAt(offset: number, length: number, signal?: AbortSignal): Promise<Uint8Array> {
    if (this.closed) throw new SourceError("CLOSED", `source ${this.name} is closed`);
    assertReadRange(offset, length);
    if (signal?.aborted) throw abortedError(signal);
    if (this.controller.signal.aborted) {
      throw new SourceError("CANCELLED", this.cancelReason ?? "source read cancelled");
    }
    if (offset >= this.blob.size || length === 0) return new Uint8Array(0);
    const end = Math.min(this.blob.size, offset + length);
    const buffer = await this.blob.slice(offset, end).arrayBuffer();
    if (signal?.aborted) throw abortedError(signal);
    return new Uint8Array(buffer);
  }

  cancel(reason = "cancelled"): void {
    this.cancelReason = reason;
    this.controller.abort(reason);
    this.controller = new AbortController();
  }

  async close(): Promise<void> {
    this.closed = true;
    this.controller.abort("closed");
  }
}
