import { useState, type CSSProperties } from "react";
import type { PlayerController } from "@wasm-player/player-core";
import { usePlayerSnapshot } from "../player/use-player-snapshot";

/**
 * Timeline slider. It owns the drag draft and subscribes to the playhead itself,
 * so scrubbing and playback progress no longer re-render the whole app shell.
 */
export function ProgressSlider({
  controller,
  onSeek
}: {
  controller: PlayerController | null;
  onSeek: (positionUs: number) => void;
}) {
  const livePositionUs = usePlayerSnapshot(controller, (snapshot) => snapshot.positionUs) ?? 0;
  const durationUs = Math.max(
    0,
    usePlayerSnapshot(controller, (snapshot) => snapshot.durationUs) ?? 0
  );
  const [draftUs, setDraftUs] = useState<number | null>(null);
  const positionUs = draftUs ?? livePositionUs;
  const progress = durationUs > 0 ? Math.min(100, Math.max(0, (positionUs / durationUs) * 100)) : 0;

  const commit = (value: number | null) => {
    if (value === null) return;
    onSeek(value);
    setDraftUs(null);
  };

  return (
    <div className="timeline-row">
      <input
        className="timeline-range"
        type="range"
        aria-label="播放进度"
        min={0}
        max={Math.max(1, durationUs)}
        value={positionUs}
        style={{ "--progress": `${progress}%` } as CSSProperties}
        onChange={(event) => setDraftUs(Number(event.target.value))}
        onPointerUp={() => commit(draftUs)}
        onKeyUp={(event) => {
          if (
            ["ArrowLeft", "ArrowRight", "Home", "End", "PageUp", "PageDown"].includes(event.key)
          ) {
            commit(draftUs);
          }
        }}
      />
    </div>
  );
}
