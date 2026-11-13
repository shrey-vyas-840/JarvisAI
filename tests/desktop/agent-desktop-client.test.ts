import { describe, expect, it } from 'vitest';

import {
  AgentDesktopClient,
  AgentDesktopCommandError,
  type AgentDesktopRunOptions,
  type AgentDesktopRunner,
} from '../../src/desktop/agent-desktop-client.js';

interface RunnerCall {
  args: readonly string[];
  options: AgentDesktopRunOptions;
}

function createClient(response: unknown): {
  client: AgentDesktopClient;
  calls: RunnerCall[];
} {
  const calls: RunnerCall[] = [];
  const runner: AgentDesktopRunner = (args, options) => {
    calls.push({ args, options });

    return Promise.resolve({
      stdout: JSON.stringify(response),
      stderr: '',
      exitCode: 0,
    });
  };

  return {
    client: new AgentDesktopClient({ runner }),
    calls,
  };
}

function success(command: string, data: unknown): unknown {
  return {
    version: '2.6',
    ok: true,
    command,
    data,
  };
}

describe('AgentDesktopClient', () => {
  it('builds snapshot flags and returns the validated snapshot', async () => {
    const { client, calls } = createClient(
      success('snapshot', {
        app: 'notepad.exe',
        snapshot_id: 'sabc123',
        ref_count: 1,
        complete: true,
        tree: { role: 'window', name: 'Untitled - Notepad' },
      }),
    );

    const snapshot = await client.snapshot({
      app: 'notepad.exe',
      interactiveOnly: true,
      compact: true,
      timeoutMs: 5000,
    });

    expect(snapshot.snapshot_id).toBe('sabc123');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args).toEqual([
      'snapshot',
      '--app',
      'notepad.exe',
      '-i',
      '--compact',
      '--timeout-ms',
      '5000',
    ]);
    expect(calls[0]?.options.timeoutMs).toBe(15000);
  });

  it('rejects unqualified refs before spawning a command', async () => {
    const { client, calls } = createClient(success('get', { result: true }));

    await expect(client.get('@e1', 'text')).rejects.toThrow(/qualified agent-desktop ref/);
    expect(calls).toHaveLength(0);
  });

  it('preserves structured action errors and retry disposition', async () => {
    const { client } = createClient({
      version: '2.6',
      ok: false,
      command: 'click',
      error: {
        code: 'STALE_REF',
        message: 'The element no longer matches the live UI.',
        details: { kind: 'saved_ref_absent' },
        disposition: { delivery: 'not_delivered', retry: 'safe' },
      },
    });

    let caught: unknown;

    try {
      await client.act({ action: 'click', ref: '@sabc123:e4' });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AgentDesktopCommandError);
    expect(caught).toMatchObject({
      code: 'STALE_REF',
      disposition: { delivery: 'not_delivered', retry: 'safe' },
    });
    expect((caught as Error).message).toContain('retry=safe');
  });

  it('uses stdin and headed physical input for type but not for set-value', async () => {
    const typeRun = createClient(success('type', { disposition: { delivery: 'delivered' } }));

    await typeRun.client.act({
      action: 'type',
      ref: '@sabc123:e2',
      text: 'hello world',
    });

    expect(typeRun.calls[0]?.args).toEqual(['type', '@sabc123:e2', '--stdin', '--headed']);
    expect(typeRun.calls[0]?.options.stdin).toBe('hello world');

    const setValueRun = createClient(
      success('set-value', { disposition: { delivery: 'verified' } }),
    );

    await setValueRun.client.act({
      action: 'set-value',
      ref: '@sabc123:e2',
      text: 'safe text',
    });

    expect(setValueRun.calls[0]?.args).toEqual(['set-value', '@sabc123:e2', '--stdin']);
    expect(setValueRun.calls[0]?.options.stdin).toBe('safe text');
  });

  it('blocks dangerous key combinations before invoking agent-desktop', async () => {
    const { client, calls } = createClient(success('press', { delivered: true }));

    await expect(client.press({ combo: 'alt+f4', app: 'notepad.exe' })).rejects.toThrow(
      /blocked by JARVIS safety policy/,
    );
    expect(calls).toHaveLength(0);

    await client.press({ combo: 'Ctrl+C', app: 'notepad.exe' });
    expect(calls[0]?.args).toEqual(['press', 'ctrl+c', '--app', 'notepad.exe']);
  });

  it('builds bounded window wait arguments', async () => {
    const { client, calls } = createClient(success('wait', { found: true }));

    await client.wait({ mode: 'window', title: 'Untitled - Notepad', timeoutMs: 1000 });

    expect(calls[0]?.args).toEqual(['wait', '--window', 'Untitled - Notepad', '--timeout', '1000']);
    expect(calls[0]?.options.timeoutMs).toBe(15000);
  });

  it('rejects malformed JSON envelopes', async () => {
    const runner: AgentDesktopRunner = () =>
      Promise.resolve({
        stdout: 'not-json',
        stderr: '',
        exitCode: 0,
      });
    const client = new AgentDesktopClient({ runner });

    await expect(client.status()).rejects.toThrow(/malformed JSON/);
  });
});
