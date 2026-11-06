import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { imageResult, jsonResult, textResult } from '../result.js';
import { registerTool, type ToolContext } from './define.js';
import { safeTitle, selectorSchema, timeoutSchema } from './shared.js';

interface MarkdownInput {
  selector: string;
  maxChars: number;
}

interface MarkdownOutput {
  content: string;
  truncated: boolean;
  selectorFound: boolean;
}

/**
 * Runs inside the page. Must stay self-contained because Playwright serializes
 * the function source.
 */
function extractReadableMarkdown(input: MarkdownInput): MarkdownOutput {
  const root = document.querySelector(input.selector);
  if (!root) {
    throw new Error(`Selector did not match any element: ${input.selector}`);
  }

  const blocks: string[] = [];
  let length = 0;
  let truncated = false;

  const normalize = (value: string | null | undefined): string =>
    (value ?? '').replace(/\s+/g, ' ').trim();

  const isVisible = (element: Element): boolean => {
    if (element.hasAttribute('hidden') || element.getAttribute('aria-hidden') === 'true') {
      return false;
    }
    const style = window.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
  };

  const push = (text: string): void => {
    const value = text.trim();
    if (!value) {
      return;
    }
    if (length + value.length > input.maxChars) {
      truncated = true;
      return;
    }
    blocks.push(value);
    length += value.length + 1;
  };

  const describeField = (element: Element): string => {
    const tag = element.tagName.toLowerCase();
    const type = element.getAttribute('type');
    const parts: string[] = [];

    if (tag === 'input') {
      parts.push(`input${type ? `[type=${type}]` : ''}`);
    } else {
      parts.push(tag);
    }

    const ariaLabel = element.getAttribute('aria-label');
    if (ariaLabel) {
      parts.push(`aria-label="${normalize(ariaLabel)}"`);
    }

    const labels = (element as HTMLInputElement).labels;
    if (labels && labels.length > 0) {
      const labelText = normalize(labels[0]?.textContent);
      if (labelText) {
        parts.push(`label="${labelText}"`);
      }
    }

    const name = element.getAttribute('name');
    if (name) {
      parts.push(`name="${name}"`);
    }
    const id = element.getAttribute('id');
    if (id) {
      parts.push(`id="${id}"`);
    }
    const placeholder = element.getAttribute('placeholder');
    if (placeholder) {
      parts.push(`placeholder="${normalize(placeholder)}"`);
    }

    const rawValue = (element as HTMLInputElement).value;
    if (typeof rawValue === 'string' && rawValue && type !== 'password') {
      parts.push(`value="${normalize(rawValue).slice(0, 120)}"`);
    }

    if (type === 'checkbox' || type === 'radio') {
      parts.push((element as HTMLInputElement).checked ? 'checked' : 'unchecked');
    }

    if (tag === 'select') {
      const options = Array.from((element as HTMLSelectElement).options)
        .slice(0, 12)
        .map((option) => normalize(option.textContent))
        .filter(Boolean);
      if (options.length > 0) {
        parts.push(`options=[${options.join(' | ')}]`);
      }
    }

    return `[${parts.join(' ')}]`;
  };

  const inline = (element: Element): string => {
    let output = '';

    for (const node of Array.from(element.childNodes)) {
      if (node.nodeType === Node.TEXT_NODE) {
        output += node.textContent ?? '';
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) {
        continue;
      }

      const child = node as Element;
      const tag = child.tagName.toLowerCase();
      if (['script', 'style', 'noscript', 'template'].includes(tag) || !isVisible(child)) {
        continue;
      }
      if (tag === 'br') {
        output += ' ';
        continue;
      }
      if (tag === 'img') {
        const alt = normalize(child.getAttribute('alt'));
        if (alt) {
          output += `[image: ${alt}]`;
        }
        continue;
      }
      if (tag === 'input' || tag === 'textarea' || tag === 'select') {
        output += ` ${describeField(child)} `;
        continue;
      }

      const content = inline(child);
      if (tag === 'a') {
        if (content.trim()) {
          output += `[${content.trim()}](${child.getAttribute('href') ?? ''})`;
        }
        continue;
      }
      if (tag === 'code') {
        output += `\`${normalize(child.textContent)}\``;
        continue;
      }
      if (tag === 'strong' || tag === 'b') {
        output += `**${content}**`;
        continue;
      }
      if (tag === 'em' || tag === 'i') {
        output += `*${content}*`;
        continue;
      }
      output += content;
    }

    return normalize(output);
  };

  const walk = (element: Element): void => {
    if (truncated || !isVisible(element)) {
      return;
    }

    const tag = element.tagName.toLowerCase();
    if (['script', 'style', 'noscript', 'template', 'svg', 'canvas'].includes(tag)) {
      return;
    }

    if (/^h[1-6]$/.test(tag)) {
      push(`${'#'.repeat(Number(tag[1]))} ${inline(element)}`);
      return;
    }

    switch (tag) {
      case 'p':
        push(inline(element));
        return;
      case 'li':
        push(`- ${inline(element)}`);
        return;
      case 'blockquote':
        push(`> ${inline(element)}`);
        return;
      case 'pre': {
        const code = (element.textContent ?? '').replace(/\n{3,}/g, '\n\n').trim();
        if (code) {
          push(`\`\`\`\n${code.slice(0, 4000)}\n\`\`\``);
        }
        return;
      }
      case 'img': {
        const alt = normalize(element.getAttribute('alt'));
        const src = element.getAttribute('src') ?? '';
        if (alt || src) {
          push(`[image: ${alt || '(no alt)'}](${src})`);
        }
        return;
      }
      case 'input':
      case 'textarea':
      case 'select':
        push(describeField(element));
        return;
      case 'button': {
        const label = inline(element) || normalize(element.getAttribute('aria-label'));
        if (label) {
          push(`[button: ${label}]`);
        }
        return;
      }
      case 'a': {
        const label = normalize(element.textContent);
        if (label) {
          push(`[${label}](${element.getAttribute('href') ?? ''})`);
        }
        return;
      }
      case 'table': {
        const rows = Array.from(element.querySelectorAll('tr')).slice(0, 40);
        for (const row of rows) {
          const cells = Array.from(row.querySelectorAll('th,td')).map((cell) =>
            normalize(cell.textContent)
          );
          if (cells.some(Boolean)) {
            push(`| ${cells.join(' | ')} |`);
          }
        }
        return;
      }
      case 'iframe':
        push(`[iframe: ${element.getAttribute('src') ?? 'about:blank'}]`);
        return;
      default:
        break;
    }

    if (element.getAttribute('role') === 'button') {
      const label = inline(element);
      if (label) {
        push(`[button: ${label}]`);
        return;
      }
    }

    const blocksBefore = blocks.length;
    for (const child of Array.from(element.children)) {
      walk(child);
      if (truncated) {
        return;
      }
    }

    if (blocks.length === blocksBefore) {
      const ownText = inline(element);
      if (ownText) {
        push(ownText);
      }
    }
  };

  walk(root);

  return {
    content: blocks.join('\n\n'),
    truncated,
    selectorFound: true
  };
}

export function registerPerceptionTools(server: McpServer, context: ToolContext): void {
  registerTool(server, context, {
    name: 'capture_viewport',
    title: 'Capture Screenshot',
    description:
      'Capture a screenshot of the active tab and return it as a base64-encoded image content block. Use full_page to capture the entire scrollable page.',
    inputSchema: {
      full_page: z.boolean().default(false).describe('Capture the full scrollable page instead of the viewport.'),
      quality: z
        .number()
        .int()
        .min(1)
        .max(100)
        .default(80)
        .describe('JPEG compression quality from 1 to 100. Ignored for PNG output.'),
      format: z
        .enum(['jpeg', 'png'])
        .default('jpeg')
        .describe('Image format. JPEG keeps payloads small; PNG is lossless.')
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const buffer = await tab.page.screenshot({
        fullPage: input.full_page,
        type: input.format,
        ...(input.format === 'jpeg' ? { quality: input.quality } : {})
      });

      return imageResult(
        buffer.toString('base64'),
        input.format === 'png' ? 'image/png' : 'image/jpeg'
      );
    }
  });

  registerTool(server, context, {
    name: 'get_dom_tree',
    title: 'Read Page Content',
    description:
      'Extract a compact, model-friendly representation of the page (or a selector subtree). Markdown mode returns headings, text, links, form fields, buttons, and tables. ARIA mode returns the accessibility tree snapshot.',
    inputSchema: {
      selector: z
        .string()
        .min(1)
        .default('body')
        .describe('Root element to extract from. Defaults to body.'),
      format: z
        .enum(['markdown', 'aria'])
        .default('markdown')
        .describe('Output format: readable Markdown or a Playwright ARIA snapshot.'),
      max_chars: z
        .number()
        .int()
        .min(500)
        .max(200_000)
        .default(20_000)
        .describe('Maximum number of characters to return. Defaults to 20000.')
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const title = await safeTitle(tab.page);
      const header = [
        `URL: ${tab.page.url()}`,
        `Title: ${title}`,
        `Selector: ${input.selector}`,
        `Format: ${input.format}`,
        ''
      ].join('\n');

      if (input.format === 'aria') {
        const locator = tab.page.locator(input.selector).first();
        await locator.waitFor({ state: 'attached', timeout: 10_000 });
        const snapshot = await locator.ariaSnapshot();
        const truncated = snapshot.length > input.max_chars;
        const content = truncated
          ? `${snapshot.slice(0, input.max_chars)}\n\n[truncated: ${snapshot.length - input.max_chars} characters omitted]`
          : snapshot;
        return textResult(`${header}\n${content}`);
      }

      const result = await tab.page.evaluate(extractReadableMarkdown, {
        selector: input.selector,
        maxChars: input.max_chars
      });

      const footer = result.truncated
        ? '\n\n[truncated: output reached max_chars]'
        : '';
      const content = result.content.trim() || '(no visible content found in this subtree)';
      return textResult(`${header}\n${content}${footer}`);
    }
  });

  registerTool(server, context, {
    name: 'get_element_details',
    title: 'Inspect Element',
    description:
      'Return the tag, text, attributes, value, visibility, enabled state, outer HTML, and bounding box of the first element matching the selector.',
    inputSchema: {
      selector: selectorSchema
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const locator = tab.page.locator(input.selector);
      const matchCount = await locator.count();
      const first = locator.first();
      await first.waitFor({ state: 'attached', timeout: 10_000 });

      const details = await first.evaluate((element) => {
        const attributes: Record<string, string> = {};
        for (const attribute of Array.from(element.attributes)) {
          attributes[attribute.name] = attribute.value;
        }

        const style = window.getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        const htmlElement = element as HTMLElement;
        const rawValue = (element as HTMLInputElement).value;
        const isPassword = element.getAttribute('type') === 'password';

        return {
          tag: element.tagName.toLowerCase(),
          text: (element.textContent ?? '').trim().slice(0, 4000),
          inner_text: (htmlElement.innerText ?? '').trim().slice(0, 4000),
          value:
            typeof rawValue === 'string'
              ? isPassword
                ? '[redacted]'
                : rawValue.slice(0, 1000)
              : null,
          attributes,
          aria_label: element.getAttribute('aria-label'),
          role: element.getAttribute('role'),
          is_visible:
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            rect.width > 0 &&
            rect.height > 0,
          is_enabled: !(element as HTMLButtonElement).disabled,
          rect: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height
          },
          outer_html: element.outerHTML.slice(0, 4000)
        };
      });

      return jsonResult({
        tab_id: tab.id,
        selector: input.selector,
        match_count: matchCount,
        bounding_box: await first.boundingBox(),
        ...details
      });
    }
  });

  registerTool(server, context, {
    name: 'wait_for_element',
    title: 'Wait For Element',
    description:
      'Wait until the first element matching the selector reaches the requested state. Returns an error with a recovery hint if the timeout expires.',
    inputSchema: {
      selector: selectorSchema,
      state: z
        .enum(['visible', 'hidden', 'attached'])
        .default('visible')
        .describe('Element state to wait for. Defaults to visible.'),
      timeout_ms: timeoutSchema(10_000)
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: true
    },
    handler: async (input, { manager }) => {
      const tab = manager.getTabHandle();
      const startedAt = Date.now();
      await tab.page
        .locator(input.selector)
        .first()
        .waitFor({ state: input.state, timeout: input.timeout_ms });

      return jsonResult({
        found: true,
        tab_id: tab.id,
        selector: input.selector,
        state: input.state,
        elapsed_ms: Date.now() - startedAt,
        url: tab.page.url()
      });
    }
  });
}
