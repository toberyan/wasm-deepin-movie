import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode
} from "react";
import {
  ACTION_IDS,
  SETTING_DEFINITIONS,
  fileIdentityOf,
  type ActionId,
  type Bookmark,
  type HistoryItem,
  type MediaSourceInput,
  type InvokeResult,
  type PlayerSnapshot,
  type SettingId,
  type TrackInfo
} from "@wasm-player/contracts";
import { PlayerController } from "@wasm-player/player-core";
import { createPlayerStorage } from "@wasm-player/storage";
import { BrowserMediaEngine } from "./player/browser-media-engine";
import { browserHost } from "@wasm-player/host";
import { CompanionClient, type CompanionBootstrap } from "./player/companion-client";
import { Icon, type IconName } from "./components/Icon";

function formatTime(us: number): string {
  if (!Number.isFinite(us) || us < 0) return "0:00";
  const total = Math.floor(us / 1_000_000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  }
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function signed(value: number, suffix = ""): string {
  return `${value > 0 ? "+" : ""}${value}${suffix}`;
}

function settingNumber(snapshot: PlayerSnapshot | null, id: SettingId, fallback: number): number {
  const value = snapshot?.settings[id]?.effective;
  return typeof value === "number" ? value : fallback;
}

function settingIssue(snapshot: PlayerSnapshot | null, id: SettingId): string | null {
  const value = snapshot?.settings[id];
  const status = value?.status;
  if (status === "unsupported") return value?.reason ?? "当前媒体不支持";
  if (status === "failed") return "应用失败";
  return null;
}

function settingLabel(id: SettingId): string {
  return SETTING_DEFINITIONS[id].title.zh;
}

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    Boolean(
      target.closest(
        'input, textarea, select, button, a[href], summary, [contenteditable="true"], [role="slider"], [role="menuitem"], [role="tab"], [role="checkbox"], [role="switch"]'
      )
    )
  );
}

const THEME_LABELS: Record<string, string> = {
  system: "跟随系统",
  dark: "深色",
  light: "浅色"
};

type SettingsView = "playback" | "app";
type SettingsTab = "picture" | "audio" | "subtitle" | "playback";
type MenuId = "open" | "more" | "volume" | "rate" | "audio" | "subtitle" | null;

interface PlaylistEntry {
  index: number;
  name: string;
  url?: string;
  sourceId?: string;
  kind?: "file" | "url" | "sourceId";
  identity?: string;
  /** False for a persisted local file that has not been re-linked yet. */
  available?: boolean;
  durationUs?: number;
}

const MEDIA_EXTENSIONS =
  /\.(mp4|m4v|mov|mkv|webm|avi|flv|ts|m2ts|mts|mpg|mpeg|vob|ogv|ogg|wmv|asf|rmvb|rm|3gp|mp3|aac|m4a|flac|wav|opus)$/i;

function isMediaFile(name: string): boolean {
  return MEDIA_EXTENSIONS.test(name);
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const exponent = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** exponent;
  return `${value.toFixed(value >= 100 || exponent === 0 ? 0 : 1)} ${units[exponent]}`;
}

function delay(ms: number): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
}

const SETTINGS_TABS: { id: SettingsTab; label: string; icon: IconName }[] = [
  { id: "picture", label: "画面", icon: "film" },
  { id: "audio", label: "声音", icon: "audio" },
  { id: "subtitle", label: "字幕", icon: "subtitles" },
  { id: "playback", label: "播放", icon: "speed" }
];

const PICTURE_IDS: SettingId[] = [
  "video.fit",
  "video.brightness",
  "video.contrast",
  "video.saturation",
  "video.gamma",
  "video.hueDeg",
  "video.rotationDeg",
  "video.sharpness",
  "video.scaleMode"
];

const AUDIO_IDS: SettingId[] = [
  "audio.volume",
  "audio.muted",
  "audio.channel",
  "audio.gainDb",
  "audio.balance",
  "audio.delayMs",
  "audio.eq",
  "audio.deviceId"
];

const SUBTITLE_IDS: SettingId[] = [
  "subtitle.visible",
  "subtitle.fontSizePct",
  "subtitle.fontFamily",
  "subtitle.delayMs",
  "subtitle.forceStyle"
];

const PLAYBACK_IDS: SettingId[] = [
  "playback.rate",
  "playback.loop",
  "playback.autoPlay",
  "playback.pauseOnHidden",
  "playback.volumeStep"
];

const APP_IDS: SettingId[] = ["app.theme", "app.reduceMotion", "app.showStats"];

interface SliderRowProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  display: string;
  issue?: string | null;
  onChange: (value: number) => void;
}

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  display,
  issue,
  onChange
}: SliderRowProps) {
  return (
    <div className="control-row">
      <div className="control-head">
        <span className="control-label">
          {label}
          {issue && <em className="control-issue">{issue}</em>}
        </span>
        <span className="control-value">{display}</span>
      </div>
      <input
        type="range"
        aria-label={label}
        min={min}
        max={max}
        step={step}
        value={value}
        style={
          {
            "--range-progress": `${max > min ? ((value - min) / (max - min)) * 100 : 0}%`
          } as CSSProperties
        }
        onChange={(event) => onChange(Number(event.target.value))}
      />
    </div>
  );
}

function ToggleRow({
  label,
  checked,
  disabled,
  onChange
}: {
  label: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="toggle-row">
      <span>{label}</span>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
    </label>
  );
}

function SelectRow({
  label,
  value,
  onChange,
  children
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  children: ReactNode;
}) {
  return (
    <label className="control-row">
      <span className="control-label">{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        {children}
      </select>
    </label>
  );
}

function TrackList({
  tracks,
  empty,
  onSelect
}: {
  tracks: TrackInfo[];
  empty: string;
  onSelect: (track: TrackInfo) => void;
}) {
  if (tracks.length === 0) return <div className="muted">{empty}</div>;
  return (
    <div className="track-list">
      {tracks.map((track) => (
        <button
          key={`${track.type}-${track.index}`}
          className={`track-item ${track.selected ? "selected" : ""}`}
          onClick={() => onSelect(track)}
        >
          <span className="track-title">
            {track.selected && <Icon name="check" size={14} />}
            {track.title ?? `${track.type} ${track.index}`}
            {track.language ? ` · ${track.language}` : ""}
          </span>
          <span className="track-codec">{track.codec}</span>
        </button>
      ))}
    </div>
  );
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<PlayerController | null>(null);
  const lastSourceRef = useRef<MediaSourceInput | null>(null);
  // Local files are keyed by their stable identity, not by file name, so two
  // files with the same name in different folders stay distinguishable.
  const localFilesRef = useRef(new Map<string, File>());
  const hideTimerRef = useRef<number | null>(null);
  const [forceWasm, setForceWasm] = useState(
    () => window.localStorage.getItem("wasm-player-force-wasm") === "1"
  );
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [message, setMessage] = useState<string>("");
  const [seekUs, setSeekUs] = useState<number | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [settingsView, setSettingsView] = useState<SettingsView>("playback");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("picture");
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [libraryTab, setLibraryTab] = useState<"playlist" | "history" | "bookmarks">("playlist");
  const [playlistItems, setPlaylistItems] = useState<PlaylistEntry[]>([]);
  // The controller owns the current playlist entry; the UI only reads it.
  const playlistIndex = snapshot?.playlistIndex ?? null;
  const [draggingPlaylistIndex, setDraggingPlaylistIndex] = useState<number | null>(null);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [bookmarkItems, setBookmarkItems] = useState<Bookmark[]>([]);
  const [urlDraft, setUrlDraft] = useState("");
  const [openUrlDraft, setOpenUrlDraft] = useState("");
  const [emptyUrlOpen, setEmptyUrlOpen] = useState(false);
  const [subtitleEncoding, setSubtitleEncoding] = useState(
    () => window.localStorage.getItem("wasm-player-subtitle-encoding") ?? "auto"
  );
  const [audioDevices, setAudioDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [agentConnected, setAgentConnected] = useState(false);
  const [openMenu, setOpenMenu] = useState<MenuId>(null);
  const [dragActive, setDragActive] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [chromeVisible, setChromeVisible] = useState(true);
  const requestSeq = useRef(0);
  const themeSetting = snapshot?.settings["app.theme"]?.effective;
  const reduceMotionSetting = snapshot?.settings["app.reduceMotion"]?.effective;
  const pauseOnHidden = Boolean(snapshot?.settings["playback.pauseOnHidden"]?.effective ?? false);
  const currentMediaKey = snapshot?.media?.sourceId ?? null;

  useEffect(() => {
    const theme = String(themeSetting ?? "dark");
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (query.matches ? "light" : "dark") : theme;
    };
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, [themeSetting]);

  useEffect(() => {
    document.documentElement.dataset.reduceMotion = reduceMotionSetting ? "true" : "false";
  }, [reduceMotionSetting]);

  useEffect(() => {
    const onFullscreenChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    onFullscreenChange();
    document.addEventListener("fullscreenchange", onFullscreenChange);
    return () => document.removeEventListener("fullscreenchange", onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!pauseOnHidden) return;
    const onVisibilityChange = () => {
      if (!document.hidden) return;
      const controller = controllerRef.current;
      if (!controller || controller.getState().phase !== "playing") return;
      void controller
        .invoke({
          requestId: `hidden-pause-${Date.now()}`,
          sessionId: controller.sessionId,
          action: ACTION_IDS.playbackPause,
          params: {}
        })
        .then(() => setSnapshot(controller.getState()));
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    return () => document.removeEventListener("visibilitychange", onVisibilityChange);
  }, [pauseOnHidden]);

  useEffect(() => {
    if (!openMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-menu-root]")) {
        setOpenMenu(null);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openMenu]);

  useEffect(() => {
    if (!showSettings || !navigator.mediaDevices?.enumerateDevices) return;
    let cancelled = false;
    void navigator.mediaDevices.enumerateDevices().then((devices) => {
      if (cancelled) return;
      setAudioDevices(
        devices
          .filter((device) => device.kind === "audiooutput")
          .map((device, index) => ({
            deviceId: device.deviceId,
            label: device.label || `音频输出 ${index + 1}`
          }))
      );
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showSettings]);

  useEffect(() => {
    if (!showPlaylist) return;
    let cancelled = false;
    const load = async () => {
      const [playlistResult, historyResult] = await Promise.all([
        invoke(ACTION_IDS.playlistList),
        invoke(ACTION_IDS.historyList, { limit: 50 })
      ]);
      if (cancelled) return;
      if (playlistResult.status === "applied") {
        setPlaylistItems(
          (playlistResult.output as { items: typeof playlistItems } | undefined)?.items ?? []
        );
      }
      if (historyResult.status === "applied") {
        setHistoryItems(
          (historyResult.output as { items: HistoryItem[] } | undefined)?.items ?? []
        );
      }
      if (currentMediaKey) {
        const bookmarkResult = await invoke(ACTION_IDS.bookmarksList);
        if (!cancelled && bookmarkResult.status === "applied") {
          setBookmarkItems(
            (bookmarkResult.output as { items: Bookmark[] } | undefined)?.items ?? []
          );
        }
      } else if (!cancelled) {
        setBookmarkItems([]);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [showPlaylist, snapshot?.revision, currentMediaKey]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    let active = true;
    let controller: PlayerController | null = null;
    let companion: CompanionClient | null = null;
    let unsubscribe: (() => void) | null = null;
    const start = async () => {
      let bootstrap: CompanionBootstrap | null = null;
      try {
        const response = await fetch("/api/bootstrap", { headers: { Accept: "application/json" } });
        if (response.ok && response.headers.get("content-type")?.includes("application/json")) {
          bootstrap = (await response.json()) as CompanionBootstrap;
        }
      } catch {
        // Static/dev hosting without a Companion.
      }
      if (!active) return;
      try {
        const engine = new BrowserMediaEngine({
          canvas,
          overlayContainer: overlay,
          libavBase: new URL("/libav/", window.location.origin).href,
          libavVariant: new URLSearchParams(window.location.search).get("libav") ?? undefined,
          libavThreads:
            new URLSearchParams(window.location.search).get("libavThreads") === "mt" ? "mt" : "st",
          onLog: (logMessage, details) => console.debug("[player]", logMessage, details)
        });
        controller = new PlayerController({
          engine,
          sessionId: bootstrap?.sessionId ?? "web-main",
          host: browserHost,
          storage: createPlayerStorage()
        });
        await controller.ready;
        if (!active) {
          await engine.dispose();
          return;
        }
        controllerRef.current = controller;
        const update = () => {
          if (active) setSnapshot(controller!.getState());
        };
        unsubscribe = controller.subscribe(update);
        update();
        (window as Window & { __player?: PlayerController }).__player = controller;
        if (bootstrap) {
          companion = new CompanionClient(bootstrap, controller, setAgentConnected);
          companion.connect();
        }
      } catch (error) {
        setMessage(error instanceof Error ? error.message : String(error));
      }
    };
    void start();
    return () => {
      active = false;
      unsubscribe?.();
      companion?.disconnect();
      controllerRef.current = null;
      void controller?.dispose();
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isInteractiveTarget(event.target)) return;
      const commandKey = event.ctrlKey || event.metaKey;
      if (commandKey && event.key === "ArrowLeft") {
        event.preventDefault();
        void setRateBy(-0.1);
        return;
      }
      if (commandKey && event.key === "ArrowRight") {
        event.preventDefault();
        void setRateBy(0.1);
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlay();
      } else if (event.key === ",") {
        event.preventDefault();
        void stepFrame(1, "backward");
      } else if (event.key === ".") {
        event.preventDefault();
        void stepFrame(1, "forward");
      } else if (!commandKey && !event.altKey && event.key.toLowerCase() === "r") {
        event.preventDefault();
        void setRateBy(1 - (snapshot?.rate ?? 1));
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        void seekRelative(-5);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        void seekRelative(5);
      } else if (event.key === "ArrowUp" || event.key === "ArrowDown") {
        event.preventDefault();
        const step = Number(snapshot?.settings["playback.volumeStep"]?.effective ?? 0.05);
        const current = snapshot?.volume ?? 1;
        const volume = Math.min(1, Math.max(0, current + (event.key === "ArrowUp" ? step : -step)));
        void invoke(ACTION_IDS.playbackSetVolume, { volume, muted: false });
      } else if (event.key.toLowerCase() === "f") {
        void invoke(ACTION_IDS.uiSet, { fullscreen: !document.fullscreenElement });
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  });

  const hasMedia = Boolean(snapshot?.media);
  const isPlaying = snapshot?.phase === "playing";
  const wakeChrome = useCallback(() => {
    setChromeVisible(true);
    if (hideTimerRef.current !== null) {
      window.clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
    const idle = isFullscreen && hasMedia && isPlaying;
    if (!idle || openMenu || showSettings || showPlaylist) return;
    hideTimerRef.current = window.setTimeout(() => setChromeVisible(false), 3000);
  }, [isFullscreen, hasMedia, isPlaying, openMenu, showSettings, showPlaylist]);

  useEffect(() => {
    wakeChrome();
    return () => {
      if (hideTimerRef.current !== null) {
        window.clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };
  }, [wakeChrome]);

  useEffect(() => {
    if (!isFullscreen) return;
    const onActivity = () => wakeChrome();
    window.addEventListener("pointermove", onActivity);
    window.addEventListener("pointerdown", onActivity);
    window.addEventListener("keydown", onActivity);
    return () => {
      window.removeEventListener("pointermove", onActivity);
      window.removeEventListener("pointerdown", onActivity);
      window.removeEventListener("keydown", onActivity);
    };
  }, [isFullscreen, wakeChrome]);

  const invoke = async (
    action: ActionId,
    params: Record<string, unknown> = {},
    expectedRevision?: number
  ): Promise<InvokeResult> => {
    const controller = controllerRef.current;
    if (!controller) throw new Error("player is not ready");
    requestSeq.current += 1;
    const request: Parameters<PlayerController["invoke"]>[0] = {
      requestId: `web-${Date.now()}-${requestSeq.current}`,
      sessionId: controller.sessionId,
      action,
      params
    };
    if (expectedRevision !== undefined) request.expectedRevision = expectedRevision;
    const result = await controller.invoke(request);
    if (result.status === "rejected") {
      setMessage(`${result.error?.code ?? "ERROR"}: ${result.error?.message ?? "request failed"}`);
    } else {
      setMessage("");
    }
    setSnapshot(controller.getState());
    return result;
  };

  const openFile = async (file: File) => {
    setBusy(true);
    try {
      const identity = fileIdentityOf(file);
      const source: MediaSourceInput = { kind: "file", file, name: file.name };
      if (identity) source.identity = identity;
      lastSourceRef.current = source;
      if (identity) localFilesRef.current.set(identity, file);
      await invoke(ACTION_IDS.mediaOpen, {
        source,
        autoPlay: Boolean(snapshot?.settings["playback.autoPlay"]?.effective ?? false),
        ...(forceWasm ? { forceDecodePath: { video: "wasm", audio: "wasm" } } : {})
      });
      // Opening a file re-links the playlist entries that were restored from
      // storage, so refresh the list to drop their "needs re-selection" state.
      const playlistResult = await invoke(ACTION_IDS.playlistList);
      const refreshed =
        (playlistResult.output as { items?: PlaylistEntry[] } | undefined)?.items ?? [];
      setPlaylistItems(refreshed);
    } finally {
      setBusy(false);
    }
  };

  const openFolder = async (files: FileList | File[]) => {
    const candidates = Array.from(files)
      .filter((file) => isMediaFile(file.name))
      .sort((left, right) =>
        (left.webkitRelativePath || left.name).localeCompare(
          right.webkitRelativePath || right.name,
          "zh-Hans-CN"
        )
      );
    if (candidates.length === 0) {
      setMessage("文件夹中没有可播放的媒体文件");
      return;
    }
    setBusy(true);
    try {
      const sources = candidates.map((file): MediaSourceInput => {
        const identity = fileIdentityOf(file);
        if (identity) localFilesRef.current.set(identity, file);
        const source: MediaSourceInput = { kind: "file", file, name: file.name };
        if (identity) source.identity = identity;
        return source;
      });
      const result = await invoke(ACTION_IDS.playlistAdd, { sources });
      const items =
        (result.output as { items?: PlaylistEntry[] } | undefined)?.items ?? [];
      setPlaylistItems(items);
      // Added files are deduplicated by identity, so locate the first picked
      // file instead of assuming every source appended a new entry.
      const first = sources[0];
      const entry = first
        ? items.find((item) =>
            first.identity ? item.identity === first.identity : item.name === first.name
          )
        : undefined;
      if (entry) {
        setLibraryTab("playlist");
        await playPlaylistItem(entry);
      }
    } finally {
      setBusy(false);
    }
  };

  const openUrl = async (rawValue = openUrlDraft) => {
    const value = rawValue.trim();
    if (!value) return;
    try {
      const parsed = new URL(value);
      const name = decodeURIComponent(parsed.pathname.split("/").pop() || parsed.hostname);
      const source: MediaSourceInput = { kind: "url", url: parsed.href, name };
      lastSourceRef.current = source;
      setOpenUrlDraft("");
      setEmptyUrlOpen(false);
      setOpenMenu(null);
      await invoke(ACTION_IDS.mediaOpen, {
        source,
        autoPlay: Boolean(snapshot?.settings["playback.autoPlay"]?.effective ?? false)
      });
    } catch {
      setMessage("请输入有效的 URL");
    }
  };

  const togglePlay = async () => {
    if (!snapshot?.media) return;
    if (snapshot.phase === "playing" || snapshot.phase === "buffering") {
      await invoke(ACTION_IDS.playbackPause);
    } else {
      await invoke(ACTION_IDS.playbackPlay);
    }
  };

  const seekRelative = async (seconds: number) => {
    if (!snapshot?.media) return;
    const target = Math.min(
      snapshot.durationUs,
      Math.max(0, snapshot.positionUs + seconds * 1_000_000)
    );
    await invoke(ACTION_IDS.playbackSeek, { positionUs: target });
  };

  const setRateBy = async (delta: number) => {
    if (!snapshot?.media) return;
    const next = Math.min(4, Math.max(0.25, Math.round((snapshot.rate + delta) * 100) / 100));
    if (next === snapshot.rate) return;
    await invoke(ACTION_IDS.playbackSetRate, { rate: next });
  };

  const stepFrame = async (frames: number, direction: "forward" | "backward" = "forward") => {
    if (!snapshot?.media) return;
    await invoke(ACTION_IDS.playbackStep, { frames, direction });
  };

  const commitSeek = (value: number | null) => {
    if (value === null) return;
    void invoke(ACTION_IDS.playbackSeek, { positionUs: value });
    setSeekUs(null);
  };

  const openSubtitle = async (file: File) => {
    await invoke(ACTION_IDS.subtitlesLoad, {
      file,
      name: file.name,
      ...(subtitleEncoding === "auto" ? {} : { encoding: subtitleEncoding })
    });
  };

  const applyPatch = async (patch: Record<string, unknown>) => {
    await invoke(ACTION_IDS.settingsApply, { scope: "session", patch });
  };

  const applyGlobalPatch = async (patch: Record<string, unknown>) => {
    await invoke(ACTION_IDS.settingsApply, { scope: "global", patch });
  };

  const resetSettings = async (ids: SettingId[]) => {
    const sessionIds = ids.filter((id) => SETTING_DEFINITIONS[id].scope === "session");
    const globalIds = ids.filter((id) => SETTING_DEFINITIONS[id].scope === "global");
    if (sessionIds.length > 0) {
      await invoke(ACTION_IDS.settingsReset, { scope: "session", ids: sessionIds });
    }
    if (globalIds.length > 0) {
      await invoke(ACTION_IDS.settingsReset, { scope: "global", ids: globalIds });
    }
    if (ids.includes("app.showStats")) setShowStats(false);
  };

  const openHistory = async (item: HistoryItem) => {
    const source =
      item.source ??
      (item.id.startsWith("http://") || item.id.startsWith("https://")
        ? { kind: "url" as const, url: item.id, name: item.name }
        : null);
    if (!source) {
      setMessage("本地文件历史需要重新选择文件");
      return;
    }
    lastSourceRef.current = source;
    await invoke(ACTION_IDS.mediaOpen, {
      source,
      startPositionUs: item.positionUs,
      autoPlay: true
    });
    setShowPlaylist(false);
  };

  const addUrlToPlaylist = async () => {
    const value = urlDraft.trim();
    if (!value) return;
    try {
      const parsed = new URL(value);
      const result = await invoke(ACTION_IDS.playlistAdd, {
        sources: [
          {
            kind: "url",
            url: parsed.href,
            name: parsed.pathname.split("/").pop() || parsed.hostname
          }
        ]
      });
      setPlaylistItems(
        (result.output as { items?: PlaylistEntry[] } | undefined)?.items ?? []
      );
      setUrlDraft("");
    } catch {
      setMessage("请输入有效的 URL");
    }
  };

  const addBookmark = async () => {
    if (!snapshot?.media) return;
    await invoke(ACTION_IDS.bookmarksAdd, {
      name: formatTime(snapshot.positionUs),
      positionUs: snapshot.positionUs
    });
  };

  const toggleForceWasm = (enabled: boolean) => {
    setForceWasm(enabled);
    window.localStorage.setItem("wasm-player-force-wasm", enabled ? "1" : "0");
  };

  const reopenWithWasm = async () => {
    const source = lastSourceRef.current;
    if (!source) {
      setMessage("当前媒体没有可复用的源，请重新选择文件");
      return;
    }
    const preferred: Record<string, number> = {};
    if (snapshot?.selected.video !== null && snapshot?.selected.video !== undefined) {
      preferred.video = snapshot.selected.video;
    }
    if (snapshot?.selected.audio !== null && snapshot?.selected.audio !== undefined) {
      preferred.audio = snapshot.selected.audio;
    }
    await invoke(ACTION_IDS.mediaOpen, {
      source,
      startPositionUs: snapshot?.positionUs ?? 0,
      ...(Object.keys(preferred).length > 0 ? { preferredTracks: preferred } : {}),
      forceDecodePath: { video: "wasm", audio: "wasm" }
    });
  };

  const playPlaylistItem = async (item: PlaylistEntry) => {
    if (item.url) {
      lastSourceRef.current = { kind: "url", url: item.url, name: item.name };
    } else if (item.sourceId) {
      lastSourceRef.current = { kind: "sourceId", sourceId: item.sourceId, name: item.name };
    } else {
      const file = item.identity ? localFilesRef.current.get(item.identity) : undefined;
      if (file) {
        lastSourceRef.current = { kind: "file", file, name: item.name };
      } else if (item.available === false) {
        // The entry survived a restart without its file handle: ask for the
        // file again; the controller matches it back by identity.
        setMessage(`请重新选择 “${item.name}” 以继续播放`);
        fileInputRef.current?.click();
        return;
      }
    }
    await invoke(ACTION_IDS.playlistPlay, { index: item.index });
  };

  const playAdjacent = async (delta: number) => {
    let items = playlistItems;
    if (items.length === 0) {
      const result = await invoke(ACTION_IDS.playlistList);
      items = (result.output as { items?: PlaylistEntry[] } | undefined)?.items ?? [];
      setPlaylistItems(items);
    }
    if (items.length === 0) return;
    // The current position is the playlist index, never the file name: several
    // same-named episodes from different folders must advance independently.
    const current =
      playlistIndex === null
        ? -1
        : items.findIndex((item) => item.index === playlistIndex);
    const nextIndex =
      current < 0
        ? delta > 0
          ? 0
          : items.length - 1
        : (current + delta + items.length) % items.length;
    const next = items[nextIndex];
    if (next) await playPlaylistItem(next);
  };

  const movePlaylistItem = async (from: number, to: number) => {
    if (from === to) return;
    const result = await invoke(ACTION_IDS.playlistMove, { from, to });
    const items = (result.output as { items?: PlaylistEntry[] } | undefined)?.items ?? [];
    setPlaylistItems(items);
    // playlistIndex comes from the controller snapshot, which adjusts it on move.
  };

  const captureFrameBlob = async (): Promise<Blob | null> => {
    const accepted = await invoke(ACTION_IDS.captureCreate, {
      includeSubtitles: true,
      format: "png"
    });
    const jobId = accepted.jobId;
    const controller = controllerRef.current;
    if (!jobId || !controller) return null;
    const started = Date.now();
    while (Date.now() - started < 5000) {
      const job = await controller.invoke({
        requestId: `job-${Date.now()}`,
        sessionId: controller.sessionId,
        action: ACTION_IDS.jobsGet,
        params: { jobId }
      });
      const result = job.output as { status?: string } | undefined;
      if (result?.status === "applied") {
        const blob = controller.getJobBlob(jobId) ?? null;
        // The caller keeps the Blob reference; only the controller's copy is
        // dropped so repeated captures do not accumulate.
        controller.releaseJob(jobId);
        return blob;
      }
      if (result?.status === "failed") {
        setMessage("截图失败");
        return null;
      }
      await delay(100);
    }
    setMessage("截图超时");
    return null;
  };

  const downloadBlob = (blob: Blob, name: string) => {
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = name;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  };

  const takeScreenshot = async () => {
    const blob = await captureFrameBlob();
    if (blob) downloadBlob(blob, `screenshot-${Date.now()}.png`);
  };

  const takeStoryboard = async () => {
    const controller = controllerRef.current;
    const media = snapshot?.media;
    if (!controller || !media || snapshot.durationUs <= 0) return;
    const wasPlaying = snapshot.phase === "playing";
    const originalPosition = snapshot.positionUs;
    await invoke(ACTION_IDS.playbackPause);
    const count = 15;
    const columns = 5;
    const tileWidth = 256;
    const tileHeight = 144;
    const board = document.createElement("canvas");
    board.width = columns * tileWidth;
    board.height = Math.ceil(count / columns) * tileHeight;
    const context = board.getContext("2d");
    if (!context) {
      setMessage("无法创建连拍画布");
      return;
    }
    context.fillStyle = "#000";
    context.fillRect(0, 0, board.width, board.height);
    try {
      for (let index = 0; index < count; index += 1) {
        const positionUs = Math.min(
          Math.max(0, snapshot.durationUs - 1),
          Math.round((snapshot.durationUs * (index + 0.5)) / count)
        );
        const beforeRendered = controller.getState().stats.renderedFrames;
        await invoke(ACTION_IDS.playbackSeek, { positionUs });
        for (let attempt = 0; attempt < 40; attempt += 1) {
          if (controller.getState().stats.renderedFrames > beforeRendered) break;
          await delay(50);
        }
        const blob = await captureFrameBlob();
        if (!blob) continue;
        const bitmap = await createImageBitmap(blob);
        const x = (index % columns) * tileWidth;
        const y = Math.floor(index / columns) * tileHeight;
        const scale = Math.max(tileWidth / bitmap.width, tileHeight / bitmap.height);
        const width = bitmap.width * scale;
        const height = bitmap.height * scale;
        context.drawImage(
          bitmap,
          x + (tileWidth - width) / 2,
          y + (tileHeight - height) / 2,
          width,
          height
        );
        bitmap.close();
        context.fillStyle = "rgba(0, 0, 0, 0.62)";
        context.fillRect(x, y + tileHeight - 18, tileWidth, 18);
        context.fillStyle = "#fff";
        context.font = "11px sans-serif";
        context.fillText(formatTime(positionUs), x + 6, y + tileHeight - 5);
      }
      const { promise, resolve } = Promise.withResolvers<Blob | null>();
      board.toBlob(resolve, "image/png");
      const storyboard = await promise;
      if (storyboard) downloadBlob(storyboard, `storyboard-${Date.now()}.png`);
    } finally {
      await invoke(ACTION_IDS.playbackSeek, { positionUs: originalPosition });
      if (wasPlaying) await invoke(ACTION_IDS.playbackPlay);
    }
  };

  const openSettings = (view: SettingsView = "playback", tab?: SettingsTab) => {
    setShowSettings(true);
    setSettingsView(view);
    if (tab) setSettingsTab(tab);
    setShowPlaylist(false);
    setOpenMenu(null);
  };

  const togglePlaylist = () => {
    setShowPlaylist((value) => !value);
    setShowSettings(false);
    setOpenMenu(null);
  };

  const selectTrack = async (type: "video" | "audio" | "subtitle", index: number) => {
    await invoke(ACTION_IDS.tracksSelect, { type, index });
    setOpenMenu(null);
  };

  const tracksByType = useMemo(() => {
    const groups: Record<string, TrackInfo[]> = { video: [], audio: [], subtitle: [] };
    for (const track of snapshot?.tracks ?? []) groups[track.type]?.push(track);
    return groups;
  }, [snapshot?.tracks]);

  const positionUs = seekUs ?? snapshot?.positionUs ?? 0;
  const durationUs = Math.max(0, snapshot?.durationUs ?? 0);
  const progress = durationUs > 0 ? Math.min(100, Math.max(0, (positionUs / durationUs) * 100)) : 0;
  const themeLabel = THEME_LABELS[String(themeSetting ?? "dark")] ?? "深色";
  const rate = snapshot?.rate ?? 1;
  const volume = snapshot?.volume ?? 1;
  const muted = snapshot?.muted ?? false;
  const eqValues = Array.isArray(snapshot?.settings["audio.eq"]?.effective)
    ? (snapshot?.settings["audio.eq"]?.effective as number[])
    : Array.from({ length: 10 }, () => 0);
  const subtitleVisible = Boolean(snapshot?.settings["subtitle.visible"]?.effective ?? true);

  const renderTrackList = (type: "video" | "audio" | "subtitle") => (
    <TrackList
      tracks={tracksByType[type] ?? []}
      empty={type === "subtitle" ? "无字幕轨" : type === "audio" ? "无音轨" : "无视频轨"}
      onSelect={(track) => void selectTrack(type, track.index)}
    />
  );

  const menuTrackItem = (track: TrackInfo, type: "audio" | "subtitle") => (
    <button
      key={`${type}-${track.index}`}
      className={`menu-item ${track.selected ? "selected" : ""}`}
      onClick={() => void selectTrack(type, track.index)}
    >
      <span className="menu-check">{track.selected && <Icon name="check" size={14} />}</span>
      <span className="menu-item-label">
        {track.title ?? `${track.language ?? "轨道"} ${track.index}`}
      </span>
      <span className="menu-meta">{track.codec}</span>
    </button>
  );

  return (
    <div
      className={`app-shell ${isFullscreen && !chromeVisible ? "chrome-hidden" : ""} ${
        isFullscreen ? "is-fullscreen" : ""
      }`}
    >
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">
            <Icon name="film" size={16} />
          </span>
          <span className="brand-name">WASM Player</span>
        </div>
        <div className="title" title={snapshot?.media?.name}>
          {snapshot?.media?.name ?? "未打开媒体"}
        </div>
        <div className="top-actions">
          <div className="menu-anchor" data-menu-root>
            <button
              className={`top-button ${openMenu === "open" ? "active" : ""}`}
              aria-haspopup="menu"
              aria-expanded={openMenu === "open"}
              onClick={() => setOpenMenu((value) => (value === "open" ? null : "open"))}
            >
              <Icon name="folder" />
              <span className="button-label">打开</span>
              <Icon name="chevronDown" size={14} />
            </button>
            {openMenu === "open" && (
              <div className="menu-panel open-menu" role="menu">
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    fileInputRef.current?.click();
                  }}
                >
                  <Icon name="folder" />
                  本地文件…
                </button>
                <button
                  className="menu-item"
                  role="menuitem"
                  onClick={() => {
                    setOpenMenu(null);
                    folderInputRef.current?.click();
                  }}
                >
                  <Icon name="library" />
                  打开文件夹…
                </button>
                <div className="menu-separator" />
                <div className="menu-label">打开网络链接</div>
                <form
                  className="menu-url"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void openUrl();
                  }}
                >
                  <Icon name="link" size={16} />
                  <input
                    value={openUrlDraft}
                    placeholder="https://example.com/video.mp4"
                    autoFocus
                    onChange={(event) => setOpenUrlDraft(event.target.value)}
                  />
                  <button className="menu-action" type="submit">
                    打开
                  </button>
                </form>
              </div>
            )}
          </div>
          <button
            className={`top-button ${showPlaylist ? "active" : ""}`}
            aria-label="媒体库"
            aria-pressed={showPlaylist}
            onClick={togglePlaylist}
          >
            <Icon name="library" />
            <span className="button-label">媒体库</span>
          </button>
          <div className="menu-anchor" data-menu-root>
            <button
              className={`icon-button ${openMenu === "more" ? "active" : ""}`}
              aria-label="更多"
              aria-haspopup="menu"
              aria-expanded={openMenu === "more"}
              onClick={() => setOpenMenu((value) => (value === "more" ? null : "more"))}
            >
              <Icon name="more" />
            </button>
            <div className="menu-panel more-menu" role="menu" hidden={openMenu !== "more"}>
              <div className="menu-label">应用</div>
              <button className="menu-item" role="menuitem" onClick={() => openSettings("app")}>
                <Icon name="sun" />
                应用外观与设置
                <span className="menu-meta">{themeLabel}</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                onClick={() => {
                  setShowStats((value) => !value);
                  openSettings("app");
                }}
              >
                <Icon name="stats" />
                播放统计
                <span className="menu-meta">{showStats ? "显示" : "隐藏"}</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!snapshot?.media}
                onClick={() => {
                  setOpenMenu(null);
                  setShowInfo(true);
                }}
              >
                <Icon name="info" />
                影片信息
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!snapshot?.media}
                onClick={() => {
                  setOpenMenu(null);
                  void stepFrame(1, "backward");
                }}
              >
                <Icon name="stepBack" />
                上一帧
                <span className="menu-meta">,</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!snapshot?.media}
                onClick={() => {
                  setOpenMenu(null);
                  void stepFrame(1, "forward");
                }}
              >
                <Icon name="stepForward" />
                下一帧
                <span className="menu-meta">.</span>
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!snapshot?.media}
                onClick={() => {
                  setOpenMenu(null);
                  void takeScreenshot();
                }}
              >
                <Icon name="camera" />
                截图
              </button>
              <button
                className="menu-item"
                role="menuitem"
                disabled={!snapshot?.media}
                onClick={() => {
                  setOpenMenu(null);
                  void takeStoryboard();
                }}
              >
                <Icon name="film" />
                剧情连拍（15 帧）
              </button>
              <div className="menu-separator" />
              <div
                className={`agent-status ${agentConnected ? "connected" : ""}`}
                title={agentConnected ? "Companion 已连接" : "Companion 尚未连接"}
              >
                <span className="dot" />
                {agentConnected ? "Agent 已连接" : "Agent 离线"}
              </div>
            </div>
          </div>
        </div>
      </header>

      <main className={`stage ${snapshot?.media ? "has-media" : "is-empty"}`}>
        <div
          className={`video-frame ${dragActive ? "drag-active" : ""}`}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
              setDragActive(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            const file = event.dataTransfer.files[0];
            if (!file) return;
            if (/\.(srt|vtt|ass|ssa)$/i.test(file.name)) {
              if (!snapshot?.media) {
                setMessage("请先打开视频，再拖入字幕文件");
                return;
              }
              void openSubtitle(file);
              return;
            }
            void openFile(file);
          }}
        >
          <canvas ref={canvasRef} className="video-canvas" />
          <div ref={overlayRef} className="overlay-host" />
          {!snapshot?.media && (
            <div className="empty-state">
              <div className="empty-glyph">
                <Icon name="film" size={30} />
              </div>
              <h1 className="empty-title">把视频放到这里</h1>
              <p className="empty-subtitle">
                拖放本地文件，或打开网络链接。支持 MP4、MKV、WebM、AVI 等常见格式。
              </p>
              <div className="empty-actions">
                <button
                  className="primary-button"
                  onClick={() => fileInputRef.current?.click()}
                >
                  <Icon name="folder" />
                  选择文件
                </button>
                <button
                  className="secondary-button"
                  onClick={() => folderInputRef.current?.click()}
                >
                  <Icon name="library" />
                  打开文件夹
                </button>
                <button
                  className="secondary-button"
                  aria-expanded={emptyUrlOpen}
                  onClick={() => setEmptyUrlOpen((value) => !value)}
                >
                  <Icon name="link" />
                  打开链接
                </button>
              </div>
              {emptyUrlOpen && (
                <form
                  className="empty-url"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void openUrl();
                  }}
                >
                  <input
                    value={openUrlDraft}
                    placeholder="https://example.com/video.mp4"
                    autoFocus
                    onChange={(event) => setOpenUrlDraft(event.target.value)}
                  />
                  <button className="secondary-button" type="submit">
                    打开
                  </button>
                </form>
              )}
              <div className="empty-hint">打开视频后，可拖入字幕文件（SRT / ASS / VTT）</div>
            </div>
          )}
          {dragActive && (
            <div className="drag-hint">
              <Icon name="folder" size={22} />
              松开以打开
            </div>
          )}
          {busy && <div className="stage-badge">正在打开…</div>}
          {snapshot?.buffering && <div className="stage-badge">缓冲中…</div>}
        </div>

        {showSettings && snapshot && (
          <aside className="drawer settings-drawer" aria-label="设置">
            <div className="drawer-header">
              <div>
                <h2>设置</h2>
                {settingsView === "app" && <p>外观、连接与诊断</p>}
              </div>
              <button
                className="icon-button"
                aria-label="关闭设置"
                onClick={() => setShowSettings(false)}
              >
                <Icon name="close" />
              </button>
            </div>

            <div className="settings-view-switch" role="tablist" aria-label="设置范围">
              <button
                role="tab"
                aria-selected={settingsView === "playback"}
                className={settingsView === "playback" ? "active" : ""}
                onClick={() => setSettingsView("playback")}
              >
                播放调节
              </button>
              <button
                role="tab"
                aria-selected={settingsView === "app"}
                className={settingsView === "app" ? "active" : ""}
                onClick={() => setSettingsView("app")}
              >
                应用设置
              </button>
            </div>

            {settingsView === "playback" ? (
              <>
                <div className="settings-tabs" role="tablist" aria-label="播放调节分类">
                  {SETTINGS_TABS.map((tab) => (
                    <button
                      key={tab.id}
                      role="tab"
                      aria-selected={settingsTab === tab.id}
                      className={settingsTab === tab.id ? "active" : ""}
                      onClick={() => setSettingsTab(tab.id)}
                    >
                      <Icon name={tab.icon} size={15} />
                      {tab.label}
                    </button>
                  ))}
                </div>

                <div className="settings-body">
                  {settingsTab === "picture" && (
                    <section className="settings-group">
                      <div className="settings-reset-row">
                        <button
                          className="reset-button"
                          aria-label="恢复画面默认"
                          onClick={() => void resetSettings(PICTURE_IDS)}
                        >
                          <Icon name="reset" size={14} />
                          恢复默认
                        </button>
                      </div>
                      <SelectRow
                        label={settingLabel("video.fit")}
                        value={String(snapshot.settings["video.fit"]?.effective ?? "contain")}
                        onChange={(value) => void applyPatch({ video: { fit: value } })}
                      >
                        <option value="contain">适应窗口</option>
                        <option value="cover">填满窗口</option>
                        <option value="fill">拉伸</option>
                        <option value="original">原始尺寸</option>
                      </SelectRow>
                      <SliderRow
                        label={settingLabel("video.brightness")}
                        value={Math.round(settingNumber(snapshot, "video.brightness", 0) * 100)}
                        min={-100}
                        max={100}
                        display={String(
                          Math.round(settingNumber(snapshot, "video.brightness", 0) * 100)
                        )}
                        issue={settingIssue(snapshot, "video.brightness")}
                        onChange={(value) => void applyPatch({ video: { brightness: value / 100 } })}
                      />
                      <SliderRow
                        label={settingLabel("video.contrast")}
                        value={Math.round(settingNumber(snapshot, "video.contrast", 1) * 100)}
                        min={0}
                        max={200}
                        display={`${Math.round(settingNumber(snapshot, "video.contrast", 1) * 100)}%`}
                        issue={settingIssue(snapshot, "video.contrast")}
                        onChange={(value) => void applyPatch({ video: { contrast: value / 100 } })}
                      />
                      <SliderRow
                        label={settingLabel("video.saturation")}
                        value={Math.round(settingNumber(snapshot, "video.saturation", 1) * 100)}
                        min={0}
                        max={200}
                        display={`${Math.round(settingNumber(snapshot, "video.saturation", 1) * 100)}%`}
                        issue={settingIssue(snapshot, "video.saturation")}
                        onChange={(value) => void applyPatch({ video: { saturation: value / 100 } })}
                      />
                      <details className="advanced">
                        <summary>高级选项</summary>
                        <SliderRow
                          label={settingLabel("video.gamma")}
                          value={Math.round(settingNumber(snapshot, "video.gamma", 1) * 100)}
                          min={10}
                          max={300}
                          display={`${settingNumber(snapshot, "video.gamma", 1).toFixed(2)}×`}
                          issue={settingIssue(snapshot, "video.gamma")}
                          onChange={(value) => void applyPatch({ video: { gamma: value / 100 } })}
                        />
                        <SliderRow
                          label={settingLabel("video.hueDeg")}
                          value={settingNumber(snapshot, "video.hueDeg", 0)}
                          min={-180}
                          max={180}
                          display={`${Math.round(settingNumber(snapshot, "video.hueDeg", 0))}°`}
                          issue={settingIssue(snapshot, "video.hueDeg")}
                          onChange={(value) => void applyPatch({ video: { hueDeg: value } })}
                        />
                        <SelectRow
                          label={settingLabel("video.rotationDeg")}
                          value={String(snapshot.settings["video.rotationDeg"]?.effective ?? 0)}
                          onChange={(value) =>
                            void applyPatch({ video: { rotationDeg: Number(value) } })
                          }
                        >
                          <option value="0">0°</option>
                          <option value="90">90°</option>
                          <option value="180">180°</option>
                          <option value="270">270°</option>
                        </SelectRow>
                        <SliderRow
                          label={settingLabel("video.sharpness")}
                          value={Math.round(settingNumber(snapshot, "video.sharpness", 0) * 100)}
                          min={0}
                          max={100}
                          display={`${Math.round(settingNumber(snapshot, "video.sharpness", 0) * 100)}%`}
                          issue={settingIssue(snapshot, "video.sharpness")}
                          onChange={(value) => void applyPatch({ video: { sharpness: value / 100 } })}
                        />
                        <SelectRow
                          label={settingLabel("video.scaleMode")}
                          value={String(
                            snapshot.settings["video.scaleMode"]?.effective ?? "high-quality"
                          )}
                          onChange={(value) =>
                            void applyPatch({ video: { scaleMode: value } })
                          }
                        >
                          <option value="high-quality">高质量（双三次）</option>
                          <option value="bilinear">双线性</option>
                          <option value="nearest">最近邻</option>
                        </SelectRow>
                        <div className="control-label spaced">视频轨</div>
                        {renderTrackList("video")}
                      </details>
                    </section>
                  )}

                  {settingsTab === "audio" && (
                    <section className="settings-group">
                      <div className="settings-reset-row">
                        <button
                          className="reset-button"
                          aria-label="恢复声音默认"
                          onClick={() => void resetSettings(AUDIO_IDS)}
                        >
                          <Icon name="reset" size={14} />
                          恢复默认
                        </button>
                      </div>
                      <SliderRow
                        label={settingLabel("audio.volume")}
                        value={Math.round(volume * 100)}
                        min={0}
                        max={100}
                        display={`${Math.round(volume * 100)}%`}
                        issue={settingIssue(snapshot, "audio.volume")}
                        onChange={(value) =>
                          void applyPatch({ audio: { volume: value / 100 } })
                        }
                      />
                      <ToggleRow
                        label={settingLabel("audio.muted")}
                        checked={muted}
                        onChange={(checked) =>
                          void applyPatch({ audio: { muted: checked } })
                        }
                      />
                      <SelectRow
                        label={settingLabel("audio.channel")}
                        value={String(snapshot.settings["audio.channel"]?.effective ?? "stereo")}
                        onChange={(value) =>
                          void applyGlobalPatch({ audio: { channel: value } })
                        }
                      >
                        <option value="stereo">立体声</option>
                        <option value="left">左声道</option>
                        <option value="right">右声道</option>
                      </SelectRow>
                      <div className="control-label spaced">音轨</div>
                      {renderTrackList("audio")}
                      <details className="advanced">
                        <summary>高级选项</summary>
                        <SliderRow
                          label={`${settingLabel("audio.gainDb")} (dB)`}
                          value={settingNumber(snapshot, "audio.gainDb", 0)}
                          min={-24}
                          max={12}
                          step={1}
                          display={signed(
                            Math.round(settingNumber(snapshot, "audio.gainDb", 0)),
                            " dB"
                          )}
                          issue={settingIssue(snapshot, "audio.gainDb")}
                          onChange={(value) => void applyPatch({ audio: { gainDb: value } })}
                        />
                        <SliderRow
                          label={settingLabel("audio.balance")}
                          value={Math.round(settingNumber(snapshot, "audio.balance", 0) * 100)}
                          min={-100}
                          max={100}
                          display={String(
                            Math.round(settingNumber(snapshot, "audio.balance", 0) * 100)
                          )}
                          issue={settingIssue(snapshot, "audio.balance")}
                          onChange={(value) =>
                            void applyPatch({ audio: { balance: value / 100 } })
                          }
                        />
                        <SliderRow
                          label={`${settingLabel("audio.delayMs")} (ms)`}
                          value={settingNumber(snapshot, "audio.delayMs", 0)}
                          min={-5000}
                          max={5000}
                          step={50}
                          display={signed(
                            Math.round(settingNumber(snapshot, "audio.delayMs", 0)),
                            "ms"
                          )}
                          issue={settingIssue(snapshot, "audio.delayMs")}
                          onChange={(value) => void applyPatch({ audio: { delayMs: value } })}
                        />
                        <SelectRow
                          label={settingLabel("audio.deviceId")}
                          value={String(snapshot.settings["audio.deviceId"]?.effective ?? "")}
                          onChange={(value) => void applyPatch({ audio: { deviceId: value } })}
                        >
                          <option value="">默认设备</option>
                          {audioDevices.map((device) => (
                            <option key={device.deviceId} value={device.deviceId}>
                              {device.label}
                            </option>
                          ))}
                        </SelectRow>
                        <div className="control-label spaced">10 段均衡器</div>
                        <div className="eq-grid">
                          {[31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map(
                            (frequency, index) => {
                              const value = eqValues[index] ?? 0;
                              return (
                                <label key={frequency} className="eq-band">
                                  <span>
                                    {frequency >= 1000 ? `${frequency / 1000}k` : frequency}
                                  </span>
                                  <input
                                    type="range"
                                    aria-label={`${frequency} Hz`}
                                    min={-12}
                                    max={12}
                                    value={value}
                                    style={
                                      {
                                        "--range-progress": `${((value + 12) / 24) * 100}%`
                                      } as CSSProperties
                                    }
                                    onChange={(event) => {
                                      const next = [...eqValues];
                                      next[index] = Number(event.target.value);
                                      void applyPatch({ audio: { eq: next } });
                                    }}
                                  />
                                  <em>{signed(value)}</em>
                                </label>
                              );
                            }
                          )}
                        </div>
                      </details>
                    </section>
                  )}

                  {settingsTab === "subtitle" && (
                    <section className="settings-group">
                      <div className="settings-reset-row">
                        <button
                          className="reset-button"
                          aria-label="恢复字幕默认"
                          onClick={() => void resetSettings(SUBTITLE_IDS)}
                        >
                          <Icon name="reset" size={14} />
                          恢复默认
                        </button>
                      </div>
                      <ToggleRow
                        label={settingLabel("subtitle.visible")}
                        checked={Boolean(snapshot.settings["subtitle.visible"]?.effective ?? true)}
                        onChange={(checked) =>
                          void applyPatch({ subtitle: { visible: checked } })
                        }
                      />
                      <SliderRow
                        label={settingLabel("subtitle.fontSizePct")}
                        value={Math.round(
                          settingNumber(snapshot, "subtitle.fontSizePct", 100)
                        )}
                        min={50}
                        max={250}
                        display={`${Math.round(
                          settingNumber(snapshot, "subtitle.fontSizePct", 100)
                        )}%`}
                        issue={settingIssue(snapshot, "subtitle.fontSizePct")}
                        onChange={(value) =>
                          void applyPatch({ subtitle: { fontSizePct: value } })
                        }
                      />
                      <SelectRow
                        label={settingLabel("subtitle.fontFamily")}
                        value={String(snapshot.settings["subtitle.fontFamily"]?.effective ?? "")}
                        onChange={(value) =>
                          void applyGlobalPatch({ subtitle: { fontFamily: value } })
                        }
                      >
                        <option value="">默认</option>
                        <option value="sans-serif">无衬线</option>
                        <option value="serif">衬线</option>
                        <option value="monospace">等宽</option>
                      </SelectRow>
                      <SliderRow
                        label={`${settingLabel("subtitle.delayMs")} (ms)`}
                        value={settingNumber(snapshot, "subtitle.delayMs", 0)}
                        min={-5000}
                        max={5000}
                        step={50}
                        display={signed(
                          Math.round(settingNumber(snapshot, "subtitle.delayMs", 0)),
                          "ms"
                        )}
                        issue={settingIssue(snapshot, "subtitle.delayMs")}
                        onChange={(value) => void applyPatch({ subtitle: { delayMs: value } })}
                      />
                      <div className="control-label spaced">字幕轨</div>
                      {renderTrackList("subtitle")}
                      <SelectRow
                        label="外挂字幕编码"
                        value={subtitleEncoding}
                        onChange={(value) => {
                          setSubtitleEncoding(value);
                          window.localStorage.setItem("wasm-player-subtitle-encoding", value);
                        }}
                      >
                        <option value="auto">自动检测</option>
                        <option value="utf-8">UTF-8</option>
                        <option value="utf-16le">UTF-16LE</option>
                        <option value="utf-16be">UTF-16BE</option>
                        <option value="gb18030">GB18030 / GBK</option>
                        <option value="big5">Big5</option>
                        <option value="shift_jis">Shift_JIS</option>
                        <option value="windows-1252">Windows-1252</option>
                      </SelectRow>
                      <button
                        className="secondary-button load-subtitle"
                        onClick={() => subtitleInputRef.current?.click()}
                      >
                        <Icon name="folder" size={15} />
                        加载外挂字幕
                      </button>
                      <details className="advanced">
                        <summary>高级选项</summary>
                        <ToggleRow
                          label={settingLabel("subtitle.forceStyle")}
                          checked={Boolean(
                            snapshot.settings["subtitle.forceStyle"]?.effective ?? false
                          )}
                          onChange={(checked) =>
                            void applyPatch({ subtitle: { forceStyle: checked } })
                          }
                        />
                      </details>
                    </section>
                  )}

                  {settingsTab === "playback" && (
                    <section className="settings-group">
                      <div className="settings-reset-row">
                        <button
                          className="reset-button"
                          aria-label="恢复播放默认"
                          onClick={() => void resetSettings(PLAYBACK_IDS)}
                        >
                          <Icon name="reset" size={14} />
                          恢复默认
                        </button>
                      </div>
                      <SelectRow
                        label={settingLabel("playback.rate")}
                        value={String(snapshot.rate)}
                        onChange={(value) =>
                          void invoke(ACTION_IDS.playbackSetRate, { rate: Number(value) })
                        }
                      >
                        {[0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4].map((value) => (
                          <option key={value} value={value}>
                            {value}×
                          </option>
                        ))}
                      </SelectRow>
                      <SelectRow
                        label={settingLabel("playback.loop")}
                        value={String(snapshot.settings["playback.loop"]?.effective ?? "off")}
                        onChange={(value) => void invoke(ACTION_IDS.loopSet, { mode: value })}
                      >
                        <option value="off">单个播放</option>
                        <option value="media">单个循环</option>
                        <option value="playlist">列表循环</option>
                        <option value="order">顺序播放</option>
                        <option value="shuffle">随机播放</option>
                      </SelectRow>
                      <ToggleRow
                        label={settingLabel("playback.autoPlay")}
                        checked={Boolean(
                          snapshot.settings["playback.autoPlay"]?.effective ?? false
                        )}
                        onChange={(checked) =>
                          void applyGlobalPatch({ playback: { autoPlay: checked } })
                        }
                      />
                      <ToggleRow
                        label={settingLabel("playback.pauseOnHidden")}
                        checked={pauseOnHidden}
                        onChange={(checked) =>
                          void applyGlobalPatch({ playback: { pauseOnHidden: checked } })
                        }
                      />
                      <details className="advanced">
                        <summary>高级选项</summary>
                        <SliderRow
                          label={settingLabel("playback.volumeStep")}
                          value={Math.round(
                            settingNumber(snapshot, "playback.volumeStep", 0.05) * 100
                          )}
                          min={1}
                          max={50}
                          display={`${Math.round(
                            settingNumber(snapshot, "playback.volumeStep", 0.05) * 100
                          )}%`}
                          onChange={(value) =>
                            void applyGlobalPatch({ playback: { volumeStep: value / 100 } })
                          }
                        />
                        <ToggleRow
                          label="优先 WASM 解码"
                          checked={forceWasm}
                          onChange={toggleForceWasm}
                        />
                        <button
                          className="secondary-button"
                          disabled={!snapshot.media || !lastSourceRef.current}
                          onClick={() => void reopenWithWasm()}
                        >
                          重新以 WASM 解码
                        </button>
                      </details>
                    </section>
                  )}
                </div>
              </>
            ) : (
              <div className="settings-body">
                <section className="settings-group">
                  <div className="group-header">
                    <h3>外观</h3>
                    <button
                      className="reset-button"
                      aria-label="恢复外观默认"
                      onClick={() => void resetSettings(APP_IDS)}
                    >
                      <Icon name="reset" size={14} />
                      恢复默认
                    </button>
                  </div>
                  <div className="theme-choice" role="group" aria-label="主题">
                    {(["system", "dark", "light"] as const).map((value) => (
                      <button
                        key={value}
                        className={String(themeSetting ?? "dark") === value ? "active" : ""}
                        onClick={() => void applyGlobalPatch({ app: { theme: value } })}
                      >
                        <Icon
                          name={value === "system" ? "monitor" : value === "dark" ? "moon" : "sun"}
                          size={15}
                        />
                        {THEME_LABELS[value]}
                      </button>
                    ))}
                  </div>
                  <ToggleRow
                    label={settingLabel("app.reduceMotion")}
                    checked={Boolean(reduceMotionSetting ?? false)}
                    onChange={(checked) =>
                      void applyGlobalPatch({ app: { reduceMotion: checked } })
                    }
                  />
                </section>

                <section className="settings-group">
                  <div className="group-header">
                    <h3>Agent 连接</h3>
                  </div>
                  <div className={`agent-row ${agentConnected ? "connected" : ""}`}>
                    <span className="dot" />
                    {agentConnected ? "Companion 已连接" : "Companion 未连接"}
                  </div>
                  <p className="hint">
                    由本地 Companion 或 MCP 客户端发起，静态安装包默认离线。
                  </p>
                </section>

                <section className="settings-group">
                  <div className="group-header">
                    <h3>播放统计</h3>
                    <button
                      className="reset-button"
                      onClick={() => setShowStats((value) => !value)}
                    >
                      <Icon name="stats" size={14} />
                      {showStats ? "隐藏" : "显示"}
                    </button>
                  </div>
                  {showStats ? (
                    <div className="stats-panel">
                      <div>
                        <span>阶段</span>
                        <strong>{snapshot.phase}</strong>
                      </div>
                      <div>
                        <span>解码路径</span>
                        <strong>
                          {Object.entries(snapshot.media?.decodePaths ?? {})
                            .map(([key, value]) => `${key}=${value}`)
                            .join(", ") || "—"}
                        </strong>
                      </div>
                      <div>
                        <span>视频队列</span>
                        <strong>
                          {snapshot.stats.videoQueueFrames} 帧 /{" "}
                          {(snapshot.stats.videoQueueBytes / 1024 / 1024).toFixed(1)} MiB
                        </strong>
                      </div>
                      <div>
                        <span>已渲染 / 丢帧</span>
                        <strong>
                          {snapshot.stats.renderedFrames} / {snapshot.stats.droppedVideoFrames}
                        </strong>
                      </div>
                      <div>
                        <span>音频欠载</span>
                        <strong>{snapshot.stats.audioUnderruns}</strong>
                      </div>
                      <div>
                        <span>WebCodecs / WebGL2</span>
                        <strong>
                          {snapshot.capabilities["webcodecs.video"]?.available ? "可用" : "不可用"} /{" "}
                          {snapshot.capabilities.webgl2?.available ? "可用" : "不可用"}
                        </strong>
                      </div>
                    </div>
                  ) : (
                    <p className="hint">打开统计后在此显示解码、队列与丢帧信息。</p>
                  )}
                </section>
              </div>
            )}
          </aside>
        )}

        {showPlaylist && snapshot && (
          <aside className="drawer library-drawer" aria-label="媒体库">
            <div className="drawer-header">
              <div>
                <h2>媒体库</h2>
                <p>播放列表、历史与书签</p>
              </div>
              <button
                className="icon-button"
                aria-label="关闭媒体库"
                onClick={() => setShowPlaylist(false)}
              >
                <Icon name="close" />
              </button>
            </div>
            <div className="library-tabs" role="tablist">
              {(
                [
                  ["playlist", "播放列表"],
                  ["history", "历史"],
                  ["bookmarks", "书签"]
                ] as const
              ).map(([tab, label]) => (
                <button
                  key={tab}
                  role="tab"
                  aria-selected={libraryTab === tab}
                  className={libraryTab === tab ? "active" : ""}
                  onClick={() => setLibraryTab(tab)}
                >
                  {label}
                </button>
              ))}
            </div>

            {libraryTab === "playlist" && (
              <>
                <div className="library-url">
                  <input
                    value={urlDraft}
                    placeholder="输入视频 URL"
                    onChange={(event) => setUrlDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void addUrlToPlaylist();
                    }}
                  />
                  <button className="secondary-button" onClick={() => void addUrlToPlaylist()}>
                    添加
                  </button>
                </div>
                {playlistItems.length === 0 ? (
                  <div className="muted">列表为空。可添加 HTTP 视频地址。</div>
                ) : (
                  <div className="library-list">
                    {playlistItems.map((item) => {
                      const local =
                        item.available !== false &&
                        item.identity !== undefined &&
                        localFilesRef.current.has(item.identity);
                      return (
                        <div
                          className={`library-item ${
                            draggingPlaylistIndex === item.index ? "dragging" : ""
                          }`}
                          key={`${item.index}-${item.name}`}
                          draggable
                          onDragStart={() => setDraggingPlaylistIndex(item.index)}
                          onDragOver={(event) => event.preventDefault()}
                          onDrop={(event) => {
                            event.preventDefault();
                            if (draggingPlaylistIndex !== null) {
                              void movePlaylistItem(draggingPlaylistIndex, item.index);
                            }
                            setDraggingPlaylistIndex(null);
                          }}
                          onDragEnd={() => setDraggingPlaylistIndex(null)}
                        >
                          <button
                            className={`library-main ${
                              playlistIndex === item.index ? "active" : ""
                            }`}
                            onClick={() => void playPlaylistItem(item)}
                          >
                            <span>{item.name}</span>
                            <small>
                              {item.kind === "file"
                                ? local
                                  ? "本地文件"
                                  : "本地文件 · 需重新选择"
                                : item.url ?? item.sourceId ?? ""}
                            </small>
                          </button>
                          <button
                            className="library-remove"
                            aria-label={`移除 ${item.name}`}
                            onClick={async () => {
                              const result = await invoke(ACTION_IDS.playlistRemove, {
                                index: item.index
                              });
                              const items =
                                (result.output as { items?: PlaylistEntry[] } | undefined)
                                  ?.items ?? [];
                              setPlaylistItems(items);
                            }}
                          >
                            <Icon name="close" size={15} />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
                {playlistItems.length > 0 && (
                  <button
                    className="secondary-button"
                    onClick={async () => {
                      await invoke(ACTION_IDS.playlistClear);
                      setPlaylistItems([]);
                    }}
                  >
                    清空列表
                  </button>
                )}
              </>
            )}

            {libraryTab === "history" && (
              <div className="library-list">
                {historyItems.length === 0 && <div className="muted">暂无播放历史。</div>}
                {historyItems.map((item) => {
                  const reopenable =
                    item.source !== undefined ||
                    item.id.startsWith("http://") ||
                    item.id.startsWith("https://");
                  return (
                    <button
                      key={`${item.id}-${item.lastPlayedAt}`}
                      className={`library-main library-row ${
                        snapshot.media?.sourceId === item.id ? "active" : ""
                      }`}
                      disabled={!reopenable}
                      onClick={() => void openHistory(item)}
                      title={reopenable ? "从上次位置继续" : "本地文件需要重新选择"}
                    >
                      <span>{item.name}</span>
                      <small>
                        {formatTime(item.positionUs)} / {formatTime(item.durationUs)} ·{" "}
                        {new Date(item.lastPlayedAt).toLocaleString()}
                      </small>
                    </button>
                  );
                })}
              </div>
            )}

            {libraryTab === "bookmarks" && (
              <>
                <button
                  className="secondary-button"
                  disabled={!snapshot.media}
                  onClick={() => void addBookmark()}
                >
                  在当前位置添加书签
                </button>
                <div className="library-list">
                  {bookmarkItems.length === 0 && (
                    <div className="muted">
                      {snapshot.media ? "当前媒体暂无书签。" : "打开媒体后可添加书签。"}
                    </div>
                  )}
                  {bookmarkItems.map((item) => (
                    <div className="library-item" key={item.id}>
                      <button
                        className="library-main"
                        onClick={() =>
                          void invoke(ACTION_IDS.playbackSeek, { positionUs: item.positionUs })
                        }
                      >
                        <span>{item.name}</span>
                        <small>{formatTime(item.positionUs)}</small>
                      </button>
                      <button
                        className="library-remove"
                        aria-label={`删除书签 ${item.name}`}
                        onClick={() =>
                          void invoke(ACTION_IDS.bookmarksRemove, { id: item.id })
                        }
                      >
                        <Icon name="close" size={15} />
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
        )}

        {showInfo && snapshot?.media && (
          <div
            className="info-backdrop"
            role="presentation"
            onClick={() => setShowInfo(false)}
          >
            <section
              className="info-dialog"
              role="dialog"
              aria-modal="true"
              aria-label="影片信息"
              onClick={(event) => event.stopPropagation()}
            >
              <div className="drawer-header">
                <div>
                  <h2>影片信息</h2>
                  <p>{snapshot.media.name}</p>
                </div>
                <button
                  className="icon-button"
                  aria-label="关闭影片信息"
                  onClick={() => setShowInfo(false)}
                >
                  <Icon name="close" />
                </button>
              </div>
              <div className="info-grid">
                <span>容器</span>
                <strong>{snapshot.media.container ?? "未知"}</strong>
                <span>大小</span>
                <strong>{formatBytes(snapshot.media.sizeBytes)}</strong>
                <span>时长</span>
                <strong>{formatTime(snapshot.media.durationUs)}</strong>
                <span>来源</span>
                <strong>{snapshot.media.sourceKind}</strong>
                <span>可拖动</span>
                <strong>{snapshot.media.seekable ? "是" : "否"}</strong>
                <span>解码路径</span>
                <strong>
                  {Object.entries(snapshot.media.decodePaths)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(", ") || "—"}
                </strong>
              </div>
              <div className="info-tracks">
                <h3>媒体流</h3>
                {snapshot.media.streams.map((stream) => (
                  <div className="info-track" key={`${stream.type}-${stream.index}`}>
                    <span className="info-track-type">{stream.type}</span>
                    <span>
                      {stream.codec}
                      {stream.width && stream.height
                        ? ` · ${stream.width}×${stream.height}`
                        : ""}
                      {stream.channels ? ` · ${stream.channels}ch` : ""}
                      {stream.language ? ` · ${stream.language}` : ""}
                    </span>
                    {stream.title && <small>{stream.title}</small>}
                  </div>
                ))}
                {snapshot.media.warnings.length > 0 && (
                  <div className="info-warnings">
                    {snapshot.media.warnings.map((warning) => (
                      <div key={warning}>{warning}</div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          </div>
        )}
      </main>

      {snapshot?.media && (
        <footer className="control-deck" aria-label="播放控制">
          <div className="timeline-row">
            <input
              className="timeline-range"
              type="range"
              aria-label="播放进度"
              min={0}
              max={Math.max(1, durationUs)}
              value={positionUs}
              style={{ "--progress": `${progress}%` } as CSSProperties}
              onChange={(event) => setSeekUs(Number(event.target.value))}
              onPointerUp={() => commitSeek(seekUs)}
              onKeyUp={(event) => {
                if (["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)) {
                  commitSeek(seekUs);
                }
              }}
            />
          </div>
          <div className="controls-row">
            <div className="controls-left">
              <button
                className="icon-button"
                aria-label="上一个"
                data-tooltip="上一个"
                disabled={playlistItems.length === 0 && !snapshot?.media}
                onClick={() => void playAdjacent(-1)}
              >
                <Icon name="skipBack" />
              </button>
              <button
                className="icon-button play-button"
                onClick={() => void togglePlay()}
                aria-label="播放/暂停"
                title="播放/暂停 (Space)"
                data-tooltip="播放/暂停 (Space)"
              >
                <Icon name={snapshot.phase === "playing" ? "pause" : "play"} size={18} />
              </button>
              <button
                className="icon-button"
                aria-label="下一个"
                data-tooltip="下一个"
                disabled={playlistItems.length === 0 && !snapshot?.media}
                onClick={() => void playAdjacent(1)}
              >
                <Icon name="skipForward" />
              </button>
              <span className="time" aria-label="播放时间">
                <span className="time-current">{formatTime(positionUs)}</span>
                <span className="time-sep">/</span>
                <span>{formatTime(durationUs)}</span>
              </span>
            </div>

            <div className="controls-right">
              <div className="menu-anchor" data-menu-root>
                <button
                  className={`icon-button ${openMenu === "volume" ? "active" : ""}`}
                  aria-label="音量"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "volume"}
                  data-tooltip="音量 (↑ / ↓)"
                  onClick={() => setOpenMenu((value) => (value === "volume" ? null : "volume"))}
                >
                  <Icon name={muted || volume === 0 ? "volumeOff" : "volume"} />
                </button>
                {openMenu === "volume" && (
                  <div className="menu-panel volume-menu" role="menu">
                    <div className="volume-head">
                      <span>音量</span>
                      <span>{Math.round(volume * 100)}%</span>
                    </div>
                    <input
                      className="volume"
                      type="range"
                      aria-label="音量滑块"
                      min={0}
                      max={100}
                      value={Math.round(volume * 100)}
                      style={
                        {
                          "--range-progress": `${Math.round(volume * 100)}%`
                        } as CSSProperties
                      }
                      onChange={(event) =>
                        void applyPatch({ audio: { volume: Number(event.target.value) / 100 } })
                      }
                    />
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={() => void applyPatch({ audio: { muted: !muted } })}
                    >
                      <Icon name={muted ? "volume" : "volumeOff"} size={16} />
                      {muted ? "取消静音" : "静音"}
                    </button>
                  </div>
                )}
              </div>

              <div className="menu-anchor" data-menu-root>
                <button
                  className={`rate-button ${openMenu === "rate" ? "active" : ""}`}
                  aria-label="播放速度"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "rate"}
                  data-tooltip={`播放速度 ${rate}×`}
                  onClick={() => setOpenMenu((value) => (value === "rate" ? null : "rate"))}
                >
                  {rate}×
                </button>
                {openMenu === "rate" && (
                  <div className="menu-panel rate-menu" role="menu">
                    <div className="menu-label">播放速度</div>
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={() => void setRateBy(-0.1)}
                    >
                      <span className="menu-item-label">减速 0.1×</span>
                      <span className="menu-meta">Ctrl+←</span>
                    </button>
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={() => void setRateBy(0.1)}
                    >
                      <span className="menu-item-label">加速 0.1×</span>
                      <span className="menu-meta">Ctrl+→</span>
                    </button>
                    <div className="menu-separator" />
                    {[0.5, 0.75, 1, 1.25, 1.5, 2, 2.5, 3, 4].map((value) => (
                      <button
                        key={value}
                        className={`menu-item ${rate === value ? "selected" : ""}`}
                        role="menuitem"
                        onClick={() => {
                          void invoke(ACTION_IDS.playbackSetRate, { rate: value });
                          setOpenMenu(null);
                        }}
                      >
                        <span className="menu-check">
                          {rate === value && <Icon name="check" size={14} />}
                        </span>
                        <span className="menu-item-label">{value}×</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>

              <div className="menu-anchor" data-menu-root>
                <button
                  className={`icon-button audio-control ${openMenu === "audio" ? "active" : ""}`}
                  aria-label="音轨"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "audio"}
                  data-tooltip="音轨"
                  onClick={() => setOpenMenu((value) => (value === "audio" ? null : "audio"))}
                >
                  <Icon name="audio" />
                </button>
                {openMenu === "audio" && (
                  <div className="menu-panel track-menu" role="menu">
                    <div className="menu-label">音轨</div>
                    {(tracksByType.audio ?? []).length === 0 ? (
                      <div className="menu-empty">无音轨</div>
                    ) : (
                      (tracksByType.audio ?? []).map((track) => menuTrackItem(track, "audio"))
                    )}
                  </div>
                )}
              </div>

              <div className="menu-anchor" data-menu-root>
                <button
                  className={`icon-button ${openMenu === "subtitle" ? "active" : ""}`}
                  aria-label="字幕"
                  aria-haspopup="menu"
                  aria-expanded={openMenu === "subtitle"}
                  data-tooltip="字幕"
                  onClick={() =>
                    setOpenMenu((value) => (value === "subtitle" ? null : "subtitle"))
                  }
                >
                  <Icon name="subtitles" />
                </button>
                {openMenu === "subtitle" && (
                  <div className="menu-panel track-menu" role="menu">
                    <div className="menu-label">字幕轨</div>
                    {(tracksByType.subtitle ?? []).length === 0 ? (
                      <div className="menu-empty">无字幕轨</div>
                    ) : (
                      (tracksByType.subtitle ?? []).map((track) =>
                        menuTrackItem(track, "subtitle")
                      )
                    )}
                    <div className="menu-separator" />
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={() => {
                        setOpenMenu(null);
                        subtitleInputRef.current?.click();
                      }}
                    >
                      <Icon name="folder" />
                      加载外挂字幕…
                    </button>
                    <button
                      className="menu-item"
                      role="menuitem"
                      onClick={() =>
                        void applyPatch({
                          subtitle: { visible: !subtitleVisible }
                        })
                      }
                    >
                      <Icon name={subtitleVisible ? "check" : "close"} size={16} />
                      {subtitleVisible ? "隐藏字幕" : "显示字幕"}
                    </button>
                  </div>
                )}
              </div>

              <button
                className="icon-button"
                aria-label="设置"
                data-tooltip="播放设置"
                onClick={() => openSettings("playback")}
              >
                <Icon name="settings" />
              </button>

              <button
                className="icon-button"
                aria-label={isFullscreen ? "退出全屏" : "全屏"}
                data-tooltip={isFullscreen ? "退出全屏 (F)" : "全屏 (F)"}
                onClick={() =>
                  void invoke(ACTION_IDS.uiSet, {
                    fullscreen: !document.fullscreenElement
                  })
                }
              >
                <Icon name={isFullscreen ? "exitFullscreen" : "fullscreen"} />
              </button>
            </div>
          </div>
        </footer>
      )}

      {message && (
        <div className="toast" role="status">
          {message}
        </div>
      )}

      <input
        ref={fileInputRef}
        type="file"
        accept="video/*,audio/*,.mkv,.avi,.flv,.ts,.m2ts,.vob,.ogv,.wav,.flac"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openFile(file);
          event.target.value = "";
        }}
      />
      <input
        ref={subtitleInputRef}
        type="file"
        accept=".srt,.vtt,.ass,.ssa"
        hidden
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) void openSubtitle(file);
          event.target.value = "";
        }}
      />
      <input
        ref={folderInputRef}
        type="file"
        multiple
        hidden
        {...({ webkitdirectory: "", directory: "" } as Record<string, string>)}
        onChange={(event) => {
          if (event.target.files?.length) void openFolder(event.target.files);
          event.target.value = "";
        }}
      />
    </div>
  );
}
