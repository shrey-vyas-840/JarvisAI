import { describe, expect, it } from 'vitest';

import { HELP_TEXT, runCli, type CliDependencies } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import type { HealthReport } from '../src/health/types.js';

interface CapturedIo {
  stdout: string[];
  stderr: string[];
  io: {
    stdout: (text: string) => void;
    stderr: (text: string) => void;
  };
}

function captureIo(): CapturedIo {
  const stdout: string[] = [];
  const stderr: string[] = [];

  return {
    stdout,
    stderr,
    io: {
      stdout: (text: string) => {
        stdout.push(text);
      },
      stderr: (text: string) => {
        stderr.push(text);
      },
    },
  };
}

function createHealthReport(status: HealthReport['status'] = 'OK'): HealthReport {
  return {
    timestamp: '2026-01-01T00:00:00.000Z',
    version: '0.1.0',
    status,
    checks: [{ id: 'node', label: 'Node.js', status, message: 'Node.js 24.18.0' }],
  };
}

function createDependencies(report: HealthReport): CliDependencies {
  return {
    loadConfig: () => loadConfig({ env: {}, loadDotEnv: false }),
    runHealthChecks: () => Promise.resolve(report),
  };
}

describe('cli', () => {
  it.each(['version', '--version', '-v'])('prints the version for %s', async (command) => {
    const captured = captureIo();

    const code = await runCli([command], captured.io);

    expect(code).toBe(0);
    expect(captured.stdout.join('')).toBe('JARVIS 0.1.0\n');
    expect(captured.stderr).toEqual([]);
  });

  it('prints help for help aliases and no arguments', async () => {
    const helpArgs: readonly (readonly string[])[] = [[], ['help'], ['--help'], ['-h']];

    for (const args of helpArgs) {
      const captured = captureIo();

      const code = await runCli(args, captured.io);

      expect(code).toBe(0);
      expect(captured.stdout.join('')).toBe(HELP_TEXT);
      expect(captured.stderr).toEqual([]);
    }
  });

  it('rejects unknown commands', async () => {
    const captured = captureIo();

    const code = await runCli(['unknown'], captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('')).toContain('Unknown command or option: unknown');
    expect(captured.stderr.join('')).toContain(HELP_TEXT);
  });

  it('prints a human-readable health report', async () => {
    const captured = captureIo();
    const report = createHealthReport();

    const code = await runCli(['health'], captured.io, createDependencies(report));

    expect(code).toBe(0);
    expect(captured.stdout.join('')).toContain('Overall: OK');
    expect(captured.stdout.join('')).toContain('[OK] Node.js: Node.js 24.18.0');
    expect(captured.stderr).toEqual([]);
  });

  it('prints health as JSON', async () => {
    const captured = captureIo();
    const report = createHealthReport();

    const code = await runCli(['health', '--json'], captured.io, createDependencies(report));

    const parsed: unknown = JSON.parse(captured.stdout.join(''));

    expect(code).toBe(0);
    expect(parsed).toEqual(report);
    expect(captured.stderr).toEqual([]);
  });

  it('returns a non-zero exit code when health fails', async () => {
    const captured = captureIo();
    const report = createHealthReport('FAILED');

    const code = await runCli(['health'], captured.io, createDependencies(report));

    expect(code).toBe(1);
    expect(captured.stdout.join('')).toContain('Overall: FAILED');
  });

  it('rejects unknown health options', async () => {
    const captured = captureIo();

    const code = await runCli(['health', '--bad'], captured.io);

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('')).toContain('Unknown health option: --bad');
  });

  it('reports configuration errors as health failures', async () => {
    const captured = captureIo();

    const code = await runCli(['health'], captured.io, {
      loadConfig: () => {
        throw new Error('bad config');
      },
      runHealthChecks: () => Promise.resolve(createHealthReport()),
    });

    expect(code).toBe(1);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('')).toContain('Health check failed: bad config');
  });

  it('runs browser profiles and browser status CLI commands', async () => {
    const captured = captureIo();
    const code = await runCli(['browser', 'profiles'], captured.io);
    expect(code).toBe(0);
    expect(captured.stdout.join('')).toContain('Discovered Profiles');

    const statusCaptured = captureIo();
    const statusCode = await runCli(['browser', 'status'], statusCaptured.io);
    expect(statusCode).toBe(0);
    expect(statusCaptured.stdout.join('')).toContain('Playwriter Relay at 127.0.0.1:19988');
  });

  it('runs desktop windows CLI command', async () => {
    const captured = captureIo();
    const code = await runCli(['desktop', 'windows'], captured.io);
    expect(code).toBe(0);
    expect(captured.stdout.join('')).toContain('Visible Desktop Windows');
  });
});
