import { z } from "zod";
import { zodToJsonSchema, type JsonSchema } from "./schema";
import type { CapabilityName } from "./types";

export const SETTING_SCOPES = ["global", "media", "session", "preset"] as const;
export type SettingScope = (typeof SETTING_SCOPES)[number];

export const SETTING_UNITS = [
  "ratio",
  "percent",
  "db",
  "ms",
  "deg",
  "px",
  "times",
  "boolean",
  "enum",
  "object",
  "string"
] as const;
export type SettingUnit = (typeof SETTING_UNITS)[number];

export const SETTING_STAGES = ["p0", "p1", "p2", "p3"] as const;
export type SettingStage = (typeof SETTING_STAGES)[number];

const ratioSigned = z.number().min(-1).max(1);
const unitInterval = z.number().min(0).max(1);
const cropSchema = z
  .object({
    left: unitInterval,
    top: unitInterval,
    right: unitInterval,
    bottom: unitInterval
  })
  .strict()
  .refine((value) => value.left + value.right < 1, {
    message: "horizontal crop must leave a visible area",
    path: ["right"]
  })
  .refine((value) => value.top + value.bottom < 1, {
    message: "vertical crop must leave a visible area",
    path: ["bottom"]
  });

/**
 * One canonical schema per public setting ID. IDs are stable dotted strings
 * shared by UI, SDK, MCP and persisted configuration.
 */
export const settingValueSchemas = {
  "video.brightness": z.number().min(-1).max(1),
  "video.contrast": z.number().min(0).max(2),
  "video.saturation": z.number().min(0).max(2),
  "video.gamma": z.number().min(0.1).max(5),
  "video.hueDeg": z.number().min(-180).max(180),
  "video.rotationDeg": z.union([z.literal(0), z.literal(90), z.literal(180), z.literal(270)]),
  "video.fit": z.enum(["contain", "cover", "fill", "original"]),
  "video.crop": cropSchema,
  "video.sharpness": z.number().min(0).max(1),
  "video.scaleMode": z.enum(["nearest", "bilinear", "high-quality"]),
  "audio.volume": z.number().min(0).max(1),
  "audio.gainDb": z.number().min(-24).max(12),
  "audio.muted": z.boolean(),
  "audio.balance": ratioSigned,
  "audio.delayMs": z.number().min(-10000).max(10000),
  "audio.eq": z.array(z.number().min(-12).max(12)).length(10),
  "audio.deviceId": z.string().max(512),
  "subtitle.delayMs": z.number().min(-10000).max(10000),
  "subtitle.visible": z.boolean(),
  "subtitle.fontSizePct": z.number().min(50).max(250),
  "subtitle.forceStyle": z.boolean(),
  "playback.rate": z.number().min(0.25).max(4),
  "playback.loop": z.enum(["off", "media", "playlist"]),
  "playback.autoPlay": z.boolean(),
  "playback.volumeStep": z.number().min(0.01).max(0.5),
  "app.theme": z.enum(["system", "dark", "light"]),
  "app.reduceMotion": z.boolean(),
  "app.showStats": z.boolean(),
  "app.panel": z.enum(["none", "playlist", "settings"])
} as const;

export type SettingId = keyof typeof settingValueSchemas;
export type SettingValueFor<Id extends SettingId> = z.infer<(typeof settingValueSchemas)[Id]>;

export interface SettingDefinition {
  id: SettingId;
  group: "video" | "audio" | "subtitle" | "playback" | "app";
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  schema: z.ZodTypeAny;
  defaultValue: unknown;
  unit: SettingUnit;
  uiScale?: number;
  scope: SettingScope;
  requiresPipelineRebuild: boolean;
  requires: readonly CapabilityName[];
  stage: SettingStage;
  advanced: boolean;
  enumLabels?: readonly { value: string | number; zh: string; en: string }[];
}

const cropDefault = { left: 0, top: 0, right: 0, bottom: 0 };

export const SETTING_DEFINITIONS: Record<SettingId, SettingDefinition> = {
  "video.brightness": {
    id: "video.brightness",
    group: "video",
    title: { zh: "亮度", en: "Brightness" },
    description: { zh: "在 SDR 调色域中增加亮度偏移。", en: "Brightness offset in the SDR grade domain." },
    schema: settingValueSchemas["video.brightness"],
    defaultValue: 0,
    unit: "ratio",
    uiScale: 100,
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false
  },
  "video.contrast": {
    id: "video.contrast",
    group: "video",
    title: { zh: "对比度", en: "Contrast" },
    description: { zh: "中性值为 1。", en: "Neutral value is 1." },
    schema: settingValueSchemas["video.contrast"],
    defaultValue: 1,
    unit: "ratio",
    uiScale: 100,
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false
  },
  "video.saturation": {
    id: "video.saturation",
    group: "video",
    title: { zh: "饱和度", en: "Saturation" },
    description: { zh: "中性值为 1。", en: "Neutral value is 1." },
    schema: settingValueSchemas["video.saturation"],
    defaultValue: 1,
    unit: "ratio",
    uiScale: 100,
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false
  },
  "video.gamma": {
    id: "video.gamma",
    group: "video",
    title: { zh: "Gamma", en: "Gamma" },
    description: { zh: "输出等于输入的 1/gamma 次方；大于 1 提亮。", en: "Output equals input^(1/gamma); above 1 brightens." },
    schema: settingValueSchemas["video.gamma"],
    defaultValue: 1,
    unit: "ratio",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "video.hueDeg": {
    id: "video.hueDeg",
    group: "video",
    title: { zh: "色相", en: "Hue" },
    description: { zh: "色相旋转角度。", en: "Hue rotation in degrees." },
    schema: settingValueSchemas["video.hueDeg"],
    defaultValue: 0,
    unit: "deg",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "video.rotationDeg": {
    id: "video.rotationDeg",
    group: "video",
    title: { zh: "旋转", en: "Rotation" },
    description: { zh: "顺时针旋转角度。", en: "Clockwise rotation." },
    schema: settingValueSchemas["video.rotationDeg"],
    defaultValue: 0,
    unit: "deg",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true,
    enumLabels: [
      { value: 0, zh: "0°", en: "0°" },
      { value: 90, zh: "90°", en: "90°" },
      { value: 180, zh: "180°", en: "180°" },
      { value: 270, zh: "270°", en: "270°" }
    ]
  },
  "video.fit": {
    id: "video.fit",
    group: "video",
    title: { zh: "画面适配", en: "Fit" },
    description: { zh: "适应窗口、填满、拉伸或原始尺寸。", en: "Contain, cover, fill or original size." },
    schema: settingValueSchemas["video.fit"],
    defaultValue: "contain",
    unit: "enum",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: false,
    enumLabels: [
      { value: "contain", zh: "适应窗口", en: "Contain" },
      { value: "cover", zh: "填满窗口", en: "Cover" },
      { value: "fill", zh: "拉伸", en: "Fill" },
      { value: "original", zh: "原始尺寸", en: "Original" }
    ]
  },
  "video.crop": {
    id: "video.crop",
    group: "video",
    title: { zh: "裁切", en: "Crop" },
    description: { zh: "以源画面为基准的归一化边距。", en: "Normalized margins relative to the source frame." },
    schema: settingValueSchemas["video.crop"],
    defaultValue: cropDefault,
    unit: "object",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "video.sharpness": {
    id: "video.sharpness",
    group: "video",
    title: { zh: "锐化", en: "Sharpen" },
    description: { zh: "轻量锐化强度。", en: "Lightweight sharpening strength." },
    schema: settingValueSchemas["video.sharpness"],
    defaultValue: 0,
    unit: "ratio",
    uiScale: 100,
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "video.scaleMode": {
    id: "video.scaleMode",
    group: "video",
    title: { zh: "缩放方式", en: "Scaling" },
    description: { zh: "画面缩放采样方式。", en: "Scaling filter." },
    schema: settingValueSchemas["video.scaleMode"],
    defaultValue: "high-quality",
    unit: "enum",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true,
    enumLabels: [
      { value: "nearest", zh: "最近邻", en: "Nearest" },
      { value: "bilinear", zh: "双线性", en: "Bilinear" },
      { value: "high-quality", zh: "高质量", en: "High quality" }
    ]
  },
  "audio.volume": {
    id: "audio.volume",
    group: "audio",
    title: { zh: "音量", en: "Volume" },
    description: { zh: "主音量，0 至 1。", en: "Master volume, 0 to 1." },
    schema: settingValueSchemas["audio.volume"],
    defaultValue: 1,
    unit: "ratio",
    uiScale: 100,
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false
  },
  "audio.gainDb": {
    id: "audio.gainDb",
    group: "audio",
    title: { zh: "增益", en: "Gain" },
    description: { zh: "额外增益，输出带防削波处理。", en: "Additional gain with clipping protection." },
    schema: settingValueSchemas["audio.gainDb"],
    defaultValue: 0,
    unit: "db",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "audio.muted": {
    id: "audio.muted",
    group: "audio",
    title: { zh: "静音", en: "Mute" },
    description: { zh: "静音但不停止时钟推进。", en: "Mute audio while the timeline continues." },
    schema: settingValueSchemas["audio.muted"],
    defaultValue: false,
    unit: "boolean",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: false
  },
  "audio.balance": {
    id: "audio.balance",
    group: "audio",
    title: { zh: "左右平衡", en: "Balance" },
    description: { zh: "-1 为左，1 为右。", en: "-1 is left, 1 is right." },
    schema: settingValueSchemas["audio.balance"],
    defaultValue: 0,
    unit: "ratio",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "audio.delayMs": {
    id: "audio.delayMs",
    group: "audio",
    title: { zh: "音频延迟", en: "Audio delay" },
    description: { zh: "正值使音频更晚呈现。", en: "Positive values present audio later." },
    schema: settingValueSchemas["audio.delayMs"],
    defaultValue: 0,
    unit: "ms",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "audio.eq": {
    id: "audio.eq",
    group: "audio",
    title: { zh: "10 段均衡器", en: "10-band equalizer" },
    description: { zh: "各频段增益，单位 dB。", en: "Per-band gain in dB." },
    schema: settingValueSchemas["audio.eq"],
    defaultValue: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    unit: "db",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "audio.deviceId": {
    id: "audio.deviceId",
    group: "audio",
    title: { zh: "输出设备", en: "Output device" },
    description: { zh: "浏览器允许时选择音频输出设备。", en: "Select an audio output device when the browser permits it." },
    schema: settingValueSchemas["audio.deviceId"],
    defaultValue: "",
    unit: "string",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "subtitle.delayMs": {
    id: "subtitle.delayMs",
    group: "subtitle",
    title: { zh: "字幕延迟", en: "Subtitle delay" },
    description: { zh: "正值使字幕更晚呈现。", en: "Positive values present subtitles later." },
    schema: settingValueSchemas["subtitle.delayMs"],
    defaultValue: 0,
    unit: "ms",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false
  },
  "subtitle.visible": {
    id: "subtitle.visible",
    group: "subtitle",
    title: { zh: "显示字幕", en: "Show subtitles" },
    description: { zh: "临时隐藏字幕，不卸载轨道。", en: "Temporarily hide subtitles without unloading the track." },
    schema: settingValueSchemas["subtitle.visible"],
    defaultValue: true,
    unit: "boolean",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: false
  },
  "subtitle.fontSizePct": {
    id: "subtitle.fontSizePct",
    group: "subtitle",
    title: { zh: "字号", en: "Font size" },
    description: { zh: "相对默认字号的比例。", en: "Relative to the default font size." },
    schema: settingValueSchemas["subtitle.fontSizePct"],
    defaultValue: 100,
    unit: "percent",
    uiScale: 1,
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: false
  },
  "subtitle.forceStyle": {
    id: "subtitle.forceStyle",
    group: "subtitle",
    title: { zh: "强制字幕样式", en: "Force subtitle style" },
    description: { zh: "覆盖 ASS 原样式；默认尊重原样式。", en: "Override ASS styles; original styles are respected by default." },
    schema: settingValueSchemas["subtitle.forceStyle"],
    defaultValue: false,
    unit: "boolean",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p2",
    advanced: true
  },
  "playback.rate": {
    id: "playback.rate",
    group: "playback",
    title: { zh: "播放速度", en: "Playback rate" },
    description: { zh: "请求倍速，实际范围受性能约束。", en: "Requested rate; effective range depends on performance." },
    schema: settingValueSchemas["playback.rate"],
    defaultValue: 1,
    unit: "times",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false
  },
  "playback.loop": {
    id: "playback.loop",
    group: "playback",
    title: { zh: "循环", en: "Loop" },
    description: { zh: "关闭、单文件循环或列表循环。", en: "Off, single media or playlist loop." },
    schema: settingValueSchemas["playback.loop"],
    defaultValue: "off",
    unit: "enum",
    scope: "global",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: false,
    enumLabels: [
      { value: "off", zh: "关闭", en: "Off" },
      { value: "media", zh: "单文件", en: "Media" },
      { value: "playlist", zh: "列表", en: "Playlist" }
    ]
  },
  "playback.autoPlay": {
    id: "playback.autoPlay",
    group: "playback",
    title: { zh: "自动播放", en: "Autoplay" },
    description: { zh: "打开媒体后尝试自动播放，可能受用户激活限制。", en: "Try to play after opening; user activation may be required." },
    schema: settingValueSchemas["playback.autoPlay"],
    defaultValue: false,
    unit: "boolean",
    scope: "global",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: false
  },
  "playback.volumeStep": {
    id: "playback.volumeStep",
    group: "playback",
    title: { zh: "音量步进", en: "Volume step" },
    description: { zh: "键盘音量调整步长。", en: "Keyboard volume adjustment step." },
    schema: settingValueSchemas["playback.volumeStep"],
    defaultValue: 0.05,
    unit: "ratio",
    uiScale: 100,
    scope: "global",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: true
  },
  "app.theme": {
    id: "app.theme",
    group: "app",
    title: { zh: "主题", en: "Theme" },
    description: { zh: "界面主题。", en: "Interface theme." },
    schema: settingValueSchemas["app.theme"],
    defaultValue: "dark",
    unit: "enum",
    scope: "global",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false,
    enumLabels: [
      { value: "system", zh: "跟随系统", en: "System" },
      { value: "dark", zh: "深色", en: "Dark" },
      { value: "light", zh: "浅色", en: "Light" }
    ]
  },
  "app.reduceMotion": {
    id: "app.reduceMotion",
    group: "app",
    title: { zh: "减少动态效果", en: "Reduce motion" },
    description: { zh: "减少界面动画。", en: "Reduce interface animation." },
    schema: settingValueSchemas["app.reduceMotion"],
    defaultValue: false,
    unit: "boolean",
    scope: "global",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: true
  },
  "app.showStats": {
    id: "app.showStats",
    group: "app",
    title: { zh: "显示统计", en: "Show stats" },
    description: { zh: "显示解码路径、队列与掉帧统计。", en: "Show decode path, queues and dropped frames." },
    schema: settingValueSchemas["app.showStats"],
    defaultValue: false,
    unit: "boolean",
    scope: "global",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p1",
    advanced: true
  },
  "app.panel": {
    id: "app.panel",
    group: "app",
    title: { zh: "侧栏", en: "Side panel" },
    description: { zh: "当前打开的侧栏面板。", en: "Currently open side panel." },
    schema: settingValueSchemas["app.panel"],
    defaultValue: "none",
    unit: "enum",
    scope: "session",
    requiresPipelineRebuild: false,
    requires: [],
    stage: "p0",
    advanced: false,
    enumLabels: [
      { value: "none", zh: "无", en: "None" },
      { value: "playlist", zh: "列表", en: "Playlist" },
      { value: "settings", zh: "设置", en: "Settings" }
    ]
  }
};

export const SETTING_IDS = Object.keys(SETTING_DEFINITIONS) as SettingId[];

export const DEFAULT_SETTINGS: Readonly<Record<SettingId, unknown>> = Object.fromEntries(
  SETTING_IDS.map((id) => [id, SETTING_DEFINITIONS[id].defaultValue])
) as Record<SettingId, unknown>;

export function isSettingId(value: string): value is SettingId {
  return Object.prototype.hasOwnProperty.call(SETTING_DEFINITIONS, value);
}

export function getSettingDefinition(id: SettingId): SettingDefinition {
  return SETTING_DEFINITIONS[id];
}

export function getSettingDefault(id: SettingId): unknown {
  return SETTING_DEFINITIONS[id].defaultValue;
}

export function validateSettingValue(id: SettingId, value: unknown): unknown {
  return settingValueSchemas[id].parse(value);
}

export function settingGroup(id: SettingId): SettingDefinition["group"] {
  return SETTING_DEFINITIONS[id].group;
}

const videoPatchSchema = z
  .object({
    brightness: settingValueSchemas["video.brightness"].optional(),
    contrast: settingValueSchemas["video.contrast"].optional(),
    saturation: settingValueSchemas["video.saturation"].optional(),
    gamma: settingValueSchemas["video.gamma"].optional(),
    hueDeg: settingValueSchemas["video.hueDeg"].optional(),
    rotationDeg: settingValueSchemas["video.rotationDeg"].optional(),
    fit: settingValueSchemas["video.fit"].optional(),
    crop: settingValueSchemas["video.crop"].optional(),
    sharpness: settingValueSchemas["video.sharpness"].optional(),
    scaleMode: settingValueSchemas["video.scaleMode"].optional()
  })
  .strict();

const audioPatchSchema = z
  .object({
    volume: settingValueSchemas["audio.volume"].optional(),
    gainDb: settingValueSchemas["audio.gainDb"].optional(),
    muted: settingValueSchemas["audio.muted"].optional(),
    balance: settingValueSchemas["audio.balance"].optional(),
    delayMs: settingValueSchemas["audio.delayMs"].optional(),
    eq: settingValueSchemas["audio.eq"].optional(),
    deviceId: settingValueSchemas["audio.deviceId"].optional()
  })
  .strict();

const subtitlePatchSchema = z
  .object({
    delayMs: settingValueSchemas["subtitle.delayMs"].optional(),
    visible: settingValueSchemas["subtitle.visible"].optional(),
    fontSizePct: settingValueSchemas["subtitle.fontSizePct"].optional(),
    forceStyle: settingValueSchemas["subtitle.forceStyle"].optional()
  })
  .strict();

const playbackPatchSchema = z
  .object({
    rate: settingValueSchemas["playback.rate"].optional(),
    loop: settingValueSchemas["playback.loop"].optional(),
    autoPlay: settingValueSchemas["playback.autoPlay"].optional(),
    volumeStep: settingValueSchemas["playback.volumeStep"].optional()
  })
  .strict();

const appPatchSchema = z
  .object({
    theme: settingValueSchemas["app.theme"].optional(),
    reduceMotion: settingValueSchemas["app.reduceMotion"].optional(),
    showStats: settingValueSchemas["app.showStats"].optional(),
    panel: settingValueSchemas["app.panel"].optional()
  })
  .strict();

export const settingsPatchSchema = z
  .object({
    video: videoPatchSchema.optional(),
    audio: audioPatchSchema.optional(),
    subtitle: subtitlePatchSchema.optional(),
    playback: playbackPatchSchema.optional(),
    app: appPatchSchema.optional()
  })
  .strict();

export type SettingsPatch = z.infer<typeof settingsPatchSchema>;
export type SettingsGroup = keyof SettingsPatch;

export const SETTINGS_GROUP_ORDER: readonly SettingsGroup[] = [
  "video",
  "audio",
  "subtitle",
  "playback",
  "app"
];

export function isSettingsGroup(value: string): value is SettingsGroup {
  return (SETTINGS_GROUP_ORDER as readonly string[]).includes(value);
}

export function flattenSettingsPatch(patch: SettingsPatch): Partial<Record<SettingId, unknown>> {
  const flat: Partial<Record<SettingId, unknown>> = {};
  for (const group of SETTINGS_GROUP_ORDER) {
    const values = patch[group];
    if (!values) continue;
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) continue;
      const id = `${group}.${key}` as SettingId;
      if (!isSettingId(id)) continue;
      flat[id] = value;
    }
  }
  return flat;
}

export function nestSettings(
  flat: Partial<Record<SettingId, unknown>>
): SettingsPatch {
  const patch: SettingsPatch = {};
  for (const [id, value] of Object.entries(flat) as [SettingId, unknown][]) {
    if (value === undefined) continue;
    const group = settingGroup(id);
    const key = id.slice(group.length + 1);
    const groupPatch = (patch[group] ??= {}) as Record<string, unknown>;
    groupPatch[key] = value;
  }
  return patch;
}

export interface SettingDescriptorJson {
  id: SettingId;
  group: SettingDefinition["group"];
  title: SettingDefinition["title"];
  description: SettingDefinition["description"];
  schema: JsonSchema;
  defaultValue: unknown;
  unit: SettingUnit;
  uiScale?: number;
  scope: SettingScope;
  requiresPipelineRebuild: boolean;
  requires: readonly CapabilityName[];
  stage: SettingStage;
  advanced: boolean;
  enumLabels?: readonly { value: string | number; zh: string; en: string }[];
}

export function describeSettings(): SettingDescriptorJson[] {
  return SETTING_IDS.map((id) => {
    const definition = SETTING_DEFINITIONS[id];
    const descriptor: SettingDescriptorJson = {
      id: definition.id,
      group: definition.group,
      title: definition.title,
      description: definition.description,
      schema: zodToJsonSchema(definition.schema),
      defaultValue: definition.defaultValue,
      unit: definition.unit,
      scope: definition.scope,
      requiresPipelineRebuild: definition.requiresPipelineRebuild,
      requires: definition.requires,
      stage: definition.stage,
      advanced: definition.advanced
    };
    if (definition.uiScale !== undefined) descriptor.uiScale = definition.uiScale;
    if (definition.enumLabels !== undefined) descriptor.enumLabels = definition.enumLabels;
    return descriptor;
  });
}
