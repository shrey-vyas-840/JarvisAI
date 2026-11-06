import { execFile } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { z } from 'zod';

import { PROJECT_ROOT, type AppConfig } from '../config.js';
import { VERSION } from '../version.js';
import type { HealthCheck, HealthReport, HealthStatus } from './types.js';

const PLAYWRITER_RELAY_HOST = '127.0.0.1';
const PLAYWRITER_RELAY_PORT = 19988;
const EXPECTED_PLAYWRITER_VERSION = '0.9.0';
const COMMAND_TIMEOUT_MS = 5000;
const HTTP_TIMEOUT_MS = 3000;
const TCP_TIMEOUT_MS = 2000;

export interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export type CommandRunner = (
  command: string,
  args: readonly string[],
  timeoutMs?: number,
) => Promise<CommandResult>;

export type TcpChecker = (host: string, port: number, timeoutMs?: number) => Promise<boolean>;

export interface HealthDependencies {
  fetch: typeof fetch;
  runCommand: CommandRunner;
  checkTcp: TcpChecker;
  now: () => Date;
  nodeVersion: string;
  platform: NodeJS.Platform;
  arch: string;
  appData: string | undefined;
  projectRoot: string;
}

const execFileAsync = promisify(execFile);

export const runCommand: CommandRunner = async (command, args, timeoutMs = COMMAND_TIMEOUT_MS) => {
  const isWindowsBatch =
    process.platform === 'win32' && (command.endsWith('.cmd') || command.endsWith('.bat'));
  const executable = isWindowsBatch ? (process.env.ComSpec ?? 'cmd.exe') : command;
  const executableArgs = isWindowsBatch
    ? ['/d', '/s', '/c', [command, ...args].map(quoteForCommandLine).join(' ')]
    : [...args];

  try {
    const { stdout, stderr } = await execFileAsync(executable, executableArgs, {
      timeout: timeoutMs,
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
    });

    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    return commandFailure(error);
  }
};

export function checkTcpPort(
  host: string,
  port: number,
  timeoutMs = TCP_TIMEOUT_MS,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }

      settled = true;
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs, () => {
      finish(false);
    });
    socket.once('connect', () => {
      finish(true);
    });
    socket.once('error', () => {
      finish(false);
    });
  });
}

const defaultDependencies: HealthDependencies = {
  fetch,
  runCommand,
  checkTcp: checkTcpPort,
  now: () => new Date(),
  nodeVersion: process.versions.node,
  platform: process.platform,
  arch: process.arch,
  appData: process.env.APPDATA,
  projectRoot: PROJECT_ROOT,
};

const ollamaVersionSchema = z.object({
  version: z.string().min(1),
});

const ollamaTagsSchema = z.object({
  models: z.array(
    z.object({
      name: z.string().min(1),
      model: z.string().optional(),
      size: z.number().optional(),
    }),
  ),
});

const playwriterPackageSchema = z.object({
  version: z.string().min(1),
});

const healthStatusSeverity: Record<HealthStatus, number> = {
  OK: 0,
  WARNING: 1,
  FAILED: 2,
};

export async function runHealthChecks(
  config: AppConfig,
  overrides: Partial<HealthDependencies> = {},
): Promise<HealthReport> {
  const dependencies: HealthDependencies = { ...defaultDependencies, ...overrides };
  const checks = await Promise.all([
    Promise.resolve(checkNode(dependencies)),
    checkNpm(dependencies),
    Promise.resolve(checkDirectories(config, dependencies)),
    checkOllamaApi(config, dependencies),
    checkOllamaModel(config, dependencies),
    Promise.resolve(checkPlaywriterPackage(dependencies)),
    checkPlaywriterRelay(dependencies),
    checkNvidia(dependencies),
  ]);

  return {
    timestamp: dependencies.now().toISOString(),
    version: VERSION,
    status: aggregateStatus(checks),
    checks,
  };
}

export function aggregateStatus(checks: readonly HealthCheck[]): HealthStatus {
  let status: HealthStatus = 'OK';

  for (const check of checks) {
    if (healthStatusSeverity[check.status] > healthStatusSeverity[status]) {
      status = check.status;
    }
  }

  return status;
}

function checkNode(dependencies: HealthDependencies): HealthCheck {
  const [majorPart] = dependencies.nodeVersion.split('.');
  const major = Number.parseInt(majorPart ?? '0', 10);
  const supported = Number.isInteger(major) && major >= 24;

  return {
    id: 'node',
    label: 'Node.js',
    status: supported ? 'OK' : 'FAILED',
    message: supported
      ? `Node.js ${dependencies.nodeVersion}`
      : `Node.js ${dependencies.nodeVersion} is below the required major version 24`,
    details: {
      version: dependencies.nodeVersion,
      platform: dependencies.platform,
      arch: dependencies.arch,
    },
  };
}

async function checkNpm(dependencies: HealthDependencies): Promise<HealthCheck> {
  const command = dependencies.platform === 'win32' ? 'npm.cmd' : 'npm';
  const result = await dependencies.runCommand(command, ['--version'], COMMAND_TIMEOUT_MS);
  const version = result.stdout.trim();

  if (result.exitCode === 0 && version.length > 0) {
    return {
      id: 'npm',
      label: 'npm',
      status: 'OK',
      message: `npm ${version}`,
      details: { command, version },
    };
  }

  return {
    id: 'npm',
    label: 'npm',
    status: 'WARNING',
    message: 'npm is not practically available',
    details: { command, exitCode: result.exitCode, stderr: result.stderr.trim() },
  };
}

interface RequiredDirectory {
  label: string;
  path: string;
  missingStatus: Extract<HealthStatus, 'FAILED' | 'WARNING'>;
}

function checkDirectories(config: AppConfig, dependencies: HealthDependencies): HealthCheck {
  const required: RequiredDirectory[] = [
    { label: 'project root', path: dependencies.projectRoot, missingStatus: 'FAILED' },
    { label: 'src', path: join(dependencies.projectRoot, 'src'), missingStatus: 'WARNING' },
    { label: 'tests', path: join(dependencies.projectRoot, 'tests'), missingStatus: 'WARNING' },
    { label: 'docs', path: join(dependencies.projectRoot, 'docs'), missingStatus: 'WARNING' },
    { label: 'data', path: join(dependencies.projectRoot, 'data'), missingStatus: 'WARNING' },
    { label: 'logs', path: join(dependencies.projectRoot, 'logs'), missingStatus: 'WARNING' },
    { label: 'scripts', path: join(dependencies.projectRoot, 'scripts'), missingStatus: 'WARNING' },
    { label: 'workspace', path: config.paths.workspace, missingStatus: 'FAILED' },
    { label: 'exports', path: config.paths.exports, missingStatus: 'WARNING' },
    { label: 'temp', path: config.paths.temp, missingStatus: 'WARNING' },
  ];
  const results = required.map((entry) => ({
    label: entry.label,
    path: entry.path,
    exists: directoryExists(entry.path),
    missingStatus: entry.missingStatus,
  }));
  const missing = results.filter((entry) => !entry.exists);

  let status: HealthStatus = 'OK';

  if (missing.some((entry) => entry.missingStatus === 'FAILED')) {
    status = 'FAILED';
  } else if (missing.length > 0) {
    status = 'WARNING';
  }

  const message =
    status === 'OK'
      ? 'All required directories exist'
      : `Missing directories: ${missing.map((entry) => entry.label).join(', ')}`;

  return {
    id: 'directories',
    label: 'Directories',
    status,
    message,
    details: {
      directories: results.map(({ label, path, exists }) => ({ label, path, exists })),
    },
  };
}

async function checkOllamaApi(
  config: AppConfig,
  dependencies: HealthDependencies,
): Promise<HealthCheck> {
  const url = joinUrl(config.ollama.baseUrl, 'api/version');
  const result = await fetchJson(dependencies, url);

  if (!result.ok) {
    return {
      id: 'ollama-api',
      label: 'Ollama API',
      status: 'FAILED',
      message: `Ollama API is unavailable at ${config.ollama.baseUrl}`,
      details: { url, error: result.error, status: result.status ?? null },
    };
  }

  const parsed = ollamaVersionSchema.safeParse(result.data);

  if (!parsed.success) {
    return {
      id: 'ollama-api',
      label: 'Ollama API',
      status: 'FAILED',
      message: 'Ollama API returned an unexpected version response',
      details: { url, response: result.data },
    };
  }

  return {
    id: 'ollama-api',
    label: 'Ollama API',
    status: 'OK',
    message: `Ollama ${parsed.data.version} is reachable`,
    details: { url, version: parsed.data.version },
  };
}

async function checkOllamaModel(
  config: AppConfig,
  dependencies: HealthDependencies,
): Promise<HealthCheck> {
  const url = joinUrl(config.ollama.baseUrl, 'api/tags');
  const result = await fetchJson(dependencies, url);

  if (!result.ok) {
    return {
      id: 'ollama-model',
      label: 'Ollama model',
      status: 'FAILED',
      message: `Cannot verify model ${config.ollama.model}`,
      details: { url, error: result.error, status: result.status ?? null },
    };
  }

  const parsed = ollamaTagsSchema.safeParse(result.data);

  if (!parsed.success) {
    return {
      id: 'ollama-model',
      label: 'Ollama model',
      status: 'FAILED',
      message: 'Ollama returned an unexpected model list',
      details: { url },
    };
  }

  const model = parsed.data.models.find(
    (entry) => entry.name === config.ollama.model || entry.model === config.ollama.model,
  );

  if (model === undefined) {
    return {
      id: 'ollama-model',
      label: 'Ollama model',
      status: 'FAILED',
      message: `Model ${config.ollama.model} is not installed`,
      details: {
        url,
        requested: config.ollama.model,
        available: parsed.data.models.map((entry) => entry.name),
      },
    };
  }

  return {
    id: 'ollama-model',
    label: 'Ollama model',
    status: 'OK',
    message: `Model ${config.ollama.model} is installed`,
    details: {
      url,
      requested: config.ollama.model,
      installed: model.name,
      size: model.size ?? null,
    },
  };
}

function checkPlaywriterPackage(dependencies: HealthDependencies): HealthCheck {
  if (dependencies.appData === undefined) {
    return {
      id: 'playwriter-package',
      label: 'Playwriter package',
      status: 'WARNING',
      message: 'APPDATA is not set; cannot locate the global Playwriter package',
      details: {},
    };
  }

  const npmRoot = join(dependencies.appData, 'npm');
  const packagePath = join(npmRoot, 'node_modules', 'playwriter', 'package.json');
  const cliPath = [
    join(npmRoot, 'playwriter.cmd'),
    join(npmRoot, 'playwriter.ps1'),
    join(npmRoot, 'playwriter'),
  ].find((path) => existsSync(path));

  if (!existsSync(packagePath)) {
    return {
      id: 'playwriter-package',
      label: 'Playwriter package',
      status: 'WARNING',
      message: 'Playwriter package is not installed',
      details: { packagePath, cliPath: cliPath ?? null },
    };
  }

  try {
    const data: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
    const parsed = playwriterPackageSchema.safeParse(data);

    if (!parsed.success) {
      return {
        id: 'playwriter-package',
        label: 'Playwriter package',
        status: 'WARNING',
        message: 'Playwriter package metadata is invalid',
        details: { packagePath, cliPath: cliPath ?? null },
      };
    }

    const versionMatches = parsed.data.version === EXPECTED_PLAYWRITER_VERSION;
    const cliAvailable = cliPath !== undefined;
    const status: HealthStatus = versionMatches && cliAvailable ? 'OK' : 'WARNING';
    let message = `Playwriter ${parsed.data.version} is installed`;

    if (!versionMatches) {
      message = `Playwriter ${parsed.data.version} is installed; expected ${EXPECTED_PLAYWRITER_VERSION}`;
    } else if (!cliAvailable) {
      message = `Playwriter ${parsed.data.version} is installed, but the CLI shim is missing`;
    }

    return {
      id: 'playwriter-package',
      label: 'Playwriter package',
      status,
      message,
      details: {
        packagePath,
        cliPath: cliPath ?? null,
        version: parsed.data.version,
        expectedVersion: EXPECTED_PLAYWRITER_VERSION,
      },
    };
  } catch (error) {
    return {
      id: 'playwriter-package',
      label: 'Playwriter package',
      status: 'WARNING',
      message: 'Playwriter package metadata could not be read',
      details: { packagePath, cliPath: cliPath ?? null, error: formatError(error) },
    };
  }
}

async function checkPlaywriterRelay(dependencies: HealthDependencies): Promise<HealthCheck> {
  const reachable = await dependencies.checkTcp(
    PLAYWRITER_RELAY_HOST,
    PLAYWRITER_RELAY_PORT,
    TCP_TIMEOUT_MS,
  );

  return {
    id: 'playwriter-relay',
    label: 'Playwriter relay',
    status: reachable ? 'OK' : 'WARNING',
    message: reachable
      ? 'Relay is reachable at 127.0.0.1:19988'
      : 'Relay is not reachable at 127.0.0.1:19988',
    details: { host: PLAYWRITER_RELAY_HOST, port: PLAYWRITER_RELAY_PORT },
  };
}

async function checkNvidia(dependencies: HealthDependencies): Promise<HealthCheck> {
  const result = await dependencies.runCommand(
    'nvidia-smi',
    [
      '--query-gpu=name,driver_version,memory.total,memory.used,memory.free',
      '--format=csv,noheader,nounits',
    ],
    COMMAND_TIMEOUT_MS,
  );

  if (result.exitCode !== 0) {
    return {
      id: 'nvidia',
      label: 'NVIDIA',
      status: 'WARNING',
      message: 'nvidia-smi is not available',
      details: { exitCode: result.exitCode, stderr: result.stderr.trim() },
    };
  }

  const output = result.stdout.trim();

  if (output.length === 0) {
    return {
      id: 'nvidia',
      label: 'NVIDIA',
      status: 'WARNING',
      message: 'nvidia-smi returned no GPU information',
      details: {},
    };
  }

  const gpus = output.split(/\r?\n/).filter((line) => line.length > 0);

  return {
    id: 'nvidia',
    label: 'NVIDIA',
    status: 'OK',
    message: `NVIDIA GPU information is available (${String(gpus.length)} GPU(s))`,
    details: { gpus },
  };
}

interface FetchJsonSuccess {
  ok: true;
  data: unknown;
  status: number;
}

interface FetchJsonFailure {
  ok: false;
  status?: number;
  error: string;
}

type FetchJsonResult = FetchJsonSuccess | FetchJsonFailure;

async function fetchJson(
  dependencies: HealthDependencies,
  url: string,
  timeoutMs = HTTP_TIMEOUT_MS,
): Promise<FetchJsonResult> {
  try {
    const response = await dependencies.fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        error: `HTTP ${String(response.status)}`,
      };
    }

    const data: unknown = await response.json();

    return { ok: true, data, status: response.status };
  } catch (error) {
    return { ok: false, error: formatError(error) };
  }
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, '')}/${path.replace(/^\/+/, '')}`;
}

function directoryExists(path: string): boolean {
  try {
    return existsSync(path) && statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function quoteForCommandLine(value: string): string {
  if (/^[A-Za-z0-9_./:=,+-]+$/.test(value)) {
    return value;
  }

  return `"${value.replaceAll('"', '""')}"`;
}

function commandFailure(error: unknown): CommandResult {
  if (error instanceof Error) {
    const code = 'code' in error && typeof error.code === 'number' ? error.code : 1;
    const stdout = 'stdout' in error && typeof error.stdout === 'string' ? error.stdout : '';
    const stderr =
      'stderr' in error && typeof error.stderr === 'string' ? error.stderr : error.message;

    return { exitCode: code, stdout, stderr };
  }

  return { exitCode: 1, stdout: '', stderr: 'Unknown command error' };
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown error';
}
