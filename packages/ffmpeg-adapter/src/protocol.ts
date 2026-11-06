import type { MediaInfo, PlayerErrorCode, TrackInfo } from "@wasm-player/contracts";
import type { SourceCapabilities } from "@wasm-player/source-readers";

export type WorkerSource =
  | { kind: "file"; file: File; name?: string; sizeBytes?: number; identity?: string }
  | { kind: "url"; url: string; name?: string; headers?: Record<string, string>; sizeBytes?: number };

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

export type CodecConfig = VideoCodecConfig | AudioCodecConfig;

export interface StreamRouteCandidate {
  index: number;
  type: "video" | "audio";
  codec: string;
  webcodecs: boolean;
  wasm: boolean;
  reason?: string;
}

export interface ProbeResult {
  media: MediaInfo;
  tracks: TrackInfo[];
  configs: Record<number, CodecConfig>;
  routes: StreamRouteCandidate[];
  sourceCapabilities: SourceCapabilities;
  warnings: string[];
}

export interface DemuxPacket {
  streamIndex: number;
  streamType: "video" | "audio";
  data: ArrayBuffer;
  ptsUs: number;
  dtsUs: number;
  durationUs: number;
  keyframe: boolean;
  timeBase: [number, number];
}

export interface WasmVideoFrame {
  streamIndex: number;
  data: ArrayBuffer;
  width: number;
  height: number;
  timestampUs: number;
  durationUs: number;
}

export interface WasmAudioChunk {
  streamIndex: number;
  timestampUs: number;
  sampleRate: number;
  numberOfFrames: number;
  channels: ArrayBuffer[];
}

export interface SubtitlePacket {
  data: ArrayBuffer;
  ptsUs: number;
  durationUs: number;
}

export interface AttachmentExtractResult {
  filename: string;
  mimeType?: string;
  data: ArrayBuffer;
}

export interface SubtitleExtractResult {
  streamIndex: number;
  codec: string;
  extradata?: ArrayBuffer;
  packets: SubtitlePacket[];
}

export interface ReadResult {
  packets: DemuxPacket[];
  bytes: number;
  eof: boolean;
  eagain: boolean;
  wasmVideoFrames: WasmVideoFrame[];
  wasmAudioChunks: WasmAudioChunk[];
}

export interface SeekResult {
  requestedUs: number;
  positionUs: number;
  errorUs: number;
  packets: DemuxPacket[];
  eof: boolean;
  wasmVideoFrames: WasmVideoFrame[];
  wasmAudioChunks: WasmAudioChunk[];
}

export interface SerializedError {
  code: PlayerErrorCode;
  message: string;
  recoverable?: boolean;
  details?: Record<string, unknown>;
}

export type DemuxRequest =
  | {
      type: "open";
      requestId: number;
      source: WorkerSource;
      options?: {
        name?: string;
        libavBase?: string;
        libavVariant?: string;
        libavThreads?: "st" | "mt";
      };
    }
  | {
      type: "read";
      requestId: number;
      maxBytes?: number;
      maxPackets?: number;
    }
  | {
      type: "seek";
      requestId: number;
      positionUs: number;
    }
  | {
      type: "configure-wasm";
      requestId: number;
      streamIndexes: number[];
    }
  | {
      type: "extract-subtitles";
      requestId: number;
      streamIndexes: number[];
    }
  | {
      type: "extract-attachments";
      requestId: number;
    }
  | {
      type: "close";
      requestId: number;
    };

export type DemuxResponse =
  | {
      type: "result";
      requestId: number;
      ok: true;
      value: unknown;
    }
  | {
      type: "result";
      requestId: number;
      ok: false;
      error: SerializedError;
    };

export type DemuxResult =
  | { kind: "open"; value: ProbeResult }
  | { kind: "read"; value: ReadResult }
  | { kind: "seek"; value: SeekResult }
  | { kind: "close"; value: { closed: true } };
