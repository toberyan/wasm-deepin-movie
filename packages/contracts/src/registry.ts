import { z } from "zod";
import {
  ACTION_IDS,
  actionsListOutputSchema,
  bookmarksAddInputSchema,
  bookmarksListOutputSchema,
  bookmarksRemoveInputSchema,
  captureCreateInputSchema,
  captureJobOutputSchema,
  configExportOutputSchema,
  configImportInputSchema,
  diagnosticsOutputSchema,
  emptyInput,
  emptyOutput,
  eventsReadInputSchema,
  eventsReadOutputSchema,
  historyListInputSchema,
  historyListOutputSchema,
  hostRequestInputSchema,
  jobStatusSchema,
  storyboardCreateInputSchema,
  storyboardJobOutputSchema,
  jobsInputSchema,
  loopSetInputSchema,
  mediaOpenInputSchema,
  mediaOpenOutputSchema,
  mediaProbeInputSchema,
  playlistAddInputSchema,
  playlistListOutputSchema,
  playlistMoveInputSchema,
  playlistPlayInputSchema,
  playlistRemoveInputSchema,
  presetsApplyInputSchema,
  presetsDeleteInputSchema,
  presetsSaveInputSchema,
  seekInputSchema,
  seekOutputSchema,
  sessionsAttachOutputSchema,
  sessionsListOutputSchema,
  sourcesListOutputSchema,
  setRateInputSchema,
  setRateOutputSchema,
  setVolumeInputSchema,
  settingsApplyInputSchema,
  settingsApplyOutputSchema,
  settingsDescribeInputSchema,
  settingsDescribeOutputSchema,
  settingsGetInputSchema,
  settingsGetOutputSchema,
  settingsResetInputSchema,
  stateGetOutputSchema,
  stepInputSchema,
  subtitlesLoadInputSchema,
  tracksListOutputSchema,
  tracksSelectInputSchema,
  uiSetInputSchema,
  type ActionDefinition,
  type ActionId
} from "./actions";
import { zodToJsonSchema, type JsonSchema } from "./schema";
import { capabilityReportSchema } from "./state-schemas";

export interface ActionDescriptorJson {
  id: ActionId;
  title: { zh: string; en: string };
  description: { zh: string; en: string };
  inputSchema: JsonSchema;
  outputSchema: JsonSchema;
  requires: readonly string[];
  media: ActionDefinition["media"];
  cancellable: boolean;
  longRunning: boolean;
  events: readonly string[];
  ui?: ActionDefinition["ui"];
  mcp?: ActionDefinition["mcp"];
}

function define(
  definition: Omit<ActionDefinition, "mcp"> & { mcpTool?: string }
): ActionDefinition {
  const { mcpTool, ...rest } = definition;
  const action: ActionDefinition = rest;
  if (mcpTool) action.mcp = { tool: mcpTool };
  return action;
}

const mediaActions = [
  define({
    id: ACTION_IDS.mediaOpen,
    title: { zh: "打开媒体", en: "Open media" },
    description: { zh: "打开本地文件、HTTP 地址或已授权 sourceId。", en: "Open a local file, HTTP URL or authorized sourceId." },
    inputSchema: mediaOpenInputSchema,
    outputSchema: mediaOpenOutputSchema,
    requires: [],
    media: "optional",
    cancellable: true,
    longRunning: true,
    events: ["phase", "mediaOpened", "decodePathChanged", "error", "state"],
    ui: { group: "media", keywords: ["open", "file", "url", "打开", "文件"] },
    mcpTool: "media_open"
  }),
  define({
    id: ACTION_IDS.mediaClose,
    title: { zh: "关闭媒体", en: "Close media" },
    description: { zh: "关闭当前媒体并释放解码与渲染资源。", en: "Close current media and release decode/render resources." },
    inputSchema: emptyInput,
    outputSchema: emptyOutput,
    requires: [],
    media: "optional",
    cancellable: true,
    longRunning: false,
    events: ["mediaClosed", "phase", "state"],
    ui: { group: "media", keywords: ["close", "关闭"] },
    mcpTool: "media_close"
  }),
  define({
    id: ACTION_IDS.mediaProbe,
    title: { zh: "探测媒体", en: "Probe media" },
    description: { zh: "仅解封装并返回轨道、时长与能力信息。", en: "Demux only; return tracks, duration and capabilities." },
    inputSchema: mediaProbeInputSchema,
    outputSchema: mediaOpenOutputSchema,
    requires: [],
    media: "optional",
    cancellable: true,
    longRunning: true,
    events: ["error"],
    ui: { group: "media", keywords: ["probe", "info", "探测", "信息"] },
    mcpTool: "media_probe"
  })
];

const playbackActions = [
  define({
    id: ACTION_IDS.playbackPlay,
    title: { zh: "播放", en: "Play" },
    description: { zh: "开始或恢复播放。", en: "Start or resume playback." },
    inputSchema: emptyInput,
    outputSchema: emptyOutput,
    requires: [],
    media: "required",
    cancellable: false,
    longRunning: false,
    events: ["phase", "position", "error", "state"],
    ui: { group: "playback", keywords: ["play", "播放"] },
    mcpTool: "playback_play"
  }),
  define({
    id: ACTION_IDS.playbackPause,
    title: { zh: "暂停", en: "Pause" },
    description: { zh: "暂停播放并保留当前位置。", en: "Pause and keep the current position." },
    inputSchema: emptyInput,
    outputSchema: emptyOutput,
    requires: [],
    media: "required",
    cancellable: false,
    longRunning: false,
    events: ["phase", "position", "state"],
    ui: { group: "playback", keywords: ["pause", "暂停"] },
    mcpTool: "playback_pause"
  }),
  define({
    id: ACTION_IDS.playbackStop,
    title: { zh: "停止", en: "Stop" },
    description: { zh: "停止播放并回到起点。", en: "Stop playback and return to the start." },
    inputSchema: emptyInput,
    outputSchema: emptyOutput,
    requires: [],
    media: "required",
    cancellable: true,
    longRunning: false,
    events: ["phase", "position", "state"],
    ui: { group: "playback", keywords: ["stop", "停止"] },
    mcpTool: "playback_stop"
  }),
  define({
    id: ACTION_IDS.playbackSeek,
    title: { zh: "跳转", en: "Seek" },
    description: { zh: "跳转到指定媒体时间，返回实际定位时间和误差。", en: "Seek to a media time and return the actual position and error." },
    inputSchema: seekInputSchema,
    outputSchema: seekOutputSchema,
    requires: [],
    media: "required",
    cancellable: true,
    longRunning: true,
    events: ["phase", "seeked", "position", "state"],
    ui: { group: "playback", keywords: ["seek", "jump", "跳转", "定位"] },
    mcpTool: "playback_seek"
  }),
  define({
    id: ACTION_IDS.playbackStep,
    title: { zh: "逐帧", en: "Step frame" },
    description: {
      zh: "按解码帧时间戳向前或向后逐帧（暂停状态）。",
      en: "Step forward or backward by decoded frame timestamps while paused."
    },
    inputSchema: stepInputSchema,
    outputSchema: emptyOutput,
    requires: [],
    media: "required",
    cancellable: true,
    longRunning: false,
    events: ["position", "state"],
    ui: { group: "playback", keywords: ["step", "frame", "逐帧"] },
    mcpTool: "playback_step"
  }),
  define({
    id: ACTION_IDS.playbackSetRate,
    title: { zh: "设置倍速", en: "Set rate" },
    description: { zh: "设置播放速度并返回实际生效值。", en: "Set playback rate and return the effective value." },
    inputSchema: setRateInputSchema,
    outputSchema: setRateOutputSchema,
    requires: [],
    media: "optional",
    cancellable: false,
    longRunning: false,
    events: ["settingsApplied", "state"],
    ui: { group: "playback", keywords: ["rate", "speed", "倍速"] },
    mcpTool: "playback_set_rate"
  }),
  define({
    id: ACTION_IDS.playbackSetVolume,
    title: { zh: "设置音量", en: "Set volume" },
    description: { zh: "设置主音量或静音。", en: "Set master volume or mute." },
    inputSchema: setVolumeInputSchema,
    outputSchema: settingsGetOutputSchema,
    requires: [],
    media: "optional",
    cancellable: false,
    longRunning: false,
    events: ["settingsApplied", "state"],
    ui: { group: "playback", keywords: ["volume", "mute", "音量", "静音"] },
    mcpTool: "playback_set_volume"
  }),
  define({
    id: ACTION_IDS.loopSet,
    title: { zh: "循环模式", en: "Loop mode" },
    description: { zh: "设置单个播放、循环、顺序或随机播放。", en: "Set single, loop, sequential or shuffle playback." },
    inputSchema: loopSetInputSchema,
    outputSchema: settingsApplyOutputSchema,
    requires: [],
    media: "optional",
    cancellable: false,
    longRunning: false,
    events: ["settingsApplied", "state"],
    ui: { group: "playback", keywords: ["loop", "repeat", "循环"] },
    mcpTool: "loop_set"
  })
];

const trackActions = [
  define({
    id: ACTION_IDS.sourcesList,
    title: { zh: "源列表", en: "List sources" },
    description: { zh: "列出已授权目录中可供播放的媒体源。", en: "List playable media sources in authorized directories." },
    inputSchema: emptyInput,
    outputSchema: sourcesListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "media", keywords: ["sources", "files", "源"], hidden: true },
    mcpTool: "sources_list"
  }),
  define({
    id: ACTION_IDS.tracksList,
    title: { zh: "轨道列表", en: "List tracks" },
    description: { zh: "列出当前媒体的音视频与字幕轨道。", en: "List audio, video and subtitle tracks." },
    inputSchema: emptyInput,
    outputSchema: tracksListOutputSchema,
    requires: [],
    media: "required",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "tracks", keywords: ["tracks", "轨道"] },
    mcpTool: "tracks_list"
  }),
  define({
    id: ACTION_IDS.tracksSelect,
    title: { zh: "选择轨道", en: "Select track" },
    description: { zh: "按类型选择轨道；切换会重建对应解码路径。", en: "Select a track by type; switching rebuilds that decode path." },
    inputSchema: tracksSelectInputSchema,
    outputSchema: tracksListOutputSchema,
    requires: [],
    media: "required",
    cancellable: true,
    longRunning: true,
    events: ["trackChanged", "decodePathChanged", "state"],
    ui: { group: "tracks", keywords: ["track", "audio", "subtitle", "轨道"] },
    mcpTool: "tracks_select"
  })
];

const settingsActions = [
  define({
    id: ACTION_IDS.settingsDescribe,
    title: { zh: "设置定义", en: "Describe settings" },
    description: { zh: "返回设置项的 schema、默认值、单位、作用域与能力条件。", en: "Return setting schemas, defaults, units, scopes and capability requirements." },
    inputSchema: settingsDescribeInputSchema,
    outputSchema: settingsDescribeOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "settings", keywords: ["settings", "schema", "设置"] },
    mcpTool: "settings_describe"
  }),
  define({
    id: ACTION_IDS.settingsGet,
    title: { zh: "读取设置", en: "Get settings" },
    description: { zh: "返回请求值、实际生效值、来源层与原因。", en: "Return requested/effective values, layer and reason." },
    inputSchema: settingsGetInputSchema,
    outputSchema: settingsGetOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "settings", keywords: ["settings", "get", "设置"] },
    mcpTool: "settings_get"
  }),
  define({
    id: ACTION_IDS.settingsApply,
    title: { zh: "应用设置", en: "Apply settings" },
    description: { zh: "按作用域应用设置 patch，逐项返回生效状态。", en: "Apply a settings patch per scope and return per-item status." },
    inputSchema: settingsApplyInputSchema,
    outputSchema: settingsApplyOutputSchema,
    requires: [],
    media: "optional",
    cancellable: true,
    longRunning: true,
    events: ["settingsApplied", "state"],
    ui: { group: "settings", keywords: ["settings", "apply", "设置"] },
    mcpTool: "settings_apply"
  }),
  define({
    id: ACTION_IDS.settingsReset,
    title: { zh: "重置设置", en: "Reset settings" },
    description: { zh: "重置指定层或指定设置项。", en: "Reset a layer or specific settings." },
    inputSchema: settingsResetInputSchema,
    outputSchema: settingsGetOutputSchema,
    requires: [],
    media: "optional",
    cancellable: false,
    longRunning: false,
    events: ["settingsApplied", "state"],
    ui: { group: "settings", keywords: ["reset", "settings", "重置"] },
    mcpTool: "settings_reset"
  })
];

const subtitleActions = [
  define({
    id: ACTION_IDS.subtitlesLoad,
    title: { zh: "加载字幕", en: "Load subtitles" },
    description: { zh: "加载外挂 SRT/VTT/ASS 字幕。", en: "Load external SRT/VTT/ASS subtitles." },
    inputSchema: subtitlesLoadInputSchema,
    outputSchema: tracksListOutputSchema,
    requires: ["subtitles.text"],
    media: "required",
    cancellable: true,
    longRunning: false,
    events: ["trackChanged", "state"],
    ui: { group: "subtitles", keywords: ["subtitle", "srt", "ass", "字幕"] },
    mcpTool: "subtitles_load"
  })
];

const stateActions = [
  define({
    id: ACTION_IDS.stateGet,
    title: { zh: "读取状态", en: "Get state" },
    description: { zh: "返回当前播放状态、轨道、位置、设置与统计。", en: "Return current phase, tracks, position, settings and stats." },
    inputSchema: emptyInput,
    outputSchema: stateGetOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "state", keywords: ["state", "status", "状态"], hidden: true },
    mcpTool: "state_get"
  }),
  define({
    id: ACTION_IDS.eventsRead,
    title: { zh: "读取事件", en: "Read events" },
    description: { zh: "按游标读取有界事件环形缓冲。", en: "Read the bounded event ring buffer by cursor." },
    inputSchema: eventsReadInputSchema,
    outputSchema: eventsReadOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "state", keywords: ["events", "事件"], hidden: true },
    mcpTool: "events_read"
  }),
  define({
    id: ACTION_IDS.diagnosticsGet,
    title: { zh: "诊断信息", en: "Diagnostics" },
    description: { zh: "返回解码路径、队列、能力、警告与统计。", en: "Return decode paths, queues, capabilities, warnings and stats." },
    inputSchema: emptyInput,
    outputSchema: diagnosticsOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "state", keywords: ["diagnostics", "debug", "诊断"], hidden: true },
    mcpTool: "diagnostics_get"
  }),
  define({
    id: ACTION_IDS.actionsList,
    title: { zh: "动作列表", en: "List actions" },
    description: { zh: "返回全部公开动作、输入输出 schema、能力条件与事件。", en: "Return all public actions, schemas, capability requirements and events." },
    inputSchema: emptyInput,
    outputSchema: actionsListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "state", keywords: ["actions", "capabilities", "动作"], hidden: true },
    mcpTool: "actions_list"
  }),
  define({
    id: ACTION_IDS.capabilitiesGet,
    title: { zh: "能力报告", en: "Capabilities" },
    description: { zh: "返回当前浏览器、宿主与媒体引擎能力及不可用原因。", en: "Return current browser, host and media engine capabilities with reasons." },
    inputSchema: emptyInput,
    outputSchema: capabilityReportSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "state", keywords: ["capabilities", "能力"], hidden: true },
    mcpTool: "capabilities_get"
  })
];

const jobActions = [
  define({
    id: ACTION_IDS.jobsGet,
    title: { zh: "读取任务", en: "Get job" },
    description: { zh: "读取打开、定位、截图或导出任务的状态与结果。", en: "Read status/result of open, seek, capture or export jobs." },
    inputSchema: jobsInputSchema,
    outputSchema: jobStatusSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "jobs", keywords: ["job", "task", "任务"], hidden: true },
    mcpTool: "jobs_get"
  }),
  define({
    id: ACTION_IDS.jobsCancel,
    title: { zh: "取消任务", en: "Cancel job" },
    description: { zh: "取消尚未完成的任务。", en: "Cancel a pending job." },
    inputSchema: jobsInputSchema,
    outputSchema: jobStatusSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: ["jobUpdated"],
    ui: { group: "jobs", keywords: ["cancel", "job", "取消"], hidden: true },
    mcpTool: "jobs_cancel"
  })
];

const captureActions = [
  define({
    id: ACTION_IDS.captureCreate,
    title: { zh: "截图", en: "Capture screenshot" },
    description: { zh: "创建截图任务，可选包含字幕/OSD。", en: "Create a screenshot job, optionally including subtitles/OSD." },
    inputSchema: captureCreateInputSchema,
    outputSchema: captureJobOutputSchema,
    requires: ["screenshot"],
    media: "required",
    cancellable: true,
    longRunning: true,
    events: ["jobUpdated"],
    ui: { group: "capture", keywords: ["screenshot", "capture", "截图"] },
    mcpTool: "capture_create"
  }),
  define({
    id: ACTION_IDS.storyboardCreate,
    title: { zh: "生成拼图", en: "Storyboard" },
    description: {
      zh: "用独立采样器生成缩略图拼图（不含字幕与画面滤镜，带时间标签），不暂停或跳转正在播放的媒体。",
      en: "Build a thumbnail strip with an independent sampler; no subtitles or picture filters, timestamps included, playback is never paused or seeked."
    },
    inputSchema: storyboardCreateInputSchema,
    outputSchema: storyboardJobOutputSchema,
    requires: ["screenshot"],
    media: "required",
    cancellable: true,
    longRunning: true,
    events: ["jobUpdated"],
    ui: { group: "capture", keywords: ["storyboard", "thumbnail", "拼图", "预览"] },
    mcpTool: "storyboard_create"
  })
];

const hostActions = [
  define({
    id: ACTION_IDS.uiSet,
    title: { zh: "设置界面", en: "Set UI" },
    description: { zh: "设置侧栏、主题、命令面板、全屏或画中画。", en: "Set panel, theme, command palette, fullscreen or PiP." },
    inputSchema: uiSetInputSchema,
    outputSchema: settingsApplyOutputSchema,
    requires: [],
    media: "optional",
    cancellable: false,
    longRunning: false,
    events: ["settingsApplied", "state"],
    ui: { group: "ui", keywords: ["ui", "theme", "fullscreen", "界面"] },
    mcpTool: "ui_set"
  }),
  define({
    id: ACTION_IDS.hostRequest,
    title: { zh: "宿主操作", en: "Host request" },
    description: { zh: "请求文件选择、全屏、画中画或保存文件。", en: "Request file picking, fullscreen, PiP or saving a file." },
    inputSchema: hostRequestInputSchema,
    outputSchema: z.record(z.string(), z.unknown()),
    requires: [],
    media: "optional",
    cancellable: true,
    longRunning: false,
    events: ["error"],
    ui: { group: "host", keywords: ["host", "fullscreen", "pip", "宿主"], hidden: true },
    mcpTool: "host_request"
  }),
  define({
    id: ACTION_IDS.sessionsList,
    title: { zh: "会话列表", en: "List sessions" },
    description: { zh: "发现可控制的播放会话。", en: "Discover controllable playback sessions." },
    inputSchema: emptyInput,
    outputSchema: sessionsListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "sessions", keywords: ["sessions", "会话"], hidden: true },
    mcpTool: "sessions_list"
  }),
  define({
    id: ACTION_IDS.sessionsAttach,
    title: { zh: "附加会话", en: "Attach session" },
    description: { zh: "选择要控制的播放会话，避免控制错实例。", en: "Select the playback session to control." },
    inputSchema: z.object({ sessionId: z.string().min(1) }).strict(),
    outputSchema: sessionsAttachOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "sessions", keywords: ["attach", "session", "会话"], hidden: true },
    mcpTool: "sessions_attach"
  })
];

const configActions = [
  define({
    id: ACTION_IDS.configExport,
    title: { zh: "导出配置", en: "Export config" },
    description: { zh: "导出带版本号的设置与预设。", en: "Export versioned settings and presets." },
    inputSchema: emptyInput,
    outputSchema: configExportOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "config", keywords: ["export", "config", "导出"] },
    mcpTool: "config_export"
  }),
  define({
    id: ACTION_IDS.configImport,
    title: { zh: "导入配置", en: "Import config" },
    description: { zh: "校验并导入设置与预设。", en: "Validate and import settings and presets." },
    inputSchema: configImportInputSchema,
    outputSchema: settingsGetOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: true,
    longRunning: false,
    events: ["settingsApplied", "state"],
    ui: { group: "config", keywords: ["import", "config", "导入"] },
    mcpTool: "config_import"
  }),
  define({
    id: ACTION_IDS.presetsList,
    title: { zh: "预设列表", en: "List presets" },
    description: { zh: "列出已保存的设置预设。", en: "List saved setting presets." },
    inputSchema: emptyInput,
    outputSchema: z.object({ presets: z.array(z.unknown()) }).strict(),
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "presets", keywords: ["presets", "预设"] },
    mcpTool: "presets_list"
  }),
  define({
    id: ACTION_IDS.presetsSave,
    title: { zh: "保存预设", en: "Save preset" },
    description: { zh: "保存命名设置预设。", en: "Save a named settings preset." },
    inputSchema: presetsSaveInputSchema,
    outputSchema: z.object({ preset: z.unknown() }).strict(),
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "presets", keywords: ["preset", "save", "预设"] },
    mcpTool: "presets_save"
  }),
  define({
    id: ACTION_IDS.presetsApply,
    title: { zh: "应用预设", en: "Apply preset" },
    description: { zh: "把预设作为指定作用域应用。", en: "Apply a preset to a layer." },
    inputSchema: presetsApplyInputSchema,
    outputSchema: settingsApplyOutputSchema,
    requires: [],
    media: "optional",
    cancellable: true,
    longRunning: true,
    events: ["settingsApplied", "state"],
    ui: { group: "presets", keywords: ["preset", "apply", "预设"] },
    mcpTool: "presets_apply"
  }),
  define({
    id: ACTION_IDS.presetsDelete,
    title: { zh: "删除预设", en: "Delete preset" },
    description: { zh: "删除已保存的预设。", en: "Delete a saved preset." },
    inputSchema: presetsDeleteInputSchema,
    outputSchema: emptyOutput,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "presets", keywords: ["preset", "delete", "预设"] },
    mcpTool: "presets_delete"
  })
];

const playlistActions = [
  define({
    id: ACTION_IDS.playlistAdd,
    title: { zh: "添加到列表", en: "Add to playlist" },
    description: { zh: "把已授权源加入播放列表。", en: "Add authorized sources to the playlist." },
    inputSchema: playlistAddInputSchema,
    outputSchema: playlistListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: ["state"],
    ui: { group: "playlist", keywords: ["playlist", "add", "列表"] },
    mcpTool: "playlist_add"
  }),
  define({
    id: ACTION_IDS.playlistMove,
    title: { zh: "调整列表顺序", en: "Move playlist item" },
    description: { zh: "把列表项从 from 移动到 to。", en: "Move a playlist item from one index to another." },
    inputSchema: playlistMoveInputSchema,
    outputSchema: playlistListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: ["state"],
    ui: { group: "playlist", keywords: ["playlist", "move", "reorder", "列表"] },
    mcpTool: "playlist_move"
  }),
  define({
    id: ACTION_IDS.playlistRemove,
    title: { zh: "从列表移除", en: "Remove from playlist" },
    description: { zh: "按索引从播放列表移除。", en: "Remove an item by index." },
    inputSchema: playlistRemoveInputSchema,
    outputSchema: playlistListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: ["state"],
    ui: { group: "playlist", keywords: ["playlist", "remove", "列表"] },
    mcpTool: "playlist_remove"
  }),
  define({
    id: ACTION_IDS.playlistClear,
    title: { zh: "清空列表", en: "Clear playlist" },
    description: { zh: "清空播放列表。", en: "Clear the playlist." },
    inputSchema: emptyInput,
    outputSchema: playlistListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: ["state"],
    ui: { group: "playlist", keywords: ["playlist", "clear", "列表"] },
    mcpTool: "playlist_clear"
  }),
  define({
    id: ACTION_IDS.playlistList,
    title: { zh: "列表内容", en: "List playlist" },
    description: { zh: "返回播放列表内容。", en: "Return playlist items." },
    inputSchema: emptyInput,
    outputSchema: playlistListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "playlist", keywords: ["playlist", "list", "列表"] },
    mcpTool: "playlist_list"
  }),
  define({
    id: ACTION_IDS.playlistPlay,
    title: { zh: "播放列表项", en: "Play playlist item" },
    description: { zh: "打开并播放指定列表项。", en: "Open and play a playlist item." },
    inputSchema: playlistPlayInputSchema,
    outputSchema: mediaOpenOutputSchema,
    requires: [],
    media: "optional",
    cancellable: true,
    longRunning: true,
    events: ["mediaOpened", "phase", "state"],
    ui: { group: "playlist", keywords: ["playlist", "play", "列表"] },
    mcpTool: "playlist_play"
  })
];

const libraryActions = [
  define({
    id: ACTION_IDS.historyList,
    title: { zh: "播放历史", en: "History" },
    description: { zh: "列出最近播放记录与续播位置。", en: "List recent playback history and resume positions." },
    inputSchema: historyListInputSchema,
    outputSchema: historyListOutputSchema,
    requires: [],
    media: "forbidden",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "library", keywords: ["history", "历史"] },
    mcpTool: "history_list"
  }),
  define({
    id: ACTION_IDS.bookmarksList,
    title: { zh: "书签列表", en: "List bookmarks" },
    description: { zh: "列出当前媒体的书签。", en: "List bookmarks for the current media." },
    inputSchema: emptyInput,
    outputSchema: bookmarksListOutputSchema,
    requires: [],
    media: "required",
    cancellable: false,
    longRunning: false,
    events: [],
    ui: { group: "library", keywords: ["bookmarks", "书签"] },
    mcpTool: "bookmarks_list"
  }),
  define({
    id: ACTION_IDS.bookmarksAdd,
    title: { zh: "添加书签", en: "Add bookmark" },
    description: { zh: "在当前播放位置添加书签。", en: "Add a bookmark at the current position." },
    inputSchema: bookmarksAddInputSchema,
    outputSchema: bookmarksListOutputSchema,
    requires: [],
    media: "required",
    cancellable: false,
    longRunning: false,
    events: ["state"],
    ui: { group: "library", keywords: ["bookmark", "add", "书签"] },
    mcpTool: "bookmarks_add"
  }),
  define({
    id: ACTION_IDS.bookmarksRemove,
    title: { zh: "删除书签", en: "Remove bookmark" },
    description: { zh: "删除指定书签。", en: "Delete a bookmark." },
    inputSchema: bookmarksRemoveInputSchema,
    outputSchema: bookmarksListOutputSchema,
    requires: [],
    media: "required",
    cancellable: false,
    longRunning: false,
    events: ["state"],
    ui: { group: "library", keywords: ["bookmark", "remove", "书签"] },
    mcpTool: "bookmarks_remove"
  })
];

export const CORE_ACTIONS: readonly ActionDefinition[] = [
  ...mediaActions,
  ...playbackActions,
  ...trackActions,
  ...settingsActions,
  ...subtitleActions,
  ...stateActions,
  ...jobActions,
  ...captureActions,
  ...hostActions,
  ...configActions,
  ...playlistActions,
  ...libraryActions
];

export class ActionRegistry {
  private readonly definitions = new Map<ActionId, ActionDefinition>();

  constructor(definitions: readonly ActionDefinition[] = []) {
    for (const definition of definitions) this.register(definition);
  }

  register(definition: ActionDefinition): void {
    if (this.definitions.has(definition.id)) {
      throw new Error(`duplicate action id: ${definition.id}`);
    }
    this.definitions.set(definition.id, definition);
  }

  has(id: string): id is ActionId {
    return this.definitions.has(id as ActionId);
  }

  get(id: string): ActionDefinition | undefined {
    return this.definitions.get(id as ActionId);
  }

  require(id: string): ActionDefinition {
    const definition = this.get(id);
    if (!definition) throw new Error(`unknown action: ${id}`);
    return definition;
  }

  list(): ActionDefinition[] {
    return [...this.definitions.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  validateInput(id: string, params: unknown): unknown {
    const definition = this.require(id);
    return definition.inputSchema.parse(params);
  }

  describe(): ActionDescriptorJson[] {
    return this.list().map((definition) => {
      const descriptor: ActionDescriptorJson = {
        id: definition.id,
        title: definition.title,
        description: definition.description,
        inputSchema: zodToJsonSchema(definition.inputSchema),
        outputSchema: zodToJsonSchema(definition.outputSchema, { io: "output" }),
        requires: definition.requires,
        media: definition.media,
        cancellable: definition.cancellable,
        longRunning: definition.longRunning,
        events: definition.events
      };
      if (definition.ui) descriptor.ui = definition.ui;
      if (definition.mcp) descriptor.mcp = definition.mcp;
      return descriptor;
    });
  }

  mcpTools(): { action: ActionDefinition; toolName: string }[] {
    return this.list()
      .filter((definition) => definition.mcp !== undefined)
      .map((definition) => ({ action: definition, toolName: definition.mcp!.tool }));
  }
}

export function createCoreRegistry(): ActionRegistry {
  return new ActionRegistry(CORE_ACTIONS);
}

export function mcpToolName(actionId: ActionId): string {
  return actionId.replace(/\./g, "_");
}

export { actionsListOutputSchema };
export type InvokeInput = z.infer<typeof emptyInput>;
