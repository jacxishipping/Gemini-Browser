import { ToolError } from './errors.js';

const NAVIGABLE_PROTOCOLS = new Set(['http:', 'https:', 'file:', 'about:', 'data:']);
const CDP_PROTOCOLS = new Set(['ws:', 'wss:', 'http:', 'https:']);

export function assertNavigableUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ToolError('URL must not be empty.', 'Provide an absolute URL such as https://example.com.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ToolError(
      `Invalid URL: ${trimmed}`,
      'Include a scheme, for example https://example.com or http://localhost:3000.'
    );
  }

  if (!NAVIGABLE_PROTOCOLS.has(parsed.protocol)) {
    throw new ToolError(
      `Unsupported URL protocol "${parsed.protocol}".`,
      'Only http:, https:, file:, about:, and data: URLs are allowed.'
    );
  }

  return trimmed;
}

export function assertCdpEndpoint(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ToolError('cdp_endpoint must not be empty.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ToolError(
      `Invalid CDP endpoint: ${trimmed}`,
      'Use a WebSocket endpoint such as ws://127.0.0.1:9222/devtools/browser/<id>, or an HTTP endpoint such as http://127.0.0.1:9222.'
    );
  }

  if (!CDP_PROTOCOLS.has(parsed.protocol)) {
    throw new ToolError(
      `Unsupported CDP endpoint protocol "${parsed.protocol}".`,
      'CDP endpoints must use ws:, wss:, http:, or https:.'
    );
  }

  return trimmed;
}
