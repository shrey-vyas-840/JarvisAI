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
import { BackendRouter } from '../src/orchestration/backend-router.js';

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

interface BrowserFixtureCall {
  name: string;
  args: Record<string, unknown>;
}

function browserWorkflowRegistry(
  executed: BrowserFixtureCall[],
  options: {
    missingTabId?: boolean;
    failNavigation?: boolean;
    failedVerificationTool?: string;
  } = {},
): ToolRegistry {
  const registry = new ToolRegistry();
  const names = [
    'browser_connect_profile',
    'browser_new_tab',
    'browser_navigate',
    'browser_get_page_url',
    'browser_get_page_title',
    'browser_get_page_text',
  ];
  for (const name of names) {
    registry.register({
      name,
      description: `Fixture for ${name}`,
      parameters: { type: 'object', properties: {}, additionalProperties: true },
      argumentsSchema: z.record(z.string(), z.unknown()),
      execute: (args) => {
        executed.push({ name, args });
        if (name === 'browser_connect_profile') {
          return { connected: true, sessionId: 'session-1' };
        }
        if (name === 'browser_new_tab') {
          return {
            created: true,
            tab: {
              ...(options.missingTabId ? {} : { id: 'jarvis-tab-1' }),
              url: 'about:blank',
              isJarvisOwned: true,
              isCurrent: true,
            },
          };
        }
        if (name === 'browser_navigate') {
          if (options.failNavigation) {
            throw new Error('fixture navigation failure');
          }
          return { url: args.url, title: 'Example Domain', recovered: false };
        }
        if (name === 'browser_get_page_url') {
          return { url: args.expectedUrl };
        }
        if (name === 'browser_get_page_title') {
          return { title: 'Example Domain' };
        }
        return {
          text: 'Example Domain body text',
          totalLength: 24,
          returnedLength: 24,
          truncated: false,
        };
      },
      verify: () => name !== options.failedVerificationTool,
      timeoutMs: 1_000,
      permission: 'read-only',
    });
  }
  return registry;
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

  it('executes a model-generated dependent plan through ToolRegistry and returns evidence to the final model round', async () => {
    const client = new FakeClient([
      response(
        JSON.stringify({
          goal: 'Echo a value and then use the observed result.',
          steps: [
            {
              id: 'first',
              description: 'Echo the original value.',
              tool: 'echo',
              args: { value: 'hello' },
              dependsOn: [],
              argumentSources: {},
              preconditions: ['The echo tool is registered.'],
              expectedOutcome: 'The value is returned.',
              verificationMethod: 'Check the tool receipt.',
              failurePolicy: 'Stop if the receipt fails.',
              requiresVerifiedReceipt: true,
            },
            {
              id: 'second',
              description: 'Echo the verified previous result.',
              tool: 'echo',
              args: {},
              dependsOn: ['first'],
              argumentSources: { value: { stepId: 'first', resultPath: ['echo'] } },
              preconditions: ['The first receipt is verified.'],
              expectedOutcome: 'The observed value is used.',
              verificationMethod: 'Check the tool receipt.',
              failurePolicy: 'Stop if the receipt fails.',
              requiresVerifiedReceipt: true,
            },
          ],
        }),
      ),
      response('Both planned tool results were verified.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());
    const loop = new AgentLoop({
      client,
      registry,
      logger,
      backendRouter: new BackendRouter({ registry, logger }),
      planningEnabled: true,
      now: () => new Date('2026-11-07T00:00:00.000Z'),
      idFactory: () => 'planned-execution',
    });

    const result = await loop.run({
      userMessage: 'Use the available tool to process hello twice.',
    });

    expect(result.status).toBe('success');
    expect(result.plan?.state).toBe('COMPLETED');
    expect(result.receipts.map((receipt) => receipt.result)).toEqual([
      { echo: 'hello' },
      { echo: 'hello' },
    ]);
    expect(result.workflowTrace?.every((step) => step.receipt.verification === 'verified')).toBe(
      true,
    );
    expect(client.requests).toHaveLength(2);
    expect(client.requests[0]?.format).toBe('json');
    expect(
      client.requests[1]?.messages.some((message) => message.content.includes('"echo":"hello"')),
    ).toBe(true);
  });

  it('observes a completed phase and dynamically executes a new model-planned phase', async () => {
    const makePlan = (id: string, value: string, continuationRequired: boolean): string =>
      JSON.stringify({
        goal: 'Handle an unfamiliar two-phase task.',
        continuationRequired,
        steps: [
          {
            id,
            description: `Observe ${value}.`,
            tool: 'echo',
            args: { value },
            dependsOn: [],
            argumentSources: {},
            preconditions: ['The tool is registered.'],
            expectedOutcome: 'The value is observed.',
            verificationMethod: 'Check the verified receipt.',
            failurePolicy: 'Stop this phase if it fails.',
            requiresVerifiedReceipt: true,
          },
        ],
      });
    const client = new FakeClient([
      response(makePlan('observe', 'first-observation', true)),
      response(makePlan('continue', 'derived-next-step', false)),
      response('Both independently verified phases completed.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());
    const loop = new AgentLoop({
      client,
      registry,
      logger,
      backendRouter: new BackendRouter({ registry, logger }),
      planningEnabled: true,
      limits: { maxToolRounds: 4, maxToolCalls: 4 },
    });

    const result = await loop.run({ userMessage: 'Complete an unfamiliar task in phases.' });

    expect(result.status).toBe('success');
    expect(result.planHistory).toHaveLength(2);
    expect(result.receipts.map((receipt) => receipt.result)).toEqual([
      { echo: 'first-observation' },
      { echo: 'derived-next-step' },
    ]);
    expect(
      client.requests[1]?.messages.some((message) => message.content.includes('first-observation')),
    ).toBe(true);
  });

  it('repairs one schema-invalid planner response before executing a validated plan', async () => {
    const validPlan = JSON.stringify({
      goal: 'Use the available tool.',
      continuationRequired: false,
      steps: [{ id: 'echo', tool: 'echo', args: { value: 'repaired' } }],
    });
    const client = new FakeClient([
      response(JSON.stringify({ status: 'blocked', reason: 'tools unavailable' })),
      response(validPlan),
      response('The verified result is repaired.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());
    const loop = new AgentLoop({
      client,
      registry,
      logger,
      backendRouter: new BackendRouter({ registry, logger }),
      planningEnabled: true,
      limits: { maxToolRounds: 4, maxToolCalls: 4 },
    });

    const result = await loop.run({ userMessage: 'Complete a generic task.' });

    expect(result.status).toBe('success');
    expect(result.receipts).toHaveLength(1);
    expect(client.requests).toHaveLength(3);
    expect(client.requests[1]?.format).toBe('json');
    expect(client.requests[1]?.messages.at(-1)?.content).toContain(
      'previous planning response was rejected',
    );
  });

  it('refuses a replan that repeats a verified non-idempotent action', async () => {
    const plan = (continuationRequired: boolean): string =>
      JSON.stringify({
        goal: 'Avoid duplicate action delivery.',
        continuationRequired,
        steps: [
          {
            id: 'create',
            description: 'Create one unique resource.',
            tool: 'create_resource',
            args: { name: 'unique' },
            dependsOn: [],
            argumentSources: {},
            preconditions: ['The name is unique.'],
            expectedOutcome: 'The resource exists.',
            verificationMethod: 'Check the receipt.',
            failurePolicy: 'Inspect before retrying.',
            requiresVerifiedReceipt: true,
          },
          ...(continuationRequired
            ? []
            : [
                {
                  id: 'observe',
                  description: 'Observe state before another action.',
                  tool: 'read_state',
                  args: {},
                  dependsOn: [],
                  argumentSources: {},
                  preconditions: [],
                  expectedOutcome: 'The current state is observed.',
                  verificationMethod: 'Check the receipt.',
                  failurePolicy: 'Stop if unavailable.',
                  requiresVerifiedReceipt: true,
                },
              ]),
        ],
      });
    const client = new FakeClient([
      response(plan(true)),
      response(plan(false)),
      response('Action was not repeated.'),
    ]);
    const registry = new ToolRegistry();
    registry.register({
      name: 'create_resource',
      description: 'Create one resource.',
      parameters: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
      argumentsSchema: z.object({ name: z.string().min(1) }),
      execute: (args) => ({ created: args.name }),
      verify: (args, output) =>
        typeof output === 'object' &&
        output !== null &&
        'created' in output &&
        output.created === args.name,
      timeoutMs: 1000,
      permission: 'read-only',
    });
    registry.register({
      name: 'read_state',
      description: 'Read current state.',
      parameters: { type: 'object', properties: {}, required: [] },
      argumentsSchema: z.object({}),
      execute: () => ({ observed: true }),
      verify: () => true,
      timeoutMs: 1000,
      permission: 'read-only',
    });
    const loop = new AgentLoop({
      client,
      registry,
      logger,
      backendRouter: new BackendRouter({ registry, logger }),
      planningEnabled: true,
      limits: { maxToolRounds: 4, maxToolCalls: 4 },
    });

    const result = await loop.run({ userMessage: 'Create a unique resource and verify it.' });

    expect(result.status).toBe('failure');
    expect(result.error).toContain('repeat completed non-idempotent action');
    expect(result.receipts).toHaveLength(1);
  });

  it('requires an explicitly named tool and withholds other tools after it completes', async () => {
    const client = new FakeClient([
      response('', [toolCall('runtime', 'echo')]),
      response('The requested value was runtime.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool());
    registry.register(echoTool({ name: 'auxiliary' }));

    const result = await createLoop(client, registry).run({
      userMessage: 'Call echo exactly once. Report the actual result. Do not call any other tool.',
    });

    expect(result.status).toBe('success');
    expect(result.receipts).toHaveLength(1);
    expect(client.requests[0]?.tools?.map((tool) => tool.function.name)).toEqual(['echo']);
    expect(client.requests[1]?.tools).toEqual([]);
    const nextRequestToolMessage = client.requests[1]?.messages.find(
      (message) => message.role === 'tool',
    );
    expect(nextRequestToolMessage?.content).toContain('"echo":"runtime"');
  });

  it('enforces explicitly named tool calls in the order written by the user', async () => {
    const client = new FakeClient([
      response('', [toolCall('status', 'desktop_ax_status')]),
      response('', [toolCall('windows', 'desktop_list_windows')]),
      response('Status and windows retrieved.'),
    ]);
    const registry = new ToolRegistry();
    registry.register(echoTool({ name: 'desktop_list_windows' }));
    registry.register(echoTool({ name: 'desktop_ax_status' }));

    const result = await createLoop(client, registry).run({
      userMessage:
        'Call desktop_ax_status exactly once, then desktop_list_windows exactly once. Report the actual results.',
    });

    expect(result.status).toBe('success');
    expect(result.receipts.map((receipt) => receipt.toolName)).toEqual([
      'desktop_ax_status',
      'desktop_list_windows',
    ]);
    expect(client.requests.slice(0, 2).map((request) => request.tools?.[0]?.function.name)).toEqual(
      ['desktop_ax_status', 'desktop_list_windows'],
    );
  });

  it('includes the failed required tool receipt error in the AgentLoop result', async () => {
    const client = new FakeClient([response('', [toolCall('snapshot', 'desktop_ax_snapshot')])]);
    const registry = new ToolRegistry();
    registry.register(
      echoTool({
        name: 'desktop_ax_snapshot',
        execute: () => {
          throw new Error('Accessibility snapshot failed.');
        },
      }),
    );

    const result = await createLoop(client, registry).run({
      userMessage: 'Call desktop_ax_snapshot exactly once and report the actual result.',
    });

    expect(result.status).toBe('failure');
    expect(result.error).toBe(
      'Required tool failed: desktop_ax_snapshot: Accessibility snapshot failed.',
    );
    expect(result.receipts[0]?.error).toBe('Accessibility snapshot failed.');
  });

  it('fails an explicit tool task when the model answers without executing the tool', async () => {
    const client = new FakeClient([response('Everything is operational.')]);
    const registry = new ToolRegistry();
    registry.register(echoTool());

    const result = await createLoop(client, registry).run({
      userMessage: 'Call echo and report its result.',
    });

    expect(result.status).toBe('failure');
    expect(result.error).toBe('Required tool was not called: echo');
    expect(result.receipts).toEqual([]);
  });

  it('executes a natural browser request as ordered dependent tool calls', async () => {
    const names = [
      'browser_connect_profile',
      'browser_new_tab',
      'browser_navigate',
      'browser_get_page_url',
      'browser_get_page_title',
      'browser_get_page_text',
    ];
    const client = new FakeClient([
      ...names.map((name) => response('', [toolCall(name, name)])),
      response('Example Domain verified.'),
    ]);
    const executed: BrowserFixtureCall[] = [];
    const registry = browserWorkflowRegistry(executed);

    const result = await createLoop(client, registry).run({
      userMessage:
        'Open a new browser tab, navigate to https://example.com, read the URL, title and visible page text.',
    });

    expect(result.status, result.error ?? 'no agent error').toBe('success');
    expect(result.receipts.map((receipt) => receipt.toolName)).toEqual(names);
    expect(result.receipts.every((receipt) => receipt.verification === 'verified')).toBe(true);
    expect(executed.map((call) => call.name)).toEqual(names);
    expect(
      client.requests.map((request) => request.tools?.map((tool) => tool.function.name)),
    ).toEqual([[names[0]], [names[1]], [names[2]], [names[3]], [names[4]], [names[5]], undefined]);
    expect(
      client.requests[5]?.messages.some((message) =>
        message.content.includes('browser_get_page_url'),
      ),
    ).toBe(true);
  });

  it('runs the deterministic browser sequence when Qwen proposes an unexpected snapshot', async () => {
    const names = [
      'browser_connect_profile',
      'browser_new_tab',
      'browser_navigate',
      'browser_get_page_url',
      'browser_get_page_title',
      'browser_get_page_text',
    ];
    const proposals = [...names.map((name) => response('', [toolCall(name, name)]))];
    proposals[2] = response('', [toolCall('snapshot', 'browser_get_page_snapshot')]);
    const client = new FakeClient([...proposals, response('Example Domain verified.')]);
    const executed: BrowserFixtureCall[] = [];
    const result = await createLoop(client, browserWorkflowRegistry(executed)).run({
      userMessage:
        'Open a new JARVIS-owned tab, navigate to https://example.com, read the current URL, title and visible page text, report the verified results, and leave the new tab open.',
    });

    expect(result.status).toBe('success');
    expect(result.toolCallCount).toBe(6);
    expect(result.plan?.state).toBe('COMPLETED');
    expect(result.plan?.stateHistory?.map((entry) => entry.state)).toEqual([
      'PLANNED',
      'RUNNING',
      'COMPLETED',
    ]);
    expect(result.plan?.steps.every((step) => step.state === 'VERIFIED')).toBe(true);
    expect(result.plan?.steps.every((step) => step.receipt?.verification === 'verified')).toBe(
      true,
    );
    expect(executed.map((call) => call.name)).toEqual(names);
    expect(executed.filter((call) => call.name === 'browser_navigate')).toHaveLength(1);
    expect(executed.some((call) => call.name === 'browser_get_page_snapshot')).toBe(false);
    expect(executed[2]?.args).toEqual({ url: 'https://example.com/', tabId: 'jarvis-tab-1' });
    expect(executed.slice(3).every((call) => call.args.tabId === 'jarvis-tab-1')).toBe(true);
    expect(result.workflowTrace?.[2]).toMatchObject({
      expectedToolName: 'browser_navigate',
      actualToolNames: ['browser_get_page_snapshot'],
      mismatch: true,
      receipt: { status: 'success', verification: 'verified' },
    });
    expect(result.workflowTrace).toHaveLength(6);
    const finalRequest = client.requests.at(-1);
    expect(finalRequest?.tools).toBeUndefined();
    expect(
      finalRequest?.messages.some((message) =>
        message.content.includes('Example Domain body text'),
      ),
    ).toBe(true);
  });

  it('records a normal expected browser tool proposal without a mismatch', async () => {
    const names = [
      'browser_connect_profile',
      'browser_new_tab',
      'browser_navigate',
      'browser_get_page_url',
      'browser_get_page_title',
      'browser_get_page_text',
    ];
    const client = new FakeClient([
      ...names.map((name) => response('', [toolCall(name, name)])),
      response('Example Domain verified.'),
    ]);
    const executed: BrowserFixtureCall[] = [];
    const result = await createLoop(client, browserWorkflowRegistry(executed)).run({
      userMessage:
        'Open a new tab, navigate to https://example.com, read the URL, title and visible page text, and report the verified results.',
    });

    expect(result.status).toBe('success');
    expect(result.workflowTrace?.every((step) => !step.mismatch)).toBe(true);
    expect(result.workflowTrace?.every((step) => step.receipt.verification === 'verified')).toBe(
      true,
    );
  });

  it('fails safely when the created browser tab has no stable ID', async () => {
    const client = new FakeClient([
      response('', [toolCall('connect', 'browser_connect_profile')]),
      response('', [toolCall('new', 'browser_new_tab')]),
    ]);
    const executed: BrowserFixtureCall[] = [];
    const result = await createLoop(
      client,
      browserWorkflowRegistry(executed, { missingTabId: true }),
    ).run({
      userMessage:
        'Open a new tab, navigate to https://example.com, read the URL, title and visible page text, and report the verified results.',
    });

    expect(result.status).toBe('failure');
    expect(result.error).toContain('argument tabId');
    expect(executed.map((call) => call.name)).toEqual([
      'browser_connect_profile',
      'browser_new_tab',
    ]);
    expect(result.plan?.steps[2]?.state).toBe('FAILED');
    expect(result.plan?.steps.slice(3).every((step) => step.state === 'SKIPPED')).toBe(true);
  });

  it('stops dependent browser reads after navigation fails', async () => {
    const names = ['browser_connect_profile', 'browser_new_tab', 'browser_navigate'];
    const client = new FakeClient(names.map((name) => response('', [toolCall(name, name)])));
    const executed: BrowserFixtureCall[] = [];
    const result = await createLoop(
      client,
      browserWorkflowRegistry(executed, { failNavigation: true }),
    ).run({
      userMessage:
        'Open a new tab, navigate to https://example.com, read the URL, title and visible page text, and report the verified results.',
    });

    expect(result.status).toBe('failure');
    expect(result.error).toBe('fixture navigation failure');
    expect(executed.map((call) => call.name)).toEqual(names);
    expect(result.plan?.steps[2]?.retryCount).toBe(0);
    expect(result.plan?.steps.slice(3).every((step) => step.state === 'SKIPPED')).toBe(true);
  });

  it('does not complete a browser plan when a required tool receipt is unverified', async () => {
    const names = [
      'browser_connect_profile',
      'browser_new_tab',
      'browser_navigate',
      'browser_get_page_url',
      'browser_get_page_title',
    ];
    const client = new FakeClient(names.map((name) => response('', [toolCall(name, name)])));
    const executed: BrowserFixtureCall[] = [];
    const result = await createLoop(
      client,
      browserWorkflowRegistry(executed, { failedVerificationTool: 'browser_get_page_title' }),
    ).run({
      userMessage:
        'Open a new tab, navigate to https://example.com, read the URL, title and visible page text, and report the verified results.',
    });

    expect(result.status).toBe('failure');
    expect(result.plan?.state).toBe('PARTIALLY_COMPLETED');
    expect(result.plan?.steps[4]?.state).toBe('FAILED');
    expect(result.plan?.steps[5]?.state).toBe('SKIPPED');
    expect(client.requests).toHaveLength(5);
  });

  it('propagates AgentLoop cancellation to Orchestrator before browser tool execution', async () => {
    const controller = new AbortController();
    const client: ChatClient = {
      chat: () => {
        controller.abort();
        return Promise.resolve(response('', [toolCall('connect', 'browser_connect_profile')]));
      },
    };
    const executed: BrowserFixtureCall[] = [];
    const result = await createLoop(client, browserWorkflowRegistry(executed)).run({
      userMessage:
        'Open a new tab, navigate to https://example.com, read the URL, title and visible page text, and report the verified results.',
      signal: controller.signal,
    });

    expect(result.status).toBe('cancelled');
    expect(executed).toEqual([]);
    expect(result.plan?.state).toBe('FAILED');
  });

  it('rejects an unsafe URL before connecting or creating a tab', async () => {
    const client = new FakeClient([]);
    const executed: BrowserFixtureCall[] = [];
    const result = await createLoop(client, browserWorkflowRegistry(executed)).run({
      userMessage:
        'Open a new tab, navigate to http://127.0.0.1/private, read the URL, title and visible page text, and report the verified results.',
    });

    expect(result.status).toBe('failure');
    expect(result.error).toContain('private/local network');
    expect(executed).toEqual([]);
    expect(client.requests).toEqual([]);
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
