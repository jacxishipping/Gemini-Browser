---
name: remote-browser
description: Launch and drive a real headless Chromium browser running on the remote server (https://browser.jxiptvplayer.app/mcp) through the gemini-browser MCP tools. Use when the user wants to open a website, browse, take screenshots, read page content, click, type, fill forms, scrape, test a web app, or otherwise "open the browser" in Gemini.
---

# Remote Browser (gemini-browser MCP)

A Playwright/Chromium browser runs on the user's AWS server and is exposed over MCP at
`https://browser.jxiptvplayer.app/mcp` (authenticated with OAuth 2.1; the user approves once with
their passcode on the consent page). There is no visible window: **see the page with
`capture_viewport` (screenshot) or `get_dom_tree` (text)**.

## Setup check

1. The MCP server must be connected as `gemini-browser` with URL `https://browser.jxiptvplayer.app/mcp`.
   If its tools are not available or return 401, ask the user to (re)connect it and approve the
   consent page. Never ask for, print, or store the passcode/token in files.
2. Health check (no auth needed): `GET https://browser.jxiptvplayer.app/healthz` returns `{"status":"ok"}`.

## Standard workflow

1. `browser_launch` with `url` (the server forces headless; viewport defaults to 1440x900).
   Optional: `record_video`, `record_trace`, `viewport_width`/`viewport_height`.
2. Inspect: `get_dom_tree` (cheap, text) first, `capture_viewport` when layout or visuals matter.
3. Act: `click_element`, `type_text`, `press_key`, `select_dropdown`, `scroll_page`, `upload_file`.
   Use `wait_for_element` after navigation or actions that load content before the next step.
4. Verify after every meaningful action with `get_dom_tree` or `capture_viewport`.
5. Debug: `get_console_errors`, `execute_javascript`, `get_element_details`.
6. Finish with `browser_close` so recordings are finalized and resources are freed.

## Tools

| Area | Tools |
|---|---|
| Lifecycle | `browser_launch`, `browser_close` |
| Tabs | `tab_new`, `tab_switch`, `tab_close`, `tab_list` |
| Navigation | `navigate_to`, `page_reload`, `page_history` |
| Perception | `capture_viewport`, `get_dom_tree`, `get_element_details`, `wait_for_element`, `get_console_errors` |
| Interaction | `click_element`, `type_text`, `press_key`, `scroll_page`, `select_dropdown`, `upload_file` |
| Scripting | `execute_javascript` |

## Rules and tips

- Launch once per task and reuse the session; call `tab_list` to recover tab ids.
- Prefer stable selectors (role, text, `data-testid`) and re-inspect when a click fails.
- Tool errors return `isError` with a recovery hint; follow the hint instead of retrying blindly.
- The browser runs on a shared remote server: do not enter the user's personal credentials or
  submit sensitive data unless the user explicitly asks, and close the session when done.
- If `browser_launch` fails, check `/healthz`, then ask the user to inspect
  `journalctl -u gemini-browser` on the server (service name `gemini-browser`, app in `/opt/gemini-browser`).
