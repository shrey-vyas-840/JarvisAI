import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';

import type { ConnectedProfileInfo, RelayStatus } from './types.js';

export const DEFAULT_RELAY_HOST = '127.0.0.1';
export const DEFAULT_RELAY_PORT = 19988;

export interface RelayManagerOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
}

export class RelayManager {
  public readonly host: string;
  public readonly port: number;
  private readonly startupTimeoutMs: number;
  private spawnedProcess: ChildProcess | null = null;

  public constructor(options: RelayManagerOptions = {}) {
    // Strictly enforce loopback
    if (
      options.host !== undefined &&
      options.host !== '127.0.0.1' &&
      options.host !== 'localhost'
    ) {
      throw new Error(
        `Security violation: Relay host must be loopback (127.0.0.1), got "${options.host}"`,
      );
    }

    this.host = DEFAULT_RELAY_HOST;
    this.port = options.port ?? DEFAULT_RELAY_PORT;
    this.startupTimeoutMs = options.startupTimeoutMs ?? 8000;
  }

  public async getStatus(): Promise<RelayStatus> {
    try {
      const version = await this.fetchJson<{ version?: string } | string>('/version');
      const versionStr = typeof version === 'string' ? version : (version.version ?? null);

      let connectedCount = 0;
      try {
        const extensions = await this.listConnectedExtensions();
        connectedCount = extensions.length;
      } catch {
        // Ignored if extensions endpoint isn't ready
      }

      return {
        running: true,
        host: this.host,
        port: this.port,
        version: versionStr,
        connectedExtensions: connectedCount,
      };
    } catch {
      return {
        running: false,
        host: this.host,
        port: this.port,
        version: null,
        connectedExtensions: 0,
      };
    }
  }

  public async isReachable(): Promise<boolean> {
    const status = await this.getStatus();
    return status.running;
  }

  public async listConnectedExtensions(): Promise<ConnectedProfileInfo[]> {
    try {
      const extensions = await this.fetchJson<
        {
          extensionId: string;
          stableKey?: string;
          browser?: string | null;
          profile?: { email: string; id: string } | null;
          activeTargets: number;
          playwriterVersion?: string | null;
        }[]
      >('/extensions');

      if (!Array.isArray(extensions)) {
        return [];
      }

      return extensions.map((ext) => ({
        id: ext.stableKey ?? ext.extensionId,
        browser: ext.browser ?? 'Chrome',
        email: ext.profile?.email ?? null,
        activeTabs: ext.activeTargets,
        playwriterVersion: ext.playwriterVersion ?? null,
      }));
    } catch {
      return [];
    }
  }

  public async start(): Promise<RelayStatus> {
    const initialStatus = await this.getStatus();
    if (initialStatus.running) {
      return initialStatus;
    }

    // Spawn relay using the safe command: playwriter serve --host 127.0.0.1
    // On Windows, playwriter is installed globally as playwriter.cmd
    const cmd = process.platform === 'win32' ? 'playwriter.cmd' : 'playwriter';
    const args = ['serve', '--host', '127.0.0.1'];

    try {
      this.spawnedProcess = spawn(cmd, args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      this.spawnedProcess.unref();
    } catch (spawnError) {
      const message = spawnError instanceof Error ? spawnError.message : 'Unknown spawn error';
      throw new Error(`Failed to spawn Playwriter relay: ${message}`, { cause: spawnError });
    }

    const startTime = Date.now();
    while (Date.now() - startTime < this.startupTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      const status = await this.getStatus();
      if (status.running) {
        return status;
      }
    }

    throw new Error(
      `Playwriter relay did not start within ${String(this.startupTimeoutMs)}ms at ${this.host}:${String(this.port)}. Please ensure 'playwriter serve --host 127.0.0.1' can run locally.`,
    );
  }

  public stop(): void {
    if (this.spawnedProcess && !this.spawnedProcess.killed) {
      try {
        this.spawnedProcess.kill();
      } catch {
        // Ignored
      }
      this.spawnedProcess = null;
    }
  }

  private fetchJson<T>(urlPath: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const req = http.get(
        {
          host: this.host,
          port: this.port,
          path: urlPath,
          timeout: 2000,
        },
        (res) => {
          if (res.statusCode && (res.statusCode < 200 || res.statusCode >= 300)) {
            res.resume();
            reject(new Error(`HTTP ${String(res.statusCode)} from relay`));
            return;
          }

          let data = '';
          res.setEncoding('utf8');
          res.on('data', (chunk: string) => {
            data += chunk;
          });
          res.on('end', () => {
            try {
              const parsed: unknown = JSON.parse(data);
              resolve(parsed as T);
            } catch {
              // Might be plain text version string
              resolve(data.trim() as unknown as T);
            }
          });
        },
      );

      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Relay request timed out'));
      });

      req.on('error', (err) => {
        reject(err);
      });
    });
  }
}
