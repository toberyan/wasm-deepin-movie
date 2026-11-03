import { PlayerError } from "@wasm-player/contracts";

const WORKLET_SOURCE = `
class WasmPlayerPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.sourceRate = 48000;
    this.channelCount = 0;
    this.capacity = 0;
    this.ring = [];
    this.writeFrame = 0;
    this.readFrame = 0;
    this.bufferStartUs = 0;
    this.hasTimestamp = false;
    this.rate = 1;
    this.gain = 1;
    this.playing = false;
    this.buffering = true;
    this.lastClockSec = -1;
    this.lastUnderrun = false;
    this.generation = 0;
    this.port.onmessage = (event) => this.onMessage(event.data);
  }

  configure(message) {
    this.sourceRate = message.sampleRate;
    this.channelCount = message.channels;
    this.capacity = message.capacityFrames;
    this.ring = Array.from({ length: this.channelCount }, () => new Float32Array(this.capacity));
    this.writeFrame = 0;
    this.readFrame = 0;
    this.bufferStartUs = 0;
    this.hasTimestamp = false;
    this.buffering = true;
  }

  append(message) {
    const channels = message.channels.map((buffer) => new Float32Array(buffer));
    const frames = channels[0] ? channels[0].length : 0;
    if (frames === 0) return;
    if (!this.hasTimestamp) {
      this.bufferStartUs = message.timestampUs;
      this.hasTimestamp = true;
    }
    const available = this.writeFrame - this.readFrame;
    if (available + frames > this.capacity) {
      const drop = Math.ceil(available + frames - this.capacity);
      this.readFrame += drop;
      this.port.postMessage({ type: "overflow", droppedFrames: drop });
    }
    for (let i = 0; i < frames; i += 1) {
      const index = (this.writeFrame + i) % this.capacity;
      for (let channel = 0; channel < this.channelCount; channel += 1) {
        const source = channels[Math.min(channel, channels.length - 1)];
        this.ring[channel][index] = source ? source[i] : 0;
      }
    }
    this.writeFrame += frames;
    if (this.buffering) {
      this.buffering = false;
      this.port.postMessage({ type: "buffering", buffering: false });
    }
  }

  flush(message) {
    this.writeFrame = 0;
    this.readFrame = 0;
    this.bufferStartUs = typeof message.timestampUs === "number" ? message.timestampUs : 0;
    this.hasTimestamp = typeof message.timestampUs === "number";
    this.buffering = true;
    this.lastUnderrun = false;
    this.generation = typeof message.generation === "number" ? message.generation : this.generation + 1;
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || output.length === 0) return true;
    const frames = output[0].length;
    const available = this.writeFrame - this.readFrame;
    if (!this.playing || available < 1) {
      for (const channel of output) channel.fill(0);
      if (this.playing && available < 1 && !this.lastUnderrun) {
        this.lastUnderrun = true;
        this.buffering = true;
        this.port.postMessage({ type: "underrun" });
      }
      this.postClock();
      return true;
    }
    this.lastUnderrun = false;
    for (let i = 0; i < frames; i += 1) {
      const position = this.readFrame;
      const index = Math.floor(position);
      const fraction = position - index;
      const i0 = index % this.capacity;
      const i1 = (index + 1) % this.capacity;
      for (let channel = 0; channel < output.length; channel += 1) {
        const ring = this.ring[Math.min(channel, this.ring.length - 1)];
        const a = ring[i0];
        const b = ring[i1];
        const sample = (a + (b - a) * fraction) * this.gain;
        output[channel][i] = Math.max(-1, Math.min(1, sample));
      }
      this.readFrame += this.rate;
    }
    this.postClock();
    return true;
  }

  postClock() {
    if (currentTime - this.lastClockSec < 0.05) return;
    this.lastClockSec = currentTime;
    const mediaTimeUs = this.bufferStartUs + (this.readFrame / this.sourceRate) * 1000000;
    this.port.postMessage({
      type: "clock",
      mediaTimeUs,
      atSec: currentTime,
      playing: this.playing,
      generation: this.generation,
      buffering: this.writeFrame - this.readFrame < this.sourceRate * 0.05
    });
  }

  onMessage(message) {
    switch (message.type) {
      case "configure":
        this.configure(message);
        return;
      case "append":
        this.append(message);
        return;
      case "flush":
        this.flush(message);
        return;
      case "playing":
        this.playing = message.value;
        this.port.postMessage({ type: "playing", value: this.playing });
        return;
      case "rate":
        this.rate = message.value;
        return;
      case "gain":
        this.gain = message.value;
        return;
    }
  }
}
registerProcessor("wasm-player-pcm", WasmPlayerPcmProcessor);
`;

export interface AudioOutputOptions {
  sampleRate: number;
  channels: number;
  capacitySeconds?: number;
}

export interface AudioClockSample {
  mediaTimeUs: number;
  atSec: number;
  playing: boolean;
  buffering: boolean;
}

export class AudioOutput {
  private readonly options: AudioOutputOptions;
  private context: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private gain: GainNode | null = null;
  private panner: StereoPannerNode | null = null;
  private gainDb = 0;
  private balance = 0;
  private workletUrl: string | null = null;
  private configuredChannels = 0;
  private latestClock: AudioClockSample | null = null;
  private generation = 0;
  private volume = 1;
  private muted = false;
  private rate = 1;
  private onUnderrun: (() => void) | null = null;

  constructor(options: AudioOutputOptions) {
    this.options = options;
    this.configuredChannels = options.channels;
  }

  get isStarted(): boolean {
    return this.context !== null;
  }

  get sampleRate(): number {
    return this.options.sampleRate;
  }

  async start(): Promise<void> {
    if (this.context) return;
    const context = new AudioContext({
      sampleRate: this.options.sampleRate,
      latencyHint: "interactive"
    });
    this.context = context;
    const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
    this.workletUrl = URL.createObjectURL(blob);
    await context.audioWorklet.addModule(this.workletUrl);
    this.createGraph();
  }

  async resume(): Promise<void> {
    await this.start();
    const context = this.context;
    if (!context) throw new PlayerError("INTERNAL", "audio context was not created");
    if (context.state === "suspended") {
      await context.resume();
    }
    if (context.state !== "running") {
      throw new PlayerError("NEEDS_USER_GESTURE", "browser blocked audio until a user gesture");
    }
  }

  append(channels: Float32Array[], timestampUs: number): void {
    const context = this.context;
    const node = this.node;
    if (!context || !node) return;
    if (channels.length !== this.configuredChannels) {
      // Rebuilding the worklet graph keeps channel counts consistent. This is
      // rare (track change) and happens before the next append.
      this.configuredChannels = channels.length;
      node.disconnect();
      this.createGraph(channels.length);
    }
    const buffers = channels.map((channel) => channel.buffer);
    node.port.postMessage(
      {
        type: "append",
        timestampUs,
        channels: buffers
      },
      buffers
    );
  }

  flush(timestampUs?: number): void {
    this.generation += 1;
    this.node?.port.postMessage({ type: "flush", timestampUs, generation: this.generation });
    this.latestClock = null;
  }

  setPaused(paused: boolean): void {
    this.node?.port.postMessage({ type: "playing", value: !paused });
  }

  setRate(rate: number): void {
    this.rate = rate;
    this.node?.port.postMessage({ type: "rate", value: rate });
  }

  setVolume(volume: number, muted = false): void {
    this.volume = Math.min(1, Math.max(0, volume));
    this.muted = muted;
    const gain = this.gain;
    const context = this.context;
    if (gain && context) {
      gain.gain.setTargetAtTime(this.muted ? 0 : this.volume, context.currentTime, 0.02);
    }
  }

  setGainDb(gainDb: number): void {
    this.gainDb = Math.max(-24, Math.min(12, gainDb));
    this.node?.port.postMessage({ type: "gain", value: 10 ** (this.gainDb / 20) });
  }

  setBalance(balance: number): void {
    this.balance = Math.max(-1, Math.min(1, balance));
    const panner = this.panner;
    const context = this.context;
    if (panner && context) {
      panner.pan.setTargetAtTime(this.balance, context.currentTime, 0.02);
    }
  }

  setUnderrunHandler(handler: () => void): void {
    this.onUnderrun = handler;
  }

  getClock(): AudioClockSample | null {
    const latest = this.latestClock;
    const context = this.context;
    if (!latest || !context) return latest;
    if (!latest.playing) return latest;
    const elapsed = Math.max(0, context.currentTime - latest.atSec);
    return {
      ...latest,
      mediaTimeUs: latest.mediaTimeUs + elapsed * this.rate * 1_000_000
    };
  }

  getContext(): AudioContext | null {
    return this.context;
  }

  async close(): Promise<void> {
    this.node?.disconnect();
    this.gain?.disconnect();
    this.panner?.disconnect();
    this.node = null;
    this.gain = null;
    this.panner = null;
    if (this.context) {
      await this.context.close().catch(() => undefined);
      this.context = null;
    }
    if (this.workletUrl) {
      URL.revokeObjectURL(this.workletUrl);
      this.workletUrl = null;
    }
    this.latestClock = null;
  }

  private createGraph(channels = this.configuredChannels): void {
    const context = this.context;
    if (!context) return;
    const node = new AudioWorkletNode(context, "wasm-player-pcm", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [Math.max(1, Math.min(8, channels))]
    });
    const gain = context.createGain();
    gain.gain.value = this.muted ? 0 : this.volume;
    const panner = context.createStereoPanner();
    panner.pan.value = this.balance;
    node.connect(gain);
    gain.connect(panner);
    panner.connect(context.destination);
    node.port.onmessage = (event: MessageEvent<{
      type: string;
      mediaTimeUs?: number;
      atSec?: number;
      playing?: boolean;
      buffering?: boolean;
      generation?: number;
    }>) => {
      const message = event.data;
      if (message.type === "clock" && message.mediaTimeUs !== undefined) {
        if ((message.generation ?? 0) !== this.generation) return;
        this.latestClock = {
          mediaTimeUs: message.mediaTimeUs,
          atSec: message.atSec ?? 0,
          playing: message.playing ?? false,
          buffering: message.buffering ?? false
        };
        return;
      }
      if (message.type === "underrun") this.onUnderrun?.();
    };
    node.port.postMessage({
      type: "configure",
      sampleRate: this.options.sampleRate,
      channels: Math.max(1, Math.min(8, channels)),
      capacityFrames: Math.max(
        4096,
        Math.ceil(this.options.sampleRate * (this.options.capacitySeconds ?? 2))
      )
    });
    node.port.postMessage({ type: "gain", value: 10 ** (this.gainDb / 20) });
    this.node = node;
    this.gain = gain;
    this.panner = panner;
  }
}
