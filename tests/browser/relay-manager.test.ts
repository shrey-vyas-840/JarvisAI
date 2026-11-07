import { EventEmitter, Readable } from 'node:stream';
import http from 'node:http';
import { describe, it, expect, vi } from 'vitest';

import { RelayManager } from '../../src/browser/relay-manager.js';

describe('RelayManager', () => {
  it('strictly enforces loopback host', () => {
    expect(() => new RelayManager({ host: '0.0.0.0' })).toThrow(/Security violation/);
    expect(() => new RelayManager({ host: '192.168.1.5' })).toThrow(/Security violation/);
    expect(() => new RelayManager({ host: 'example.com' })).toThrow(/Security violation/);

    const validLoopback = new RelayManager({ host: '127.0.0.1' });
    expect(validLoopback.host).toBe('127.0.0.1');
  });

  it('reports offline status when port is not listening', async () => {
    // Pick an unused high port
    const manager = new RelayManager({ port: 59991 });
    const status = await manager.getStatus();

    expect(status.running).toBe(false);
    expect(status.version).toBeNull();
    expect(status.connectedExtensions).toBe(0);
  });

  it('parses version and extensions from mock relay HTTP endpoints', async () => {
    const getSpy = vi
      .spyOn(http, 'get')
      .mockImplementation((options: unknown, callback?: unknown) => {
        const opts = options as { path?: string };
        const cb = callback as (res: unknown) => void;
        const req = new EventEmitter() as http.ClientRequest;
        req.destroy = vi.fn().mockReturnThis();

        const res = new Readable({
          read(): void {
            // No-op for mock stream
          },
        }) as unknown as http.IncomingMessage;
        Object.assign(res, { statusCode: 200, setEncoding: vi.fn() });

        setTimeout(() => {
          if (opts.path === '/version') {
            res.push(JSON.stringify({ version: '0.9.0' }));
            res.push(null);
          } else if (opts.path === '/extensions') {
            res.push(
              JSON.stringify([
                {
                  extensionId: 'ext-123',
                  stableKey: 'chrome-key-1',
                  browser: 'Chrome',
                  profile: { email: 'user@example.com', id: '1' },
                  activeTargets: 2,
                  playwriterVersion: '0.9.0',
                },
              ]),
            );
            res.push(null);
          } else {
            Object.assign(res, { statusCode: 404 });
            res.push(null);
          }
          cb(res);
        }, 5);

        return req;
      });

    try {
      const manager = new RelayManager({ port: 19988 });
      const status = await manager.getStatus();

      expect(status.running).toBe(true);
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
});
