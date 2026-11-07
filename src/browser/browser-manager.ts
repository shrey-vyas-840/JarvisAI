import {
  connectViaExtension,
  listBrowsers,
  type ExtensionBrowser,
  type PlaywriterBrowserConnection,
  type BrowserContext,
  type Page,
} from 'playwriter';

import { RelayManager } from './relay-manager.js';
import type { BrowserTabInfo, ConnectedProfileInfo } from './types.js';

export const JARVIS_TAB_GROUP_NAME = 'jarvis';

export interface BrowserManagerOptions {
  readonly relayPort?: number;
  readonly defaultTimeoutMs?: number;
}

export class BrowserManager {
  private readonly relayManager: RelayManager;
  private readonly defaultTimeoutMs: number;
  private connection: PlaywriterBrowserConnection | null = null;
  private currentContext: BrowserContext | null = null;
  private readonly jarvisOwnedPages = new Set<Page>();
  private activePage: Page | null = null;

  public constructor(options: BrowserManagerOptions = {}) {
    this.relayManager = new RelayManager({ port: options.relayPort });
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 30000;
  }

  public isConnected(): boolean {
    return this.connection !== null;
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
      // If already connected to the requested target, return existing
      const current = this.connection.extensionBrowser;
      if (
        !targetProfileEmailOrId ||
        current.id === targetProfileEmailOrId ||
        current.email === targetProfileEmailOrId
      ) {
        const profile = this.getConnectedProfile();
        if (profile) return profile;
      }
      await this.disconnect();
    }

    const isRunning = await this.relayManager.isReachable();
    if (!isRunning) {
      throw new Error(
        'Playwriter relay is not reachable. Ensure the relay is running at 127.0.0.1:19988.',
      );
    }

    const available = await this.listConnectedProfiles();
    if (available.length === 0) {
      throw new Error(
        'No Chrome profiles with Playwriter extension are connected. Please open Chrome, enable the Playwriter extension on your desired tab, and retry.',
      );
    }

    const selectTarget = (browsers: ExtensionBrowser[]): ExtensionBrowser | undefined => {
      if (!targetProfileEmailOrId) {
        return browsers[0];
      }
      const match = browsers.find(
        (b) =>
          b.id === targetProfileEmailOrId ||
          b.email?.toLowerCase() === targetProfileEmailOrId.toLowerCase(),
      );
      return match ?? browsers[0];
    };

    try {
      this.connection = await connectViaExtension({
        port: this.relayManager.port,
        tabGroup: JARVIS_TAB_GROUP_NAME,
        tabGroupColor: 'blue',
        closeTabsOnEnd: false,
        selectBrowser: selectTarget,
      });

      const contexts = this.connection.browser.contexts();
      this.currentContext = contexts[0] ?? null;

      // Track any initial page as active page if available
      if (this.currentContext) {
        const pages = this.currentContext.pages();
        const first = pages[0];
        if (first !== undefined) {
          this.activePage = first;
        }
      }

      const connected = this.getConnectedProfile();
      if (!connected) {
        throw new Error('Failed to retrieve connected profile metadata.');
      }
      return connected;
    } catch (error) {
      this.connection = null;
      this.currentContext = null;
      const message = error instanceof Error ? error.message : 'Unknown connection error';
      throw new Error(`Failed to connect to browser via Playwriter: ${message}`, {
        cause: error,
      });
    }
  }

  public async disconnect(): Promise<void> {
    if (this.connection) {
      try {
        await this.connection.close();
      } catch {
        // Disconnect gracefully
      }
      this.connection = null;
      this.currentContext = null;
      this.jarvisOwnedPages.clear();
      this.activePage = null;
    }
  }

  public async listTabs(): Promise<BrowserTabInfo[]> {
    this.ensureConnected();
    const pages = this.getPages();
    const result: BrowserTabInfo[] = [];

    for (let i = 0; i < pages.length; i++) {
      const page = pages[i];
      if (!page || page.isClosed()) continue;

      let title = '';
      let url = '';
      try {
        title = await page.title();
        url = page.url();
      } catch {
        // Stale or navigating page
      }

      result.push({
        index: i,
        id: `tab-${String(i)}`,
        title,
        url,
        isJarvisOwned: this.jarvisOwnedPages.has(page),
        isCurrent: this.activePage !== null && page === this.activePage,
      });
    }

    return result;
  }

  public async newTab(url = 'about:blank'): Promise<BrowserTabInfo> {
    this.ensureConnected();
    if (!this.currentContext) {
      throw new Error('No active browser context available.');
    }

    const page = await this.currentContext.newPage();
    this.jarvisOwnedPages.add(page);
    this.activePage = page;

    if (url && url !== 'about:blank') {
      await this.navigate(url);
    }

    const tabs = await this.listTabs();
    const currentTab = tabs.find((t) => t.isCurrent) ?? tabs[tabs.length - 1];
    if (!currentTab) {
      throw new Error('Failed to retrieve newly created tab.');
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
    if (!targetPage || targetPage.isClosed()) {
      throw new Error(`Tab ${String(tabIndex)} has already been closed or is unavailable.`);
    }

    await targetPage.bringToFront();
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

    await targetPage.close();
    this.jarvisOwnedPages.delete(targetPage);

    const remaining = this.getPages().filter((p) => !p.isClosed());
    this.activePage = remaining.length > 0 && remaining[0] !== undefined ? remaining[0] : null;

    return {
      closed: true,
      remainingTabs: remaining.length,
    };
  }

  public getActivePage(): Page {
    this.ensureConnected();
    if (!this.activePage || this.activePage.isClosed()) {
      const remaining = this.getPages().filter((p) => !p.isClosed());
      const first = remaining[0];
      if (!first) {
        throw new Error('No active open tabs in browser context.');
      }
      this.activePage = first;
    }
    return this.activePage;
  }

  public async navigate(url: string): Promise<{ url: string; title: string }> {
    const page = this.getActivePage();
    await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: this.defaultTimeoutMs,
    });
    const finalUrl = page.url();
    const title = await page.title();
    return { url: finalUrl, title };
  }

  private getPages(): Page[] {
    if (!this.currentContext) return [];
    return this.currentContext.pages().filter((p) => !p.isClosed());
  }

  private ensureConnected(): void {
    if (!this.connection) {
      throw new Error('Browser is not connected. Call browser_connect_profile first.');
    }
  }
}
