import {
  ACTION_IDS,
  type ActionId,
  type InvokeRequest,
  type InvokeResult,
  type MediaSourceInput,
  type PlayerEvent,
  type PlayerSnapshot,
  type TrackType
} from "@wasm-player/contracts";

export interface AgentInvoker {
  readonly sessionId: string;
  invoke<I = unknown, O = unknown>(request: InvokeRequest<I>): Promise<InvokeResult<O>>;
  getState(): PlayerSnapshot;
  subscribe?(listener: (event: PlayerEvent) => void): () => void;
}

export interface AgentOpenOptions {
  autoPlay?: boolean;
  startPositionUs?: number;
  forceDecodePath?: Partial<Record<TrackType, "webcodecs" | "wasm">>;
  preferredTracks?: Partial<Record<TrackType, number>>;
}

export class AgentSdk {
  private sequence = 0;
  private readonly sessionId: string;

  constructor(private readonly player: AgentInvoker) {
    this.sessionId = player.sessionId;
  }

  getState(): PlayerSnapshot {
    return this.player.getState();
  }

  subscribe(listener: (event: PlayerEvent) => void): () => void {
    return this.player.subscribe?.(listener) ?? (() => undefined);
  }

  async call<O = unknown>(
    action: ActionId,
    params: Record<string, unknown> = {},
    expectedRevision?: number
  ): Promise<InvokeResult<O>> {
    this.sequence += 1;
    const request: InvokeRequest<Record<string, unknown>> = {
      requestId: `agent-${Date.now()}-${this.sequence}`,
      sessionId: this.sessionId,
      action,
      params
    };
    if (expectedRevision !== undefined) request.expectedRevision = expectedRevision;
    return this.player.invoke<Record<string, unknown>, O>(request);
  }

  open(source: MediaSourceInput, options: AgentOpenOptions = {}): Promise<InvokeResult> {
    return this.call(ACTION_IDS.mediaOpen, { source, ...options });
  }

  play(): Promise<InvokeResult> {
    return this.call(ACTION_IDS.playbackPlay);
  }

  pause(): Promise<InvokeResult> {
    return this.call(ACTION_IDS.playbackPause);
  }

  seek(positionUs: number): Promise<InvokeResult> {
    return this.call(ACTION_IDS.playbackSeek, { positionUs });
  }

  setVolume(volume: number, muted?: boolean): Promise<InvokeResult> {
    const params: Record<string, unknown> = { volume };
    if (muted !== undefined) params.muted = muted;
    return this.call(ACTION_IDS.playbackSetVolume, params);
  }

  setRate(rate: number): Promise<InvokeResult> {
    return this.call(ACTION_IDS.playbackSetRate, { rate });
  }

  selectTrack(type: TrackType, index: number): Promise<InvokeResult> {
    return this.call(ACTION_IDS.tracksSelect, { type, index });
  }

  loadSubtitleText(text: string, name?: string): Promise<InvokeResult> {
    const params: Record<string, unknown> = { text };
    if (name !== undefined) params.name = name;
    return this.call(ACTION_IDS.subtitlesLoad, params);
  }

  capture(options: Record<string, unknown> = {}): Promise<InvokeResult> {
    return this.call(ACTION_IDS.captureCreate, options);
  }
}
