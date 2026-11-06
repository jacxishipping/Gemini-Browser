import { randomBytes } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { chromium, firefox, webkit } from 'playwright';
import type {
  Browser,
  BrowserContext,
  BrowserType,
  ConsoleMessage,
  Page
} from 'playwright';
import { ToolError } from './errors.js';
import { logger } from './logger.js';
import { assertNavigableUrl } from './url-utils.js';

export const BROWSER_ENGINES = ['chromium', 'firefox', 'webkit'] as const;
export type BrowserEngine = (typeof BROWSER_ENGINES)[number];
export type WaitUntil = 'load' | 'domcontentloaded' | 'networkidle';

/**
 * Headed browsers cannot start on a Linux host without a display (typical servers), so fall back to\n * headless there. Set BROWSER_FORCE_HEADLESS=true to force headless anywhere.\n */
function effectiveHeadless(requested: boolean): boolean {
  if (requested || process.env.BROWSER_FORCE_HEADLESS?.toLowerCase() === 'true') {
    return true;
  }
  return process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY;
}

const ENGINE_TYPES: Record<BrowserEngine, BrowserType> = {
  chromium,
  firefox,
  webkit
};

const MAX_CONSOLE_ENTRIES_PER_TAB = 250;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 30_000;

export interface LaunchRequest {
  url?: string;
  headless: boolean;
  cdpEndpoint?: string;
  viewportWidth: number;
  viewportHeight: number;
  engine?: BrowserEngine;
  channel?: string;
  executablePath?: string;
  slowMoMs?: number;
  recordVideo?: boolean;
  recordTrace?: boolean;
}

export interface TabInfo {
  tabId: string;
  title: string;
  url: string;
  active: boolean;
  closed: boolean;
  videoPath?: string;
}

export interface TabHandle {
  id: string;
  page: Page;
  context: BrowserContext;
}

export type ConsoleErrorType = 'console_error' | 'page_error' | 'crash';

export interface ConsoleErrorEntry {
  timestamp: string;
  type: ConsoleErrorType;
  text: string;
  location?: string;
  stack?: string;
  pageUrl: string;
}

export interface ConsoleErrorReport {
  tabId: string;
  url: string;
  count: number;
  errors: ConsoleErrorEntry[];
}

export interface DesignatedRecordings {
  directory: string;
  video: boolean;
  trace: boolean;
}

export interface LaunchResult {
  engine: BrowserEngine;
  headless: boolean;
  attachedOverCdp: boolean;
  viewport: { width: number; height: number } | null;
  activeTabId: string | null;
  tabs: TabInfo[];
  recordings: DesignatedRecordings;
  warnings: string[];
}

export interface CloseResult {
  status: 'closed' | 'not_running';
  closedTabs: number;
  savedVideos: string[];
  savedTrace?: string;
  detached: boolean;
}

export interface CloseTabResult {
  closedTabId: string;
  activeTabId: string | null;
  remainingTabs: number;
}

interface TabRecord {
  id: string;
  page: Page;
  context: BrowserContext;
  createdAt: number;
  consoleEntries: ConsoleErrorEntry[];
  videoPath?: string;
  finalizePromise?: Promise<void>;
}

function evenDimension(value: number): number {
  return Math.max(2, value % 2 === 0 ? value : value - 1);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function timestampSlug(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

/**
 * Owns the Playwright browser, its contexts, and a registry of tabs that can be
 * addressed by stable ids. A single instance is shared by all MCP sessions.
 */
export class BrowserManager {
  private browser?: Browser;
  private primaryContext?: BrowserContext;
  private readonly contexts = new Set<BrowserContext>();
  private readonly tabs = new Map<string, TabRecord>();
  private readonly pageTabIds = new Map<Page, string>();
  private activeTabId?: string;

  private engine: BrowserEngine = 'chromium';
  private attached = false;
  private videoEnabled = false;
  private traceEnabled = false;
  private traceStarted = false;
  private closing = false;

  private launching?: Promise<LaunchResult>;
  private closePromise?: Promise<CloseResult>;

  private readonly recordingsDir = path.resolve(
    process.env.BROWSER_RECORDINGS_DIR?.trim() || path.join(process.cwd(), '.recordings')
  );
  private readonly videosDir = path.join(this.recordingsDir, 'videos');
  private readonly rawVideosDir = path.join(this.recordingsDir, '.raw-videos');

  get isRunning(): boolean {
    return this.browser !== undefined;
  }

  get activeTab(): string | undefined {
    return this.activeTabId;
  }

  getRecordingsInfo(): DesignatedRecordings {
    return {
      directory: this.recordingsDir,
      video: this.videoEnabled,
      trace: this.traceEnabled
    };
  }

  async launch(request: LaunchRequest): Promise<LaunchResult> {
    if (this.browser) {
      throw new ToolError(
        'A browser session is already active.',
        'Call browser_close first, or continue with tab_new / tab_list on the existing session.'
      );
    }
    if (this.launching) {
      throw new ToolError('The browser is already starting.', 'Retry once the launch call completes.');
    }

    const run = this.doLaunch(request);
    this.launching = run;
    try {
      return await run;
    } finally {
      this.launching = undefined;
    }
  }

  private async doLaunch(request: LaunchRequest): Promise<LaunchResult> {
    const warnings: string[] = [];
    const engine: BrowserEngine = request.cdpEndpoint ? 'chromium' : request.engine ?? 'chromium';
    const attached = Boolean(request.cdpEndpoint);

    if (engine !== 'chromium' && request.channel) {
      throw new ToolError('The channel option is only supported by the chromium engine.');
    }
    if (engine !== 'chromium' && attached) {
      throw new ToolError('CDP attachment is only supported by the chromium engine.');
    }

    this.engine = engine;
    this.attached = attached;
    this.videoEnabled = Boolean(request.recordVideo) && !attached;
    this.traceEnabled = Boolean(request.recordTrace);

    if (request.recordVideo && attached) {
      warnings.push('Video recording is not available for CDP-attached browsers; existing pages cannot be recorded.');
    }
    if (request.recordTrace && attached) {
      warnings.push('Trace recording on a CDP-attached browser captures only pages driven through this server.');
    }
    if (attached) {
      warnings.push('CDP-attached browsers keep their existing context and viewport; viewport parameters are not applied.');
    }

    try {
      if (this.videoEnabled) {
        await rm(this.rawVideosDir, { recursive: true, force: true });
        await mkdir(this.videosDir, { recursive: true });
      }
      if (this.traceEnabled) {
        await mkdir(this.recordingsDir, { recursive: true });
      }

      let browser: Browser;
      let context: BrowserContext;

      if (request.cdpEndpoint) {
        browser = await chromium.connectOverCDP(request.cdpEndpoint, { timeout: 60_000 });
        this.browser = browser;
        browser.on('disconnected', () => {
          this.handleUnexpectedDisconnect(browser);
        });

        for (const existing of browser.contexts()) {
          this.trackContext(existing);
        }

        const existingContext = browser.contexts()[0];
        if (existingContext) {
          context = existingContext;
        } else {
          context = await browser.newContext({
            viewport: {
              width: request.viewportWidth,
              height: request.viewportHeight
            },
            acceptDownloads: true
          });
          this.trackContext(context);
        }
      } else {
        browser = await ENGINE_TYPES[engine].launch({
          headless: effectiveHeadless(request.headless),
          timeout: 60_000,
          ...(request.channel ? { channel: request.channel } : {}),
          ...(request.executablePath ? { executablePath: request.executablePath } : {}),
          ...(request.slowMoMs ? { slowMo: request.slowMoMs } : {})
        });
        this.browser = browser;
        browser.on('disconnected', () => {
          this.handleUnexpectedDisconnect(browser);
        });

        context = await browser.newContext({
          viewport: {
            width: request.viewportWidth,
            height: request.viewportHeight
          },
          acceptDownloads: true,
          ...(this.videoEnabled
            ? {
                recordVideo: {
                  dir: this.rawVideosDir,
                  size: {
                    width: evenDimension(request.viewportWidth),
                    height: evenDimension(request.viewportHeight)
                  }
                }
              }
            : {})
        });
        this.trackContext(context);
      }

      this.primaryContext = context;

      context.setDefaultTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);
      context.setDefaultNavigationTimeout(DEFAULT_NAVIGATION_TIMEOUT_MS);

      if (this.traceEnabled) {
        try {
          await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
          this.traceStarted = true;
        } catch (error) {
          this.traceEnabled = false;
          warnings.push(`Trace recording could not be started: ${errorMessage(error)}`);
          logger.warn('Failed to start trace recording', { error: errorMessage(error) });
        }
      }

      for (const existing of context.pages()) {
        this.registerPage(existing, false);
      }

      if (this.tabs.size === 0) {
        await context.newPage();
      }
      if (this.activeTabId === undefined) {
        const firstTabId = this.tabs.keys().next().value;
        if (firstTabId) {
          this.activeTabId = firstTabId;
        }
      }

      if (request.url) {
        const target = assertNavigableUrl(request.url);
        const handle = this.getTabHandle();
        try {
          await handle.page.goto(target, {
            waitUntil: 'load',
            timeout: DEFAULT_NAVIGATION_TIMEOUT_MS
          });
        } catch (error) {
          warnings.push(`Initial navigation to ${target} failed: ${errorMessage(error)}`);
          logger.warn('Initial navigation failed', { url: target, error: errorMessage(error) });
        }
      }

      const tabs = await this.listTabs();
      return {
        engine,
        headless: attached ? false : effectiveHeadless(request.headless),
        attachedOverCdp: attached,
        viewport: attached ? null : { width: request.viewportWidth, height: request.viewportHeight },
        activeTabId: this.activeTabId ?? null,
        tabs,
        recordings: this.getRecordingsInfo(),
        warnings
      };
    } catch (error) {
      logger.error('Browser launch failed', { error: errorMessage(error) });
      await this.closeAfterFailedLaunch();
      throw error;
    }
  }

  private trackContext(context: BrowserContext): void {
    if (this.contexts.has(context)) {
      return;
    }
    this.contexts.add(context);
    context.on('page', (page) => {
      try {
        this.registerPage(page, true);
      } catch (error) {
        logger.error('Failed to register new page', { error: errorMessage(error) });
      }
    });
    context.on('close', () => {
      this.contexts.delete(context);
    });
  }

  private registerPage(page: Page, makeActive: boolean): string {
    const existingId = this.pageTabIds.get(page);
    if (existingId) {
      if (makeActive) {
        this.setActive(existingId);
      }
      return existingId;
    }

    const id = this.generateTabId();
    const tab: TabRecord = {
      id,
      page,
      context: page.context(),
      createdAt: Date.now(),
      consoleEntries: []
    };

    this.tabs.set(id, tab);
    this.pageTabIds.set(page, id);

    page.on('console', (message) => {
      this.recordConsoleMessage(tab, message);
    });
    page.on('pageerror', (error) => {
      this.addConsoleEntry(tab, {
        timestamp: new Date().toISOString(),
        type: 'page_error',
        text: error.message,
        ...(error.stack ? { stack: error.stack } : {}),
        pageUrl: this.safePageUrl(page)
      });
    });
    page.on('crash', () => {
      this.addConsoleEntry(tab, {
        timestamp: new Date().toISOString(),
        type: 'crash',
        text: 'Page crashed',
        pageUrl: this.safePageUrl(page)
      });
    });
    page.once('close', () => {
      void this.finalizeTab(tab).catch((error) => {
        logger.error('Failed to finalize closed tab', {
          tabId: tab.id,
          error: errorMessage(error)
        });
      });
    });

    if (makeActive) {
      this.setActive(id);
    } else if (this.activeTabId === undefined) {
      this.activeTabId = id;
    }

    logger.debug('Registered tab', { tabId: id, url: this.safePageUrl(page) });
    return id;
  }

  private recordConsoleMessage(tab: TabRecord, message: ConsoleMessage): void {
    if (message.type() !== 'error') {
      return;
    }
    const location = message.location();
    this.addConsoleEntry(tab, {
      timestamp: new Date().toISOString(),
      type: 'console_error',
      text: message.text(),
      ...(location.url
        ? { location: `${location.url}:${location.lineNumber}:${location.columnNumber}` }
        : {}),
      pageUrl: this.safePageUrl(tab.page)
    });
  }

  private addConsoleEntry(tab: TabRecord, entry: ConsoleErrorEntry): void {
    if (tab.consoleEntries.length >= MAX_CONSOLE_ENTRIES_PER_TAB) {
      tab.consoleEntries.shift();
    }
    tab.consoleEntries.push(entry);
  }

  private safePageUrl(page: Page): string {
    try {
      return page.url();
    } catch {
      return 'about:blank';
    }
  }

  private generateTabId(): string {
    for (;;) {
      const id = `tab-${randomBytes(4).toString('hex')}`;
      if (!this.tabs.has(id)) {
        return id;
      }
    }
  }

  private setActive(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab || tab.page.isClosed()) {
      return;
    }
    this.activeTabId = tabId;
  }

  private requireBrowser(): Browser {
    if (!this.browser) {
      throw new ToolError(
        'No browser session is active.',
        'Call browser_launch before using browser tools.'
      );
    }
    return this.browser;
  }

  private requireTab(tabId?: string): TabRecord {
    this.requireBrowser();
    const id = tabId ?? this.activeTabId;
    if (!id) {
      throw new ToolError('No active tab.', 'Call tab_new to open a tab, then retry.');
    }
    const tab = this.tabs.get(id);
    if (!tab) {
      throw new ToolError(
        `Unknown tab_id "${id}".`,
        'Call tab_list to see the currently open tabs.'
      );
    }
    if (tab.page.isClosed()) {
      throw new ToolError(
        `Tab "${id}" is already closed.`,
        'Call tab_list to find an open tab, or tab_new to open a new one.'
      );
    }
    return tab;
  }

  getTabHandle(tabId?: string): TabHandle {
    const tab = this.requireTab(tabId);
    return { id: tab.id, page: tab.page, context: tab.context };
  }

  getActiveTabHandle(): TabHandle {
    return this.getTabHandle();
  }

  async newTab(url?: string): Promise<TabInfo> {
    this.requireBrowser();
    const context = this.primaryContext ?? this.browser?.contexts()[0];
    if (!context) {
      throw new ToolError(
        'The browser has no usable context.',
        'Call browser_close and browser_launch again to recreate the session.'
      );
    }

    const page = await context.newPage();
    const tabId = this.pageTabIds.get(page) ?? this.registerPage(page, true);
    this.setActive(tabId);
    await page.bringToFront().catch(() => undefined);

    if (url) {
      const target = assertNavigableUrl(url);
      try {
        await page.goto(target, {
          waitUntil: 'load',
          timeout: DEFAULT_NAVIGATION_TIMEOUT_MS
        });
      } catch (error) {
        await page.close({ runBeforeUnload: false }).catch(() => undefined);
        throw error;
      }
    }

    return this.getTabInfo(tabId);
  }

  async switchTab(tabId: string): Promise<TabInfo> {
    const tab = this.requireTab(tabId);
    await tab.page.bringToFront();
    this.setActive(tab.id);
    return this.getTabInfo(tab.id);
  }

  async closeTab(tabId: string): Promise<CloseTabResult> {
    const tab = this.requireTab(tabId);
    if (!tab.page.isClosed()) {
      await tab.page.close({ runBeforeUnload: false }).catch(() => undefined);
    }
    await this.finalizeTab(tab);
    return {
      closedTabId: tab.id,
      activeTabId: this.activeTabId ?? null,
      remainingTabs: this.tabs.size
    };
  }

  private finalizeTab(tab: TabRecord): Promise<void> {
    if (!tab.finalizePromise) {
      tab.finalizePromise = this.doFinalizeTab(tab);
    }
    return tab.finalizePromise;
  }

  private async doFinalizeTab(tab: TabRecord): Promise<void> {
    if (this.pageTabIds.get(tab.page) === tab.id) {
      this.pageTabIds.delete(tab.page);
    }
    if (this.tabs.get(tab.id) === tab) {
      this.tabs.delete(tab.id);
    }

    await this.saveTabVideo(tab);

    if (this.activeTabId === tab.id) {
      this.activeTabId = undefined;
      const remaining = [...this.tabs.values()].filter((candidate) => !candidate.page.isClosed());
      const next = remaining[remaining.length - 1];
      if (next) {
        this.activeTabId = next.id;
        await next.page.bringToFront().catch(() => undefined);
      }
    }
  }

  private async saveTabVideo(tab: TabRecord): Promise<void> {
    if (!this.videoEnabled) {
      return;
    }
    const video = tab.page.video();
    if (!video) {
      return;
    }

    try {
      await mkdir(this.videosDir, { recursive: true });
      const target = path.join(this.videosDir, `${tab.id}.webm`);
      await video.saveAs(target);
      tab.videoPath = target;
      logger.info('Saved tab video', { tabId: tab.id, path: target });
    } catch (error) {
      logger.warn('Failed to save tab video', { tabId: tab.id, error: errorMessage(error) });
    }
  }

  async getTabInfo(tabId: string): Promise<TabInfo> {
    const tab = this.requireTab(tabId);
    return this.toTabInfo(tab);
  }

  private async toTabInfo(tab: TabRecord): Promise<TabInfo> {
    let title = '';
    try {
      title = await tab.page.title();
    } catch {
      title = '';
    }
    return {
      tabId: tab.id,
      title,
      url: this.safePageUrl(tab.page),
      active: tab.id === this.activeTabId,
      closed: tab.page.isClosed(),
      ...(tab.videoPath ? { videoPath: tab.videoPath } : {})
    };
  }

  async listTabs(): Promise<TabInfo[]> {
    this.requireBrowser();
    const records = [...this.tabs.values()].sort((left, right) => left.createdAt - right.createdAt);
    return Promise.all(records.map((tab) => this.toTabInfo(tab)));
  }

  getConsoleErrors(tabId?: string, limit = 100, clear = false): ConsoleErrorReport {
    const tab = this.requireTab(tabId);
    const errors = tab.consoleEntries.slice(-limit);
    if (clear) {
      tab.consoleEntries.length = 0;
    }
    return {
      tabId: tab.id,
      url: this.safePageUrl(tab.page),
      count: errors.length,
      errors
    };
  }

  async close(): Promise<CloseResult> {
    if (!this.closePromise) {
      this.closePromise = this.doClose();
    }
    try {
      return await this.closePromise;
    } finally {
      this.closePromise = undefined;
    }
  }

  private async doClose(): Promise<CloseResult> {
    if (this.launching) {
      await this.launching.catch(() => undefined);
    }

    const browser = this.browser;
    if (!browser) {
      this.resetSessionState();
      return {
        status: 'not_running',
        closedTabs: 0,
        savedVideos: [],
        detached: false
      };
    }

    this.closing = true;
    const attached = this.attached;
    const savedTrace = await this.stopTraceSafely();
    const savedVideos: string[] = [];
    const trackedTabs = this.tabs.size;
    const closedTabs = attached ? 0 : trackedTabs;

    try {
      if (!attached) {
        for (const tab of [...this.tabs.values()]) {
          if (!tab.page.isClosed()) {
            try {
              await tab.page.close({ runBeforeUnload: false });
            } catch (error) {
              logger.warn('Failed to close tab cleanly', {
                tabId: tab.id,
                error: errorMessage(error)
              });
            }
          }
          await this.finalizeTab(tab);
          if (tab.videoPath) {
            savedVideos.push(tab.videoPath);
          }
        }

        for (const context of this.contexts) {
          try {
            await context.close();
          } catch (error) {
            logger.warn('Failed to close browser context', { error: errorMessage(error) });
          }
        }
      } else {
        // Detaching must leave the externally managed browser and its tabs open.
        logger.info('Detaching from CDP-attached browser', { tabs: trackedTabs });
      }
    } finally {
      try {
        // For CDP-attached browsers Playwright only closes the CDP transport.
        await browser.close();
      } catch (error) {
        logger.warn('Failed to close browser cleanly', { error: errorMessage(error) });
      }

      if (this.videoEnabled) {
        await rm(this.rawVideosDir, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 200
        }).catch((error: unknown) => {
          logger.warn('Failed to remove raw video artifacts', { error: errorMessage(error) });
        });
      }

      this.resetSessionState();
    }

    logger.info('Browser session closed', {
      closedTabs,
      savedVideos: savedVideos.length,
      savedTrace: savedTrace ?? null,
      attached
    });

    return {
      status: 'closed',
      closedTabs,
      savedVideos,
      ...(savedTrace ? { savedTrace } : {}),
      detached: attached
    };
  }

  private async stopTraceSafely(): Promise<string | undefined> {
    if (!this.traceStarted || !this.primaryContext) {
      return undefined;
    }
    this.traceStarted = false;

    try {
      await mkdir(this.recordingsDir, { recursive: true });
      const target = path.join(this.recordingsDir, `trace-${timestampSlug()}.zip`);
      await this.primaryContext.tracing.stop({ path: target });
      logger.info('Saved trace recording', { path: target });
      return target;
    } catch (error) {
      logger.warn('Failed to save trace recording', { error: errorMessage(error) });
      return undefined;
    }
  }

  private handleUnexpectedDisconnect(browser: Browser): void {
    if (this.browser !== browser || this.closing) {
      return;
    }
    logger.warn('Browser disconnected unexpectedly');
    this.resetSessionState();
  }

  private async closeAfterFailedLaunch(): Promise<void> {
    const browser = this.browser;
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Already gone; nothing else to release.
      }
    }
    this.resetSessionState();
  }

  private resetSessionState(): void {
    this.browser = undefined;
    this.primaryContext = undefined;
    this.contexts.clear();
    this.tabs.clear();
    this.pageTabIds.clear();
    this.activeTabId = undefined;
    this.attached = false;
    this.videoEnabled = false;
    this.traceEnabled = false;
    this.traceStarted = false;
    this.closing = false;
  }

  /**
   * Idempotent teardown used by signal handlers and the HTTP server.
   */
  async shutdown(): Promise<void> {
    try {
      await this.close();
    } catch (error) {
      logger.error('Error during browser shutdown', { error: errorMessage(error) });
    }
  }
}
