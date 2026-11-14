import { randomUUID } from 'node:crypto';

import {
  OllamaRequestError,
  type OllamaChatRequest,
  type OllamaChatResult,
  type OllamaMessage,
} from '../llm/ollama-client.js';
import { validateBrowserUrl } from '../browser/url-guard.js';
import type { Logger } from '../logging/logger.js';
import {
  AgentPlanningError,
  createPlanningPrompt,
  parseAgentPlan,
} from '../orchestration/agent-planner.js';
import type { BackendRouter } from '../orchestration/backend-router.js';
import { Orchestrator } from '../orchestration/orchestrator.js';
import { PlanBuilder } from '../orchestration/plan-builder.js';
import type { Plan } from '../orchestration/types.js';
import { SYSTEM_PROMPT } from './system-prompt.js';
import type { ToolExecutionContext, ToolExecutionReceipt, ToolRegistry } from './tool-registry.js';

export interface ChatClient {
  chat(request: OllamaChatRequest, options?: { signal?: AbortSignal }): Promise<OllamaChatResult>;
}

export interface AgentLimits {
  maxToolRounds: number;
  maxToolCalls: number;
  maxToolOutputChars: number;
}

export type AgentStatus = 'success' | 'failure' | 'cancelled' | 'limit_reached';

export interface AgentRunOptions {
  userMessage: string;
  signal?: AbortSignal;
  executionId?: string;
}

export interface AgentRunResult {
  executionId: string;
  status: AgentStatus;
  finalResponse: string;
  messages: OllamaMessage[];
  receipts: ToolExecutionReceipt[];
  rounds: number;
  toolCallCount: number;
  startedAt: string;
  completedAt: string;
  durationMs: number;
  error: string | null;
  workflowTrace?: AgentWorkflowStepTrace[];
  plan?: Plan;
  planHistory?: Plan[];
}

export interface AgentWorkflowStepTrace {
  stepId: string;
  expectedToolName: string;
  actualToolNames: string[];
  arguments: Record<string, unknown>;
  receipt: ToolExecutionReceipt;
  mismatch: boolean;
}

interface RecognizedBrowserWorkflow {
  url: string | null;
  error: string | null;
}

export interface AgentLoopOptions {
  client: ChatClient;
  registry: ToolRegistry;
  logger: Logger;
  systemPrompt?: string;
  limits?: Partial<AgentLimits>;
  now?: () => Date;
  idFactory?: () => string;
  backendRouter?: BackendRouter;
  planningEnabled?: boolean;
  legacySinglePlanMode?: boolean;
}

const DEFAULT_LIMITS: AgentLimits = {
  maxToolRounds: 8,
  maxToolCalls: 12,
  maxToolOutputChars: 20_000,
};

const TRUNCATION_MARKER = '... [truncated]';

export class AgentLoop {
  private readonly client: ChatClient;
  private readonly registry: ToolRegistry;
  private readonly logger: Logger;
  private readonly systemPrompt: string;
  private readonly limits: AgentLimits;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly backendRouter: BackendRouter | undefined;
  private readonly planningEnabled: boolean;
  private readonly legacySinglePlanMode: boolean;

  public constructor(options: AgentLoopOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.logger = options.logger;
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
    this.backendRouter = options.backendRouter;
    this.planningEnabled = options.planningEnabled ?? false;
    this.legacySinglePlanMode = options.legacySinglePlanMode ?? false;
  }

  public async run(options: AgentRunOptions): Promise<AgentRunResult> {
    const executionId = options.executionId ?? this.idFactory();
    const signal = options.signal ?? new AbortController().signal;
    const started = this.now();
    const messages: OllamaMessage[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: options.userMessage },
    ];
    const receipts: ToolExecutionReceipt[] = [];
    const seenCalls = new Set<string>();
    const requiredTools = inferRequiredTools(options.userMessage, this.registry.listNames());
    let requiredToolIndex = 0;
    let rounds = 0;
    let toolCallCount = 0;
    let lastAssistantContent = '';

    this.logger.info('agent.started', {
      executionId,
      userMessageLength: options.userMessage.length,
      maxToolRounds: this.limits.maxToolRounds,
      maxToolCalls: this.limits.maxToolCalls,
      toolNames: this.registry.listNames(),
    });

    if (isAborted(signal)) {
      return this.finish(
        executionId,
        'cancelled',
        lastAssistantContent,
        messages,
        receipts,
        rounds,
        toolCallCount,
        started,
        'Agent run cancelled before the first round',
      );
    }

    if (this.planningEnabled && requiredTools === null) {
      return this.legacySinglePlanMode
        ? this.runModelPlannedWorkflow({
            executionId,
            signal,
            started,
            messages,
            receipts,
            userMessage: options.userMessage,
          })
        : this.runAdaptivePlannedWorkflow({
            executionId,
            signal,
            started,
            messages,
            receipts,
            userMessage: options.userMessage,
          });
    }

    const browserWorkflow = recognizeBrowserWorkflow(options.userMessage);
    if (browserWorkflow !== null) {
      return this.runBrowserWorkflow({
        executionId,
        signal,
        started,
        messages,
        receipts,
        browserWorkflow,
      });
    }

    for (let round = 1; round <= this.limits.maxToolRounds; round += 1) {
      if (isAborted(signal)) {
        return this.finish(
          executionId,
          'cancelled',
          lastAssistantContent,
          messages,
          receipts,
          rounds,
          toolCallCount,
          started,
          'Agent run cancelled',
        );
      }

      rounds = round;
      const nextRequiredTool = requiredTools?.[requiredToolIndex];
      const offeredTools =
        requiredTools === null
          ? this.registry.getOllamaTools()
          : nextRequiredTool === undefined
            ? []
            : this.registry
                .getOllamaTools()
                .filter((tool) => tool.function.name === nextRequiredTool);
      this.logger.info('ollama.request', {
        executionId,
        round,
        messageCount: messages.length,
        toolNames: offeredTools.map((tool) => tool.function.name),
      });

      let response: OllamaChatResult;

      try {
        response = await this.client.chat(
          {
            messages:
              nextRequiredTool === undefined
                ? messages
                : addRequiredToolInstruction(messages, nextRequiredTool),
            tools: offeredTools,
          },
          { signal },
        );
      } catch (error) {
        const message = formatError(error);
        const cancelled = error instanceof OllamaRequestError && error.kind === 'aborted';

        return this.finish(
          executionId,
          cancelled ? 'cancelled' : 'failure',
          lastAssistantContent,
          messages,
          receipts,
          rounds,
          toolCallCount,
          started,
          message,
        );
      }

      const assistantMessage = toAssistantMessage(response.message);
      messages.push(assistantMessage);
      lastAssistantContent = assistantMessage.content;
      const toolCalls = assistantMessage.tool_calls ?? [];

      if (requiredTools !== null && toolCalls.length > 1) {
        return this.finish(
          executionId,
          'failure',
          assistantMessage.content,
          messages,
          receipts,
          rounds,
          toolCallCount,
          started,
          'Required tool sequence must execute one step per model round',
        );
      }

      this.logger.info('ollama.response', {
        executionId,
        round,
        toolCallCount: toolCalls.length,
        doneReason: response.doneReason,
        evalCount: response.metrics.evalCount,
        totalDurationMs: response.metrics.totalDurationMs,
      });

      if (isAborted(signal)) {
        return this.finish(
          executionId,
          'cancelled',
          lastAssistantContent,
          messages,
          receipts,
          rounds,
          toolCallCount,
          started,
          'Agent run cancelled',
        );
      }

      if (toolCalls.length === 0) {
        const missingTool = requiredTools?.[requiredToolIndex];
        if (missingTool !== undefined) {
          return this.finish(
            executionId,
            'failure',
            assistantMessage.content,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            `Required tool was not called: ${missingTool}`,
          );
        }
        return this.finish(
          executionId,
          'success',
          assistantMessage.content,
          messages,
          receipts,
          rounds,
          toolCallCount,
          started,
          null,
        );
      }

      for (const [callIndex, call] of toolCalls.entries()) {
        if (isAborted(signal)) {
          return this.finish(
            executionId,
            'cancelled',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            'Agent run cancelled',
          );
        }

        const toolName = call.function.name;
        if (nextRequiredTool !== undefined && toolName !== nextRequiredTool) {
          return this.finish(
            executionId,
            'failure',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            `Expected tool ${nextRequiredTool}, received ${toolName}`,
          );
        }
        const callId = this.idFactory();
        const normalizedCall = `${toolName}:${stableStringify(call.function.arguments)}`;

        this.logger.info('tool.requested', {
          executionId,
          callId,
          toolName,
          round,
          callIndex,
        });

        if (toolCallCount >= this.limits.maxToolCalls) {
          const receipt = createBlockedReceipt(
            executionId,
            callId,
            toolName,
            this.now,
            `Maximum tool calls (${String(this.limits.maxToolCalls)}) reached`,
          );
          receipts.push(receipt);
          this.logger.error('tool.failed', receiptLogMetadata(receipt, round, callIndex));

          return this.finish(
            executionId,
            'limit_reached',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            receipt.error,
          );
        }

        toolCallCount += 1;

        if (seenCalls.has(normalizedCall)) {
          const receipt = createBlockedReceipt(
            executionId,
            callId,
            toolName,
            this.now,
            'Repeated tool call detected; stopping to prevent a loop',
          );
          receipts.push(receipt);
          this.logger.error('tool.failed', receiptLogMetadata(receipt, round, callIndex));

          return this.finish(
            executionId,
            'failure',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            receipt.error,
          );
        }

        seenCalls.add(normalizedCall);

        this.logger.info('tool.started', {
          executionId,
          callId,
          toolName,
          round,
          callIndex,
        });

        const context: ToolExecutionContext = {
          executionId,
          callId,
          logger: this.logger,
          signal,
          now: this.now,
        };
        const receipt = await this.registry.execute(toolName, call.function.arguments, context);
        receipts.push(receipt);
        this.logReceipt(receipt, round, callIndex);

        messages.push({
          role: 'tool',
          tool_name: toolName,
          content: serializeToolReceipt(receipt, this.limits.maxToolOutputChars),
        });

        if (receipt.status === 'cancelled') {
          return this.finish(
            executionId,
            'cancelled',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            receipt.error ?? 'Agent run cancelled',
          );
        }

        if (receipt.status === 'approval_required') {
          return this.finish(
            executionId,
            'failure',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            receipt.error ?? 'Tool requires approval',
          );
        }

        if (receipt.status === 'denied' || receipt.status === 'approval_unavailable') {
          return this.finish(
            executionId,
            'failure',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            receipt.error ?? 'Side-effecting tool was not approved',
          );
        }
        if (requiredTools !== null && receipt.status !== 'success') {
          return this.finish(
            executionId,
            'failure',
            lastAssistantContent,
            messages,
            receipts,
            rounds,
            toolCallCount,
            started,
            `Required tool failed: ${toolName}: ${receipt.error ?? receipt.status}`,
          );
        }
        if (nextRequiredTool !== undefined) {
          requiredToolIndex += 1;
        }
      }
    }

    return this.finish(
      executionId,
      'limit_reached',
      lastAssistantContent,
      messages,
      receipts,
      rounds,
      toolCallCount,
      started,
      `Maximum tool rounds (${String(this.limits.maxToolRounds)}) reached`,
    );
  }

  private finish(
    executionId: string,
    status: AgentStatus,
    finalResponse: string,
    messages: OllamaMessage[],
    receipts: ToolExecutionReceipt[],
    rounds: number,
    toolCallCount: number,
    started: Date,
    error: string | null,
    workflowTrace: AgentWorkflowStepTrace[] = [],
    plan?: Plan,
    planHistory?: Plan[],
  ): AgentRunResult {
    const completed = this.now();
    const durationMs = Math.max(0, completed.getTime() - started.getTime());
    const result: AgentRunResult = {
      executionId,
      status,
      finalResponse,
      messages,
      receipts,
      rounds,
      toolCallCount,
      startedAt: started.toISOString(),
      completedAt: completed.toISOString(),
      durationMs,
      error,
      workflowTrace,
      ...(plan === undefined ? {} : { plan }),
      ...(planHistory === undefined ? {} : { planHistory }),
    };
    const metadata = {
      executionId,
      status,
      rounds,
      toolCallCount,
      durationMs,
      error: redactUrlsForLog(error),
    };

    if (status === 'success') {
      this.logger.info('agent.completed', metadata);
    } else if (status === 'cancelled') {
      this.logger.warn('agent.cancelled', metadata);
    } else {
      this.logger.error('agent.failed', metadata);
    }

    return result;
  }

  private async runAdaptivePlannedWorkflow(input: {
    executionId: string;
    signal: AbortSignal;
    started: Date;
    messages: OllamaMessage[];
    receipts: ToolExecutionReceipt[];
    userMessage: string;
  }): Promise<AgentRunResult> {
    const { executionId, signal, started, messages, receipts, userMessage } = input;
    if (this.backendRouter === undefined) {
      return this.finish(
        executionId,
        'failure',
        '',
        messages,
        receipts,
        0,
        0,
        started,
        'Adaptive planning requires an available backend router',
      );
    }

    const planHistory: Plan[] = [];
    const workflowTrace: AgentWorkflowStepTrace[] = [];
    const planSignatures = new Set<string>();
    let rounds = 0;
    let toolCallCount = 0;
    let lastPlan: Plan | undefined;
    let completed = false;
    let terminalError: string | null = null;

    while (rounds + 1 < this.limits.maxToolRounds && toolCallCount < this.limits.maxToolCalls) {
      if (signal.aborted) {
        terminalError = 'Agent run cancelled during adaptive execution';
        break;
      }

      const evidence = planHistory.map((plan) => summarizePlanForPlanner(plan));
      let planningResponse: OllamaChatResult;
      try {
        planningResponse = await this.client.chat(
          {
            format: 'json',
            messages: [
              ...messages,
              {
                role: 'system',
                content: createPlanningPrompt(
                  userMessage,
                  this.registry.getOllamaTools(),
                  evidence,
                ),
              },
            ],
          },
          { signal },
        );
      } catch (error) {
        terminalError = formatError(error);
        break;
      }
      rounds += 1;
      const planningMessage = toAssistantMessage(planningResponse.message);
      messages.push(planningMessage);
      if ((planningMessage.tool_calls?.length ?? 0) > 0) {
        terminalError = 'Planner returned tool calls instead of a JSON plan';
        break;
      }

      let definition: ReturnType<typeof parseAgentPlan>;
      try {
        definition = parseAgentPlan(planningMessage.content, this.registry.getOllamaTools());
      } catch (error) {
        const parseError =
          error instanceof AgentPlanningError
            ? error.message
            : `Planner failed: ${formatError(error)}`;
        if (rounds + 1 >= this.limits.maxToolRounds) {
          terminalError = parseError;
          break;
        }
        let repairResponse: OllamaChatResult;
        try {
          repairResponse = await this.client.chat(
            {
              format: 'json',
              messages: [
                ...messages,
                {
                  role: 'system',
                  content: `Your previous planning response was rejected: ${parseError}. Return only a JSON object matching the requested plan schema. Do not explain tool availability, do not return a status report, and do not call tools.`,
                },
              ],
            },
            { signal },
          );
        } catch (repairError) {
          terminalError = formatError(repairError);
          break;
        }
        rounds += 1;
        const repairMessage = toAssistantMessage(repairResponse.message);
        messages.push(repairMessage);
        if ((repairMessage.tool_calls?.length ?? 0) > 0) {
          terminalError = 'Planner repair response returned tool calls instead of a JSON plan';
          break;
        }
        try {
          definition = parseAgentPlan(repairMessage.content, this.registry.getOllamaTools());
        } catch (repairError) {
          terminalError =
            repairError instanceof AgentPlanningError
              ? repairError.message
              : `Planner repair failed: ${formatError(repairError)}`;
          break;
        }
      }

      const signature = planSignature(definition.steps);
      if (planSignatures.has(signature)) {
        terminalError = 'Planner repeated an identical plan; stopping to prevent an execution loop';
        break;
      }
      planSignatures.add(signature);

      const remainingCalls = this.limits.maxToolCalls - toolCallCount;
      if (definition.steps.length > remainingCalls) {
        terminalError = `The generated plan exceeds the remaining tool-call budget (${String(remainingCalls)})`;
        break;
      }
      const unsafeRepeat = findUnsafeCompletedActionRepeat(definition.steps, planHistory);
      if (unsafeRepeat !== null) {
        terminalError = `Planner attempted to repeat completed non-idempotent action: ${unsafeRepeat}`;
        break;
      }

      const orchestrator = new Orchestrator({
        registry: this.registry,
        logger: this.logger,
        signal,
        now: this.now,
        idFactory: this.idFactory,
        maxRetries: 1,
        backendRouter: this.backendRouter,
      });
      const createdPlan = await orchestrator.createPlan(definition.goal, definition.steps);
      this.logger.info('agent.plan_selected', {
        executionId,
        planId: createdPlan.id,
        stepCount: createdPlan.steps.length,
        source: planHistory.length === 0 ? 'model-generated' : 'model-replanned',
      });
      const executedPlan = await orchestrator.runPlan();
      lastPlan = executedPlan;
      planHistory.push(executedPlan);
      const planReceipts = executedPlan.steps.flatMap((step) =>
        step.receipt === undefined ? [] : [step.receipt],
      );
      receipts.push(...planReceipts);
      toolCallCount += planReceipts.length;
      for (const step of executedPlan.steps) {
        if (step.receipt !== undefined) {
          workflowTrace.push({
            stepId: step.id,
            expectedToolName: step.tool,
            actualToolNames: [step.tool],
            arguments: step.resolvedArgs ?? step.args,
            receipt: step.receipt,
            mismatch: false,
          });
        }
        messages.push({
          role: 'system',
          content: serializePlanStep(step, this.limits.maxToolOutputChars),
        });
      }

      if (executedPlan.state === 'COMPLETED' && !definition.continuationRequired) {
        completed = true;
        terminalError = null;
        break;
      }
      terminalError =
        executedPlan.error ??
        (definition.continuationRequired
          ? 'Planner requested observation-driven continuation'
          : `Plan ended in ${executedPlan.state}; requesting safe replanning`);
    }

    if (signal.aborted) {
      return this.finish(
        executionId,
        'cancelled',
        '',
        messages,
        receipts,
        rounds,
        toolCallCount,
        started,
        terminalError ?? 'Agent run cancelled',
        workflowTrace,
        lastPlan,
        planHistory,
      );
    }

    if (rounds >= this.limits.maxToolRounds || toolCallCount >= this.limits.maxToolCalls) {
      terminalError ??= 'Adaptive execution budget reached before task completion';
    }
    if (rounds >= this.limits.maxToolRounds) {
      return this.finish(
        executionId,
        'limit_reached',
        '',
        messages,
        receipts,
        rounds,
        toolCallCount,
        started,
        terminalError,
        workflowTrace,
        lastPlan,
        planHistory,
      );
    }

    let final: OllamaChatResult;
    try {
      final = await this.client.chat(
        {
          messages: [
            ...messages,
            {
              role: 'system',
              content:
                'Write a concise evidence-based final report. State which outcomes are verified, failed, blocked, uncertain, or not run. Successful dispatch alone is not verification. Do not call tools or invent missing details.',
            },
          ],
        },
        { signal },
      );
    } catch (error) {
      return this.finish(
        executionId,
        'failure',
        '',
        messages,
        receipts,
        rounds + 1,
        toolCallCount,
        started,
        formatError(error),
        workflowTrace,
        lastPlan,
        planHistory,
      );
    }
    rounds += 1;
    const finalMessage = toAssistantMessage(final.message);
    messages.push(finalMessage);
    if ((finalMessage.tool_calls?.length ?? 0) > 0) {
      terminalError = 'Model returned tool calls after adaptive execution stopped';
    }
    return this.finish(
      executionId,
      completed && terminalError === null ? 'success' : 'failure',
      finalMessage.content,
      messages,
      receipts,
      rounds,
      toolCallCount,
      started,
      terminalError,
      workflowTrace,
      lastPlan,
      planHistory,
    );
  }

  private async runModelPlannedWorkflow(input: {
    executionId: string;
    signal: AbortSignal;
    started: Date;
    messages: OllamaMessage[];
    receipts: ToolExecutionReceipt[];
    userMessage: string;
  }): Promise<AgentRunResult> {
    const { executionId, signal, started, messages, receipts, userMessage } = input;
    if (this.backendRouter === undefined) {
      return this.finish(
        executionId,
        'failure',
        '',
        messages,
        receipts,
        0,
        0,
        started,
        'General task planning requires an available backend router',
      );
    }

    let planningResponse: OllamaChatResult;
    try {
      planningResponse = await this.client.chat(
        {
          messages: [
            ...messages,
            {
              role: 'system',
              content: createPlanningPrompt(userMessage, this.registry.getOllamaTools()),
            },
          ],
        },
        { signal },
      );
    } catch (error) {
      return this.finish(
        executionId,
        error instanceof OllamaRequestError && error.kind === 'aborted' ? 'cancelled' : 'failure',
        '',
        messages,
        receipts,
        1,
        0,
        started,
        formatError(error),
      );
    }

    const planningMessage = toAssistantMessage(planningResponse.message);
    messages.push(planningMessage);
    if ((planningMessage.tool_calls?.length ?? 0) > 0) {
      return this.finish(
        executionId,
        'failure',
        planningMessage.content,
        messages,
        receipts,
        1,
        0,
        started,
        'Planner returned tool calls instead of a JSON plan',
      );
    }

    let definition: { goal: string; steps: Omit<Plan['steps'][number], 'state' | 'retryCount'>[] };
    try {
      definition = parseAgentPlan(planningMessage.content, this.registry.getOllamaTools());
    } catch (error) {
      const message =
        error instanceof AgentPlanningError
          ? error.message
          : `Planner failed: ${formatError(error)}`;
      return this.finish(
        executionId,
        'failure',
        planningMessage.content,
        messages,
        receipts,
        1,
        0,
        started,
        message,
      );
    }

    if (definition.steps.length > this.limits.maxToolCalls) {
      return this.finish(
        executionId,
        'limit_reached',
        '',
        messages,
        receipts,
        1,
        0,
        started,
        `The generated plan exceeds the configured tool-call limit (${String(this.limits.maxToolCalls)})`,
      );
    }

    const orchestrator = new Orchestrator({
      registry: this.registry,
      logger: this.logger,
      signal,
      now: this.now,
      idFactory: this.idFactory,
      maxRetries: 1,
      backendRouter: this.backendRouter,
    });
    const plan = await orchestrator.createPlan(definition.goal, definition.steps);
    this.logger.info('agent.plan_selected', {
      executionId,
      planId: plan.id,
      stepCount: plan.steps.length,
      source: 'model-generated',
    });
    const completedPlan = await orchestrator.runPlan();
    const planReceipts = completedPlan.steps.flatMap((step) =>
      step.receipt === undefined ? [] : [step.receipt],
    );
    receipts.push(...planReceipts);
    const workflowTrace: AgentWorkflowStepTrace[] = completedPlan.steps.flatMap((step) =>
      step.receipt === undefined
        ? []
        : [
            {
              stepId: step.id,
              expectedToolName: step.tool,
              actualToolNames: [step.tool],
              arguments: step.resolvedArgs ?? step.args,
              receipt: step.receipt,
              mismatch: false,
            },
          ],
    );
    for (const step of completedPlan.steps) {
      messages.push({
        role: 'system',
        content: serializePlanStep(step, this.limits.maxToolOutputChars),
      });
    }

    if (signal.aborted) {
      return this.finish(
        executionId,
        'cancelled',
        '',
        messages,
        receipts,
        1,
        planReceipts.length,
        started,
        'Agent run cancelled during plan execution',
        workflowTrace,
        completedPlan,
      );
    }

    if (this.limits.maxToolRounds < 2) {
      return this.finish(
        executionId,
        'limit_reached',
        '',
        messages,
        receipts,
        1,
        planReceipts.length,
        started,
        'Maximum tool rounds reached before final report',
        workflowTrace,
        completedPlan,
      );
    }

    let final: OllamaChatResult;
    try {
      final = await this.client.chat(
        {
          messages: [
            ...messages,
            {
              role: 'system',
              content:
                'Write a concise final report from the plan evidence. Mark each requested outcome as verified, failed, blocked, uncertain, or not run. Only state facts present in successful receipts or verified read-backs. Do not claim an action completed merely because it was dispatched. Do not call tools.',
            },
          ],
        },
        { signal },
      );
    } catch (error) {
      return this.finish(
        executionId,
        error instanceof OllamaRequestError && error.kind === 'aborted' ? 'cancelled' : 'failure',
        '',
        messages,
        receipts,
        2,
        planReceipts.length,
        started,
        formatError(error),
        workflowTrace,
        completedPlan,
      );
    }

    const finalMessage = toAssistantMessage(final.message);
    messages.push(finalMessage);
    if ((finalMessage.tool_calls?.length ?? 0) > 0) {
      return this.finish(
        executionId,
        'failure',
        finalMessage.content,
        messages,
        receipts,
        2,
        planReceipts.length,
        started,
        'Model returned tool calls after plan execution',
        workflowTrace,
        completedPlan,
      );
    }

    const status = completedPlan.state === 'COMPLETED' ? 'success' : 'failure';
    return this.finish(
      executionId,
      status,
      finalMessage.content,
      messages,
      receipts,
      2,
      planReceipts.length,
      started,
      status === 'success' ? null : (completedPlan.error ?? `Plan ended in ${completedPlan.state}`),
      workflowTrace,
      completedPlan,
    );
  }

  private async runBrowserWorkflow(input: {
    executionId: string;
    signal: AbortSignal;
    started: Date;
    messages: OllamaMessage[];
    receipts: ToolExecutionReceipt[];
    browserWorkflow: RecognizedBrowserWorkflow;
  }): Promise<AgentRunResult> {
    const { executionId, signal, started, messages, receipts, browserWorkflow } = input;
    if (browserWorkflow.error !== null || browserWorkflow.url === null) {
      return this.finish(
        executionId,
        'failure',
        '',
        messages,
        receipts,
        0,
        0,
        started,
        browserWorkflow.error ?? 'The URL-based browser request did not contain a valid URL',
      );
    }

    const url = browserWorkflow.url;
    const planDefinition = new PlanBuilder()
      .addBrowserUrlWorkflow(url)
      .build(
        `Open a JARVIS-owned tab, navigate to ${url}, and verify the page URL, title, and visible text.`,
      );
    if (planDefinition.steps.length > this.limits.maxToolCalls) {
      return this.finish(
        executionId,
        'limit_reached',
        '',
        messages,
        receipts,
        0,
        0,
        started,
        'The browser plan exceeds the configured tool-call limit',
      );
    }
    if (planDefinition.steps.length + 1 > this.limits.maxToolRounds) {
      return this.finish(
        executionId,
        'limit_reached',
        '',
        messages,
        receipts,
        0,
        0,
        started,
        'The browser plan and final response exceed the configured round limit',
      );
    }

    let proposalRounds = 0;
    const orchestrator = new Orchestrator({
      registry: this.registry,
      logger: this.logger,
      signal,
      now: this.now,
      idFactory: this.idFactory,
      maxRetries: 0,
      ...(this.backendRouter === undefined ? {} : { backendRouter: this.backendRouter }),
      onStepProposal: async (plan, step) => {
        const toolDefinition = this.registry
          .getOllamaTools()
          .find((tool) => tool.function.name === step.tool);
        if (toolDefinition === undefined) {
          throw new Error(`Required planned tool is unavailable: ${step.tool}`);
        }
        const priorResults = plan.steps
          .filter((candidate) => candidate.state === 'VERIFIED' && candidate.receipt !== undefined)
          .map((candidate) => ({
            stepId: candidate.id,
            tool: candidate.tool,
            status: candidate.receipt?.status,
            verification: candidate.receipt?.verification,
            result: candidate.receipt?.result,
          }));
        proposalRounds += 1;
        const proposal = await this.client.chat(
          {
            messages: [
              ...messages,
              {
                role: 'system',
                content: `The Orchestrator owns plan ${plan.id}. Step ${step.id} requires ${step.tool}. Previous verified results: ${JSON.stringify(priorResults)}. Return a structured tool proposal if appropriate; the runtime will execute the validated plan step regardless of this proposal.`,
              },
            ],
            tools: [toolDefinition],
          },
          { signal },
        );
        return (proposal.message.tool_calls ?? []).map((call) => call.function.name);
      },
    });

    const plan = await orchestrator.createPlan(url, planDefinition.steps);
    this.logger.info('agent.plan_selected', {
      executionId,
      planId: plan.id,
      stepCount: plan.steps.length,
      supportedWorkflow: 'browser-url-readback',
    });
    const completedPlan = await orchestrator.runPlan();
    const planReceipts = completedPlan.steps.flatMap((step) =>
      step.receipt === undefined ? [] : [step.receipt],
    );
    receipts.push(...planReceipts);
    const workflowTrace: AgentWorkflowStepTrace[] = completedPlan.steps.flatMap((step) =>
      step.receipt === undefined
        ? []
        : [
            {
              stepId: step.id,
              expectedToolName: step.tool,
              actualToolNames: step.modelProposedTools ?? [],
              arguments: step.resolvedArgs ?? step.args,
              receipt: step.receipt,
              mismatch:
                (step.modelProposedTools?.length ?? 0) !== 1 ||
                step.modelProposedTools?.[0] !== step.tool,
            },
          ],
    );
    for (const step of completedPlan.steps) {
      if (step.receipt !== undefined) {
        messages.push({
          role: 'system',
          content: `Orchestrator plan ${completedPlan.id}; step ${step.id} (${step.tool}) is ${step.state}. ${serializeToolReceipt(step.receipt, this.limits.maxToolOutputChars)}`,
        });
      }
    }

    let rounds = proposalRounds;
    const toolCallCount = planReceipts.length;
    if (completedPlan.state !== 'COMPLETED') {
      return this.finish(
        executionId,
        signal.aborted ? 'cancelled' : 'failure',
        `Browser plan ${completedPlan.state}: ${completedPlan.error ?? 'one or more required steps did not complete'}`,
        messages,
        receipts,
        rounds,
        toolCallCount,
        started,
        completedPlan.error ?? `Browser plan ended in ${completedPlan.state}`,
        workflowTrace,
        completedPlan,
      );
    }

    if (rounds >= this.limits.maxToolRounds) {
      return this.finish(
        executionId,
        'limit_reached',
        '',
        messages,
        receipts,
        rounds,
        toolCallCount,
        started,
        'Maximum tool rounds reached before the final response',
        workflowTrace,
        completedPlan,
      );
    }

    let final: OllamaChatResult;
    try {
      rounds += 1;
      final = await this.client.chat(
        {
          messages: [
            ...messages,
            {
              role: 'system',
              content:
                'Summarize only the Orchestrator plan results whose steps are VERIFIED and whose tool receipts report verification=verified. State the actual URL and title, briefly summarize the returned visible page text, and do not claim anything absent from those results.',
            },
          ],
        },
        { signal },
      );
    } catch (error) {
      return this.finish(
        executionId,
        error instanceof OllamaRequestError && error.kind === 'aborted' ? 'cancelled' : 'failure',
        '',
        messages,
        receipts,
        rounds,
        toolCallCount,
        started,
        formatError(error),
        workflowTrace,
        completedPlan,
      );
    }

    const finalMessage = toAssistantMessage(final.message);
    if ((finalMessage.tool_calls?.length ?? 0) > 0) {
      return this.finish(
        executionId,
        'failure',
        finalMessage.content,
        [...messages, finalMessage],
        receipts,
        rounds,
        toolCallCount,
        started,
        'Model returned tool calls after the Orchestrator plan completed',
        workflowTrace,
        completedPlan,
      );
    }
    messages.push(finalMessage);
    return this.finish(
      executionId,
      'success',
      finalMessage.content,
      messages,
      receipts,
      rounds,
      toolCallCount,
      started,
      null,
      workflowTrace,
      completedPlan,
    );
  }
  private logReceipt(receipt: ToolExecutionReceipt, round: number, callIndex: number): void {
    const metadata = receiptLogMetadata(receipt, round, callIndex);

    if (receipt.status === 'success') {
      this.logger.info('tool.completed', metadata);
      return;
    }

    if (
      receipt.status === 'failure' &&
      (receipt.error?.startsWith('Invalid arguments') === true ||
        receipt.error?.startsWith('Unknown tool') === true)
    ) {
      this.logger.warn('tool.validation_failed', metadata);
      return;
    }

    this.logger.error('tool.failed', metadata);
  }
}

function summarizePlanForPlanner(plan: Plan): Record<string, unknown> {
  return {
    id: plan.id,
    state: plan.state,
    error: plan.error ?? null,
    steps: plan.steps.map((step) => ({
      id: step.id,
      tool: step.tool,
      args: step.resolvedArgs ?? step.args,
      state: step.state,
      receipt:
        step.receipt === undefined
          ? null
          : {
              status: step.receipt.status,
              verification: step.receipt.verification,
              approval: step.receipt.approval,
              result: step.receipt.result,
              error: step.receipt.error,
            },
      error: step.error ?? null,
    })),
  };
}

function planSignature(
  steps: readonly Omit<Plan['steps'][number], 'state' | 'retryCount'>[],
): string {
  return stableStringify(
    steps.map((step) => ({
      tool: step.tool,
      args: step.args,
      dependsOn: step.dependsOn,
      argumentSources: step.argumentSources ?? null,
    })),
  );
}

function findUnsafeCompletedActionRepeat(
  candidateSteps: readonly Omit<Plan['steps'][number], 'state' | 'retryCount'>[],
  history: readonly Plan[],
): string | null {
  const completedActions = history.flatMap((plan) =>
    plan.steps.filter(
      (step) =>
        step.state === 'VERIFIED' &&
        step.receipt?.status === 'success' &&
        isPotentialActionToolName(step.tool),
    ),
  );
  for (const candidate of candidateSteps) {
    if (!isPotentialActionToolName(candidate.tool)) continue;
    const repeated = completedActions.some(
      (completed) =>
        completed.tool === candidate.tool &&
        stableStringify(completed.resolvedArgs ?? completed.args) ===
          stableStringify(candidate.args),
    );
    if (repeated) return candidate.tool;
  }
  return null;
}

function isPotentialActionToolName(toolName: string): boolean {
  return /(?:action|click|fill|type|press|submit|write|create|new_tab|navigate|delete|move|toggle|check|uncheck|expand|collapse|set_value|send)/i.test(
    toolName,
  );
}

function toAssistantMessage(message: OllamaMessage): OllamaMessage {
  const assistant: OllamaMessage = {
    role: 'assistant',
    content: message.content,
  };

  if (message.tool_calls !== undefined && message.tool_calls.length > 0) {
    assistant.tool_calls = message.tool_calls;
  }

  return assistant;
}

function inferRequiredTools(
  userMessage: string,
  registeredNames: readonly string[],
): string[] | null {
  const explicit = registeredNames
    .flatMap((name) => {
      const match = new RegExp(`\\b${name}\\b`, 'i').exec(userMessage);
      return match === null ? [] : [{ name, index: match.index }];
    })
    .sort((left, right) => left.index - right.index)
    .map(({ name }) => name);
  const explicitExecutionContract =
    /\b(exactly once|only|do not call any other tool)\b/i.test(userMessage) ||
    /\b(report|return|show)\b.{0,50}\b(actual|result|returned|verified)\b/i.test(userMessage);
  if (explicit.length > 0 && explicitExecutionContract) {
    return explicit;
  }
  return null;
}

function addRequiredToolInstruction(
  messages: readonly OllamaMessage[],
  toolName: string,
): OllamaMessage[] {
  const instruction: OllamaMessage = {
    role: 'system',
    content: `The user requested this operation. Call the required registered tool ${toolName} now using a structured tool call. Do not answer in plain text until required tool execution is complete.`,
  };
  const systemMessage = messages[0];
  return systemMessage === undefined
    ? [instruction, ...messages]
    : [systemMessage, instruction, ...messages.slice(1)];
}

function serializeToolReceipt(receipt: ToolExecutionReceipt, maxChars: number): string {
  const payload = JSON.stringify({
    status: receipt.status,
    verification: receipt.verification,
    result: receipt.result,
    error: receipt.error,
  }) as string | undefined;
  const text = payload ?? 'null';

  if (text.length <= maxChars) {
    return text;
  }

  if (maxChars <= TRUNCATION_MARKER.length) {
    return TRUNCATION_MARKER.slice(0, maxChars);
  }

  return `${text.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function serializePlanStep(step: Plan['steps'][number], maxChars: number): string {
  const payload = JSON.stringify({
    planStep: step.id,
    tool: step.tool,
    state: step.state,
    expectedOutcome: step.expectedOutcome,
    verificationMethod: step.verificationMethod ?? null,
    failurePolicy: step.failurePolicy ?? null,
    receipt:
      step.receipt === undefined
        ? null
        : {
            status: step.receipt.status,
            verification: step.receipt.verification,
            approval: step.receipt.approval,
            result: step.receipt.result,
            error: step.receipt.error,
          },
    error: step.error ?? null,
  });
  return payload.length <= maxChars
    ? payload
    : `${payload.slice(0, maxChars - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value) as string | undefined;

    return serialized ?? 'null';
  }

  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();

  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function createBlockedReceipt(
  executionId: string,
  callId: string,
  toolName: string,
  now: () => Date,
  error: string,
): ToolExecutionReceipt {
  const started = now();
  const completed = now();

  return {
    executionId,
    callId,
    toolName,
    status: 'failure',
    approval: 'not_required',
    verification: 'not_applicable',
    result: null,
    error,
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
  };
}

function receiptLogMetadata(
  receipt: ToolExecutionReceipt,
  round: number,
  callIndex: number,
): Record<string, unknown> {
  return {
    executionId: receipt.executionId,
    callId: receipt.callId,
    toolName: receipt.toolName,
    status: receipt.status,
    approval: receipt.approval,
    verification: receipt.verification,
    durationMs: receipt.durationMs,
    round,
    callIndex,
  };
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function recognizeBrowserWorkflow(userMessage: string): RecognizedBrowserWorkflow | null {
  const hasNewTab = /\bnew\s+(?:(?:JARVIS-owned|browser)\s+)?tab\b/i.test(userMessage);
  const hasNavigation = /\bnavigate\b/i.test(userMessage);
  const hasUrlReadback = /\b(read|verify|check)\b.{0,60}\bURL\b/i.test(userMessage);
  const hasTitleAndText =
    /\btitle\b/i.test(userMessage) && /\b(visible\s+)?page\s+text\b/i.test(userMessage);
  if (!hasNewTab || !hasNavigation || !hasUrlReadback || !hasTitleAndText) {
    return null;
  }

  const rawUrl = /https?:\/\/[^\s<>"']+/i.exec(userMessage)?.[0]?.replace(/[),.;!?\]]+$/, '');
  if (rawUrl === undefined) {
    return { url: null, error: 'The browser workflow requires an explicit HTTP or HTTPS URL' };
  }
  const validation = validateBrowserUrl(rawUrl);
  if (!validation.valid || validation.sanitizedUrl === undefined) {
    return { url: null, error: validation.error ?? 'The requested URL is invalid' };
  }
  return { url: validation.sanitizedUrl, error: null };
}

function redactUrlsForLog(value: string | null): string | null {
  return value?.replace(/https?:\/\/[^\s<>"']+/gi, '[redacted-url]') ?? null;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown agent error';
}
