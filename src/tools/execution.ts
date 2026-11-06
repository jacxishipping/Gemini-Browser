import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult, textResult } from '../result.js';
import { registerTool, type ToolContext } from './define.js';
import { tabIdSchema } from './shared.js';

const MAX_SCRIPT_OUTPUT_CHARS = 100_000;

export function registerExecutionTools(server: McpServer, context: ToolContext): void {
  registerTool(server, context, {
    name: 'execute_javascript',
    title: 'Execute JavaScript',
    description:
      'Evaluate arbitrary JavaScript in the active tab and return a serialized result. Runs in page context and supports top-level await, statements, and DOM access. DOM nodes, Errors, Maps, Sets, Dates, and circular structures are serialized safely.',
    inputSchema: {
      script: z
        .string()
        .min(1)
        .describe(
          'JavaScript to evaluate. An expression returns its value; a statement body may use "return"; top-level await is supported.'
        )
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();

      const outcome = await tab.page.evaluate(async (source: string) => {
        const seen = new WeakSet<object>();

        const serialize = (value: unknown, depth: number): unknown => {
          if (value === undefined) {
            return { __type: 'undefined' };
          }
          if (value === null) {
            return null;
          }

          const type = typeof value;
          if (type === 'string' || type === 'number' || type === 'boolean') {
            return value;
          }
          if (type === 'bigint') {
            return `${String(value)}n`;
          }
          if (type === 'function') {
            return {
              __type: 'function',
              name: (value as Function).name || '(anonymous)'
            };
          }
          if (type === 'symbol') {
            return {
              __type: 'symbol',
              description: (value as symbol).description ?? null
            };
          }
          if (depth > 5) {
            return Array.isArray(value) ? '[Array]' : '[Object]';
          }

          if (value instanceof Date) {
            return { __type: 'Date', iso: value.toISOString() };
          }
          if (value instanceof RegExp) {
            return { __type: 'RegExp', source: value.source, flags: value.flags };
          }
          if (value instanceof Error) {
            return {
              __type: 'Error',
              name: value.name,
              message: value.message,
              stack: value.stack ?? null
            };
          }
          if (typeof Node !== 'undefined' && value instanceof Node) {
            if (value instanceof Element) {
              return {
                __type: 'Element',
                tag: value.tagName.toLowerCase(),
                id: value.id || null,
                classes: Array.from(value.classList).slice(0, 20),
                text: (value.textContent ?? '').trim().slice(0, 1000)
              };
            }
            return {
              __type: 'Node',
              node_name: value.nodeName,
              text: (value.textContent ?? '').trim().slice(0, 1000)
            };
          }

          if (typeof value === 'object') {
            const objectValue = value as object;
            if (seen.has(objectValue)) {
              return '[Circular]';
            }
            seen.add(objectValue);

            if (Array.isArray(value)) {
              return value.slice(0, 1000).map((item) => serialize(item, depth + 1));
            }
            if (value instanceof Map) {
              return {
                __type: 'Map',
                entries: Array.from(value.entries())
                  .slice(0, 200)
                  .map(([key, item]) => [serialize(key, depth + 1), serialize(item, depth + 1)])
              };
            }
            if (value instanceof Set) {
              return {
                __type: 'Set',
                values: Array.from(value.values())
                  .slice(0, 200)
                  .map((item) => serialize(item, depth + 1))
              };
            }
            if (value instanceof Promise) {
              return '[Promise]';
            }

            const record: Record<string, unknown> = {};
            const keys = Object.keys(value as Record<string, unknown>).slice(0, 500);
            for (const key of keys) {
              try {
                record[key] = serialize(
                  (value as Record<string, unknown>)[key],
                  depth + 1
                );
              } catch {
                record[key] = '[Unreadable]';
              }
            }
            return record;
          }

          return String(value);
        };

        let mode: 'eval' | 'function_body' = 'eval';
        let value: unknown;

        try {
          value = await (0, eval)(source);
        } catch (error) {
          if (error instanceof SyntaxError) {
            mode = 'function_body';
            const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
              body: string
            ) => () => Promise<unknown>;
            const fn = new AsyncFunction(source);
            value = await fn();
          } else {
            throw error;
          }
        }

        return { mode, value: serialize(value, 0) };
      }, input.script);

      const serialized = JSON.stringify(
        {
          tab_id: tab.id,
          url: tab.page.url(),
          mode: outcome.mode,
          result: outcome.value
        },
        (_key, value: unknown) => (typeof value === 'bigint' ? String(value) : value),
        2
      );

      const text = serialized ?? 'null';
      if (text.length > MAX_SCRIPT_OUTPUT_CHARS) {
        return textResult(
          `${text.slice(0, MAX_SCRIPT_OUTPUT_CHARS)}\n\n[truncated: result exceeded ${MAX_SCRIPT_OUTPUT_CHARS} characters]`
        );
      }
      return textResult(text);
    }
  });

  registerTool(server, context, {
    name: 'get_console_errors',
    title: 'Get Console Errors',
    description:
      'Return browser console errors, unhandled page exceptions, and page crashes captured for a tab (active tab by default). Optionally clear the captured log after reading.',
    inputSchema: {
      tab_id: tabIdSchema
        .optional()
        .describe('Tab to read. Defaults to the active tab.'),
      limit: z
        .number()
        .int()
        .min(1)
        .max(500)
        .default(100)
        .describe('Maximum number of most recent entries to return. Defaults to 100.'),
      clear: z
        .boolean()
        .default(false)
        .describe('Clear the tab error log after reading. Defaults to false.')
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const report = manager.getConsoleErrors(input.tab_id, input.limit, input.clear);
      return jsonResult({
        tab_id: report.tabId,
        url: report.url,
        count: report.count,
        cleared: input.clear,
        errors: report.errors.map((entry) => ({
          timestamp: entry.timestamp,
          type: entry.type,
          text: entry.text,
          location: entry.location ?? null,
          stack: entry.stack ?? null,
          page_url: entry.pageUrl
        }))
      });
    }
  });
}
