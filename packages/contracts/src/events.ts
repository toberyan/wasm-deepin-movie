import { z } from "zod";

export const PLAYER_EVENT_TYPES = [
  "state",
  "phase",
  "position",
  "mediaOpened",
  "mediaClosed",
  "trackChanged",
  "decodePathChanged",
  "settingsApplied",
  "buffering",
  "seeked",
  "ended",
  "error",
  "jobUpdated",
  "capabilitiesChanged",
  "stats"
] as const;

export type PlayerEventType = (typeof PLAYER_EVENT_TYPES)[number];

export interface PlayerEvent<T = unknown> {
  seq: number;
  sessionId: string;
  type: PlayerEventType;
  at: number;
  revision: number;
  payload: T;
}

export const playerEventSchema = z
  .object({
    seq: z.number().int().nonnegative(),
    sessionId: z.string().min(1),
    type: z.enum(PLAYER_EVENT_TYPES),
    at: z.number().nonnegative(),
    revision: z.number().int().nonnegative(),
    payload: z.unknown()
  })
  .strict();

export interface EventCursor {
  afterSeq: number;
  limit: number;
}
