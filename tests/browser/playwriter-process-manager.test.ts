import { createServer, type Server } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { PlaywriterProcessManager } from '../../src/browser/playwriter-process-manager.js';

describe('PlaywriterProcessManager', () => {
  let server: Server | undefined;
  let tempDir: string | undefined;

  afterEach(async () => {
    if (server?.listening) {
      await new Promise<void>((resolve, reject) => {
        server?.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
    server = undefined;
    if (tempDir) rmSync(tempDir, { recursive: true, force: true });
    tempDir = undefined;
  });

  it('reuses and preserves an externally owned listener when stopped', async () => {
    server = createServer();
    await new Promise<void>((resolve) => server?.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Expected a TCP address');

    tempDir = mkdtempSync(join(tmpdir(), 'jarvis-playwriter-'));
    const manager = new PlaywriterProcessManager({ port: address.port, logDir: tempDir });

    const status = await manager.ensureRunning();
    expect(status.owner).toBe('external');
    expect(status.listening).toBe(true);

    await manager.stop();

    expect(server.listening).toBe(true);
  });
});
