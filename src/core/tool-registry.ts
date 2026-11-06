import type { ZodType } from 'zod';

import type { OllamaToolDefinition } from '../llm/ollama-client.js';
import type { Logger } from '../logging/logger.js';

export type ToolPermission = 'read-only' | 'requires-approval' | 'denied';
export type ToolExecutionStatus =
  'success' | 'failure' | 'approval_required' | 'timeout' | 'cancelled';
export type VerificationStatus = 'verified' | 'failed' | 'not_applicable';

export interface ToolExecutionContext {
  executionId: string;
  callId: string;
  logger: Logger;
  signal: AbortSignal;
  now: () => Date;
}

export interface ToolDefinition<TArgs = unknown> {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  argumentsSchema: ZodType<TArgs>;
  execute: (args: TArgs, context: ToolExecutionContext) => unknown;
  verify?: (
    args: TArgs,
    output: unknown,
    context: ToolExecutionContext,
  ) => boolean | Promise<boolean>;
  timeoutMs: number;
  permission: ToolPermission;
}

export interface ToolExecutionReceipt {
  executionId: string;
  callId: string;
  toolName: string;
  status: ToolExecutionStatus;
  verification: VerificationStatus;
  result: unknown;
  error: string | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

interface RegisteredTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  parse: (args: unknown) =>
    | {
        success: true;
        data: unknown;
      }
    | {
        success: false;
        message: string;
      };
  execute: (args: unknown, context: ToolExecutionContext) => Promise<unknown>;
  verify:
    | ((
        args: unknown,
        output: unknown,
        context: ToolExecutionContext,
      ) => boolean | Promise<boolean>)
    | null;
  timeoutMs: number;
  permission: ToolPermission;
}

type ToolRunOutcome =
  | { status: 'completed'; output: unknown }
  | { status: 'failed'; error: string }
  | { status: 'timeout'; error: string }
  | { status: 'cancelled'; error: string };

const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_PERMISSIONS: readonly ToolPermission[] = ['read-only', 'requires-approval', 'denied'];

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>();

  public register<TArgs>(definition: ToolDefinition<TArgs>): void {
    validateDefinition(definition);

    if (this.tools.has(definition.name)) {
      throw new Error(`Tool is already registered: ${definition.name}`);
    }

    const registered: RegisteredTool = {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      parse: (args) => {
        const parsed = definition.argumentsSchema.safeParse(args);

        if (!parsed.success) {
          return { success: false, message: formatValidationError(parsed.error.issues) };
        }

        return { success: true, data: parsed.data };
      },
      execute: (args, context) => Promise.resolve(definition.execute(args as TArgs, context)),
      verify:
        definition.verify === undefined
          ? null
          : (args, output, context) => definition.verify?.(args as TArgs, output, context) ?? false,
      timeoutMs: definition.timeoutMs,
      permission: definition.permission,
    };

    this.tools.set(definition.name, registered);
  }

  public has(name: string): boolean {
    return this.tools.has(name);
  }

  public listNames(): string[] {
    return [...this.tools.keys()];
  }

  public getOllamaTools(): OllamaToolDefinition[] {
    return [...this.tools.values()].map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    }));
  }

  public async execute(
    name: string,
    rawArgs: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionReceipt> {
    const started = context.now();
    const tool = this.tools.get(name);

    if (tool === undefined) {
      return createReceipt(name, context, started, 'failure', 'Unknown tool', null);
    }

    if (tool.permission === 'denied') {
      return createReceipt(name, context, started, 'failure', 'Tool is denied by policy', null);
    }

    if (tool.permission === 'requires-approval') {
      return createReceipt(
        name,
        context,
        started,
        'approval_required',
        'Tool requires approval',
        null,
      );
    }

    const parsed = tool.parse(rawArgs);

    if (!parsed.success) {
      return createReceipt(
        name,
        context,
        started,
        'failure',
        `Invalid arguments: ${parsed.message}`,
        null,
      );
    }

    if (context.signal.aborted) {
      return createReceipt(name, context, started, 'cancelled', 'Tool execution cancelled', null);
    }

    const outcome = await runWithLimits(tool, parsed.data, context);

    if (outcome.status !== 'completed') {
      const status: ToolExecutionStatus = outcome.status === 'failed' ? 'failure' : outcome.status;

      return createReceipt(name, context, started, status, outcome.error, null);
    }

    let verification: VerificationStatus = 'not_applicable';
    let status: ToolExecutionStatus = 'success';
    let error: string | null = null;

    if (tool.verify !== null) {
      try {
        const verified = await tool.verify(parsed.data, outcome.output, context);
        verification = verified ? 'verified' : 'failed';

        if (!verified) {
          status = 'failure';
          error = 'Tool verification failed';
        }
      } catch (verificationError) {
        verification = 'failed';
        status = 'failure';
        error = `Tool verification failed: ${formatError(verificationError)}`;
      }
    }

    return createReceipt(name, context, started, status, error, outcome.output, verification);
  }
}

function validateDefinition<TArgs>(definition: ToolDefinition<TArgs>): void {
  if (!TOOL_NAME_PATTERN.test(definition.name)) {
    throw new Error(`Invalid tool name: ${definition.name}`);
  }

  if (definition.description.trim().length === 0) {
    throw new Error(`Tool description is required: ${definition.name}`);
  }

  if (definition.parameters.type !== 'object') {
    throw new Error(`Tool parameters must describe an object: ${definition.name}`);
  }

  if (typeof definition.argumentsSchema.safeParse !== 'function') {
    throw new Error(`Tool argument schema is invalid: ${definition.name}`);
  }

  if (typeof definition.execute !== 'function') {
    throw new Error(`Tool execute handler is invalid: ${definition.name}`);
  }

  if (definition.verify !== undefined && typeof definition.verify !== 'function') {
    throw new Error(`Tool verify handler is invalid: ${definition.name}`);
  }

  if (!Number.isInteger(definition.timeoutMs) || definition.timeoutMs < 1) {
    throw new Error(`Tool timeout must be a positive integer: ${definition.name}`);
  }

  if (!TOOL_PERMISSIONS.includes(definition.permission)) {
    throw new Error(`Tool permission is invalid: ${definition.name}`);
  }
}

async function runWithLimits(
  tool: RegisteredTool,
  args: unknown,
  context: ToolExecutionContext,
): Promise<ToolRunOutcome> {
  if (context.signal.aborted) {
    return { status: 'cancelled', error: 'Tool execution cancelled' };
  }

  let timeoutId: NodeJS.Timeout | undefined;
  let abortHandler: (() => void) | undefined;

  const execution = Promise.resolve()
    .then(async () => tool.execute(args, context))
    .then((output): ToolRunOutcome => ({ status: 'completed', output }))
    .catch((error: unknown): ToolRunOutcome => ({ status: 'failed', error: formatError(error) }));

  const timeout = new Promise<ToolRunOutcome>((resolve) => {
    timeoutId = setTimeout(() => {
      resolve({
        status: 'timeout',
        error: `Tool execution timed out after ${String(tool.timeoutMs)} ms`,
      });
    }, tool.timeoutMs);
  });

  const cancellation = new Promise<ToolRunOutcome>((resolve) => {
    abortHandler = () => {
      resolve({ status: 'cancelled', error: 'Tool execution cancelled' });
    };
    context.signal.addEventListener('abort', abortHandler, { once: true });
  });

  try {
    return await Promise.race([execution, timeout, cancellation]);
  } finally {
    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    if (abortHandler !== undefined) {
      context.signal.removeEventListener('abort', abortHandler);
    }
  }
}

function createReceipt(
  toolName: string,
  context: ToolExecutionContext,
  started: Date,
  status: ToolExecutionStatus,
  error: string | null,
  result: unknown,
  verification: VerificationStatus = 'not_applicable',
): ToolExecutionReceipt {
  const completed = context.now();

  return {
    executionId: context.executionId,
    callId: context.callId,
    toolName,
    status,
    verification,
    result,
    error,
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
  };
}

function formatValidationError(
  issues: readonly { path: readonly PropertyKey[]; message: string }[],
): string {
  return issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.map(String).join('.') : 'arguments';
      return `${path}: ${issue.message}`;
    })
    .join('; ');
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown tool error';
}
