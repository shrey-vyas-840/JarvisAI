import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import {
  ToolRegistry,
  type ToolDefinition,
  type ToolExecutionContext,
} from '../src/core/tool-registry.js';
import { Logger } from '../src/logging/logger.js';

const logger = new Logger({ level: 'debug', logDir: 'unused', console: false, file: false });
const fixedNow = () => new Date('2026-11-07T00:00:00.000Z');

function context(signal = new AbortController().signal): ToolExecutionContext {
  return {
    executionId: 'exec-1',
    callId: 'call-1',
    logger,
    signal,
    now: fixedNow,
  };
}

function echoTool(overrides: Partial<ToolDefinition<{ value: string }>> = {}): ToolDefinition<{
  value: string;
}> {
  return {
    name: 'echo',
    description: 'Echo a value.',
    parameters: {
      type: 'object',
      properties: {
        value: { type: 'string' },
      },
      required: ['value'],
      additionalProperties: false,
    },
    argumentsSchema: z.object({ value: z.string().min(1) }).strict(),
    execute: (args) => ({ echo: args.value }),
    verify: (args, output) =>
      typeof output === 'object' &&
      output !== null &&
      'echo' in output &&
      output.echo === args.value,
    timeoutMs: 1_000,
    permission: 'read-only',
    ...overrides,
  };
}

describe('ToolRegistry', () => {
  it('registers and executes a validated tool with verification', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());

    const receipt = await registry.execute('echo', { value: 'hello' }, context());

    expect(receipt).toMatchObject({
      executionId: 'exec-1',
      callId: 'call-1',
      toolName: 'echo',
      status: 'success',
      verification: 'verified',
      result: { echo: 'hello' },
      error: null,
    });
    expect(registry.listNames()).toEqual(['echo']);
    expect(registry.getOllamaTools()).toEqual([
      {
        type: 'function',
        function: {
          name: 'echo',
          description: 'Echo a value.',
          parameters: echoTool().parameters,
        },
      },
    ]);
  });

  it('rejects duplicate and invalid tool definitions', () => {
    const registry = new ToolRegistry();
    registry.register(echoTool());

    expect(() => {
      registry.register(echoTool());
    }).toThrow('Tool is already registered: echo');

    expect(() => {
      registry.register(echoTool({ name: 'Invalid Name' }));
    }).toThrow('Invalid tool name: Invalid Name');

    expect(() => {
      registry.register(echoTool({ description: '   ' }));
    }).toThrow('Tool description is required: echo');

    expect(() => {
      registry.register(
        echoTool({
          argumentsSchema: z.object({ value: z.string() }),
          timeoutMs: 0,
        }),
      );
    }).toThrow('Tool timeout must be a positive integer: echo');
  });

  it('returns validation failures without executing the tool', async () => {
    let executions = 0;
    const registry = new ToolRegistry();
    registry.register(
      echoTool({
        execute: () => {
          executions += 1;
          return { echo: 'unexpected' };
        },
      }),
    );

    const receipt = await registry.execute('echo', { value: '' }, context());

    expect(receipt.status).toBe('failure');
    expect(receipt.error).toContain('Invalid arguments');
    expect(receipt.verification).toBe('not_applicable');
    expect(executions).toBe(0);
  });

  it('returns a failure for unknown tools', async () => {
    const registry = new ToolRegistry();

    const receipt = await registry.execute('missing', {}, context());

    expect(receipt).toMatchObject({
      status: 'failure',
      error: 'Unknown tool',
      result: null,
    });
  });

  it('does not execute denied or approval-required tools', async () => {
    let executions = 0;
    const execute = (): { ok: boolean } => {
      executions += 1;
      return { ok: true };
    };
    const registry = new ToolRegistry();
    registry.register(echoTool({ name: 'denied_tool', execute, permission: 'denied' }));
    registry.register(
      echoTool({ name: 'approval_tool', execute, permission: 'requires-approval' }),
    );

    const denied = await registry.execute('denied_tool', { value: 'x' }, context());
    const approval = await registry.execute('approval_tool', { value: 'x' }, context());

    expect(denied).toMatchObject({ status: 'failure', error: 'Tool is denied by policy' });
    expect(approval).toMatchObject({
      status: 'approval_required',
      error: 'Tool requires approval',
    });
    expect(executions).toBe(0);
  });

  it('marks verification failures as failures while preserving output', async () => {
    const registry = new ToolRegistry();
    registry.register(echoTool({ verify: () => false }));

    const receipt = await registry.execute('echo', { value: 'hello' }, context());

    expect(receipt).toMatchObject({
      status: 'failure',
      verification: 'failed',
      result: { echo: 'hello' },
      error: 'Tool verification failed',
    });
  });

  it('times out a tool without waiting for its handler', async () => {
    const registry = new ToolRegistry();
    registry.register(
      echoTool({
        timeoutMs: 5,
        execute: () => new Promise(() => undefined),
      }),
    );

    const receipt = await registry.execute('echo', { value: 'hello' }, context());

    expect(receipt).toMatchObject({
      status: 'timeout',
      verification: 'not_applicable',
      result: null,
    });
    expect(receipt.error).toContain('timed out');
  });

  it('does not execute a tool when the context is already cancelled', async () => {
    let executions = 0;
    const controller = new AbortController();
    controller.abort();
    const registry = new ToolRegistry();
    registry.register(
      echoTool({
        execute: () => {
          executions += 1;
          return { echo: 'unexpected' };
        },
      }),
    );

    const receipt = await registry.execute('echo', { value: 'hello' }, context(controller.signal));

    expect(receipt).toMatchObject({
      status: 'cancelled',
      error: 'Tool execution cancelled',
    });
    expect(executions).toBe(0);
  });
});
