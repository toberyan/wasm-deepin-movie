import type { Bookmark, HistoryItem, PlaylistItem, Preset } from "./lists";

export interface PersistedPlayerState {
  version: 1;
  globalSettings: Record<string, unknown>;
  history: HistoryItem[];
  bookmarks: Bookmark[];
  playlist: PlaylistItem[];
  presets: Preset[];
}

export interface PlayerStorage {
  load(): Promise<PersistedPlayerState | null>;
  save(state: PersistedPlayerState): Promise<void>;
  clear(): Promise<void>;
}
