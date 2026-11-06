import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig, type AppConfig } from '../src/config.js';
import {
  aggregateStatus,
  runHealthChecks,
  type CommandRunner,
  type HealthDependencies,
} from '../src/health/checks.js';
import { formatHealthReport } from '../src/health/format.js';
import type { HealthCheck, HealthReport } from '../src/health/types.js';
import { VERSION } from '../src/version.js';

const tempRoots: string[] = [];

afterEach(() => {
  while (tempRoots.length > 0) {
    const root = tempRoots.pop();

    if (root !== undefined) {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

function createTempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'jarvis-health-'));
  tempRoots.push(root);
  return root;
}

function createConfig(root: string): AppConfig {
  return loadConfig({
    env: {
      JARVIS_WORKSPACE: join(root, 'workspace'),
      JARVIS_EXPORTS: join(root, 'exports'),
      JARVIS_TEMP: join(root, 'temp'),
    },
    loadDotEnv: false,
  });
}

function createRequiredDirectories(root: string, config: AppConfig): void {
  for (const name of ['src', 'tests', 'docs', 'data', 'logs', 'scripts']) {
    mkdirSync(join(root, name), { recursive: true });
  }

  for (const path of [config.paths.workspace, config.paths.exports, config.paths.temp]) {
    mkdirSync(path, { recursive: true });
  }
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function createFetchHandler(
  models: readonly unknown[] = [{ name: 'qwen3.5:9b', model: 'qwen3.5:9b', size: 7000000000 }],
): typeof fetch {
  return (input) => {
    const url = requestUrl(input);

    if (url.endsWith('/api/version')) {
      return Promise.resolve(jsonResponse({ version: '0.40.15' }));
    }

    if (url.endsWith('/api/tags')) {
      return Promise.resolve(jsonResponse({ models }));
    }

    return Promise.resolve(jsonResponse({}, 404));
  };
}

function createSuccessfulDependencies(root: string): HealthDependencies {
  const appData = join(root, 'appdata');
  const npmRoot = join(appData, 'npm');
  const packageDirectory = join(npmRoot, 'node_modules', 'playwriter');

  mkdirSync(packageDirectory, { recursive: true });
  writeFileSync(join(packageDirectory, 'package.json'), JSON.stringify({ version: '0.9.0' }));
  writeFileSync(join(npmRoot, 'playwriter.cmd'), '');

  const runCommand: CommandRunner = (command) => {
    if (command === 'npm.cmd') {
      return Promise.resolve({ exitCode: 0, stdout: '11.16.0\n', stderr: '' });
    }

    if (command === 'nvidia-smi') {
      return Promise.resolve({
        exitCode: 0,
        stdout: 'NVIDIA GeForce RTX 4060 Laptop GPU, 560.94, 8188, 0, 7957\r\n',
        stderr: '',
      });
    }

    return Promise.resolve({
      exitCode: 1,
      stdout: '',
      stderr: `unexpected command: ${command}`,
    });
  };

  return {
    fetch: createFetchHandler(),
    runCommand,
    checkTcp: () => Promise.resolve(true),
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    nodeVersion: '24.18.0',
    platform: 'win32',
    arch: 'x64',
    appData,
    projectRoot: root,
  };
}

describe('health', () => {
  it('aggregates the worst status', () => {
    const checks: HealthCheck[] = [
      { id: 'a', label: 'A', status: 'OK', message: 'ok' },
      { id: 'b', label: 'B', status: 'WARNING', message: 'warn' },
      { id: 'c', label: 'C', status: 'FAILED', message: 'fail' },
    ];

    expect(aggregateStatus([])).toBe('OK');
    expect(aggregateStatus(checks.slice(0, 2))).toBe('WARNING');
    expect(aggregateStatus(checks)).toBe('FAILED');
  });

  it('reports OK when all checks pass', async () => {
    const root = createTempRoot();
    const config = createConfig(root);
    createRequiredDirectories(root, config);

    const report = await runHealthChecks(config, createSuccessfulDependencies(root));

    expect(report.timestamp).toBe('2026-01-01T00:00:00.000Z');
    expect(report.version).toBe(VERSION);
    expect(report.status).toBe('OK');
    expect(report.checks.map((check) => check.id)).toEqual([
      'node',
      'npm',
      'directories',
      'ollama-api',
      'ollama-model',
      'playwriter-package',
      'playwriter-relay',
      'nvidia',
    ]);
    expect(report.checks.find((check) => check.id === 'node')).toMatchObject({
      status: 'OK',
      message: 'Node.js 24.18.0',
    });
    expect(report.checks.find((check) => check.id === 'ollama-model')).toMatchObject({
      status: 'OK',
      message: 'Model qwen3.5:9b is installed',
    });
    expect(report.checks.find((check) => check.id === 'playwriter-package')).toMatchObject({
      status: 'OK',
      message: 'Playwriter 0.9.0 is installed',
    });
  });

  it('fails when Node.js is below the required major version', async () => {
    const root = createTempRoot();
    const config = createConfig(root);
    createRequiredDirectories(root, config);

    const report = await runHealthChecks(config, {
      ...createSuccessfulDependencies(root),
      nodeVersion: '22.0.0',
    });

    expect(report.checks.find((check) => check.id === 'node')).toMatchObject({
      status: 'FAILED',
      message: 'Node.js 22.0.0 is below the required major version 24',
    });
    expect(report.status).toBe('FAILED');
  });

  it('reports failures and warnings without aborting other checks', async () => {
    const root = createTempRoot();
    const config = createConfig(root);
    createRequiredDirectories(root, config);
    rmSync(config.paths.workspace, { recursive: true, force: true });

    const dependencies: HealthDependencies = {
      ...createSuccessfulDependencies(root),
      fetch: createFetchHandler([]),
      checkTcp: () => Promise.resolve(false),
    };

    const report = await runHealthChecks(config, dependencies);

    expect(report.status).toBe('FAILED');
    expect(report.checks.find((check) => check.id === 'directories')).toMatchObject({
      status: 'FAILED',
    });
    expect(report.checks.find((check) => check.id === 'ollama-model')).toMatchObject({
      status: 'FAILED',
    });
    expect(report.checks.find((check) => check.id === 'playwriter-relay')).toMatchObject({
      status: 'WARNING',
    });
    expect(report.checks.find((check) => check.id === 'node')).toMatchObject({ status: 'OK' });
  });

  it('reports warnings for optional tools and failures for an unavailable Ollama API', async () => {
    const root = createTempRoot();
    const config = createConfig(root);
    createRequiredDirectories(root, config);

    const dependencies: HealthDependencies = {
      ...createSuccessfulDependencies(root),
      appData: join(root, 'missing-appdata'),
      fetch: () => Promise.resolve(jsonResponse({}, 500)),
      runCommand: (command) =>
        Promise.resolve({
          exitCode: 1,
          stdout: '',
          stderr: `${command} unavailable`,
        }),
    };

    const report = await runHealthChecks(config, dependencies);

    expect(report.status).toBe('FAILED');
    expect(report.checks.find((check) => check.id === 'ollama-api')).toMatchObject({
      status: 'FAILED',
    });
    expect(report.checks.find((check) => check.id === 'ollama-model')).toMatchObject({
      status: 'FAILED',
    });
    expect(report.checks.find((check) => check.id === 'npm')).toMatchObject({
      status: 'WARNING',
    });
    expect(report.checks.find((check) => check.id === 'playwriter-package')).toMatchObject({
      status: 'WARNING',
    });
    expect(report.checks.find((check) => check.id === 'nvidia')).toMatchObject({
      status: 'WARNING',
    });
  });

  it('formats a human-readable report', () => {
    const report: HealthReport = {
      timestamp: '2026-01-01T00:00:00.000Z',
      version: '0.1.0',
      status: 'WARNING',
      checks: [
        {
          id: 'node',
          label: 'Node.js',
          status: 'OK',
          message: 'Node.js 24.18.0',
          details: { version: '24.18.0' },
        },
        { id: 'relay', label: 'Relay', status: 'WARNING', message: 'not reachable' },
      ],
    };

    const text = formatHealthReport(report);

    expect(text).toContain('JARVIS health (0.1.0) at 2026-01-01T00:00:00.000Z');
    expect(text).toContain('Overall: WARNING');
    expect(text).toContain('[OK] Node.js: Node.js 24.18.0');
    expect(text).toContain('  {"version":"24.18.0"}');
    expect(text).toContain('[WARNING] Relay: not reachable');
    expect(text.endsWith('\n')).toBe(true);
  });
});
