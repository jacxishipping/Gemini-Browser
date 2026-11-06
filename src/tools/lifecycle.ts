import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from '../result.js';
import { assertCdpEndpoint, assertNavigableUrl } from '../url-utils.js';
import { BROWSER_ENGINES } from '../browser-manager.js';
import { registerTool, type ToolContext } from './define.js';
import { tabIdSchema, toTabPayload } from './shared.js';

const lifecycleAnnotations = {
  readOnlyHint: false,
  openWorldHint: true
} as const;

export function registerLifecycleTools(server: McpServer, context: ToolContext): void {
  registerTool(server, context, {
    name: 'browser_launch',
    title: 'Launch Browser',
    description:
      'Launch a new Chromium, Firefox, or WebKit browser session, or attach to an existing Chrome/Chromium instance over CDP. Call this before any other browser tool. Only one browser session can be active at a time.',
    inputSchema: {
      url: z
        .string()
        .min(1)
        .optional()
        .describe('Optional URL to open in the initial tab. Defaults to about:blank.'),
      headless: z
        .boolean()
        .default(false)
        .describe('Run the browser without a visible window. Defaults to false.'),
      cdp_endpoint: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Attach to an existing Chromium-based browser instead of launching one. Accepts ws://, wss://, http://, or https:// CDP endpoints (for example http://127.0.0.1:9222). When set, engine is forced to chromium.'
        ),
      viewport_width: z
        .number()
        .int()
        .min(320)
        .max(7680)
        .default(1440)
        .describe('Viewport width in pixels for a newly launched browser. Defaults to 1440.'),
      viewport_height: z
        .number()
        .int()
        .min(240)
        .max(4320)
        .default(900)
        .describe('Viewport height in pixels for a newly launched browser. Defaults to 900.'),
      engine: z
        .enum(BROWSER_ENGINES)
        .optional()
        .describe('Browser engine to launch. Defaults to chromium. Ignored when cdp_endpoint is set.'),
      channel: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Chromium channel to launch, such as "chrome", "msedge", or "chromium". Requires a locally installed channel.'
        ),
      executable_path: z
        .string()
        .min(1)
        .optional()
        .describe('Absolute path to a custom browser executable. Overrides Playwright-managed browsers.'),
      slow_mo_ms: z
        .number()
        .int()
        .min(0)
        .max(5000)
        .optional()
        .describe('Slow down Playwright operations by this many milliseconds, useful for demos.'),
      record_video: z
        .boolean()
        .default(false)
        .describe(
          'Record a WebM video for each tab. Videos are saved under the recordings directory when tabs close. Not available for CDP-attached browsers.'
        ),
      record_trace: z
        .boolean()
        .default(false)
        .describe(
          'Record a Playwright trace (screenshots, snapshots, sources) and save it as a ZIP when the browser closes.'
        )
    },
    annotations: lifecycleAnnotations,
    handler: async (input, { manager }) => {
      const cdpEndpoint = input.cdp_endpoint ? assertCdpEndpoint(input.cdp_endpoint) : undefined;
      const url = input.url ? assertNavigableUrl(input.url) : undefined;

      const result = await manager.launch({
        ...(url ? { url } : {}),
        headless: input.headless,
        ...(cdpEndpoint ? { cdpEndpoint } : {}),
        viewportWidth: input.viewport_width,
        viewportHeight: input.viewport_height,
        ...(input.engine ? { engine: input.engine } : {}),
        ...(input.channel ? { channel: input.channel } : {}),
        ...(input.executable_path ? { executablePath: input.executable_path } : {}),
        ...(input.slow_mo_ms !== undefined ? { slowMoMs: input.slow_mo_ms } : {}),
        recordVideo: input.record_video,
        recordTrace: input.record_trace
      });

      return jsonResult({
        status: 'launched',
        engine: result.engine,
        headless: result.headless,
        attached_over_cdp: result.attachedOverCdp,
        viewport: result.viewport,
        active_tab_id: result.activeTabId,
        recordings: {
          directory: result.recordings.directory,
          video: result.recordings.video,
          trace: result.recordings.trace
        },
        warnings: result.warnings,
        tabs: result.tabs.map(toTabPayload)
      });
    }
  });

  registerTool(server, context, {
    name: 'browser_close',
    title: 'Close Browser',
    description:
      'Close the active browser session. Locally launched browsers are terminated and open tabs are closed; CDP-attached browsers are detached without closing the external browser. Recordings are finalized before shutdown.',
    inputSchema: {},
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    handler: async (_input, { manager }) => {
      const result = await manager.close();
      return jsonResult({
        status: result.status,
        closed_tabs: result.closedTabs,
        saved_videos: result.savedVideos,
        saved_trace: result.savedTrace ?? null,
        detached_from_external_browser: result.detached
      });
    }
  });

  registerTool(server, context, {
    name: 'tab_new',
    title: 'Open New Tab',
    description:
      'Open a new tab in the active browser session, optionally navigating to a URL, and make it the active tab. Returns the new tab_id.',
    inputSchema: {
      url: z
        .string()
        .min(1)
        .optional()
        .describe('Optional URL to load in the new tab. Defaults to about:blank.')
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = await manager.newTab(input.url ? assertNavigableUrl(input.url) : undefined);
      return jsonResult({
        status: 'created',
        ...toTabPayload(tab)
      });
    }
  });

  registerTool(server, context, {
    name: 'tab_switch',
    title: 'Switch Active Tab',
    description: 'Focus an existing tab and make it the active tab for subsequent tools.',
    inputSchema: {
      tab_id: tabIdSchema
    },
    annotations: {
      readOnlyHint: false,
      idempotentHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = await manager.switchTab(input.tab_id);
      return jsonResult({
        status: 'active',
        ...toTabPayload(tab)
      });
    }
  });

  registerTool(server, context, {
    name: 'tab_close',
    title: 'Close Tab',
    description:
      'Close a specific tab by tab_id. If the closed tab was active, the most recently created remaining tab becomes active. The browser session stays open.',
    inputSchema: {
      tab_id: tabIdSchema
    },
    annotations: {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const result = await manager.closeTab(input.tab_id);
      return jsonResult({
        status: 'closed',
        closed_tab_id: result.closedTabId,
        active_tab_id: result.activeTabId,
        remaining_tabs: result.remainingTabs
      });
    }
  });

  registerTool(server, context, {
    name: 'tab_list',
    title: 'List Tabs',
    description:
      'List every open tab with its tab_id, title, URL, and which tab is active. Use this to discover tab ids before tab_switch or tab_close.',
    inputSchema: {},
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    handler: async (_input, { manager }) => {
      const tabs = await manager.listTabs();
      return jsonResult({
        active_tab_id: manager.activeTab ?? null,
        count: tabs.length,
        tabs: tabs.map(toTabPayload)
      });
    }
  });
}
