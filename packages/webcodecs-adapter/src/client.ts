import { PlayerError } from "@wasm-player/contracts";
import type {
  AudioCodecConfig,
  AudioDecoderRequest,
  AudioDecoderResponse,
  VideoCodecConfig,
  VideoDecoderRequest,
  VideoDecoderResponse
} from "./protocol";

interface Pending<T> {
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}

function timeoutError(label: string): PlayerError {
  return new PlayerError("TIMEOUT", `${label} timed out`);
}

export interface VideoFrameEvent {
  frame: VideoFrame;
  epoch: number;
}

export class VideoDecoderWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending<unknown>>();
  private nextId = 1;
  private frameHandler: ((event: VideoFrameEvent) => void) | null = null;
  private errorHandler: ((error: PlayerError) => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<VideoDecoderResponse>) => {
      const message = event.data;
      if (message.type === "frame") {
        this.frameHandler?.({ frame: message.frame, epoch: message.epoch });
        return;
      }
      if (message.type === "error") {
        if (message.requestId !== undefined) {
          const pending = this.pending.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            pending.reject(
              new PlayerError(message.error.code, message.error.message, { recoverable: true })
            );
          }
          return;
        }
        this.errorHandler?.(
          new PlayerError(message.error.code, message.error.message, { recoverable: true })
        );
        return;
      }
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (requestId === undefined) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (message.type === "configured") {
        pending.resolve({ supported: message.supported, reason: message.reason });
      } else {
        pending.resolve(message);
      }
    };
    this.worker.onerror = (event) => {
      this.rejectAll(new PlayerError("INTERNAL", event.message || "video decoder worker crashed"));
    };
  }

  setFrameHandler(handler: (event: VideoFrameEvent) => void): void {
    this.frameHandler = handler;
  }

  setErrorHandler(handler: (error: PlayerError) => void): void {
    this.errorHandler = handler;
  }

  configure(
    config: VideoCodecConfig,
    epoch: number
  ): Promise<{ supported: boolean; reason?: string }> {
    return this.request(
      { type: "configure", requestId: 0, epoch, config },
      15_000
    ) as Promise<{ supported: boolean; reason?: string }>;
  }

  decode(packet: { data: ArrayBuffer; keyframe: boolean; ptsUs: number; durationUs: number }, epoch: number): void {
    const message: VideoDecoderRequest = {
      type: "decode",
      epoch,
      chunk: {
        type: packet.keyframe ? "key" : "delta",
        timestamp: packet.ptsUs,
        duration: packet.durationUs,
        data: packet.data
      }
    };
    this.worker.postMessage(message, [packet.data]);
  }

  flush(epoch: number): Promise<void> {
    return this.request({ type: "flush", requestId: 0, epoch }, 15_000).then(() => undefined);
  }

  reset(epoch: number): Promise<void> {
    return this.request({ type: "reset", requestId: 0, epoch }, 10_000).then(() => undefined);
  }

  async close(): Promise<void> {
    try {
      await this.request({ type: "close", requestId: 0 }, 10_000);
    } finally {
      this.worker.terminate();
    }
  }

  terminate(): void {
    this.worker.terminate();
    this.rejectAll(new PlayerError("CANCELLED", "video decoder terminated"));
  }

  private request(message: VideoDecoderRequest, timeoutMs: number): Promise<unknown> {
    const requestId = this.nextId;
    this.nextId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      reject(timeoutError("video decoder request"));
    }, timeoutMs);
    this.pending.set(requestId, { resolve, reject, timer });
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

export interface PcmEvent {
  epoch: number;
  timestampUs: number;
  sampleRate: number;
  numberOfFrames: number;
  channels: Float32Array[];
}

export class AudioDecoderWorkerClient {
  private readonly worker: Worker;
  private readonly pending = new Map<number, Pending<unknown>>();
  private nextId = 1;
  private pcmHandler: ((event: PcmEvent) => void) | null = null;
  private errorHandler: ((error: PlayerError) => void) | null = null;

  constructor(worker: Worker) {
    this.worker = worker;
    this.worker.onmessage = (event: MessageEvent<AudioDecoderResponse>) => {
      const message = event.data;
      if (message.type === "pcm") {
        this.pcmHandler?.({
          epoch: message.epoch,
          timestampUs: message.timestampUs,
          sampleRate: message.sampleRate,
          numberOfFrames: message.numberOfFrames,
          channels: message.channels.map((buffer) => new Float32Array(buffer))
        });
        return;
      }
      if (message.type === "error") {
        if (message.requestId !== undefined) {
          const pending = this.pending.get(message.requestId);
          if (pending) {
            clearTimeout(pending.timer);
            this.pending.delete(message.requestId);
            pending.reject(
              new PlayerError(message.error.code, message.error.message, { recoverable: true })
            );
          }
          return;
        }
        this.errorHandler?.(
          new PlayerError(message.error.code, message.error.message, { recoverable: true })
        );
        return;
      }
      const requestId = "requestId" in message ? message.requestId : undefined;
      if (requestId === undefined) return;
      const pending = this.pending.get(requestId);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(requestId);
      if (message.type === "configured") {
        pending.resolve({ supported: message.supported, reason: message.reason });
      } else {
        pending.resolve(message);
      }
    };
    this.worker.onerror = (event) => {
      this.rejectAll(new PlayerError("INTERNAL", event.message || "audio decoder worker crashed"));
    };
  }

  setPcmHandler(handler: (event: PcmEvent) => void): void {
    this.pcmHandler = handler;
  }

  setErrorHandler(handler: (error: PlayerError) => void): void {
    this.errorHandler = handler;
  }

  configure(
    config: AudioCodecConfig,
    epoch: number
  ): Promise<{ supported: boolean; reason?: string }> {
    return this.request(
      { type: "configure", requestId: 0, epoch, config },
      15_000
    ) as Promise<{ supported: boolean; reason?: string }>;
  }

  decode(packet: { data: ArrayBuffer; ptsUs: number; durationUs: number }, epoch: number): void {
    const message: AudioDecoderRequest = {
      type: "decode",
      epoch,
      chunk: {
        type: "key",
        timestamp: packet.ptsUs,
        duration: packet.durationUs,
        data: packet.data
      }
    };
    this.worker.postMessage(message, [packet.data]);
  }

  flush(epoch: number): Promise<void> {
    return this.request({ type: "flush", requestId: 0, epoch }, 15_000).then(() => undefined);
  }

  reset(epoch: number): Promise<void> {
    return this.request({ type: "reset", requestId: 0, epoch }, 10_000).then(() => undefined);
  }

  async close(): Promise<void> {
    try {
      await this.request({ type: "close", requestId: 0 }, 10_000);
    } finally {
      this.worker.terminate();
    }
  }

  terminate(): void {
    this.worker.terminate();
    this.rejectAll(new PlayerError("CANCELLED", "audio decoder terminated"));
  }

  private request(message: AudioDecoderRequest, timeoutMs: number): Promise<unknown> {
    const requestId = this.nextId;
    this.nextId += 1;
    const { promise, resolve, reject } = Promise.withResolvers<unknown>();
    const timer = setTimeout(() => {
      this.pending.delete(requestId);
      reject(timeoutError("audio decoder request"));
    }, timeoutMs);
    this.pending.set(requestId, { resolve, reject, timer });
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

export function createVideoDecoderWorker(): VideoDecoderWorkerClient {
  return new VideoDecoderWorkerClient(
    new Worker(new URL("./video-decoder.worker.ts", import.meta.url), {
      type: "module",
      name: "video-decoder"
    })
  );
}

export function createAudioDecoderWorker(): AudioDecoderWorkerClient {
  return new AudioDecoderWorkerClient(
    new Worker(new URL("./audio-decoder.worker.ts", import.meta.url), {
      type: "module",
      name: "audio-decoder"
    })
  );
}
