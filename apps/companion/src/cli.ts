import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { readFileSync } from "node:fs";
import { createMcpServer } from "@wasm-player/mcp-server";
import { MediaBroker } from "./broker";
import { CompanionServer } from "./http-server";
import { RemoteProxy } from "./remote-proxy";
import { parseArgs } from "./args";
import { createSessionToken } from "./token";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const token = args.tokenFile
    ? readFileSync(args.tokenFile, "utf8").trim()
    : args.token ?? createSessionToken();
  if (!token) throw new Error("companion token is empty");
  const broker = new MediaBroker(args.allowRoots);
  const remote = new RemoteProxy({
    allowDomains: args.allowDomains,
    allowPrivateNetwork: args.allowPrivateNetwork
  });
  const companion = new CompanionServer({
    host: args.host,
    port: args.port,
    token,
    webRoot: args.webRoot,
    broker,
    remote
  });
  await companion.start();
  console.error(`[companion] listening on ${companion.url}`);
  console.error(`[companion] allowed roots: ${args.allowRoots.join(", ") || "none"}`);
  console.error(`[companion] web root: ${args.webRoot}`);
  console.error(`[companion] token: ${token}`);

  if (args.stdio) {
    const mcp = createMcpServer({ bridge: companion });
    await mcp.connect(new StdioServerTransport());
    console.error("[companion] MCP stdio ready");
  }

  const shutdown = async () => {
    await companion.close().catch(() => undefined);
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

void main().catch((error) => {
  console.error(`[companion] fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  process.exit(1);
});
