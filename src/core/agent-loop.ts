import { randomUUID } from 'node:crypto';

import {
  OllamaRequestError,
  type OllamaChatRequest,
  type OllamaChatResult,
  type OllamaMessage,
} from '../llm/ollama-client.js';
import type { Logger } from '../logging/logger.js';
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
}

export interface AgentLoopOptions {
  client: ChatClient;
  registry: ToolRegistry;
  logger: Logger;
  systemPrompt?: string;
  limits?: Partial<AgentLimits>;
  now?: () => Date;
  idFactory?: () => string;
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

  public constructor(options: AgentLoopOptions) {
    this.client = options.client;
    this.registry = options.registry;
    this.logger = options.logger;
    this.systemPrompt = options.systemPrompt ?? SYSTEM_PROMPT;
    this.limits = { ...DEFAULT_LIMITS, ...options.limits };
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? randomUUID;
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
      this.logger.info('ollama.request', {
        executionId,
        round,
        messageCount: messages.length,
        toolNames: this.registry.listNames(),
      });

      let response: OllamaChatResult;

      try {
        response = await this.client.chat(
          {
            messages,
            tools: this.registry.getOllamaTools(),
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
    };
    const metadata = {
      executionId,
      status,
      rounds,
      toolCallCount,
      durationMs,
      error,
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
    verification: receipt.verification,
    durationMs: receipt.durationMs,
    round,
    callIndex,
  };
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown agent error';
}
