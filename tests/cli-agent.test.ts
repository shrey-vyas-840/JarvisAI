import { describe, expect, it } from 'vitest';

import { runCli, type AgentRunner, type CliDependencies } from '../src/cli.js';
import { loadConfig } from '../src/config.js';
import type { AgentRunResult } from '../src/core/agent-loop.js';
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

function healthReport(): HealthReport {
  return {
    timestamp: '2026-11-07T00:00:00.000Z',
    version: '0.1.0',
    status: 'OK',
    checks: [],
  };
}

function createDependencies(runAgent: AgentRunner): CliDependencies {
  return {
    loadConfig: () => loadConfig({ env: {}, loadDotEnv: false }),
    runHealthChecks: () => Promise.resolve(healthReport()),
    runAgent,
  };
}

function agentResult(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
  return {
    executionId: 'exec-1',
    status: 'success',
    finalResponse: 'JARVIS is operational.',
    messages: [],
    receipts: [],
    rounds: 2,
    toolCallCount: 1,
    startedAt: '2026-11-07T00:00:00.000Z',
    completedAt: '2026-11-07T00:00:01.000Z',
    durationMs: 1_000,
    error: null,
    ...overrides,
  };
}

describe('cli agent command', () => {
  it('runs the agent with the joined message and prints the final response', async () => {
    const captured = captureIo();
    const calls: { message: string; signal: AbortSignal }[] = [];

    const code = await runCli(
      ['agent', 'Call', 'get_jarvis_status'],
      captured.io,
      createDependencies((_config, message, options) => {
        calls.push({ message, signal: options.signal });
        return Promise.resolve(agentResult());
      }),
    );

    expect(code).toBe(0);
    expect(captured.stdout.join('')).toBe('JARVIS is operational.\n');
    expect(captured.stderr).toEqual([]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.message).toBe('Call get_jarvis_status');
    expect(calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  it('returns a non-zero exit code and prints partial output when the agent fails', async () => {
    const captured = captureIo();

    const code = await runCli(
      ['agent', 'Keep working'],
      captured.io,
      createDependencies(() =>
        Promise.resolve(
          agentResult({
            status: 'failure',
            finalResponse: 'Partial response.',
            error: 'Maximum tool rounds (8) reached',
          }),
        ),
      ),
    );

    expect(code).toBe(1);
    expect(captured.stdout.join('')).toBe('Partial response.\n');
    expect(captured.stderr.join('')).toContain('Agent run failed: Maximum tool rounds (8) reached');
  });

  it('returns 130 when the agent is cancelled', async () => {
    const captured = captureIo();

    const code = await runCli(
      ['agent', 'Keep working'],
      captured.io,
      createDependencies(() =>
        Promise.resolve(
          agentResult({
            status: 'cancelled',
            finalResponse: '',
            error: 'Agent run cancelled',
          }),
        ),
      ),
    );

    expect(code).toBe(130);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('')).toContain('Agent run cancelled');
  });

  it('requires a non-empty agent message', async () => {
    const captured = captureIo();
    let called = false;

    const code = await runCli(
      ['agent', '   '],
      captured.io,
      createDependencies(() => {
        called = true;
        return Promise.resolve(agentResult());
      }),
    );

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('')).toContain('Agent message is required.');
  });

  it('reports configuration failures without invoking the agent', async () => {
    const captured = captureIo();
    let called = false;
    const dependencies: CliDependencies = {
      loadConfig: () => {
        throw new Error('bad config');
      },
      runHealthChecks: () => Promise.resolve(healthReport()),
      runAgent: () => {
        called = true;
        return Promise.resolve(agentResult());
      },
    };

    const code = await runCli(['agent', 'Call get_jarvis_status'], captured.io, dependencies);

    expect(code).toBe(1);
    expect(called).toBe(false);
    expect(captured.stdout).toEqual([]);
    expect(captured.stderr.join('')).toContain('Agent run failed: bad config');
  });
});
