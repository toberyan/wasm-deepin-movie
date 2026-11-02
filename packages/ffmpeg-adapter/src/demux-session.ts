import LibAV from "@libav.js/variant-webcodecs";
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
  VideoCodecConfig,
  WorkerSource
} from "./protocol";

type LibAVInstance = LibAVJS.LibAV;

export interface DemuxSessionOptions {
  libavBase?: string;
  fetch?: typeof fetch;
}

export interface DemuxOpenOptions {
  name?: string;
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

function timeUs(lo: number | undefined, hi: number | undefined, tbNum: number, tbDen: number): number {
  const value = LibAV.i64tof64(lo ?? 0, hi ?? 0);
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

export class DemuxSession {
  private readonly options: DemuxSessionOptions;
  private libavBase: string | undefined;
  private libav: LibAVInstance | null = null;
  private source: SourceReader | null = null;
  private fmt = 0;
  private pkt = 0;
  private streams: LibAVJS.Stream[] = [];
  private streamByIndex = new Map<number, LibAVJS.Stream>();
  private pending: DemuxPacket[] = [];
  private probe: ProbeResult | null = null;
  private lastSourceError: SourceError | null = null;
  private closed = false;

  constructor(options: DemuxSessionOptions = {}) {
    this.options = options;
    this.libavBase = options.libavBase;
  }

  setLibavBase(base: string | undefined): void {
    if (this.libav) throw new PlayerError("BUSY", "cannot change libav base while open");
    this.libavBase = base;
  }

  async open(source: WorkerSource, options: DemuxOpenOptions = {}): Promise<ProbeResult> {
    if (this.libav) throw new PlayerError("BUSY", "demux session is already open");
    this.closed = false;
    this.lastSourceError = null;
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
      const libavOptions: { noworker: boolean; base?: string } = { noworker: true };
      if (this.libavBase) libavOptions.base = this.libavBase;
      const libav = await LibAV.LibAV(libavOptions);
      this.libav = libav;
      (globalThis as Record<string, unknown>).LibAV = LibAV;
      await libav.mkblockreaderdev("input", size);
      libav.onblockread = (name, position, length) => {
        void this.handleBlockRead(name, position, length);
      };
      const [fmt, streams] = await libav.ff_init_demuxer_file("input");
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
        details: { source: sourceName(source, "media") }
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
        eagain: false
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
    const [ret, packetsByStream] = result;
    const packets: DemuxPacket[] = [];
    for (const [streamIndex, streamPackets] of Object.entries(packetsByStream)) {
      const stream = this.streamByIndex.get(Number(streamIndex));
      if (!stream) continue;
      const type = streamType(stream.codec_type);
      if (type !== "video" && type !== "audio") continue;
      for (const packet of streamPackets) {
        const converted = this.convertPacket(stream, packet);
        if (converted) packets.push(converted);
      }
    }
    packets.sort(
      (a, b) =>
        a.dtsUs - b.dtsUs ||
        a.ptsUs - b.ptsUs ||
        a.streamIndex - b.streamIndex
    );
    this.pending = packets.slice(maxPackets);
    const output = packets.slice(0, maxPackets);
    const eof = ret === libav.AVERROR_EOF && this.pending.length === 0;
    return {
      packets: output,
      bytes: output.reduce((sum, packet) => sum + packet.data.byteLength, 0),
      eof,
      eagain: ret === -libav.EAGAIN
    };
  }

  async seek(positionUs: number): Promise<SeekResult> {
    const libav = this.requireLibav();
    if (this.fmt === 0) throw new PlayerError("NEEDS_MEDIA", "no media is open");
    if (!this.probe?.media.seekable) {
      throw new PlayerError("UNSUPPORTED", "source does not support seeking");
    }
    this.pending = [];
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
        eof: first.eof
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
      });
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
        const subtitleTrack: ProbeResult["tracks"][number] = {
          index: stream.index,
          type: "subtitle",
          codec,
          codecId: codecpar.codec_id,
          default: false,
          forced: false,
          id: `subtitle:${stream.index}`,
          selected: false
        };
        if (stream.metadata?.language !== undefined) subtitleTrack.language = stream.metadata.language;
        if (stream.metadata?.title !== undefined) subtitleTrack.title = stream.metadata.title;
        streams.push(subtitleTrack);
        tracks.push(subtitleTrack);
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
            const description = configDescription(candidate.description);
            if (description) videoConfig.description = description;
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
      ptsUs: timeUs(packet.pts, packet.ptshi, stream.time_base_num, stream.time_base_den),
      dtsUs: timeUs(packet.dts, packet.dtshi, stream.time_base_num, stream.time_base_den),
      durationUs: timeUs(packet.duration, packet.durationhi, stream.time_base_num, stream.time_base_den),
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
