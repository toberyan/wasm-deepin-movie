import LibAV from "@libav.js/variant-webcodecs";
import { loadLibAV, type LibAVWrapper } from "./libav-loader";
import * as bridge from "libavjs-webcodecs-bridge";
import type * as LibAVJS from "@libav.js/types";
import { PlayerError } from "@wasm-player/contracts";
import type { ColorInfo } from "@wasm-player/contracts";
import {
  FileSourceReader,
  HttpSourceReader,
  SourceError,
  type SourceCapabilities,
  type SourceReader
} from "@wasm-player/source-readers";
import type {
  AudioCodecConfig,
  CodecConfig,
  DemuxPacket,
  ProbeResult,
  ReadResult,
  SeekResult,
  StreamRouteCandidate,
  SubtitleExtractResult,
  AttachmentExtractResult,
  VideoCodecConfig,
  WasmAudioChunk,
  WasmVideoFrame,
  WorkerSource
} from "./protocol";

type LibAVInstance = LibAVJS.LibAV;

export interface DemuxSessionOptions {
  libavBase?: string;
  libavVariant?: string;
  libavThreads?: "st" | "mt";
  fetch?: typeof fetch;
  /**
   * libav.js 6.8.8 direct mode installs its own global onmessage handler even
   * with noworker. The owning worker uses this hook to restore its dispatcher.
   */
  onLibavReady?: () => void;
}

export interface DemuxOpenOptions {
  name?: string;
  libavThreads?: "st" | "mt";
}

const AVSEEK_FLAGS = { backward: 1 } as const;
const STREAM_TYPE_VIDEO = 0;
const STREAM_TYPE_AUDIO = 1;
const STREAM_TYPE_SUBTITLE = 3;

const COLOR_SPACE_NAMES: Record<number, string> = {
  0: "rgb",
  1: "bt709",
  2: "unknown",
  4: "fcc",
  5: "bt470bg",
  6: "smpte170m",
  7: "smpte240m",
  8: "ycgco",
  9: "bt2020nc",
  10: "bt2020c",
  11: "smpte2085",
  12: "chroma-derived-nc",
  13: "chroma-derived-c",
  14: "ictcp"
};

const COLOR_TRANSFER_NAMES: Record<number, string> = {
  1: "bt709",
  2: "unknown",
  4: "gamma22",
  5: "gamma28",
  6: "smpte170m",
  7: "smpte240m",
  8: "linear",
  9: "log100",
  10: "log316",
  11: "iec61966-2-4",
  13: "iec61966-2-1",
  14: "bt2020-10",
  15: "bt2020-12",
  16: "smpte2084",
  17: "smpte428",
  18: "arib-std-b67"
};

const COLOR_PRIMARIES_NAMES: Record<number, string> = {
  1: "bt709",
  4: "bt470m",
  5: "bt470bg",
  6: "smpte170m",
  7: "smpte240m",
  8: "film",
  9: "bt2020",
  10: "smpte428",
  11: "smpte431",
  12: "smpte432",
  22: "ebu3213"
};

const PIXEL_FORMAT_NAME_CACHE = new Map<string, string>();

function streamType(codecType: number): "video" | "audio" | "subtitle" | "data" {
  if (codecType === STREAM_TYPE_VIDEO) return "video";
  if (codecType === STREAM_TYPE_AUDIO) return "audio";
  if (codecType === STREAM_TYPE_SUBTITLE) return "subtitle";
  return "data";
}

function containerFromName(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const extension = name.split(".").pop()?.toLowerCase();
  if (!extension) return undefined;
  const map: Record<string, string> = {
    mp4: "mp4",
    m4v: "mp4",
    mov: "mov",
    mkv: "matroska",
    webm: "webm",
    avi: "avi",
    flv: "flv",
    ts: "mpegts",
    m2ts: "mpegts",
    mpg: "mpegps",
    mpeg: "mpegps",
    vob: "mpegps",
    ogv: "ogg",
    ogg: "ogg",
    flac: "flac",
    wav: "wav",
    mp3: "mp3"
  };
  return map[extension];
}

function sourceErrorToPlayerError(error: SourceError): PlayerError {
  switch (error.code) {
    case "SOURCE_CHANGED":
      return new PlayerError("SOURCE_CHANGED", error.message, { details: error.details });
    case "SOURCE_NOT_AUTHORIZED":
      return new PlayerError("SOURCE_NOT_AUTHORIZED", error.message, { details: error.details });
    case "CANCELLED":
      return new PlayerError("CANCELLED", error.message, { details: error.details });
    case "CLOSED":
      return new PlayerError("SESSION_CLOSED", error.message, { details: error.details });
    case "SOURCE_NOT_SEEKABLE":
    case "RANGE_NOT_SUPPORTED":
      return new PlayerError("UNSUPPORTED", error.message, { details: error.details });
    case "OUT_OF_RANGE":
    case "PROTOCOL_ERROR":
      return new PlayerError("DECODE_FAILED", error.message, {
        details: error.details,
        recoverable: true
      });
    case "READ_FAILED":
      return new PlayerError("DECODE_FAILED", error.message, {
        details: error.details,
        recoverable: true
      });
  }
}

function timeUs(
  wrapper: LibAVWrapper,
  lo: number | undefined,
  hi: number | undefined,
  tbNum: number,
  tbDen: number
): number {
  const value = wrapper.i64tof64(lo ?? 0, hi ?? 0);
  return Math.round((value * tbNum * 1_000_000) / tbDen);
}

function sourceName(source: WorkerSource, fallback: string): string {
  if (source.name) return source.name;
  if (source.kind === "file") return source.file.name || fallback;
  try {
    return new URL(source.url).pathname.split("/").pop() || fallback;
  } catch {
    return fallback;
  }
}

interface WasmDecoderState {
  stream: LibAVJS.Stream;
  decoder: number;
  packet: number;
  frame: number;
  nextAudioTimestampUs?: number;
  nextVideoTimestampUs?: number;
}

export class DemuxSession {
  private readonly options: DemuxSessionOptions;
  private libavBase: string | undefined;
  private libavVariant: string | undefined;
  private libavThreads: "st" | "mt" = "st";
  private libavWrapper: LibAVWrapper = LibAV;
  private libav: LibAVInstance | null = null;
  private source: SourceReader | null = null;
  private fmt = 0;
  private pkt = 0;
  private streams: LibAVJS.Stream[] = [];
  private streamByIndex = new Map<number, LibAVJS.Stream>();
  private pending: DemuxPacket[] = [];
  private wasmDecoders = new Map<number, WasmDecoderState>();
  private wasmFlushed = false;
  private probe: ProbeResult | null = null;
  private lastSourceError: SourceError | null = null;
  private closed = false;

  constructor(options: DemuxSessionOptions = {}) {
    this.options = options;
    this.libavBase = options.libavBase;
    this.libavVariant = options.libavVariant;
  }

  setLibavBase(base: string | undefined): void {
    if (this.libav) throw new PlayerError("BUSY", "cannot change libav base while open");
    this.libavBase = base;
  }

  setLibavVariant(variant: string | undefined): void {
    if (this.libav) throw new PlayerError("BUSY", "cannot change libav variant while open");
    this.libavVariant = variant;
  }

  setLibavThreads(threads: "st" | "mt" | undefined): void {
    if (this.libav) throw new PlayerError("BUSY", "cannot change libav threads while open");
    this.libavThreads = threads ?? "st";
  }

  async open(source: WorkerSource, options: DemuxOpenOptions = {}): Promise<ProbeResult> {
    if (this.libav) throw new PlayerError("BUSY", "demux session is already open");
    this.closed = false;
    this.lastSourceError = null;
    if (options.libavThreads !== undefined) this.libavThreads = options.libavThreads;
    const reader = await this.createSource(source);
    this.source = reader;
    const size = reader.getSize();
    if (size <= 0) {
      await this.close();
      throw new PlayerError("DECODE_FAILED", "source is empty");
    }
    const capabilities = reader.getCapabilities();
    const warnings: string[] = [];
    if (!capabilities.randomAccess) {
      warnings.push("source is forward-only; seeking is unavailable");
    }
    try {
      const libavOptions: { noworker: boolean; base?: string; yesthreads?: boolean } = {
        noworker: true
      };
      if (this.libavBase) libavOptions.base = this.libavBase;
      if (this.libavThreads === "mt") libavOptions.yesthreads = true;
      const wrapper = await loadLibAV({
        base: this.libavBase,
        variant: this.libavVariant
      });
      this.libavWrapper = wrapper;
      if (this.libavThreads === "mt") {
        const target = (
          wrapper as unknown as { target?: (options: { yesthreads: boolean }) => string }
        ).target?.({ yesthreads: true });
        warnings.push(`libav thread target: ${target ?? "unknown"}`);
      }
      const libav = await wrapper.LibAV(libavOptions);
      this.options.onLibavReady?.();
      this.libav = libav;
      (globalThis as Record<string, unknown>).LibAV = wrapper;
      await libav.mkblockreaderdev("input", size);
      libav.onblockread = (name, position, length) => {
        void this.handleBlockRead(name, position, length);
      };
      const [fmt, streams] = await this.initDemuxerFile(libav);
      this.fmt = fmt;
      this.streams = streams;
      this.streamByIndex = new Map(streams.map((stream) => [stream.index, stream]));
      this.pkt = await libav.av_packet_alloc();
      const probe = await this.buildProbe(source, options, capabilities, warnings);
      this.probe = probe;
      return probe;
    } catch (error) {
      await this.close();
      if (this.lastSourceError) throw sourceErrorToPlayerError(this.lastSourceError);
      if (error instanceof PlayerError) throw error;
      throw new PlayerError("DECODE_FAILED", "failed to probe media", {
        recoverable: true,
        cause: error,
        details: {
          source: sourceName(source, "media"),
          reason: error instanceof Error ? error.message : String(error)
        }
      });
    }
  }

  async read(maxBytes = 512 * 1024, maxPackets = 256): Promise<ReadResult> {
    const libav = this.requireLibav();
    if (this.closed) throw new PlayerError("SESSION_CLOSED", "demux session is closed");
    if (this.pending.length > 0) {
      const packets = this.pending.splice(0, maxPackets);
      return {
        packets,
        bytes: packets.reduce((sum, packet) => sum + packet.data.byteLength, 0),
        eof: false,
        eagain: false,
        wasmVideoFrames: [],
        wasmAudioChunks: []
      };
    }
    if (this.fmt === 0 || this.pkt === 0) throw new PlayerError("NEEDS_MEDIA", "no media is open");
    let result: [number, Record<number, LibAVJS.Packet[]>];
    try {
      result = await libav.ff_read_frame_multi(this.fmt, this.pkt, { limit: maxBytes });
    } catch (error) {
      if (this.lastSourceError) throw sourceErrorToPlayerError(this.lastSourceError);
      throw new PlayerError("DECODE_FAILED", "failed to read packets", {
        recoverable: true,
        cause: error
      });
    }
    if (this.lastSourceError) throw sourceErrorToPlayerError(this.lastSourceError);
    const [ret, packetsByStream] = result;
    const ordered: {
      stream: LibAVJS.Stream;
      raw: LibAVJS.Packet;
      converted: DemuxPacket;
    }[] = [];
    for (const [streamIndex, streamPackets] of Object.entries(packetsByStream)) {
      const stream = this.streamByIndex.get(Number(streamIndex));
      if (!stream) continue;
      const type = streamType(stream.codec_type);
      if (type !== "video" && type !== "audio") continue;
      for (const packet of streamPackets) {
        const converted = this.convertPacket(stream, packet);
        if (converted) ordered.push({ stream, raw: packet, converted });
      }
    }
    ordered.sort(
      (a, b) =>
        a.converted.dtsUs - b.converted.dtsUs ||
        a.converted.ptsUs - b.converted.ptsUs ||
        a.converted.streamIndex - b.converted.streamIndex
    );
    const packets: DemuxPacket[] = [];
    const wasmVideoFrames: WasmVideoFrame[] = [];
    const wasmAudioChunks: WasmAudioChunk[] = [];
    for (const entry of ordered) {
      const decoder = this.wasmDecoders.get(entry.stream.index);
      if (decoder) {
        await this.decodeWasmPacket(decoder, entry.raw, entry.converted, wasmVideoFrames, wasmAudioChunks);
      } else {
        packets.push(this.prepareWebCodecsPacket(entry.stream, entry.converted));
      }
    }
    const eof = ret === libav.AVERROR_EOF && packets.length === 0;
    if (eof && !this.wasmFlushed) {
      await this.flushWasmDecoders(wasmVideoFrames, wasmAudioChunks);
      this.wasmFlushed = true;
    }
    this.pending = packets.slice(maxPackets);
    const output = packets.slice(0, maxPackets);
    return {
      packets: output,
      bytes: output.reduce((sum, packet) => sum + packet.data.byteLength, 0),
      eof: eof && this.pending.length === 0,
      eagain: ret === -libav.EAGAIN,
      wasmVideoFrames,
      wasmAudioChunks
    };
  }

  async configureWasmDecoders(streamIndexes: number[]): Promise<number[]> {
    const libav = this.requireLibav();
    const configured: number[] = [];
    for (const index of streamIndexes) {
      if (this.wasmDecoders.has(index)) {
        configured.push(index);
        continue;
      }
      const stream = this.streamByIndex.get(index);
      if (!stream || (stream.codec_type !== STREAM_TYPE_VIDEO && stream.codec_type !== STREAM_TYPE_AUDIO)) {
        continue;
      }
      const [codec, decoder, packet, frame] = await libav.ff_init_decoder(stream.codec_id, {
        codecpar: stream.codecpar,
        time_base: [stream.time_base_num, stream.time_base_den]
      });
      void codec;
      this.wasmDecoders.set(index, {
        stream,
        decoder,
        packet,
        frame
      });
      configured.push(index);
    }
    return configured;
  }

  async extractAttachments(): Promise<AttachmentExtractResult[]> {
    const libav = this.requireLibav();
    const attachments: AttachmentExtractResult[] = [];
    for (const stream of this.streams) {
      if (streamType(stream.codec_type) !== "data") continue;
      const filename = stream.metadata?.filename;
      if (!filename) continue;
      const codecpar = await libav.ff_copyout_codecpar(stream.codecpar);
      if (!codecpar.extradata || codecpar.extradata.byteLength === 0) continue;
      attachments.push({
        filename,
        ...(stream.metadata?.mimetype ? { mimeType: stream.metadata.mimetype } : {}),
        data: codecpar.extradata.slice().buffer as ArrayBuffer
      });
    }
    return attachments;
  }

  async extractSubtitles(streamIndexes: number[]): Promise<SubtitleExtractResult[]> {
    const libav = this.requireLibav();
    if (this.fmt === 0 || this.pkt === 0) throw new PlayerError("NEEDS_MEDIA", "no media is open");
    const targets = streamIndexes
      .map((index) => this.streamByIndex.get(index))
      .filter((stream): stream is LibAVJS.Stream => stream !== undefined && streamType(stream.codec_type) === "subtitle");
    if (targets.length === 0) return [];
    const results = new Map<number, SubtitleExtractResult>();
    for (const stream of targets) {
      const codecpar = await libav.ff_copyout_codecpar(stream.codecpar);
      const codec = await libav.avcodec_get_name(codecpar.codec_id);
      const result: SubtitleExtractResult = {
        streamIndex: stream.index,
        codec,
        packets: []
      };
      if (codecpar.extradata && codecpar.extradata.byteLength > 0) {
        result.extradata = codecpar.extradata.slice().buffer as ArrayBuffer;
      }
      results.set(stream.index, result);
    }
    const anchor = targets.find((stream) => streamType(stream.codec_type) === "subtitle")!;
    const [lo, hi] = LibAV.f64toi64(0);
    try {
      await libav.av_seek_frame(this.fmt, anchor.index, lo, hi, AVSEEK_FLAGS.backward);
      await libav.avformat_flush(this.fmt);
      let eof = false;
      let bytes = 0;
      let iterations = 0;
      while (!eof && bytes < 8 * 1024 * 1024 && iterations < 20_000) {
        iterations += 1;
        const [ret, packetsByStream] = await libav.ff_read_frame_multi(this.fmt, this.pkt, {
          limit: 1024 * 1024
        });
        for (const [streamIndex, streamPackets] of Object.entries(packetsByStream)) {
          const result = results.get(Number(streamIndex));
          if (!result) continue;
          const stream = this.streamByIndex.get(Number(streamIndex));
          if (!stream) continue;
          for (const packet of streamPackets) {
            const data = packet.data.slice();
            result.packets.push({
              data: data.buffer as ArrayBuffer,
              ptsUs: timeUs(
                this.libavWrapper,
                packet.pts,
                packet.ptshi,
                stream.time_base_num,
                stream.time_base_den
              ),
              durationUs: timeUs(
                this.libavWrapper,
                packet.duration,
                packet.durationhi,
                stream.time_base_num,
                stream.time_base_den
              )
            });
            bytes += data.byteLength;
          }
        }
        if (ret === libav.AVERROR_EOF) eof = true;
        else if (ret === -libav.EAGAIN) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      return [...results.values()];
    } finally {
      try {
        await libav.av_seek_frame(this.fmt, anchor.index, lo, hi, AVSEEK_FLAGS.backward);
        await libav.avformat_flush(this.fmt);
      } catch {
        // The caller will surface the original extraction error.
      }
    }
  }

  async seek(positionUs: number): Promise<SeekResult> {
    const libav = this.requireLibav();
    if (this.fmt === 0) throw new PlayerError("NEEDS_MEDIA", "no media is open");
    if (!this.probe?.media.seekable) {
      throw new PlayerError("UNSUPPORTED", "source does not support seeking");
    }
    this.pending = [];
    this.lastSourceError = null;
    await this.flushWasmDecoderState();
    this.wasmFlushed = false;
    const target = this.streams.find((stream) => stream.codec_type === STREAM_TYPE_VIDEO) ??
      this.streams.find((stream) => stream.codec_type === STREAM_TYPE_AUDIO);
    if (!target) throw new PlayerError("DECODE_FAILED", "media has no seekable stream");
    const tbNum = target.time_base_num;
    const tbDen = target.time_base_den;
    const ticks = Math.max(0, Math.round((positionUs * tbDen) / (tbNum * 1_000_000)));
    const [lo, hi] = LibAV.f64toi64(ticks);
    try {
      const ret = await libav.av_seek_frame(
        this.fmt,
        target.index,
        lo,
        hi,
        AVSEEK_FLAGS.backward
      );
      if (ret < 0) {
        throw new PlayerError("DECODE_FAILED", `seek failed with code ${ret}`, {
          recoverable: true
        });
      }
      await libav.avformat_flush(this.fmt);
      const first = await this.read(128 * 1024, 8);
      const video = first.packets.find((packet) => packet.streamType === "video");
      const anchor = video ?? first.packets[0];
      const actual = anchor?.ptsUs ?? positionUs;
      return {
        requestedUs: positionUs,
        positionUs: actual,
        errorUs: actual - positionUs,
        packets: first.packets,
        eof: first.eof,
        wasmVideoFrames: first.wasmVideoFrames,
        wasmAudioChunks: first.wasmAudioChunks
      };
    } catch (error) {
      if (this.lastSourceError) throw sourceErrorToPlayerError(this.lastSourceError);
      if (error instanceof PlayerError) throw error;
      throw new PlayerError("DECODE_FAILED", "seek failed", {
        recoverable: true,
        cause: error
      });
    }
  }

  getProbe(): ProbeResult | null {
    return this.probe;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const libav = this.libav;
    const fmt = this.fmt;
    const pkt = this.pkt;
    this.libav = null;
    this.fmt = 0;
    this.pkt = 0;
    this.streams = [];
    this.streamByIndex.clear();
    this.pending = [];
    this.probe = null;
    for (const state of this.wasmDecoders.values()) {
      if (libav) {
        await libav.ff_free_decoder(state.decoder, state.packet, state.frame).catch(() => undefined);
      }
    }
    this.wasmDecoders.clear();
    if (libav) {
      try {
        if (pkt !== 0) await libav.av_packet_free(pkt);
        if (fmt !== 0) await libav.avformat_close_input_js(fmt);
      } catch {
        // Best effort; the WASM instance is terminated next.
      }
      try {
        await libav.terminate();
      } catch {
        // ignore termination errors
      }
    }
    if (this.source) {
      await this.source.close().catch(() => undefined);
      this.source = null;
    }
  }

  private async createSource(source: WorkerSource): Promise<SourceReader> {
    if (source.kind === "file") {
      return new FileSourceReader(source.file, { name: source.name });
    }
    if (source.kind === "url") {
      const reader = new HttpSourceReader({
        url: source.url,
        headers: source.headers,
        fetch: this.options.fetch,
        name: source.name
      });
      await reader.whenReady();
      return reader;
    }
    throw new PlayerError("UNSUPPORTED", "sourceId requires an authorized host broker");
  }

  private async initDemuxerFile(
    libav: LibAVInstance
  ): Promise<[number, LibAVJS.Stream[]]> {
    if (this.libavThreads !== "mt") {
      return libav.ff_init_demuxer_file("input");
    }
    // libav.js 6.8.8's threaded build has a broken ff_init_demuxer_file
    // closure: its local accessor variables are missing inside a Worker even
    // though the instance methods exist. Build the same stream list using the
    // public accessors instead of failing on AVFormatContext_nb_streams.
    const fmt = await libav.avformat_open_input_js("input", 0, 0);
    if (!fmt) throw new PlayerError("DECODE_FAILED", "could not open source file");
    const info = await libav.avformat_find_stream_info(fmt, 0);
    if (info < 0) throw new PlayerError("DECODE_FAILED", `stream info failed with code ${info}`);
    const count = await libav.AVFormatContext_nb_streams(fmt);
    const streams: LibAVJS.Stream[] = [];
    for (let index = 0; index < count; index += 1) {
      const ptr = await libav.AVFormatContext_streams_a(fmt, index);
      const codecpar = await libav.AVStream_codecpar(ptr);
      const timeBaseNum = await libav.AVStream_time_base_num(ptr);
      const timeBaseDen = await libav.AVStream_time_base_den(ptr);
      const durationTicks =
        (await libav.AVStream_duration(ptr)) +
        (await libav.AVStream_durationhi(ptr)) * 4294967296;
      const stream = {
        ptr,
        index,
        codecpar,
        codec_type: await libav.AVCodecParameters_codec_type(codecpar),
        codec_id: await libav.AVCodecParameters_codec_id(codecpar),
        time_base_num: timeBaseNum,
        time_base_den: timeBaseDen,
        duration_time_base: durationTicks,
        duration: timeBaseNum ? (durationTicks * timeBaseNum) / timeBaseDen : 0
      };
      streams.push(stream as LibAVJS.Stream);
    }
    return [fmt, streams];
  }

  private handleBlockRead(name: string, position: number, length: number): void {
    const reader = this.source;
    if (!reader) {
      this.lastSourceError = new SourceError("CLOSED", "source is closed");
      return;
    }
    void reader
      .readAt(position, Math.max(1, Math.min(length, 8 * 1024 * 1024)))
      .then((data) => {
        const libav = this.libav;
        if (!libav) return;
        return libav.ff_block_reader_dev_send(name, position, data);
      })
      .catch((error: unknown) => {
        this.lastSourceError =
          error instanceof SourceError
            ? error
            : new SourceError("READ_FAILED", error instanceof Error ? error.message : String(error));
        const libav = this.libav;
        if (libav) {
          // Release FFmpeg's pending AVIO read; the next read() surfaces the
          // typed source error instead of leaving the worker blocked forever.
          void libav.ff_block_reader_dev_send(name, position, new Uint8Array(0)).catch(() => undefined);
        }
      });
  }

  private async decodeWasmPacket(
    state: WasmDecoderState,
    raw: LibAVJS.Packet,
    packet: DemuxPacket,
    videoOut: WasmVideoFrame[],
    audioOut: WasmAudioChunk[]
  ): Promise<void> {
    const libav = this.requireLibav();
    const isVideo = packet.streamType === "video";
    if (isVideo) {
      const images = (await libav.ff_decode_multi(
        state.decoder,
        state.packet,
        state.frame,
        [raw],
        { copyoutFrame: "ImageData" }
      )) as ImageData[];
      const durationUs = packet.durationUs > 0 ? packet.durationUs : 33_333;
      const baseTimestamp = state.nextVideoTimestampUs ?? packet.ptsUs;
      images.forEach((image, index) => {
        const copy = new Uint8ClampedArray(image.data);
        videoOut.push({
          streamIndex: packet.streamIndex,
          data: copy.buffer,
          width: image.width,
          height: image.height,
          timestampUs: baseTimestamp + Math.round(index * durationUs),
          durationUs
        });
      });
      state.nextVideoTimestampUs = baseTimestamp + durationUs * Math.max(1, images.length);
      return;
    }
    const frames = (await libav.ff_decode_multi(
      state.decoder,
      state.packet,
      state.frame,
      [raw]
    )) as LibAVJS.Frame[];
    for (const frame of frames) {
      const sampleRate = frame.sample_rate ?? 48_000;
      const numberOfFrames = frame.nb_samples ?? 0;
      if (numberOfFrames <= 0) continue;
      const channels = audioFrameToFloat32(frame);
      const durationUs = Math.round((numberOfFrames / sampleRate) * 1_000_000);
      const timestampUs = state.nextAudioTimestampUs ?? packet.ptsUs;
      state.nextAudioTimestampUs = timestampUs + durationUs;
      audioOut.push({
        streamIndex: packet.streamIndex,
        timestampUs,
        sampleRate,
        numberOfFrames,
        channels: channels.map((channel) => channel.buffer as ArrayBuffer)
      });
    }
  }

  private async flushWasmDecoders(
    videoOut: WasmVideoFrame[],
    audioOut: WasmAudioChunk[]
  ): Promise<void> {
    const libav = this.requireLibav();
    for (const state of this.wasmDecoders.values()) {
      const isVideo = state.stream.codec_type === STREAM_TYPE_VIDEO;
      if (isVideo) {
        const images = (await libav.ff_decode_multi(
          state.decoder,
          state.packet,
          state.frame,
          [],
          { fin: true, copyoutFrame: "ImageData" }
        )) as ImageData[];
        const durationUs = 33_333;
        const baseTimestamp = state.nextVideoTimestampUs ?? 0;
        images.forEach((image, index) => {
          const copy = new Uint8ClampedArray(image.data);
          videoOut.push({
            streamIndex: state.stream.index,
            data: copy.buffer,
            width: image.width,
            height: image.height,
            timestampUs: baseTimestamp + index * durationUs,
            durationUs
          });
        });
        state.nextVideoTimestampUs = baseTimestamp + durationUs * Math.max(1, images.length);
      } else {
        const frames = (await libav.ff_decode_multi(
          state.decoder,
          state.packet,
          state.frame,
          [],
          { fin: true }
        )) as LibAVJS.Frame[];
        for (const frame of frames) {
          const sampleRate = frame.sample_rate ?? 48_000;
          const numberOfFrames = frame.nb_samples ?? 0;
          if (numberOfFrames <= 0) continue;
          const channels = audioFrameToFloat32(frame);
          const durationUs = Math.round((numberOfFrames / sampleRate) * 1_000_000);
          audioOut.push({
            streamIndex: state.stream.index,
            timestampUs: state.nextAudioTimestampUs ?? 0,
            sampleRate,
            numberOfFrames,
            channels: channels.map((channel) => channel.buffer as ArrayBuffer)
          });
          state.nextAudioTimestampUs = (state.nextAudioTimestampUs ?? 0) + durationUs;
        }
      }
    }
  }

  private async flushWasmDecoderState(): Promise<void> {
    if (!this.libav || this.wasmDecoders.size === 0) return;
    for (const state of this.wasmDecoders.values()) {
      await this.libav.avcodec_flush_buffers(state.decoder);
      state.nextAudioTimestampUs = undefined;
      state.nextVideoTimestampUs = undefined;
    }
  }

  private async buildProbe(
    source: WorkerSource,
    options: DemuxOpenOptions,
    capabilities: SourceCapabilities,
    warnings: string[]
  ): Promise<ProbeResult> {
    const libav = this.requireLibav();
    const name = options.name ?? sourceName(source, "media");
    const durationLo = await libav.AVFormatContext_duration(this.fmt);
    const durationHi = await libav.AVFormatContext_durationhi(this.fmt);
    let durationUs = Math.round(LibAV.i64tof64(durationLo, durationHi));
    if (!Number.isFinite(durationUs) || durationUs <= 0) {
      durationUs = Math.max(
        0,
        ...this.streams.map((stream) => Math.round((stream.duration || 0) * 1_000_000))
      );
    }
    const streams: ProbeResult["media"]["streams"] = [];
    const tracks: ProbeResult["tracks"] = [];
    const configs: Record<number, CodecConfig> = {};
    const routes: StreamRouteCandidate[] = [];
    const attachments: ProbeResult["media"]["attachments"] = [];
    const decodePaths: Record<string, "webcodecs" | "wasm"> = {};
    let firstVideo = true;
    let firstAudio = true;

    for (const stream of this.streams) {
      const codecpar = await libav.ff_copyout_codecpar(stream.codecpar);
      const codec = await libav.avcodec_get_name(codecpar.codec_id);
      const type = streamType(stream.codec_type);
      if (type === "data") {
        const filename = stream.metadata?.filename;
        if (filename) {
          attachments.push({
            index: stream.index,
            filename,
            mimeType: stream.metadata?.mimetype,
            sizeBytes: codecpar.extradata?.byteLength ?? 0
          });
        }
        continue;
      }
      if (type === "subtitle") {
        const subtitleInfo: ProbeResult["media"]["streams"][number] = {
          index: stream.index,
          type: "subtitle",
          codec,
          codecId: codecpar.codec_id,
          default: false,
          forced: false,
          timeBase: [stream.time_base_num, stream.time_base_den]
        };
        if (stream.metadata?.language !== undefined) subtitleInfo.language = stream.metadata.language;
        if (stream.metadata?.title !== undefined) subtitleInfo.title = stream.metadata.title;
        streams.push(subtitleInfo);
        tracks.push({
          ...subtitleInfo,
          id: `subtitle:${stream.index}`,
          selected: false
        });
        continue;
      }

      const color = type === "video" ? await this.describePixelFormat(codecpar.format) : undefined;
      const inferredColor =
        type === "video" && (!color || color.bitDepth === undefined)
          ? inferVideoColor(codec, codecpar.profile)
          : undefined;
      const effectiveColor: ColorInfo | undefined = color ?? inferredColor;
      if (effectiveColor) {
        if (color && inferredColor) {
          if (effectiveColor.bitDepth === undefined) effectiveColor.bitDepth = inferredColor.bitDepth;
          if (effectiveColor.pixelFormat === undefined) {
            effectiveColor.pixelFormat = inferredColor.pixelFormat;
          }
          if (effectiveColor.chromaSubsampling === undefined) {
            effectiveColor.chromaSubsampling = inferredColor.chromaSubsampling;
          }
        }
        if (inferredColor) effectiveColor.inferred = true;
        effectiveColor.range =
          codecpar.color_range === 1 ? "tv" : codecpar.color_range === 2 ? "pc" : "unknown";
        const matrix = COLOR_SPACE_NAMES[codecpar.color_space ?? 0];
        const transfer = COLOR_TRANSFER_NAMES[codecpar.color_trc ?? 0];
        const primaries = COLOR_PRIMARIES_NAMES[codecpar.color_primaries ?? 0];
        if (matrix) effectiveColor.matrix = matrix;
        if (transfer) effectiveColor.transfer = transfer;
        if (primaries) effectiveColor.primaries = primaries;
      }

      const isDefault = type === "video" ? firstVideo : firstAudio;
      if (type === "video") firstVideo = false;
      else firstAudio = false;
      const info: ProbeResult["media"]["streams"][number] = {
        index: stream.index,
        type,
        codec,
        codecId: codecpar.codec_id,
        default: isDefault,
        forced: false,
        timeBase: [stream.time_base_num, stream.time_base_den]
      };
      if (codecpar.profile !== undefined && codecpar.profile >= 0) info.profile = codecpar.profile;
      if (codecpar.level !== undefined && codecpar.level >= 0) info.level = codecpar.level;
      if (codecpar.width) info.width = codecpar.width;
      if (codecpar.height) info.height = codecpar.height;
      if (codecpar.sample_rate) info.sampleRate = codecpar.sample_rate;
      if (codecpar.channels) info.channels = codecpar.channels;
      if (stream.metadata?.language !== undefined) info.language = stream.metadata.language;
      if (stream.metadata?.title !== undefined) info.title = stream.metadata.title;
      const streamDurationUs = Math.round((stream.duration || 0) * 1_000_000);
      if (streamDurationUs > 0) info.durationUs = streamDurationUs;
      if (effectiveColor) info.color = effectiveColor;
      streams.push(info);

      let config: CodecConfig | undefined;
      try {
        if (type === "video") {
          const candidate = await bridge.videoStreamToConfig(libav, stream);
          if (candidate && candidate.codec !== "unknown") {
            const videoConfig: VideoCodecConfig = {
              type: "video",
              codec: candidate.codec,
              codedWidth: candidate.codedWidth,
              codedHeight: candidate.codedHeight
            };
            let description = configDescription(candidate.description);
            if (!description && codecpar.extradata) {
              description = codecpar.extradata.buffer.slice(
                codecpar.extradata.byteOffset,
                codecpar.extradata.byteOffset + codecpar.extradata.byteLength
              ) as ArrayBuffer;
            }
            const normalized = normalizeVideoDescription(candidate.codec, description);
            if (normalized) videoConfig.description = normalized;
            config = videoConfig;
          }
        } else {
          const candidate = await bridge.audioStreamToConfig(libav, stream);
          if (candidate && candidate.codec !== "unknown") {
            const audioConfig: AudioCodecConfig = {
              type: "audio",
              codec: candidate.codec,
              sampleRate: candidate.sampleRate,
              numberOfChannels: candidate.numberOfChannels
            };
            const description = configDescription(candidate.description);
            if (description) audioConfig.description = description;
            config = audioConfig;
          }
        }
      } catch (error) {
        warnings.push(`could not build WebCodecs config for ${type}:${stream.index}: ${String(error)}`);
      }
      if (config) configs[stream.index] = config;
      const decoder = await libav.avcodec_find_decoder(codecpar.codec_id);
      const wasm = decoder !== 0;
      const route: StreamRouteCandidate = {
        index: stream.index,
        type,
        codec,
        webcodecs: config !== undefined,
        wasm
      };
      if (!config && !wasm) route.reason = "no WebCodecs config and no WASM decoder in this variant";
      routes.push(route);
      const path = config ? "webcodecs" : "wasm";
      decodePaths[`${type}:${stream.index}`] = path;

      const track: ProbeResult["tracks"][number] = {
        ...info,
        id: `${type}:${stream.index}`,
        selected: isDefault,
        decodePath: path,
        acceleration: "unknown"
      };
      tracks.push(track);
    }

    const media: ProbeResult["media"] = {
      sourceId:
        source.kind === "file"
          ? `file:${name}:${capabilities.size}`
          : source.kind === "url"
            ? source.url
            : `source:${name}`,
      name,
      sizeBytes: capabilities.size,
      durationUs: Math.max(0, durationUs),
      seekable: capabilities.seekable,
      sourceKind: source.kind === "file" ? "file" : "http",
      streams,
      chapters: [],
      attachments,
      decodePaths,
      warnings
    };
    const container = containerFromName(name);
    if (container) media.container = container;
    if (capabilities.etag !== undefined) media.etag = capabilities.etag;
    if (capabilities.lastModified !== undefined) media.lastModified = capabilities.lastModified;

    return {
      media,
      tracks,
      configs,
      routes,
      sourceCapabilities: capabilities,
      warnings
    };
  }

  private async describePixelFormat(
    format: number
  ): Promise<ProbeResult["media"]["streams"][number]["color"] | undefined> {
    if (format < 0) return undefined;
    const libav = this.requireLibav();
    const key = `${format}`;
    const cached = PIXEL_FORMAT_NAME_CACHE.get(key);
    if (cached) {
      return {
        pixelFormat: cached,
        bitDepth: Number(key.split(":")[1] ?? 8)
      };
    }
    try {
      const descriptor = await libav.av_pix_fmt_desc_get(format);
      if (descriptor === 0) return undefined;
      const depth = await libav.AVPixFmtDescriptor_comp_depth(descriptor, 0);
      const subX = await libav.AVPixFmtDescriptor_log2_chroma_w(descriptor);
      const subY = await libav.AVPixFmtDescriptor_log2_chroma_h(descriptor);
      const components = await libav.AVPixFmtDescriptor_nb_components(descriptor);
      let pixelFormat: string;
      if (components <= 1) {
        pixelFormat = depth > 8 ? `gray${depth}le` : "gray";
      } else {
        const luma = subX ? "4" : "4";
        const chromaX = subX ? "2" : "4";
        const chromaY = subY ? "0" : "4";
        pixelFormat = `yuv${luma}${chromaX}${chromaY}p${depth > 8 ? `${depth}le` : ""}`;
      }
      PIXEL_FORMAT_NAME_CACHE.set(key, pixelFormat);
      return {
        pixelFormat,
        bitDepth: depth,
        chromaSubsampling: subX && subY ? "4:2:0" : subX ? "4:2:2" : "4:4:4"
      };
    } catch {
      return undefined;
    }
  }

  private prepareWebCodecsPacket(
    stream: LibAVJS.Stream,
    packet: DemuxPacket
  ): DemuxPacket {
    // Matroska stores H.264 as Annex B, while an avcC/avc1 WebCodecs config
    // expects 4-byte length-prefixed NAL units. MP4 packets are already in
    // that form and do not start with a start code.
    if (stream.codec_id !== 27) return packet;
    const bytes = new Uint8Array(packet.data);
    if (bytes.length < 4 || bytes[0] !== 0 || bytes[1] !== 0) return packet;
    const startsWithStartCode =
      bytes[2] === 1 || (bytes[2] === 0 && bytes[3] === 1);
    if (!startsWithStartCode) return packet;
    const converted = annexBToAvccSample(bytes);
    if (!converted) return packet;
    return {
      ...packet,
      data: converted.buffer.slice(
        converted.byteOffset,
        converted.byteOffset + converted.byteLength
      ) as ArrayBuffer
    };
  }

  private convertPacket(
    stream: LibAVJS.Stream,
    packet: LibAVJS.Packet
  ): DemuxPacket | null {
    const type = streamType(stream.codec_type);
    if (type !== "video" && type !== "audio") return null;
    const data = packet.data.slice();
    return {
      streamIndex: stream.index,
      streamType: type,
      data: data.buffer as ArrayBuffer,
      ptsUs: timeUs(this.libavWrapper, packet.pts, packet.ptshi, stream.time_base_num, stream.time_base_den),
      dtsUs: timeUs(this.libavWrapper, packet.dts, packet.dtshi, stream.time_base_num, stream.time_base_den),
      durationUs: timeUs(
        this.libavWrapper,
        packet.duration,
        packet.durationhi,
        stream.time_base_num,
        stream.time_base_den
      ),
      keyframe: ((packet.flags ?? 0) & 1) === 1,
      timeBase: [stream.time_base_num, stream.time_base_den]
    };
  }

  private requireLibav(): LibAVInstance {
    if (!this.libav) {
      throw new PlayerError("NEEDS_MEDIA", "demux session is not open");
    }
    return this.libav;
  }
}

function normalizeVideoDescription(
  codec: string,
  description: ArrayBuffer | undefined
): ArrayBuffer | undefined {
  if (!description) return undefined;
  if (!codec.startsWith("avc1") && !codec.startsWith("avc3")) return description;
  const bytes = new Uint8Array(description);
  if (bytes.length === 0 || bytes[0] === 1) return description;
  const avcC = annexBToAvcC(bytes);
  return avcC
    ? (avcC.buffer.slice(avcC.byteOffset, avcC.byteOffset + avcC.byteLength) as ArrayBuffer)
    : description;
}

function annexBToAvcC(data: Uint8Array): Uint8Array | null {
  const nalUnits: Uint8Array[] = [];
  let index = 0;
  while (index + 3 < data.length) {
    let start = -1;
    let prefix = 0;
    for (let cursor = index; cursor + 2 < data.length; cursor += 1) {
      if (data[cursor] !== 0 || data[cursor + 1] !== 0) continue;
      if (data[cursor + 2] === 1) {
        start = cursor + 3;
        prefix = 3;
        break;
      }
      if (cursor + 3 < data.length && data[cursor + 2] === 0 && data[cursor + 3] === 1) {
        start = cursor + 4;
        prefix = 4;
        break;
      }
    }
    if (start < 0) break;
    let end = data.length;
    for (let cursor = start; cursor + 2 < data.length; cursor += 1) {
      if (
        data[cursor] === 0 &&
        data[cursor + 1] === 0 &&
        (data[cursor + 2] === 1 ||
          (cursor + 3 < data.length && data[cursor + 2] === 0 && data[cursor + 3] === 1))
      ) {
        end = cursor;
        break;
      }
    }
    if (end > start) nalUnits.push(data.subarray(start, end));
    index = end > start ? end : start + prefix;
  }
  const sps = nalUnits.find((nal) => ((nal[0] ?? 0) & 0x1f) === 7);
  const pps = nalUnits.find((nal) => ((nal[0] ?? 0) & 0x1f) === 8);
  if (!sps || sps.length < 4 || !pps || pps.length === 0) return null;
  const output = new Uint8Array(11 + sps.length + pps.length);
  output[0] = 1;
  output[1] = sps[1] ?? 0;
  output[2] = sps[2] ?? 0;
  output[3] = sps[3] ?? 0;
  output[4] = 0xff;
  output[5] = 0xe1;
  output[6] = (sps.length >> 8) & 0xff;
  output[7] = sps.length & 0xff;
  output.set(sps, 8);
  let offset = 8 + sps.length;
  output[offset] = 1;
  offset += 1;
  output[offset] = (pps.length >> 8) & 0xff;
  output[offset + 1] = pps.length & 0xff;
  offset += 2;
  output.set(pps, offset);
  return output;
}

function annexBToAvccSample(data: Uint8Array): Uint8Array | null {
  const nalUnits: Uint8Array[] = [];
  let index = 0;
  while (index + 3 < data.length) {
    let start = -1;
    let prefix = 0;
    for (let cursor = index; cursor + 2 < data.length; cursor += 1) {
      if (data[cursor] !== 0 || data[cursor + 1] !== 0) continue;
      if (data[cursor + 2] === 1) {
        start = cursor + 3;
        prefix = 3;
        break;
      }
      if (cursor + 3 < data.length && data[cursor + 2] === 0 && data[cursor + 3] === 1) {
        start = cursor + 4;
        prefix = 4;
        break;
      }
    }
    if (start < 0) break;
    let end = data.length;
    for (let cursor = start; cursor + 2 < data.length; cursor += 1) {
      if (
        data[cursor] === 0 &&
        data[cursor + 1] === 0 &&
        (data[cursor + 2] === 1 ||
          (cursor + 3 < data.length && data[cursor + 2] === 0 && data[cursor + 3] === 1))
      ) {
        end = cursor;
        break;
      }
    }
    if (end > start) nalUnits.push(data.subarray(start, end));
    index = end > start ? end : start + prefix;
  }
  if (nalUnits.length === 0) return null;
  const size = nalUnits.reduce((sum, nal) => sum + 4 + nal.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const nal of nalUnits) {
    output[offset] = (nal.length >>> 24) & 0xff;
    output[offset + 1] = (nal.length >>> 16) & 0xff;
    output[offset + 2] = (nal.length >>> 8) & 0xff;
    output[offset + 3] = nal.length & 0xff;
    output.set(nal, offset + 4);
    offset += 4 + nal.length;
  }
  return output;
}

function configDescription(
  description: BufferSource | undefined
): ArrayBuffer | undefined {
  if (!description) return undefined;
  if (description instanceof ArrayBuffer) return description.slice(0);
  if (ArrayBuffer.isView(description)) {
    return description.buffer.slice(
      description.byteOffset,
      description.byteOffset + description.byteLength
    ) as ArrayBuffer;
  }
  return undefined;
}

interface InferredColor {
  bitDepth: number;
  pixelFormat: string;
  chromaSubsampling: string;
}

function inferVideoColor(codec: string, profile: number | undefined): InferredColor | undefined {
  if (codec === "h264") {
    const chroma =
      profile === 244 ? "4:4:4" : profile === 122 ? "4:2:2" : "4:2:0";
    const suffix = chroma === "4:4:4" ? "444p" : chroma === "4:2:2" ? "422p" : "420p";
    const depth = profile === 110 || profile === 122 || profile === 244 ? 10 : 8;
    return {
      bitDepth: depth,
      pixelFormat: `yuv${suffix}${depth > 8 ? `${depth}le` : ""}`,
      chromaSubsampling: chroma
    };
  }
  if (codec === "hevc") {
    const depth = profile === 2 || profile === 3 ? 10 : 8;
    return {
      bitDepth: depth,
      pixelFormat: `yuv420p${depth > 8 ? `${depth}le` : ""}`,
      chromaSubsampling: "4:2:0"
    };
  }
  if (codec === "vp9" || codec === "vp8" || codec === "av1") {
    const depth = codec === "vp9" && profile === 2 ? 10 : 8;
    return {
      bitDepth: depth,
      pixelFormat: `yuv420p${depth > 8 ? `${depth}le` : ""}`,
      chromaSubsampling: "4:2:0"
    };
  }
  return undefined;
}


type AudioSampleFormat = number;

function sampleValue(value: number, format: AudioSampleFormat): number {
  const base = format >= 5 ? format - 5 : format;
  switch (base) {
    case 0:
      return (value - 128) / 128;
    case 1:
      return value / 32768;
    case 2:
      return value / 2147483648;
    case 3:
      return value;
    case 4:
      return value;
    default:
      return value;
  }
}

function audioFrameToFloat32(frame: LibAVJS.Frame): Float32Array[] {
  const count = frame.nb_samples ?? 0;
  const channels = frame.channels ?? 1;
  const format = frame.format;
  const planar = format >= 5;
  const data = frame.data;
  const out: Float32Array[] = [];
  if (planar && Array.isArray(data)) {
    for (let channel = 0; channel < channels; channel += 1) {
      const source = data[Math.min(channel, data.length - 1)] as ArrayLike<number>;
      const target = new Float32Array(count);
      for (let index = 0; index < count; index += 1) {
        target[index] = sampleValue(Number(source[index] ?? 0), format);
      }
      out.push(target);
    }
    return out;
  }
  const packed = data as ArrayLike<number>;
  for (let channel = 0; channel < channels; channel += 1) {
    const target = new Float32Array(count);
    for (let index = 0; index < count; index += 1) {
      target[index] = sampleValue(Number(packed[index * channels + channel] ?? 0), format);
    }
    out.push(target);
  }
  return out;
}
