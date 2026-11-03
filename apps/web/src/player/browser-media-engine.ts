import {
  DEFAULT_SETTINGS,
  EMPTY_STATS,
  PlayerError,
  flattenSettingsPatch,
  type CapabilityReport,
  type DecodePath,
  type EffectiveValue,
  type MediaInfo,
  type MediaStreamInfo,
  type PlaybackStats,
  type PlayerErrorShape,
  type PlayerPhase,
  type SelectedTracks,
  type SettingId,
  type SettingScope,
  type SettingsPatch,
  type TrackInfo,
  type TrackType
} from "@wasm-player/contracts";
import {
  MediaClock,
  VideoFrameQueue,
  capabilityReport,
  routeTracks,
  type CodecSupport,
  type DiagnosticsReport,
  type EngineEvent,
  type EngineListener,
  type EngineMediaSource,
  type EngineSnapshot,
  type CaptureOptions,
  type CaptureResult,
  type MediaEngine,
  type MediaOpenResult,
  type OpenMediaRequest,
  type RateResult,
  type SeekResult,
  type SettingsApplyResult,
  type SubtitleLoadInput
} from "@wasm-player/media-engine";
import {
  DemuxWorkerClient,
  type DemuxPacket,
  type ProbeResult,
  type WasmAudioChunk,
  type WasmVideoFrame
} from "@wasm-player/ffmpeg-adapter";
import {
  createAudioDecoderWorker,
  createVideoDecoderWorker,
  probeAudioConfig,
  probeVideoConfig,
  type AudioDecoderWorkerClient,
  type PcmEvent,
  type VideoDecoderWorkerClient,
  type VideoFrameEvent
} from "@wasm-player/webcodecs-adapter";
import {
  WebGL2Renderer,
  type CropRect,
  type FitMode,
  type RotationDeg,
  type ScaleMode
} from "@wasm-player/renderer";
import { AudioOutput } from "@wasm-player/audio";
import JASSUB from "jassub";
import jassubWorkerUrl from "jassub/dist/worker/worker.js?worker&url";
import jassubWasmUrl from "jassub/dist/wasm/jassub-worker.wasm?url";
import jassubModernWasmUrl from "jassub/dist/wasm/jassub-worker-modern.wasm?url";
import jassubDefaultFontUrl from "jassub/dist/default.woff2?url";
import {
  SubtitleOverlay,
  SubtitleTrack,
  decodeSubtitleBytes,
  parseSubtitles
} from "@wasm-player/subtitles";

interface QueuedVideoFrame {
  frame: VideoFrame;
  timestampUs: number;
  durationUs: number;
  byteLength: number;
}

export interface BrowserMediaEngineOptions {
  canvas: HTMLCanvasElement;
  overlayContainer: HTMLElement;
  libavBase?: string;
  libavVariant?: string;
  libavThreads?: "st" | "mt";
  onLog?: (message: string, details?: unknown) => void;
}

const VIDEO_QUEUE_LIMITS = {
  maxFrames: 64,
  maxBytes: 64 * 1024 * 1024,
  maxDurationUs: 2_000_000
};
const VIDEO_QUEUE_TARGET_FRAMES = 24;

function nowSeconds(): number {
  return performance.now() / 1000;
}

function mediaSourceName(source: EngineMediaSource): string {
  if (source.name) return source.name;
  if (source.kind === "file") {
    return source.file instanceof File ? source.file.name : "local-file";
  }
  if (source.kind === "url") {
    try {
      return new URL(source.url).pathname.split("/").pop() || "remote";
    } catch {
      return "remote";
    }
  }
  return source.sourceId;
}

const LEGACY_CONTAINER_EXTENSIONS = new Set([
  "avi",
  "flv",
  "ts",
  "m2ts",
  "mts",
  "mpg",
  "mpeg",
  "vob",
  "wmv",
  "asf",
  "rm",
  "rmvb",
  "ogm",
  "mp3",
  "aac"
]);

function isLegacyContainer(name: string): boolean {
  const extension = name.split(".").pop()?.toLowerCase();
  return extension !== undefined && LEGACY_CONTAINER_EXTENSIONS.has(extension);
}

function toWorkerSource(source: EngineMediaSource): {
  kind: "file" | "url";
  file?: File;
  url?: string;
  name?: string;
  headers?: Record<string, string>;
  sizeBytes?: number;
} {
  if (source.kind === "file") {
    const workerSource: {
      kind: "file";
      file: File;
      name?: string;
      sizeBytes?: number;
    } = { kind: "file", file: source.file as File };
    if (source.name !== undefined) workerSource.name = source.name;
    if (source.sizeBytes !== undefined) workerSource.sizeBytes = source.sizeBytes;
    return workerSource;
  }
  if (source.kind === "url") {
    const workerSource: {
      kind: "url";
      url: string;
      name?: string;
      headers?: Record<string, string>;
      sizeBytes?: number;
    } = { kind: "url", url: source.url };
    if (source.name !== undefined) workerSource.name = source.name;
    if (source.headers !== undefined) workerSource.headers = source.headers;
    if (source.sizeBytes !== undefined) workerSource.sizeBytes = source.sizeBytes;
    return workerSource;
  }
  throw new PlayerError("UNSUPPORTED", "sourceId requires an authorized host broker");
}

function settingDefault<T>(id: SettingId): T {
  return DEFAULT_SETTINGS[id] as T;
}

export class BrowserMediaEngine implements MediaEngine {
  readonly id = "browser-webcodecs";
  private readonly canvas: HTMLCanvasElement;
  private readonly renderer: WebGL2Renderer;
  private readonly overlay: SubtitleOverlay;
  private readonly overlayContainer: HTMLElement;
  private assCanvas: HTMLCanvasElement;
  private assRenderer: JASSUB | null = null;
  private assTrackIndex: number | null = null;
  private assFontData: Uint8Array | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private readonly libavBase: string | undefined;
  private readonly libavVariant: string | undefined;
  private readonly libavThreads: "st" | "mt";
  private lastOpenRequest: OpenMediaRequest | null = null;
  private customVariantAvailable: boolean | null = null;
  private libavVariantUsed: string | undefined;
  private readonly onLog: ((message: string, details?: unknown) => void) | undefined;

  private phase: PlayerPhase = "idle";
  private media: MediaInfo | null = null;
  private tracks: TrackInfo[] = [];
  private selected: SelectedTracks = { video: null, audio: null, subtitle: null };
  private positionUs = 0;
  private durationUs = 0;
  private rate = 1;
  private volume = 1;
  private muted = false;
  private buffering = false;
  private stats: PlaybackStats = { ...EMPTY_STATS };
  private capabilities: CapabilityReport = capabilityReport({});
  private decodePaths: Record<string, DecodePath> = {};
  private error: PlayerErrorShape | null = null;
  private warnings: string[] = [];

  private demux: DemuxWorkerClient | null = null;
  private videoDecoder: VideoDecoderWorkerClient | null = null;
  private audioDecoder: AudioDecoderWorkerClient | null = null;
  private audioOutput: AudioOutput | null = null;
  private probe: ProbeResult | null = null;
  private videoTrack: TrackInfo | null = null;
  private audioTrack: TrackInfo | null = null;
  private videoWasm = false;
  private audioWasm = false;
  private previewFramePending = false;
  private videoQueue = new VideoFrameQueue<QueuedVideoFrame>(VIDEO_QUEUE_LIMITS);
  private readonly clock = new MediaClock("monotonic");
  private readonly settings = new Map<SettingId, EffectiveValue>();
  private readonly subtitleTracks = new Map<number, SubtitleTrack>();
  private nextSubtitleIndex = 10_000;

  private epoch = 0;
  private closed = true;
  private disposed = false;
  private pumping = false;
  private demuxEof = false;
  private decoderFlushed = false;
  private videoPacketsInFlight = 0;
  private seekTargetUs = 0;
  private audioBufferedUs = 0;
  private renderHandle: number | null = null;
  private lastPositionEmit = 0;
  private lastStatsEmit = 0;
  private lastSubtitleText = "";
  private readonly listeners = new Set<EngineListener>();

  constructor(options: BrowserMediaEngineOptions) {
    this.canvas = options.canvas;
    this.libavBase = options.libavBase;
    this.libavVariant = options.libavVariant;
    this.libavThreads = options.libavThreads ?? "st";
    this.onLog = options.onLog;
    this.renderer = new WebGL2Renderer(options.canvas);
    this.overlay = new SubtitleOverlay(options.overlayContainer);
    this.overlayContainer = options.overlayContainer;
    this.assCanvas = this.createAssCanvas();
    this.resizeObserver =
      typeof ResizeObserver !== "undefined"
        ? new ResizeObserver(() => this.syncCanvasSize())
        : null;
    this.resizeObserver?.observe(options.canvas);
    this.syncCanvasSize();
    this.capabilities = this.detectCapabilities();
  }

  async open(request: OpenMediaRequest): Promise<MediaOpenResult> {
    if (this.disposed) throw new PlayerError("SESSION_CLOSED", "engine is disposed");
    await this.close();
    this.closed = false;
    this.demuxEof = false;
    this.decoderFlushed = false;
    this.error = null;
    this.warnings = [];
    this.stats = { ...EMPTY_STATS };
    this.audioBufferedUs = 0;
    this.lastSubtitleText = "";
    this.previewFramePending = true;
    this.epoch += 1;
    const epoch = this.epoch;
    this.phase = "opening";
    this.emit({ type: "phase", phase: "opening", previous: "idle" });

    const workerSource = toWorkerSource(request.source);
    this.lastOpenRequest = request;
    const name = mediaSourceName(request.source);
    const preferCustom =
      this.libavVariant !== undefined ||
      (isLegacyContainer(name) && (await this.hasCustomVariant()));
    let variant = preferCustom ? this.libavVariant ?? "wasm-player-p0" : undefined;
    let probe: ProbeResult;
    let demux = this.createDemuxClient();
    this.demux = demux;
    try {
      probe = await demux.open(workerSource as Parameters<DemuxWorkerClient["open"]>[0], {
        name,
        ...(this.libavBase ? { libavBase: this.libavBase } : {}),
        ...(variant ? { libavVariant: variant } : {}),
        libavThreads: this.libavThreads
      });
    } catch (firstError) {
      const canFallback =
        variant === undefined &&
        this.libavVariant === undefined &&
        (await this.hasCustomVariant());
      if (!canFallback) {
        await this.close();
        throw firstError;
      }
      await demux.close().catch(() => demux.terminate());
      demux = this.createDemuxClient();
      this.demux = demux;
      variant = "wasm-player-p0";
      try {
        probe = await demux.open(workerSource as Parameters<DemuxWorkerClient["open"]>[0], {
          name,
          ...(this.libavBase ? { libavBase: this.libavBase } : {}),
          libavVariant: variant,
          libavThreads: this.libavThreads
        });
      } catch (secondError) {
        await this.close();
        throw secondError;
      }
    }
    this.libavVariantUsed = variant;
    this.probe = probe;
    try {
      this.media = structuredClone(probe.media);
      this.durationUs = probe.media.durationUs;
      this.warnings = [...probe.warnings];
      this.capabilities = this.detectCapabilities();

      const support: Record<string, CodecSupport> = {};
      for (const route of probe.routes) {
        const key = `${route.type}:${route.index}`;
        const config = probe.configs[route.index];
        if (route.type === "video" && config?.type === "video") {
          const result = await probeVideoConfig(config);
          const entry: CodecSupport = { webcodecs: result.supported, wasm: route.wasm };
          if (result.reason !== undefined) entry.reason = result.reason;
          support[key] = entry;
        } else if (route.type === "audio" && config?.type === "audio") {
          const result = await probeAudioConfig(config);
          const entry: CodecSupport = { webcodecs: result.supported, wasm: route.wasm };
          if (result.reason !== undefined) entry.reason = result.reason;
          support[key] = entry;
        } else {
          const entry: CodecSupport = { webcodecs: false, wasm: route.wasm };
          if (route.reason !== undefined) entry.reason = route.reason;
          support[key] = entry;
        }
      }
      const routed = routeTracks(probe.media.streams, support, {
        force: request.forceDecodePath
      });
      const preferredVideo = request.preferredTracks?.video;
      const preferredAudio = request.preferredTracks?.audio;
      const videoTrack =
        (preferredVideo !== undefined
          ? probe.tracks.find((track) => track.type === "video" && track.index === preferredVideo)
          : undefined) ??
        probe.tracks.find((track) => track.type === "video" && track.default) ??
        probe.tracks.find((track) => track.type === "video") ?? null;
      const audioTrack =
        (preferredAudio !== undefined
          ? probe.tracks.find((track) => track.type === "audio" && track.index === preferredAudio)
          : undefined) ??
        probe.tracks.find((track) => track.type === "audio" && track.default) ??
        probe.tracks.find((track) => track.type === "audio") ?? null;

      let videoWasm = false;
      if (videoTrack) {
        const decision = routed.playbackTracks.find(
          (track) => track.type === "video" && track.index === videoTrack.index
        );
        if (!decision?.supported) {
          const reason = decision?.reason ?? "video decoder is unavailable";
          throw new PlayerError("UNSUPPORTED", reason);
        }
        if (decision.path === "wasm") {
          const configured = await demux.configureWasm([videoTrack.index]);
          if (!configured.includes(videoTrack.index)) {
            throw new PlayerError("UNSUPPORTED", "WASM video decoder could not be configured");
          }
          videoWasm = true;
        } else if (decision.path !== "webcodecs") {
          throw new PlayerError("UNSUPPORTED", decision.reason ?? "unknown video decode path");
        }
      }
      let selectedAudio = audioTrack;
      let audioWasm = false;
      if (audioTrack) {
        const decision = routed.playbackTracks.find(
          (track) => track.type === "audio" && track.index === audioTrack.index
        );
        if (!decision?.supported) {
          this.warnings.push(
            `audio track ${audioTrack.index} (${audioTrack.codec}) is unavailable: ${
              decision?.reason ?? "no WebCodecs audio route"
            }`
          );
          selectedAudio = null;
        } else if (decision.path === "wasm") {
          const configured = await demux.configureWasm([audioTrack.index]);
          if (configured.includes(audioTrack.index)) {
            audioWasm = true;
          } else {
            this.warnings.push("WASM audio decoder could not be configured");
            selectedAudio = null;
          }
        } else if (decision.path !== "webcodecs") {
          this.warnings.push(
            `audio track ${audioTrack.index} (${audioTrack.codec}) is unavailable: ${
              decision.reason ?? "unknown audio decode path"
            }`
          );
          selectedAudio = null;
        }
      }
      this.videoWasm = videoWasm;
      this.audioWasm = audioWasm;
      this.videoTrack = videoTrack;
      this.audioTrack = selectedAudio;
      this.decodePaths = routed.decodePaths;
      if (this.media) this.media.decodePaths = { ...routed.decodePaths };
      this.tracks = probe.tracks.map((track) => {
        const copy: TrackInfo = { ...track };
        const route = routed.decodePaths[`${track.type}:${track.index}`];
        if (route) copy.decodePath = route;
        copy.selected =
          (track.type === "video" && track.index === videoTrack?.index) ||
          (track.type === "audio" && track.index === selectedAudio?.index);
        return copy;
      });
      this.selected = {
        video: videoTrack?.index ?? null,
        audio: selectedAudio?.index ?? null,
        subtitle: null
      };

      if (videoTrack && !videoWasm) {
        const config = probe.configs[videoTrack.index];
        if (!config || config.type !== "video") {
          throw new PlayerError("UNSUPPORTED", "video track has no WebCodecs configuration");
        }
        this.videoDecoder = createVideoDecoderWorker();
        this.videoDecoder.setFrameHandler((event) => this.onVideoFrame(event));
        this.videoDecoder.setErrorHandler((error) => this.onDecodeError(error, this.epoch, "video"));
        const configured = await this.videoDecoder.configure(config, epoch);
        if (!configured.supported) {
          throw new PlayerError("UNSUPPORTED", configured.reason ?? "video decoder rejected the config");
        }
      }

      if (selectedAudio) {
        const config = probe.configs[selectedAudio.index];
        if (!audioWasm && config && config.type === "audio") {
          this.audioDecoder = createAudioDecoderWorker();
          this.audioDecoder.setPcmHandler((event) => this.onAudioPcm(event));
          this.audioDecoder.setErrorHandler((error) => this.onDecodeError(error, this.epoch, "audio"));
          const configured = await this.audioDecoder.configure(config, epoch);
          if (!configured.supported) {
            this.warnings.push(
              `audio decoder rejected the config: ${configured.reason ?? "unsupported"}`
            );
            await this.audioDecoder.close();
            this.audioDecoder = null;
            this.selected.audio = null;
            this.audioTrack = null;
            selectedAudio = null;
          }
        }
        if (selectedAudio) {
          const audioOutput = new AudioOutput({
            sampleRate: selectedAudio.sampleRate ?? 48000,
            channels: selectedAudio.channels ?? 2,
            capacitySeconds: 2
          });
          audioOutput.setUnderrunHandler(() => {
            this.stats.audioUnderruns += 1;
            this.buffering = true;
            this.emit({ type: "buffering", buffering: true, reason: "audio underrun" });
          });
          try {
            await audioOutput.start();
            audioOutput.setVolume(this.volume, this.muted);
            audioOutput.setGainDb(this.settingValue("audio.gainDb", 0));
            audioOutput.setBalance(this.settingValue("audio.balance", 0));
            audioOutput.setRate(this.rate);
            this.audioOutput = audioOutput;
          } catch (error) {
            this.warnings.push(
              `AudioWorklet unavailable: ${error instanceof Error ? error.message : String(error)}`
            );
            await audioOutput.close();
            await this.audioDecoder?.close();
            this.audioDecoder = null;
            this.selected.audio = null;
            this.audioTrack = null;
          }
        }
      }

      this.applyRenderSettings();
      this.applySubtitleSettings();
      this.clock.seek(0, nowSeconds());
      this.phase = "ready";
      this.emit({
        type: "mediaOpened",
        media: this.media,
        tracks: this.tracks
      });
      this.emit({ type: "phase", phase: "ready", previous: "opening" });
      this.scheduleRender();

      if (request.startPositionUs && request.startPositionUs > 0) {
        const seekResult = await this.seek(request.startPositionUs);
        this.positionUs = seekResult.positionUs;
      } else {
        this.seekTargetUs = 0;
      }
      this.startPump();
      if (videoTrack) await this.waitForFirstFrame(7000);
      if (request.autoPlay) await this.play();

      return {
        media: this.media!,
        tracks: this.tracks,
        selected: { ...this.selected },
        capabilities: this.capabilities,
        warnings: [...this.warnings]
      };
    } catch (error) {
      await this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.epoch += 1;
    this.phase = "idle";
    this.clock.pause(nowSeconds());
    if (this.renderHandle !== null) {
      cancelAnimationFrame(this.renderHandle);
      this.renderHandle = null;
    }
    this.audioOutput?.setPaused(true);
    await this.audioOutput?.close();
    this.audioOutput = null;
    await this.videoDecoder?.close().catch(() => undefined);
    this.videoDecoder = null;
    await this.audioDecoder?.close().catch(() => undefined);
    this.audioDecoder = null;
    await this.demux?.close().catch(() => undefined);
    this.demux = null;
    this.clearVideoQueue();
    this.videoPacketsInFlight = 0;
    this.media = null;
    this.probe = null;
    this.tracks = [];
    this.selected = { video: null, audio: null, subtitle: null };
    this.videoTrack = null;
    this.audioTrack = null;
    this.videoWasm = false;
    this.audioWasm = false;
    this.lastOpenRequest = null;
    this.libavVariantUsed = undefined;
    this.positionUs = 0;
    this.durationUs = 0;
    this.decodingStatsReset();
    this.audioBufferedUs = 0;
    this.demuxEof = false;
    this.decoderFlushed = false;
    this.error = null;
    await this.destroyAssRenderer();
    this.emit({ type: "mediaClosed" });
    this.emit({ type: "phase", phase: "idle", previous: "ready" });
  }

  async play(): Promise<void> {
    this.requireMedia();
    if (this.phase === "playing") return;
    if (this.phase === "ended") await this.seek(0);
    const now = nowSeconds();
    if (this.audioOutput) {
      try {
        await this.audioOutput.resume();
      } catch (error) {
        this.clock.pause(now);
        throw error;
      }
      this.audioOutput.setPaused(false);
      this.audioOutput.setRate(this.rate);
      this.clock.setSource("audio", this.positionUs, now);
    } else {
      this.clock.setSource("monotonic", this.positionUs, now);
    }
    this.clock.play(now);
    const previous = this.phase;
    this.phase = "playing";
    this.buffering = false;
    this.startPump();
    this.scheduleRender();
    this.emit({ type: "phase", phase: "playing", previous });
  }

  async pause(): Promise<void> {
    this.requireMedia();
    if (this.phase !== "playing") {
      if (this.phase !== "paused") {
        const previous = this.phase;
        this.phase = "paused";
        this.emit({ type: "phase", phase: "paused", previous });
      }
      return;
    }
    const now = nowSeconds();
    this.positionUs = this.currentMediaTime(now);
    this.clock.pause(now);
    this.audioOutput?.setPaused(true);
    const previous = this.phase;
    this.phase = "paused";
    this.emit({ type: "position", positionUs: this.positionUs, durationUs: this.durationUs });
    this.emit({ type: "phase", phase: "paused", previous });
  }

  async stop(): Promise<void> {
    await this.pause();
    await this.seek(0);
    this.phase = "paused";
    this.emit({ type: "position", positionUs: 0, durationUs: this.durationUs });
  }

  async seek(positionUs: number): Promise<SeekResult> {
    this.requireMedia();
    if (!this.demux) throw new PlayerError("NEEDS_MEDIA", "demux session is missing");
    const target = Math.min(Math.max(0, positionUs), this.durationUs);
    const wasPlaying = this.phase === "playing";
    const now = nowSeconds();
    this.epoch += 1;
    const epoch = this.epoch;
    const previous = this.phase;
    this.phase = "seeking";
    this.clock.pause(now);
    this.audioOutput?.setPaused(true);
    this.audioOutput?.flush();
    this.clearVideoQueue();
    this.videoPacketsInFlight = 0;
    this.audioBufferedUs = 0;
    this.seekTargetUs = target;
    this.previewFramePending = true;
    this.demuxEof = false;
    this.decoderFlushed = false;
    await this.videoDecoder?.reset(epoch);
    await this.audioDecoder?.reset(epoch);
    this.emit({ type: "phase", phase: "seeking", previous });

    const result = await this.demux.seek(target);
    // Keyframe seeking can land before the requested target. Presentation is
    // anchored at the requested time and pre-target frames/PCM are dropped, so
    // paused seeks still show the target frame and playing seeks resume there.
    this.positionUs = target;
    this.clock.seek(target, now);
    this.feedPackets(result.packets, epoch);
    this.processWasmOutput(result, epoch);
    if (wasPlaying) {
      this.audioOutput?.setPaused(false);
      this.clock.setSource(this.audioOutput ? "audio" : "monotonic", target, now);
      this.clock.play(now);
      this.phase = "playing";
    } else {
      this.phase = "paused";
    }
    const output = {
      requestedUs: target,
      positionUs: target,
      errorUs: 0,
      packets: result.packets,
      eof: result.eof
    };
    this.emit({ type: "seeked", positionUs: target, requestedUs: target });
    this.emit({ type: "position", positionUs: target, durationUs: this.durationUs });
    this.emit({ type: "phase", phase: this.phase, previous: "seeking" });
    this.startPump();
    return output;
  }

  async step(frames: number): Promise<void> {
    this.requireMedia();
    if (this.phase === "playing") await this.pause();
    const frameUs = this.videoTrack ? 1_000_000 / 30 : 33_333;
    const target = Math.min(this.durationUs, this.positionUs + frames * frameUs);
    await this.seek(target);
    await this.waitForFirstFrame(3000);
  }

  async setRate(rate: number): Promise<RateResult> {
    const effective = Math.min(4, Math.max(0.25, rate));
    const now = nowSeconds();
    this.positionUs = this.currentMediaTime(now);
    this.rate = effective;
    this.clock.setRate(effective, now);
    this.audioOutput?.setRate(effective);
    const value: EffectiveValue = {
      requested: rate,
      effective,
      status: "applied",
      layer: "session"
    };
    if (effective !== rate) value.reason = "clamped to the supported 0.25x–4x range";
    this.settings.set("playback.rate", value);
    return { requested: rate, effective, reason: value.reason };
  }

  async setVolume(volume: number, muted?: boolean): Promise<Record<string, EffectiveValue>> {
    this.volume = Math.min(1, Math.max(0, volume));
    if (muted !== undefined) this.muted = muted;
    this.audioOutput?.setVolume(this.volume, this.muted);
    const values: Record<string, EffectiveValue> = {
      "audio.volume": {
        requested: volume,
        effective: this.volume,
        status: "applied",
        layer: "session"
      },
      "audio.muted": {
        requested: this.muted,
        effective: this.muted,
        status: "applied",
        layer: "session"
      }
    };
    this.settings.set("audio.volume", values["audio.volume"]!);
    this.settings.set("audio.muted", values["audio.muted"]!);
    return values;
  }

  async selectTrack(type: TrackType, index: number): Promise<TrackInfo[]> {
    this.requireMedia();
    if (type === "subtitle") {
      if (!this.subtitleTracks.has(index)) {
        throw new PlayerError("UNSUPPORTED", `subtitle track ${index} is not loaded`);
      }
      this.selected.subtitle = index;
      this.lastSubtitleText = "";
      this.tracks = this.tracks.map((track) => ({
        ...track,
        selected: track.type === "subtitle" && track.index === index
      }));
      this.emit({
        type: "trackChanged",
        tracks: this.tracks,
        selected: { ...this.selected }
      });
      return this.tracks;
    }
    const current = type === "video" ? this.selected.video : this.selected.audio;
    if (current === index) return this.tracks;
    if (!this.tracks.some((track) => track.type === type && track.index === index)) {
      throw new PlayerError("UNSUPPORTED", `${type} track ${index} does not exist`);
    }
    const request = this.lastOpenRequest;
    if (!request) throw new PlayerError("INVALID_REQUEST", "no media is open");
    const wasPlaying = this.phase === "playing";
    const positionUs = this.currentMediaTime(nowSeconds());
    const preferredTracks: Partial<Record<"video" | "audio" | "subtitle", number>> = {
      ...request.preferredTracks
    };
    if (this.selected.video !== null) preferredTracks.video = this.selected.video;
    if (this.selected.audio !== null) preferredTracks.audio = this.selected.audio;
    preferredTracks[type] = index;
    await this.open({
      ...request,
      autoPlay: wasPlaying,
      startPositionUs: positionUs,
      preferredTracks
    });
    if (!wasPlaying) await this.pause();
    return this.tracks;
  }

  async loadSubtitle(input: SubtitleLoadInput): Promise<TrackInfo[]> {
    this.requireMedia();
    let bytes: Uint8Array;
    if (input.file) {
      bytes = new Uint8Array(await input.file.arrayBuffer());
    } else if (input.text !== undefined) {
      bytes = new TextEncoder().encode(input.text);
    } else if (input.url) {
      const response = await fetch(input.url);
      if (!response.ok) {
        throw new PlayerError("UNSUPPORTED", `subtitle fetch failed: HTTP ${response.status}`);
      }
      bytes = new Uint8Array(await response.arrayBuffer());
    } else {
      throw new PlayerError("INVALID_REQUEST", "subtitle needs a file, text or url");
    }
    const decoded = decodeSubtitleBytes(bytes, input.encoding);
    const parsed = parseSubtitles(decoded.text, input.format ?? "auto");
    const track = new SubtitleTrack(parsed);
    const index = this.nextSubtitleIndex;
    this.nextSubtitleIndex += 1;
    this.subtitleTracks.set(index, track);
    if (parsed.format === "ass" || parsed.format === "ssa") {
      try {
        await this.destroyAssRenderer();
        if (!this.assFontData) {
          const fontResponse = await fetch(jassubDefaultFontUrl);
          if (fontResponse.ok) {
            this.assFontData = new Uint8Array(await fontResponse.arrayBuffer());
          }
        }
        const renderer = new JASSUB({
          canvas: this.assCanvas,
          subContent: decoded.text,
          workerUrl: jassubWorkerUrl,
          wasmUrl: jassubWasmUrl,
          modernWasmUrl: jassubModernWasmUrl,
          fonts: this.assFontData ? [this.assFontData] : [],
          availableFonts: { "liberation sans": jassubDefaultFontUrl },
          defaultFont: "liberation sans",
          queryFonts: false,
          debug: false,
          prescaleFactor: 1
        });
        await renderer.ready;
        this.assRenderer = renderer;
        this.assTrackIndex = index;
      } catch (error) {
        this.warnings.push(
          `ASS renderer unavailable: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    const name = input.name ?? `External ${parsed.format.toUpperCase()}`;
    const language = decoded.encoding;
    const trackInfo: TrackInfo = {
      index,
      type: "subtitle",
      codec: parsed.format,
      codecId: 0,
      title: name,
      language,
      default: false,
      forced: false,
      id: `subtitle:${index}`,
      selected: true
    };
    if (this.media) {
      const streamInfo: MediaStreamInfo = {
        index,
        type: "subtitle",
        codec: parsed.format,
        codecId: 0,
        title: name,
        language,
        default: false,
        forced: false
      };
      this.media.streams = [...this.media.streams, streamInfo];
    }
    this.tracks = [
      ...this.tracks.map((candidate) => ({ ...candidate, selected: false })),
      trackInfo
    ];
    this.selected.subtitle = index;
    this.lastSubtitleText = "";
    if (parsed.format !== "ass" && parsed.format !== "ssa") {
      await this.destroyAssRenderer();
    }
    this.warnings.push(...decoded.warnings, ...parsed.warnings);
    this.emit({
      type: "trackChanged",
      tracks: this.tracks,
      selected: { ...this.selected }
    });
    return this.tracks;
  }

  async applySettings(
    patch: SettingsPatch,
    scope: SettingScope
  ): Promise<SettingsApplyResult> {
    const flat = flattenSettingsPatch(patch);
    const effective: Record<string, EffectiveValue> = {};
    for (const [id, requested] of Object.entries(flat) as [SettingId, unknown][]) {
      const value = await this.applySetting(id, requested, scope);
      this.settings.set(id, value);
      effective[id] = value;
    }
    this.applyRenderSettings();
    this.applySubtitleSettings();
    return { requested: patch, effective };
  }

  getSetting(id: SettingId): EffectiveValue | undefined {
    return this.settings.get(id);
  }

  async capture(options: CaptureOptions): Promise<CaptureResult> {
    this.requireMedia();
    const width = this.canvas.width;
    const height = this.canvas.height;
    let blob: Blob;
    if (!options.includeSubtitles && !options.includeOsd) {
      blob = await this.renderer.capture(options.format, options.quality);
    } else {
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw new PlayerError("INTERNAL", "2D canvas is unavailable");
      context.drawImage(this.canvas, 0, 0);
      if (options.includeSubtitles) this.drawSubtitlesToContext(context, width, height);
      if (options.includeOsd) this.drawOsdToContext(context, width, height);
      blob = await new Promise<Blob>((resolve, reject) => {
        canvas.toBlob(
          (result) => (result ? resolve(result) : reject(new Error("failed to encode screenshot"))),
          options.format === "jpeg" ? "image/jpeg" : "image/png",
          options.quality
        );
      });
    }
    return {
      blob,
      width,
      height,
      capturedAtUs: this.positionUs,
      mimeType: options.format === "jpeg" ? "image/jpeg" : "image/png"
    };
  }

  getSnapshot(): EngineSnapshot {
    return {
      phase: this.phase,
      media: this.media,
      tracks: this.tracks,
      selected: { ...this.selected },
      positionUs: this.positionUs,
      durationUs: this.durationUs,
      rate: this.rate,
      volume: this.volume,
      muted: this.muted,
      buffering: this.buffering,
      stats: { ...this.stats },
      capabilities: this.capabilities,
      decodePaths: this.decodePaths,
      error: this.error
    };
  }

  getCapabilities(): CapabilityReport {
    return this.capabilities;
  }

  getDiagnostics(): DiagnosticsReport {
    return {
      sessionId: this.id,
      phase: this.phase,
      media: this.media,
      stats: { ...this.stats },
      capabilities: this.capabilities,
      decodePaths: this.decodePaths,
      queues: {
        videoFrames: this.videoQueue.size,
        videoBytes: this.videoQueue.byteLength,
        audioBufferedUs: this.audioBufferedUs,
        droppedVideoFrames: this.videoQueue.droppedFrames
      },
      warnings: [...this.warnings],
      generatedAt: Date.now()
    };
  }

  subscribe(listener: EngineListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.close();
    this.disposed = true;
    this.listeners.clear();
    this.resizeObserver?.disconnect();
    await this.destroyAssRenderer();
    this.assCanvas.remove();
    this.renderer.destroy();
    this.overlay.destroy();
  }

  private async applySetting(
    id: SettingId,
    requested: unknown,
    scope: SettingScope
  ): Promise<EffectiveValue> {
    const applied = (effective: unknown = requested): EffectiveValue => ({
      requested,
      effective,
      status: "applied",
      layer: scope
    });
    const unsupported = (reason: string): EffectiveValue => ({
      requested,
      effective: settingDefault(id),
      status: "unsupported",
      layer: scope,
      reason
    });
    switch (id) {
      case "video.brightness":
      case "video.contrast":
      case "video.saturation":
      case "video.gamma":
      case "video.hueDeg":
      case "video.rotationDeg":
      case "video.crop":
      case "video.sharpness":
      case "video.fit":
        return applied();
      case "video.scaleMode":
        return {
          requested,
          effective: requested,
          status: "applied",
          layer: scope,
          reason:
            requested === "high-quality"
              ? "WebGL2 linear filtering with shader sharpening available"
              : "WebGL2 filtering"
        };
      case "audio.volume": {
        this.volume = requested as number;
        this.audioOutput?.setVolume(this.volume, this.muted);
        return applied();
      }
      case "audio.muted": {
        this.muted = requested as boolean;
        this.audioOutput?.setVolume(this.volume, this.muted);
        return applied();
      }
      case "subtitle.delayMs":
      case "subtitle.visible":
      case "subtitle.fontSizePct":
        return applied();
      case "subtitle.forceStyle":
        if (requested === false) return applied();
        return unsupported("ASS style override requires JASSUB and is P2");
      case "playback.rate": {
        const result = await this.setRate(requested as number);
        return {
          requested,
          effective: result.effective,
          status: "applied",
          layer: scope,
          reason: result.reason
        };
      }
      case "playback.loop":
      case "playback.autoPlay":
      case "playback.volumeStep":
        return applied();
      case "app.theme":
      case "app.reduceMotion":
      case "app.showStats":
      case "app.panel":
        return applied();
      case "audio.gainDb": {
        this.audioOutput?.setGainDb(requested as number);
        return applied();
      }
      case "audio.balance": {
        this.audioOutput?.setBalance(requested as number);
        return applied();
      }
      case "audio.delayMs":
        return unsupported("audio delay is P2");
      default:
        return unsupported("not implemented by the browser engine");
    }
  }

  private applyRenderSettings(): void {
    this.renderer.setSettings({
      brightness: this.settingValue("video.brightness", 0),
      contrast: this.settingValue("video.contrast", 1),
      saturation: this.settingValue("video.saturation", 1),
      gamma: this.settingValue("video.gamma", 1),
      hueDeg: this.settingValue("video.hueDeg", 0),
      rotationDeg: this.settingValue<RotationDeg>("video.rotationDeg", 0),
      crop: this.settingValue<CropRect>("video.crop", {
        left: 0,
        top: 0,
        right: 0,
        bottom: 0
      }),
      sharpness: this.settingValue("video.sharpness", 0),
      scaleMode: this.settingValue<ScaleMode>("video.scaleMode", "high-quality"),
      fit: this.settingValue<FitMode>("video.fit", "contain")
    });
  }

  private applySubtitleSettings(): void {
    this.overlay.setOptions({
      visible: this.settingValue("subtitle.visible", true),
      fontSizePct: this.settingValue("subtitle.fontSizePct", 100)
    });
  }

  private settingValue<T>(id: SettingId, fallback: T): T {
    const value = this.settings.get(id);
    if (value && value.status === "applied") return value.effective as T;
    return fallback;
  }

  private startPump(): void {
    if (this.pumping || this.closed || !this.demux) return;
    this.pumping = true;
    void this.pumpLoop().finally(() => {
      this.pumping = false;
    });
  }

  private async pumpLoop(): Promise<void> {
    while (!this.closed && !this.disposed) {
      if (!this.demux) return;
      const paused = this.phase !== "playing";
      const videoBudget = this.videoQueue.size + this.videoPacketsInFlight;
      const estimatedFrameBytes = this.videoTrack
        ? Math.max(1, (this.videoTrack.width ?? 640) * (this.videoTrack.height ?? 360) * 1.5)
        : 1;
      const maxInFlight = Math.max(
        2,
        Math.min(12, Math.floor(VIDEO_QUEUE_LIMITS.maxBytes / estimatedFrameBytes))
      );
      if (
        (paused && (videoBudget >= 8 || this.phase === "seeking")) ||
        (paused && !this.videoTrack && this.audioBufferedUs > 1_000_000) ||
        this.videoQueue.size >= VIDEO_QUEUE_TARGET_FRAMES ||
        this.videoQueue.byteLength >= VIDEO_QUEUE_LIMITS.maxBytes ||
        this.videoPacketsInFlight >= maxInFlight ||
        this.audioBufferedUs > 2_500_000
      ) {
        await new Promise((resolve) => setTimeout(resolve, 12));
        continue;
      }
      if (this.demuxEof) {
        await new Promise((resolve) => setTimeout(resolve, 20));
        continue;
      }
      const readEpoch = this.epoch;
      try {
        const result = await this.demux.read(128 * 1024, 8);
        if (this.closed) return;
        if (readEpoch !== this.epoch) continue;
        if (result.packets.length > 0) {
          this.feedPackets(result.packets, readEpoch);
          this.stats.packetQueueBytes = result.bytes;
        }
        if (result.wasmVideoFrames.length > 0 || result.wasmAudioChunks.length > 0) {
          this.processWasmOutput(result, readEpoch);
        }
        if (result.eof) {
          this.demuxEof = true;
          this.videoPacketsInFlight = 0;
          try {
            await this.videoDecoder?.flush(readEpoch);
            await this.audioDecoder?.flush(readEpoch);
          } catch {
            // A flush failure is reported by the decoder error callback.
          }
          this.decoderFlushed = true;
        } else if (result.eagain || result.packets.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      } catch (error) {
        if (this.closed) return;
        if (readEpoch !== this.epoch) continue;
        this.onEngineError(error);
        return;
      }
    }
  }

  private feedPackets(packets: DemuxPacket[], epoch: number): void {
    for (const packet of packets) {
      if (packet.streamType === "video" && this.videoTrack && packet.streamIndex === this.videoTrack.index) {
        this.videoPacketsInFlight += 1;
        this.videoDecoder?.decode(packet, epoch);
      } else if (
        packet.streamType === "audio" &&
        this.audioTrack &&
        packet.streamIndex === this.audioTrack.index
      ) {
        this.audioDecoder?.decode(packet, epoch);
      }
    }
  }

  private onVideoFrame(event: VideoFrameEvent): void {
    if (event.epoch !== this.epoch || this.closed) {
      event.frame.close();
      return;
    }
    this.videoPacketsInFlight = Math.max(0, this.videoPacketsInFlight - 1);
    const frame = event.frame;
    if (frame.timestamp < this.seekTargetUs - 1000) {
      frame.close();
      return;
    }
    this.stats.decodedVideoFrames += 1;
    let byteLength = 0;
    try {
      byteLength = frame.allocationSize();
    } catch {
      byteLength = frame.codedWidth * frame.codedHeight * 4;
    }
    const queued: QueuedVideoFrame = {
      frame,
      timestampUs: frame.timestamp,
      durationUs: frame.duration ?? 0,
      byteLength
    };
    const pushed = this.videoQueue.push(queued);
    for (const dropped of pushed.dropped) dropped.frame.close();
    this.stats.videoQueueFrames = this.videoQueue.size;
    this.stats.videoQueueBytes = this.videoQueue.byteLength;
    this.stats.droppedVideoFrames = this.videoQueue.droppedFrames;
  }

  private processWasmOutput(
    result: { wasmVideoFrames: WasmVideoFrame[]; wasmAudioChunks: WasmAudioChunk[] },
    epoch: number
  ): void {
    if (epoch !== this.epoch || this.closed) return;
    for (const item of result.wasmVideoFrames) {
      const frame = new VideoFrame(new Uint8ClampedArray(item.data), {
        format: "RGBA",
        codedWidth: item.width,
        codedHeight: item.height,
        timestamp: item.timestampUs,
        duration: item.durationUs > 0 ? item.durationUs : 33_333,
        layout: [{ offset: 0, stride: item.width * 4 }]
      });
      this.onVideoFrame({ frame, epoch });
    }
    for (const chunk of result.wasmAudioChunks) {
      const channels = chunk.channels.map((buffer) => new Float32Array(buffer));
      this.appendPcm(
        channels,
        chunk.timestampUs,
        chunk.sampleRate,
        chunk.numberOfFrames,
        epoch
      );
    }
  }

  private onAudioPcm(event: PcmEvent): void {
    if (event.epoch !== this.epoch || this.closed) return;
    this.appendPcm(event.channels, event.timestampUs, event.sampleRate, event.numberOfFrames, event.epoch);
  }

  private appendPcm(
    channels: Float32Array[],
    timestampUs: number,
    sampleRate: number,
    numberOfFrames: number,
    epoch: number
  ): void {
    if (epoch !== this.epoch || this.closed) return;
    const durationUs = (numberOfFrames / sampleRate) * 1_000_000;
    if (timestampUs + durationUs < this.seekTargetUs) return;
    this.audioOutput?.append(channels, timestampUs);
    this.stats.decodedAudioFrames += numberOfFrames;
    this.audioBufferedUs += durationUs;
    if (this.buffering) {
      this.buffering = false;
      this.emit({ type: "buffering", buffering: false });
    }
  }

  private onDecodeError(error: PlayerError, epoch: number, track: "video" | "audio"): void {
    if (epoch !== this.epoch || this.closed) return;
    this.onEngineError(
      new PlayerError(error.code, error.message, {
        recoverable: error.recoverable,
        details: { ...(error.details ?? {}), track }
      })
    );
  }

  private onEngineError(error: unknown): void {
    const playerError =
      error instanceof PlayerError
        ? error
        : new PlayerError("DECODE_FAILED", error instanceof Error ? error.message : String(error), {
            recoverable: true
          });
    this.error = playerError.toJSON();
    const previous = this.phase;
    this.phase = "error";
    this.emit({ type: "error", error: this.error });
    this.emit({ type: "phase", phase: "error", previous });
  }

  private scheduleRender(): void {
    if (this.renderHandle !== null || this.closed) return;
    this.renderHandle = requestAnimationFrame(this.renderLoop);
  }

  private readonly renderLoop = (): void => {
    this.renderHandle = null;
    if (this.closed || this.disposed) return;
    const now = nowSeconds();
    if (this.lastStatsEmit === 0) this.lastStatsEmit = now;
    const previousPosition = this.positionUs;
    const mediaTime = this.currentMediaTime(now);
    let due = this.videoQueue.takeDue(mediaTime);
    if (!due && this.previewFramePending && this.phase !== "playing") {
      due = this.videoQueue.takeFirst();
      if (due) this.previewFramePending = false;
    }
    if (due) {
      this.renderer.render(due.frame);
      due.frame.close();
      this.stats.renderedFrames += 1;
    }
    const clamped = Math.max(0, Math.min(this.durationUs, mediaTime));
    this.positionUs = clamped;
    this.updateSubtitleOverlay(mediaTime);
    if (mediaTime > this.seekTargetUs + 250_000) this.seekTargetUs = Number.NEGATIVE_INFINITY;
    if (this.phase === "playing") {
      const elapsedUs = Math.max(0, (now - this.lastStatsEmit) * 1_000_000);
      if (elapsedUs > 0) {
        this.audioBufferedUs = Math.max(0, this.audioBufferedUs - elapsedUs * this.rate);
      }
    }
    this.stats.videoQueueFrames = this.videoQueue.size;
    this.stats.videoQueueBytes = this.videoQueue.byteLength;
    this.stats.audioBufferMs = this.audioBufferedUs / 1000;
    if (now - this.lastPositionEmit > 0.2 || Math.abs(this.positionUs - previousPosition) > 250_000) {
      this.lastPositionEmit = now;
      this.emit({ type: "position", positionUs: this.positionUs, durationUs: this.durationUs });
    }
    if (now - this.lastStatsEmit > 0.5) {
      this.lastStatsEmit = now;
      this.emit({ type: "stats", stats: { ...this.stats } });
    }
    if (this.shouldEnd()) {
      this.phase = "ended";
      this.clock.pause(now);
      this.audioOutput?.setPaused(true);
      this.emit({ type: "ended" });
      this.emit({ type: "phase", phase: "ended", previous: "playing" });
    }
    this.renderHandle = requestAnimationFrame(this.renderLoop);
  };

  private currentMediaTime(now: number): number {
    if (this.phase === "playing" && this.audioOutput?.isStarted) {
      const clock = this.audioOutput.getClock();
      if (clock) return clock.mediaTimeUs;
    }
    return this.clock.now(now);
  }

  private shouldEnd(): boolean {
    if (this.phase !== "playing") return false;
    if (!this.demuxEof || !this.decoderFlushed) return false;
    if (this.videoQueue.size > 0) return false;
    if (this.audioBufferedUs > 80_000) return false;
    return this.positionUs >= Math.max(0, this.durationUs - 200_000);
  }

  private updateSubtitleOverlay(mediaTimeUs: number): void {
    const index = this.selected.subtitle;
    const visible = this.settingValue("subtitle.visible", true);
    const delay = this.settingValue("subtitle.delayMs", 0);
    if (index === null) {
      if (this.lastSubtitleText !== "") {
        this.lastSubtitleText = "";
        this.overlay.clear();
      }
      if (this.assRenderer) this.assCanvas.style.display = "none";
      return;
    }
    if (index === this.assTrackIndex && this.assRenderer) {
      if (this.lastSubtitleText !== "") {
        this.lastSubtitleText = "";
        this.overlay.clear();
      }
      if (!visible) {
        this.assCanvas.style.display = "none";
        return;
      }
      this.assCanvas.style.display = "block";
      void this.assRenderer.manualRender({
        expectedDisplayTime: performance.now(),
        width: this.canvas.width,
        height: this.canvas.height,
        mediaTime: mediaTimeUs / 1_000_000 - delay / 1000
      });
      return;
    }
    this.assCanvas.style.display = "none";
    const track = this.subtitleTracks.get(index);
    if (!track) return;
    const cues = track.getActive(mediaTimeUs, delay);
    const text = cues.map((cue) => cue.text).join("\n");
    if (text !== this.lastSubtitleText) {
      this.lastSubtitleText = text;
      this.overlay.update(cues);
    }
  }

  private createAssCanvas(): HTMLCanvasElement {
    const canvas = document.createElement("canvas");
    canvas.className = "ass-subtitle-canvas";
    this.overlayContainer.appendChild(canvas);
    return canvas;
  }

  private async destroyAssRenderer(): Promise<void> {
    const renderer = this.assRenderer;
    this.assRenderer = null;
    this.assTrackIndex = null;
    if (renderer) {
      await renderer.destroy().catch(() => undefined);
      this.assCanvas.remove();
      this.assCanvas = this.createAssCanvas();
    }
  }

  private drawSubtitlesToContext(
    context: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    const index = this.selected.subtitle;
    if (index === null) return;
    const track = this.subtitleTracks.get(index);
    if (!track) return;
    const delay = this.settingValue("subtitle.delayMs", 0);
    const cues = track.getActive(this.positionUs, delay);
    if (cues.length === 0) return;
    const fontSize = Math.round(height * 0.045 * (this.settingValue("subtitle.fontSizePct", 100) / 100));
    context.save();
    context.font = `${fontSize}px sans-serif`;
    context.textAlign = "center";
    context.textBaseline = "bottom";
    context.fillStyle = "#ffffff";
    context.strokeStyle = "rgba(0,0,0,0.9)";
    context.lineWidth = Math.max(2, fontSize / 12);
    const lines = cues.flatMap((cue) => cue.text.split("\n"));
    lines.forEach((line, lineIndex) => {
      const y = height - fontSize * (lines.length - lineIndex) - height * 0.04;
      context.strokeText(line, width / 2, y);
      context.fillText(line, width / 2, y);
    });
    context.restore();
  }

  private drawOsdToContext(
    context: CanvasRenderingContext2D,
    width: number,
    height: number
  ): void {
    const fontSize = Math.round(height * 0.025);
    context.save();
    context.font = `${fontSize}px monospace`;
    context.textAlign = "left";
    context.textBaseline = "top";
    context.fillStyle = "rgba(0,0,0,0.6)";
    context.fillRect(0, 0, width * 0.5, fontSize * 4.2);
    context.fillStyle = "#ffffff";
    const lines = [
      `phase: ${this.phase}`,
      `pos: ${(this.positionUs / 1_000_000).toFixed(2)}s / ${(this.durationUs / 1_000_000).toFixed(2)}s`,
      `queue: ${this.videoQueue.size} frames / ${(this.videoQueue.byteLength / 1024 / 1024).toFixed(1)} MiB`,
      `paths: ${Object.entries(this.decodePaths).map(([key, value]) => `${key}=${value}`).join(" ")}`
    ];
    lines.forEach((line, index) => {
      context.fillText(line, fontSize, fontSize * (index + 0.4));
    });
    context.restore();
  }

  private async waitForFirstFrame(timeoutMs: number): Promise<void> {
    const deadline = performance.now() + timeoutMs;
    while (this.videoQueue.size === 0 && this.stats.renderedFrames === 0) {
      if (this.closed) throw new PlayerError("CANCELLED", "media closed while opening");
      if (performance.now() >= deadline) {
        throw new PlayerError("TIMEOUT", "timed out waiting for the first video frame", {
          recoverable: true
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private clearVideoQueue(): void {
    for (const queued of this.videoQueue.clear()) queued.frame.close();
    this.stats.videoQueueFrames = 0;
    this.stats.videoQueueBytes = 0;
  }

  private decodingStatsReset(): void {
    this.stats = { ...EMPTY_STATS };
  }

  private detectCapabilities(): CapabilityReport {
    const hasWebCodecsVideo = typeof VideoDecoder !== "undefined";
    const hasWebCodecsAudio = typeof AudioDecoder !== "undefined";
    const hasAudioWorklet =
      typeof AudioContext !== "undefined" && "audioWorklet" in AudioContext.prototype;
    const hasScreenshot = true;
    const routes = this.probe?.routes ?? [];
    const caps = capabilityReport({
      "media.file": true,
      "media.http": true,
      "media.range": this.probe?.sourceCapabilities.rangeRequests ?? false,
      "media.seek": this.probe?.sourceCapabilities.seekable ?? false,
      "media.large-file": true,
      "webcodecs.video": hasWebCodecsVideo,
      "webcodecs.audio": hasWebCodecsAudio,
      "wasm.demux": true,
      "wasm.decode.video": routes.some((route) => route.type === "video" && route.wasm),
      "wasm.decode.audio": routes.some((route) => route.type === "audio" && route.wasm),
      "webgl2": this.renderer !== null,
      "webgpu": typeof navigator !== "undefined" && "gpu" in navigator,
      "offscreen-canvas": typeof OffscreenCanvas !== "undefined",
      "audio-worklet": hasAudioWorklet,
      "shared-array-buffer":
        typeof SharedArrayBuffer !== "undefined" &&
        typeof crossOriginIsolated !== "undefined" &&
        crossOriginIsolated,
      "file-system-access":
        typeof window !== "undefined" && "showOpenFilePicker" in window,
      fullscreen: typeof document !== "undefined" && document.fullscreenEnabled,
      "picture-in-picture":
        typeof document !== "undefined" && "pictureInPictureEnabled" in document
          ? document.pictureInPictureEnabled
          : false,
      "subtitles.text": true,
      "subtitles.ass": true,
      "subtitles.bitmap": false,
      "host.pick-files": true,
      "host.save-file": true,
      "mcp.companion": false,
      screenshot: hasScreenshot
    });
    return caps;
  }

  private createDemuxClient(): DemuxWorkerClient {
    const worker = new Worker(new URL("../workers/demux.worker.ts", import.meta.url), {
      type: "module",
      name: "demux"
    });
    return new DemuxWorkerClient(worker);
  }

  private async hasCustomVariant(): Promise<boolean> {
    if (this.customVariantAvailable !== null) return this.customVariantAvailable;
    try {
      const base = new URL(this.libavBase ?? "/libav/", window.location.href).href;
      const response = await fetch(new URL("libav-wasm-player-p0.mjs", base), {
        method: "HEAD",
        cache: "no-store"
      });
      this.customVariantAvailable = response.ok;
    } catch {
      this.customVariantAvailable = false;
    }
    return this.customVariantAvailable;
  }

  private syncCanvasSize(): void {
    const width = this.canvas.clientWidth || this.canvas.width || 640;
    const height = this.canvas.clientHeight || this.canvas.height || 360;
    const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
    this.renderer.resize(width, height, dpr);
  }

  private requireMedia(): void {
    if (!this.media) throw new PlayerError("NEEDS_MEDIA", "no media is open");
  }

  private emit(event: EngineEvent): void {
    for (const listener of this.listeners) listener(event);
  }
}
