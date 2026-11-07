import { describe, it, expect } from 'vitest';

import { BrowserManager } from '../../src/browser/browser-manager.js';

describe('BrowserManager', () => {
  it('throws helpful error when operations are attempted before connecting', async () => {
    const manager = new BrowserManager({ relayPort: 59992 });

    expect(manager.isConnected()).toBe(false);
    expect(manager.getConnectedProfile()).toBeNull();

    await expect(manager.listTabs()).rejects.toThrow(/Browser is not connected/);
    await expect(manager.newTab()).rejects.toThrow(/Browser is not connected/);
    await expect(manager.switchTab(0)).rejects.toThrow(/Browser is not connected/);
    await expect(manager.closeJarvisTab(0)).rejects.toThrow(/Browser is not connected/);
    await expect(manager.navigate('https://example.com')).rejects.toThrow(
      /Browser is not connected/,
    );
  });

  it('fails gracefully when relay is offline during connect()', async () => {
    const manager = new BrowserManager({ relayPort: 59993 });

    await expect(manager.connect()).rejects.toThrow(/Playwriter relay is not reachable/);
  });
});
