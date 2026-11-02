import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  createCoreRegistry,
  describeSettings,
  playerErrorSchema,
  playerEventSchema,
  playerSnapshotSchema,
  settingsApplyInputSchema,
  stableJson,
  zodToJsonSchema
} from "../packages/contracts/src/index.ts";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schemaDir = resolve(root, "packages/contracts/schema");

const registry = createCoreRegistry();
const files: Record<string, unknown> = {
  "actions.json": {
    schemaVersion: 1,
    actions: registry.describe()
  },
  "settings.json": {
    schemaVersion: 1,
    settings: describeSettings()
  },
  "errors.json": {
    schemaVersion: 1,
    error: zodToJsonSchema(playerErrorSchema)
  },
  "events.json": {
    schemaVersion: 1,
    event: zodToJsonSchema(playerEventSchema)
  },
  "snapshot.json": {
    schemaVersion: 1,
    snapshot: zodToJsonSchema(playerSnapshotSchema, { io: "output" })
  },
  "settings-apply.json": {
    schemaVersion: 1,
    request: zodToJsonSchema(settingsApplyInputSchema)
  },
  "mcp-tools.json": {
    schemaVersion: 1,
    tools: registry.mcpTools().map(({ action, toolName }) => ({
      name: toolName,
      description: action.description.en,
      inputSchema: zodToJsonSchema(action.inputSchema),
      outputSchema: zodToJsonSchema(action.outputSchema, { io: "output" })
    }))
  }
};

const check = process.argv.includes("--check");
let drifted = false;
await mkdir(schemaDir, { recursive: true });

for (const [name, content] of Object.entries(files)) {
  const path = resolve(schemaDir, name);
  const next = stableJson(content) + "\n";
  let current: string | null = null;
  try {
    current = await readFile(path, "utf8");
  } catch {
    current = null;
  }
  if (check) {
    if (current !== next) {
      console.error(`schema drift: packages/contracts/schema/${name}`);
      drifted = true;
    }
  } else {
    await writeFile(path, next, "utf8");
    console.log(`wrote packages/contracts/schema/${name}`);
  }
}

if (check && drifted) {
  console.error("Run `pnpm schema:generate` to refresh committed schema snapshots.");
  process.exitCode = 1;
} else if (check) {
  console.log("schema snapshots are up to date");
}
