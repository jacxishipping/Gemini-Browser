import { z } from 'zod';
import type { TabInfo } from '../browser-manager.js';

export const tabIdSchema = z
  .string()
  .min(1)
  .describe('Tab identifier returned by tab_new or tab_list (for example "tab-1a2b3c4d").');

export const selectorSchema = z
  .string()
  .min(1)
  .describe(
    'Playwright/CSS selector. Supports CSS, text=, role=, and other Playwright selector engines. The first match is used.'
  );

export const waitUntilSchema = z
  .enum(['load', 'domcontentloaded', 'networkidle'])
  .default('load')
  .describe(
    'Navigation wait condition. "load" waits for the load event, "domcontentloaded" for DOMContentLoaded, "networkidle" for 500ms without network activity (can time out on busy pages).'
  );

export function timeoutSchema(defaultMs: number, maximumMs = 300_000) {
  return z
    .number()
    .int()
    .min(1)
    .max(maximumMs)
    .default(defaultMs)
    .describe(`Timeout in milliseconds (default ${defaultMs}).`);
}

export interface TabPayload {
  tab_id: string;
  title: string;
  url: string;
  active: boolean;
  closed?: boolean;
  video_path?: string;
}

export function toTabPayload(tab: TabInfo): TabPayload {
  return {
    tab_id: tab.tabId,
    title: tab.title,
    url: tab.url,
    active: tab.active,
    ...(tab.closed ? { closed: true } : {}),
    ...(tab.videoPath ? { video_path: tab.videoPath } : {})
  };
}

export async function safeTitle(page: { title: () => Promise<string> }): Promise<string> {
  try {
    return await page.title();
  } catch {
    return '';
  }
}
