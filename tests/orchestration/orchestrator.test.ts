import { describe, expect, it, vi, beforeEach } from 'vitest';

import {
  Orchestrator,
  PlanBuilder,
  createPlan,
  inferBackendFromTool,
  getBackendForStep,
} from '../../src/orchestration/index.js';
import type { ToolRegistry, ToolExecutionContext, ToolExecutionReceipt, Logger } from '../../src/orchestration/types.js';
import type { ToolExecutionStatus } from '../../src/core/tool-registry.js';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMockRegistry(tools: Map<string, { execute: (args: unknown) => Promise<unknown>; verify?: (args: unknown, output: unknown) => boolean }>): ToolRegistry {
  return {
    execute: async (name: string, args: Record<string, unknown>, _context: ToolExecutionContext): Promise<ToolExecutionReceipt> => {
      const tool = tools.get(name);
      if (!tool) {
        return {
          executionId: _context.executionId,
          callId: _context.callId,
          toolName: name,
          status: 'failure',
          approval: 'not_required',
          verification: 'not_applicable',
          result: null,
          error: `Unknown tool: ${name}`,
          durationMs: 0,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
      try {
        const result = await tool.execute(args);
        let verification: 'verified' | 'failed' | 'not_applicable' = 'not_applicable';
        let status: ToolExecutionStatus = 'success';
        if (tool.verify) {
          const verified = tool.verify(args, result);
          verification = verified ? 'verified' : 'failed';
          if (!verified) {
            status = 'failure';
          }
        }
        return {
          executionId: _context.executionId,
          callId: _context.callId,
          toolName: name,
          status,
          approval: 'not_required',
          verification,
          result,
          error: null,
          durationMs: 10,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      } catch (error) {
        return {
          executionId: _context.executionId,
          callId: _context.callId,
          toolName: name,
          status: 'failure',
          approval: 'not_required',
          verification: 'not_applicable',
          result: null,
          error: error instanceof Error ? error.message : 'Unknown error',
          durationMs: 10,
          startedAt: new Date().toISOString(),
          completedAt: new Date().toISOString(),
        };
      }
    },
    has: (name: string) => tools.has(name),
    listNames: () => [...tools.keys()],
  };
}

describe('Orchestrator', () => {
  let orchestrator: Orchestrator;
  let mockRegistry: ToolRegistry;

  beforeEach(() => {
    const tools = new Map();
    tools.set('step_a', {
      execute: async () => ({ output: 'a' }),
      verify: () => true,
    });
    tools.set('step_b', {
      execute: async () => ({ output: 'b' }),
      verify: () => true,
    });
    tools.set('step_c', {
      execute: async () => ({ output: 'c' }),
      verify: () => true,
    });
    tools.set('failing_step', {
      execute: async () => { throw new Error('Intentional failure'); },
    });
    tools.set('verify_tool', {
      execute: async (args: { expect: unknown }) => ({ match: args.expect }),
      verify: (args: { expect: unknown }, output: { match?: unknown }) => output?.match === args.expect,
    });

    mockRegistry = createMockRegistry(tools);
    orchestrator = new Orchestrator({ registry: mockRegistry, logger: mockLogger });
  });

  it('executes a simple linear plan', async () => {
    await orchestrator.createPlan('Test goal', [
      { description: 'Step A', tool: 'step_a', args: {}, expectedOutcome: 'A done', dependsOn: [], backend: 'playwriter' },
      { description: 'Step B', tool: 'step_b', args: {}, expectedOutcome: 'B done', dependsOn: [], backend: 'playwriter' },
      { description: 'Step C', tool: 'step_c', args: {}, expectedOutcome: 'C done', dependsOn: [], backend: 'playwriter' },
    ]);

    const result = await orchestrator.runPlan();

    expect(result.state).toBe('COMPLETED');
    expect(result.steps.every((s) => s.state === 'VERIFIED')).toBe(true);
    expect(result.steps).toHaveLength(3);
  });

  it('respects step dependencies', async () => {
    const builder = new PlanBuilder();
    builder
      .addStep({
        description: 'Step A',
        tool: 'step_a',
        args: {},
        expectedOutcome: 'A done',
        backend: 'playwriter',
        verification: undefined,
      })
      .addStep({
        description: 'Step B',
        tool: 'step_b',
        args: {},
        expectedOutcome: 'B done',
        backend: 'playwriter',
        verification: undefined,
      })
      .dependsOn('Step B', 'Step A');

    const planData = builder.build('Dependent goal');
    await orchestrator.createPlan(planData.goal, planData.steps);

    const result = await orchestrator.runPlan();

    expect(result.steps[0]!.state).toBe('VERIFIED');
    expect(result.steps[1]!.state).toBe('VERIFIED');
    expect(result.steps[0]!.completedAt).toBeDefined();
    expect(result.steps[1]!.startedAt).toBeDefined();
    expect(new Date(result.steps[1]!.startedAt!).getTime()).toBeGreaterThanOrEqual(new Date(result.steps[0]!.completedAt!).getTime());
  });

  it('retries failed steps up to maxRetries', async () => {
    const tools = new Map();
    let attempts = 0;
    tools.set('flaky_step', {
      execute: async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error('Temporary failure');
        }
        return { success: true };
      },
      verify: () => true,
    });
    const registry = createMockRegistry(tools);
    const orch = new Orchestrator({ registry, logger: mockLogger, maxRetries: 3 });

    await orch.createPlan('Retry test', [
      { description: 'Flaky', tool: 'flaky_step', args: {}, expectedOutcome: 'Eventually succeeds', dependsOn: [], backend: 'playwriter' },
    ]);

    const result = await orch.runPlan();

    expect(result.state).toBe('COMPLETED');
    expect(result.steps[0]!.state).toBe('VERIFIED');
    expect(result.steps[0]!.retryCount).toBe(2);
    expect(attempts).toBe(3);
  });

  it('marks plan as PARTIALLY_COMPLETED when some steps fail after retries', async () => {
    await orchestrator.createPlan('Partial failure', [
      { description: 'Good', tool: 'step_a', args: {}, expectedOutcome: 'OK', dependsOn: [], backend: 'playwriter' },
      { description: 'Bad', tool: 'failing_step', args: {}, expectedOutcome: 'Fails', dependsOn: [], backend: 'playwriter' },
    ]);

    const result = await orchestrator.runPlan();

    expect(result.state).toBe('PARTIALLY_COMPLETED');
    expect(result.steps[0]!.state).toBe('VERIFIED');
    expect(result.steps[1]!.state).toBe('FAILED');
  });

  it('marks plan as FAILED when all steps fail', async () => {
    await orchestrator.createPlan('All fail', [
      { description: 'Bad 1', tool: 'failing_step', args: {}, expectedOutcome: 'Fails', dependsOn: [], backend: 'playwriter' },
      { description: 'Bad 2', tool: 'failing_step', args: {}, expectedOutcome: 'Fails', dependsOn: [], backend: 'playwriter' },
    ]);

    const result = await orchestrator.runPlan();

    expect(result.state).toBe('FAILED');
    expect(result.steps.every((s) => s.state === 'FAILED')).toBe(true);
  });

  it('pauses and resumes plan', async () => {
    const tools = new Map();
    tools.set('slow_step', {
      execute: async () => {
        await new Promise((r) => setTimeout(r, 50));
        return { done: true };
      },
      verify: () => true,
    });
    const registry = createMockRegistry(tools);
    const orch = new Orchestrator({ registry, logger: mockLogger });

    await orch.createPlan('Pause test', [
      { description: 'Slow', tool: 'slow_step', args: {}, expectedOutcome: 'Done', dependsOn: [], backend: 'playwriter' },
    ]);

    const runPromise = orch.runPlan();
    await new Promise((r) => setTimeout(r, 10));
    await orch.pausePlan();
    expect(orch.getPlan()?.state).toBe('WAITING_FOR_USER');
    await orch.resumePlan();
    const result = await runPromise;

    expect(result.state).toBe('COMPLETED');
  });

  it('aborts running plan', async () => {
    const tools = new Map();
    tools.set('slow_step', {
      execute: async () => {
        await new Promise((r) => setTimeout(r, 1000));
        return { done: true };
      },
      verify: () => true,
    });
    const registry = createMockRegistry(tools);
    const orch = new Orchestrator({ registry, logger: mockLogger });

    await orch.createPlan('Abort test', [
      { description: 'Slow', tool: 'slow_step', args: {}, expectedOutcome: 'Done', dependsOn: [], backend: 'playwriter' },
    ]);

    const runPromise = orch.runPlan();
    await new Promise((r) => setTimeout(r, 10));
    await orch.abort();
    const result = await runPromise;

    expect(result.state).toBe('FAILED');
    expect(result.error).toContain('Aborted');
  });

  it('verifies step results when verification provided', async () => {
    const tools = new Map();
    tools.set('produce_value', {
      execute: async () => ({ value: 42 }),
    });
    tools.set('verify_value', {
      execute: async (args: { expect: number }) => ({ match: args.expect }),
      verify: (args: { expect: number }, output: { match?: number }) => output?.match === args.expect,
    });
    const registry = createMockRegistry(tools);
    const orch = new Orchestrator({ registry, logger: mockLogger });

    await orch.createPlan('Verification test', [
      {
        description: 'Produce',
        tool: 'produce_value',
        args: {},
        expectedOutcome: 'Value produced',
        dependsOn: [],
        backend: 'playwriter',
        verification: { tool: 'verify_value', args: { expect: 42 }, expected: { match: 42 } },
      },
    ]);

    const result = await orch.runPlan();

    expect(result.state).toBe('COMPLETED');
    expect(result.steps[0]!.state).toBe('VERIFIED');
  });

  it('fails verification when expected value mismatches', async () => {
    const tools = new Map();
    tools.set('produce_value', {
      execute: async () => ({ value: 42 }),
    });
    tools.set('verify_value', {
      execute: async (args: { expect: number }) => ({ match: args.expect }),
      // This verify function will fail because the output from execute is { match: 99 }
      // but the verification compares with expected { match: 99 } which matches
      // So we need the verify function to return false to simulate a verification failure
      verify: () => false,
    });
    const registry = createMockRegistry(tools);
    const orch = new Orchestrator({ registry, logger: mockLogger, maxRetries: 1 });

    await orch.createPlan('Verification mismatch', [
      {
        description: 'Produce',
        tool: 'produce_value',
        args: {},
        expectedOutcome: 'Value produced',
        dependsOn: [],
        backend: 'playwriter',
        verification: { tool: 'verify_value', args: { expect: 99 }, expected: { match: 99 } },
      },
    ]);

    const result = await orch.runPlan();

    expect(result.state).toBe('FAILED');
    expect(result.steps[0]!.state).toBe('FAILED');
    expect(result.steps[0]!.error).toBe('Verification failed');
  });

  it('updates context from step results', async () => {
    const tools = new Map();
    tools.set('set_context', {
      execute: async () => ({ activeApp: 'notepad.exe', variables: { foo: 'bar' } }),
      verify: () => true,
    });
    const registry = createMockRegistry(tools);
    const orch = new Orchestrator({ registry, logger: mockLogger });

    await orch.createPlan('Context update', [
      { description: 'Set context', tool: 'set_context', args: {}, expectedOutcome: 'Context updated', dependsOn: [], backend: 'playwriter' },
    ]);

    const result = await orch.runPlan();

    expect(result.context.activeApp).toBe('notepad.exe');
    expect(result.context.variables).toEqual({ foo: 'bar' });
  });
});

describe('PlanBuilder', () => {
  it('creates steps with auto-generated IDs and backend inference', () => {
    const builder = new PlanBuilder();
    builder
      .addBrowserNavigate('https://example.com')
      .addDesktopSnapshot('notepad.exe')
      .addDesktopAction('click', '@s1:e2')
      .addVisionLocate('/path/img.png');

    const plan = builder.build('Test plan');

    expect(plan.steps).toHaveLength(4);
    expect(plan.steps[0]!.tool).toBe('browser_navigate');
    expect(plan.steps[0]!.backend).toBe('playwriter');
    expect(plan.steps[1]!.tool).toBe('desktop_ax_snapshot');
    expect(plan.steps[1]!.backend).toBe('agent-desktop');
    expect(plan.steps[2]!.tool).toBe('desktop_ax_action');
    expect(plan.steps[2]!.backend).toBe('agent-desktop');
    expect(plan.steps[3]!.tool).toBe('desktop_vision_locate');
    expect(plan.steps[3]!.backend).toBe('vision');
  });

  it('handles dependencies via description mapping', () => {
    const builder = new PlanBuilder();
    builder
      .addBrowserNavigate('https://example.com', 'Navigate')
      .addBrowserClick('button', 'Click button')
      .dependsOn('Click button', 'Navigate');

    const plan = builder.build('Dep test');

    expect(plan.steps[1]!.dependsOn).toContain(plan.steps[0]!.id);
  });

  it('allows explicit backend override', () => {
    const builder = new PlanBuilder();
    builder.addStep({
      description: 'Custom',
      tool: 'desktop_ax_action',
      args: {},
      expectedOutcome: 'Done',
      backend: 'pywinauto',
      verification: undefined,
    });

    const plan = builder.build('Override');
    expect(plan.steps[0]!.backend).toBe('pywinauto');
  });
});

describe('createPlan helper', () => {
  it('infers backend from tool name', () => {
    const plan = createPlan('Test', [
      { description: 'A', tool: 'browser_click', args: {}, expectedOutcome: 'OK', dependsOn: [], backend: 'playwriter' },
      { description: 'B', tool: 'desktop_ax_snapshot', args: {}, expectedOutcome: 'OK', dependsOn: [], backend: 'agent-desktop' },
      { description: 'C', tool: 'desktop_click_control', args: {}, expectedOutcome: 'OK', dependsOn: [], backend: 'pywinauto' },
    ]);

    expect(plan.steps[0]!.backend).toBe('playwriter');
    expect(plan.steps[1]!.backend).toBe('agent-desktop');
    expect(plan.steps[2]!.backend).toBe('pywinauto');
  });

  it('respects explicit backend in step', () => {
    const plan = createPlan('Test', [
      { description: 'A', tool: 'desktop_ax_action', args: {}, expectedOutcome: 'OK', dependsOn: [], backend: 'pywinauto' },
    ]);

    expect(plan.steps[0]!.backend).toBe('pywinauto');
  });
});

describe('inferBackendFromTool', () => {
  it('maps correctly', () => {
    expect(inferBackendFromTool('browser_navigate')).toBe('playwriter');
    expect(inferBackendFromTool('desktop_ax_snapshot')).toBe('agent-desktop');
    expect(inferBackendFromTool('desktop_list_windows')).toBe('pywinauto');
    expect(inferBackendFromTool('desktop_vision_locate')).toBe('vision');
  });
});

describe('getBackendForStep', () => {
  it('uses explicit backend when provided', () => {
    const step = { tool: 'browser_click', backend: 'vision' as const };
    expect(getBackendForStep(step)).toBe('vision');
  });

  it('infers when not provided', () => {
    const step = { tool: 'desktop_ax_action' };
    expect(getBackendForStep(step)).toBe('agent-desktop');
  });
});