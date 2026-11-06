# Gemini Browser MCP

A standalone, production-grade [Model Context Protocol](https://modelcontextprotocol.io) server that lets an AI model launch, inspect, and drive a real web browser. It is built on Playwright and exposes 21 typed tools over stdio (default) or Streamable HTTP / legacy SSE.

- **Runtime:** Node.js 20+, TypeScript, ESM
- **MCP SDK:** `@modelcontextprotocol/sdk`
- **Automation:** Playwright (`chromium`, `firefox`, `webkit`, or attach to an existing Chrome over CDP)
- **Validation:** Zod schemas on every tool argument

## Features

- Full browser lifecycle: launch headless/headful, attach over CDP, close cleanly
- Tab registry with stable `tab_id`s, active-tab tracking, and automatic popup registration
- Navigation, history, cache-bypassing reload, screenshots, Markdown/ARIA page extraction
- Element inspection, waiting, clicking, typing, keyboard shortcuts, scrolling, dropdowns, file uploads
- Arbitrary JavaScript execution with safe serialization (DOM nodes, errors, maps, sets, cycles)
- Per-tab console error and unhandled exception capture
- Optional per-tab WebM video and per-session Playwright trace recordings
- Structured `isError` results with actionable recovery hints
- Graceful `SIGINT` / `SIGTERM` / stdin-close shutdown that finalizes recordings and closes the browser
- Optional remote HTTP transport with bearer-token auth, CORS, health check, and legacy SSE

## Requirements

- Node.js 20 or newer
- A Playwright browser binary (Chromium recommended):
  ```bash
  npx playwright install chromium
  # or all engines:
  npx playwright install
  # Linux CI/container dependencies:
  npx playwright install --with-deps chromium
  ```
- Alternatively, use an installed Chrome/Edge with `channel: "chrome"` / `"msedge"`, or a custom `executable_path`.

## Quick start

```bash
npm install
npm run build
npx playwright install chromium   # skip if using the Chrome channel
```

Run over stdio (what MCP hosts use):

```bash
node dist/server.js
```

Run over HTTP:

```bash
node dist/server.js --transport http --host 127.0.0.1 --port 3000
# or: npm run start:http
```

## Register with Claude Desktop

Copy [claude_desktop_config.json](claude_desktop_config.json) to your Claude Desktop configuration file and adjust the absolute path:

- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "gemini-browser": {
      "command": "node",
      "args": ["/absolute/path/to/Gemini-Browser/dist/server.js"],
      "env": {
        "BROWSER_RECORDINGS_DIR": "/absolute/path/to/Gemini-Browser/.recordings"
      }
    }
  }
}
```

Restart Claude Desktop and ask it to launch a browser. Other MCP hosts (Cursor, VS Code, Cline, etc.) use the same `command` + `args` shape. Hosts that only speak HTTP can connect to `http://127.0.0.1:3000/mcp` directly, or bridge stdio hosts with [`mcp-remote`](https://www.npmjs.com/package/mcp-remote):

```bash
npx mcp-remote http://127.0.0.1:3000/mcp
```

## Tools

### Lifecycle and tabs

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `browser_launch` | Launch a browser or attach over CDP | `url`, `headless=false`, `cdp_endpoint`, `viewport_width=1440`, `viewport_height=900`, `engine`, `channel`, `executable_path`, `slow_mo_ms`, `record_video=false`, `record_trace=false` |
| `browser_close` | Terminate the session; finalize recordings | – |
| `tab_new` | Open a tab and make it active | `url` (optional) |
| `tab_switch` | Focus an existing tab | `tab_id` |
| `tab_close` | Close one tab | `tab_id` |
| `tab_list` | List tabs with id, title, URL, active flag | – |

`browser_launch` attaches to an existing Chromium when `cdp_endpoint` is set (`ws://`, `wss://`, `http://`, or `https://`). Attached sessions are detached on `browser_close`; the external browser and its tabs are left running.

### Navigation

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `navigate_to` | Navigate the active tab | `url`, `wait_until="load"`, `timeout_ms=30000` |
| `page_reload` | Reload; optionally bypass cache | `ignore_cache=false` (cache bypass is Chromium-only) |
| `page_history` | Go back or forward | `action="back" \| "forward"` |

### Perception

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `capture_viewport` | Screenshot as an MCP image block | `full_page=false`, `quality=80`, `format="jpeg"` |
| `get_dom_tree` | Readable Markdown or ARIA snapshot | `selector="body"`, `format="markdown" \| "aria"`, `max_chars=20000` |
| `get_element_details` | Text, attributes, value, visibility, box, HTML | `selector` |
| `wait_for_element` | Wait for visible/hidden/attached | `selector`, `state="visible"`, `timeout_ms=10000` |

### Interaction

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `click_element` | Click the first match | `selector`, `button="left"`, `click_count=1` |
| `type_text` | Type into inputs/contenteditable | `selector`, `text`, `clear_first=false`, `press_enter=false` |
| `press_key` | Press a key or shortcut | `key_or_combo` (e.g. `Enter`, `Control+A`) |
| `scroll_page` | Wheel-scroll the viewport | `direction="up" \| "down"`, `amount_px=500` |
| `select_dropdown` | Select a `<select>` option | `selector`, `value` |
| `upload_file` | Set files on a file input | `selector`, `file_paths` |

### Execution and diagnostics

| Tool | Purpose | Key parameters |
| --- | --- | --- |
| `execute_javascript` | Evaluate JS in page context | `script` (expression or statement body, top-level `await` supported) |
| `get_console_errors` | Read captured errors/exceptions | `tab_id` (optional, defaults to active), `limit=100`, `clear=false` |

All tools return JSON text except `capture_viewport`, which returns a base64 `image/jpeg` or `image/png` content block. Failures return `isError: true` with a message and a recovery hint.

## Typical model workflow

1. `browser_launch` with `headless: true` and a starting URL.
2. `get_dom_tree` (cheap, text) or `capture_viewport` (visual) to inspect.
3. `get_element_details` to confirm selectors.
4. `click_element`, `type_text`, `press_key`, `scroll_page`, `select_dropdown`, `upload_file`.
5. Verify the result, then `get_console_errors` if something failed.
6. Reuse tabs with `tab_list` / `tab_switch`; call `browser_close` when finished.

## HTTP transport

```bash
node dist/server.js --transport http --host 127.0.0.1 --port 3000 --path /mcp
```

Endpoints:

- `POST/GET/DELETE /mcp` — MCP Streamable HTTP (stateful sessions; `Mcp-Session-Id` header)
- `GET /sse` + `POST /messages?sessionId=...` — deprecated SSE transport (disable with `--no-legacy-sse`)
- `GET /healthz` — unauthenticated liveness probe

Authentication: set `MCP_HTTP_TOKEN` to require `Authorization: Bearer <token>` on every endpoint except `/healthz`. The legacy SSE endpoint also accepts `?token=<token>` because `EventSource` cannot set headers.

```bash
MCP_HTTP_TOKEN=change-me node dist/server.js --transport http --port 3000
```

The server binds `127.0.0.1` by default. Binding to `0.0.0.0` logs a warning; always set a token before exposing it.

## CDP attachment

Start Chrome with remote debugging on a dedicated profile (Chrome 136+ ignores the debugging port on the default profile):

```bash
chrome --remote-debugging-port=9222 --user-data-dir=/tmp/gemini-chrome-profile
```

Then call `browser_launch` with `"cdp_endpoint": "http://127.0.0.1:9222"`. CDP attachment is Chromium-only. Viewport parameters and video recording do not apply to pre-existing contexts; trace recording only captures pages driven by this server.

## Recordings

Enable at launch with `record_video: true` and/or `record_trace: true`.

- Videos are saved as `.recordings/videos/<tab_id>.webm` when a tab closes.
- Raw Playwright artifacts are kept in `.recordings/.raw-videos` and removed on shutdown.
- Traces are saved as `.recordings/trace-<timestamp>.zip` when the browser closes.
- Override the directory with `BROWSER_RECORDINGS_DIR`.

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `MCP_TRANSPORT` | `stdio` | `stdio` or `http` |
| `MCP_HTTP_HOST` | `127.0.0.1` | HTTP bind address |
| `MCP_HTTP_PORT` | `3000` | HTTP port |
| `MCP_HTTP_PATH` | `/mcp` | Streamable HTTP path |
| `MCP_HTTP_TOKEN` | unset | Require a bearer token |
| `MCP_CORS_ORIGIN` | unset | Allowed CORS origin (`*` allowed) |
| `MCP_LEGACY_SSE` | `true` | Serve legacy `/sse` and `/messages` |
| `BROWSER_RECORDINGS_DIR` | `./.recordings` | Video and trace output |
| `LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error`, `silent` (logs go to stderr) |

CLI flags: `--transport`, `--host`, `--port`, `--path`, `--no-legacy-sse`, `--cors-origin`, `--version`, `--help`.

## Security notes

This server grants powerful capabilities by design:

- `execute_javascript` runs arbitrary code in page context.
- `upload_file` reads local files into web pages.
- Page content can contain prompt injection; treat model-driven purchases, form submissions, and data entry as untrusted until verified.
- A CDP endpoint or an unauthenticated HTTP port gives full control of the browser. Keep the HTTP server on localhost or behind a token and trusted network.
- The server logs to stderr only; stdout is reserved for the MCP protocol.

## Architecture

```
MCP host
   │  stdio | Streamable HTTP | SSE
   ▼
src/server.ts  ──  transports/http.ts
   │
   ▼
src/tools/{lifecycle,navigation,perception,interaction,execution}.ts
   │  Zod schemas + error-safe handlers
   ▼
src/browser-manager.ts
   │  BrowserManager singleton: browser, contexts, tab registry, recordings
   ▼
Playwright ──► Chromium | Firefox | WebKit | external Chrome over CDP
```

### Project layout

```
src/
  server.ts              MCP server, CLI, stdio/HTTP startup, shutdown hooks
  browser-manager.ts     Playwright orchestration, tabs, recording, teardown
  transports/http.ts     Streamable HTTP, legacy SSE, auth, CORS
  tools/                 Modular tool definitions and Zod schemas
  errors.ts              Error normalization and recovery hints
  result.ts              MCP content result helpers
  logger.ts              stderr-only structured logger
  url-utils.ts           URL/CDP endpoint validation
scripts/smoke-test.mjs   End-to-end test across all tool categories
claude_desktop_config.json
```

## Development

```bash
npm run typecheck
npm run build
npm run smoke                       # uses bundled Chromium if installed
SMOKE_CHANNEL=chrome npm run smoke  # or an installed Chrome/Edge
npm run dev                         # run TypeScript directly with tsx
```

## Troubleshooting

- **"Executable doesn't exist"** — run `npx playwright install chromium` (or the selected engine), or pass `channel: "chrome"` / `executable_path`.
- **Headless launch fails on Linux** — install OS dependencies with `npx playwright install --with-deps chromium`.
- **Navigation or selector timeouts** — raise `timeout_ms`, verify the selector with `get_dom_tree`, and prefer `wait_until: "domcontentloaded"` on network-heavy pages.
- **`ignore_cache` did not bypass the cache** — it is only supported on Chromium; the response reports `cache_bypassed` and a notice for other engines.
- **HTTP 401** — send `Authorization: Bearer <MCP_HTTP_TOKEN>`.
- **Tab id unknown** — call `tab_list`; ids change when the browser session is relaunched.
- **Headed launch does nothing on a remote server** — there is no display; use `headless: true`.

## Limitations

- One browser session is active per server process; all HTTP sessions share it.
- Selectors target the main frame only (frames can be inspected via `execute_javascript`).
- Downloads are not exposed as a dedicated tool; observe them with page JavaScript.
- Browser permission prompts are not automated.
