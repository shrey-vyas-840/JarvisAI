import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

import type {
  Plan,
  Step,
  PlanState,
  StepState,
  ExecutionContext,
  OrchestratorOptions,
  ToolRegistry,
  ToolExecutionContext,
  Logger,
  PersistedPlan,
} from './types.js';

const DEFAULT_MAX_RETRIES = 2;

function isTerminalPlanState(state: PlanState): boolean {
  return state === 'COMPLETED' || state === 'PARTIALLY_COMPLETED' || state === 'FAILED';
}

function allDependenciesMet(step: Step, steps: Step[]): boolean {
  return step.dependsOn.every((depId) => {
    const dep = steps.find((s) => s.id === depId);
    return dep?.state === 'VERIFIED';
  });
}

function getNextRunnableStep(plan: Plan): Step | null {
  for (const step of plan.steps) {
    if (step.state === 'PENDING' && allDependenciesMet(step, plan.steps)) {
      return step;
    }
  }
  return null;
}

function computePlanState(steps: Step[]): PlanState {
  const verifiedCount = steps.filter((s) => s.state === 'VERIFIED').length;
  const failedCount = steps.filter((s) => s.state === 'FAILED').length;
  const pendingCount = steps.filter((s) => s.state === 'PENDING').length;
  const runningCount = steps.filter((s) => s.state === 'RUNNING').length;
  const waitingCount = steps.filter((s) => s.state === 'WAITING_VERIFICATION').length;

  if (failedCount > 0 && verifiedCount === 0) {
    return 'FAILED';
  }
  if (failedCount > 0 && pendingCount === 0 && runningCount === 0 && waitingCount === 0) {
    return 'PARTIALLY_COMPLETED';
  }
  if (verifiedCount === steps.length) {
    return 'COMPLETED';
  }
  if (runningCount > 0 || waitingCount > 0) {
    return 'RUNNING';
  }
  if (pendingCount > 0) {
    return 'PLANNED';
  }
  return 'PARTIALLY_COMPLETED';
}

function sanitizeForPersistence(obj: unknown): unknown {
  if (obj === null || obj === undefined) {
    return obj;
  }
  if (typeof obj !== 'object') {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(sanitizeForPersistence);
  }
  const record = obj as Record<string, unknown>;
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const lowerKey = key.toLowerCase();
    if (
      lowerKey.includes('password') ||
      lowerKey.includes('secret') ||
      lowerKey.includes('token') ||
      lowerKey.includes('credential') ||
      lowerKey.includes('authorization') ||
      lowerKey.includes('cookie') ||
      lowerKey.includes('session')
    ) {
      sanitized[key] = '[REDACTED]';
    } else if (lowerKey === 'screenshot' || lowerKey === 'image' || lowerKey === 'base64') {
      sanitized[key] = '[OMITTED]';
    } else {
      sanitized[key] = sanitizeForPersistence(value);
    }
  }
  return sanitized;
}

export class Orchestrator {
  private readonly registry: ToolRegistry;
  private readonly logger: Logger;
  private readonly persistencePath: string | null;
  private readonly maxRetries: number;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private currentPlan: Plan | null = null;
  private readonly signal: AbortSignal;
  private readonly abortController: AbortController;

  public constructor(options: OrchestratorOptions) {
    this.registry = options.registry;
    this.logger = options.logger;
    this.persistencePath = options.persistencePath ?? null;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.abortController = new AbortController();
    this.signal = this.abortController.signal;
  }

  public async createPlan(goal: string, steps: (Omit<Step, 'id' | 'state' | 'retryCount'> & { id?: string })[]): Promise<Plan> {
    const plan: Plan = {
      id: this.idFactory(),
      goal,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      steps: steps.map((s) => ({
        ...s,
        id: s.id ?? this.idFactory(),
        state: 'PENDING' as StepState,
        retryCount: 0,
      })),
      state: 'PLANNED',
      currentStepIndex: 0,
      context: this.createEmptyContext(),
    };
    this.currentPlan = plan;
    await this.persist();
    return plan;
  }

  public async loadPlan(planId: string): Promise<Plan | null> {
    if (!this.persistencePath) {
      return null;
    }
    const filePath = resolve(this.persistencePath, `${planId}.json`);
    if (!existsSync(filePath)) {
      return null;
    }
    try {
      const content = readFileSync(filePath, 'utf8');
      const persisted = JSON.parse(content) as PersistedPlan;
      const plan: Plan = {
        ...persisted,
        steps: persisted.steps.map((s) => ({ ...s })),
      };
      this.currentPlan = plan;
      return plan;
    } catch (error) {
      this.logger.error('orchestrator.load_failed', { planId, error: formatError(error) });
      return null;
    }
  }

  public async runPlan(): Promise<Plan> {
    const plan = this.currentPlan;
    if (!plan) {
      throw new Error('No plan loaded');
    }
    if (isTerminalPlanState(plan.state)) {
      return plan;
    }

    plan.state = 'RUNNING';
    plan.updatedAt = this.now().toISOString();
    await this.persist();

    while (!isTerminalPlanState(plan.state) && !this.signal.aborted) {
      const step = getNextRunnableStep(plan);
      if (!step) {
        break;
      }

      plan.currentStepIndex = plan.steps.findIndex((s) => s.id === step.id);
      const result = await this.executeStep(plan, step);
      if (result === 'ABORTED') {
        plan.state = 'FAILED';
        plan.error = 'Orchestration aborted';
        break;
      }
      plan.updatedAt = this.now().toISOString();
      await this.persist();
    }

    if (!isTerminalPlanState(plan.state)) {
      plan.state = computePlanState(plan.steps);
    }
    plan.updatedAt = this.now().toISOString();
    await this.persist();
    return plan;
  }

  public async pausePlan(): Promise<void> {
    const plan = this.currentPlan;
    if (!plan) {
      return;
    }
    if (plan.state === 'RUNNING') {
      plan.state = 'WAITING_FOR_USER';
      plan.updatedAt = this.now().toISOString();
      await this.persist();
    }
  }

  public async resumePlan(): Promise<Plan | null> {
    const plan = this.currentPlan;
    if (!plan) {
      return null;
    }
    if (plan.state === 'WAITING_FOR_USER') {
      plan.state = 'RUNNING';
      plan.updatedAt = this.now().toISOString();
      await this.persist();
      return this.runPlan();
    }
    return plan;
  }

  public async abort(): Promise<void> {
    this.abortController.abort();
    const plan = this.currentPlan;
    if (plan && !isTerminalPlanState(plan.state)) {
      plan.state = 'FAILED';
      plan.error = 'Aborted by user';
      plan.updatedAt = this.now().toISOString();
      await this.persist();
    }
  }

  public getPlan(): Plan | null {
    return this.currentPlan;
  }

  public getContext(): ExecutionContext {
    return this.currentPlan?.context ?? this.createEmptyContext();
  }

  public updateContext(partial: Partial<ExecutionContext>): void {
    if (!this.currentPlan) {
      return;
    }
    this.currentPlan.context = { ...this.currentPlan.context, ...partial };
    this.currentPlan.updatedAt = this.now().toISOString();
  }

  private async executeStep(plan: Plan, step: Step): Promise<'SUCCESS' | 'FAILED' | 'ABORTED'> {
    if (this.signal.aborted) {
      return 'ABORTED';
    }

    step.state = 'RUNNING';
    step.startedAt = this.now().toISOString();
    plan.updatedAt = this.now().toISOString();
    await this.persist();

    this.logger.info('orchestrator.step_started', {
      planId: plan.id,
      stepId: step.id,
      tool: step.tool,
      backend: step.backend,
    });

    const context = this.createToolContext(plan.id, step.id);

    try {
      const receipt = await this.registry.execute(step.tool, step.args, context);

      if (receipt.status === 'cancelled') {
        step.state = 'FAILED';
        step.error = receipt.error ?? 'Cancelled';
        step.completedAt = this.now().toISOString();
        return 'FAILED';
      }

      if (receipt.status === 'failure' || receipt.status === 'timeout') {
        if (step.retryCount < this.maxRetries) {
          step.retryCount += 1;
          step.state = 'PENDING';
          this.logger.warn('orchestrator.step_retry', {
            planId: plan.id,
            stepId: step.id,
            attempt: step.retryCount,
            error: receipt.error,
          });
          return 'FAILED';
        }
        step.state = 'FAILED';
        step.error = receipt.error ?? 'Tool execution failed';
        step.completedAt = this.now().toISOString();
        return 'FAILED';
      }

      if (receipt.status === 'approval_required' || receipt.status === 'approval_unavailable') {
        step.state = 'WAITING_VERIFICATION';
        plan.state = 'WAITING_FOR_USER';
        this.logger.warn('orchestrator.step_awaiting_approval', {
          planId: plan.id,
          stepId: step.id,
          tool: step.tool,
        });
        return 'SUCCESS';
      }

      step.result = receipt.result;
      step.completedAt = this.now().toISOString();

      if (step.verification) {
        step.state = 'WAITING_VERIFICATION';
        const verified = await this.verifyStep(plan, step, context);
        if (verified) {
          step.state = 'VERIFIED';
          this.updateContextFromResult(plan, step, receipt.result);
          this.logger.info('orchestrator.step_verified', { planId: plan.id, stepId: step.id });
        } else {
          if (step.retryCount < this.maxRetries) {
            step.retryCount += 1;
            step.state = 'PENDING';
            this.logger.warn('orchestrator.step_verification_failed_retry', {
              planId: plan.id,
              stepId: step.id,
              attempt: step.retryCount,
            });
            return 'FAILED';
          }
          step.state = 'FAILED';
          step.error = 'Verification failed';
          this.logger.error('orchestrator.step_verification_failed', { planId: plan.id, stepId: step.id });
        }
      } else {
        step.state = 'VERIFIED';
        this.updateContextFromResult(plan, step, receipt.result);
        this.logger.info('orchestrator.step_completed', { planId: plan.id, stepId: step.id });
      }

      return 'SUCCESS';
    } catch (error) {
      if (this.signal.aborted) {
        return 'ABORTED';
      }
      if (step.retryCount < this.maxRetries) {
        step.retryCount += 1;
        step.state = 'PENDING';
        this.logger.warn('orchestrator.step_exception_retry', {
          planId: plan.id,
          stepId: step.id,
          attempt: step.retryCount,
          error: formatError(error),
        });
        return 'FAILED';
      }
      step.state = 'FAILED';
      step.error = formatError(error);
      step.completedAt = this.now().toISOString();
      this.logger.error('orchestrator.step_failed', { planId: plan.id, stepId: step.id, error: formatError(error) });
      return 'FAILED';
    }
  }

  private async verifyStep(plan: Plan, step: Step, context: ToolExecutionContext): Promise<boolean> {
    if (!step.verification) {
      return true;
    }
    const { tool, args, expected } = step.verification;
    this.logger.info('orchestrator.verification_started', { planId: plan.id, stepId: step.id, tool });

    try {
      const receipt = await this.registry.execute(tool, args, context);
      if (receipt.status !== 'success') {
        return false;
      }
      return this.deepEqual(receipt.result, expected);
    } catch {
      return false;
    }
  }

  private deepEqual(a: unknown, b: unknown): boolean {
    if (a === b) {
      return true;
    }
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
      return false;
    }
    if (Array.isArray(a) !== Array.isArray(b)) {
      return false;
    }
    const keysA = Object.keys(a as Record<string, unknown>);
    const keysB = Object.keys(b as Record<string, unknown>);
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every((key) => this.deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
  }

  private updateContextFromResult(plan: Plan, _step: Step, result: unknown): void {
    if (!result || typeof result !== 'object') {
      return;
    }
    const record = result as Record<string, unknown>;
    if (record.browserTabs) {
      plan.context = { ...plan.context, browserTabs: record.browserTabs as ExecutionContext['browserTabs'] };
    }
    if (record.desktopWindows) {
      plan.context = { ...plan.context, desktopWindows: record.desktopWindows as ExecutionContext['desktopWindows'] };
    }
    if (record.activeApp) {
      plan.context = { ...plan.context, activeApp: record.activeApp as string };
    }
    if (record.activeWindowId) {
      plan.context = { ...plan.context, activeWindowId: record.activeWindowId as string };
    }
    if (record.snapshotId) {
      plan.context = { ...plan.context, lastSnapshotRef: record.snapshotId as string };
    }
    if (record.screenshotPath) {
      plan.context = { ...plan.context, lastScreenshotPath: record.screenshotPath as string };
    }
    if (record.variables) {
      plan.context = { ...plan.context, variables: { ...plan.context.variables, ...(record.variables as Record<string, unknown>) } };
    }
  }

  private createToolContext(executionId: string, callId: string): ToolExecutionContext {
    return {
      executionId,
      callId,
      logger: this.logger,
      signal: this.signal,
      now: this.now,
    };
  }

  private createEmptyContext(): ExecutionContext {
    return {
      browserTabs: [],
      desktopWindows: [],
      variables: {},
    };
  }

  private async persist(): Promise<void> {
    if (!this.persistencePath || !this.currentPlan) {
      return;
    }
    try {
      mkdirSync(this.persistencePath, { recursive: true });
      const filePath = resolve(this.persistencePath, `${this.currentPlan.id}.json`);
      const sanitized = sanitizeForPersistence(this.currentPlan) as PersistedPlan;
      writeFileSync(filePath, JSON.stringify(sanitized, null, 2), 'utf8');
    } catch (error) {
      this.logger.error('orchestrator.persist_failed', { error: formatError(error) });
    }
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return 'Unknown error';
}