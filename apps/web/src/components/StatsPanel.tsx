import type { PlayerSnapshot } from "@wasm-player/contracts";
import type { PlayerController } from "@wasm-player/player-core";
import { usePlayerSnapshot } from "../player/use-player-snapshot";

/**
 * Diagnostics panel. Stats change every 500 ms, so the subscription lives here
 * instead of in the app shell.
 */
export function StatsPanel({
  controller,
  snapshot
}: {
  controller: PlayerController | null;
  snapshot: Pick<PlayerSnapshot, "phase" | "media" | "capabilities"> | null;
}) {
  const stats = usePlayerSnapshot(controller, (state) => state.stats);
  if (!snapshot) return null;
  return (
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
          {stats?.videoQueueFrames ?? 0} 帧 /{" "}
          {((stats?.videoQueueBytes ?? 0) / 1024 / 1024).toFixed(1)} MiB
        </strong>
      </div>
      <div>
        <span>已渲染 / 丢帧</span>
        <strong>
          {stats?.renderedFrames ?? 0} / {stats?.droppedVideoFrames ?? 0}
        </strong>
      </div>
      <div>
        <span>音频欠载</span>
        <strong>{stats?.audioUnderruns ?? 0}</strong>
      </div>
      <div>
        <span>WebCodecs / WebGL2</span>
        <strong>
          {snapshot.capabilities["webcodecs.video"]?.available ? "可用" : "不可用"} /{" "}
          {snapshot.capabilities.webgl2?.available ? "可用" : "不可用"}
        </strong>
      </div>
    </div>
  );
}
