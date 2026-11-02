export interface TimedFrame {
  /** Presentation timestamp in integer microseconds. */
  timestampUs: number;
  /** Duration in microseconds when known. */
  durationUs?: number;
  /** Accounted bytes for queue memory limits. */
  byteLength: number;
}

export interface FrameQueueLimits {
  maxFrames: number;
  maxBytes: number;
  maxDurationUs: number;
}

export interface FrameQueuePushResult<T> {
  dropped: T[];
  overLimit: boolean;
}

/**
 * Bounded presentation queue. It enforces frame count, byte size and duration
 * limits simultaneously, so 4K frames cannot silently consume the same number
 * of frames as 360p frames.
 */
export class VideoFrameQueue<T extends TimedFrame> {
  private frames: T[] = [];
  private bytes = 0;
  private droppedCount = 0;

  constructor(private readonly limits: FrameQueueLimits) {
    if (limits.maxFrames <= 0) throw new RangeError("maxFrames must be positive");
    if (limits.maxBytes <= 0) throw new RangeError("maxBytes must be positive");
  }

  get size(): number {
    return this.frames.length;
  }

  get byteLength(): number {
    return this.bytes;
  }

  get droppedFrames(): number {
    return this.droppedCount;
  }

  get durationUs(): number {
    const first = this.frames[0];
    const last = this.frames[this.frames.length - 1];
    if (!first || !last) return 0;
    return Math.max(0, last.timestampUs + (last.durationUs ?? 0) - first.timestampUs);
  }

  push(frame: T): FrameQueuePushResult<T> {
    const dropped: T[] = [];
    this.frames.push(frame);
    this.bytes += frame.byteLength;
    this.frames.sort((a, b) => a.timestampUs - b.timestampUs);

    while (
      this.frames.length > this.limits.maxFrames ||
      this.bytes > this.limits.maxBytes ||
      this.durationUs > this.limits.maxDurationUs
    ) {
      const removed = this.frames.shift();
      if (!removed) break;
      this.bytes -= removed.byteLength;
      dropped.push(removed);
      this.droppedCount += 1;
      if (this.frames.length <= 1) break;
    }
    return { dropped, overLimit: dropped.length > 0 };
  }

  /**
   * Return the newest frame whose presentation time has arrived, dropping all
   * older frames. Returns undefined when the queue is empty or the head is in
   * the future.
   */
  takeDue(timeUs: number): T | undefined {
    let dueIndex = -1;
    for (let i = 0; i < this.frames.length; i += 1) {
      const frame = this.frames[i]!;
      if (frame.timestampUs <= timeUs) dueIndex = i;
      else break;
    }
    if (dueIndex < 0) return undefined;
    const due = this.frames[dueIndex]!;
    const expired = this.frames.slice(0, dueIndex);
    this.frames = this.frames.slice(dueIndex + 1);
    this.bytes -= due.byteLength;
    for (const frame of expired) {
      this.bytes -= frame.byteLength;
      this.droppedCount += 1;
    }
    return due;
  }

  peek(): T | undefined {
    return this.frames[0];
  }

  last(): T | undefined {
    return this.frames[this.frames.length - 1];
  }

  clear(): T[] {
    const removed = this.frames;
    this.frames = [];
    this.bytes = 0;
    return removed;
  }

  snapshot(): { frames: number; bytes: number; dropped: number; durationUs: number } {
    return {
      frames: this.size,
      bytes: this.byteLength,
      dropped: this.droppedFrames,
      durationUs: this.durationUs
    };
  }
}
