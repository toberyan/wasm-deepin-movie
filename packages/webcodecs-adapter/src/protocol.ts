import type { PlayerErrorCode } from "@wasm-player/contracts";

export interface VideoCodecConfig {
  type: "video";
  codec: string;
  description?: ArrayBuffer;
  codedWidth?: number;
  codedHeight?: number;
  hardwareAcceleration?: "no-preference" | "prefer-hardware" | "prefer-software";
}

export interface AudioCodecConfig {
  type: "audio";
  codec: string;
  description?: ArrayBuffer;
  sampleRate?: number;
  numberOfChannels?: number;
}

export interface WorkerError {
  code: PlayerErrorCode;
  message: string;
}

export interface VideoDecoderRequestMap {
  configure: {
    type: "configure";
    requestId: number;
    epoch: number;
    config: VideoCodecConfig;
  };
  decode: {
    type: "decode";
    epoch: number;
    chunk: {
      type: "key" | "delta";
      timestamp: number;
      duration?: number;
      data: ArrayBuffer;
    };
  };
  flush: { type: "flush"; requestId: number; epoch: number };
  reset: { type: "reset"; requestId: number; epoch: number };
  close: { type: "close"; requestId: number };
}

export type VideoDecoderRequest = VideoDecoderRequestMap[keyof VideoDecoderRequestMap];

export type VideoDecoderResponse =
  | {
      type: "configured";
      requestId: number;
      supported: boolean;
      reason?: string;
    }
  | { type: "frame"; epoch: number; frame: VideoFrame }
  | { type: "flushed"; requestId: number; epoch: number }
  | { type: "reset"; requestId: number; epoch: number }
  | { type: "closed"; requestId: number }
  | { type: "error"; epoch?: number; requestId?: number; error: WorkerError };

export interface AudioDecoderRequestMap {
  configure: {
    type: "configure";
    requestId: number;
    epoch: number;
    config: AudioCodecConfig;
  };
  decode: {
    type: "decode";
    epoch: number;
    chunk: {
      type: "key" | "delta";
      timestamp: number;
      duration?: number;
      data: ArrayBuffer;
    };
  };
  flush: { type: "flush"; requestId: number; epoch: number };
  reset: { type: "reset"; requestId: number; epoch: number };
  close: { type: "close"; requestId: number };
}

export type AudioDecoderRequest = AudioDecoderRequestMap[keyof AudioDecoderRequestMap];

export type AudioDecoderResponse =
  | {
      type: "configured";
      requestId: number;
      supported: boolean;
      reason?: string;
    }
  | {
      type: "pcm";
      epoch: number;
      timestampUs: number;
      sampleRate: number;
      numberOfFrames: number;
      channels: ArrayBuffer[];
    }
  | { type: "flushed"; requestId: number; epoch: number }
  | { type: "reset"; requestId: number; epoch: number }
  | { type: "closed"; requestId: number }
  | { type: "error"; epoch?: number; requestId?: number; error: WorkerError };

export function toVideoDecoderConfig(config: VideoCodecConfig): VideoDecoderConfig {
  const init: VideoDecoderConfig = {
    codec: config.codec,
    optimizeForLatency: true
  };
  if (config.codedWidth !== undefined) init.codedWidth = config.codedWidth;
  if (config.codedHeight !== undefined) init.codedHeight = config.codedHeight;
  if (config.description !== undefined) init.description = config.description;
  if (config.hardwareAcceleration !== undefined) {
    init.hardwareAcceleration = config.hardwareAcceleration;
  }
  return init;
}

export function toAudioDecoderConfig(config: AudioCodecConfig): AudioDecoderConfig {
  const init: AudioDecoderConfig = {
    codec: config.codec,
    sampleRate: config.sampleRate ?? 48000,
    numberOfChannels: config.numberOfChannels ?? 2
  };
  if (config.description !== undefined) init.description = config.description;
  return init;
}

export async function probeVideoConfig(
  config: VideoCodecConfig
): Promise<{ supported: boolean; reason?: string }> {
  if (typeof VideoDecoder === "undefined") {
    return { supported: false, reason: "WebCodecs VideoDecoder is unavailable" };
  }
  try {
    const result = await VideoDecoder.isConfigSupported(toVideoDecoderConfig(config));
    if (result.supported) return { supported: true };
    return { supported: false, reason: `WebCodecs does not support ${config.codec}` };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}

export async function probeAudioConfig(
  config: AudioCodecConfig
): Promise<{ supported: boolean; reason?: string }> {
  if (typeof AudioDecoder === "undefined") {
    return { supported: false, reason: "WebCodecs AudioDecoder is unavailable" };
  }
  try {
    const result = await AudioDecoder.isConfigSupported(toAudioDecoderConfig(config));
    if (result.supported) return { supported: true };
    return { supported: false, reason: `WebCodecs does not support ${config.codec}` };
  } catch (error) {
    return {
      supported: false,
      reason: error instanceof Error ? error.message : String(error)
    };
  }
}
