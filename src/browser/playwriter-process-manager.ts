import { spawn, type ChildProcess } from 'node:child_process';
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { resolve } from 'node:path';
import net from 'node:net';
import { NOOP_LOGGER, type LoggerLike } from '../logging/logger.js';

const DEFAULT_RELAY_HOST = '127.0.0.1';
const DEFAULT_RELAY_PORT = 19988;
const DEFAULT_STARTUP_TIMEOUT_MS = 15_000;
const DEFAULT_SHUTDOWN_TIMEOUT_MS = 5_000;

export interface PlaywriterProcessManagerOptions {
  readonly host?: string;
  readonly port?: number;
  readonly startupTimeoutMs?: number;
  readonly shutdownTimeoutMs?: number;
  readonly pidFilePath?: string;
  readonly logDir?: string;
  readonly logger?: LoggerLike;
}

export interface ProcessManagerStatus {
  readonly running: boolean;
  readonly listening: boolean;
  readonly pid: number | null;
  readonly port: number;
  readonly host: string;
  readonly startedAt: string | null;
  readonly owner: 'jarvis' | 'external' | 'unknown';
  readonly error: string | null;
}

interface PidFileData {
  pid: number;
  port: number;
  host: string;
  startedAt: string;
  owner: 'jarvis';
}

export class PlaywriterProcessManager {
  private readonly host: string;
  private readonly port: number;
  private readonly startupTimeoutMs: number;
  private readonly shutdownTimeoutMs: number;
  private readonly pidFilePath: string;
  private readonly logDir: string;
  private readonly logger: LoggerLike;
  private spawnedProcess: ChildProcess | null = null;
  private readonly pidFileData: PidFileData | null = null;

  public constructor(options: PlaywriterProcessManagerOptions = {}) {
    this.host = options.host ?? DEFAULT_RELAY_HOST;
    this.port = options.port ?? DEFAULT_RELAY_PORT;
    this.startupTimeoutMs = options.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS;
    this.shutdownTimeoutMs = options.shutdownTimeoutMs ?? DEFAULT_SHUTDOWN_TIMEOUT_MS;
    this.logDir = options.logDir ?? resolve(process.cwd(), 'logs', 'playwriter');
    this.logger = options.logger ?? NOOP_LOGGER;
    this.pidFilePath =
      options.pidFilePath ?? resolve(this.logDir, `playwriter-${String(this.port)}.pid`);

    mkdirSync(this.logDir, { recursive: true });

    this.pidFileData = this.readPidFile();
  }

  public async getStatus(): Promise<ProcessManagerStatus> {
    const listening = await this.probeListening();
    let pid: number | null = null;
    let owner: 'jarvis' | 'external' | 'unknown' = 'unknown';
    let running = false;

    if (this.spawnedProcess?.exitCode === null && this.spawnedProcess.signalCode === null) {
      pid = this.spawnedProcess.pid ?? null;
      running = true;
      owner = 'jarvis';
    } else if (this.pidFileData) {
      pid = this.pidFileData.pid;
      running = this.isPidAlive(pid);
      if (running) {
        owner = 'jarvis';
      } else {
        owner = 'unknown';
      }
    } else if (listening) {
      owner = 'external';
      running = true;
    }

    return {
      running,
      listening,
      pid,
      port: this.port,
      host: this.host,
      startedAt: this.pidFileData?.startedAt ?? null,
      owner,
      error: null,
    };
  }

  public async ensureRunning(): Promise<ProcessManagerStatus> {
    const status = await this.getStatus();

    if (status.running && status.listening) {
      if (status.owner === 'jarvis') {
        this.logger.info('playwriter.manager.reuse', {
          pid: status.pid,
          port: this.port,
          message: 'Reusing existing JARVIS-owned Playwriter relay',
        });
        return status;
      }
      if (status.owner === 'external') {
        this.logger.warn('playwriter.manager.external', {
          pid: status.pid,
          port: this.port,
          message: 'Playwriter relay is running but owned externally; will reuse',
        });
        return status;
      }
    }

    if (status.listening && !status.running) {
      this.logger.warn('playwriter.manager.port-conflict', {
        port: this.port,
        message: 'Port is listening but no process found; assuming external relay',
      });
      return { ...status, running: true, owner: 'external' };
    }

    return await this.start();
  }

  public async start(): Promise<ProcessManagerStatus> {
    const existingStatus = await this.getStatus();
    if (existingStatus.running && existingStatus.listening) {
      if (existingStatus.owner === 'external') {
        this.logger.warn('playwriter.manager.cannot-start-external', {
          message: 'Cannot start new relay; port occupied by external process',
        });
        return existingStatus;
      }
    }

    this.logger.info('playwriter.manager.starting', {
      host: this.host,
      port: this.port,
      timeoutMs: this.startupTimeoutMs,
    });

    const cmd = process.platform === 'win32' ? 'playwriter.cmd' : 'playwriter';
    const args = ['serve', '--host', this.host, '--port', String(this.port)];

    const stdoutPath = resolve(this.logDir, `playwriter-${String(this.port)}-stdout.log`);
    const stderrPath = resolve(this.logDir, `playwriter-${String(this.port)}-stderr.log`);

    const stdoutFd = openSync(stdoutPath, 'a');
    let stderrFd: number | undefined;
    let child: ChildProcess;
    try {
      stderrFd = openSync(stderrPath, 'a');
      child = spawn(cmd, args, {
        detached: true,
        stdio: ['ignore', stdoutFd, stderrFd],
        windowsHide: true,
      });
    } finally {
      closeSync(stdoutFd);
      if (stderrFd !== undefined) closeSync(stderrFd);
    }

    let spawnError: Error | undefined;
    child.once('error', (error) => {
      spawnError = error;
    });
    child.unref();
    this.spawnedProcess = child;

    if (child.pid) {
      this.writePidFile(child.pid);
    }

    this.logger.info('playwriter.manager.spawned', {
      pid: child.pid,
      command: `${cmd} ${args.join(' ')}`,
    });

    const startTime = Date.now();

    while (Date.now() - startTime < this.startupTimeoutMs) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (spawnError) {
        const error = new Error(`Failed to spawn Playwriter relay: ${spawnError.message}`, {
          cause: spawnError,
        });
        this.logger.error('playwriter.manager.start-failed', { error: error.message });
        this.spawnedProcess = null;
        this.cleanupPidFile();
        throw error;
      }
      const status = await this.getStatus();
      if (status.listening) {
        this.logger.info('playwriter.manager.started', {
          pid: status.pid,
          port: this.port,
          elapsedMs: Date.now() - startTime,
        });
        return status;
      }
    }

    const error = new Error(
      `Playwriter relay did not start within ${String(this.startupTimeoutMs)}ms`,
    );
    this.logger.error('playwriter.manager.start-failed', { error: error.message });
    await this.stop();
    throw error;
  }

  public async stop(force = false): Promise<void> {
    const pid = this.spawnedProcess?.pid ?? this.pidFileData?.pid;
    const hasJarvisOwnership = this.spawnedProcess !== null || this.pidFileData?.owner === 'jarvis';
    if (hasJarvisOwnership && pid !== undefined && this.isPidAlive(pid)) {
      this.logger.info('playwriter.manager.stopping', { pid });

      try {
        if (this.spawnedProcess && !this.spawnedProcess.killed) {
          this.spawnedProcess.kill(force ? 'SIGKILL' : 'SIGTERM');
        } else {
          process.kill(pid, force ? 'SIGKILL' : 'SIGTERM');
        }
      } catch {
        // Ignored
      }

      const shutdownStart = Date.now();
      while (Date.now() - shutdownStart < this.shutdownTimeoutMs) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        if (!(await this.probeListening())) {
          break;
        }
      }

      if (await this.probeListening()) {
        if (!force) {
          this.logger.warn('playwriter.manager.force-stop', { pid });
          await this.stop(true);
        } else {
          this.logger.error('playwriter.manager.stop-failed', { pid });
        }
      } else {
        this.logger.info('playwriter.manager.stopped', { pid });
      }

      this.spawnedProcess = null;
    }

    if (hasJarvisOwnership) this.cleanupPidFile();
  }

  public async restart(): Promise<ProcessManagerStatus> {
    await this.stop();
    return this.start();
  }

  private async probeListening(timeoutMs = 600): Promise<boolean> {
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

  private isPidAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  private readPidFile(): PidFileData | null {
    if (!existsSync(this.pidFilePath)) return null;
    try {
      const content = readFileSync(this.pidFilePath, 'utf8');
      const data: unknown = JSON.parse(content);
      if (
        typeof data !== 'object' ||
        data === null ||
        !('owner' in data) ||
        data.owner !== 'jarvis' ||
        !('pid' in data) ||
        typeof data.pid !== 'number' ||
        !('port' in data) ||
        typeof data.port !== 'number' ||
        !('host' in data) ||
        typeof data.host !== 'string' ||
        !('startedAt' in data) ||
        typeof data.startedAt !== 'string'
      )
        return null;
      if (data.port !== this.port || data.host !== this.host) return null;
      return {
        pid: data.pid,
        port: data.port,
        host: data.host,
        startedAt: data.startedAt,
        owner: 'jarvis',
      };
    } catch {
      return null;
    }
  }

  private writePidFile(pid: number): void {
    const data: PidFileData = {
      pid,
      port: this.port,
      host: this.host,
      startedAt: new Date().toISOString(),
      owner: 'jarvis',
    };
    writeFileSync(this.pidFilePath, JSON.stringify(data, null, 2), 'utf8');
  }

  private cleanupPidFile(): void {
    if (existsSync(this.pidFilePath)) {
      try {
        unlinkSync(this.pidFilePath);
      } catch {
        // Ignored
      }
    }
  }

  public getPidFilePath(): string {
    return this.pidFilePath;
  }

  public getLogPaths(): { stdout: string; stderr: string } {
    return {
      stdout: resolve(this.logDir, `playwriter-${String(this.port)}-stdout.log`),
      stderr: resolve(this.logDir, `playwriter-${String(this.port)}-stderr.log`),
    };
  }
}
