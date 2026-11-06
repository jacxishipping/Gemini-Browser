import { stat } from 'node:fs/promises';
import path from 'node:path';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { jsonResult } from '../result.js';
import { ToolError } from '../errors.js';
import { registerTool, type ToolContext } from './define.js';
import { safeTitle, selectorSchema } from './shared.js';

const KEY_ALIASES: Record<string, string> = {
  ctrl: 'Control',
  cmd: 'Meta',
  command: 'Meta',
  meta: 'Meta',
  super: 'Meta',
  win: 'Meta',
  alt: 'Alt',
  option: 'Alt',
  shift: 'Shift',
  enter: 'Enter',
  return: 'Enter',
  esc: 'Escape',
  escape: 'Escape',
  tab: 'Tab',
  space: 'Space',
  spacebar: 'Space',
  backspace: 'Backspace',
  delete: 'Delete',
  del: 'Delete',
  insert: 'Insert',
  home: 'Home',
  end: 'End',
  pageup: 'PageUp',
  pagedown: 'PageDown',
  arrowup: 'ArrowUp',
  arrowdown: 'ArrowDown',
  arrowleft: 'ArrowLeft',
  arrowright: 'ArrowRight',
  up: 'ArrowUp',
  down: 'ArrowDown',
  left: 'ArrowLeft',
  right: 'ArrowRight',
  comma: ',',
  period: '.',
  plus: '+'
};

function normalizeKeyCombo(raw: string): string {
  const parts = raw
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

  if (parts.length === 0) {
    throw new ToolError('key_or_combo must contain a key name.');
  }

  return parts
    .map((part) => {
      const alias = KEY_ALIASES[part.toLowerCase()];
      if (alias) {
        return alias;
      }
      if (/^f\d{1,2}$/i.test(part)) {
        return part.toUpperCase();
      }
      return part;
    })
    .join('+');
}

export function registerInteractionTools(server: McpServer, context: ToolContext): void {
  registerTool(server, context, {
    name: 'click_element',
    title: 'Click Element',
    description:
      'Click the first element matching the selector. Waits for the element to be visible and actionable. If the click opens a new tab, that tab becomes active.',
    inputSchema: {
      selector: selectorSchema,
      button: z
        .enum(['left', 'right', 'middle'])
        .default('left')
        .describe('Mouse button to use. Defaults to left.'),
      click_count: z
        .number()
        .int()
        .min(1)
        .max(3)
        .default(1)
        .describe('Number of consecutive clicks. Defaults to 1.')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const locator = tab.page.locator(input.selector).first();
      await locator.waitFor({ state: 'visible', timeout: 15_000 });
      await locator.click({
        button: input.button,
        clickCount: input.click_count,
        timeout: 15_000
      });

      const activeTab = manager.getTabHandle();
      return jsonResult({
        status: 'clicked',
        selector: input.selector,
        button: input.button,
        click_count: input.click_count,
        tab_id: activeTab.id,
        new_tab_opened: activeTab.id !== tab.id,
        url: activeTab.page.url(),
        title: await safeTitle(activeTab.page)
      });
    }
  });

  registerTool(server, context, {
    name: 'type_text',
    title: 'Type Text',
    description:
      'Type text into an input, textarea, or contenteditable element. Use clear_first to replace existing content. Optionally press Enter after typing.',
    inputSchema: {
      selector: selectorSchema,
      text: z.string().describe('Text to type. Pass an empty string only with clear_first=true.'),
      clear_first: z
        .boolean()
        .default(false)
        .describe('Clear the existing content before typing. Defaults to false.'),
      press_enter: z
        .boolean()
        .default(false)
        .describe('Press Enter after typing, which can submit forms. Defaults to false.')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const locator = tab.page.locator(input.selector).first();
      await locator.waitFor({ state: 'visible', timeout: 15_000 });

      if (input.clear_first) {
        await locator.fill(input.text, { timeout: 15_000 });
      } else {
        await locator.click({ timeout: 15_000 });
        await locator.evaluate((element) => {
          const htmlElement = element as HTMLElement;
          if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
            element.focus();
            element.setSelectionRange(element.value.length, element.value.length);
            return;
          }
          if (htmlElement.isContentEditable) {
            htmlElement.focus();
            const selection = window.getSelection();
            if (selection) {
              const range = document.createRange();
              range.selectNodeContents(htmlElement);
              range.collapse(false);
              selection.removeAllRanges();
              selection.addRange(range);
            }
          }
        });
        await tab.page.keyboard.type(input.text, { delay: 10 });
      }

      if (input.press_enter) {
        await tab.page.keyboard.press('Enter');
      }

      const currentValue = await locator
        .evaluate((element) => {
          if (element instanceof HTMLInputElement) {
            return element.type === 'password' ? '[redacted]' : element.value;
          }
          if (element instanceof HTMLTextAreaElement) {
            return element.value;
          }
          if ((element as HTMLElement).isContentEditable) {
            return (element.textContent ?? '').trim();
          }
          return null;
        })
        .catch(() => null);

      return jsonResult({
        status: 'typed',
        tab_id: tab.id,
        selector: input.selector,
        characters_typed: input.text.length,
        cleared_first: input.clear_first,
        pressed_enter: input.press_enter,
        value: currentValue,
        url: tab.page.url()
      });
    }
  });

  registerTool(server, context, {
    name: 'press_key',
    title: 'Press Key',
    description:
      'Press a key or keyboard shortcut on the active tab, such as "Enter", "Tab", "Escape", or "Control+A". Modifiers: Control/Ctrl, Alt, Shift, Meta/Cmd.',
    inputSchema: {
      key_or_combo: z
        .string()
        .min(1)
        .describe('Playwright key or "+"-separated combination, for example "Enter" or "Control+Shift+T".')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const combo = normalizeKeyCombo(input.key_or_combo);
      await tab.page.keyboard.press(combo);

      return jsonResult({
        status: 'pressed',
        tab_id: tab.id,
        key: combo,
        url: tab.page.url(),
        title: await safeTitle(tab.page)
      });
    }
  });

  registerTool(server, context, {
    name: 'scroll_page',
    title: 'Scroll Page',
    description:
      'Scroll the active viewport up or down using the mouse wheel. Returns the resulting scroll position and whether the top or bottom was reached.',
    inputSchema: {
      direction: z.enum(['up', 'down']).describe('Scroll direction.'),
      amount_px: z
        .number()
        .int()
        .min(1)
        .max(100_000)
        .default(500)
        .describe('Number of pixels to scroll. Defaults to 500.')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const dimensions = await tab.page.evaluate(() => ({
        width: window.innerWidth,
        height: window.innerHeight
      }));
      const delta = input.direction === 'down' ? input.amount_px : -input.amount_px;

      await tab.page.mouse.move(
        Math.max(1, Math.floor(dimensions.width / 2)),
        Math.max(1, Math.floor(dimensions.height / 2))
      );
      await tab.page.mouse.wheel(0, delta);
      await tab.page.waitForTimeout(250);

      const metrics = await tab.page.evaluate(() => {
        const maxScroll = Math.max(
          document.documentElement.scrollHeight,
          document.body?.scrollHeight ?? 0
        );
        return {
          scroll_x: window.scrollX,
          scroll_y: window.scrollY,
          scroll_height: maxScroll,
          viewport_height: window.innerHeight
        };
      });

      return jsonResult({
        status: 'scrolled',
        tab_id: tab.id,
        direction: input.direction,
        amount_px: input.amount_px,
        ...metrics,
        at_top: metrics.scroll_y <= 0,
        at_bottom: metrics.scroll_y + metrics.viewport_height >= metrics.scroll_height - 1
      });
    }
  });

  registerTool(server, context, {
    name: 'select_dropdown',
    title: 'Select Dropdown Option',
    description:
      'Select an option in a <select> element by its option value. Use get_element_details or get_dom_tree to discover the available option values.',
    inputSchema: {
      selector: selectorSchema,
      value: z.string().min(1).describe('Option value to select.')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const locator = tab.page.locator(input.selector).first();
      await locator.waitFor({ state: 'visible', timeout: 10_000 });

      let selected: string[];
      try {
        selected = await locator.selectOption(input.value, { timeout: 10_000 });
      } catch (error) {
        throw new ToolError(
          `Could not select "${input.value}" in "${input.selector}": ${
            error instanceof Error ? error.message : String(error)
          }`,
          'Pass the exact option value from the HTML. Use get_element_details or get_dom_tree to inspect the available options.'
        );
      }

      const label = await locator
        .evaluate((element) => {
          const select = element as HTMLSelectElement;
          const option = select.selectedOptions?.[0];
          return option ? (option.textContent ?? '').trim() : null;
        })
        .catch(() => null);

      return jsonResult({
        status: 'selected',
        tab_id: tab.id,
        selector: input.selector,
        selected_values: selected,
        selected_label: label
      });
    }
  });

  registerTool(server, context, {
    name: 'upload_file',
    title: 'Upload Files',
    description:
      'Set one or more local files on an <input type="file"> element. Paths may be absolute or relative to the server working directory.',
    inputSchema: {
      selector: selectorSchema,
      file_paths: z
        .array(z.string().min(1))
        .min(1)
        .max(50)
        .describe('Local file paths to upload.')
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const resolvedPaths = input.file_paths.map((filePath) => path.resolve(filePath));
      for (const filePath of resolvedPaths) {
        const info = await stat(filePath);
        if (!info.isFile()) {
          throw new ToolError(
            `Not a regular file: ${filePath}`,
            'upload_file accepts file paths only, not directories.'
          );
        }
      }

      const tab = manager.getTabHandle();
      const locator = tab.page.locator(input.selector).first();
      await locator.setInputFiles(resolvedPaths, { timeout: 15_000 });

      return jsonResult({
        status: 'uploaded',
        tab_id: tab.id,
        selector: input.selector,
        uploaded_count: resolvedPaths.length,
        files: resolvedPaths.map((filePath) => path.basename(filePath))
      });
    }
  });
}
