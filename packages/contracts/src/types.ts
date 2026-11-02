import type { PlayerErrorShape } from "./errors";

export const TRACK_TYPES = ["video", "audio", "subtitle"] as const;
export type TrackType = (typeof TRACK_TYPES)[number];

export const DECODE_PATHS = ["webcodecs", "wasm", "native"] as const;
export type DecodePath = (typeof DECODE_PATHS)[number];

export const PLAYER_PHASES = [
  "idle",
  "opening",
  "ready",
  "playing",
  "paused",
  "buffering",
  "seeking",
  "ended",
  "error",
  "disposed"
] as const;
export type PlayerPhase = (typeof PLAYER_PHASES)[number];

export const SOURCE_KINDS = ["file", "http", "sparse", "memory"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export interface ColorInfo {
  bitDepth?: number;
  pixelFormat?: string;
  range?: "tv" | "pc" | "unknown";
  matrix?: string;
  transfer?: string;
  primaries?: string;
  chromaSubsampling?: string;
  /** True when a field was inferred because the container omitted it. */
  inferred?: boolean;
}

export interface MediaStreamInfo {
  index: number;
  type: TrackType;
  codec: string;
  codecId: number;
  profile?: number;
  level?: number;
  width?: number;
  height?: number;
  sampleRate?: number;
  channels?: number;
  channelLayout?: string;
  language?: string;
  title?: string;
  default: boolean;
  forced: boolean;
  durationUs?: number;
  timeBase?: [number, number];
  color?: ColorInfo;
}

export interface TrackInfo extends MediaStreamInfo {
  id: string;
  selected: boolean;
  decodePath?: DecodePath;
  acceleration?: "hardware" | "software" | "unknown";
}

export interface ChapterInfo {
  index: number;
  title?: string;
  startUs: number;
  endUs?: number;
}

export interface AttachmentInfo {
  index: number;
  filename: string;
  mimeType?: string;
  sizeBytes: number;
}

export interface MediaInfo {
  sourceId: string;
  name: string;
  container?: string;
  sizeBytes: number;
  durationUs: number;
  seekable: boolean;
  sourceKind: SourceKind;
  etag?: string;
  lastModified?: string;
  streams: MediaStreamInfo[];
  chapters: ChapterInfo[];
  attachments: AttachmentInfo[];
  decodePaths: Record<string, DecodePath>;
  warnings: string[];
}

export interface SelectedTracks {
  video: number | null;
  audio: number | null;
  subtitle: number | null;
}

export interface PlaybackStats {
  decodedVideoFrames: number;
  renderedFrames: number;
  droppedVideoFrames: number;
  decodedAudioFrames: number;
  audioUnderruns: number;
  videoQueueFrames: number;
  videoQueueBytes: number;
  audioBufferMs: number;
  packetQueueBytes: number;
  lastDecodeError?: string;
}

export const EMPTY_STATS: PlaybackStats = {
  decodedVideoFrames: 0,
  renderedFrames: 0,
  droppedVideoFrames: 0,
  decodedAudioFrames: 0,
  audioUnderruns: 0,
  videoQueueFrames: 0,
  videoQueueBytes: 0,
  audioBufferMs: 0,
  packetQueueBytes: 0
};

export const CAPABILITIES = [
  "media.file",
  "media.http",
  "media.range",
  "media.seek",
  "media.large-file",
  "webcodecs.video",
  "webcodecs.audio",
  "wasm.demux",
  "wasm.decode.video",
  "wasm.decode.audio",
  "webgl2",
  "webgpu",
  "offscreen-canvas",
  "audio-worklet",
  "shared-array-buffer",
  "file-system-access",
  "fullscreen",
  "picture-in-picture",
  "subtitles.text",
  "subtitles.ass",
  "subtitles.bitmap",
  "host.pick-files",
  "host.save-file",
  "mcp.companion",
  "screenshot"
] as const;

export type CapabilityName = (typeof CAPABILITIES)[number];

export interface CapabilityState {
  available: boolean;
  reason?: string;
  details?: Record<string, unknown>;
}

export type CapabilityReport = Record<CapabilityName, CapabilityState>;

export interface PlayerSnapshot {
  sessionId: string;
  phase: PlayerPhase;
  revision: number;
  eventSeq: number;
  media: MediaInfo | null;
  tracks: TrackInfo[];
  selected: SelectedTracks;
  positionUs: number;
  durationUs: number;
  rate: number;
  volume: number;
  muted: boolean;
  buffering: boolean;
  settings: Record<string, EffectiveSettingsValue>;
  capabilities: CapabilityReport;
  error: PlayerErrorShape | null;
  stats: PlaybackStats;
  updatedAt: number;
}

export const SETTING_LAYERS = ["default", "global", "preset", "media", "session"] as const;
export type SettingLayer = (typeof SETTING_LAYERS)[number];

export interface EffectiveValue<T = unknown> {
  requested: T;
  effective: T;
  status: "applied" | "applying" | "failed" | "unsupported";
  layer: SettingLayer;
  reason?: string;
}

export type EffectiveSettingsValue = EffectiveValue;
