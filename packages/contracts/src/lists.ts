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
