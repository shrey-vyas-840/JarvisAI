import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { AgentLoop, type ChatClient } from '../src/core/agent-loop.js';
import { ToolRegistry, type ToolDefinition } from '../src/core/tool-registry.js';
import type {
  OllamaChatRequest,
  OllamaChatResult,
  OllamaToolCall,
} from '../src/llm/ollama-client.js';
import { Logger } from '../src/logging/logger.js';

const logger = new Logger({ level: 'debug', logDir: 'unused', console: false, file: false });

class FakeClient implements ChatClient {
  public readonly requests: OllamaChatRequest[] = [];
  private readonly responses: OllamaChatResult[];

  public constructor(responses: readonly OllamaChatResult[]) {
    this.responses = [...responses];
  }

  public chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
    this.requests.push(request);
    const response = this.responses.shift();

    if (response === undefined) {
      return Promise.reject(new Error('No fake response remains'));
    }

    return Promise.resolve(response);
  }
}

function response(content: string, toolCalls: readonly OllamaToolCall[] = []): OllamaChatResult {
  return {
    model: 'qwen3.5:9b',
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: [...toolCalls] } : {}),
    },
    done: true,
    doneReason: 'stop',
    metrics: {
      totalDurationMs: null,
      loadDurationMs: null,
      promptEvalCount: null,
      promptEvalDurationMs: null,
      evalCount: null,
      evalDurationMs: null,
    },
  };
}

function toolCall(value: string, name = 'echo'): OllamaToolCall {
  return {
    function: {
      name,
      arguments: { value },
    },
  };
}

function echoTool(
  overrides: Partial<ToolDefinition<{ value: string }>> = {},
): ToolDefinition<{ value: string }> {
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

function createLoop(
  client: ChatClient,
  registry: ToolRegistry,
  limits?: { maxToolRounds?: number; maxToolCalls?: number; maxToolOutputChars?: number },
): AgentLoop {
  let nextId = 0;

  return new AgentLoop({
    client,
    registry,
    logger,
    ...(limits === undefined ? {} : { limits }),
    now: () => new Date('2026-11-07T00:00:00.000Z'),
    idFactory: () => {
      nextId += 1;
      return `id-${String(nextId)}`;
    },
  });
}

describe('AgentLoop', () => {
  it('executes a structured tool call and returns the result to Ollama', async () => {
    const client = new FakeClient([
      response('', [toolCall('hello')]),
      response('JARVIS is operational.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());

    const result = await createLoop(client, registry).run({
      userMessage: 'Call echo with hello.',
      executionId: 'exec-test',
    });

    expect(result.status).toBe('success');
    expect(result.finalResponse).toBe('JARVIS is operational.');
    expect(result.rounds).toBe(2);
    expect(result.toolCallCount).toBe(1);
    expect(result.receipts).toHaveLength(1);
    expect(result.receipts[0]).toMatchObject({
      toolName: 'echo',
      status: 'success',
      verification: 'verified',
      result: { echo: 'hello' },
    });
    expect(client.requests[0]?.tools?.[0]?.function.name).toBe('echo');
    expect(client.requests[0]?.messages[0]?.role).toBe('system');

    const toolMessage = client.requests[1]?.messages.find((message) => message.role === 'tool');

    expect(toolMessage?.tool_name).toBe('echo');

    const toolPayload = JSON.parse(toolMessage?.content ?? '') as unknown;

    expect(toolPayload).toMatchObject({
      status: 'success',
      verification: 'verified',
      result: { echo: 'hello' },
    });
  });

  it('does not execute a tool call merely imitated in assistant text', async () => {
    const client = new FakeClient([
      response('{"function":{"name":"echo","arguments":{"value":"hello"}}}'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());

    const result = await createLoop(client, registry).run({
      userMessage: 'Pretend to call echo.',
    });

    expect(result.status).toBe('success');
    expect(result.receipts).toEqual([]);
    expect(result.toolCallCount).toBe(0);
    expect(client.requests).toHaveLength(1);
  });

  it('stops at the maximum tool-round limit', async () => {
    const client = new FakeClient([
      response('Working', [toolCall('one')]),
      response('Working', [toolCall('two')]),
      response('This response must not be requested.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());

    const result = await createLoop(client, registry, {
      maxToolRounds: 2,
      maxToolCalls: 10,
    }).run({ userMessage: 'Keep working.' });

    expect(result.status).toBe('limit_reached');
    expect(result.error).toContain('Maximum tool rounds (2)');
    expect(result.rounds).toBe(2);
    expect(result.toolCallCount).toBe(2);
    expect(result.receipts).toHaveLength(2);
    expect(client.requests).toHaveLength(2);
  });

  it('stops repeated identical tool calls to prevent a loop', async () => {
    const client = new FakeClient([
      response('', [toolCall('same')]),
      response('', [toolCall('same')]),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());

    const result = await createLoop(client, registry).run({
      userMessage: 'Repeat the call.',
    });

    expect(result.status).toBe('failure');
    expect(result.error).toContain('Repeated tool call detected');
    expect(result.toolCallCount).toBe(2);
    expect(result.receipts).toHaveLength(2);
    expect(result.receipts[0]?.status).toBe('success');
    expect(result.receipts[1]?.status).toBe('failure');
    expect(client.requests).toHaveLength(2);
  });

  it('stops before exceeding the maximum tool-call limit', async () => {
    const client = new FakeClient([
      response('', [toolCall('one'), toolCall('two'), toolCall('three')]),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());

    const result = await createLoop(client, registry, {
      maxToolRounds: 8,
      maxToolCalls: 2,
    }).run({ userMessage: 'Call echo three times.' });

    expect(result.status).toBe('limit_reached');
    expect(result.error).toContain('Maximum tool calls (2)');
    expect(result.toolCallCount).toBe(2);
    expect(result.receipts).toHaveLength(3);
    expect(result.receipts[2]?.status).toBe('failure');
    expect(client.requests).toHaveLength(1);
  });

  it('returns tool failures to the model without claiming success', async () => {
    const client = new FakeClient([
      response('', [toolCall('hello')]),
      response('The tool failed.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(
      echoTool({
        execute: () => {
          throw new Error('boom');
        },
      }),
    );

    const result = await createLoop(client, registry).run({
      userMessage: 'Call echo.',
    });

    expect(result.receipts[0]).toMatchObject({
      status: 'failure',
      verification: 'not_applicable',
      error: 'boom',
    });

    const toolMessage = client.requests[1]?.messages.find((message) => message.role === 'tool');

    expect(toolMessage?.content).toContain('"status":"failure"');
    expect(toolMessage?.content).toContain('"error":"boom"');
  });

  it('truncates oversized tool results before returning them to the model', async () => {
    const client = new FakeClient([
      response('', [toolCall('hello')]),
      response('Oversized output was truncated.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(
      echoTool({
        execute: () => ({ echo: 'x'.repeat(1_000) }),
      }),
    );

    await createLoop(client, registry, { maxToolOutputChars: 50 }).run({
      userMessage: 'Call echo.',
    });

    const toolMessage = client.requests[1]?.messages.find((message) => message.role === 'tool');
    const content = toolMessage?.content ?? '';

    expect(content.length).toBeLessThanOrEqual(50);
    expect(content).toContain('[truncated]');
  });

  it('records cancellation without calling Ollama', async () => {
    const client = new FakeClient([]);
    const registry = new ToolRegistry();
    registry.register(echoTool());
    const controller = new AbortController();
    controller.abort();

    const result = await createLoop(client, registry).run({
      userMessage: 'Call echo.',
      signal: controller.signal,
      executionId: 'cancelled-exec',
    });

    expect(result.status).toBe('cancelled');
    expect(result.executionId).toBe('cancelled-exec');
    expect(result.toolCallCount).toBe(0);
    expect(result.receipts).toEqual([]);
    expect(client.requests).toHaveLength(0);
  });
});
