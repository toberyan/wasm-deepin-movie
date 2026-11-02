import { z } from "zod";

export type JsonSchema = Record<string, unknown>;

export interface JsonSchemaOptions {
  io?: "input" | "output";
}

/**
 * Convert a Zod schema to a stable JSON Schema representation used by the SDK,
 * MCP tool generation and the committed schema snapshots.
 */
export function zodToJsonSchema(
  schema: z.ZodTypeAny,
  options: JsonSchemaOptions = {}
): JsonSchema {
  return z.toJSONSchema(schema, {
    target: "draft-2020-12",
    io: options.io ?? "input"
  }) as JsonSchema;
}

export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner && typeof inner === "object" && !Array.isArray(inner)) {
      const record = inner as Record<string, unknown>;
      return Object.fromEntries(
        Object.keys(record)
          .sort()
          .map((key) => [key, record[key]])
      );
    }
    return inner;
  }, 2);
}
