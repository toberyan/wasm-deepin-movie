import { z } from "zod";
import { playerErrorSchema } from "./errors";
import { CAPABILITIES, DECODE_PATHS, PLAYER_PHASES, SETTING_LAYERS, SOURCE_KINDS, TRACK_TYPES } from "./types";

export const trackTypeSchema = z.enum(TRACK_TYPES);
export const decodePathSchema = z.enum(DECODE_PATHS);
export const playerPhaseSchema = z.enum(PLAYER_PHASES);
export const sourceKindSchema = z.enum(SOURCE_KINDS);

export const colorInfoSchema = z
  .object({
    bitDepth: z.number().int().positive().optional(),
    pixelFormat: z.string().optional(),
    range: z.enum(["tv", "pc", "unknown"]).optional(),
    matrix: z.string().optional(),
    transfer: z.string().optional(),
    primaries: z.string().optional(),
    chromaSubsampling: z.string().optional(),
    inferred: z.boolean().optional()
  })
  .strict();

export const mediaStreamInfoSchema = z
  .object({
    index: z.number().int().nonnegative(),
    type: trackTypeSchema,
    codec: z.string().min(1),
    codecId: z.number().int(),
    profile: z.number().int().optional(),
    level: z.number().int().optional(),
    width: z.number().int().positive().optional(),
    height: z.number().int().positive().optional(),
    sampleRate: z.number().int().positive().optional(),
    channels: z.number().int().positive().optional(),
    channelLayout: z.string().optional(),
    language: z.string().optional(),
    title: z.string().optional(),
    default: z.boolean(),
    forced: z.boolean(),
    durationUs: z.number().nonnegative().optional(),
    timeBase: z.tuple([z.number().int().positive(), z.number().int().positive()]).optional(),
    color: colorInfoSchema.optional()
  })
  .strict();

export const trackInfoSchema = mediaStreamInfoSchema
  .extend({
    id: z.string().min(1),
    selected: z.boolean(),
    decodePath: decodePathSchema.optional(),
    acceleration: z.enum(["hardware", "software", "unknown"]).optional()
  })
  .strict();

export const chapterInfoSchema = z
  .object({
    index: z.number().int().nonnegative(),
    title: z.string().optional(),
    startUs: z.number().nonnegative(),
    endUs: z.number().nonnegative().optional()
  })
  .strict();

export const attachmentInfoSchema = z
  .object({
    index: z.number().int().nonnegative(),
    filename: z.string(),
    mimeType: z.string().optional(),
    sizeBytes: z.number().int().nonnegative()
  })
  .strict();

export const mediaInfoSchema = z
  .object({
    sourceId: z.string().min(1),
    name: z.string().min(1),
    container: z.string().optional(),
    sizeBytes: z.number().nonnegative(),
    durationUs: z.number().nonnegative(),
    seekable: z.boolean(),
    sourceKind: sourceKindSchema,
    etag: z.string().optional(),
    lastModified: z.string().optional(),
    streams: z.array(mediaStreamInfoSchema),
    chapters: z.array(chapterInfoSchema),
    attachments: z.array(attachmentInfoSchema),
    decodePaths: z.record(z.string(), decodePathSchema),
    warnings: z.array(z.string())
  })
  .strict();

export const selectedTracksSchema = z
  .object({
    video: z.number().int().nonnegative().nullable(),
    audio: z.number().int().nonnegative().nullable(),
    subtitle: z.number().int().nonnegative().nullable()
  })
  .strict();

export const playbackStatsSchema = z
  .object({
    decodedVideoFrames: z.number().int().nonnegative(),
    renderedFrames: z.number().int().nonnegative(),
    droppedVideoFrames: z.number().int().nonnegative(),
    decodedAudioFrames: z.number().int().nonnegative(),
    audioUnderruns: z.number().int().nonnegative(),
    videoQueueFrames: z.number().int().nonnegative(),
    videoQueueBytes: z.number().int().nonnegative(),
    audioBufferMs: z.number().nonnegative(),
    packetQueueBytes: z.number().int().nonnegative(),
    lastDecodeError: z.string().optional()
  })
  .strict();

export const capabilityStateSchema = z
  .object({
    available: z.boolean(),
    reason: z.string().optional(),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const capabilityReportSchema = z.record(
  z.enum(CAPABILITIES),
  capabilityStateSchema
);

export const effectiveValueSchema = z
  .object({
    requested: z.unknown(),
    effective: z.unknown(),
    status: z.enum(["applied", "applying", "failed", "unsupported"]),
    layer: z.enum(SETTING_LAYERS),
    reason: z.string().optional()
  })
  .strict();

export const jobSummarySchema = z
  .object({
    jobId: z.string().min(1),
    action: z.string().min(1),
    status: z.enum(["accepted", "running", "applied", "failed", "cancelled"]),
    progress: z
      .object({
        completed: z.number().int().nonnegative(),
        total: z.number().int().nonnegative()
      })
      .optional(),
    updatedAt: z.number()
  })
  .strict();

export const playerSnapshotSchema = z
  .object({
    sessionId: z.string().min(1),
    phase: playerPhaseSchema,
    revision: z.number().int().nonnegative(),
    eventSeq: z.number().int().nonnegative(),
    media: mediaInfoSchema.nullable(),
    tracks: z.array(trackInfoSchema),
    selected: selectedTracksSchema,
    playlistIndex: z.number().int().nonnegative().nullable(),
    jobs: z.array(jobSummarySchema),
    positionUs: z.number(),
    durationUs: z.number().nonnegative(),
    rate: z.number().positive(),
    volume: z.number().min(0).max(1),
    muted: z.boolean(),
    buffering: z.boolean(),
    settings: z.record(z.string(), effectiveValueSchema),
    capabilities: capabilityReportSchema,
    error: playerErrorSchema.nullable(),
    stats: playbackStatsSchema,
    updatedAt: z.number().nonnegative()
  })
  .strict();
