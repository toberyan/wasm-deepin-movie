import { formatTime } from "../format";
import type { PlayerController } from "@wasm-player/player-core";
import { usePlayerSnapshot } from "../player/use-player-snapshot";

/** Position/duration readout; re-renders on position updates without the app shell. */
export function PlaybackClock({ controller }: { controller: PlayerController | null }) {
  const positionUs = usePlayerSnapshot(controller, (snapshot) => snapshot.positionUs);
  const durationUs = usePlayerSnapshot(controller, (snapshot) => snapshot.durationUs);
  return (
    <span className="time" aria-label="播放时间">
      <span className="time-current">{formatTime(positionUs ?? 0)}</span>
      <span className="time-sep">/</span>
      <span>{formatTime(Math.max(0, durationUs ?? 0))}</span>
    </span>
  );
}
