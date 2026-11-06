/**
 * End-to-end smoke test: starts a local web page, spawns the MCP server over
 * stdio, and exercises every tool category with a real (headless) browser.
 *
 * Usage: npm run smoke
 * Set SMOKE_CHANNEL=chrome|msedge to use an installed browser channel. When
 * unset, Playwright's bundled Chromium is used (run `npm run install-browsers`).
 */
import assert from 'node:assert/strict';
import { access, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serverEntry = path.join(projectRoot, 'dist', 'server.js');

const mainPage = `<!doctype html>
<html>
  <head><title>Smoke Test Page</title></head>
  <body>
    <h1 id="title">Browser MCP Smoke Test</h1>
    <p>Welcome to the <a id="next" href="/second">second page</a>.</p>
    <label for="name">Name</label>
    <input id="name" name="name" placeholder="Your name" />
    <select id="color" name="color">
      <option value="red">Red</option>
      <option value="green">Green</option>
    </select>
    <button
      id="btn"
      onclick="document.getElementById('result').textContent='clicked:'+document.getElementById('name').value; console.error('boom');"
    >Click me</button>
    <div id="result"></div>
    <input id="file" type="file" />
    <div style="height: 1600px"></div>
    <div id="bottom">Bottom of page</div>
    <script>console.warn('this warning should not be captured');</script>
  </body>
</html>`;

const secondPage = `<!doctype html>
<html><head><title>Second Page</title></head><body><h1>Second page</h1></body></html>`;

function parseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const pageServer = createServer((req, res) => {
  if (req.url === '/second') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(secondPage);
    return;
  }
  if (req.url === '/favicon.ico') {
    res.writeHead(204);
    res.end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(mainPage);
});

await new Promise((resolve) => pageServer.listen(0, '127.0.0.1', resolve));
const port = pageServer.address().port;
const baseUrl = `http://127.0.0.1:${port}/`;
const secondUrl = `http://127.0.0.1:${port}/second`;

const tempDir = await mkdtemp(path.join(os.tmpdir(), 'gemini-browser-smoke-'));
const recordingsDir = path.join(tempDir, 'recordings');
const uploadPath = path.join(tempDir, 'upload-me.txt');
await writeFile(uploadPath, 'hello from the smoke test');

const env = {
  ...process.env,
  LOG_LEVEL: process.env.LOG_LEVEL ?? 'warn',
  BROWSER_RECORDINGS_DIR: recordingsDir
};

const client = new Client({ name: 'gemini-browser-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [serverEntry],
  cwd: projectRoot,
  env,
  stderr: 'inherit'
});

let stepNumber = 0;
async function step(name, fn) {
  stepNumber += 1;
  process.stdout.write(`\n[${String(stepNumber).padStart(2, '0')}] ${name}\n`);
  return fn();
}

async function callTool(name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content?.find((block) => block.type === 'text')?.text ?? '';
  return { result, text, json: parseJson(text) };
}

async function expectOk(name, args = {}) {
  const outcome = await callTool(name, args);
  if (outcome.result.isError) {
    throw new Error(`${name} returned an error:\n${outcome.text}`);
  }
  process.stdout.write(`     ok: ${name}\n`);
  return outcome;
}

try {
  await client.connect(transport);

  await step('listTools exposes all 21 tools', async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name).sort();
    const expected = [
      'browser_close',
      'browser_launch',
      'capture_viewport',
      'click_element',
      'execute_javascript',
      'get_console_errors',
      'get_dom_tree',
      'get_element_details',
      'navigate_to',
      'page_history',
      'page_reload',
      'press_key',
      'scroll_page',
      'select_dropdown',
      'tab_close',
      'tab_list',
      'tab_new',
      'tab_switch',
      'type_text',
      'upload_file',
      'wait_for_element'
    ].sort();
    assert.deepEqual(names, expected);
    assert.ok(tools.every((tool) => tool.description && tool.inputSchema));
    process.stdout.write(`     ok: ${tools.length} tools registered\n`);
  });

  let activeTabId;
  await step('browser_launch (Chrome channel, headless, video + trace)', async () => {
    const launchArgs = {
      url: baseUrl,
      headless: true,
      viewport_width: 1280,
      viewport_height: 720,
      record_video: true,
      record_trace: true,
      ...(process.env.SMOKE_CHANNEL ? { channel: process.env.SMOKE_CHANNEL } : {})
    };
    const { json } = await expectOk('browser_launch', launchArgs);
    assert.equal(json.status, 'launched');
    assert.equal(json.engine, 'chromium');
    assert.equal(json.tabs.length, 1);
    assert.match(json.tabs[0].url, /^http:\/\/127\.0\.0\.1:/);
    assert.equal(json.recordings.video, true);
    assert.equal(json.recordings.trace, true);
    activeTabId = json.active_tab_id;
    assert.ok(activeTabId);
  });

  await step('get_dom_tree returns readable Markdown', async () => {
    const { text } = await expectOk('get_dom_tree', { selector: 'body' });
    assert.match(text, /Browser MCP Smoke Test/);
    assert.match(text, /second page/);
    assert.match(text, /\[button: Click me\]/);
    assert.match(text, /placeholder="Your name"/);
  });

  await step('get_dom_tree aria mode', async () => {
    const { text } = await expectOk('get_dom_tree', { selector: 'body', format: 'aria' });
    assert.match(text, /heading/);
  });

  await step('get_element_details', async () => {
    const { json } = await expectOk('get_element_details', { selector: '#title' });
    assert.equal(json.tag, 'h1');
    assert.match(json.text, /Smoke Test/);
    assert.ok(json.bounding_box.width > 0);
    assert.equal(json.match_count, 1);
  });

  await step('type_text + select_dropdown', async () => {
    const typed = await expectOk('type_text', {
      selector: '#name',
      text: 'Grace Hopper',
      clear_first: true
    });
    assert.equal(typed.json.value, 'Grace Hopper');

    const selected = await expectOk('select_dropdown', {
      selector: '#color',
      value: 'green'
    });
    assert.deepEqual(selected.json.selected_values, ['green']);
  });

  await step('click_element + wait_for_element + console errors', async () => {
    await expectOk('click_element', { selector: '#btn' });
    await expectOk('wait_for_element', { selector: '#result', state: 'visible' });
    const details = await expectOk('get_element_details', { selector: '#result' });
    assert.match(details.json.text, /clicked:Grace Hopper/);

    const errors = await expectOk('get_console_errors', {});
    assert.ok(errors.json.count >= 1);
    assert.ok(errors.json.errors.some((entry) => /boom/.test(entry.text)));
    assert.ok(!errors.json.errors.some((entry) => /this warning/.test(entry.text)));
  });

  await step('execute_javascript', async () => {
    const { json } = await expectOk('execute_javascript', {
      script: `({ title: document.title, answer: 6 * 7, headings: [...document.querySelectorAll('h1')].map(h => h.textContent) })`
    });
    assert.equal(json.result.answer, 42);
    assert.equal(json.result.title, 'Smoke Test Page');
    assert.equal(json.result.headings[0], 'Browser MCP Smoke Test');

    const statement = await expectOk('execute_javascript', {
      script: `const base = await Promise.resolve(41); return { total: base + 1 };`
    });
    assert.equal(statement.json.mode, 'function_body');
    assert.equal(statement.json.result.total, 42);

    const element = await expectOk('execute_javascript', {
      script: `document.querySelector('#title')`
    });
    assert.equal(element.json.result.__type, 'Element');
    assert.equal(element.json.result.tag, 'h1');
  });

  await step('execute_javascript throws are reported by the tool', async () => {
    const { result, text } = await callTool('execute_javascript', {
      script: `throw new Error('intentional smoke failure')`
    });
    assert.equal(result.isError, true);
    assert.match(text, /intentional smoke failure/);
    process.stdout.write('     ok: error surfaced\n');
  });

  await step('capture_viewport returns an image block', async () => {
    const outcome = await callTool('capture_viewport', { full_page: false, quality: 70 });
    const image = outcome.result.content?.find((block) => block.type === 'image');
    assert.ok(image, 'expected an image content block');
    assert.equal(image.mimeType, 'image/jpeg');
    assert.ok(image.data.length > 1000);
    assert.ok(!outcome.result.isError);
    process.stdout.write(`     ok: ${image.data.length} base64 chars\n`);
  });

  await step('scroll_page moves the viewport', async () => {
    const { json } = await expectOk('scroll_page', { direction: 'down', amount_px: 700 });
    assert.ok(json.scroll_y > 0);
  });

  await step('navigate_to + page_history + page_reload', async () => {
    const navigated = await expectOk('navigate_to', { url: secondUrl, wait_until: 'load' });
    assert.equal(navigated.json.title, 'Second Page');

    const back = await expectOk('page_history', { action: 'back' });
    assert.equal(back.json.navigated, true);
    assert.equal(back.json.title, 'Smoke Test Page');

    const reload = await expectOk('page_reload', { ignore_cache: true });
    assert.equal(reload.json.cache_bypassed, true);
  });

  await step('tabs: new, list, switch, close', async () => {
    const created = await callTool('tab_new', { url: secondUrl });
    assert.ok(!created.result.isError, created.text);
    const secondTabId = created.json.tab_id;
    assert.notEqual(secondTabId, activeTabId);

    const listed = await callTool('tab_list', {});
    assert.equal(listed.json.count, 2);
    assert.equal(listed.json.active_tab_id, secondTabId);

    await expectOk('tab_switch', { tab_id: activeTabId });
    await expectOk('tab_close', { tab_id: secondTabId });

    const after = await callTool('tab_list', {});
    assert.equal(after.json.count, 1);
    assert.equal(after.json.active_tab_id, activeTabId);
  });

  await step('press_key and upload_file', async () => {
    await expectOk('type_text', { selector: '#name', text: 'Ada', clear_first: true });
    await expectOk('press_key', { key_or_combo: 'Control+A' });
    await expectOk('press_key', { key_or_combo: 'Escape' });

    const upload = await expectOk('upload_file', {
      selector: '#file',
      file_paths: [uploadPath]
    });
    assert.deepEqual(upload.json.files, ['upload-me.txt']);

    const { json } = await expectOk('execute_javascript', {
      script: `document.querySelector('#file').files[0]?.name ?? null`
    });
    assert.equal(json.result, 'upload-me.txt');
  });

  await step('unknown selector returns a structured tool error', async () => {
    const { result, text } = await callTool('get_element_details', {
      selector: '#definitely-missing'
    });
    assert.equal(result.isError, true);
    assert.match(text, /Timeout|selector/i);
    process.stdout.write('     ok: tool error has isError=true\n');
  });

  await step('browser_close finalizes video and trace recordings', async () => {
    const { json } = await expectOk('browser_close', {});
    assert.equal(json.status, 'closed');
    assert.equal(json.detached_from_external_browser, false);
    assert.ok(json.saved_trace, 'expected a saved trace zip');
    await access(json.saved_trace);
    assert.ok(json.saved_videos.length >= 1, 'expected at least one saved video');
    for (const videoPath of json.saved_videos) {
      await access(videoPath);
    }

    const videos = (await readdir(path.join(recordingsDir, 'videos'))).filter((file) =>
      file.endsWith('.webm')
    );
    assert.ok(videos.length >= 1);
    process.stdout.write(
      `     ok: ${videos.length} video(s), trace=${path.basename(json.saved_trace)}\n`
    );
  });

  await step('browser_close is idempotent', async () => {
    const { json } = await expectOk('browser_close', {});
    assert.equal(json.status, 'not_running');
  });

  process.stdout.write('\nSmoke test passed.\n');
} finally {
  await client.close().catch(() => undefined);
  await new Promise((resolve) => pageServer.close(resolve));
  await rm(tempDir, { recursive: true, force: true });
}
