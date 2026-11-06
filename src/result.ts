import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeFailure } from './errors.js';

function stringify(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }
  const serialized = JSON.stringify(
    value,
    (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item),
    2
  );
  return serialized ?? String(value);
}

export function textResult(text: string): CallToolResult {
  return {
    content: [{ type: 'text', text }]
  };
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(stringify(value));
}

export function imageResult(data: string, mimeType: 'image/png' | 'image/jpeg'): CallToolResult {
  return {
    content: [{ type: 'image', data, mimeType }]
  };
}

export function errorResult(error: unknown): CallToolResult {
  const { message, hint } = describeFailure(error);
  const text = hint ? `${message}\n\nHint: ${hint}` : message;
  return {
    isError: true,
    content: [{ type: 'text', text }]
  };
}
