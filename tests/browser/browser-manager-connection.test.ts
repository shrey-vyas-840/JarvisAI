import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ExtensionBrowser, Page } from 'playwriter';

import { BrowserManager } from '../../src/browser/browser-manager.js';

const harness = vi.hoisted(() => ({
  listBrowsers: vi.fn(),
  connectViaExtension: vi.fn(),
}));

vi.mock('playwriter', () => ({
  listBrowsers: harness.listBrowsers,
  connectViaExtension: harness.connectViaExtension,
}));

vi.mock('../../src/browser/relay-manager.js', () => ({
  DEFAULT_RELAY_HOST: '127.0.0.1',
  DEFAULT_RELAY_PORT: 19988,
  RelayManager: class {
    public readonly host = '127.0.0.1';
    public readonly port = 19988;

    public getStatus() {
      return Promise.resolve({
        running: true,
        listening: true,
        host: this.host,
        port: this.port,
        version: '0.9.0',
        connectedExtensions: 1,
        extensionStatusError: null,
      });
    }

    public isReachable(): Promise<boolean> {
      return Promise.resolve(true);
    }

    public start() {
      return this.getStatus();
    }
  },
}));

interface FakePage {
  url: () => string;
  title: () => Promise<string>;
  isClosed: () => boolean;
  bringToFront: () => Promise<void>;
  close: () => Promise<void>;
  goto: (url: string, options?: unknown) => Promise<null>;
}

interface FakePageOptions {
  url?: string;
  title?: string | (() => Promise<string>);
  closed?: boolean;
  goto?: (url: string, options?: unknown) => Promise<null>;
}

interface FakeContext {
  pages: () => Page[];
  newPage: ReturnType<typeof vi.fn>;
}

interface FakeConnection {
  browser: { contexts: () => FakeContext[] };
  extensionBrowser: ExtensionBrowser;
  sessionId: string;
  close: ReturnType<typeof vi.fn>;
  context: FakeContext;
}

function makePage(options: FakePageOptions = {}): FakePage {
  let closed = options.closed ?? false;
  let currentUrl = options.url ?? '';

  return {
    url: () => currentUrl,
    title: () =>
      typeof options.title === 'function' ? options.title() : Promise.resolve(options.title ?? ''),
    isClosed: () => closed,
    bringToFront: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => {
      closed = true;
      return Promise.resolve();
    }),
    goto: (url: string, gotoOptions?: unknown) => {
      if (options.goto) return options.goto(url, gotoOptions);
      currentUrl = url;
      return Promise.resolve(null);
    },
  };
}

function makeConnection(pages: FakePage[], browser: ExtensionBrowser): FakeConnection {
  const typedPages = pages as unknown as Page[];
  const context: FakeContext = {
    pages: () => typedPages,
    newPage: vi.fn(() => {
      const page = makePage({ url: 'about:blank' });
      typedPages.push(page as unknown as Page);
      return Promise.resolve(page);
    }),
  };

  return {
    browser: { contexts: () => [context] },
    extensionBrowser: browser,
    sessionId: `session-${browser.id}`,
    close: vi.fn(() => Promise.resolve()),
    context,
  };
}

const browserA: ExtensionBrowser = {
  id: 'browser-a',
  browser: 'Chrome',
  email: 'first@example.com',
  activeTabs: 2,
  playwriterVersion: '0.9.0',
};

const browserB: ExtensionBrowser = {
  id: 'browser-b',
  browser: 'Chrome',
  email: 'second@example.com',
  activeTabs: 1,
  playwriterVersion: '0.9.0',
};

function manager(): BrowserManager {
  return new BrowserManager({ pageTitleTimeoutMs: 50, relayReadyTimeoutMs: 50 });
}

describe('BrowserManager connection lifecycle', () => {
  beforeEach(() => {
    harness.listBrowsers.mockReset();
    harness.connectViaExtension.mockReset();
  });

  it('selects a responsive tab instead of an unresponsive first target', async () => {
    const phantom = makePage({
      url: '',
      title: () => new Promise<string>(() => undefined),
    });
    const good = makePage({ url: 'https://example.com/', title: 'Example Domain' });
    const connection = makeConnection([phantom, good], browserA);

    harness.listBrowsers.mockResolvedValue([browserA]);
    harness.connectViaExtension.mockResolvedValue(connection);

    const instance = manager();
    const profile = await instance.connect();

    expect(profile.id).toBe('browser-a');
    expect(instance.getActivePage()).toBe(good as unknown as Page);

    const tabs = await instance.listTabs();
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.responsive).toBe(false);
    expect(tabs[0]?.titleError).toMatch(/no committed URL/i);
    expect(tabs[1]?.responsive).toBe(true);
    expect(tabs[1]?.title).toBe('Example Domain');
  });

  it('bounds listTabs when a tab title never resolves', async () => {
    const phantom = makePage({
      url: '',
      title: () => new Promise<string>(() => undefined),
    });
    const good = makePage({ url: 'https://example.com/', title: 'Example Domain' });
    const connection = makeConnection([phantom, good], browserA);

    harness.listBrowsers.mockResolvedValue([browserA]);
    harness.connectViaExtension.mockResolvedValue(connection);

    const instance = manager();
    await instance.connect();

    const startedAt = Date.now();
    const tabs = await instance.listTabs();
    const elapsedMs = Date.now() - startedAt;

    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.responsive).toBe(false);
    expect(tabs[1]?.responsive).toBe(true);
    expect(elapsedMs).toBeLessThan(1500);
  });

  it('opens a JARVIS-owned tab when no existing tab is responsive', async () => {
    const phantom = makePage({
      url: '',
      title: () => new Promise<string>(() => undefined),
    });
    const connection = makeConnection([phantom], browserA);

    harness.listBrowsers.mockResolvedValue([browserA]);
    harness.connectViaExtension.mockResolvedValue(connection);

    const instance = manager();
    await instance.connect();

    expect(connection.context.newPage).toHaveBeenCalledTimes(1);

    const tabs = await instance.listTabs();
    const jarvisTab = tabs.find((tab) => tab.isJarvisOwned);
    expect(jarvisTab).toBeDefined();
    expect(jarvisTab?.responsive).toBe(true);
  });

  it('rejects a requested profile that is not connected instead of silently using another', async () => {
    harness.listBrowsers.mockResolvedValue([browserA]);

    const instance = manager();
    await expect(instance.connect('missing@example.com')).rejects.toMatchObject({
      code: 'no-matching-browser',
    });
    expect(harness.connectViaExtension).not.toHaveBeenCalled();
  });

  it('selects the requested profile when multiple browsers are connected', async () => {
    const good = makePage({ url: 'https://example.com/', title: 'Example Domain' });
    const connection = makeConnection([good], browserB);

    harness.listBrowsers.mockResolvedValue([browserA, browserB]);
    harness.connectViaExtension.mockResolvedValue(connection);

    const instance = manager();
    const profile = await instance.connect('SECOND@example.com');

    expect(profile.id).toBe('browser-b');
    expect(profile.email).toBe('second@example.com');

    const options = harness.connectViaExtension.mock.calls[0]?.[0] as {
      selectBrowser: (browsers: ExtensionBrowser[]) => ExtensionBrowser | undefined;
    };
    expect(options.selectBrowser([browserA, browserB])?.id).toBe('browser-b');
  });

  it('fails loudly when the selected browser disappears before session creation', async () => {
    harness.listBrowsers.mockResolvedValue([browserA, browserB]);
    const connection = makeConnection(
      [makePage({ url: 'https://example.com/', title: 'Example Domain' })],
      browserB,
    );
    harness.connectViaExtension.mockImplementation((options: unknown) => {
      const config = options as {
        selectBrowser: (browsers: ExtensionBrowser[]) => ExtensionBrowser | undefined;
      };
      config.selectBrowser([browserA]);
      return Promise.resolve(connection);
    });

    const instance = manager();
    await expect(instance.connect('browser-b')).rejects.toMatchObject({
      code: 'browser-not-registered',
    });
  });

  it('recovers once from a stale session during navigation', async () => {
    const stalePage = makePage({
      url: 'https://example.com/',
      title: 'Example Domain',
      goto: () => Promise.reject(new Error('Target page, context or browser has been closed')),
    });
    const healthyPage = makePage({ url: 'https://example.com/', title: 'Example Domain' });
    const staleConnection = makeConnection([stalePage], browserA);
    const healthyConnection = makeConnection([healthyPage], browserA);

    harness.listBrowsers.mockResolvedValue([browserA]);
    harness.connectViaExtension
      .mockResolvedValueOnce(staleConnection)
      .mockResolvedValueOnce(healthyConnection);

    const instance = manager();
    await instance.connect();
    const result = await instance.navigate('https://example.org/');

    expect(result.recovered).toBe(true);
    expect(result.url).toBe('https://example.org/');
    expect(harness.connectViaExtension).toHaveBeenCalledTimes(2);
    expect(staleConnection.close).toHaveBeenCalledTimes(1);
    expect(instance.getSessionId()).toBe('session-browser-a');
  });

  it('reports a navigation failure without retrying non-transient errors', async () => {
    const page = makePage({
      url: 'https://example.com/',
      title: 'Example Domain',
      goto: () => Promise.reject(new Error('net::ERR_NAME_NOT_RESOLVED')),
    });
    const connection = makeConnection([page], browserA);

    harness.listBrowsers.mockResolvedValue([browserA]);
    harness.connectViaExtension.mockResolvedValue(connection);

    const instance = manager();
    await instance.connect();
    await expect(instance.navigate('https://missing.invalid/')).rejects.toMatchObject({
      code: 'navigation-failed',
    });
    expect(harness.connectViaExtension).toHaveBeenCalledTimes(1);
  });

  it('proves readiness with a harmless read', async () => {
    const page = makePage({ url: 'https://example.com/', title: 'Example Domain' });
    const connection = makeConnection([page], browserA);

    harness.listBrowsers.mockResolvedValue([browserA]);
    harness.connectViaExtension.mockResolvedValue(connection);

    const instance = manager();
    const report = await instance.verifyReadiness();

    expect(report.readiness.sessionReady).toBe(true);
    expect(report.readiness.responsiveTabs).toBe(1);
    expect(report.readiness.lastSuccessfulOperation).toBe('readiness-check');
    expect(report.attempts).toBe(1);
  });

  it('clears session state on disconnect', async () => {
    const page = makePage({ url: 'https://example.com/', title: 'Example Domain' });
    const connection = makeConnection([page], browserA);

    harness.listBrowsers.mockResolvedValue([browserA]);
    harness.connectViaExtension.mockResolvedValue(connection);

    const instance = manager();
    await instance.connect();
    expect(instance.isConnected()).toBe(true);

    await instance.disconnect();
    expect(instance.isConnected()).toBe(false);
    expect(instance.getConnectedProfile()).toBeNull();
    expect(instance.getSessionId()).toBeNull();
    expect(connection.close).toHaveBeenCalledTimes(1);
  });
});
