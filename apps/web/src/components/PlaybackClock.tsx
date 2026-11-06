import { formatTime } from "../format";
import type { PlayerController } from "@wasm-player/player-core";
import { usePlayerSnapshot } from "../player/use-player-snapshot";

/** Position/duration readout; re-renders on position updates without the app shell. */
export function PlaybackClock({ controller, part }: {
  controller: PlayerController | null;
  part: "current" | "duration";
}) {
  const value = usePlayerSnapshot(controller, (snapshot) =>
    part === "current" ? snapshot.positionUs : snapshot.durationUs
  );
  return (
    <span className={`time time-${part}`} aria-label={part === "current" ? "当前时间" : "总时长"}>
      {formatTime(Math.max(0, value ?? 0))}
    </span>
  );
}
