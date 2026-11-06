import type { MediaSourceInput } from "./actions";
import type { SettingsPatch } from "./settings";

export interface Preset {
  id: string;
  name: string;
  patch: SettingsPatch;
  createdAt: number;
}

export interface PlaylistItem {
  index: number;
  name: string;
  source: MediaSourceInput;
  durationUs?: number;
  /** Stable identity for a local file; persisted across restarts. */
  identity?: string;
  /**
   * `false` when the item is a persisted local file whose `File` handle has not
   * been re-linked yet. Playing it must ask the user to re-select the file.
   */
  available?: boolean;
}

export interface HistoryItem {
  id: string;
  name: string;
  lastPlayedAt: number;
  positionUs: number;
  durationUs: number;
  completed: boolean;
  source?: MediaSourceInput;
}

export interface Bookmark {
  id: string;
  mediaId: string;
  name: string;
  positionUs: number;
  createdAt: number;
}
