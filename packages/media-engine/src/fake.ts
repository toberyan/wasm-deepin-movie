import {
  DEFAULT_SETTINGS,
  EMPTY_STATS,
  PlayerError,
  SETTING_DEFINITIONS,
  flattenSettingsPatch,
  type CapabilityReport,
  type EffectiveValue,
  type MediaInfo,
  type MediaStreamInfo,
  type PlaybackStats,
  type PlayerPhase,
  type SelectedTracks,
  type SettingId,
  type SettingsPatch,
  type TrackInfo,
  type TrackType
} from "@wasm-player/contracts";
import { allCapabilities } from "./capabilities";
import { MediaClock } from "./clock";
import type {
  CaptureOptions,
  CaptureResult,
  DiagnosticsReport,
  EngineEvent,
  EngineListener,
  EngineMediaSource,
  EngineSnapshot,
  MediaEngine,
  MediaOpenResult,
  OpenMediaRequest,
  RateResult,
  SeekResult,
  SettingsApplyResult,
  SubtitleLoadInput
} from "./port";

const SUPPORTED_SETTINGS = new Set<SettingId>([
  "video.brightness",
  "video.contrast",
  "video.saturation",
  "video.fit",
  "audio.volume",
  "audio.muted",
  "playback.rate",
  "subtitle.delayMs",
  "app.theme",
  "app.panel",
  "app.showStats"
]);

const FAKE_DURATION_US = 120_000_000;

function sourceName(source: EngineMediaSource): string {
  if (source.kind === "file") return source.name ?? "local-file";
  if (source.kind === "url") return source.name ?? new URL(source.url).pathname.split("/").pop() ?? "remote";
  return source.name ?? source.sourceId;
}

function fakeStreams(): MediaStreamInfo[] {
  return [
    {
      index: 0,
      type: "video",
      codec: "h264",
      codecId: 27,
      profile: 100,
      level: 30,
      width: 640,
      height: 360,
      default: true,
      forced: false,
      durationUs: FAKE_DURATION_US,
      timeBase: [1, 15360],
      color: { bitDepth: 8, pixelFormat: "yuv420p", range: "tv", matrix: "bt709", transfer: "bt709", primaries: "bt709" }
    },
    {
      index: 1,
      type: "audio",
      codec: "aac",
      codecId: 86018,
      profile: 1,
      sampleRate: 48000,
      channels: 2,
      default: true,
      forced: false,
      durationUs: FAKE_DURATION_US,
      timeBase: [1, 48000]
    }
  ];
}

function toTracks(streams: MediaStreamInfo[], selected: SelectedTracks): TrackInfo[] {
  return streams.map((stream) => {
    const track: TrackInfo = {
      ...stream,
      id: `${stream.type}:${stream.index}`,
      selected:
        (stream.type === "video" && selected.video === stream.index) ||
        (stream.type === "audio" && selected.audio === stream.index),
      decodePath: stream.type === "video" || stream.type === "audio" ? "webcodecs" : undefined,
      acceleration: "unknown"
    };
    if (stream.type === "subtitle") {
      delete track.decodePath;
      delete track.acceleration;
    }
    return track;
  });
}

/**
 * Test double for player-core unit tests and UI development. It is explicitly
 * not part of any gate: real media paths must use BrowserMediaEngine.
 */
export class FakeMediaEngine implements MediaEngine {
  readonly id = "fake";
  private phase: PlayerPhase = "idle";
  private media: MediaInfo | null = null;
  private streams: MediaStreamInfo[] = [];
  private selected: SelectedTracks = { video: null, audio: null, subtitle: null };
  private positionUs = 0;
  private durationUs = 0;
  private rate = 1;
  private volume = 1;
  private muted = false;
  private buffering = false;
  private stats: PlaybackStats = { ...EMPTY_STATS };
  private settings = new Map<SettingId, EffectiveValue>();
  private listeners = new Set<EngineListener>();
  private readonly clock = new MediaClock("monotonic");
  private disposed = false;

  async open(request: OpenMediaRequest): Promise<MediaOpenResult> {
    if (this.disposed) throw new PlayerError("SESSION_CLOSED", "engine disposed");
    this.emit({ type: "phase", phase: "opening", previous: this.phase });
    this.phase = "opening";
    const streams = fakeStreams();
    const media: MediaInfo = {
      sourceId: `fake:${sourceName(request.source)}`,
      name: sourceName(request.source),
      container: "mp4",
      sizeBytes: request.source.sizeBytes ?? 1024 * 1024,
      durationUs: FAKE_DURATION_US,
      seekable: true,
      sourceKind: request.source.kind === "url" ? "http" : request.source.kind === "sourceId" ? "memory" : "file",
      streams,
      chapters: [{ index: 0, title: "Chapter 1", startUs: 0, endUs: FAKE_DURATION_US }],
      attachments: [],
      decodePaths: { "video:0": "webcodecs", "audio:1": "webcodecs" },
      warnings: []
    };
    this.media = media;
    this.streams = streams;
    this.selected = { video: 0, audio: 1, subtitle: null };
    this.positionUs = request.startPositionUs ?? 0;
    this.durationUs = FAKE_DURATION_US;
    this.settings.clear();
    for (const id of SUPPORTED_SETTINGS) {
      const requested = DEFAULT_SETTINGS[id];
      this.settings.set(id, {
        requested,
        effective: requested,
        status: "applied",
        layer: "default"
      });
    }
    this.clock.seek(this.positionUs, 0);
    this.phase = "ready";
    this.emit({ type: "mediaOpened", media, tracks: this.getTracks() });
    this.emit({ type: "phase", phase: "ready", previous: "opening" });
    if (request.autoPlay) await this.play();
    return {
      media,
      tracks: this.getTracks(),
      selected: { ...this.selected },
      capabilities: this.getCapabilities(),
      warnings: []
    };
  }

  async close(): Promise<void> {
    if (this.media === null && this.phase === "idle") return;
    this.clock.pause(0);
    this.media = null;
    this.streams = [];
    this.selected = { video: null, audio: null, subtitle: null };
    this.positionUs = 0;
    this.durationUs = 0;
    this.phase = "idle";
    this.emit({ type: "mediaClosed" });
    this.emit({ type: "phase", phase: "idle", previous: "ready" });
  }

  async play(): Promise<void> {
    this.requireMedia();
    if (this.phase === "ended") {
      this.positionUs = 0;
      this.clock.seek(0, 0);
    }
    const previous = this.phase;
    this.phase = "playing";
    this.clock.play(0);
    this.emit({ type: "phase", phase: "playing", previous });
  }

  async pause(): Promise<void> {
    this.requireMedia();
    const previous = this.phase;
    this.clock.pause(0);
    this.phase = "paused";
    this.emit({ type: "phase", phase: "paused", previous });
  }

  async stop(): Promise<void> {
    this.requireMedia();
    this.clock.pause(0);
    this.positionUs = 0;
    this.clock.seek(0, 0);
    const previous = this.phase;
    this.phase = "paused";
    this.emit({ type: "position", positionUs: 0, durationUs: this.durationUs });
    this.emit({ type: "phase", phase: "paused", previous });
  }

  async seek(positionUs: number): Promise<SeekResult> {
    this.requireMedia();
    const requested = Math.min(Math.max(0, positionUs), this.durationUs);
    const previous = this.phase;
    this.phase = "seeking";
    this.emit({ type: "phase", phase: "seeking", previous });
    this.positionUs = requested;
    this.clock.seek(requested, 0);
    if (requested >= this.durationUs) {
      this.phase = "ended";
      this.emit({ type: "ended" });
    } else {
      this.phase = previous === "playing" ? "playing" : "paused";
    }
    this.emit({ type: "seeked", positionUs: requested, requestedUs: positionUs });
    this.emit({ type: "position", positionUs: requested, durationUs: this.durationUs });
    this.emit({ type: "phase", phase: this.phase, previous: "seeking" });
    return { positionUs: requested, requestedUs: positionUs, errorUs: requested - positionUs };
  }

  async step(frames: number, direction: "forward" | "backward" = "forward"): Promise<void> {
    this.requireMedia();
    if (this.phase === "playing") throw new PlayerError("INVALID_REQUEST", "step requires paused state");
    const frameUs = Math.round(1_000_000 / 30);
    const delta = frames * frameUs * (direction === "backward" ? -1 : 1);
    this.positionUs = Math.min(this.durationUs, Math.max(0, this.positionUs + delta));
    this.clock.seek(this.positionUs, 0);
    this.stats.decodedVideoFrames += frames;
    this.emit({ type: "position", positionUs: this.positionUs, durationUs: this.durationUs });
  }

  async setRate(rate: number): Promise<RateResult> {
    const effective = Math.min(4, Math.max(0.25, rate));
    this.rate = effective;
    this.clock.setRate(effective, 0);
    this.stats = { ...this.stats };
    return { requested: rate, effective, reason: effective === rate ? undefined : "clamped to supported range" };
  }

  async setVolume(volume: number, muted?: boolean): Promise<Record<string, EffectiveValue>> {
    const patch: SettingsPatch = { audio: { volume } };
    if (muted !== undefined) patch.audio = { ...patch.audio, muted };
    const result = await this.applySettings(patch, "session");
    return result.effective;
  }

  async selectTrack(type: TrackType, index: number): Promise<MediaOpenResult["tracks"]> {
    this.requireMedia();
    const stream = this.streams.find((candidate) => candidate.type === type && candidate.index === index);
    if (!stream) throw new PlayerError("INVALID_REQUEST", `track ${type}:${index} not found`);
    if (type === "video") this.selected.video = index;
    if (type === "audio") this.selected.audio = index;
    if (type === "subtitle") this.selected.subtitle = index;
    const tracks = this.getTracks();
    this.emit({ type: "trackChanged", tracks, selected: { ...this.selected } });
    return tracks;
  }

  async loadSubtitle(input: SubtitleLoadInput): Promise<MediaOpenResult["tracks"]> {
    this.requireMedia();
    const subtitleIndex = this.streams.filter((stream) => stream.type === "subtitle").length;
    const stream: MediaStreamInfo = {
      index: subtitleIndex,
      type: "subtitle",
      codec: input.format && input.format !== "auto" ? input.format : "srt",
      codecId: 0,
      title: input.name ?? "External subtitle",
      default: true,
      forced: false
    };
    this.streams = [...this.streams, stream];
    this.selected.subtitle = subtitleIndex;
    const tracks = this.getTracks();
    this.emit({ type: "trackChanged", tracks, selected: { ...this.selected } });
    return tracks;
  }

  async applySettings(
    patch: SettingsPatch,
    scope: "global" | "media" | "session" | "preset"
  ): Promise<SettingsApplyResult> {
    const flat = flattenSettingsPatch(patch);
    const effective: Record<string, EffectiveValue> = {};
    for (const [id, requested] of Object.entries(flat) as [SettingId, unknown][]) {
      if (SUPPORTED_SETTINGS.has(id)) {
        if (id === "playback.rate" && typeof requested === "number") {
          this.rate = requested;
        }
        if (id === "audio.volume" && typeof requested === "number") this.volume = requested;
        if (id === "audio.muted" && typeof requested === "boolean") this.muted = requested;
        const value: EffectiveValue = {
          requested,
          effective: requested,
          status: "applied",
          layer: scope
        };
        this.settings.set(id, value);
        effective[id] = value;
      } else {
        const definition = SETTING_DEFINITIONS[id];
        effective[id] = {
          requested,
          effective: DEFAULT_SETTINGS[id],
          status: "unsupported",
          layer: scope,
          reason: `not supported by fake engine (${definition.stage})`
        };
      }
    }
    this.emit({ type: "settingsApplied", effective });
    return { requested: patch, effective };
  }

  getSetting(id: SettingId): EffectiveValue | undefined {
    return this.settings.get(id);
  }

  async capture(options: CaptureOptions): Promise<CaptureResult> {
    this.requireMedia();
    if (options.format === "jpeg") {
      return {
        blob: new Blob([new Uint8Array([0xff, 0xd8, 0xff, 0xd9])], { type: "image/jpeg" }),
        width: 640,
        height: 360,
        capturedAtUs: this.positionUs,
        mimeType: "image/jpeg"
      };
    }
    return {
      blob: new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: "image/png" }),
      width: 640,
      height: 360,
      capturedAtUs: this.positionUs,
      mimeType: "image/png"
    };
  }

  getSnapshot(): EngineSnapshot {
    return {
      phase: this.phase,
      media: this.media,
      tracks: this.getTracks(),
      selected: { ...this.selected },
      positionUs: this.positionUs,
      durationUs: this.durationUs,
      rate: this.rate,
      volume: this.volume,
      muted: this.muted,
      buffering: this.buffering,
      stats: { ...this.stats },
      capabilities: this.getCapabilities(),
      decodePaths: this.media?.decodePaths ?? {},
      error: null
    };
  }

  getCapabilities(): CapabilityReport {
    return allCapabilities(true);
  }

  getDiagnostics(): DiagnosticsReport {
    return {
      sessionId: this.id,
      phase: this.phase,
      media: this.media,
      stats: { ...this.stats },
      capabilities: this.getCapabilities(),
      decodePaths: this.media?.decodePaths ?? {},
      queues: {},
      warnings: [],
      generatedAt: Date.now()
    };
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    this.listeners.clear();
    const previous = this.phase;
    this.phase = "disposed";
    this.emit({ type: "phase", phase: "disposed", previous });
  }

  private requireMedia(): void {
    if (this.media === null) throw new PlayerError("NEEDS_MEDIA", "no media is open");
  }

  private getTracks(): TrackInfo[] {
    return toTracks(this.streams, this.selected);
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
