import { spawn, type ChildProcess } from 'node:child_process';
import http from 'node:http';
import net from 'node:net';

import { BrowserError, errorMessage } from './errors.js';
import type { ConnectedProfileInfo, RelayStatus } from './types.js';

export const DEFAULT_RELAY_HOST = '127.0.0.1';
export const DEFAULT_RELAY_PORT = 19988;

const PROBE_TIMEOUT_MS = 600;

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
    let version: string | null;
    try {
      const payload = await this.fetchJson<{ version?: unknown } | string>('/version');
      version =
        typeof payload === 'string'
          ? payload
          : isRecord(payload) && typeof payload.version === 'string'
            ? payload.version
            : null;
    } catch (error) {
      const listening = await this.probeListening();
      return {
        running: false,
        listening,
        host: this.host,
        port: this.port,
        version: null,
        connectedExtensions: null,
        extensionStatusError: listening
          ? `Relay HTTP API is not ready: ${errorMessage(error)}`
          : 'Relay is not listening on the configured loopback port.',
      };
    }

    try {
      const extensions = await this.listConnectedExtensions();
      return {
        running: true,
        listening: true,
        host: this.host,
        port: this.port,
        version,
        connectedExtensions: extensions.length,
        extensionStatusError: null,
      };
    } catch (error) {
      return {
        running: true,
        listening: true,
        host: this.host,
        port: this.port,
        version,
        connectedExtensions: null,
        extensionStatusError: errorMessage(error),
      };
    }
  }

  public async isReachable(): Promise<boolean> {
    const status = await this.getStatus();
    return status.running;
  }

  public async listConnectedExtensions(): Promise<ConnectedProfileInfo[]> {
    let payload: unknown;
    try {
      payload = await this.fetchJson<unknown>('/extensions/status');
    } catch (primaryError) {
      return this.listSingleConnectedExtension(primaryError);
    }

    const list = Array.isArray(payload)
      ? payload
      : isRecord(payload) && Array.isArray(payload.extensions)
        ? payload.extensions
        : null;

    if (!list) {
      throw new BrowserError(
        'relay-unavailable',
        'Playwriter relay returned an unexpected /extensions/status payload.',
      );
    }

    const profiles: ConnectedProfileInfo[] = [];
    for (const entry of list) {
      const normalized = normalizeExtension(entry);
      if (normalized) profiles.push(normalized);
    }
    return profiles;
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

  private async listSingleConnectedExtension(cause: unknown): Promise<ConnectedProfileInfo[]> {
    try {
      const payload = await this.fetchJson<unknown>('/extension/status');
      if (!isRecord(payload) || payload.connected !== true) {
        return [];
      }
      const normalized = normalizeExtension(payload);
      return normalized ? [normalized] : [];
    } catch {
      throw new BrowserError(
        'relay-unavailable',
        `Unable to read Playwriter extension status: ${errorMessage(cause)}`,
        { cause },
      );
    }
  }

  private probeListening(timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = net.connect({ host: this.host, port: this.port });
      let settled = false;

      const finish = (value: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(value);
      };

      socket.setTimeout(timeoutMs);
      socket.once('connect', () => {
        finish(true);
      });
      socket.once('timeout', () => {
        finish(false);
      });
      socket.once('error', () => {
        finish(false);
      });
    });
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function normalizeExtension(value: unknown): ConnectedProfileInfo | null {
  if (!isRecord(value)) return null;

  const extensionId = typeof value.extensionId === 'string' ? value.extensionId : null;
  const stableKey =
    typeof value.stableKey === 'string' && value.stableKey.length > 0 ? value.stableKey : null;
  const id = stableKey ?? extensionId;
  if (!id) return null;

  const profile = isRecord(value.profile) ? value.profile : null;
  const email = profile && typeof profile.email === 'string' ? profile.email : null;

  return {
    id,
    browser: typeof value.browser === 'string' ? value.browser : 'Chrome',
    email,
    activeTabs: typeof value.activeTargets === 'number' ? value.activeTargets : 0,
    playwriterVersion: typeof value.playwriterVersion === 'string' ? value.playwriterVersion : null,
  };
}
