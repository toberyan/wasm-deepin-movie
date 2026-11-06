import { resolve } from "node:path";

export interface CompanionArgs {
  host: string;
  port: number;
  allowRoots: string[];
  webRoot: string;
  token?: string;
  tokenFile?: string;
  allowDomains: string[];
  allowPrivateNetwork: boolean;
  stdio: boolean;
}

export function parseArgs(argv: string[]): CompanionArgs {
  const args: CompanionArgs = {
    host: "127.0.0.1",
    port: 4178,
    allowRoots: [],
    webRoot: resolve("apps/web/dist"),
    allowDomains: [],
    allowPrivateNetwork: false,
    stdio: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      const value = argv[index + 1];
      if (!value || value.startsWith("--")) throw new Error(`missing value for ${arg}`);
      index += 1;
      return value;
    };
    switch (arg) {
      case "--host":
        args.host = next();
        break;
      case "--port":
        args.port = Number(next());
        if (!Number.isInteger(args.port) || args.port < 0 || args.port > 65535) {
          throw new Error("--port must be an integer between 0 and 65535");
        }
        break;
      case "--allow-root":
        args.allowRoots.push(resolve(next()));
        break;
      case "--web-root":
        args.webRoot = resolve(next());
        break;
      case "--token":
        args.token = next();
        break;
      case "--token-file":
        args.tokenFile = resolve(next());
        break;
      case "--allow-domain":
        args.allowDomains.push(next().toLowerCase());
        break;
      case "--allow-private-network":
        args.allowPrivateNetwork = true;
        break;
      case "--stdio":
        args.stdio = true;
        break;
      case "--help":
      case "-h":
        args.stdio = false;
        printHelp();
        process.exit(0);
        break;
      default:
        throw new Error(`unknown argument: ${arg}`);
    }
  }
  if (!["127.0.0.1", "localhost", "::1"].includes(args.host)) {
    throw new Error("Companion must bind to a loopback host");
  }
  return args;
}

function printHelp(): void {
  console.error(
    [
      "Usage: companion [options]",
      "  --stdio                 serve MCP over stdio (stdout is protocol-only)",
      "  --host <loopback>       default 127.0.0.1",
      "  --port <number>         default 4178; 0 picks a free port",
      "  --allow-root <dir>      allow read-only media under this directory (repeatable)",
      "  --web-root <dir>        built web app directory (default apps/web/dist)",
      "  --token <hex>           control token (default random per process)",
      "  --token-file <path>     read the control token from a file",
      "  --allow-domain <host>   allow remote media from this host/suffix (repeatable)",
      "  --allow-private-network allow loopback/private remote targets (tests only)"
    ].join("\n")
  );
}
