import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool
} from "@modelcontextprotocol/sdk/types.js";
import {
  ACTION_IDS,
  createCoreRegistry,
  describeSettings,
  zodToJsonSchema,
  type ActionDefinition,
  type ActionId,
  type InvokeResult
} from "@wasm-player/contracts";

export interface McpSessionInfo {
  sessionId: string;
  title?: string;
  mediaName?: string;
  phase?: string;
  connectedAt?: number;
}

export interface McpSourceInfo {
  sourceId: string;
  name: string;
  sizeBytes: number;
  url?: string;
}

export interface ControlBridge {
  listSessions(): Promise<McpSessionInfo[]>;
  attachSession(sessionId: string): Promise<McpSessionInfo | null>;
  listSources(): Promise<McpSourceInfo[]>;
  invoke(action: ActionId, params: unknown): Promise<InvokeResult>;
}

export interface McpServerOptions {
  name?: string;
  version?: string;
  bridge: ControlBridge;
}

const LOCAL_TOOL_NAMES = new Set([
  "actions_list",
  "settings_describe",
  "sessions_list",
  "sessions_attach",
  "sources_list"
]);

export function buildMcpTools(): Tool[] {
  const registry = createCoreRegistry();
  return registry.mcpTools().map(({ action, toolName }) => {
    const tool: Tool = {
      name: toolName,
      title: action.title.en,
      description: action.description.en,
      inputSchema: zodToJsonSchema(action.inputSchema, { target: "draft-7" }) as unknown as Tool["inputSchema"],
      outputSchema: zodToJsonSchema(action.outputSchema, { io: "output", target: "draft-7" }) as unknown as Tool["outputSchema"],
      annotations: {
        readOnlyHint: !action.longRunning && action.media !== "required",
        destructiveHint: false,
        openWorldHint: action.id === ACTION_IDS.mediaOpen
      }
    };
    return tool;
  });
}

export function createMcpServer(options: McpServerOptions): Server {
  const registry = createCoreRegistry();
  const toolToAction = new Map<string, ActionDefinition>();
  for (const { action, toolName } of registry.mcpTools()) {
    toolToAction.set(toolName, action);
  }
  const tools = buildMcpTools();
  const server = new Server(
    {
      name: options.name ?? "wasm-player",
      version: options.version ?? "0.1.0"
    },
    {
      capabilities: { tools: {} }
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request): Promise<CallToolResult> => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {}) as Record<string, unknown>;
    const action = toolToAction.get(name);
    if (!action) {
      return errorResult("UNKNOWN_TOOL", `unknown tool: ${name}`);
    }
    try {
      const params = action.inputSchema.parse(args);
      if (name === "actions_list") {
        return okResult({ actions: registry.describe() });
      }
      if (name === "settings_describe") {
        return okResult({ settings: describeSettings() });
      }
      if (name === "sessions_list") {
        return okResult({ sessions: await options.bridge.listSessions() });
      }
      if (name === "sessions_attach") {
        const sessionId = (params as { sessionId: string }).sessionId;
        const session = await options.bridge.attachSession(sessionId);
        if (!session) {
          return errorResult("SESSION_CLOSED", `session ${sessionId} is not connected`);
        }
        return okResult({ session });
      }
      if (name === "sources_list") {
        return okResult({ sources: await options.bridge.listSources() });
      }
      const result = await options.bridge.invoke(action.id, params);
      if (result.status === "rejected") {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: JSON.stringify({
                requestId: result.requestId,
                status: result.status,
                error: result.error
              })
            }
          ],
          structuredContent: undefined
        };
      }
      return okResult(result, result.output ?? {});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return errorResult("INVALID_REQUEST", message);
    }
  });

  return server;
}

export function isLocalMcpTool(name: string): boolean {
  return LOCAL_TOOL_NAMES.has(name);
}

function okResult(value: unknown, structured?: unknown): CallToolResult {
  const payload = structured === undefined ? value : structured;
  const text = JSON.stringify(payload);
  const result: CallToolResult = {
    content: [{ type: "text", text }]
  };
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    result.structuredContent = payload as Record<string, unknown>;
  }
  return result;
}

function errorResult(code: string, message: string): CallToolResult {
  return {
    isError: true,
    content: [{ type: "text", text: JSON.stringify({ code, message }) }]
  };
}
