const MAX_ERROR_LENGTH = 6000;

/**
 * Error intended to be shown to the MCP client as-is, optionally with a hint
 * describing how the model should recover.
 */
export class ToolError extends Error {
  override readonly name = 'ToolError';
  readonly hint?: string;

  constructor(message: string, hint?: string, options?: { cause?: unknown }) {
    super(message, options);
    this.hint = hint;
  }
}

export interface FailureDescription {
  message: string;
  hint?: string;
}

function truncate(value: string, maxLength = MAX_ERROR_LENGTH): string {
  if (value.length <= maxLength) {
    return value;
  }
  const head = Math.floor(maxLength * 0.7);
  const tail = maxLength - head;
  return `${value.slice(0, head)}\n… [truncated] …\n${value.slice(-tail)}`;
}

function inferHint(message: string): string | undefined {
  if (/Timeout \d+ms exceeded/i.test(message)) {
    return 'The operation timed out. Increase the timeout, or verify that the selector/URL is correct and the page has finished loading.';
  }
  if (/strict mode violation/i.test(message)) {
    return 'The selector matched more than one element. Use a more specific selector.';
  }
  if (/Target page, context or browser has been closed|Target closed|has been closed/i.test(message)) {
    return 'The browser or tab is no longer open. Call browser_launch, then tab_new, and retry.';
  }
  if (/net::ERR_[A-Z_]+/i.test(message)) {
    return 'The page could not be reached. Check the URL, DNS, and network connectivity.';
  }
  if (/Executable doesn't exist|browserType\.launch/i.test(message)) {
    return 'The browser binary is missing. Run "npx playwright install chromium" (or the engine you selected) and retry.';
  }
  if (/ENOENT|no such file or directory|file does not exist/i.test(message)) {
    return 'A required file was not found. Verify the path exists and is readable.';
  }
  if (/not an <input type="file">|File input/i.test(message)) {
    return 'upload_file requires a selector that points to an <input type="file"> element.';
  }
  if (/Element is not attached|element is not attached/i.test(message)) {
    return 'The page changed and the element was replaced. Re-query the page with get_dom_tree or get_element_details, then retry.';
  }
  if (/Unknown tab_id/i.test(message)) {
    return 'Call tab_list to see the currently open tabs.';
  }
  if (/No active tab/i.test(message)) {
    return 'Call tab_new to open a tab, then retry.';
  }
  if (/No browser session/i.test(message)) {
    return 'Call browser_launch before using browser tools.';
  }
  return undefined;
}

export function describeFailure(error: unknown): FailureDescription {
  if (error instanceof ToolError) {
    return {
      message: error.message,
      ...(error.hint ? { hint: error.hint } : {})
    };
  }

  if (error instanceof Error) {
    const message = truncate(error.message || error.name);
    const hint = inferHint(message);
    return {
      message,
      ...(hint ? { hint } : {})
    };
  }

  return { message: truncate(String(error)) };
}
