import { z } from "zod";
import type { CapabilityName } from "./types";
import type { PlayerEventType } from "./events";
import { playerErrorSchema } from "./errors";
import {
  attachmentInfoSchema,
  effectiveValueSchema,
  mediaInfoSchema,
  playbackStatsSchema,
  playerSnapshotSchema,
  trackInfoSchema
} from "./state-schemas";
import { SETTING_IDS, settingsPatchSchema, type SettingId } from "./settings";

export type ActionId = `${string}.${string}`;

export interface ActionDefinition {
  id: ActionId;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  inputSchema: z.ZodTypeAny;
  outputSchema: z.ZodTypeAny;
  requires: readonly CapabilityName[];
  media: "required" | "optional" | "forbidden";
  cancellable: boolean;
  longRunning: boolean;
  events: readonly PlayerEventType[];
  ui?: { group: string; keywords: readonly string[]; hidden?: boolean };
  mcp?: { tool: string };
}

export interface InvokeRequest<I = unknown> {
  requestId: string;
  sessionId: string;
  expectedRevision?: number;
  action: ActionId;
  params: I;
}

export interface InvokeResult<O = unknown> {
  requestId: string;
  sessionId: string;
  status: "applied" | "accepted" | "rejected";
  revision: number;
  requested?: unknown;
  effective?: unknown;
  jobId?: string;
  error?: import("./errors").PlayerErrorShape;
  output?: O;
}

export const ACTION_IDS = {
  mediaOpen: "media.open",
  mediaClose: "media.close",
  mediaProbe: "media.probe",
  sourcesList: "sources.list",
  playbackPlay: "playback.play",
  playbackPause: "playback.pause",
  playbackStop: "playback.stop",
  playbackSeek: "playback.seek",
  playbackStep: "playback.step",
  playbackSetRate: "playback.setRate",
  playbackSetVolume: "playback.setVolume",
  loopSet: "loop.set",
  tracksList: "tracks.list",
  tracksSelect: "tracks.select",
  settingsDescribe: "settings.describe",
  settingsGet: "settings.get",
  settingsApply: "settings.apply",
  settingsReset: "settings.reset",
  subtitlesLoad: "subtitles.load",
  stateGet: "state.get",
  eventsRead: "events.read",
  diagnosticsGet: "diagnostics.get",
  actionsList: "actions.list",
  capabilitiesGet: "capabilities.get",
  jobsGet: "jobs.get",
  jobsCancel: "jobs.cancel",
  captureCreate: "capture.create",
  uiSet: "ui.set",
  hostRequest: "host.request",
  sessionsList: "sessions.list",
  sessionsAttach: "sessions.attach",
  configExport: "config.export",
  configImport: "config.import",
  presetsList: "presets.list",
  presetsSave: "presets.save",
  presetsApply: "presets.apply",
  presetsDelete: "presets.delete",
  playlistAdd: "playlist.add",
  playlistMove: "playlist.move",
  playlistRemove: "playlist.remove",
  playlistClear: "playlist.clear",
  playlistList: "playlist.list",
  playlistPlay: "playlist.play",
  historyList: "history.list",
  bookmarksList: "bookmarks.list",
  bookmarksAdd: "bookmarks.add",
  bookmarksRemove: "bookmarks.remove"
} as const satisfies Record<string, ActionId>;

const emptyInput = z.object({}).strict();
const emptyOutput = z.object({}).strict();

export const mediaSourceSchema = z
  .object({
    kind: z.enum(["file", "url", "sourceId"]),
    file: z.unknown().optional(),
    url: z.string().url().optional(),
    sourceId: z.string().min(1).optional(),
    name: z.string().optional(),
    headers: z.record(z.string(), z.string()).optional(),
    sizeBytes: z.number().nonnegative().optional(),
    /**
     * Stable identity for local files (see `fileIdentity`). It survives a
     * restart, so a re-opened file can be matched back to its playlist entry
     * instead of matching by file name alone.
     */
    identity: z.string().min(1).max(4096).optional()
  })
  .strict()
  .superRefine((source, ctx) => {
    if (source.kind === "file" && source.file === undefined) {
      ctx.addIssue({ code: "custom", message: "file is required for kind=file", path: ["file"] });
    }
    if (source.kind === "url" && source.url === undefined) {
      ctx.addIssue({ code: "custom", message: "url is required for kind=url", path: ["url"] });
    }
    if (source.kind === "sourceId" && source.sourceId === undefined) {
      ctx.addIssue({ code: "custom", message: "sourceId is required for kind=sourceId", path: ["sourceId"] });
    }
  });

export type MediaSourceInput = z.infer<typeof mediaSourceSchema>;

export const mediaOpenInputSchema = z
  .object({
    source: mediaSourceSchema,
    autoPlay: z.boolean().optional(),
    startPositionUs: z.number().nonnegative().optional(),
    forceDecodePath: z
      .object({
        video: z.enum(["webcodecs", "wasm"]).optional(),
        audio: z.enum(["webcodecs", "wasm"]).optional()
      })
      .strict()
      .optional(),
    preferredTracks: z
      .object({
        video: z.number().int().nonnegative().optional(),
        audio: z.number().int().nonnegative().optional(),
        subtitle: z.number().int().nonnegative().optional()
      })
      .strict()
      .optional()
  })
  .strict();

export const mediaProbeInputSchema = z.object({ source: mediaSourceSchema }).strict();

export const sourcesListOutputSchema = z
  .object({
    sources: z.array(
      z
        .object({
          sourceId: z.string().min(1),
          name: z.string().min(1),
          sizeBytes: z.number().nonnegative(),
          url: z.string().optional()
        })
        .strict()
    )
  })
  .strict();

export const mediaOpenOutputSchema = z
  .object({ media: mediaInfoSchema })
  .strict();

export const seekInputSchema = z
  .object({
    positionUs: z.number().nonnegative(),
    exact: z.boolean().optional()
  })
  .strict();

export const seekOutputSchema = z
  .object({
    positionUs: z.number().nonnegative(),
    requestedUs: z.number().nonnegative(),
    errorUs: z.number()
  })
  .strict();

export const stepInputSchema = z
  .object({
    frames: z.number().int().min(1).max(600).default(1),
    direction: z.enum(["forward", "backward"]).default("forward")
  })
  .strict();

export const setRateInputSchema = z
  .object({ rate: z.number().min(0.25).max(4) })
  .strict();

export const setRateOutputSchema = z
  .object({ requested: z.number(), effective: z.number(), reason: z.string().optional() })
  .strict();

export const setVolumeInputSchema = z
  .object({ volume: z.number().min(0).max(1), muted: z.boolean().optional() })
  .strict();

export const loopSetInputSchema = z
  .object({ mode: z.enum(["off", "media", "playlist", "order", "shuffle"]) })
  .strict();

export const tracksSelectInputSchema = z
  .object({
    type: z.enum(["video", "audio", "subtitle"]),
    index: z.number().int().nonnegative()
  })
  .strict();

export const tracksListOutputSchema = z
  .object({ tracks: z.array(trackInfoSchema) })
  .strict();

export const settingsDescribeInputSchema = z
  .object({ group: z.enum(["video", "audio", "subtitle", "playback", "app"]).optional() })
  .strict();

export const settingsDescribeOutputSchema = z
  .object({
    settings: z.array(
      z
        .object({
          id: z.string().min(1),
          group: z.string().min(1),
          title: z.object({ zh: z.string(), en: z.string() }),
          description: z.object({ zh: z.string(), en: z.string() }),
          schema: z.record(z.string(), z.unknown()),
          defaultValue: z.unknown(),
          unit: z.string(),
          uiScale: z.number().optional(),
          scope: z.enum(["global", "media", "session", "preset"]),
          requiresPipelineRebuild: z.boolean(),
          requires: z.array(z.string()),
          stage: z.enum(["p0", "p1", "p2", "p3"]),
          advanced: z.boolean(),
          enumLabels: z
            .array(z.object({ value: z.union([z.string(), z.number()]), zh: z.string(), en: z.string() }))
            .optional()
        })
        .strict()
    )
  })
  .strict();

export const settingsGetInputSchema = z
  .object({ ids: z.array(z.string()).optional() })
  .strict();

export const settingsGetOutputSchema = z
  .object({ values: z.record(z.string(), effectiveValueSchema) })
  .strict();

export const settingsApplyInputSchema = z
  .object({
    scope: z.enum(["global", "media", "session", "preset"]),
    patch: settingsPatchSchema
  })
  .strict();

export const settingsApplyOutputSchema = z
  .object({
    requested: settingsPatchSchema,
    effective: z.record(z.string(), effectiveValueSchema)
  })
  .strict();

export const settingsResetInputSchema = z
  .object({
    scope: z.enum(["global", "media", "session", "preset"]),
    ids: z.array(z.string()).optional()
  })
  .strict();

export const subtitlesLoadInputSchema = z
  .object({
    file: z.unknown().optional(),
    text: z.string().optional(),
    url: z.string().url().optional(),
    name: z.string().optional(),
    encoding: z.string().optional(),
    format: z.enum(["auto", "srt", "vtt", "ass", "ssa"]).optional()
  })
  .strict()
  .superRefine((input, ctx) => {
    if (input.file === undefined && input.text === undefined && input.url === undefined) {
      ctx.addIssue({ code: "custom", message: "file, text or url is required" });
    }
  });

export const eventsReadInputSchema = z
  .object({
    afterSeq: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(1000).default(200)
  })
  .strict();

export const eventsReadOutputSchema = z
  .object({ events: z.array(z.unknown()), nextSeq: z.number().int().nonnegative() })
  .strict();

export const jobsInputSchema = z.object({ jobId: z.string().min(1) }).strict();

export const jobStatusSchema = z
  .object({
    jobId: z.string().min(1),
    action: z.string().min(1),
    status: z.enum(["accepted", "running", "applied", "failed", "cancelled"]),
    createdAt: z.number(),
    updatedAt: z.number(),
    result: z.unknown().optional(),
    error: playerErrorSchema.optional()
  })
  .strict();

export const captureCreateInputSchema = z
  .object({
    includeSubtitles: z.boolean().default(false),
    includeOsd: z.boolean().default(false),
    format: z.enum(["png", "jpeg"]).default("png"),
    quality: z.number().min(0.1).max(1).optional()
  })
  .strict();

export const captureJobOutputSchema = z
  .object({ jobId: z.string().min(1), status: z.literal("accepted") })
  .strict();

export const uiSetInputSchema = z
  .object({
    panel: z.enum(["none", "playlist", "settings"]).optional(),
    commandPalette: z.boolean().optional(),
    theme: z.enum(["system", "dark", "light"]).optional(),
    fullscreen: z.boolean().optional(),
    pictureInPicture: z.boolean().optional()
  })
  .strict();

export const hostRequestInputSchema = z
  .object({
    operation: z.enum(["pickFiles", "fullscreen", "pictureInPicture", "saveFile"]),
    params: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

export const sessionInfoSchema = z
  .object({
    sessionId: z.string().min(1),
    title: z.string().optional(),
    mediaName: z.string().optional(),
    phase: z.string().optional(),
    connectedAt: z.number().optional()
  })
  .strict();

export const sessionsListOutputSchema = z
  .object({
    sessions: z.array(sessionInfoSchema)
  })
  .strict();

export const sessionsAttachOutputSchema = z
  .object({ session: sessionInfoSchema })
  .strict();

export const configExportOutputSchema = z
  .object({
    version: z.literal(1),
    exportedAt: z.string(),
    settings: z.record(z.string(), z.unknown()),
    presets: z.array(z.unknown()).optional()
  })
  .strict();

export const configImportInputSchema = z
  .object({
    version: z.literal(1),
    settings: z.record(z.string(), z.unknown()),
    presets: z.array(z.unknown()).optional()
  })
  .strict();

export const presetSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    patch: settingsPatchSchema,
    createdAt: z.number().optional()
  })
  .strict();

export const presetsSaveInputSchema = z
  .object({ preset: presetSchema })
  .strict();

export const presetsApplyInputSchema = z
  .object({ id: z.string().min(1), scope: z.enum(["session", "media", "global"]).optional() })
  .strict();

export const presetsDeleteInputSchema = z.object({ id: z.string().min(1) }).strict();

export const playlistAddInputSchema = z
  .object({ sources: z.array(mediaSourceSchema).min(1) })
  .strict();

export const playlistMoveInputSchema = z
  .object({
    from: z.number().int().nonnegative(),
    to: z.number().int().nonnegative()
  })
  .strict();

export const playlistRemoveInputSchema = z.object({ index: z.number().int().nonnegative() }).strict();

export const playlistPlayInputSchema = z.object({ index: z.number().int().nonnegative() }).strict();

export const playlistListOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          index: z.number().int().nonnegative(),
          name: z.string(),
          sourceId: z.string().optional(),
          url: z.string().optional(),
          kind: z.enum(["file", "url", "sourceId"]).optional(),
          identity: z.string().optional(),
          available: z.boolean().optional(),
          durationUs: z.number().nonnegative().optional()
        })
        .strict()
    )
  })
  .strict();

export const historyListInputSchema = z
  .object({ limit: z.number().int().min(1).max(500).default(100) })
  .strict();

export const historyListOutputSchema = z
  .object({
    items: z.array(
      z
        .object({
          id: z.string(),
          name: z.string(),
          lastPlayedAt: z.number(),
          positionUs: z.number().nonnegative(),
          durationUs: z.number().nonnegative(),
          completed: z.boolean(),
          source: mediaSourceSchema.optional()
        })
        .strict()
    )
  })
  .strict();

export const bookmarkSchema = z
  .object({
    id: z.string().min(1),
    mediaId: z.string().min(1),
    name: z.string(),
    positionUs: z.number().nonnegative(),
    createdAt: z.number()
  })
  .strict();

export const bookmarksAddInputSchema = z
  .object({ name: z.string().min(1), positionUs: z.number().nonnegative() })
  .strict();

export const bookmarksRemoveInputSchema = z.object({ id: z.string().min(1) }).strict();

export const bookmarksListOutputSchema = z.object({ items: z.array(bookmarkSchema) }).strict();

export const stateGetOutputSchema = playerSnapshotSchema;
export const diagnosticsOutputSchema = z
  .object({
    sessionId: z.string().min(1),
    phase: z.string().min(1),
    media: mediaInfoSchema.nullable(),
    stats: playbackStatsSchema,
    capabilities: z.record(z.string(), z.unknown()),
    decodePaths: z.record(z.string(), z.string()),
    queues: z.record(z.string(), z.number()),
    warnings: z.array(z.string()),
    generatedAt: z.number()
  })
  .strict();

export const mediaAttachmentsOutputSchema = z
  .object({ attachments: z.array(attachmentInfoSchema) })
  .strict();

export const actionDescriptorSchema = z
  .object({
    id: z.string().min(1),
    title: z.object({ zh: z.string(), en: z.string() }),
    description: z.object({ zh: z.string(), en: z.string() }),
    inputSchema: z.record(z.string(), z.unknown()),
    outputSchema: z.record(z.string(), z.unknown()),
    requires: z.array(z.string()),
    media: z.enum(["required", "optional", "forbidden"]),
    cancellable: z.boolean(),
    longRunning: z.boolean(),
    events: z.array(z.string()),
    ui: z
      .object({
        group: z.string(),
        keywords: z.array(z.string()),
        hidden: z.boolean().optional()
      })
      .optional(),
    mcp: z.object({ tool: z.string().min(1) }).optional()
  })
  .strict();

export const actionsListOutputSchema = z
  .object({ actions: z.array(actionDescriptorSchema) })
  .strict();

export function settingIdFromPatchKey(group: string, key: string): SettingId | null {
  const id = `${group}.${key}`;
  return (SETTING_IDS as readonly string[]).includes(id) ? (id as SettingId) : null;
}

export { emptyInput, emptyOutput, playerSnapshotSchema, playbackStatsSchema };
