import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

/**
 * Minimal, stateless OAuth 2.1 authorization server for single-owner deployments.
 *
 * - Dynamic client registration (RFC 7591): client_id is a signed blob of the registered metadata.
 * - Authorization code + PKCE (S256 only). The owner approves by entering the configured
 *   MCP_HTTP_TOKEN as a passcode on the consent page.
 * - Access / refresh tokens are HMAC-signed, so they survive restarts without storage.
 */

const ACCESS_TTL_S = 60 * 60;
const REFRESH_TTL_S = 30 * 24 * 60 * 60;
const CODE_TTL_S = 5 * 60;

type TokenKind = 'client' | 'code' | 'access' | 'refresh';

interface Payload {
  k: TokenKind;
  exp: number;
  [key: string]: unknown;
}

export interface OAuthOptions {
  secret: string;
  publicUrl?: string;
  mcpPath: string;
}

const b64u = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');

function sign(secret: string, payload: Payload): string {
  const body = b64u(JSON.stringify(payload));
  const mac = createHmac('sha256', secret).update(body).digest('base64url');
  return `${body}.${mac}`;
}

function verify(secret: string, token: string, kind: TokenKind): Payload | undefined {
  const [body, mac] = token.split('.');
  if (!body || !mac) {
    return undefined;
  }
  const expected = createHmac('sha256', secret).update(body).digest();
  const actual = Buffer.from(mac, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return undefined;
  }
  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Payload;
    if (payload.k !== kind || typeof payload.exp !== 'number' || payload.exp < now()) {
      return undefined;
    }
    return payload;
  } catch {
    return undefined;
  }
}

const now = (): number => Math.floor(Date.now() / 1000);

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

function json(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    Pragma: 'no-cache'
  });
  res.end(JSON.stringify(payload));
}

function html(res: ServerResponse, status: number, body: string): void {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'"
  });
  res.end(body);
}

const esc = (s: string): string =>
  s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

async function readForm(req: IncomingMessage): Promise<URLSearchParams> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > 64 * 1024) {
      throw new Error('Body too large');
    }
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const type = req.headers['content-type'] ?? '';
  if (type.includes('application/json')) {
    const obj = JSON.parse(text || '{}') as Record<string, unknown>;
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(obj)) {
      params.set(key, typeof value === 'string' ? value : JSON.stringify(value));
    }
    return params;
  }
  return new URLSearchParams(text);
}

export class OAuthProvider {
  private readonly usedCodes = new Map<string, number>();
  private readonly failures = new Map<string, { count: number; until: number }>();

  constructor(private readonly options: OAuthOptions) {}

  issuer(req: IncomingMessage): string {
    if (this.options.publicUrl) {
      return this.options.publicUrl.replace(/\/+$/, '');
    }
    const proto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0] ?? 'http';
    const host = (req.headers['x-forwarded-host'] as string | undefined) ?? req.headers.host ?? 'localhost';
    return `${proto}://${host}`;
  }

  resourceMetadataUrl(req: IncomingMessage): string {
    return `${this.issuer(req)}/.well-known/oauth-protected-resource`;
  }

  /** True when the bearer value is a valid, unexpired OAuth access token. */
  isValidAccessToken(token: string): boolean {
    return verify(this.options.secret, token, 'access') !== undefined;
  }

  /** Returns true when the request was an OAuth endpoint and has been fully handled. */
  async handle(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
    const path = url.pathname;
    const issuer = this.issuer(req);

    if (path.startsWith('/.well-known/oauth-protected-resource')) {
      json(res, 200, {
        resource: `${issuer}${this.options.mcpPath}`,
        authorization_servers: [issuer],
        bearer_methods_supported: ['header']
      });
      return true;
    }

    if (path.startsWith('/.well-known/oauth-authorization-server') ||
        path.startsWith('/.well-known/openid-configuration')) {
      json(res, 200, {
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ['code'],
        grant_types_supported: ['authorization_code', 'refresh_token'],
        code_challenge_methods_supported: ['S256'],
        token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
        scopes_supported: ['mcp']
      });
      return true;
    }

    if (path === '/register' && req.method === 'POST') {
      await this.register(req, res);
      return true;
    }
    if (path === '/authorize') {
      await this.authorize(req, res, url);
      return true;
    }
    if (path === '/token' && req.method === 'POST') {
      await this.token(req, res);
      return true;
    }
    return false;
  }

  private async register(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let params: URLSearchParams;
    try {
      params = await readForm(req);
    } catch {
      json(res, 400, { error: 'invalid_client_metadata' });
      return;
    }
    let redirectUris: string[] = [];
    try {
      redirectUris = JSON.parse(params.get('redirect_uris') ?? '[]') as string[];
    } catch {
      redirectUris = [];
    }
    if (!Array.isArray(redirectUris) || redirectUris.length === 0 ||
        !redirectUris.every((u) => typeof u === 'string' && /^(https?|[a-z][a-z0-9+.-]*):\/\//i.test(u))) {
      json(res, 400, { error: 'invalid_redirect_uri' });
      return;
    }
    const clientName = (params.get('client_name') ?? 'MCP client').slice(0, 100);
    const clientId = sign(this.options.secret, {
      k: 'client',
      exp: now() + 365 * 24 * 60 * 60,
      redirect_uris: redirectUris,
      client_name: clientName
    });
    json(res, 201, {
      client_id: clientId,
      client_id_issued_at: now(),
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none'
    });
  }

  private clientFrom(clientId: string | null): Payload | undefined {
    return clientId ? verify(this.options.secret, clientId, 'client') : undefined;
  }

  private async authorize(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    let params = url.searchParams;
    if (req.method === 'POST') {
      params = await readForm(req);
    }

    const client = this.clientFrom(params.get('client_id'));
    const redirectUri = params.get('redirect_uri') ?? '';
    const registered = (client?.redirect_uris as string[] | undefined) ?? [];
    if (!client || !registered.includes(redirectUri)) {
      html(res, 400, page('Invalid request', '<p>Unknown client or redirect URI.</p>'));
      return;
    }

    const state = params.get('state');
    const fail = (error: string): void => {
      const target = new URL(redirectUri);
      target.searchParams.set('error', error);
      if (state) {
        target.searchParams.set('state', state);
      }
      res.writeHead(302, { Location: target.toString() });
      res.end();
    };

    const challenge = params.get('code_challenge');
    if (params.get('response_type') !== 'code' || !challenge || params.get('code_challenge_method') !== 'S256') {
      fail('invalid_request');
      return;
    }

    const hidden = ['client_id', 'redirect_uri', 'response_type', 'state', 'code_challenge', 'code_challenge_method', 'scope', 'resource']
      .filter((k) => params.get(k) !== null)
      .map((k) => `<input type="hidden" name="${k}" value="${esc(params.get(k) ?? '')}">`)
      .join('');
    const form = (message = ''): string =>
      page(
        'Authorize access',
        `<p><b>${esc(String(client.client_name ?? 'An MCP client'))}</b> wants to control the browser on this server.</p>
         ${message}
         <form method="POST" action="/authorize">${hidden}
           <label>Passcode<input type="password" name="passcode" autofocus required></label>
           <button type="submit">Approve</button>
         </form>`
      );

    if (req.method !== 'POST') {
      html(res, 200, form());
      return;
    }

    const ip = req.socket.remoteAddress ?? 'unknown';
    const failure = this.failures.get(ip);
    if (failure && failure.until > Date.now()) {
      html(res, 429, form('<p class="err">Too many attempts. Try again later.</p>'));
      return;
    }

    if (!safeEqual(params.get('passcode') ?? '', this.options.secret)) {
      const count = (failure?.count ?? 0) + 1;
      this.failures.set(ip, { count, until: count >= 5 ? Date.now() + 60_000 * count : 0 });
      html(res, 401, form('<p class="err">Incorrect passcode.</p>'));
      return;
    }
    this.failures.delete(ip);

    const code = sign(this.options.secret, {
      k: 'code',
      exp: now() + CODE_TTL_S,
      cid: params.get('client_id'),
      ru: redirectUri,
      cc: challenge,
      jti: randomBytes(12).toString('base64url')
    });
    const target = new URL(redirectUri);
    target.searchParams.set('code', code);
    if (state) {
      target.searchParams.set('state', state);
    }
    res.writeHead(302, { Location: target.toString(), 'Cache-Control': 'no-store' });
    res.end();
  }

  private issue(clientId: string): Record<string, unknown> {
    const access = sign(this.options.secret, { k: 'access', exp: now() + ACCESS_TTL_S, cid: clientId });
    const refresh = sign(this.options.secret, { k: 'refresh', exp: now() + REFRESH_TTL_S, cid: clientId });
    return {
      access_token: access,
      token_type: 'Bearer',
      expires_in: ACCESS_TTL_S,
      refresh_token: refresh,
      scope: 'mcp'
    };
  }

  private async token(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let params: URLSearchParams;
    try {
      params = await readForm(req);
    } catch {
      json(res, 400, { error: 'invalid_request' });
      return;
    }
    const grant = params.get('grant_type');

    if (grant === 'authorization_code') {
      const payload = verify(this.options.secret, params.get('code') ?? '', 'code');
      const verifier = params.get('code_verifier') ?? '';
      if (!payload) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      const jti = String(payload.jti);
      this.pruneCodes();
      if (this.usedCodes.has(jti)) {
        json(res, 400, { error: 'invalid_grant', error_description: 'Code already used.' });
        return;
      }
      const computed = createHash('sha256').update(verifier).digest('base64url');
      if (!verifier || !safeEqual(computed, String(payload.cc)) ||
          params.get('client_id') !== payload.cid ||
          params.get('redirect_uri') !== payload.ru) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      this.usedCodes.set(jti, payload.exp);
      json(res, 200, this.issue(String(payload.cid)));
      return;
    }

    if (grant === 'refresh_token') {
      const payload = verify(this.options.secret, params.get('refresh_token') ?? '', 'refresh');
      if (!payload) {
        json(res, 400, { error: 'invalid_grant' });
        return;
      }
      json(res, 200, this.issue(String(payload.cid)));
      return;
    }

    json(res, 400, { error: 'unsupported_grant_type' });
  }

  private pruneCodes(): void {
    const t = now();
    for (const [jti, exp] of this.usedCodes) {
      if (exp < t) {
        this.usedCodes.delete(jti);
      }
    }
  }
}

function page(title: string, body: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;display:grid;place-items:center;min-height:100vh;margin:0}
main{background:#1e293b;padding:2rem;border-radius:12px;max-width:380px;width:90%}
label{display:block;margin:1rem 0}input[type=password]{width:100%;padding:.6rem;margin-top:.4rem;border-radius:6px;border:1px solid #475569;background:#0f172a;color:inherit;box-sizing:border-box}
button{width:100%;padding:.7rem;border:0;border-radius:6px;background:#3b82f6;color:#fff;font-size:1rem;cursor:pointer}.err{color:#f87171}
</style></head><body><main><h2>${esc(title)}</h2>${body}</main></body></html>`;
}
