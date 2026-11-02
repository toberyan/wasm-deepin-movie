import { useEffect, useMemo, useRef, useState } from "react";
import {
  ACTION_IDS,
  type ActionId,
  type InvokeResult,
  type PlayerSnapshot,
  type TrackInfo
} from "@wasm-player/contracts";
import { PlayerController } from "@wasm-player/player-core";
import { BrowserMediaEngine } from "./player/browser-media-engine";
import { browserHost } from "./player/browser-host";

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
  const [snapshot, setSnapshot] = useState<PlayerSnapshot | null>(null);
  const [message, setMessage] = useState<string>("");
  const [seekUs, setSeekUs] = useState<number | null>(null);
  const [showStats, setShowStats] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showPlaylist, setShowPlaylist] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestSeq = useRef(0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const overlay = overlayRef.current;
    if (!canvas || !overlay) return;
    let active = true;
    let controller: PlayerController | null = null;
    try {
      const engine = new BrowserMediaEngine({
        canvas,
        overlayContainer: overlay,
        libavBase: new URL("/libav/", window.location.origin).href,
        onLog: (logMessage, details) => console.debug("[player]", logMessage, details)
      });
      controller = new PlayerController({
        engine,
        sessionId: "web-main",
        host: browserHost
      });
      controllerRef.current = controller;
      const update = () => {
        if (active) setSnapshot(controller!.getState());
      };
      const unsubscribe = controller.subscribe(update);
      update();
      (window as Window & { __player?: PlayerController }).__player = controller;
      return () => {
        active = false;
        unsubscribe();
        controllerRef.current = null;
        void controller?.dispose();
      };
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
      return () => {
        active = false;
        void controller?.dispose();
      };
    }
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
      await invoke(ACTION_IDS.mediaOpen, {
        source: { kind: "file", file, name: file.name },
        autoPlay: false
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
            disabled={!snapshot?.media}
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
          <span className="agent-status" title="Companion 尚未连接">
            <span className="dot" /> Agent 离线
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
            </section>
            <section>
              <h3>轨道</h3>
              {(["audio", "subtitle"] as const).map((type) => (
                <div className="track-group" key={type}>
                  <div className="track-label">{type === "audio" ? "音频" : "字幕"}</div>
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
          <aside className="drawer">
            <div className="drawer-header">
              <h2>播放列表</h2>
              <button className="icon-button" onClick={() => setShowPlaylist(false)}>
                ×
              </button>
            </div>
            <div className="muted">P0 先支持单文件；列表管理在 P1 接入。</div>
            <div className="playlist-item">{snapshot.media?.name ?? "无媒体"}</div>
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
