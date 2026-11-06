import type {
  CapabilityReport,
  DecodePath,
  EffectiveValue,
  MediaInfo,
  PlaybackStats,
  PlayerErrorShape,
  PlayerPhase,
  SelectedTracks,
  SettingId,
  SettingsPatch,
  TrackInfo,
  TrackType
} from "@wasm-player/contracts";

export type EngineMediaSource =
  | { kind: "file"; file: Blob; name?: string; sizeBytes?: number; identity?: string }
  | { kind: "url"; url: string; name?: string; headers?: Record<string, string>; sizeBytes?: number }
  | { kind: "sourceId"; sourceId: string; name?: string; sizeBytes?: number };

export interface OpenMediaRequest {
  source: EngineMediaSource;
  autoPlay?: boolean;
  startPositionUs?: number;
  forceDecodePath?: Partial<Record<TrackType, "webcodecs" | "wasm">>;
  preferredTracks?: Partial<Record<TrackType, number>>;
  preferCustomVariant?: boolean;
}

export interface MediaOpenResult {
  media: MediaInfo;
  tracks: TrackInfo[];
  selected: SelectedTracks;
  capabilities: CapabilityReport;
  warnings: string[];
}

export interface SeekResult {
  positionUs: number;
  requestedUs: number;
  errorUs: number;
}

export interface RateResult {
  requested: number;
  effective: number;
  reason?: string;
}

export interface SettingsApplyResult {
  requested: SettingsPatch;
  effective: Record<string, EffectiveValue>;
}

export interface CaptureOptions {
  includeSubtitles: boolean;
  includeOsd: boolean;
  format: "png" | "jpeg";
  quality?: number;
}

export interface CaptureResult {
  blob: Blob;
  width: number;
  height: number;
  capturedAtUs: number;
  mimeType: string;
}

export interface EngineSnapshot {
  phase: PlayerPhase;
  media: MediaInfo | null;
  tracks: TrackInfo[];
  selected: SelectedTracks;
  positionUs: number;
  durationUs: number;
  rate: number;
  volume: number;
  muted: boolean;
  buffering: boolean;
  stats: PlaybackStats;
  capabilities: CapabilityReport;
  decodePaths: Record<string, DecodePath>;
  error: PlayerErrorShape | null;
}

export type EngineEvent =
  | { type: "phase"; phase: PlayerPhase; previous: PlayerPhase }
  | { type: "position"; positionUs: number; durationUs: number }
  | { type: "buffering"; buffering: boolean; reason?: string }
  | { type: "trackChanged"; tracks: TrackInfo[]; selected: SelectedTracks }
  | { type: "decodePathChanged"; decodePaths: Record<string, DecodePath>; tracks: TrackInfo[] }
  | { type: "settingsApplied"; effective: Record<string, EffectiveValue> }
  | { type: "stats"; stats: PlaybackStats }
  | { type: "mediaOpened"; media: MediaInfo; tracks: TrackInfo[] }
  | { type: "mediaClosed" }
  | { type: "seeked"; positionUs: number; requestedUs: number }
  | { type: "ended" }
  | { type: "error"; error: PlayerErrorShape };

export type EngineListener = (event: EngineEvent) => void;

export interface DiagnosticsReport {
  sessionId: string;
  phase: string;
  media: MediaInfo | null;
  stats: PlaybackStats;
  capabilities: CapabilityReport;
  decodePaths: Record<string, DecodePath>;
  queues: Record<string, number>;
  warnings: string[];
  generatedAt: number;
}

export interface SubtitleLoadInput {
  file?: Blob;
  text?: string;
  url?: string;
  name?: string;
  encoding?: string;
  format?: "auto" | "srt" | "vtt" | "ass" | "ssa";
  trackIndex?: number;
  activate?: boolean;
}

export type StepDirection = "forward" | "backward";

export interface FrameSamplerInfo {
  durationUs: number;
  width: number;
  height: number;
  /** Video track the sampler decodes. */
  trackIndex: number;
}

export interface StoryboardSampleRequest {
  positionsUs: number[];
  columns: number;
  tileWidth: number;
  tileHeight: number;
  quality?: number;
  signal: AbortSignal;
  onProgress?: (completed: number, total: number) => void;
}

export interface FrameSampler {
  /** Opened and probed by the factory; describes the media it samples. */
  readonly info: FrameSamplerInfo;
  /** Composes the sampled frames into one image, honouring `signal`. */
  storyboard(request: StoryboardSampleRequest): Promise<{ blob: Blob; width: number; height: number }>;
  close(): Promise<void>;
}

/**
 * Opens an independent sampler for a source. It must not share state with the
 * playing engine, so sampling never seeks or pauses the main player.
 */
export type FrameSamplerFactory = (
  source: EngineMediaSource,
  options: { trackIndex?: number }
) => Promise<FrameSampler>;

/**
 * The only boundary player-core sees for media work. Implementations must not
 * leak FFmpeg pointers, WebCodecs objects or renderer details through it.
 */
export interface MediaEngine {
  readonly id: string;
  open(request: OpenMediaRequest): Promise<MediaOpenResult>;
  close(): Promise<void>;
  play(): Promise<void>;
  pause(): Promise<void>;
  stop(): Promise<void>;
  seek(positionUs: number): Promise<SeekResult>;
  step(frames: number, direction?: StepDirection): Promise<void>;
  setRate(rate: number): Promise<RateResult>;
  setVolume(volume: number, muted?: boolean): Promise<Record<string, EffectiveValue>>;
  selectTrack(type: TrackType, index: number): Promise<MediaOpenResult["tracks"]>;
  loadSubtitle(input: SubtitleLoadInput): Promise<MediaOpenResult["tracks"]>;
  applySettings(patch: SettingsPatch, scope: "global" | "media" | "session" | "preset"): Promise<SettingsApplyResult>;
  getSetting(id: SettingId): EffectiveValue | undefined;
  capture(options: CaptureOptions): Promise<CaptureResult>;
  getSnapshot(): EngineSnapshot;
  getCapabilities(): CapabilityReport;
  getDiagnostics(): DiagnosticsReport;
  subscribe(listener: EngineListener): () => void;
  dispose(): Promise<void>;
}

export type EngineSettingSupport = {
  supported: boolean;
  reason?: string;
  clamp?: (value: unknown) => unknown;
};
