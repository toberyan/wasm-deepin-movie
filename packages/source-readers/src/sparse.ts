import {
  SourceError,
  assertReadRange,
  type SourceCapabilities,
  type SourceReader
} from "./types";

/** In-memory source used for tiny fixtures and tests. */
export class MemorySourceReader implements SourceReader {
  private closed = false;

  constructor(
    private readonly data: Uint8Array,
    private readonly name = "memory"
  ) {}

  getSize(): number {
    return this.data.length;
  }

  getCapabilities(): SourceCapabilities {
    return {
      kind: "memory",
      size: this.data.length,
      randomAccess: true,
      seekable: true,
      rangeRequests: false
    };
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new SourceError("CLOSED", `source ${this.name} is closed`);
    assertReadRange(offset, length);
    if (offset >= this.data.length || length === 0) return new Uint8Array(0);
    return this.data.slice(offset, Math.min(this.data.length, offset + length));
  }

  cancel(): void {
    // No in-flight operation to cancel.
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/**
 * Virtual sparse source. It never allocates `size` bytes, which makes 6 GiB
 * offset/boundary tests practical on developer machines.
 */
export class SparseSourceReader implements SourceReader {
  private closed = false;

  constructor(
    private readonly size: number,
    private readonly fill?: (offset: number, target: Uint8Array) => void,
    private readonly name = "sparse"
  ) {
    if (!Number.isSafeInteger(size) || size < 0) {
      throw new RangeError(`invalid sparse size: ${size}`);
    }
  }

  getSize(): number {
    return this.size;
  }

  getCapabilities(): SourceCapabilities {
    return {
      kind: "sparse",
      size: this.size,
      randomAccess: true,
      seekable: true,
      rangeRequests: false
    };
  }

  async readAt(offset: number, length: number): Promise<Uint8Array> {
    if (this.closed) throw new SourceError("CLOSED", `source ${this.name} is closed`);
    assertReadRange(offset, length);
    if (offset >= this.size || length === 0) return new Uint8Array(0);
    const count = Math.min(this.size - offset, length);
    const target = new Uint8Array(count);
    if (this.fill) {
      this.fill(offset, target);
    } else {
      for (let i = 0; i < count; i += 1) {
        target[i] = ((offset + i) * 31 + 17) & 0xff;
      }
    }
    return target;
  }

  cancel(): void {
    // No in-flight operation to cancel.
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
