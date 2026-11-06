#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { BrowserManager } from './browser-manager.js';
import { logger } from './logger.js';
import { registerAllTools } from './tools/index.js';
import { startHttpServer, type RunningHttpServer } from './transports/http.js';

const SERVER_NAME = 'gemini-browser-mcp';
const SERVER_VERSION = '1.0.0';

const SERVER_INSTRUCTIONS = `This server controls a real web browser through Playwright.

Typical workflow:
1. Call browser_launch once. Use headless=true unless the user needs to watch.
2. Inspect the page with get_dom_tree (compact Markdown), capture_viewport (image), or get_element_details (single element).
3. Interact with click_element, type_text, press_key, scroll_page, select_dropdown, and upload_file.
4. After actions, verify with get_dom_tree or capture_viewport. Use get_console_errors to diagnose page failures.
5. Reuse the existing browser and tabs across calls. Prefer tab_list + tab_switch over launching again. Call browser_close only when the session is finished.

Notes:
- Only one browser session is active at a time. Tabs have stable ids such as "tab-1a2b3c4d".
- Tools act on the active tab unless a tab_id is accepted and provided.
- Screenshots are returned as base64 image content blocks.
- Timeouts are in milliseconds.`;

const manager = new BrowserManager();

export function createMcpServer(): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      capabilities: { tools: {} },
      instructions: SERVER_INSTRUCTIONS
    }
  );
  registerAllTools(server, { manager });
  return server;
}

type TransportKind = 'stdio' | 'http';

interface CliConfig {
  transport: TransportKind;
  host: string;
  port: number;
  path: string;
  legacySse: boolean;
  corsOrigin?: string;
  help: boolean;
  version: boolean;
}

const USAGE = `Usage: gemini-browser-mcp [options]

Options:
  --transport <stdio|http>   Transport to serve (default: stdio, env MCP_TRANSPORT)
  --host <address>           HTTP bind address (default: 127.0.0.1, env MCP_HTTP_HOST)
  --port <number>            HTTP port (default: 3000, env MCP_HTTP_PORT)
  --path <path>              Streamable HTTP endpoint (default: /mcp, env MCP_HTTP_PATH)
  --no-legacy-sse            Disable deprecated GET /sse + POST /messages endpoints
  --cors-origin <origin>     Allowed CORS origin for HTTP mode (env MCP_CORS_ORIGIN)
  --version                  Print the server version
  -h, --help                 Show this help text

Environment:
  MCP_HTTP_TOKEN             When set, require "Authorization: Bearer <token>" on HTTP requests
  BROWSER_RECORDINGS_DIR     Directory for videos and traces (default: ./.recordings)
  LOG_LEVEL                  debug | info | warn | error | silent (default: info)`;

function parseCli(argv: string[]): CliConfig {
  let transport: TransportKind = process.env.MCP_TRANSPORT?.toLowerCase() === 'http' ? 'http' : 'stdio';
  let host = process.env.MCP_HTTP_HOST?.trim() || '127.0.0.1';
  let port = Number.parseInt(process.env.MCP_HTTP_PORT ?? '3000', 10);
  let requestPath = process.env.MCP_HTTP_PATH?.trim() || '/mcp';
  let legacySse = (process.env.MCP_LEGACY_SSE ?? 'true').toLowerCase() !== 'false';
  let corsOrigin = process.env.MCP_CORS_ORIGIN?.trim() || undefined;
  let help = false;
  let version = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument) {
      continue;
    }

    const equalsIndex = argument.indexOf('=');
    const flag = equalsIndex > 0 ? argument.slice(0, equalsIndex) : argument;
    const inlineValue = equalsIndex > 0 ? argument.slice(equalsIndex + 1) : undefined;

    const readValue = (): string => {
      if (inlineValue !== undefined) {
        return inlineValue;
      }
      const next = argv[index + 1];
      if (!next) {
        throw new Error(`Missing value for ${flag}.`);
      }
      index += 1;
      return next;
    };

    switch (flag) {
      case '--transport': {
        const value = readValue().toLowerCase();
        if (value !== 'stdio' && value !== 'http') {
          throw new Error(`Invalid transport "${value}". Expected "stdio" or "http".`);
        }
        transport = value;
        break;
      }
      case '--host':
        host = readValue();
        break;
      case '--port':
        port = Number.parseInt(readValue(), 10);
        break;
      case '--path':
        requestPath = readValue();
        break;
      case '--no-legacy-sse':
        legacySse = false;
        break;
      case '--cors-origin':
        corsOrigin = readValue();
        break;
      case '--version':
        version = true;
        break;
      case '-h':
      case '--help':
        help = true;
        break;
      default:
        throw new Error(`Unknown option "${argument}".`);
    }
  }

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid port "${port}". Expected an integer between 1 and 65535.`);
  }
  if (!requestPath.startsWith('/')) {
    throw new Error(`Invalid path "${requestPath}". Paths must start with "/".`);
  }

  return {
    transport,
    host,
    port,
    path: requestPath,
    legacySse,
    ...(corsOrigin ? { corsOrigin } : {}),
    help,
    version
  };
}

let shuttingDown = false;
let cleanup: (() => Promise<void>) | undefined;

async function shutdown(reason: string): Promise<void> {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  logger.info('Shutting down', { reason });

  const forceExit = setTimeout(() => {
    logger.warn('Forced exit after shutdown timeout');
    process.exit(1);
  }, 15_000);
  forceExit.unref();

  try {
    await cleanup?.();
  } catch (error) {
    logger.error('Cleanup failed during shutdown', { error });
  }
  await manager.shutdown();

  clearTimeout(forceExit);
  process.exit(0);
}

function installProcessHandlers(): void {
  process.on('SIGINT', () => {
    void shutdown('SIGINT');
  });
  process.on('SIGTERM', () => {
    void shutdown('SIGTERM');
  });
  process.on('uncaughtException', (error) => {
    logger.error('Uncaught exception', { error });
    void shutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    logger.error('Unhandled promise rejection', { error: reason });
  });
}

async function runStdio(): Promise<void> {
  const server = createMcpServer();
  const transport = new StdioServerTransport();

  cleanup = async () => {
    await server.close().catch(() => undefined);
  };

  await server.connect(transport);
  logger.info('MCP server ready', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'stdio'
  });

  process.stdin.on('end', () => {
    void shutdown('stdin closed');
  });
}

async function runHttp(config: CliConfig): Promise<RunningHttpServer> {
  if (config.host !== '127.0.0.1' && config.host !== 'localhost' && !process.env.MCP_HTTP_TOKEN) {
    logger.warn(
      'HTTP server is bound beyond localhost without MCP_HTTP_TOKEN. Anyone with network access can control the browser.'
    );
  }

  const running = await startHttpServer({
    host: config.host,
    port: config.port,
    path: config.path,
    ...(process.env.MCP_HTTP_TOKEN ? { authToken: process.env.MCP_HTTP_TOKEN } : {}),
    ...(config.corsOrigin ? { corsOrigin: config.corsOrigin } : {}),
    enableLegacySse: config.legacySse,
    createServer: createMcpServer
  });

  cleanup = async () => {
    await running.close();
  };

  logger.info('MCP server ready', {
    server: SERVER_NAME,
    version: SERVER_VERSION,
    transport: 'http',
    url: `http://${running.host}:${running.port}${running.path}`,
    legacySse: config.legacySse,
    auth: Boolean(process.env.MCP_HTTP_TOKEN)
  });

  return running;
}

async function main(): Promise<void> {
  let config: CliConfig;
  try {
    config = parseCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${USAGE}\n`);
    process.exit(1);
  }

  if (config.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (config.version) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  installProcessHandlers();

  if (config.transport === 'http') {
    await runHttp(config);
  } else {
    await runStdio();
  }
}

void main().catch((error: unknown) => {
  logger.error('Fatal startup error', { error });
  process.exit(1);
});
