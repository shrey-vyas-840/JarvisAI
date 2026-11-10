import {
  connectViaExtension,
  listBrowsers,
  type ExtensionBrowser,
  type PlaywriterBrowserConnection,
  type BrowserContext,
  type Page,
} from 'playwriter';

import {
  BrowserError,
  errorMessage,
  isStaleSessionError,
  type BrowserErrorCode,
} from './errors.js';
import { RelayManager } from './relay-manager.js';
import type {
  BrowserReadiness,
  BrowserReadinessReport,
  BrowserTabInfo,
  ConnectedProfileInfo,
  RelayStatus,
} from './types.js';

export const JARVIS_TAB_GROUP_NAME = 'jarvis';

const DEFAULT_PAGE_TITLE_TIMEOUT_MS = 2000;
const DEFAULT_RELAY_READY_TIMEOUT_MS = 5000;
const CLOSE_TIMEOUT_MS = 5000;
const RETRY_DELAY_MS = 250;

interface PageMeta {
  readonly url: string;
  readonly title: string;
  readonly responsive: boolean;
  readonly titleError: string | null;
}

export interface BrowserManagerOptions {
  readonly relayPort?: number;
  readonly defaultTimeoutMs?: number;
  readonly pageTitleTimeoutMs?: number;
  readonly relayReadyTimeoutMs?: number;
}

export class BrowserManager {
  private readonly relayManager: RelayManager;
  private readonly defaultTimeoutMs: number;
  private readonly pageTitleTimeoutMs: number;
  private readonly relayReadyTimeoutMs: number;
  private connection: PlaywriterBrowserConnection | null = null;
  private currentContext: BrowserContext | null = null;
  private readonly jarvisOwnedPages = new Set<Page>();
  private activePage: Page | null = null;
  private selectedBrowserId: string | null = null;
  private sessionId: string | null = null;
  private lastSuccessfulOperation: string | null = null;
  private lastError: string | null = null;
  private recoveryAttempts = 0;

  public constructor(options: BrowserManagerOptions = {}) {
    this.relayManager = new RelayManager({ port: options.relayPort });
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
    this.pageTitleTimeoutMs = options.pageTitleTimeoutMs ?? DEFAULT_PAGE_TITLE_TIMEOUT_MS;
    this.relayReadyTimeoutMs = options.relayReadyTimeoutMs ?? DEFAULT_RELAY_READY_TIMEOUT_MS;
  }

  public isConnected(): boolean {
    return this.connection !== null;
  }

  public getSessionId(): string | null {
    return this.sessionId;
  }

  public getConnectedProfile(): ConnectedProfileInfo | null {
    if (!this.connection) return null;
    const eb = this.connection.extensionBrowser;
    return {
      id: eb.id,
      browser: eb.browser,
      email: eb.email,
      activeTabs: eb.activeTabs,
      playwriterVersion: eb.playwriterVersion,
    };
  }

  public async listConnectedProfiles(): Promise<ExtensionBrowser[]> {
    return listBrowsers({ port: this.relayManager.port });
  }

  public async connect(targetProfileEmailOrId?: string): Promise<ConnectedProfileInfo> {
    if (this.connection) {
      const current = this.connection.extensionBrowser;
      const matchesTarget =
        !targetProfileEmailOrId ||
        current.id === targetProfileEmailOrId ||
        current.email?.toLowerCase() === targetProfileEmailOrId.toLowerCase();

      if (matchesTarget && this.activePage !== null && !this.isPageClosed(this.activePage)) {
        const existing = this.getConnectedProfile();
        if (existing) return existing;
      }
      await this.disconnect();
    }

    try {
      const relayStatus = await this.waitForRelay();
      if (!relayStatus.running) {
        throw new BrowserError(
          'relay-unavailable',
          `Playwriter relay is not reachable at ${this.relayManager.host}:${String(this.relayManager.port)}. Start it with "playwriter serve --host 127.0.0.1", then retry.`,
          {
            details: {
              host: this.relayManager.host,
              port: this.relayManager.port,
              listening: relayStatus.listening,
              relayError: relayStatus.extensionStatusError,
            },
          },
        );
      }

      const available = await this.listConnectedProfiles();
      if (available.length === 0) {
        throw new BrowserError(
          'extension-disconnected',
          'Playwriter relay is reachable, but no Chrome profile is connected. Activate the Playwriter extension on a Chrome tab, then retry.',
          { details: { relayVersion: relayStatus.version } },
        );
      }

      const selected = this.selectTarget(available, targetProfileEmailOrId);

      let connection: PlaywriterBrowserConnection;
      try {
        connection = await connectViaExtension({
          port: this.relayManager.port,
          tabGroup: JARVIS_TAB_GROUP_NAME,
          tabGroupColor: 'blue',
          closeTabsOnEnd: false,
          selectBrowser: (browsers) => {
            const match = browsers.find((b) => b.id === selected.id);
            if (!match) {
              throw new BrowserError(
                'browser-not-registered',
                `The selected Chrome profile "${selected.id}" is no longer registered. Reconnect and retry.`,
              );
            }
            return match;
          },
        });
      } catch (error) {
        throw asBrowserError(
          error,
          'session-init-failed',
          'Playwriter session initialization failed',
        );
      }

      this.connection = connection;
      this.sessionId = connection.sessionId;
      this.selectedBrowserId = selected.id;

      const context = connection.browser.contexts()[0];
      if (!context) {
        throw new BrowserError(
          'session-init-failed',
          'Playwriter connected but did not expose a browser context.',
        );
      }
      this.currentContext = context;

      const responsive = await this.findResponsivePage(this.getPages());
      if (responsive) {
        this.activePage = responsive;
      } else {
        let created: Page;
        try {
          created = await withTimeout(
            context.newPage(),
            this.defaultTimeoutMs,
            'Timed out creating a JARVIS-owned tab during session initialization.',
          );
        } catch (error) {
          throw asBrowserError(
            error,
            'session-init-failed',
            'No enabled tab was responsive and JARVIS could not open its own tab',
          );
        }
        this.jarvisOwnedPages.add(created);
        this.activePage = created;
      }

      this.lastSuccessfulOperation = 'connect';
      this.lastError = null;

      const connected = this.getConnectedProfile();
      if (!connected) {
        throw new BrowserError(
          'session-init-failed',
          'Failed to retrieve connected profile metadata.',
        );
      }
      return connected;
    } catch (error) {
      const browserError = asBrowserError(
        error,
        'session-init-failed',
        'Failed to connect to browser via Playwriter',
      );
      this.recordError(browserError);
      await this.closeConnection();
      throw browserError;
    }
  }

  public async disconnect(): Promise<void> {
    await this.closeConnection();
  }

  public async listTabs(): Promise<BrowserTabInfo[]> {
    this.ensureConnected();
    const pages = this.getPages();
    const metas = await Promise.all(
      pages.map(async (page) => ({ page, meta: await this.readPageMeta(page) })),
    );

    return metas.map(({ page, meta }, index) => ({
      index,
      id: `tab-${String(index)}`,
      title: meta.title,
      url: meta.url,
      isJarvisOwned: this.jarvisOwnedPages.has(page),
      isCurrent: this.activePage !== null && page === this.activePage,
      responsive: meta.responsive,
      titleError: meta.titleError,
    }));
  }

  public async newTab(url = 'about:blank'): Promise<BrowserTabInfo> {
    this.ensureConnected();
    if (!this.currentContext) {
      throw new BrowserError('session-init-failed', 'No active browser context available.');
    }

    let page: Page;
    try {
      page = await withTimeout(
        this.currentContext.newPage(),
        this.defaultTimeoutMs,
        'Timed out creating a new browser tab.',
      );
    } catch (error) {
      throw asBrowserError(error, 'session-init-failed', 'Failed to create a new browser tab');
    }

    this.jarvisOwnedPages.add(page);
    this.activePage = page;

    if (url && url !== 'about:blank') {
      await this.navigate(url);
    }

    const tabs = await this.listTabs();
    const currentTab = tabs.find((t) => t.isCurrent) ?? tabs[tabs.length - 1];
    if (!currentTab) {
      throw new BrowserError('session-init-failed', 'Failed to retrieve newly created tab.');
    }
    return currentTab;
  }

  public async switchTab(tabIndex: number): Promise<BrowserTabInfo> {
    this.ensureConnected();
    const pages = this.getPages();
    if (tabIndex < 0 || tabIndex >= pages.length) {
      throw new Error(
        `Tab index ${String(tabIndex)} out of range (0 to ${String(pages.length - 1)}).`,
      );
    }

    const targetPage = pages[tabIndex];
    if (!targetPage || this.isPageClosed(targetPage)) {
      throw new Error(`Tab ${String(tabIndex)} has already been closed or is unavailable.`);
    }

    const meta = await this.readPageMeta(targetPage);
    if (!meta.responsive) {
      throw new BrowserError(
        'no-enabled-tabs',
        `Tab ${String(tabIndex)} is not responsive (${meta.titleError ?? 'no URL or title'}). Reconnect and retry.`,
      );
    }

    try {
      await withTimeout(
        targetPage.bringToFront(),
        CLOSE_TIMEOUT_MS,
        `Timed out focusing tab ${String(tabIndex)}.`,
      );
    } catch (error) {
      throw asBrowserError(error, 'no-enabled-tabs', `Failed to focus tab ${String(tabIndex)}`);
    }

    this.activePage = targetPage;

    const tabs = await this.listTabs();
    const selectedTab = tabs[tabIndex];
    if (!selectedTab) {
      throw new Error(`Failed to retrieve tab information for index ${String(tabIndex)}.`);
    }
    return selectedTab;
  }

  public async closeJarvisTab(
    tabIndex?: number,
  ): Promise<{ closed: boolean; remainingTabs: number }> {
    this.ensureConnected();
    const pages = this.getPages();

    let targetPage: Page;
    if (tabIndex !== undefined) {
      if (tabIndex < 0 || tabIndex >= pages.length) {
        throw new Error(`Tab index ${String(tabIndex)} out of range.`);
      }
      const page = pages[tabIndex];
      if (!page) {
        throw new Error(`Tab at index ${String(tabIndex)} not found.`);
      }
      targetPage = page;
    } else {
      if (!this.activePage) {
        throw new Error('No active tab to close.');
      }
      targetPage = this.activePage;
    }

    // Safety check: ONLY close JARVIS-owned tabs!
    if (!this.jarvisOwnedPages.has(targetPage)) {
      throw new Error(
        'Security restriction: Cannot close a user tab. JARVIS can only close tabs created by JARVIS.',
      );
    }

    try {
      await withTimeout(targetPage.close(), CLOSE_TIMEOUT_MS, 'Timed out closing browser tab.');
    } catch (error) {
      throw asBrowserError(error, 'stale-session', 'Failed to close browser tab');
    }
    this.jarvisOwnedPages.delete(targetPage);

    const remaining = this.getPages();
    this.activePage = (await this.findResponsivePage(remaining)) ?? remaining[0] ?? null;

    return {
      closed: true,
      remainingTabs: remaining.length,
    };
  }

  public getActivePage(): Page {
    this.ensureConnected();
    if (!this.activePage || this.isPageClosed(this.activePage)) {
      const remaining = this.getPages();
      const preferred = remaining.find((page) => this.hasCommittedUrl(page));
      const first = preferred ?? remaining[0];
      if (!first) {
        throw new BrowserError('no-enabled-tabs', 'No active open tabs in browser context.');
      }
      this.activePage = first;
    }
    return this.activePage;
  }

  public async navigate(url: string): Promise<{ url: string; title: string; recovered: boolean }> {
    let recovered = false;

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const page = this.getActivePage();
      try {
        await withTimeout(
          page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: this.defaultTimeoutMs,
          }),
          this.defaultTimeoutMs + CLOSE_TIMEOUT_MS,
          `Navigation to ${url} exceeded ${String(this.defaultTimeoutMs + CLOSE_TIMEOUT_MS)}ms.`,
        );

        const meta = await this.readPageMeta(page);
        if (!meta.responsive) {
          throw new BrowserError(
            'navigation-failed',
            `Navigation to ${url} did not produce a responsive tab (${meta.titleError ?? 'no URL'}).`,
          );
        }

        this.lastSuccessfulOperation = 'navigate';
        return { url: meta.url, title: meta.title, recovered };
      } catch (error) {
        const message = errorMessage(error);
        const recoverable = isStaleSessionError(message) || /timed? ?out|exceeded/i.test(message);

        if (attempt === 0 && recoverable) {
          recovered = true;
          this.recoveryAttempts += 1;
          try {
            await this.recoverConnection();
            continue;
          } catch (recoveryError) {
            const wrapped = asBrowserError(
              recoveryError,
              'navigation-failed',
              `Navigation to ${url} failed and session recovery failed`,
            );
            this.recordError(wrapped);
            throw wrapped;
          }
        }

        const wrapped = new BrowserError(
          'navigation-failed',
          `Failed to navigate to ${url}: ${message}`,
          { cause: error },
        );
        this.recordError(wrapped);
        throw wrapped;
      }
    }

    const wrapped = new BrowserError(
      'navigation-failed',
      `Failed to navigate to ${url} after session recovery.`,
    );
    this.recordError(wrapped);
    throw wrapped;
  }

  public async getReadiness(): Promise<BrowserReadiness> {
    const status = await this.relayManager.getStatus();

    let pages: Page[] = [];
    if (this.connection) {
      try {
        pages = this.getPages();
      } catch {
        pages = [];
      }
    }

    const metas = await Promise.all(pages.map(async (page) => this.readPageMeta(page)));
    const active = this.activePage;

    return {
      relayRunning: status.running,
      relayListening: status.listening,
      relayVersion: status.version,
      extensionCount: status.connectedExtensions,
      selectedBrowserId: this.selectedBrowserId,
      enabledTabs: pages.length,
      responsiveTabs: metas.filter((meta) => meta.responsive).length,
      sessionReady: this.connection !== null && active !== null && !this.isPageClosed(active),
      lastSuccessfulOperation: this.lastSuccessfulOperation,
      lastError: this.lastError,
      recoveryAttempts: this.recoveryAttempts,
    };
  }

  public async verifyReadiness(
    options: { readonly retries?: number | undefined } = {},
  ): Promise<BrowserReadinessReport> {
    const startedAt = Date.now();
    const retries = options.retries ?? 2;
    let lastError: unknown = null;

    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        if (!this.connection) {
          await this.connect();
        }

        const meta = await this.readPageMeta(this.getActivePage());
        if (!meta.responsive) {
          throw new BrowserError(
            'readiness-timeout',
            `Active tab is not responsive (${meta.titleError ?? 'no URL or title'}).`,
          );
        }

        this.lastSuccessfulOperation = 'readiness-check';
        const readiness = await this.getReadiness();
        return { readiness, elapsedMs: Date.now() - startedAt, attempts: attempt + 1 };
      } catch (error) {
        lastError = error;
        if (attempt < retries) {
          this.recoveryAttempts += 1;
          try {
            await this.recoverConnection();
          } catch {
            // The next attempt reports the failure.
          }
          await delay(RETRY_DELAY_MS * (attempt + 1));
        }
      }
    }

    const wrapped = asBrowserError(
      lastError,
      'readiness-timeout',
      'Browser readiness check failed',
    );
    this.recordError(wrapped);
    throw wrapped;
  }

  private async waitForRelay(): Promise<RelayStatus> {
    const deadline = Date.now() + this.relayReadyTimeoutMs;
    let status = await this.relayManager.getStatus();

    while (!status.running && Date.now() < deadline) {
      await delay(RETRY_DELAY_MS);
      status = await this.relayManager.getStatus();
    }

    return status;
  }

  private selectTarget(
    browsers: readonly ExtensionBrowser[],
    targetProfileEmailOrId?: string,
  ): ExtensionBrowser {
    if (!targetProfileEmailOrId) {
      const first = browsers[0];
      if (!first) {
        throw new BrowserError('extension-disconnected', 'No Chrome profiles are connected.');
      }
      return first;
    }

    const lowered = targetProfileEmailOrId.toLowerCase();
    const match = browsers.find(
      (browser) =>
        browser.id === targetProfileEmailOrId || browser.email?.toLowerCase() === lowered,
    );
    if (!match) {
      const available = browsers.map((browser) => browser.email ?? browser.id).join(', ');
      throw new BrowserError(
        'no-matching-browser',
        `Requested Chrome profile "${targetProfileEmailOrId}" is not connected. Connected profiles: ${available}.`,
      );
    }
    return match;
  }

  private async recoverConnection(): Promise<void> {
    const target = this.selectedBrowserId ?? undefined;
    await this.closeConnection();
    await this.connect(target);
  }

  private async findResponsivePage(pages: readonly Page[]): Promise<Page | null> {
    const metas = await Promise.all(
      pages.map(async (page) => ({ page, meta: await this.readPageMeta(page) })),
    );
    return metas.find(({ meta }) => meta.responsive)?.page ?? null;
  }

  private async readPageMeta(page: Page): Promise<PageMeta> {
    let url = '';
    try {
      url = page.url();
    } catch (error) {
      return { url, title: '', responsive: false, titleError: errorMessage(error) };
    }

    if (!url) {
      return {
        url,
        title: '',
        responsive: false,
        titleError: 'Page target has no committed URL yet.',
      };
    }

    try {
      const title = await withTimeout(
        page.title(),
        this.pageTitleTimeoutMs,
        `Timed out reading tab title within ${String(this.pageTitleTimeoutMs)}ms.`,
      );
      return { url, title, responsive: true, titleError: null };
    } catch (error) {
      return { url, title: '', responsive: false, titleError: errorMessage(error) };
    }
  }

  private getPages(): Page[] {
    if (!this.currentContext) return [];
    return this.currentContext.pages().filter((page) => !this.isPageClosed(page));
  }

  private isPageClosed(page: Page): boolean {
    try {
      return page.isClosed();
    } catch {
      return true;
    }
  }

  private hasCommittedUrl(page: Page): boolean {
    try {
      return page.url().length > 0;
    } catch {
      return false;
    }
  }

  private ensureConnected(): void {
    if (!this.connection) {
      throw new BrowserError(
        'session-init-failed',
        'Browser is not connected. Call browser_connect_profile first.',
      );
    }
  }

  private async closeConnection(): Promise<void> {
    const connection = this.connection;
    this.connection = null;
    this.currentContext = null;
    this.activePage = null;
    this.selectedBrowserId = null;
    this.sessionId = null;
    this.jarvisOwnedPages.clear();

    if (connection) {
      try {
        await withTimeout(
          connection.close(),
          CLOSE_TIMEOUT_MS,
          'Timed out closing Playwriter session.',
        );
      } catch {
        // Best effort: the relay may already have dropped the session.
      }
    }
  }

  private recordError(error: unknown): void {
    this.lastError = errorMessage(error);
  }
}

function asBrowserError(error: unknown, code: BrowserErrorCode, prefix: string): BrowserError {
  if (error instanceof BrowserError) return error;
  return new BrowserError(code, `${prefix}: ${errorMessage(error)}`, { cause: error });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new BrowserError('readiness-timeout', message));
    }, timeoutMs);

    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(
          error instanceof Error
            ? error
            : new BrowserError('readiness-timeout', errorMessage(error), { cause: error }),
        );
      },
    );
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
