import http from 'node:http';

import { BrowserError, errorMessage } from './errors.js';
import { PlaywriterProcessManager } from './playwriter-process-manager.js';
import type { ConnectedProfileInfo, RelayStatus } from './types.js';
import { NOOP_LOGGER, type LoggerLike } from '../logging/logger.js';

export const DEFAULT_RELAY_HOST = '127.0.0.1';
export const DEFAULT_RELAY_PORT = 19988;

export interface RelayManagerOptions {
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly startupTimeoutMs?: number | undefined;
  readonly logger?: LoggerLike;
  readonly logDir?: string;
  readonly pidFilePath?: string;
}

export class RelayManager {
  public readonly host: string;
  public readonly port: number;
  private readonly processManager: PlaywriterProcessManager;

  public constructor(options: RelayManagerOptions = {}) {
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
    this.processManager = new PlaywriterProcessManager({
      host: this.host,
      port: this.port,
      startupTimeoutMs: options.startupTimeoutMs ?? 15_000,
      logger: options.logger ?? NOOP_LOGGER,
      ...(options.logDir === undefined ? {} : { logDir: options.logDir }),
      ...(options.pidFilePath === undefined ? {} : { pidFilePath: options.pidFilePath }),
    });
  }

  public async getStatus(): Promise<RelayStatus> {
    const pmStatus = await this.processManager.getStatus();

    if (!pmStatus.listening) {
      return {
        running: false,
        listening: false,
        host: this.host,
        port: this.port,
        version: null,
        connectedExtensions: null,
        extensionStatusError: 'Relay is not listening on the configured loopback port.',
      };
    }

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
      return {
        running: false,
        listening: true,
        host: this.host,
        port: this.port,
        version: null,
        connectedExtensions: null,
        extensionStatusError: `Relay HTTP API is not ready: ${errorMessage(error)}`,
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

  public async ensureRunning(): Promise<RelayStatus> {
    const pmStatus = await this.processManager.ensureRunning();
    if (!pmStatus.listening) {
      throw new Error(`Playwriter relay failed to start on ${this.host}:${String(this.port)}`);
    }

    // Wait for HTTP API to be ready
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await this.fetchJson<unknown>('/version');
        return await this.getStatus();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }

    const status = await this.getStatus();
    if (!status.running) {
      throw new Error(
        `Playwriter HTTP API did not become ready within 15000ms at ${this.host}:${String(this.port)}`,
      );
    }
    return status;
  }

  public async start(): Promise<RelayStatus> {
    const pmStatus = await this.processManager.start();
    if (!pmStatus.listening) {
      throw new Error(`Playwriter relay failed to start on ${this.host}:${String(this.port)}`);
    }

    // Wait for HTTP API to be ready
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      try {
        await this.fetchJson<unknown>('/version');
        return await this.getStatus();
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 300));
      }
    }
    throw new Error(
      `Playwriter HTTP API did not become ready within 15000ms at ${this.host}:${String(this.port)}`,
    );
  }

  public async stop(): Promise<void> {
    await this.processManager.stop();
  }

  public async restart(): Promise<RelayStatus> {
    await this.processManager.restart();
    return this.getStatus();
  }

  public getProcessManager(): PlaywriterProcessManager {
    return this.processManager;
  }

  public getProcessManagerStatus(): Promise<
    import('./playwriter-process-manager.js').ProcessManagerStatus
  > {
    return this.processManager.getStatus();
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}
