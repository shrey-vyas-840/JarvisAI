import { z } from 'zod';

export type OllamaRole = 'system' | 'user' | 'assistant' | 'tool';

export interface OllamaToolCall {
  type?: 'function' | undefined;
  id?: string | undefined;
  function: {
    name: string;
    arguments: Record<string, unknown>;
    index?: number | undefined;
  };
}

export interface OllamaMessage {
  role: OllamaRole;
  content: string;
  tool_calls?: OllamaToolCall[];
  tool_name?: string;
}

export interface OllamaToolDefinition {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface OllamaChatRequest {
  messages: readonly OllamaMessage[];
  tools?: readonly OllamaToolDefinition[];
  format?: 'json';
}

export interface OllamaChatMetrics {
  totalDurationMs: number | null;
  loadDurationMs: number | null;
  promptEvalCount: number | null;
  promptEvalDurationMs: number | null;
  evalCount: number | null;
  evalDurationMs: number | null;
}

export interface OllamaChatResult {
  model: string | null;
  message: OllamaMessage;
  done: boolean | null;
  doneReason: string | null;
  metrics: OllamaChatMetrics;
}

export type OllamaErrorKind = 'http' | 'network' | 'timeout' | 'aborted' | 'invalid_response';

export class OllamaRequestError extends Error {
  public readonly kind: OllamaErrorKind;
  public readonly status: number | null;

  public constructor(
    kind: OllamaErrorKind,
    message: string,
    status: number | null = null,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = 'OllamaRequestError';
    this.kind = kind;
    this.status = status;
  }
}

export interface OllamaClientOptions {
  baseUrl: string;
  model: string;
  numCtx: number;
  temperature?: number;
  numPredict?: number;
  timeoutMs?: number;
  retryCount?: number;
  fetch?: typeof fetch;
}

const DEFAULT_TEMPERATURE = 0.2;
const DEFAULT_NUM_PREDICT = 512;
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_COUNT = 1;

const toolCallSchema = z.object({
  type: z.literal('function').optional(),
  id: z.string().optional(),
  function: z.object({
    name: z.string().min(1),
    arguments: z.record(z.string(), z.unknown()).default({}),
    index: z.number().int().optional(),
  }),
});

const assistantMessageSchema = z.object({
  role: z.string().optional(),
  content: z.string().optional(),
  tool_calls: z.array(toolCallSchema).optional(),
});

const chatResponseSchema = z.object({
  model: z.string().optional(),
  message: assistantMessageSchema,
  done: z.boolean().optional(),
  done_reason: z.string().optional(),
  total_duration: z.number().optional(),
  load_duration: z.number().optional(),
  prompt_eval_count: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
  eval_count: z.number().optional(),
  eval_duration: z.number().optional(),
});

export class OllamaClient {
  private readonly url: string;
  private readonly model: string;
  private readonly numCtx: number;
  private readonly temperature: number;
  private readonly numPredict: number;
  private readonly timeoutMs: number;
  private readonly retryCount: number;
  private readonly fetchImpl: typeof fetch;

  public constructor(options: OllamaClientOptions) {
    this.url = `${options.baseUrl.replace(/\/+$/, '')}/api/chat`;
    this.model = options.model;
    this.numCtx = options.numCtx;
    this.temperature = options.temperature ?? DEFAULT_TEMPERATURE;
    this.numPredict = options.numPredict ?? DEFAULT_NUM_PREDICT;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.retryCount = options.retryCount ?? DEFAULT_RETRY_COUNT;
    this.fetchImpl = options.fetch ?? fetch;

    if (this.numCtx < 1) {
      throw new Error('numCtx must be at least 1');
    }

    if (this.timeoutMs < 1) {
      throw new Error('timeoutMs must be at least 1');
    }

    if (this.retryCount < 0) {
      throw new Error('retryCount must not be negative');
    }
  }

  public async chat(
    request: OllamaChatRequest,
    options: { signal?: AbortSignal } = {},
  ): Promise<OllamaChatResult> {
    if (options.signal?.aborted) {
      throw new OllamaRequestError('aborted', 'Ollama request cancelled');
    }

    const body = this.buildBody(request);
    let lastError: OllamaRequestError | null = null;

    for (let attempt = 0; attempt <= this.retryCount; attempt += 1) {
      try {
        return await this.requestOnce(body, options.signal);
      } catch (error) {
        const normalized =
          error instanceof OllamaRequestError
            ? error
            : new OllamaRequestError('network', formatError(error), null, { cause: error });

        if (!isRetryable(normalized)) {
          throw normalized;
        }

        lastError = normalized;
      }
    }

    throw lastError ?? new OllamaRequestError('network', 'Ollama request failed');
  }

  private buildBody(request: OllamaChatRequest): Record<string, unknown> {
    const body: Record<string, unknown> = {
      model: this.model,
      messages: request.messages,
      stream: false,
      think: false,
      options: {
        num_ctx: this.numCtx,
        temperature: this.temperature,
        num_predict: this.numPredict,
      },
    };

    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools;
    }
    if (request.format !== undefined) {
      body.format = request.format;
    }

    return body;
  }

  private async requestOnce(
    body: Record<string, unknown>,
    externalSignal: AbortSignal | undefined,
  ): Promise<OllamaChatResult> {
    if (externalSignal?.aborted) {
      throw new OllamaRequestError('aborted', 'Ollama request cancelled');
    }

    const controller = new AbortController();
    const timeoutState = { timedOut: false };
    const timer = setTimeout(() => {
      timeoutState.timedOut = true;
      controller.abort();
    }, this.timeoutMs);
    const onAbort = (): void => {
      controller.abort();
    };

    if (externalSignal !== undefined) {
      externalSignal.addEventListener('abort', onAbort, { once: true });
    }

    try {
      let response: Response;

      try {
        response = await this.fetchImpl(this.url, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });
      } catch (error) {
        if (timeoutState.timedOut) {
          throw new OllamaRequestError(
            'timeout',
            `Ollama request timed out after ${String(this.timeoutMs)} ms`,
            null,
            { cause: error },
          );
        }

        if (externalSignal?.aborted) {
          throw new OllamaRequestError('aborted', 'Ollama request cancelled', null, {
            cause: error,
          });
        }

        throw new OllamaRequestError('network', formatError(error), null, { cause: error });
      }

      if (!response.ok) {
        const detail = await readResponseText(response);
        const suffix = detail.length > 0 ? `: ${detail}` : '';
        throw new OllamaRequestError(
          'http',
          `Ollama returned HTTP ${String(response.status)}${suffix}`,
          response.status,
        );
      }

      let data: unknown;

      try {
        data = await response.json();
      } catch (error) {
        throw new OllamaRequestError('invalid_response', 'Ollama returned invalid JSON', null, {
          cause: error,
        });
      }

      const parsed = chatResponseSchema.safeParse(data);

      if (!parsed.success) {
        throw new OllamaRequestError(
          'invalid_response',
          'Ollama returned an invalid chat response',
        );
      }

      return mapResponse(parsed.data);
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }
}

type ParsedChatResponse = z.infer<typeof chatResponseSchema>;

function mapResponse(data: ParsedChatResponse): OllamaChatResult {
  const message: OllamaMessage = {
    role: 'assistant',
    content: data.message.content ?? '',
  };

  if (data.message.tool_calls !== undefined && data.message.tool_calls.length > 0) {
    message.tool_calls = data.message.tool_calls;
  }

  return {
    model: data.model ?? null,
    message,
    done: data.done ?? null,
    doneReason: data.done_reason ?? null,
    metrics: {
      totalDurationMs: data.total_duration ?? null,
      loadDurationMs: data.load_duration ?? null,
      promptEvalCount: data.prompt_eval_count ?? null,
      promptEvalDurationMs: data.prompt_eval_duration ?? null,
      evalCount: data.eval_count ?? null,
      evalDurationMs: data.eval_duration ?? null,
    },
  };
}

function isRetryable(error: OllamaRequestError): boolean {
  if (error.kind === 'network' || error.kind === 'timeout') {
    return true;
  }

  if (error.kind === 'http') {
    return error.status === 429 || (error.status !== null && error.status >= 500);
  }

  return false;
}

async function readResponseText(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.replace(/\s+/g, ' ').trim().slice(0, 300);
  } catch {
    return '';
  }
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return 'Unknown Ollama network error';
}
