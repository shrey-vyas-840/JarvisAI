import type { ZodType } from 'zod';

import type { OllamaToolDefinition } from '../llm/ollama-client.js';
import type { Logger } from '../logging/logger.js';
import type {
  ApprovalOutcome,
  ApprovalProvider,
  ApprovalRequest,
} from '../security/approval-types.js';

export type ToolPermission = 'read-only' | 'requires-approval' | 'denied';
export type ToolExecutionStatus =
  | 'success'
  | 'failure'
  | 'approval_required'
  | 'approval_unavailable'
  | 'denied'
  | 'timeout'
  | 'cancelled';
export type VerificationStatus = 'verified' | 'failed' | 'not_applicable';
export type ToolApprovalStatus =
  'not_required' | 'required' | 'approved' | 'denied' | 'cancelled' | 'unavailable';

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
  approvalRequest?: (
    args: TArgs,
    context: ToolExecutionContext,
  ) => ApprovalRequest | Promise<ApprovalRequest>;
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
  approval: ToolApprovalStatus;
  verification: VerificationStatus;
  result: unknown;
  error: string | null;
  durationMs: number;
  startedAt: string;
  completedAt: string;
}

export interface ToolRegistryOptions {
  readonly approvalProvider?: ApprovalProvider;
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
  approvalRequest:
    | ((args: unknown, context: ToolExecutionContext) => ApprovalRequest | Promise<ApprovalRequest>)
    | null;
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
  private readonly approvalProvider: ApprovalProvider | null;

  public constructor(options: ToolRegistryOptions = {}) {
    this.approvalProvider = options.approvalProvider ?? null;
  }

  public register<TArgs>(definition: ToolDefinition<TArgs>): void {
    validateDefinition(definition);

    if (this.tools.has(definition.name)) {
      throw new Error(`Tool is already registered: ${definition.name}`);
    }

    const approvalRequest = definition.approvalRequest;
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
      approvalRequest:
        approvalRequest === undefined
          ? null
          : (args, context) => approvalRequest(args as TArgs, context),
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
      return createReceipt(name, context, started, 'failure', 'not_required', 'Unknown tool', null);
    }

    if (tool.permission === 'denied') {
      return createReceipt(
        name,
        context,
        started,
        'failure',
        'not_required',
        'Tool is denied by policy',
        null,
      );
    }

    if (tool.permission === 'requires-approval' && tool.approvalRequest === null) {
      return createReceipt(
        name,
        context,
        started,
        'approval_required',
        'required',
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
        'not_required',
        `Invalid arguments: ${parsed.message}`,
        null,
      );
    }

    if (context.signal.aborted) {
      return createReceipt(
        name,
        context,
        started,
        'cancelled',
        'not_required',
        'Tool execution cancelled',
        null,
      );
    }

    let approval: ToolApprovalStatus = 'not_required';

    if (tool.permission === 'requires-approval' && tool.approvalRequest !== null) {
      const approvalResult = await this.resolveApproval(tool, parsed.data, context, started);

      if (approvalResult.receipt !== null) {
        return approvalResult.receipt;
      }

      approval = approvalResult.approval;
    }

    const outcome = await runWithLimits(tool, parsed.data, context);

    if (outcome.status !== 'completed') {
      const status: ToolExecutionStatus = outcome.status === 'failed' ? 'failure' : outcome.status;

      return createReceipt(name, context, started, status, approval, outcome.error, null);
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

    return createReceipt(
      name,
      context,
      started,
      status,
      approval,
      error,
      outcome.output,
      verification,
    );
  }

  private async resolveApproval(
    tool: RegisteredTool,
    args: unknown,
    context: ToolExecutionContext,
    started: Date,
  ): Promise<{
    readonly receipt: ToolExecutionReceipt | null;
    readonly approval: ToolApprovalStatus;
  }> {
    const approvalRequest = tool.approvalRequest;

    if (approvalRequest === null) {
      return { receipt: null, approval: 'required' };
    }

    if (this.approvalProvider === null) {
      context.logger.error('approval.unavailable', { toolName: tool.name, reason: 'no_provider' });

      return {
        receipt: createReceipt(
          tool.name,
          context,
          started,
          'approval_unavailable',
          'unavailable',
          'Approval provider is unavailable',
          null,
        ),
        approval: 'unavailable',
      };
    }

    let request: ApprovalRequest;

    try {
      request = await approvalRequest(args, context);
    } catch (error) {
      return {
        receipt: createReceipt(
          tool.name,
          context,
          started,
          'failure',
          'required',
          `Approval request could not be prepared: ${formatError(error)}`,
          null,
        ),
        approval: 'required',
      };
    }

    context.logger.info('approval.requested', approvalLogMetadata(tool.name, request));

    let outcome: ApprovalOutcome;

    try {
      outcome = await this.approvalProvider.requestApproval(request, {
        signal: context.signal,
      });
    } catch (error) {
      if (context.signal.aborted || isAbortError(error)) {
        context.logger.warn('approval.cancelled', approvalLogMetadata(tool.name, request));

        return {
          receipt: createReceipt(
            tool.name,
            context,
            started,
            'cancelled',
            'cancelled',
            'Approval cancelled',
            null,
          ),
          approval: 'cancelled',
        };
      }

      context.logger.error('approval.unavailable', {
        ...approvalLogMetadata(tool.name, request),
        reason: 'provider_error',
      });

      return {
        receipt: createReceipt(
          tool.name,
          context,
          started,
          'approval_unavailable',
          'unavailable',
          'Approval provider failed',
          null,
        ),
        approval: 'unavailable',
      };
    }

    if (outcome === 'approved') {
      context.logger.info('approval.granted', approvalLogMetadata(tool.name, request));

      return { receipt: null, approval: 'approved' };
    }

    if (outcome === 'cancelled') {
      context.logger.warn('approval.cancelled', approvalLogMetadata(tool.name, request));

      return {
        receipt: createReceipt(
          tool.name,
          context,
          started,
          'cancelled',
          'cancelled',
          'Approval cancelled',
          null,
        ),
        approval: 'cancelled',
      };
    }

    if (outcome === 'denied') {
      context.logger.warn('approval.denied', approvalLogMetadata(tool.name, request));

      return {
        receipt: createReceipt(
          tool.name,
          context,
          started,
          'denied',
          'denied',
          'Operation denied by user',
          null,
        ),
        approval: 'denied',
      };
    }

    context.logger.error('approval.unavailable', {
      ...approvalLogMetadata(tool.name, request),
      reason: 'unavailable',
    });

    return {
      receipt: createReceipt(
        tool.name,
        context,
        started,
        'approval_unavailable',
        'unavailable',
        'Approval is unavailable',
        null,
      ),
      approval: 'unavailable',
    };
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

  if (
    definition.approvalRequest !== undefined &&
    typeof definition.approvalRequest !== 'function'
  ) {
    throw new Error(`Tool approval request handler is invalid: ${definition.name}`);
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
  approval: ToolApprovalStatus,
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
    approval,
    verification,
    result,
    error,
    durationMs: Math.max(0, completed.getTime() - started.getTime()),
    startedAt: started.toISOString(),
    completedAt: completed.toISOString(),
  };
}

function approvalLogMetadata(toolName: string, request: ApprovalRequest): Record<string, unknown> {
  return {
    toolName,
    operation: request.operation,
    root: request.root,
    relativePath: request.relativePath,
    absolutePath: request.absolutePath,
    contentBytes: request.content?.bytes ?? null,
    contentSha256: request.content?.sha256 ?? null,
  };
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
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
