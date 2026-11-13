import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import type {
  Plan,
  Step,
  PlanState,
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

function isWaitingForUser(plan: Plan): boolean {
  return plan.state === 'WAITING_FOR_USER';
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
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

function skipBlockedSteps(steps: Step[], completedAt: string): number {
  let skipped = 0;
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (
        step.state === 'PENDING' &&
        step.dependsOn.some((dependencyId) => {
          const dependency = steps.find((candidate) => candidate.id === dependencyId);
          return dependency?.state === 'FAILED' || dependency?.state === 'SKIPPED';
        })
      ) {
        step.state = 'SKIPPED';
        step.error = 'Blocked by a failed or skipped dependency.';
        step.completedAt = completedAt;
        skipped += 1;
        changed = true;
      }
    }
  }
  return skipped;
}

function getUniqueRef(result: unknown): string | null {
  if (!isRecord(result) || !isRecord(result.result) || !Array.isArray(result.result.matches)) {
    return null;
  }
  if (result.result.matches.length !== 1) return null;
  const match: unknown = result.result.matches[0];
  if (!isRecord(match) || typeof match.ref_id !== 'string') return null;
  return match.ref_id;
}

function resultContainsRef(result: unknown, expectedRef: string): boolean {
  if (!isRecord(result) || !isRecord(result.result) || !Array.isArray(result.result.matches)) {
    return false;
  }
  return result.result.matches.some(
    (match: unknown) => isRecord(match) && match.ref_id === expectedRef,
  );
}

function isPotentialActionTool(toolName: string): boolean {
  return /(?:action|click|fill|type|press|submit|write|create|delete|move|toggle|check|uncheck|expand|collapse|set_value|send)/i.test(
    toolName,
  );
}

function hasSafeNotDeliveredDisposition(error: string | null): boolean {
  return error !== null && error.includes('delivery=not_delivered') && error.includes('retry=safe');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

  public async createPlan(
    goal: string,
    steps: (Omit<Step, 'id' | 'state' | 'retryCount'> & { id?: string })[],
  ): Promise<Plan> {
    const plan: Plan = {
      id: this.idFactory(),
      goal,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      steps: steps.map((s) => ({
        ...s,
        id: s.id ?? this.idFactory(),
        state: 'PENDING',
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
    if (this.persistencePath === null) {
      return null;
    }
    const filePath = resolve(this.persistencePath, `${planId}.json`);
    try {
      await access(filePath);
    } catch {
      return null;
    }
    try {
      const content = await readFile(filePath, 'utf8');
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

    while (!isTerminalPlanState(plan.state) && !isWaitingForUser(plan) && !isAborted(this.signal)) {
      const step = getNextRunnableStep(plan);
      if (!step) {
        skipBlockedSteps(plan.steps, this.now().toISOString());
        if (plan.steps.some((candidate) => candidate.state === 'PENDING')) {
          plan.state = 'FAILED';
          plan.error = 'Plan contains steps with dependencies that cannot be satisfied.';
        }
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

    if (!isTerminalPlanState(plan.state) && !isWaitingForUser(plan)) {
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

    let staleRecoveryAttempted = false;
    try {
      let receipt = await this.registry.execute(step.tool, step.args, context);

      if (this.isSafelyRecoverableStaleReference(step, receipt)) {
        staleRecoveryAttempted = true;
        step.retryCount += 1;
        receipt = await this.recoverStaleDesktopAction(plan, step, context);
      }

      if (receipt.status === 'cancelled') {
        step.state = 'FAILED';
        step.error = receipt.error ?? 'Cancelled';
        step.completedAt = this.now().toISOString();
        return 'FAILED';
      }

      if (receipt.status === 'failure' || receipt.status === 'timeout') {
        if (
          !staleRecoveryAttempted &&
          step.retryCount < this.maxRetries &&
          (!isPotentialActionTool(step.tool) || hasSafeNotDeliveredDisposition(receipt.error))
        ) {
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
          if (!isPotentialActionTool(step.tool) && step.retryCount < this.maxRetries) {
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
          this.logger.error('orchestrator.step_verification_failed', {
            planId: plan.id,
            stepId: step.id,
          });
        }
      } else {
        step.state = 'VERIFIED';
        this.updateContextFromResult(plan, step, receipt.result);
        this.logger.info('orchestrator.step_completed', { planId: plan.id, stepId: step.id });
      }

      return 'SUCCESS';
    } catch (error) {
      if (isAborted(this.signal)) {
        return 'ABORTED';
      }
      if (staleRecoveryAttempted) {
        step.state = 'FAILED';
        step.error = `Stale accessibility reference recovery failed: ${formatError(error)}`;
        step.completedAt = this.now().toISOString();
        this.logger.error('orchestrator.stale_ref_recovery_failed', {
          planId: plan.id,
          stepId: step.id,
          error: step.error,
        });
        return 'FAILED';
      }
      if (
        step.retryCount < this.maxRetries &&
        (!isPotentialActionTool(step.tool) || hasSafeNotDeliveredDisposition(formatError(error)))
      ) {
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
      this.logger.error('orchestrator.step_failed', {
        planId: plan.id,
        stepId: step.id,
        error: formatError(error),
      });
      return 'FAILED';
    }
  }

  private isSafelyRecoverableStaleReference(
    step: Step,
    receipt: Awaited<ReturnType<ToolRegistry['execute']>>,
  ): boolean {
    return (
      step.tool === 'desktop_ax_action' &&
      step.retryCount < this.maxRetries &&
      receipt.status === 'failure' &&
      receipt.error !== null &&
      receipt.error.includes('INVALID_ARGS: Invalid snapshot_id') &&
      receipt.error.includes('delivery=not_delivered') &&
      receipt.error.includes('retry=safe')
    );
  }

  private async recoverStaleDesktopAction(
    plan: Plan,
    step: Step,
    context: ToolExecutionContext,
  ): Promise<Awaited<ReturnType<ToolRegistry['execute']>>> {
    const actionIndex = plan.steps.findIndex((candidate) => candidate.id === step.id);
    const locatorStep = plan.steps
      .slice(0, actionIndex)
      .findLast(
        (candidate) => candidate.tool === 'desktop_ax_find' && candidate.state === 'VERIFIED',
      );
    if (!locatorStep)
      throw new Error('No prior accessibility locator is available to re-resolve the target.');
    const staleRef = step.args.ref;
    if (typeof staleRef !== 'string' || !resultContainsRef(locatorStep.result, staleRef)) {
      throw new Error(
        'The prior accessibility lookup did not produce the action target being refreshed.',
      );
    }

    const app = locatorStep.args.app;
    const windowId = locatorStep.args.window_id;
    if (typeof app !== 'string' && typeof windowId !== 'string') {
      throw new Error(
        'The prior accessibility locator has no app or window_id scope for a fresh snapshot.',
      );
    }

    const snapshotArgs: Record<string, unknown> = {
      interactive_only: true,
      compact: true,
      ...(typeof app === 'string' ? { app } : {}),
      ...(typeof windowId === 'string' ? { window_id: windowId } : {}),
    };
    const snapshot = await this.registry.execute('desktop_ax_snapshot', snapshotArgs, context);
    if (snapshot.status !== 'success') {
      throw new Error(snapshot.error ?? 'Fresh accessibility snapshot failed.');
    }

    const locatorArgs: Record<string, unknown> = { ...locatorStep.args, first: false, limit: 2 };
    delete locatorArgs.root;
    const resolved = await this.registry.execute('desktop_ax_find', locatorArgs, context);
    if (resolved.status !== 'success') {
      throw new Error(resolved.error ?? 'Fresh accessibility target lookup failed.');
    }
    const matchRef = getUniqueRef(resolved.result);
    if (!matchRef)
      throw new Error('Fresh accessibility lookup did not return exactly one actionable match.');

    return this.registry.execute('desktop_ax_action', { ...step.args, ref: matchRef }, context);
  }

  private async verifyStep(
    plan: Plan,
    step: Step,
    context: ToolExecutionContext,
  ): Promise<boolean> {
    if (!step.verification) {
      return true;
    }
    const { tool, args, expected } = step.verification;
    this.logger.info('orchestrator.verification_started', {
      planId: plan.id,
      stepId: step.id,
      tool,
    });

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
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) {
      return false;
    }
    return keysA.every((key) =>
      this.deepEqual((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]),
    );
  }

  private updateContextFromResult(plan: Plan, _step: Step, result: unknown): void {
    if (!result || typeof result !== 'object') {
      return;
    }
    const record = result as Record<string, unknown>;
    if (record.browserTabs) {
      plan.context = {
        ...plan.context,
        browserTabs: record.browserTabs as ExecutionContext['browserTabs'],
      };
    }
    if (record.desktopWindows) {
      plan.context = {
        ...plan.context,
        desktopWindows: record.desktopWindows as ExecutionContext['desktopWindows'],
      };
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
      plan.context = {
        ...plan.context,
        variables: { ...plan.context.variables, ...(record.variables as Record<string, unknown>) },
      };
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
      await mkdir(this.persistencePath, { recursive: true });
      const filePath = resolve(this.persistencePath, `${this.currentPlan.id}.json`);
      const sanitized = sanitizeForPersistence(this.currentPlan) as PersistedPlan;
      await writeFile(filePath, JSON.stringify(sanitized, null, 2), 'utf8');
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
