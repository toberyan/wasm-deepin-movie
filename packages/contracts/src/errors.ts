import { z } from "zod";

/**
 * Stable error codes. These are part of the public SDK/MCP contract: clients
 * may branch on them, so never rename one without an ABI/contract revision.
 */
export const PLAYER_ERROR_CODES = [
  "UNSUPPORTED",
  "NEEDS_MEDIA",
  "NEEDS_USER_GESTURE",
  "SOURCE_NOT_AUTHORIZED",
  "SOURCE_CHANGED",
  "REVISION_CONFLICT",
  "PERFORMANCE_LIMIT",
  "DECODE_FAILED",
  "CANCELLED",
  "SESSION_CLOSED",
  "TIMEOUT",
  "INVALID_REQUEST",
  "NOT_READY",
  "BUSY",
  "INTERNAL"
] as const;

export type PlayerErrorCode = (typeof PLAYER_ERROR_CODES)[number];

export interface PlayerErrorOptions {
  recoverable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export interface PlayerErrorShape {
  code: PlayerErrorCode;
  message: string;
  recoverable: boolean;
  details?: Record<string, unknown>;
}

export const playerErrorSchema = z
  .object({
    code: z.enum(PLAYER_ERROR_CODES),
    message: z.string().min(1),
    recoverable: z.boolean(),
    details: z.record(z.string(), z.unknown()).optional()
  })
  .strict();

const RECOVERABLE_BY_DEFAULT: ReadonlySet<PlayerErrorCode> = new Set([
  "NEEDS_MEDIA",
  "NEEDS_USER_GESTURE",
  "SOURCE_NOT_AUTHORIZED",
  "SOURCE_CHANGED",
  "REVISION_CONFLICT",
  "PERFORMANCE_LIMIT",
  "DECODE_FAILED",
  "CANCELLED",
  "TIMEOUT",
  "NOT_READY",
  "BUSY"
]);

export class PlayerError extends Error {
  readonly code: PlayerErrorCode;
  readonly recoverable: boolean;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: PlayerErrorCode, message: string, options: PlayerErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "PlayerError";
    this.code = code;
    this.recoverable = options.recoverable ?? RECOVERABLE_BY_DEFAULT.has(code);
    this.details = options.details;
  }

  toJSON(): PlayerErrorShape {
    const shape: PlayerErrorShape = {
      code: this.code,
      message: this.message,
      recoverable: this.recoverable
    };
    if (this.details !== undefined) shape.details = this.details;
    return shape;
  }
}

export function isPlayerError(value: unknown): value is PlayerError {
  return value instanceof PlayerError;
}

export function toPlayerError(value: unknown): PlayerError {
  if (isPlayerError(value)) return value;
  if (value instanceof Error) {
    return new PlayerError("INTERNAL", value.message, {
      recoverable: false,
      cause: value
    });
  }
  return new PlayerError("INTERNAL", String(value), { recoverable: false });
}
