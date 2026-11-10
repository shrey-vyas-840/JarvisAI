import { EventEmitter, Readable } from 'node:stream';
import http from 'node:http';
import { describe, it, expect, vi } from 'vitest';

import { RelayManager } from '../../src/browser/relay-manager.js';

interface MockRoute {
  readonly status?: number;
  readonly body?: string;
}

function mockRelay(routes: Record<string, MockRoute>) {
  return vi.spyOn(http, 'get').mockImplementation((options: unknown, callback?: unknown) => {
    const opts = options as { path?: string };
    const cb = callback as (res: unknown) => void;
    const req = new EventEmitter() as http.ClientRequest;
    req.destroy = vi.fn().mockReturnThis();

    const res = new Readable({
      read(): void {
        // No-op for mock stream
      },
    }) as unknown as http.IncomingMessage;
    Object.assign(res, {
      statusCode: 200,
      setEncoding: vi.fn(),
    });

    setTimeout(() => {
      const route = opts.path ? routes[opts.path] : undefined;
      if (!route) {
        Object.assign(res, { statusCode: 404 });
        res.push(null);
      } else {
        Object.assign(res, { statusCode: route.status ?? 200 });
        if (route.body !== undefined) res.push(route.body);
        res.push(null);
      }
      cb(res);
    }, 2);

    return req;
  });
}

describe('RelayManager', () => {
  it('strictly enforces loopback host', () => {
    expect(() => new RelayManager({ host: '0.0.0.0' })).toThrow(/Security violation/);
    expect(() => new RelayManager({ host: '192.168.1.5' })).toThrow(/Security violation/);
    expect(() => new RelayManager({ host: 'example.com' })).toThrow(/Security violation/);

    const validLoopback = new RelayManager({ host: '127.0.0.1' });
    expect(validLoopback.host).toBe('127.0.0.1');
  });

  it('reports offline status when port is not listening', async () => {
    const manager = new RelayManager({ port: 59991 });
    const status = await manager.getStatus();

    expect(status.running).toBe(false);
    expect(status.listening).toBe(false);
    expect(status.version).toBeNull();
    expect(status.connectedExtensions).toBeNull();
    expect(status.extensionStatusError).toContain('not listening');
  });

  it('parses wrapped /extensions/status payloads', async () => {
    const getSpy = mockRelay({
      '/version': { body: JSON.stringify({ version: '0.9.0' }) },
      '/extensions/status': {
        body: JSON.stringify({
          extensions: [
            {
              extensionId: 'ext-123',
              stableKey: 'chrome-key-1',
              browser: 'Chrome',
              profile: { email: 'user@example.com', id: '1' },
              activeTargets: 2,
              playwriterVersion: '0.9.0',
            },
          ],
        }),
      },
    });

    try {
      const manager = new RelayManager({ port: 19988 });
      const status = await manager.getStatus();

      expect(status.running).toBe(true);
      expect(status.listening).toBe(true);
      expect(status.version).toBe('0.9.0');
      expect(status.connectedExtensions).toBe(1);

      const extensions = await manager.listConnectedExtensions();
      expect(extensions).toHaveLength(1);
      expect(extensions[0]?.id).toBe('chrome-key-1');
      expect(extensions[0]?.email).toBe('user@example.com');
      expect(extensions[0]?.activeTabs).toBe(2);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('falls back to /extension/status when /extensions/status is unavailable', async () => {
    const getSpy = mockRelay({
      '/version': { body: JSON.stringify({ version: '0.9.0' }) },
      '/extension/status': {
        body: JSON.stringify({
          connected: true,
          extensionId: 'ext-abc',
          browser: 'Chrome',
          profile: { email: 'fallback@example.com', id: '2' },
          activeTargets: 1,
          playwriterVersion: '0.9.0',
        }),
      },
    });

    try {
      const manager = new RelayManager({ port: 19988 });
      const extensions = await manager.listConnectedExtensions();
      expect(extensions).toHaveLength(1);
      expect(extensions[0]?.id).toBe('ext-abc');
      expect(extensions[0]?.email).toBe('fallback@example.com');
    } finally {
      getSpy.mockRestore();
    }
  });

  it('reports unknown extension count instead of zero when inventory fails', async () => {
    const getSpy = mockRelay({
      '/version': { body: JSON.stringify({ version: '0.9.0' }) },
      '/extensions/status': { status: 500 },
      '/extension/status': { status: 500 },
    });

    try {
      const manager = new RelayManager({ port: 19988 });
      const status = await manager.getStatus();

      expect(status.running).toBe(true);
      expect(status.connectedExtensions).toBeNull();
      expect(status.extensionStatusError).toMatch(/extension status/i);
    } finally {
      getSpy.mockRestore();
    }
  });

  it('accepts a bare extension array from the relay', async () => {
    const getSpy = mockRelay({
      '/version': { body: JSON.stringify({ version: '0.9.0' }) },
      '/extensions/status': {
        body: JSON.stringify([
          {
            extensionId: 'ext-array',
            browser: 'Chrome',
            profile: null,
            activeTargets: 0,
            playwriterVersion: null,
          },
        ]),
      },
    });

    try {
      const manager = new RelayManager({ port: 19988 });
      const extensions = await manager.listConnectedExtensions();
      expect(extensions).toHaveLength(1);
      expect(extensions[0]?.id).toBe('ext-array');
      expect(extensions[0]?.email).toBeNull();
    } finally {
      getSpy.mockRestore();
    }
  });
});
