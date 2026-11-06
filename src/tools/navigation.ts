import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from '../result.js';
import { assertNavigableUrl } from '../url-utils.js';
import { registerTool, type ToolContext } from './define.js';
import { safeTitle, timeoutSchema, waitUntilSchema } from './shared.js';

export function registerNavigationTools(server: McpServer, context: ToolContext): void {
  registerTool(server, context, {
    name: 'navigate_to',
    title: 'Navigate Active Tab',
    description:
      'Navigate the active tab to a URL and wait for the requested load state. Accepts http(s), file, about, and data URLs.',
    inputSchema: {
      url: z.string().min(1).describe('Absolute URL to navigate to.'),
      wait_until: waitUntilSchema,
      timeout_ms: timeoutSchema(30_000)
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const target = assertNavigableUrl(input.url);
      const tab = manager.getTabHandle();
      const startedAt = Date.now();

      const response = await tab.page.goto(target, {
        waitUntil: input.wait_until,
        timeout: input.timeout_ms
      });

      return jsonResult({
        status: 'navigated',
        tab_id: tab.id,
        requested_url: target,
        url: tab.page.url(),
        title: await safeTitle(tab.page),
        http_status: response?.status() ?? null,
        wait_until: input.wait_until,
        elapsed_ms: Date.now() - startedAt
      });
    }
  });

  registerTool(server, context, {
    name: 'page_reload',
    title: 'Reload Page',
    description:
      'Reload the active tab. Set ignore_cache to bypass the HTTP cache on Chromium (other engines perform a normal reload).',
    inputSchema: {
      ignore_cache: z
        .boolean()
        .default(false)
        .describe('When true, disable the browser cache for the reload (Chromium only).')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const page = tab.page;
      let cacheBypassed = false;
      let notice: string | undefined;

      if (input.ignore_cache) {
        const engineName = page.context().browser()?.browserType().name();
        if (engineName === 'chromium') {
          const session = await tab.context.newCDPSession(page);
          try {
            await session.send('Network.setCacheDisabled', { cacheDisabled: true });
            await page.reload({ waitUntil: 'load', timeout: 30_000 });
            cacheBypassed = true;
          } finally {
            await session
              .send('Network.setCacheDisabled', { cacheDisabled: false })
              .catch(() => undefined);
            await session.detach().catch(() => undefined);
          }
        } else {
          await page.reload({ waitUntil: 'load', timeout: 30_000 });
          notice = `Cache bypass is only supported on Chromium; performed a normal reload on ${engineName ?? 'this engine'}.`;
        }
      } else {
        await page.reload({ waitUntil: 'load', timeout: 30_000 });
      }

      return jsonResult({
        status: 'reloaded',
        tab_id: tab.id,
        url: page.url(),
        title: await safeTitle(page),
        ignore_cache_requested: input.ignore_cache,
        cache_bypassed: cacheBypassed,
        ...(notice ? { notice } : {})
      });
    }
  });

  registerTool(server, context, {
    name: 'page_history',
    title: 'Navigate History',
    description: 'Go back or forward in the active tab browsing history.',
    inputSchema: {
      action: z.enum(['back', 'forward']).describe('History direction to navigate.')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const startedAt = Date.now();
      const response =
        input.action === 'back'
          ? await tab.page.goBack({ waitUntil: 'load', timeout: 30_000 })
          : await tab.page.goForward({ waitUntil: 'load', timeout: 30_000 });

      return jsonResult({
        status: response ? 'navigated' : 'unchanged',
        action: input.action,
        tab_id: tab.id,
        navigated: response !== null,
        url: tab.page.url(),
        title: await safeTitle(tab.page),
        http_status: response?.status() ?? null,
        elapsed_ms: Date.now() - startedAt,
        ...(response === null
          ? { message: `No ${input.action} history entry is available.` }
          : {})
      });
    }
  });
}
