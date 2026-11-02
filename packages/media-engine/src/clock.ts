/**
 * Media clock used for A/V scheduling. When audio exists, the audio-consumed
 * sample count anchors the clock; without audio, the same class can be driven
 * by the monotonic context clock. All media times are integer microseconds.
 */
export type ClockSource = "audio" | "monotonic";

export interface ClockAnchor {
  mediaTimeUs: number;
  contextTimeSec: number;
  rate: number;
  source: ClockSource;
}

export class MediaClock {
  private anchor: ClockAnchor;
  private playing = false;
  private frozenAtUs: number;

  constructor(source: ClockSource = "monotonic") {
    this.anchor = {
      mediaTimeUs: 0,
      contextTimeSec: 0,
      rate: 1,
      source
    };
    this.frozenAtUs = 0;
  }

  get source(): ClockSource {
    return this.anchor.source;
  }

  get rate(): number {
    return this.anchor.rate;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  getAnchor(): Readonly<ClockAnchor> {
    return { ...this.anchor };
  }

  /** Re-anchor at an exact audio consumption point or after a seek. */
  anchorAt(mediaTimeUs: number, contextTimeSec: number, rate = this.anchor.rate): void {
    this.anchor = {
      mediaTimeUs,
      contextTimeSec,
      rate,
      source: this.anchor.source
    };
    this.frozenAtUs = mediaTimeUs;
  }

  setSource(source: ClockSource, mediaTimeUs: number, contextTimeSec: number): void {
    this.anchor = {
      mediaTimeUs,
      contextTimeSec,
      rate: this.anchor.rate,
      source
    };
    this.frozenAtUs = mediaTimeUs;
  }

  play(contextTimeSec: number): void {
    if (this.playing) return;
    this.anchor = {
      ...this.anchor,
      mediaTimeUs: this.frozenAtUs,
      contextTimeSec
    };
    this.playing = true;
  }

  pause(contextTimeSec: number): void {
    if (!this.playing) return;
    this.frozenAtUs = this.now(contextTimeSec);
    this.playing = false;
  }

  setRate(rate: number, contextTimeSec: number): void {
    if (!Number.isFinite(rate) || rate <= 0) {
      throw new RangeError(`invalid rate: ${rate}`);
    }
    const current = this.now(contextTimeSec);
    this.anchor = {
      mediaTimeUs: current,
      contextTimeSec,
      rate,
      source: this.anchor.source
    };
    this.frozenAtUs = current;
  }

  seek(mediaTimeUs: number, contextTimeSec: number): void {
    this.anchorAt(mediaTimeUs, contextTimeSec);
  }

  /** Current media time; does not extrapolate while paused. */
  now(contextTimeSec: number): number {
    if (!this.playing) return this.frozenAtUs;
    const elapsedSec = Math.max(0, contextTimeSec - this.anchor.contextTimeSec);
    return Math.round(this.anchor.mediaTimeUs + elapsedSec * this.anchor.rate * 1_000_000);
  }

  /**
   * Re-anchor from a measured audio clock value, compensating for the callback
   * latency between audio consumption and the message reaching the main thread.
   */
  syncFromAudio(
    consumedMediaTimeUs: number,
    measuredAtContextSec: number,
    nowContextSec: number
  ): void {
    if (this.anchor.source !== "audio") return;
    if (!this.playing) {
      this.frozenAtUs = consumedMediaTimeUs;
      return;
    }
    const latencySec = Math.max(0, nowContextSec - measuredAtContextSec);
    const compensatedUs = Math.round(
      consumedMediaTimeUs + latencySec * this.anchor.rate * 1_000_000
    );
    this.anchor = {
      ...this.anchor,
      mediaTimeUs: compensatedUs,
      contextTimeSec: nowContextSec
    };
  }
}
