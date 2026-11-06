import { z } from "zod";
import {
  ACTION_IDS,
  DEFAULT_SETTINGS,
  EMPTY_STATS,
  PlayerError,
  SETTING_IDS,
  createCoreRegistry,
  describeSettings,
  fileIdentityOf,
  flattenSettingsPatch,
  isSettingId,
  nestSettings,
  toPlayerError,
  validateSettingValue,
  bookmarksAddInputSchema,
  bookmarksRemoveInputSchema,
  captureCreateInputSchema,
  configImportInputSchema,
  eventsReadInputSchema,
  historyListInputSchema,
  hostRequestInputSchema,
  jobsInputSchema,
  loopSetInputSchema,
  mediaOpenInputSchema,
  mediaProbeInputSchema,
  playlistAddInputSchema,
  playlistPlayInputSchema,
  playlistMoveInputSchema,
  playlistRemoveInputSchema,
  presetsApplyInputSchema,
  presetsDeleteInputSchema,
  presetsSaveInputSchema,
  seekInputSchema,
  setRateInputSchema,
  setVolumeInputSchema,
  settingsApplyInputSchema,
  settingsDescribeInputSchema,
  settingsGetInputSchema,
  settingsResetInputSchema,
  stepInputSchema,
  subtitlesLoadInputSchema,
  tracksSelectInputSchema,
  uiSetInputSchema,
  type ActionId,
  type Bookmark,
  type CapabilityReport,
  type EffectiveValue,
  type InvokeRequest,
  type InvokeResult,
  type HistoryItem,
  type MediaInfo,
  type MediaSourceInput,
  type PlayerErrorShape,
  type PlayerEvent,
  type PlayerEventType,
  type PlayerPhase,
  type PlayerSnapshot,
  type PlayerStorage,
  type PersistedPlayerState,
  type PlaylistItem,
  type Preset,
  type SelectedTracks,
  type SettingId,
  type SettingLayer,
  type SettingScope,
  type SettingsPatch,
  type TrackInfo,
  type TrackType
} from "@wasm-player/contracts";
import type {
  CaptureOptions,
  EngineEvent,
  EngineMediaSource,
  MediaEngine,
  MediaOpenResult
} from "@wasm-player/media-engine";

export interface PlayerHost {
  fullscreen?(enabled: boolean): Promise<void>;
  pictureInPicture?(enabled: boolean): Promise<void>;
  pickFiles?(params?: Record<string, unknown>): Promise<File[]>;
  saveFile?(params?: Record<string, unknown>): Promise<void>;
}

export interface JobRetentionOptions {
  /** Finished jobs kept in memory. Defaults to 32. */
  maxEntries?: number;
  /** Total bytes of capture results kept in memory. Defaults to 128 MiB. */
  maxBytes?: number;
  /** How long a finished job stays queryable. Defaults to 10 minutes. */
  ttlMs?: number;
}

export interface PlayerControllerOptions {
  engine: MediaEngine;
  sessionId?: string;
  host?: PlayerHost;
  now?: () => number;
  eventBufferSize?: number;
  dedupeWindowMs?: number;
  maxDedupEntries?: number;
  storage?: PlayerStorage;
  jobRetention?: JobRetentionOptions;
}

interface JobRecord {
  jobId: string;
  action: ActionId;
  status: "accepted" | "running" | "applied" | "failed" | "cancelled";
  createdAt: number;
  updatedAt: number;
  result?: unknown;
  error?: PlayerErrorShape;
}

interface HandlerResult {
  status: "applied" | "accepted";
  output?: unknown;
  requested?: unknown;
  effective?: unknown;
  jobId?: string;
  bumpRevision: boolean;
  events?: { type: PlayerEventType; payload: unknown }[];
}

/**
 * Actions that only read controller/engine state. Everything else is executed
 * through the serial mutation queue so concurrent writes cannot interleave, and
 * so `expectedRevision` is checked at execution time rather than at submission.
 */
const READ_ONLY_ACTIONS: ReadonlySet<ActionId> = new Set([
  ACTION_IDS.sourcesList,
  ACTION_IDS.tracksList,
  ACTION_IDS.settingsDescribe,
  ACTION_IDS.settingsGet,
  ACTION_IDS.stateGet,
  ACTION_IDS.eventsRead,
  ACTION_IDS.diagnosticsGet,
  ACTION_IDS.actionsList,
  ACTION_IDS.capabilitiesGet,
  ACTION_IDS.jobsGet,
  ACTION_IDS.sessionsList,
  ACTION_IDS.configExport,
  ACTION_IDS.presetsList,
  ACTION_IDS.playlistList,
  ACTION_IDS.historyList,
  ACTION_IDS.bookmarksList
]);

const CORE_OWNED_SETTINGS: ReadonlySet<SettingId> = new Set([
  "app.theme",
  "app.panel",
  "app.showStats",
  "app.reduceMotion",
  "playback.loop",
  "playback.autoPlay",
  "playback.volumeStep"
]);

const LAYER_ORDER: readonly Exclude<SettingLayer, "default">[] = [
  "global",
  "preset",
  "media",
  "session"
];

function emptyEffective(id: SettingId): EffectiveValue {
  const value = DEFAULT_SETTINGS[id];
  return {
    requested: value,
    effective: value,
    status: "applied",
    layer: "default"
  };
}

function isCoreOwned(id: SettingId): boolean {
  return CORE_OWNED_SETTINGS.has(id);
}

function errorDetails(error: unknown): Record<string, unknown> | undefined {
  if (error instanceof z.ZodError) {
    return { issues: error.issues };
  }
  return undefined;
}

function invalidRequest(message: string, error?: unknown): PlayerError {
  return new PlayerError("INVALID_REQUEST", message, {
    details: errorDetails(error)
  });
}

export class PlayerController {
  readonly sessionId: string;
  private readonly engine: MediaEngine;
  private readonly host: PlayerHost | undefined;
  private readonly storage: PlayerStorage | undefined;
  readonly ready: Promise<void>;
  private readonly now: () => number;
  private readonly registry = createCoreRegistry();
  private readonly eventBufferSize: number;
  private readonly dedupeWindowMs: number;
  private readonly maxDedupEntries: number;

  private revision = 0;
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
  private stats = { ...EMPTY_STATS };
  private capabilities: CapabilityReport;
  private error: PlayerErrorShape | null = null;

  private readonly effective = new Map<SettingId, EffectiveValue>();
  private readonly layers: Record<Exclude<SettingLayer, "default">, Map<SettingId, unknown>> = {
    global: new Map(),
    preset: new Map(),
    media: new Map(),
    session: new Map()
  };

  private readonly jobs = new Map<string, JobRecord>();
  private readonly jobBlobs = new Map<string, Blob>();
  private readonly jobRetention: Required<JobRetentionOptions>;
  private jobSeq = 0;

  private eventSeq = 0;
  private events: PlayerEvent[] = [];
  private readonly listeners = new Set<(event: PlayerEvent) => void>();
  private readonly dedupe = new Map<string, { at: number; result: InvokeResult }>();
  /** Requests that are still executing, so duplicates share one execution. */
  private readonly inFlight = new Map<string, Promise<InvokeResult>>();
  /** Tail of the serial queue used for state-changing actions. */
  private mutationTail: Promise<void> = Promise.resolve();

  private readonly presets = new Map<string, Preset>();
  private playlist: PlaylistItem[] = [];
  private currentPlaylistIndex: number | null = null;
  /** Source key of the media that is open; format-agnostic media identity. */
  private currentMediaKey: string | undefined;
  private history: HistoryItem[] = [];
  private readonly bookmarks = new Map<string, Bookmark[]>();

  private suppressEngineEvents = false;
  private disposed = false;
  private persistTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPositionPersistAt = 0;
  private readonly unsubscribeEngine: () => void;

  constructor(options: PlayerControllerOptions) {
    this.engine = options.engine;
    this.host = options.host;
    this.storage = options.storage;
    this.now = options.now ?? Date.now;
    this.sessionId = options.sessionId ?? `player-${Math.random().toString(36).slice(2, 10)}`;
    this.eventBufferSize = options.eventBufferSize ?? 1000;
    this.dedupeWindowMs = options.dedupeWindowMs ?? 5 * 60 * 1000;
    this.maxDedupEntries = options.maxDedupEntries ?? 2048;
    this.jobRetention = {
      maxEntries: options.jobRetention?.maxEntries ?? 32,
      maxBytes: options.jobRetention?.maxBytes ?? 128 * 1024 * 1024,
      ttlMs: options.jobRetention?.ttlMs ?? 10 * 60 * 1000
    };
    this.capabilities = this.engine.getCapabilities();
    for (const id of SETTING_IDS) this.effective.set(id, emptyEffective(id));
    this.unsubscribeEngine = this.engine.subscribe((event) => this.onEngineEvent(event));
    this.ready = this.restoreState();
  }

  getState(): PlayerSnapshot {
    const snapshot: PlayerSnapshot = {
      sessionId: this.sessionId,
      phase: this.phase,
      revision: this.revision,
      eventSeq: this.eventSeq,
      media: this.media,
      tracks: this.tracks,
      selected: this.selected,
      playlistIndex: this.currentPlaylistIndex,
      positionUs: this.positionUs,
      durationUs: this.durationUs,
      rate: this.rate,
      volume: this.volume,
      muted: this.muted,
      buffering: this.buffering,
      settings: Object.fromEntries(this.effective),
      capabilities: this.capabilities,
      error: this.error,
      stats: this.stats,
      updatedAt: this.now()
    };
    return structuredClone(snapshot);
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  getEventSeq(): number {
    return this.eventSeq;
  }

  getRegistry(): typeof this.registry {
    return this.registry;
  }

  getEffectiveSettings(): Record<string, EffectiveValue> {
    return Object.fromEntries(this.effective);
  }

  async invoke<I = unknown, O = unknown>(
    request: InvokeRequest<I>
  ): Promise<InvokeResult<O>> {
    const dedupeKey = `${request.sessionId}:${request.requestId}`;
    this.pruneDedupe(this.now());
    const existing = this.dedupe.get(dedupeKey);
    if (existing) {
      return structuredClone(existing.result) as InvokeResult<O>;
    }
    // A duplicate that arrives while the first copy is still running must not
    // execute the action again; it waits for the same result.
    const running = this.inFlight.get(dedupeKey);
    if (running) {
      return structuredClone(await running) as InvokeResult<O>;
    }

    const task = (async (): Promise<InvokeResult> => {
      try {
        return await this.execute(request, this.now());
      } catch (error) {
        return this.rejected(request, error);
      }
    })();
    this.inFlight.set(dedupeKey, task);
    let result: InvokeResult;
    try {
      result = await task;
    } finally {
      this.inFlight.delete(dedupeKey);
    }
    this.dedupe.set(dedupeKey, { at: this.now(), result });
    while (this.dedupe.size > this.maxDedupEntries) {
      const oldest = this.dedupe.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.dedupe.delete(oldest);
    }
    return result as InvokeResult<O>;
  }

  /** Runs `task` after every previously queued mutation has settled. */
  private runSerialized<T>(task: () => Promise<T>): Promise<T> {
    const result = this.mutationTail.then(task, task);
    this.mutationTail = result.then(
      () => undefined,
      () => undefined
    );
    return result;
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    await this.ready.catch(() => undefined);
    await this.flushPersist();
    this.disposed = true;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    this.unsubscribeEngine();
    this.listeners.clear();
    this.jobs.clear();
    this.jobBlobs.clear();
    const previous = this.phase;
    this.phase = "disposed";
    await this.engine.dispose();
    this.emitEvent("phase", { phase: "disposed", previous });
  }

  private async restoreState(): Promise<void> {
    if (!this.storage) return;
    let saved: PersistedPlayerState | null = null;
    try {
      saved = await this.storage.load();
    } catch {
      return;
    }
    if (!saved) return;

    const changes: Partial<Record<SettingId, unknown>> = {};
    for (const [rawId, value] of Object.entries(saved.globalSettings ?? {})) {
      if (!isSettingId(rawId)) continue;
      try {
        const validated = validateSettingValue(rawId, value);
        this.layers.global.set(rawId, validated);
        changes[rawId] = validated;
      } catch {
        // Ignore a value that no longer validates after an upgrade.
      }
    }
    if (Object.keys(changes).length > 0) {
      try {
        await this.applyResolvedSettings(nestSettings(changes), changes, "global");
      } catch {
        for (const id of Object.keys(changes) as SettingId[]) {
          const resolved = this.resolveSetting(id);
          this.effective.set(id, {
            requested: resolved.value,
            effective: resolved.value,
            status: "applied",
            layer: resolved.layer
          });
        }
        this.applyEffectiveToSnapshot(this.getEffectiveSettings());
      }
    }

    this.history = (Array.isArray(saved.history) ? saved.history : [])
      .filter((item) => item && typeof item.id === "string" && typeof item.name === "string")
      .slice(0, 100);
    this.playlist = (Array.isArray(saved.playlist) ? saved.playlist : [])
      .filter((item) => {
        if (!item || typeof item.name !== "string" || !item.source) return false;
        if (item.source.kind === "url" || item.source.kind === "sourceId") return true;
        // A local file cannot be serialized; keep the entry only when it has a
        // stable identity that can be re-linked from a file picker later.
        return (
          item.source.kind === "file" &&
          typeof (item.identity ?? item.source.identity) === "string"
        );
      })
      .map((item, index) => {
        if (item.source.kind !== "file") return { ...item, index };
        const identity = (item.identity ?? item.source.identity) as string;
        const source: MediaSourceInput = { kind: "file", identity };
        if (item.source.name !== undefined) source.name = item.source.name;
        if (item.source.sizeBytes !== undefined) source.sizeBytes = item.source.sizeBytes;
        return { ...item, index, identity, available: false, source };
      });
    this.bookmarks.clear();
    for (const item of Array.isArray(saved.bookmarks) ? saved.bookmarks : []) {
      if (!item || typeof item.mediaId !== "string" || typeof item.id !== "string") continue;
      const items = this.bookmarks.get(item.mediaId) ?? [];
      items.push(item);
      this.bookmarks.set(item.mediaId, items);
    }
    this.presets.clear();
    for (const preset of Array.isArray(saved.presets) ? saved.presets : []) {
      if (!preset || typeof preset.id !== "string" || typeof preset.name !== "string") continue;
      if (!preset.patch || typeof preset.patch !== "object") continue;
      this.presets.set(preset.id, preset);
    }
  }

  private persistedState(): PersistedPlayerState {
    const playlist: PlaylistItem[] = [];
    this.playlist.forEach((item, index) => {
      if (item.source.kind !== "file") {
        playlist.push({ ...item, index });
        return;
      }
      const identity = item.identity ?? this.identityOf(item.source);
      if (!identity) return;
      const source: MediaSourceInput = { kind: "file", identity };
      if (item.source.name !== undefined) source.name = item.source.name;
      if (item.source.sizeBytes !== undefined) source.sizeBytes = item.source.sizeBytes;
      playlist.push({ ...item, index, identity, available: false, source });
    });
    return {
      version: 1,
      globalSettings: Object.fromEntries(this.layers.global),
      history: this.history,
      bookmarks: [...this.bookmarks.values()].flat(),
      playlist,
      presets: [...this.presets.values()]
    };
  }

  /** Media source id that a playlist entry would produce for this source. */
  private currentSourceKey(source: MediaSourceInput): string | undefined {
    if (source.kind === "file") {
      const identity = this.identityOf(source);
      return identity === undefined ? undefined : `file:${identity}`;
    }
    return source.kind === "url" ? source.url : undefined;
  }

  /** Stable identity for a local file source, or `undefined` for remote ones. */
  private identityOf(source: MediaSourceInput): string | undefined {
    if (source.kind !== "file") return undefined;
    return source.identity ?? fileIdentityOf(source.file, source.name);
  }

  /**
   * Re-attach a freshly picked file to the playlist entries that were restored
   * from storage. Matching happens on the persisted identity, so a file is
   * recognised even when its playlist entry no longer holds a `File`.
   *
   * Returns the index of the matching entry so a direct open can make the
   * controller's current playlist entry follow the file that is playing.
   */
  private relinkPlaylistSource(source: MediaSourceInput): number | null {
    const identity = this.identityOf(source);
    if (!identity) return null;
    let matched: number | null = null;
    let changed = false;
    for (const item of this.playlist) {
      if (item.source.kind !== "file") continue;
      const itemIdentity = item.identity ?? this.identityOf(item.source);
      if (itemIdentity !== identity) continue;
      matched = item.index;
      if (item.available !== false && item.source.file === source.file) continue;
      item.source = source;
      item.identity = identity;
      item.available = true;
      if (source.name !== undefined) item.name = source.name;
      changed = true;
    }
    if (changed) this.schedulePersist();
    return matched;
  }

  private schedulePersist(delayMs = 250): void {
    if (!this.storage || this.disposed) return;
    if (this.persistTimer) clearTimeout(this.persistTimer);
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null;
      void this.persist();
    }, delayMs);
  }

  private async persist(): Promise<void> {
    if (!this.storage) return;
    try {
      await this.storage.save(this.persistedState());
    } catch {
      // Persistence must never break playback.
    }
  }

  private async flushPersist(): Promise<void> {
    if (!this.storage) return;
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = null;
    }
    await this.persist();
  }

  private updateHistoryPosition(): void {
    if (!this.media) return;
    const item = this.history.find((entry) => entry.id === this.media?.sourceId);
    if (!item) return;
    item.positionUs = this.positionUs;
    item.durationUs = this.durationUs;
    item.completed = this.durationUs > 0 && this.positionUs >= this.durationUs * 0.98;
  }

  private async execute(
    request: InvokeRequest<unknown>,
    now: number
  ): Promise<InvokeResult> {
    await this.ready;
    if (
      typeof request.requestId !== "string" ||
      request.requestId.length === 0 ||
      typeof request.sessionId !== "string" ||
      request.sessionId.length === 0 ||
      typeof request.action !== "string"
    ) {
      throw invalidRequest("requestId, sessionId and action are required");
    }
    if (request.sessionId !== this.sessionId) {
      throw new PlayerError("SESSION_CLOSED", `session ${request.sessionId} is not this player`);
    }
    if (this.disposed) {
      throw new PlayerError("SESSION_CLOSED", `session ${this.sessionId} is disposed`);
    }
    const definition = this.registry.get(request.action);
    if (!definition) {
      throw invalidRequest(`unknown action: ${request.action}`);
    }

    let params: unknown;
    try {
      params = definition.inputSchema.parse(request.params ?? {});
    } catch (error) {
      throw invalidRequest(`invalid params for ${request.action}`, error);
    }

    // Everything that can change state runs through one queue: the revision
    // check, the dispatch and the revision bump must not interleave with another
    // write, otherwise two requests that both expect revision N both succeed.
    const run = async (): Promise<InvokeResult> => {
      if (request.expectedRevision !== undefined && request.expectedRevision !== this.revision) {
        throw new PlayerError(
          "REVISION_CONFLICT",
          `expected revision ${request.expectedRevision}, current revision ${this.revision}`,
          {
            details: {
              expectedRevision: request.expectedRevision,
              revision: this.revision
            }
          }
        );
      }
      if (definition.media === "required" && this.media === null) {
        throw new PlayerError("NEEDS_MEDIA", `${request.action} requires an open media`);
      }

      const handled = await this.dispatch(request.action, params, now);

      let output: unknown = handled.output;
      if (output !== undefined) {
        try {
          output = definition.outputSchema.parse(output);
        } catch (error) {
          throw new PlayerError("INTERNAL", `action ${request.action} produced invalid output`, {
            details: errorDetails(error),
            cause: error
          });
        }
      }

      if (handled.bumpRevision) this.revision += 1;
      for (const event of handled.events ?? []) {
        this.emitEvent(event.type, event.payload);
      }
      if (handled.bumpRevision) {
        this.emitEvent("state", this.getState());
      }

      const result: InvokeResult = {
        requestId: request.requestId,
        sessionId: this.sessionId,
        status: handled.status,
        revision: this.revision
      };
      if (handled.requested !== undefined) result.requested = handled.requested;
      if (handled.effective !== undefined) result.effective = handled.effective;
      if (handled.jobId !== undefined) result.jobId = handled.jobId;
      if (output !== undefined) result.output = output;
      return result;
    };

    if (READ_ONLY_ACTIONS.has(request.action) && request.expectedRevision === undefined) {
      return run();
    }
    return this.runSerialized(run);
  }

  private rejected(request: InvokeRequest<unknown>, error: unknown): InvokeResult {
    const playerError = toPlayerError(error);
    return {
      requestId: request.requestId,
      sessionId: request.sessionId,
      status: "rejected",
      revision: this.revision,
      error: playerError.toJSON()
    };
  }

  private async dispatch(
    action: ActionId,
    params: unknown,
    now: number
  ): Promise<HandlerResult> {
    switch (action) {
      case ACTION_IDS.mediaOpen:
        return this.openMedia(mediaOpenInputSchema.parse(params));
      case ACTION_IDS.mediaClose:
        return this.closeMedia();
      case ACTION_IDS.mediaProbe:
        return this.probeMedia(mediaProbeInputSchema.parse(params));
      case ACTION_IDS.sourcesList:
        return { status: "applied", output: { sources: [] }, bumpRevision: false };
      case ACTION_IDS.playbackPlay:
        return this.play();
      case ACTION_IDS.playbackPause:
        return this.pause();
      case ACTION_IDS.playbackStop:
        return this.stop();
      case ACTION_IDS.playbackSeek:
        return this.seek(seekInputSchema.parse(params));
      case ACTION_IDS.playbackStep:
        return this.step(stepInputSchema.parse(params));
      case ACTION_IDS.playbackSetRate:
        return this.setRate(setRateInputSchema.parse(params));
      case ACTION_IDS.playbackSetVolume:
        return this.setVolume(setVolumeInputSchema.parse(params));
      case ACTION_IDS.loopSet:
        return this.setLoop(loopSetInputSchema.parse(params).mode);
      case ACTION_IDS.tracksList:
        return this.listTracks();
      case ACTION_IDS.tracksSelect:
        return this.selectTrack(tracksSelectInputSchema.parse(params));
      case ACTION_IDS.settingsDescribe:
        return this.describeSettings(settingsDescribeInputSchema.parse(params).group);
      case ACTION_IDS.settingsGet:
        return this.getSettings(settingsGetInputSchema.parse(params).ids);
      case ACTION_IDS.settingsApply: {
        const input = settingsApplyInputSchema.parse(params);
        return this.applySettings(input.scope, input.patch);
      }
      case ACTION_IDS.settingsReset: {
        const input = settingsResetInputSchema.parse(params);
        return this.resetSettings(input.scope, input.ids);
      }
      case ACTION_IDS.subtitlesLoad: {
        const input = subtitlesLoadInputSchema.parse(params);
        if (input.file !== undefined && !(input.file instanceof Blob)) {
          throw invalidRequest("subtitles.file must be a File or Blob");
        }
        const subtitleInput = {
          text: input.text,
          url: input.url,
          name: input.name,
          encoding: input.encoding,
          format: input.format
        } as Parameters<MediaEngine["loadSubtitle"]>[0];
        if (input.file instanceof Blob) subtitleInput.file = input.file;
        return this.loadSubtitle(subtitleInput);
      }
      case ACTION_IDS.stateGet:
        return { status: "applied", output: this.getState(), bumpRevision: false };
      case ACTION_IDS.eventsRead:
        return this.readEvents(eventsReadInputSchema.parse(params));
      case ACTION_IDS.diagnosticsGet:
        return this.diagnostics();
      case ACTION_IDS.actionsList:
        return { status: "applied", output: { actions: this.registry.describe() }, bumpRevision: false };
      case ACTION_IDS.capabilitiesGet:
        return { status: "applied", output: this.capabilities, bumpRevision: false };
      case ACTION_IDS.jobsGet:
        return this.getJob(jobsInputSchema.parse(params).jobId);
      case ACTION_IDS.jobsCancel:
        return this.cancelJob(jobsInputSchema.parse(params).jobId);
      case ACTION_IDS.captureCreate:
        return this.createCaptureJob(captureCreateInputSchema.parse(params), now);
      case ACTION_IDS.uiSet:
        return this.setUi(uiSetInputSchema.parse(params));
      case ACTION_IDS.hostRequest:
        return this.hostRequest(hostRequestInputSchema.parse(params));
      case ACTION_IDS.sessionsList:
        return this.listSessions();
      case ACTION_IDS.sessionsAttach:
        return this.attachSession(z.object({ sessionId: z.string().min(1) }).strict().parse(params).sessionId);
      case ACTION_IDS.configExport:
        return this.exportConfig(now);
      case ACTION_IDS.configImport:
        return this.importConfig(configImportInputSchema.parse(params));
      case ACTION_IDS.presetsList:
        return { status: "applied", output: { presets: [...this.presets.values()] }, bumpRevision: false };
      case ACTION_IDS.presetsSave:
        return this.savePreset(presetsSaveInputSchema.parse(params).preset);
      case ACTION_IDS.presetsApply: {
        const input = presetsApplyInputSchema.parse(params);
        return this.applyPreset(input.id, input.scope);
      }
      case ACTION_IDS.presetsDelete:
        return this.deletePreset(presetsDeleteInputSchema.parse(params).id);
      case ACTION_IDS.playlistAdd:
        return this.addPlaylist(playlistAddInputSchema.parse(params).sources);
      case ACTION_IDS.playlistMove: {
        const input = playlistMoveInputSchema.parse(params);
        return this.movePlaylist(input.from, input.to);
      }
      case ACTION_IDS.playlistRemove:
        return this.removePlaylist(playlistRemoveInputSchema.parse(params).index);
      case ACTION_IDS.playlistClear:
        return this.clearPlaylist();
      case ACTION_IDS.playlistList:
        return { status: "applied", output: { items: this.playlistItems() }, bumpRevision: false };
      case ACTION_IDS.playlistPlay:
        return this.playPlaylist(playlistPlayInputSchema.parse(params).index);
      case ACTION_IDS.historyList:
        return this.listHistory(historyListInputSchema.parse(params).limit);
      case ACTION_IDS.bookmarksList:
        return this.listBookmarks();
      case ACTION_IDS.bookmarksAdd: {
        const input = bookmarksAddInputSchema.parse(params);
        return this.addBookmark(input.name, input.positionUs);
      }
      case ACTION_IDS.bookmarksRemove:
        return this.removeBookmark(bookmarksRemoveInputSchema.parse(params).id);
      default:
        throw new PlayerError("UNSUPPORTED", `action ${action} is not implemented`);
    }
  }

  private engineSource(source: MediaSourceInput): EngineMediaSource {
    if (source.kind === "file") {
      if (!(source.file instanceof Blob)) {
        throw invalidRequest("source.file must be a File or Blob");
      }
      const value: EngineMediaSource = { kind: "file", file: source.file };
      if (source.name !== undefined) value.name = source.name;
      if (source.sizeBytes !== undefined) value.sizeBytes = source.sizeBytes;
      // The identity survives restarts, so the engine can expose it as the
      // media source id and history/bookmarks stay per file, not per name.
      const identity = this.identityOf(source);
      if (identity !== undefined) value.identity = identity;
      return value;
    }
    if (source.kind === "url") {
      if (!source.url) throw invalidRequest("source.url is required");
      const value: EngineMediaSource = { kind: "url", url: source.url };
      if (source.name !== undefined) value.name = source.name;
      if (source.headers !== undefined) value.headers = source.headers;
      if (source.sizeBytes !== undefined) value.sizeBytes = source.sizeBytes;
      return value;
    }
    const value: EngineMediaSource = { kind: "sourceId", sourceId: source.sourceId ?? "" };
    if (source.name !== undefined) value.name = source.name;
    if (source.sizeBytes !== undefined) value.sizeBytes = source.sizeBytes;
    return value;
  }

  private async openMedia(input: {
    source: MediaSourceInput;
    autoPlay?: boolean;
    startPositionUs?: number;
    forceDecodePath?: Partial<Record<TrackType, "webcodecs" | "wasm">>;
    preferredTracks?: Partial<Record<TrackType, number>>;
    fromPlaylist?: boolean;
  }): Promise<HandlerResult> {
    // Opening a playlist entry always sets the index; opening the same file
    // directly makes the entry it belongs to current, so the UI and the
    // previous/next commands follow the media that is actually playing.
    const linked = this.relinkPlaylistSource(input.source);
    const result = await this.engine.open({
      source: this.engineSource(input.source),
      autoPlay: input.autoPlay,
      startPositionUs: input.startPositionUs,
      forceDecodePath: input.forceDecodePath,
      preferredTracks: input.preferredTracks
    });
    if (!input.fromPlaylist) this.currentPlaylistIndex = linked;
    this.currentMediaKey = this.currentSourceKey(input.source);
    this.layers.media.clear();
    this.applyOpenResult(result);
    await this.syncSettingsToEngine("session");
    this.recordHistory(result.media, input.source);
    return {
      status: "applied",
      output: { media: result.media },
      bumpRevision: true,
      events: [{ type: "mediaOpened", payload: { media: result.media, tracks: result.tracks } }]
    };
  }

  private applyOpenResult(result: MediaOpenResult): void {
    this.media = result.media;
    this.tracks = result.tracks;
    this.selected = result.selected;
    this.capabilities = result.capabilities;
    this.phase = this.engine.getSnapshot().phase;
    this.durationUs = result.media.durationUs;
    this.positionUs = this.engine.getSnapshot().positionUs;
    this.rate = this.engine.getSnapshot().rate;
    this.volume = this.engine.getSnapshot().volume;
    this.muted = this.engine.getSnapshot().muted;
    this.buffering = false;
    this.error = null;
  }

  private async closeMedia(): Promise<HandlerResult> {
    this.currentPlaylistIndex = null;
    this.currentMediaKey = undefined;
    this.updateHistoryPosition();
    this.schedulePersist(0);
    await this.engine.close();
    this.layers.media.clear();
    this.media = null;
    this.tracks = [];
    this.selected = { video: null, audio: null, subtitle: null };
    this.phase = "idle";
    this.positionUs = 0;
    this.durationUs = 0;
    this.rate = 1;
    this.buffering = false;
    this.error = null;
    return {
      status: "applied",
      bumpRevision: true,
      events: [{ type: "mediaClosed", payload: { sessionId: this.sessionId } }]
    };
  }

  private async probeMedia(input: { source: MediaSourceInput }): Promise<HandlerResult> {
    if (this.media !== null) {
      throw new PlayerError("BUSY", "close the current media before probing");
    }
    this.suppressEngineEvents = true;
    try {
      const result = await this.engine.open({ source: this.engineSource(input.source) });
      return {
        status: "applied",
        output: { media: result.media },
        bumpRevision: false
      };
    } finally {
      await this.engine.close();
      this.suppressEngineEvents = false;
    }
  }

  private async play(): Promise<HandlerResult> {
    await this.engine.play();
    this.phase = "playing";
    return {
      status: "applied",
      bumpRevision: true,
      events: [{ type: "phase", payload: { phase: "playing" } }]
    };
  }

  private async pause(): Promise<HandlerResult> {
    await this.engine.pause();
    this.phase = "paused";
    return {
      status: "applied",
      bumpRevision: true,
      events: [{ type: "phase", payload: { phase: "paused" } }]
    };
  }

  private async stop(): Promise<HandlerResult> {
    await this.engine.stop();
    this.positionUs = 0;
    this.phase = "paused";
    return {
      status: "applied",
      bumpRevision: true,
      events: [{ type: "position", payload: { positionUs: 0, durationUs: this.durationUs } }]
    };
  }

  private async seek(input: { positionUs: number }): Promise<HandlerResult> {
    const result = await this.engine.seek(input.positionUs);
    this.positionUs = result.positionUs;
    this.phase = this.engine.getSnapshot().phase;
    const output = {
      positionUs: result.positionUs,
      requestedUs: result.requestedUs,
      errorUs: result.errorUs
    };
    return {
      status: "applied",
      bumpRevision: true,
      output,
      events: [
        { type: "seeked", payload: output },
        { type: "position", payload: { positionUs: result.positionUs, durationUs: this.durationUs } }
      ]
    };
  }

  private async step(input: { frames: number; direction?: "forward" | "backward" }): Promise<HandlerResult> {
    await this.engine.step(input.frames, input.direction ?? "forward");
    this.positionUs = this.engine.getSnapshot().positionUs;
    return {
      status: "applied",
      bumpRevision: true,
      events: [{ type: "position", payload: { positionUs: this.positionUs, durationUs: this.durationUs } }]
    };
  }

  private async setRate(input: { rate: number }): Promise<HandlerResult> {
    const result = await this.engine.setRate(input.rate);
    this.rate = result.effective;
    this.layers.session.set("playback.rate", input.rate);
    const value: EffectiveValue = {
      requested: input.rate,
      effective: result.effective,
      status: "applied",
      layer: "session"
    };
    if (result.reason !== undefined) value.reason = result.reason;
    this.effective.set("playback.rate", value);
    return {
      status: "applied",
      bumpRevision: true,
      output: result,
      requested: { rate: input.rate },
      effective: result,
      events: [{ type: "settingsApplied", payload: { "playback.rate": value } }]
    };
  }

  private async setVolume(input: { volume: number; muted?: boolean }): Promise<HandlerResult> {
    const effective = await this.engine.setVolume(input.volume, input.muted);
    this.layers.session.set("audio.volume", input.volume);
    if (input.muted !== undefined) this.layers.session.set("audio.muted", input.muted);
    for (const [id, value] of Object.entries(effective)) {
      if (isSettingId(id)) this.effective.set(id, value);
    }
    const snapshot = this.engine.getSnapshot();
    this.volume = snapshot.volume;
    this.muted = snapshot.muted;
    return {
      status: "applied",
      bumpRevision: true,
      output: { values: effective },
      requested: input,
      effective,
      events: [{ type: "settingsApplied", payload: effective }]
    };
  }

  private async setLoop(
    mode: "off" | "media" | "playlist" | "order" | "shuffle"
  ): Promise<HandlerResult> {
    return this.applySettings("global", { playback: { loop: mode } });
  }

  private listTracks(): HandlerResult {
    return { status: "applied", output: { tracks: this.tracks }, bumpRevision: false };
  }

  private async selectTrack(input: { type: TrackType; index: number }): Promise<HandlerResult> {
    const tracks = await this.engine.selectTrack(input.type, input.index);
    this.tracks = tracks;
    const snapshot = this.engine.getSnapshot();
    this.selected = snapshot.selected;
    return {
      status: "applied",
      bumpRevision: true,
      output: { tracks },
      events: [{ type: "trackChanged", payload: { tracks, selected: this.selected } }]
    };
  }

  private describeSettings(group?: string): HandlerResult {
    const all = describeSettings();
    const settings = group ? all.filter((setting) => setting.group === group) : all;
    return { status: "applied", output: { settings }, bumpRevision: false };
  }

  private getSettings(ids?: string[]): HandlerResult {
    const values: Record<string, EffectiveValue> = {};
    if (ids) {
      for (const id of ids) {
        if (!isSettingId(id)) throw invalidRequest(`unknown setting: ${id}`);
        const value = this.effective.get(id);
        if (value) values[id] = value;
      }
    } else {
      for (const [id, value] of this.effective) values[id] = value;
    }
    return { status: "applied", output: { values }, bumpRevision: false };
  }

  private async applySettings(
    scope: SettingScope,
    patch: SettingsPatch
  ): Promise<HandlerResult> {
    const flat = flattenSettingsPatch(patch);
    if (scope === "preset") {
      for (const [id, value] of Object.entries(flat) as [SettingId, unknown][]) {
        this.layers.preset.set(id, value);
      }
    } else {
      for (const [id, value] of Object.entries(flat) as [SettingId, unknown][]) {
        this.layers[scope].set(id, value);
      }
    }

    const engineResult = await this.engine.applySettings(patch, scope);
    const effective: Record<string, EffectiveValue> = {};
    for (const [id, requested] of Object.entries(flat) as [SettingId, unknown][]) {
      const engineValue = engineResult.effective[id];
      let value: EffectiveValue;
      if (isCoreOwned(id)) {
        value = {
          requested,
          effective: requested,
          status: "applied",
          layer: scope
        };
      } else if (engineValue) {
        value = engineValue;
      } else {
        value = {
          requested,
          effective: DEFAULT_SETTINGS[id],
          status: "unsupported",
          layer: scope,
          reason: "the media engine did not report an effective value"
        };
      }
      this.effective.set(id, value);
      effective[id] = value;
    }
    this.applyEffectiveToSnapshot(effective);
    if (scope === "global") this.schedulePersist();
    const allEffective = Object.fromEntries(this.effective);
    return {
      status: "applied",
      bumpRevision: true,
      output: { requested: patch, effective: allEffective },
      requested: patch,
      effective: allEffective,
      events: [{ type: "settingsApplied", payload: effective }]
    };
  }

  private async resetSettings(scope: SettingScope, ids?: string[]): Promise<HandlerResult> {
    const layer = scope === "preset" ? this.layers.preset : this.layers[scope];
    const targets = ids ?? SETTING_IDS;
    const changed: Partial<Record<SettingId, unknown>> = {};
    for (const rawId of targets) {
      if (!isSettingId(rawId)) throw invalidRequest(`unknown setting: ${rawId}`);
      const id = rawId;
      layer.delete(id);
      const resolved = this.resolveSetting(id);
      const previous = this.effective.get(id);
      if (!previous || previous.requested !== resolved.value) {
        changed[id] = resolved.value;
      }
    }
    if (Object.keys(changed).length > 0) {
      const patch = nestSettings(changed);
      await this.applyResolvedSettings(patch, changed, scope);
    }
    if (scope === "global") this.schedulePersist();
    const effective = Object.fromEntries(this.effective);
    return {
      status: "applied",
      bumpRevision: true,
      output: { values: effective },
      effective,
      events: [{ type: "settingsApplied", payload: effective }]
    };
  }

  private resolveSetting(id: SettingId): { value: unknown; layer: SettingLayer } {
    let value = DEFAULT_SETTINGS[id];
    let layer: SettingLayer = "default";
    for (const name of LAYER_ORDER) {
      const map = this.layers[name];
      if (map.has(id)) {
        value = map.get(id);
        layer = name;
      }
    }
    return { value, layer };
  }

  private async applyResolvedSettings(
    patch: SettingsPatch,
    changed: Partial<Record<SettingId, unknown>>,
    scope: SettingScope
  ): Promise<void> {
    const engineResult = await this.engine.applySettings(patch, scope);
    for (const id of Object.keys(changed) as SettingId[]) {
      const resolved = this.resolveSetting(id);
      const engineValue = engineResult.effective[id];
      let value: EffectiveValue;
      if (isCoreOwned(id)) {
        value = {
          requested: resolved.value,
          effective: resolved.value,
          status: "applied",
          layer: resolved.layer
        };
      } else if (engineValue) {
        value = engineValue;
      } else {
        value = {
          requested: resolved.value,
          effective: DEFAULT_SETTINGS[id],
          status: "unsupported",
          layer: resolved.layer,
          reason: "the media engine did not report an effective value"
        };
      }
      value.requested = resolved.value;
      value.layer = resolved.layer;
      this.effective.set(id, value);
    }
    this.applyEffectiveToSnapshot(this.getEffectiveSettings());
  }

  private async syncSettingsToEngine(scope: SettingScope): Promise<void> {
    const flat: Partial<Record<SettingId, unknown>> = {};
    for (const id of SETTING_IDS) {
      if (isCoreOwned(id)) continue;
      const value = this.effective.get(id);
      if (!value) continue;
      const isDefault =
        value.layer === "default" && Object.is(value.requested, DEFAULT_SETTINGS[id]);
      if (isDefault) continue;
      flat[id] = value.requested;
    }
    if (Object.keys(flat).length === 0) return;
    try {
      const result = await this.engine.applySettings(nestSettings(flat), scope);
      for (const [id, value] of Object.entries(result.effective) as [SettingId, EffectiveValue][]) {
        const current = this.effective.get(id);
        if (!current) continue;
        this.effective.set(id, {
          ...value,
          requested: current.requested,
          layer: current.layer
        });
      }
      this.applyEffectiveToSnapshot(this.getEffectiveSettings());
    } catch {
      // Opening media must not fail because a non-critical visual setting is
      // not implemented by an engine yet.
    }
  }

  private applyEffectiveToSnapshot(effective: Record<string, EffectiveValue>): void {
    const rate = effective["playback.rate"];
    if (rate && rate.status === "applied" && typeof rate.effective === "number") {
      this.rate = rate.effective;
    }
    const volume = effective["audio.volume"];
    if (volume && volume.status === "applied" && typeof volume.effective === "number") {
      this.volume = volume.effective;
    }
    const muted = effective["audio.muted"];
    if (muted && muted.status === "applied" && typeof muted.effective === "boolean") {
      this.muted = muted.effective;
    }
  }

  private async loadSubtitle(input: Parameters<MediaEngine["loadSubtitle"]>[0]): Promise<HandlerResult> {
    const tracks = await this.engine.loadSubtitle(input);
    this.tracks = tracks;
    this.selected = this.engine.getSnapshot().selected;
    return {
      status: "applied",
      bumpRevision: true,
      output: { tracks },
      events: [{ type: "trackChanged", payload: { tracks, selected: this.selected } }]
    };
  }

  private readEvents(input: { afterSeq: number; limit: number }): HandlerResult {
    const events = this.events.filter((event) => event.seq > input.afterSeq).slice(0, input.limit);
    const nextSeq = events.length > 0 ? events[events.length - 1]!.seq : input.afterSeq;
    return {
      status: "applied",
      output: { events, nextSeq },
      bumpRevision: false
    };
  }

  private diagnostics(): HandlerResult {
    const engineDiagnostics = this.engine.getDiagnostics();
    return {
      status: "applied",
      output: {
        sessionId: this.sessionId,
        phase: this.phase,
        media: this.media,
        stats: this.stats,
        capabilities: engineDiagnostics.capabilities,
        decodePaths: engineDiagnostics.decodePaths,
        queues: engineDiagnostics.queues,
        warnings: engineDiagnostics.warnings,
        generatedAt: this.now()
      },
      bumpRevision: false
    };
  }

  private getJob(jobId: string): HandlerResult {
    const job = this.jobs.get(jobId);
    if (!job) throw invalidRequest(`unknown job: ${jobId}`);
    const output = this.jobStatus(job);
    return { status: "applied", output, bumpRevision: false };
  }

  private async cancelJob(jobId: string): Promise<HandlerResult> {
    const job = this.jobs.get(jobId);
    if (!job) throw invalidRequest(`unknown job: ${jobId}`);
    if (job.status === "accepted" || job.status === "running") {
      job.status = "cancelled";
      job.updatedAt = this.now();
      this.emitEvent("jobUpdated", { jobId, status: "cancelled" });
    }
    return {
      status: "applied",
      output: this.jobStatus(job),
      bumpRevision: false
    };
  }

  private createCaptureJob(options: CaptureOptions, now: number): HandlerResult {
    this.pruneJobs(now);
    this.jobSeq += 1;
    const jobId = `job-${this.jobSeq}`;
    const job: JobRecord = {
      jobId,
      action: ACTION_IDS.captureCreate,
      status: "accepted",
      createdAt: now,
      updatedAt: now
    };
    this.jobs.set(jobId, job);
    void this.runCaptureJob(jobId, options);
    return {
      status: "accepted",
      jobId,
      output: { jobId, status: "accepted" },
      bumpRevision: false,
      events: [{ type: "jobUpdated", payload: { jobId, status: "accepted" } }]
    };
  }

  private async runCaptureJob(jobId: string, options: CaptureOptions): Promise<void> {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.updatedAt = this.now();
    try {
      const result = await this.engine.capture(options);
      const latest = this.jobs.get(jobId);
      if (!latest || latest.status === "cancelled") return;
      latest.status = "applied";
      latest.updatedAt = this.now();
      latest.result = {
        mimeType: result.mimeType,
        width: result.width,
        height: result.height,
        capturedAtUs: result.capturedAtUs
      };
      this.jobBlobs.set(jobId, result.blob);
      this.pruneJobs();
      this.emitEvent("jobUpdated", { jobId, status: "applied", result: latest.result });
    } catch (error) {
      const latest = this.jobs.get(jobId);
      if (!latest || latest.status === "cancelled") return;
      const playerError = toPlayerError(error);
      latest.status = "failed";
      latest.updatedAt = this.now();
      latest.error = playerError.toJSON();
      this.emitEvent("jobUpdated", { jobId, status: "failed", error: latest.error });
    }
  }

  getJobBlob(jobId: string): Blob | undefined {
    return this.jobBlobs.get(jobId);
  }

  /**
   * Drop a captured result once the caller has consumed it. The returned Blob
   * reference stays valid; only the controller's copy is released.
   */
  releaseJob(jobId: string): boolean {
    const hadBlob = this.jobBlobs.delete(jobId);
    const job = this.jobs.get(jobId);
    const removable = job !== undefined && this.isFinishedJob(job);
    if (removable) this.jobs.delete(jobId);
    return hadBlob || removable;
  }

  private isFinishedJob(job: JobRecord): boolean {
    return job.status === "applied" || job.status === "failed" || job.status === "cancelled";
  }

  /**
   * Captures are the only unbounded results the controller keeps: evict expired
   * jobs and, when over the entry or byte budget, the oldest finished ones.
   * Running jobs are never evicted mid-flight.
   */
  private pruneJobs(now = this.now()): void {
    for (const [jobId, job] of this.jobs) {
      if (!this.isFinishedJob(job)) continue;
      if (now - job.updatedAt > this.jobRetention.ttlMs) {
        this.jobs.delete(jobId);
        this.jobBlobs.delete(jobId);
      }
    }
    let bytes = 0;
    for (const blob of this.jobBlobs.values()) bytes += blob.size;
    const finished = [...this.jobs.values()]
      .filter((job) => this.isFinishedJob(job))
      .sort((left, right) => left.updatedAt - right.updatedAt);
    for (const job of finished) {
      const overEntries = this.jobs.size > this.jobRetention.maxEntries;
      const overBytes = bytes > this.jobRetention.maxBytes;
      if (!overEntries && !overBytes) break;
      const blob = this.jobBlobs.get(job.jobId);
      if (blob) {
        bytes -= blob.size;
        this.jobBlobs.delete(job.jobId);
      }
      this.jobs.delete(job.jobId);
    }
  }

  private jobStatus(job: JobRecord): Record<string, unknown> {
    const output: Record<string, unknown> = {
      jobId: job.jobId,
      action: job.action,
      status: job.status,
      createdAt: job.createdAt,
      updatedAt: job.updatedAt
    };
    if (job.result !== undefined) output.result = job.result;
    if (job.error !== undefined) output.error = job.error;
    return output;
  }

  private async setUi(input: {
    panel?: "none" | "playlist" | "settings";
    commandPalette?: boolean;
    theme?: "system" | "dark" | "light";
    fullscreen?: boolean;
    pictureInPicture?: boolean;
  }): Promise<HandlerResult> {
    let result: HandlerResult | null = null;
    const patch: SettingsPatch = {};
    if (input.theme !== undefined) patch.app = { ...(patch.app ?? {}), theme: input.theme };
    if (input.panel !== undefined) patch.app = { ...(patch.app ?? {}), panel: input.panel };
    if (Object.keys(patch).length > 0) {
      result = await this.applySettings("global", patch);
    }
    if (input.fullscreen !== undefined) {
      if (!this.host?.fullscreen) throw new PlayerError("UNSUPPORTED", "fullscreen host API is unavailable");
      await this.host.fullscreen(input.fullscreen);
    }
    if (input.pictureInPicture !== undefined) {
      if (!this.host?.pictureInPicture) {
        throw new PlayerError("UNSUPPORTED", "picture-in-picture host API is unavailable");
      }
      await this.host.pictureInPicture(input.pictureInPicture);
    }
    if (result) return result;
    return { status: "applied", bumpRevision: false };
  }

  private async hostRequest(input: {
    operation: "pickFiles" | "fullscreen" | "pictureInPicture" | "saveFile";
    params?: Record<string, unknown>;
  }): Promise<HandlerResult> {
    if (input.operation === "fullscreen") {
      if (!this.host?.fullscreen) throw new PlayerError("UNSUPPORTED", "fullscreen host API is unavailable");
      await this.host.fullscreen(true);
      return { status: "applied", bumpRevision: false };
    }
    if (input.operation === "pictureInPicture") {
      if (!this.host?.pictureInPicture) {
        throw new PlayerError("UNSUPPORTED", "picture-in-picture host API is unavailable");
      }
      await this.host.pictureInPicture(true);
      return { status: "applied", bumpRevision: false };
    }
    if (input.operation === "pickFiles") {
      if (!this.host?.pickFiles) throw new PlayerError("UNSUPPORTED", "file picker host API is unavailable");
      const files = await this.host.pickFiles(input.params);
      return {
        status: "applied",
        output: { count: files.length, names: files.map((file) => file.name) },
        bumpRevision: false
      };
    }
    if (!this.host?.saveFile) throw new PlayerError("UNSUPPORTED", "save-file host API is unavailable");
    await this.host.saveFile(input.params);
    return { status: "applied", bumpRevision: false };
  }

  private listSessions(): HandlerResult {
    return {
      status: "applied",
      output: {
        sessions: [
          {
            sessionId: this.sessionId,
            title: this.media?.name,
            mediaName: this.media?.name,
            phase: this.phase,
            connectedAt: this.now()
          }
        ]
      },
      bumpRevision: false
    };
  }

  private attachSession(sessionId: string): HandlerResult {
    if (sessionId !== this.sessionId) {
      throw new PlayerError("SESSION_CLOSED", `session ${sessionId} is not available`);
    }
    return {
      status: "applied",
      output: {
        session: {
          sessionId: this.sessionId,
          title: this.media?.name,
          mediaName: this.media?.name,
          phase: this.phase,
          connectedAt: this.now()
        }
      },
      bumpRevision: false
    };
  }

  private exportConfig(now: number): HandlerResult {
    const settings: Record<string, unknown> = {};
    for (const name of LAYER_ORDER) {
      for (const [id, value] of this.layers[name]) settings[id] = value;
    }
    return {
      status: "applied",
      output: {
        version: 1,
        exportedAt: new Date(now).toISOString(),
        settings,
        presets: [...this.presets.values()]
      },
      bumpRevision: false
    };
  }

  private async importConfig(input: {
    version: 1;
    settings: Record<string, unknown>;
    presets?: unknown[];
  }): Promise<HandlerResult> {
    const changed: Partial<Record<SettingId, unknown>> = {};
    for (const [id, value] of Object.entries(input.settings)) {
      if (!isSettingId(id)) throw invalidRequest(`unknown setting in config: ${id}`);
      const validated = validateSettingValue(id, value);
      this.layers.global.set(id, validated);
      changed[id] = validated;
    }
    await this.applyResolvedSettings(nestSettings(changed), changed, "global");
    this.schedulePersist();
    return {
      status: "applied",
      bumpRevision: true,
      output: { values: Object.fromEntries(this.effective) },
      events: [{ type: "settingsApplied", payload: this.getEffectiveSettings() }]
    };
  }

  private savePreset(preset: {
    id: string;
    name: string;
    patch: SettingsPatch;
    createdAt?: number;
  }): HandlerResult {
    const record: Preset = { ...preset, createdAt: preset.createdAt ?? this.now() };
    this.presets.set(record.id, record);
    this.schedulePersist();
    return { status: "applied", output: { preset: record }, bumpRevision: true };
  }

  private async applyPreset(
    id: string,
    scope: "session" | "media" | "global" = "session"
  ): Promise<HandlerResult> {
    const preset = this.presets.get(id);
    if (!preset) throw invalidRequest(`unknown preset: ${id}`);
    this.layers.preset.clear();
    for (const [settingId, value] of Object.entries(flattenSettingsPatch(preset.patch)) as [SettingId, unknown][]) {
      this.layers.preset.set(settingId, value);
    }
    return this.applySettings(scope, preset.patch);
  }

  private deletePreset(id: string): HandlerResult {
    if (!this.presets.delete(id)) throw invalidRequest(`unknown preset: ${id}`);
    this.schedulePersist();
    return { status: "applied", bumpRevision: true };
  }

  private addPlaylist(sources: MediaSourceInput[]): HandlerResult {
    for (const source of sources) {
      const identity = this.identityOf(source);
      const name = source.name ?? this.sourceLabel(source);
      // Adding the file that is already playing (or the URL doing so) makes its
      // new entry the current one, so the highlight and previous/next agree
      // with what the user hears.
      const playingKey = this.currentSourceKey(source);
      const isPlaying = playingKey !== undefined && this.currentMediaKey === playingKey;
      const existing = identity
        ? this.playlist.find(
            (item) => item.source.kind === "file" && item.identity === identity
          )
        : undefined;
      if (existing) {
        // Re-adding a known file refreshes its handle instead of duplicating
        // the entry, which is what a folder re-pick or relink should do.
        existing.name = name;
        existing.source = source;
        existing.identity = identity;
        existing.available = true;
        if (isPlaying) this.currentPlaylistIndex = existing.index;
        continue;
      }
      const index = this.playlist.length;
      const item: PlaylistItem = { index, name, source };
      if (identity) {
        item.identity = identity;
        item.available = true;
      }
      this.playlist.push(item);
      if (isPlaying) this.currentPlaylistIndex = index;
    }
    this.schedulePersist();
    return {
      status: "applied",
      bumpRevision: true,
      output: { items: this.playlistItems() }
    };
  }

  private movePlaylist(from: number, to: number): HandlerResult {
    const lastIndex = this.playlist.length - 1;
    if (from < 0 || from > lastIndex || to < 0 || to > lastIndex) {
      throw invalidRequest(`playlist index out of range: ${from} -> ${to}`);
    }
    const [item] = this.playlist.splice(from, 1);
    if (!item) throw invalidRequest(`playlist index out of range: ${from}`);
    this.playlist.splice(to, 0, item);
    this.playlist = this.playlist.map((entry, index) => ({ ...entry, index }));
    const current = this.currentPlaylistIndex;
    if (current === from) {
      this.currentPlaylistIndex = to;
    } else if (current !== null && from < current && to >= current) {
      this.currentPlaylistIndex = current - 1;
    } else if (current !== null && from > current && to <= current) {
      this.currentPlaylistIndex = current + 1;
    }
    this.schedulePersist();
    return {
      status: "applied",
      bumpRevision: true,
      output: { items: this.playlistItems() }
    };
  }

  private removePlaylist(index: number): HandlerResult {
    if (index < 0 || index >= this.playlist.length) throw invalidRequest(`playlist index out of range: ${index}`);
    this.playlist.splice(index, 1);
    this.playlist = this.playlist.map((item, next) => ({ ...item, index: next }));
    if (this.currentPlaylistIndex === index) {
      this.currentPlaylistIndex = null;
    } else if (this.currentPlaylistIndex !== null && index < this.currentPlaylistIndex) {
      this.currentPlaylistIndex -= 1;
    }
    this.schedulePersist();
    return {
      status: "applied",
      bumpRevision: true,
      output: { items: this.playlistItems() }
    };
  }

  private clearPlaylist(): HandlerResult {
    this.playlist = [];
    this.currentPlaylistIndex = null;
    this.schedulePersist();
    return {
      status: "applied",
      bumpRevision: true,
      output: { items: [] }
    };
  }

  private async playPlaylist(index: number): Promise<HandlerResult> {
    const item = this.playlist[index];
    if (!item) throw invalidRequest(`playlist index out of range: ${index}`);
    if (item.source.kind === "file" && !(item.source.file instanceof Blob)) {
      throw new PlayerError(
        "SOURCE_NOT_AUTHORIZED",
        `“${item.name}”是本地文件，需要在浏览器中重新选择后才能播放`,
        {
          recoverable: true,
          details: {
            relinkRequired: true,
            identity: item.identity ?? null,
            name: item.name
          }
        }
      );
    }
    this.currentPlaylistIndex = index;
    return this.openMedia({ source: item.source, autoPlay: true, fromPlaylist: true });
  }

  private playlistItems(): Record<string, unknown>[] {
    return this.playlist.map((item) => {
      const output: Record<string, unknown> = {
        index: item.index,
        name: item.name,
        kind: item.source.kind,
        available: item.available !== false
      };
      if (item.source.kind === "url" && item.source.url) output.url = item.source.url;
      if (item.source.kind === "sourceId" && item.source.sourceId) output.sourceId = item.source.sourceId;
      const identity = item.identity ?? this.identityOf(item.source);
      if (identity) output.identity = identity;
      if (item.durationUs !== undefined) output.durationUs = item.durationUs;
      return output;
    });
  }

  private sourceLabel(source: MediaSourceInput): string {
    if (source.kind === "url") return source.url ?? "remote";
    if (source.kind === "sourceId") return source.sourceId ?? "source";
    return "local-file";
  }

  private recordHistory(media: MediaInfo, source: MediaSourceInput): void {
    const existing = this.history.find((item) => item.id === media.sourceId);
    if (existing) {
      existing.lastPlayedAt = this.now();
      existing.name = media.name;
      existing.durationUs = media.durationUs;
      if (source.kind !== "file") existing.source = source;
      return;
    }
    const item: HistoryItem = {
      id: media.sourceId,
      name: media.name,
      lastPlayedAt: this.now(),
      positionUs: 0,
      durationUs: media.durationUs,
      completed: false
    };
    if (source.kind !== "file") item.source = source;
    this.history.unshift(item);
    if (this.history.length > 100) this.history.length = 100;
    this.schedulePersist();
  }

  private listHistory(limit: number): HandlerResult {
    return {
      status: "applied",
      output: { items: this.history.slice(0, limit) },
      bumpRevision: false
    };
  }

  private currentBookmarks(): Bookmark[] {
    const mediaId = this.media?.sourceId;
    if (!mediaId) return [];
    return this.bookmarks.get(mediaId) ?? [];
  }

  private listBookmarks(): HandlerResult {
    return { status: "applied", output: { items: this.currentBookmarks() }, bumpRevision: false };
  }

  private addBookmark(name: string, positionUs: number): HandlerResult {
    const media = this.media;
    if (!media) throw new PlayerError("NEEDS_MEDIA", "no media is open");
    const item: Bookmark = {
      id: `bookmark-${this.now()}-${Math.random().toString(36).slice(2, 7)}`,
      mediaId: media.sourceId,
      name,
      positionUs,
      createdAt: this.now()
    };
    const items = [...this.currentBookmarks(), item];
    this.bookmarks.set(media.sourceId, items);
    this.schedulePersist();
    return { status: "applied", output: { items }, bumpRevision: true };
  }

  private removeBookmark(id: string): HandlerResult {
    const media = this.media;
    if (!media) throw new PlayerError("NEEDS_MEDIA", "no media is open");
    const items = this.currentBookmarks().filter((item) => item.id !== id);
    this.bookmarks.set(media.sourceId, items);
    this.schedulePersist();
    return { status: "applied", output: { items }, bumpRevision: true };
  }

  private onEngineEvent(event: EngineEvent): void {
    if (this.suppressEngineEvents || this.disposed) return;
    switch (event.type) {
      case "phase": {
        this.phase = event.phase;
        this.emitEvent("phase", { phase: event.phase, previous: event.previous });
        break;
      }
      case "position": {
        this.positionUs = event.positionUs;
        this.durationUs = event.durationUs;
        this.updateHistoryPosition();
        const now = this.now();
        if (now - this.lastPositionPersistAt >= 5000) {
          this.lastPositionPersistAt = now;
          this.schedulePersist();
        }
        this.emitEvent("position", { positionUs: event.positionUs, durationUs: event.durationUs });
        break;
      }
      case "buffering": {
        this.buffering = event.buffering;
        this.emitEvent("buffering", { buffering: event.buffering, reason: event.reason ?? null });
        break;
      }
      case "trackChanged": {
        this.tracks = event.tracks;
        this.selected = event.selected;
        this.emitEvent("trackChanged", event);
        break;
      }
      case "decodePathChanged": {
        if (this.media) this.media.decodePaths = event.decodePaths;
        this.tracks = event.tracks;
        this.emitEvent("decodePathChanged", event);
        break;
      }
      case "settingsApplied": {
        for (const [id, value] of Object.entries(event.effective)) {
          if (isSettingId(id)) this.effective.set(id, value);
        }
        this.applyEffectiveToSnapshot(event.effective);
        this.emitEvent("settingsApplied", event.effective);
        break;
      }
      case "stats": {
        this.stats = event.stats;
        this.emitEvent("stats", event.stats);
        break;
      }
      case "mediaOpened": {
        this.media = event.media;
        this.tracks = event.tracks;
        this.emitEvent("mediaOpened", event);
        break;
      }
      case "mediaClosed": {
        this.media = null;
        this.currentMediaKey = undefined;
        this.tracks = [];
        this.stats = this.engine.getSnapshot().stats;
        this.emitEvent("mediaClosed", {});
        break;
      }
      case "seeked": {
        this.positionUs = event.positionUs;
        this.emitEvent("seeked", event);
        break;
      }
      case "ended": {
        this.phase = "ended";
        this.emitEvent("ended", {});
        void this.handleLoopOnEnd();
        break;
      }
      case "error": {
        this.error = event.error;
        this.phase = "error";
        this.emitEvent("error", event.error);
        break;
      }
    }
  }

  /** Auto-advance is a state change, so it joins the same serial queue. */
  private async handleLoopOnEnd(): Promise<void> {
    await this.runSerialized(() => this.advanceAfterEnd());
  }

  private async advanceAfterEnd(): Promise<void> {
    const loop = this.effective.get("playback.loop")?.effective;
    if (loop === "media") {
      try {
        await this.engine.seek(0);
        await this.engine.play();
      } catch {
        // The ended event remains authoritative; a failed loop is surfaced by
        // the engine's error event.
      }
      return;
    }
    if (
      (loop === "playlist" || loop === "order" || loop === "shuffle") &&
      this.currentPlaylistIndex !== null &&
      this.playlist.length > 0
    ) {
      let next: number;
      if (loop === "playlist") {
        next = (this.currentPlaylistIndex + 1) % this.playlist.length;
      } else if (loop === "order") {
        next = this.currentPlaylistIndex + 1;
        if (next >= this.playlist.length) return;
      } else if (this.playlist.length === 1) {
        next = 0;
      } else {
        do {
          next = Math.floor(Math.random() * this.playlist.length);
        } while (next === this.currentPlaylistIndex);
      }
      try {
        await this.playPlaylist(next);
      } catch {
        // Keep the ended event visible if the next entry cannot be opened.
      }
    }
  }

  private emitEvent(type: PlayerEventType, payload: unknown): void {
    this.eventSeq += 1;
    const event: PlayerEvent = {
      seq: this.eventSeq,
      sessionId: this.sessionId,
      type,
      at: this.now(),
      revision: this.revision,
      payload
    };
    this.events.push(event);
    if (this.events.length > this.eventBufferSize) {
      this.events.splice(0, this.events.length - this.eventBufferSize);
    }
    for (const listener of this.listeners) listener(event);
  }

  private pruneDedupe(now: number): void {
    for (const [key, entry] of this.dedupe) {
      if (now - entry.at > this.dedupeWindowMs) this.dedupe.delete(key);
    }
  }
}

export type PlayerClient = Pick<PlayerController, "invoke" | "getState" | "subscribe">;
