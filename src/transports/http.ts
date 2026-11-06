import { randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { logger } from '../logger.js';
import { OAuthProvider } from './oauth.js';

const MAX_BODY_BYTES = 10 * 1024 * 1024;

class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

interface StreamableSession {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
}

interface SseSession {
  server: McpServer;
  transport: SSEServerTransport;
}

export interface HttpTransportOptions {
  host: string;
  port: number;
  path: string;
  authToken?: string;
  /** Public base URL (e.g. https://browser.example.com) used as the OAuth issuer. */
  publicUrl?: string;
  corsOrigin?: string;
  enableLegacySse: boolean;
  createServer: () => McpServer;
}

export interface RunningHttpServer {
  host: string;
  port: number;
  path: string;
  close: () => Promise<void>;
}

function applyCors(req: IncomingMessage, res: ServerResponse, origin?: string): void {
  if (!origin) {
    return;
  }
  const requestOrigin = req.headers.origin;
  const allowOrigin = origin === '*' ? requestOrigin ?? '*' : origin;
  res.setHeader('Access-Control-Allow-Origin', allowOrigin);
  res.setHeader('Vary', 'Origin');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version, Last-Event-ID'
  );
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new HttpError(413, 'Request body exceeds the 10 MB limit.');
    }
    chunks.push(buffer);
  }

  if (size === 0) {
    return undefined;
  }

  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Request body is not valid JSON.');
  }
}

function isAuthorized(
  req: IncomingMessage,
  url: URL,
  token: string | undefined
): boolean {
  if (!token) {
    return true;
  }

  const header = req.headers.authorization;
  const headerToken = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : undefined;
  const provided = headerToken ?? url.searchParams.get('token') ?? '';
  const expected = Buffer.from(token);
  const actual = Buffer.from(provided);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function sessionIdFrom(req: IncomingMessage): string | undefined {
  const value = req.headers['mcp-session-id'];
  if (Array.isArray(value)) {
    return value[0];
  }
  return value;
}

export async function startHttpServer(options: HttpTransportOptions): Promise<RunningHttpServer> {
  const streamableSessions = new Map<string, StreamableSession>();
  const sseSessions = new Map<string, SseSession>();
  const mcpPath = options.path.endsWith('/') && options.path !== '/'
    ? options.path.slice(0, -1)
    : options.path;

  const oauth = options.authToken
    ? new OAuthProvider({ secret: options.authToken, publicUrl: options.publicUrl, mcpPath })
    : undefined;

  const createStreamableSession = async (): Promise<StreamableSession> => {
    const server = options.createServer();
    let transport!: StreamableHTTPServerTransport;

    transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => randomUUID(),
      onsessioninitialized: (sessionId) => {
        streamableSessions.set(sessionId, { server, transport });
        logger.info('Streamable HTTP session initialized', { sessionId });
      }
    });

    transport.onclose = () => {
      const sessionId = transport.sessionId;
      if (sessionId) {
        streamableSessions.delete(sessionId);
        logger.info('Streamable HTTP session closed', { sessionId });
      }
      void server.close().catch(() => undefined);
    };
    transport.onerror = (error) => {
      logger.warn('Streamable HTTP transport error', { error: error.message });
    };

    await server.connect(transport);
    return { server, transport };
  };

  const handleStreamable = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const sessionId = sessionIdFrom(req);

    if (req.method === 'POST') {
      const body = await readBody(req);

      if (sessionId) {
        const session = streamableSessions.get(sessionId);
        if (!session) {
          sendJson(res, 404, {
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found. Re-initialize the MCP session.' },
            id: null
          });
          return;
        }
        await session.transport.handleRequest(req, res, body);
        return;
      }

      if (!isInitializeRequest(body)) {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: {
            code: -32000,
            message: 'Bad Request: send an initialize request or provide the Mcp-Session-Id header.'
          },
          id: null
        });
        return;
      }

      const session = await createStreamableSession();
      await session.transport.handleRequest(req, res, body);
      return;
    }

    if (req.method === 'GET' || req.method === 'DELETE') {
      if (!sessionId) {
        sendJson(res, 400, {
          jsonrpc: '2.0',
          error: { code: -32000, message: 'Bad Request: Mcp-Session-Id header is required.' },
          id: null
        });
        return;
      }

      const session = streamableSessions.get(sessionId);
      if (!session) {
        sendJson(res, 404, {
          jsonrpc: '2.0',
          error: { code: -32001, message: 'Session not found. Re-initialize the MCP session.' },
          id: null
        });
        return;
      }

      await session.transport.handleRequest(req, res);
      if (req.method === 'DELETE') {
        streamableSessions.delete(sessionId);
      }
      return;
    }

    res.setHeader('Allow', 'GET, POST, DELETE');
    sendJson(res, 405, { error: 'Method not allowed.' });
  };

  const handleSseConnect = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (req.method !== 'GET') {
      res.setHeader('Allow', 'GET');
      sendJson(res, 405, { error: 'Legacy SSE connections require GET.' });
      return;
    }

    const server = options.createServer();
    const transport = new SSEServerTransport('/messages', res);
    sseSessions.set(transport.sessionId, { server, transport });

    transport.onclose = () => {
      sseSessions.delete(transport.sessionId);
      logger.info('Legacy SSE session closed', { sessionId: transport.sessionId });
      void server.close().catch(() => undefined);
    };
    transport.onerror = (error) => {
      logger.warn('Legacy SSE transport error', { error: error.message });
    };

    await server.connect(transport);
    logger.info('Legacy SSE client connected', {
      sessionId: transport.sessionId,
      endpoint: '/messages'
    });
  };

  const handleSseMessage = async (
    req: IncomingMessage,
    res: ServerResponse,
    url: URL
  ): Promise<void> => {
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      sendJson(res, 405, { error: 'Legacy SSE messages require POST.' });
      return;
    }

    const sessionId = url.searchParams.get('sessionId');
    if (!sessionId) {
      sendJson(res, 400, { error: 'The sessionId query parameter is required.' });
      return;
    }

    const session = sseSessions.get(sessionId);
    if (!session) {
      sendJson(res, 404, { error: 'Unknown SSE session.' });
      return;
    }

    const body = await readBody(req);
    await session.transport.handlePostMessage(req, res, body);
  };

  const handleRequest = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    applyCors(req, res, options.corsOrigin);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    if (url.pathname === '/healthz') {
      sendJson(res, 200, { status: 'ok' });
      return;
    }

    if (oauth && (await oauth.handle(req, res, url))) {
      return;
    }

    const bearer = req.headers.authorization?.startsWith('Bearer ')
      ? req.headers.authorization.slice('Bearer '.length)
      : undefined;
    const oauthOk = oauth !== undefined && bearer !== undefined && oauth.isValidAccessToken(bearer);
    if (!oauthOk && !isAuthorized(req, url, options.authToken)) {
      res.setHeader(
        'WWW-Authenticate',
        oauth ? `Bearer resource_metadata="${oauth.resourceMetadataUrl(req)}"` : 'Bearer'
      );
      sendJson(res, 401, { error: 'Unauthorized.' });
      return;
    }

    if (url.pathname === mcpPath) {
      await handleStreamable(req, res);
      return;
    }

    if (options.enableLegacySse && url.pathname === '/sse') {
      await handleSseConnect(req, res);
      return;
    }

    if (options.enableLegacySse && url.pathname === '/messages') {
      await handleSseMessage(req, res, url);
      return;
    }

    sendJson(res, 404, {
      error: 'Not found.',
      endpoints: {
        streamable_http: mcpPath,
        ...(options.enableLegacySse ? { sse: '/sse', messages: '/messages' } : {})
      }
    });
  };

  const httpServer: Server = createServer((req, res) => {
    handleRequest(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) {
        sendJson(res, error.status, { error: error.message });
        return;
      }
      logger.error('Unhandled HTTP transport error', { error });
      sendJson(res, 500, { error: 'Internal server error.' });
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      httpServer.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      httpServer.off('error', onError);
      resolve();
    };
    httpServer.once('error', onError);
    httpServer.once('listening', onListening);
    httpServer.listen(options.port, options.host);
  });

  const address = httpServer.address();
  const boundPort = typeof address === 'object' && address ? address.port : options.port;
  logger.info('HTTP transport listening', {
    host: options.host,
    port: boundPort,
    path: mcpPath,
    legacySse: options.enableLegacySse
  });

  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) {
      return;
    }
    closing = true;

    const closed = new Promise<void>((resolve) => {
      httpServer.close(() => resolve());
    });
    httpServer.closeAllConnections();
    await closed;

    for (const session of streamableSessions.values()) {
      await session.transport.close().catch(() => undefined);
      await session.server.close().catch(() => undefined);
    }
    streamableSessions.clear();

    for (const session of sseSessions.values()) {
      await session.transport.close().catch(() => undefined);
      await session.server.close().catch(() => undefined);
    }
    sseSessions.clear();
  };

  return {
    host: options.host,
    port: boundPort,
    path: mcpPath,
    close
  };
}
