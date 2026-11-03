import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACTION_IDS,
  type ActionId,
  type Bookmark,
  type HistoryItem,
  type MediaSourceInput,
  type InvokeResult,
  type PlayerSnapshot,
  type TrackInfo
} from "@wasm-player/contracts";
import { PlayerController } from "@wasm-player/player-core";
import { createPlayerStorage } from "@wasm-player/storage";
import { BrowserMediaEngine } from "./player/browser-media-engine";
import { browserHost } from "@wasm-player/host";
import { CompanionClient, type CompanionBootstrap } from "./player/companion-client";

function formatTime(us: number): string {
  if (!Number.isFinite(us) || us < 0) return "0:00";
  const total = Math.floor(us / 1_000_000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}:${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function statusLabel(snapshot: PlayerSnapshot | null): string {
  if (!snapshot) return "初始化中";
  switch (snapshot.phase) {
    case "opening":
      return "打开中";
    case "ready":
      return "就绪";
    case "playing":
      return "播放中";
    case "paused":
      return "已暂停";
    case "buffering":
      return "缓冲中";
    case "seeking":
      return "定位中";
    case "ended":
      return "已结束";
    case "error":
      return "错误";
    default:
      return snapshot.phase;
  }
}

function effectiveStatus(snapshot: PlayerSnapshot, id: string): string {
  const value = snapshot.settings[id];
  if (!value) return "默认";
  if (value.status === "unsupported") return "不支持";
  if (value.status === "failed") return "失败";
  return value.layer === "default" ? "默认" : "已生效";
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const subtitleInputRef = useRef<HTMLInputElement | null>(null);
  const controllerRef = useRef<PlayerController | null>(null);
  const lastSourceRef = useRef<MediaSourceInput | null>(null);
  const [forceWasm, setForceWasm] = useState(
    () => window.localStorage.getItem("wasm-player-force-wasm") === "1"
  );
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [message, setMessage] = useState<string>("");
  const [seekUs, setSeekUs] = useState<number | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [libraryTab, setLibraryTab] = useState<"playlist" | "history" | "bookmarks">("playlist");
  const [playlistItems, setPlaylistItems] = useState<
    { index: number; name: string; url?: string; sourceId?: string; durationUs?: number }[]
  >([]);
  const [historyItems, setHistoryItems] = useState<HistoryItem[]>([]);
  const [bookmarkItems, setBookmarkItems] = useState<Bookmark[]>([]);
  const [urlDraft, setUrlDraft] = useState("");
  const [audioDevices, setAudioDevices] = useState<{ deviceId: string; label: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [agentConnected, setAgentConnected] = useState(false);
  const requestSeq = useRef(0);
  const themeSetting = snapshot?.settings["app.theme"]?.effective;
  const reduceMotionSetting = snapshot?.settings["app.reduceMotion"]?.effective;
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
      if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement) {
        return;
      }
      if (event.code === "Space") {
        event.preventDefault();
        void togglePlay();
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
      const source: MediaSourceInput = { kind: "file", file, name: file.name };
      lastSourceRef.current = source;
      await invoke(ACTION_IDS.mediaOpen, {
        source,
        autoPlay: Boolean(snapshot?.settings["playback.autoPlay"]?.effective ?? false),
        ...(forceWasm ? { forceDecodePath: { video: "wasm", audio: "wasm" } } : {})
      });
    } finally {
      setBusy(false);
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

  const openSubtitle = async (file: File) => {
    await invoke(ACTION_IDS.subtitlesLoad, { file, name: file.name });
  };

  const applyPatch = async (patch: Record<string, unknown>) => {
    await invoke(ACTION_IDS.settingsApply, { scope: "session", patch });
  };

  const applyGlobalPatch = async (patch: Record<string, unknown>) => {
    await invoke(ACTION_IDS.settingsApply, { scope: "global", patch });
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
      await invoke(ACTION_IDS.playlistAdd, {
        sources: [
          {
            kind: "url",
            url: parsed.href,
            name: parsed.pathname.split("/").pop() || parsed.hostname
          }
        ]
      });
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

  const playPlaylistItem = async (item: {
    index: number;
    name: string;
    url?: string;
    sourceId?: string;
  }) => {
    if (item.url) {
      lastSourceRef.current = { kind: "url", url: item.url, name: item.name };
    } else if (item.sourceId) {
      lastSourceRef.current = { kind: "sourceId", sourceId: item.sourceId, name: item.name };
    }
    await invoke(ACTION_IDS.playlistPlay, { index: item.index });
  };

  const takeScreenshot = async () => {
    const accepted = await invoke(ACTION_IDS.captureCreate, {
      includeSubtitles: true,
      format: "png"
    });
    const jobId = accepted.jobId;
    if (!jobId) return;
    const controller = controllerRef.current;
    if (!controller) return;
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
        const blob = controller.getJobBlob(jobId);
        if (blob) {
          const url = URL.createObjectURL(blob);
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.download = `screenshot-${Date.now()}.png`;
          anchor.click();
          setTimeout(() => URL.revokeObjectURL(url), 5000);
        }
        return;
      }
      if (result?.status === "failed") {
        setMessage("截图失败");
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    setMessage("截图超时");
  };

  const tracksByType = useMemo(() => {
    const groups: Record<string, TrackInfo[]> = { video: [], audio: [], subtitle: [] };
    for (const track of snapshot?.tracks ?? []) groups[track.type]?.push(track);
    return groups;
  }, [snapshot?.tracks]);

  const sliderValue = (id: string, fallback: number, scale = 1): number => {
    const value = snapshot?.settings[id];
    const effective = value?.effective;
    return typeof effective === "number" ? effective * scale : fallback;
  };

  const eqValues = Array.isArray(snapshot?.settings["audio.eq"]?.effective)
    ? (snapshot?.settings["audio.eq"]?.effective as number[])
    : Array.from({ length: 10 }, () => 0);

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">W</span>
          <span>WASM Player</span>
        </div>
        <div className="title" title={snapshot?.media?.name}>
          {snapshot?.media?.name ?? "未打开媒体"}
        </div>
        <div className="top-actions">
          <button className="ghost-button" onClick={() => fileInputRef.current?.click()}>
            打开
          </button>
          <button
            className={`ghost-button ${showPlaylist ? "active" : ""}`}
            onClick={() => {
              setShowPlaylist((value) => !value);
              setShowSettings(false);
            }}
          >
            列表
          </button>
          <button
            className={`ghost-button ${showSettings ? "active" : ""}`}
            onClick={() => {
              setShowSettings((value) => !value);
              setShowPlaylist(false);
            }}
          >
            设置
          </button>
          <span
            className={`agent-status ${agentConnected ? "connected" : ""}`}
            title={agentConnected ? "Companion 已连接" : "Companion 尚未连接"}
          >
            <span className="dot" /> {agentConnected ? "Agent 已连接" : "Agent 离线"}
          </span>
        </div>
      </header>

      <main className="stage">
        <div
          className="video-frame"
          onDragOver={(event) => event.preventDefault()}
          onDrop={(event) => {
            event.preventDefault();
            const file = event.dataTransfer.files[0];
            if (file) void openFile(file);
          }}
        >
          <canvas ref={canvasRef} className="video-canvas" />
          <div ref={overlayRef} className="overlay-host" />
          {!snapshot?.media && (
            <div className="empty-state">
              <div className="empty-title">打开一个视频</div>
              <div className="empty-subtitle">拖放文件，或选择本地文件开始播放</div>
              <button className="primary-button" onClick={() => fileInputRef.current?.click()}>
                选择文件
              </button>
            </div>
          )}
          {busy && <div className="stage-badge">正在打开…</div>}
          {snapshot?.buffering && <div className="stage-badge">缓冲中…</div>}
        </div>

        {showSettings && snapshot && (
          <aside className="drawer">
            <div className="drawer-header">
              <h2>设置</h2>
              <button className="icon-button" onClick={() => setShowSettings(false)}>
                ×
              </button>
            </div>
            <section>
              <h3>外观</h3>
              <label className="control-row">
                <span>主题</span>
                <select
                  value={String(themeSetting ?? "dark")}
                  onChange={(event) =>
                    void applyGlobalPatch({ app: { theme: event.target.value } })
                  }
                >
                  <option value="system">跟随系统</option>
                  <option value="dark">深色</option>
                  <option value="light">浅色</option>
                </select>
              </label>
              <label className="control-row checkbox">
                <span>减少动态效果</span>
                <input
                  type="checkbox"
                  checked={Boolean(reduceMotionSetting ?? false)}
                  onChange={(event) =>
                    void applyGlobalPatch({ app: { reduceMotion: event.target.checked } })
                  }
                />
              </label>
            </section>
            <section>
              <h3>画面</h3>
              <label className="control-row">
                <span>亮度 <em>{effectiveStatus(snapshot, "video.brightness")}</em></span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={sliderValue("video.brightness", 0, 100)}
                  onChange={(event) =>
                    void applyPatch({ video: { brightness: Number(event.target.value) / 100 } })
                  }
                />
              </label>
              <label className="control-row">
                <span>对比度 <em>{effectiveStatus(snapshot, "video.contrast")}</em></span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={sliderValue("video.contrast", 100, 100)}
                  onChange={(event) =>
                    void applyPatch({ video: { contrast: Number(event.target.value) / 100 } })
                  }
                />
              </label>
              <label className="control-row">
                <span>饱和度 <em>{effectiveStatus(snapshot, "video.saturation")}</em></span>
                <input
                  type="range"
                  min={0}
                  max={200}
                  value={sliderValue("video.saturation", 100, 100)}
                  onChange={(event) =>
                    void applyPatch({ video: { saturation: Number(event.target.value) / 100 } })
                  }
                />
              </label>
              <label className="control-row">
                <span>Gamma <em>{effectiveStatus(snapshot, "video.gamma")}</em></span>
                <input
                  type="range"
                  min={10}
                  max={300}
                  value={sliderValue("video.gamma", 100, 100)}
                  onChange={(event) =>
                    void applyPatch({ video: { gamma: Number(event.target.value) / 100 } })
                  }
                />
              </label>
              <label className="control-row">
                <span>色相 <em>{effectiveStatus(snapshot, "video.hueDeg")}</em></span>
                <input
                  type="range"
                  min={-180}
                  max={180}
                  value={sliderValue("video.hueDeg", 0)}
                  onChange={(event) =>
                    void applyPatch({ video: { hueDeg: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="control-row">
                <span>旋转 <em>{effectiveStatus(snapshot, "video.rotationDeg")}</em></span>
                <select
                  value={String(snapshot.settings["video.rotationDeg"]?.effective ?? 0)}
                  onChange={(event) =>
                    void applyPatch({ video: { rotationDeg: Number(event.target.value) } })
                  }
                >
                  <option value="0">0°</option>
                  <option value="90">90°</option>
                  <option value="180">180°</option>
                  <option value="270">270°</option>
                </select>
              </label>
              <label className="control-row">
                <span>锐化 <em>{effectiveStatus(snapshot, "video.sharpness")}</em></span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={sliderValue("video.sharpness", 0, 100)}
                  onChange={(event) =>
                    void applyPatch({ video: { sharpness: Number(event.target.value) / 100 } })
                  }
                />
              </label>
              <label className="control-row">
                <span>缩放 <em>{effectiveStatus(snapshot, "video.scaleMode")}</em></span>
                <select
                  value={String(snapshot.settings["video.scaleMode"]?.effective ?? "high-quality")}
                  onChange={(event) =>
                    void applyPatch({ video: { scaleMode: event.target.value } })
                  }
                >
                  <option value="high-quality">高质量</option>
                  <option value="bilinear">双线性</option>
                  <option value="nearest">最近邻</option>
                </select>
              </label>
              <label className="control-row">
                <span>画面适配</span>
                <select
                  value={(snapshot.settings["video.fit"]?.effective as string) ?? "contain"}
                  onChange={(event) => void applyPatch({ video: { fit: event.target.value } })}
                >
                  <option value="contain">适应窗口</option>
                  <option value="cover">填满窗口</option>
                  <option value="fill">拉伸</option>
                  <option value="original">原始尺寸</option>
                </select>
              </label>
            </section>
            <section>
              <h3>音频</h3>
              <label className="control-row">
                <span>音量 <em>{effectiveStatus(snapshot, "audio.volume")}</em></span>
                <input
                  type="range"
                  min={0}
                  max={100}
                  value={Math.round(snapshot.volume * 100)}
                  onChange={(event) =>
                    void applyPatch({ audio: { volume: Number(event.target.value) / 100 } })
                  }
                />
              </label>
              <label className="control-row checkbox">
                <span>静音</span>
                <input
                  type="checkbox"
                  checked={snapshot.muted}
                  onChange={(event) => void applyPatch({ audio: { muted: event.target.checked } })}
                />
              </label>
              <label className="control-row">
                <span>增益 (dB) <em>{effectiveStatus(snapshot, "audio.gainDb")}</em></span>
                <input
                  type="range"
                  min={-24}
                  max={12}
                  value={sliderValue("audio.gainDb", 0)}
                  onChange={(event) =>
                    void applyPatch({ audio: { gainDb: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="control-row">
                <span>左右平衡 <em>{effectiveStatus(snapshot, "audio.balance")}</em></span>
                <input
                  type="range"
                  min={-100}
                  max={100}
                  value={sliderValue("audio.balance", 0, 100)}
                  onChange={(event) =>
                    void applyPatch({ audio: { balance: Number(event.target.value) / 100 } })
                  }
                />
              </label>
              <label className="control-row">
                <span>音频延迟 (ms) <em>{effectiveStatus(snapshot, "audio.delayMs")}</em></span>
                <input
                  type="range"
                  min={-5000}
                  max={5000}
                  step={50}
                  value={sliderValue("audio.delayMs", 0)}
                  onChange={(event) =>
                    void applyPatch({ audio: { delayMs: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="control-row">
                <span>输出设备 <em>{effectiveStatus(snapshot, "audio.deviceId")}</em></span>
                <select
                  value={String(snapshot.settings["audio.deviceId"]?.effective ?? "")}
                  onChange={(event) =>
                    void applyPatch({ audio: { deviceId: event.target.value } })
                  }
                >
                  <option value="">默认设备</option>
                  {audioDevices.map((device) => (
                    <option key={device.deviceId} value={device.deviceId}>
                      {device.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="eq-grid">
                {[31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000].map((frequency, index) => (
                  <label key={frequency} className="eq-band">
                    <span>{frequency >= 1000 ? `${frequency / 1000}k` : frequency}</span>
                    <input
                      type="range"
                      min={-12}
                      max={12}
                      value={eqValues[index] ?? 0}
                      onChange={(event) => {
                        const next = [...eqValues];
                        next[index] = Number(event.target.value);
                        void applyPatch({ audio: { eq: next } });
                      }}
                    />
                  </label>
                ))}
              </div>
            </section>
            <section>
              <h3>字幕</h3>
              <label className="control-row">
                <span>延迟 (ms) <em>{effectiveStatus(snapshot, "subtitle.delayMs")}</em></span>
                <input
                  type="range"
                  min={-5000}
                  max={5000}
                  step={50}
                  value={sliderValue("subtitle.delayMs", 0)}
                  onChange={(event) =>
                    void applyPatch({ subtitle: { delayMs: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="control-row">
                <span>字号 (%) <em>{effectiveStatus(snapshot, "subtitle.fontSizePct")}</em></span>
                <input
                  type="range"
                  min={50}
                  max={200}
                  value={sliderValue("subtitle.fontSizePct", 100)}
                  onChange={(event) =>
                    void applyPatch({ subtitle: { fontSizePct: Number(event.target.value) } })
                  }
                />
              </label>
              <label className="control-row checkbox">
                <span>显示字幕</span>
                <input
                  type="checkbox"
                  checked={Boolean(snapshot.settings["subtitle.visible"]?.effective ?? true)}
                  onChange={(event) =>
                    void applyPatch({ subtitle: { visible: event.target.checked } })
                  }
                />
              </label>
              <button className="secondary-button" onClick={() => subtitleInputRef.current?.click()}>
                加载外挂字幕
              </button>
            </section>
            <section>
              <h3>播放</h3>
              <label className="control-row">
                <span>倍速</span>
                <select
                  value={String(snapshot.rate)}
                  onChange={(event) =>
                    void invoke(ACTION_IDS.playbackSetRate, { rate: Number(event.target.value) })
                  }
                >
                  {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
                    <option key={rate} value={rate}>
                      {rate}×
                    </option>
                  ))}
                </select>
              </label>
              <label className="control-row">
                <span>循环</span>
                <select
                  value={String(snapshot.settings["playback.loop"]?.effective ?? "off")}
                  onChange={(event) =>
                    void invoke(ACTION_IDS.loopSet, { mode: event.target.value })
                  }
                >
                  <option value="off">关闭</option>
                  <option value="media">单个文件</option>
                  <option value="playlist">播放列表</option>
                </select>
              </label>
              <label className="control-row checkbox">
                <span>打开后自动播放</span>
                <input
                  type="checkbox"
                  checked={Boolean(snapshot.settings["playback.autoPlay"]?.effective ?? false)}
                  onChange={(event) =>
                    void applyGlobalPatch({ playback: { autoPlay: event.target.checked } })
                  }
                />
              </label>
              <label className="control-row checkbox">
                <span>优先 WASM 解码</span>
                <input
                  type="checkbox"
                  checked={forceWasm}
                  onChange={(event) => toggleForceWasm(event.target.checked)}
                />
              </label>
              <button
                className="secondary-button"
                disabled={!snapshot.media || !lastSourceRef.current}
                onClick={() => void reopenWithWasm()}
              >
                重新以 WASM 解码
              </button>
            </section>
            <section>
              <h3>轨道</h3>
              {(["video", "audio", "subtitle"] as const).map((type) => (
                <div className="track-group" key={type}>
                  <div className="track-label">
                    {type === "video" ? "视频" : type === "audio" ? "音频" : "字幕"}
                  </div>
                  {(tracksByType[type] ?? []).length === 0 && <div className="muted">无</div>}
                  {(tracksByType[type] ?? []).map((track) => (
                    <button
                      key={track.id}
                      className={`track-item ${track.selected ? "selected" : ""}`}
                      onClick={() =>
                        void invoke(ACTION_IDS.tracksSelect, { type, index: track.index })
                      }
                    >
                      {track.title ?? `${type} ${track.index}`}
                      {track.language ? ` · ${track.language}` : ""}
                      <span className="track-codec">{track.codec}</span>
                    </button>
                  ))}
                </div>
              ))}
            </section>
            <section>
              <h3>诊断</h3>
              <button className="secondary-button" onClick={() => setShowStats((value) => !value)}>
                {showStats ? "隐藏统计" : "显示统计"}
              </button>
              <button className="secondary-button" onClick={() => void takeScreenshot()}>
                截图
              </button>
            </section>
          </aside>
        )}

        {showPlaylist && snapshot && (
          <aside className="drawer library-drawer">
            <div className="drawer-header">
              <h2>媒体库</h2>
              <button className="icon-button" onClick={() => setShowPlaylist(false)}>
                ×
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
                    {playlistItems.map((item) => (
                      <div className="library-item" key={`${item.index}-${item.name}`}>
                        <button
                          className="library-main"
                          onClick={() => void playPlaylistItem(item)}
                        >
                          <span>{item.name}</span>
                          <small>{item.url ?? item.sourceId ?? ""}</small>
                        </button>
                        <button
                          className="library-remove"
                          aria-label={`移除 ${item.name}`}
                          onClick={() =>
                            void invoke(ACTION_IDS.playlistRemove, { index: item.index })
                          }
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}
                {playlistItems.length > 0 && (
                  <button
                    className="secondary-button"
                    onClick={() => void invoke(ACTION_IDS.playlistClear)}
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
                      className="library-main library-row"
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
                        onClick={() => void invoke(ACTION_IDS.bookmarksRemove, { id: item.id })}
                      >
                        ×
                      </button>
                    </div>
                  ))}
                </div>
              </>
            )}
          </aside>
        )}

        {showStats && snapshot && (
          <div className="stats-panel">
            <div>阶段：{snapshot.phase}</div>
            <div>解码路径：{Object.entries(snapshot.media?.decodePaths ?? {}).map(([key, value]) => `${key}=${value}`).join(", ") || "—"}</div>
            <div>视频队列：{snapshot.stats.videoQueueFrames} 帧 / {(snapshot.stats.videoQueueBytes / 1024 / 1024).toFixed(1)} MiB</div>
            <div>已渲染：{snapshot.stats.renderedFrames}，丢帧：{snapshot.stats.droppedVideoFrames}</div>
            <div>音频欠载：{snapshot.stats.audioUnderruns}</div>
            <div>WebCodecs：{snapshot.capabilities["webcodecs.video"]?.available ? "可用" : "不可用"}；WebGL2：{snapshot.capabilities.webgl2?.available ? "可用" : "不可用"}</div>
          </div>
        )}
      </main>

      <footer className="controls">
        <button className="icon-button play-button" onClick={() => void togglePlay()} aria-label="播放/暂停">
          {snapshot?.phase === "playing" ? "❚❚" : "▶"}
        </button>
        <span className="time">{formatTime(snapshot?.positionUs ?? 0)}</span>
        <input
          className="seek"
          type="range"
          min={0}
          max={Math.max(1, snapshot?.durationUs ?? 1)}
          value={seekUs ?? snapshot?.positionUs ?? 0}
          onChange={(event) => setSeekUs(Number(event.target.value))}
          onPointerUp={() => {
            if (seekUs !== null) {
              void invoke(ACTION_IDS.playbackSeek, { positionUs: seekUs });
              setSeekUs(null);
            }
          }}
          disabled={!snapshot?.media}
        />
        <span className="time">{formatTime(snapshot?.durationUs ?? 0)}</span>
        <div className="control-group">
          <button className="ghost-button" onClick={() => void applyPatch({ audio: { muted: !snapshot?.muted } })}>
            {snapshot?.muted ? "静音" : "音量"}
          </button>
          <input
            type="range"
            className="volume"
            min={0}
            max={100}
            value={Math.round((snapshot?.volume ?? 1) * 100)}
            onChange={(event) =>
              void applyPatch({ audio: { volume: Number(event.target.value) / 100 } })
            }
          />
        </div>
        <select
          className="rate-select"
          value={String(snapshot?.rate ?? 1)}
          onChange={(event) =>
            void invoke(ACTION_IDS.playbackSetRate, { rate: Number(event.target.value) })
          }
        >
          {[0.5, 0.75, 1, 1.25, 1.5, 2].map((rate) => (
            <option key={rate} value={rate}>
              {rate}×
            </option>
          ))}
        </select>
        <span className="status-pill">{statusLabel(snapshot)}</span>
        <button className="ghost-button" onClick={() => void takeScreenshot()} disabled={!snapshot?.media}>
          截图
        </button>
        <button
          className="ghost-button"
          onClick={() => void invoke(ACTION_IDS.uiSet, { fullscreen: !document.fullscreenElement })}
        >
          全屏
        </button>
      </footer>

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
    </div>
  );
}
