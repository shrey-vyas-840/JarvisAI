import {
  VISION_RESPONSE_JSON_SCHEMA,
  VisionError,
  visionResponseSchema,
  type VisionElement,
} from './types.js';
import {
  isRectWithinImage,
  normalizedRectToImageRect,
  VISION_COORDINATE_GRID,
} from './coordinates.js';

export interface VisionAnalyzerOptions {
  readonly baseUrl: string;
  readonly model: string;
  readonly timeoutMs?: number | undefined;
  readonly fetch?: typeof fetch | undefined;
}

export interface VisionCapability {
  readonly supported: boolean;
  readonly capabilities: readonly string[];
  readonly model: string;
}

export interface VisionAnalysisInput {
  readonly imageBase64: string;
  readonly imageWidth: number;
  readonly imageHeight: number;
  readonly target: string;
  readonly contextLabel?: string | undefined;
}

export interface VisionAnalysisResult {
  readonly model: string;
  readonly summary: string | null;
  readonly elements: readonly VisionElement[];
  readonly invalidElementCount: number;
  readonly elapsedMs: number;
}

interface VisionModelInfo {
  readonly capabilities?: unknown;
  readonly projector_info?: {
    readonly clip?: {
      readonly has_vision_encoder?: unknown;
    };
  };
}

interface VisionChatResponse {
  readonly model?: unknown;
  readonly message?: {
    readonly content?: unknown;
  };
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const DEFAULT_NUM_CTX = 8192;
const DEFAULT_NUM_PREDICT = 1200;

export class VisionAnalyzer {
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;
  private capabilityCache: VisionCapability | null = null;

  public constructor(options: VisionAnalyzerOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.model = options.model;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = options.fetch ?? fetch;

    if (this.timeoutMs < 1) {
      throw new Error('Vision timeout must be at least 1 ms.');
    }
  }

  public async getCapability(options: { signal?: AbortSignal } = {}): Promise<VisionCapability> {
    if (this.capabilityCache !== null) {
      return this.capabilityCache;
    }

    const data = await this.requestJson<VisionModelInfo>(
      '/api/show',
      { model: this.model },
      options.signal,
      'inspect the local vision model',
    );
    const capabilities = Array.isArray(data.capabilities)
      ? data.capabilities.filter((item): item is string => typeof item === 'string')
      : [];
    const hasVisionEncoder = data.projector_info?.clip?.has_vision_encoder === true;
    const supported = capabilities.includes('vision') || hasVisionEncoder;

    this.capabilityCache = {
      supported,
      capabilities,
      model: this.model,
    };

    return this.capabilityCache;
  }

  public async assertVisionSupport(
    options: { signal?: AbortSignal } = {},
  ): Promise<VisionCapability> {
    const capability = await this.getCapability(options);

    if (!capability.supported) {
      throw new VisionError(
        'unsupported_model',
        `Local Ollama model "${this.model}" does not report image/vision capability. Refusing to guess screen coordinates.`,
      );
    }

    return capability;
  }

  public async analyze(
    input: VisionAnalysisInput,
    options: { signal?: AbortSignal } = {},
  ): Promise<VisionAnalysisResult> {
    validateAnalysisInput(input);
    await this.assertVisionSupport(options);

    const started = Date.now();
    const response = await this.requestJson<VisionChatResponse>(
      '/api/chat',
      {
        model: this.model,
        messages: [
          {
            role: 'user',
            content: buildVisionPrompt(input),
            images: [input.imageBase64],
          },
        ],
        stream: false,
        think: false,
        format: VISION_RESPONSE_JSON_SCHEMA,
        options: {
          temperature: 0,
          num_ctx: DEFAULT_NUM_CTX,
          num_predict: DEFAULT_NUM_PREDICT,
        },
      },
      options.signal,
      'analyze the screenshot',
    );

    const content = response.message?.content;

    if (typeof content !== 'string' || content.trim().length === 0) {
      throw new VisionError(
        'invalid_response',
        'Local vision model returned an empty response. No coordinates were used.',
      );
    }

    const parsed = parseModelJson(content);
    const validated = visionResponseSchema.safeParse(parsed);

    if (!validated.success) {
      throw new VisionError(
        'invalid_response',
        'Local vision model returned a response that did not match the required element schema.',
      );
    }

    const validElements: VisionElement[] = [];
    let invalidElementCount = 0;

    for (const element of validated.data.elements) {
      if (!isRectWithinImage(element, VISION_COORDINATE_GRID, VISION_COORDINATE_GRID)) {
        invalidElementCount += 1;
        continue;
      }

      const imageRect = normalizedRectToImageRect(
        {
          x: element.x,
          y: element.y,
          width: element.width,
          height: element.height,
        },
        input.imageWidth,
        input.imageHeight,
      );

      validElements.push({
        x: imageRect.x,
        y: imageRect.y,
        width: imageRect.width,
        height: imageRect.height,
        label: element.label,
        ...(element.role !== undefined ? { role: element.role } : {}),
        ...(element.confidence !== undefined ? { confidence: element.confidence } : {}),
      });
    }

    return {
      model: typeof response.model === 'string' ? response.model : this.model,
      summary: validated.data.summary ?? null,
      elements: validElements,
      invalidElementCount,
      elapsedMs: Math.max(0, Date.now() - started),
    };
  }

  private async requestJson<T>(
    endpoint: string,
    body: Record<string, unknown>,
    externalSignal: AbortSignal | undefined,
    action: string,
  ): Promise<T> {
    if (externalSignal?.aborted) {
      throw new VisionError('aborted', 'Vision request cancelled.');
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
        response = await this.fetchImpl(`${this.baseUrl}${endpoint}`, {
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
          throw new VisionError(
            'timeout',
            `Local Ollama ${action} timed out after ${String(this.timeoutMs)} ms.`,
            null,
            { cause: error },
          );
        }

        if (externalSignal?.aborted) {
          throw new VisionError('aborted', 'Vision request cancelled.', null, { cause: error });
        }

        throw new VisionError('network', `Could not reach local Ollama to ${action}.`, null, {
          cause: error,
        });
      }

      if (!response.ok) {
        throw new VisionError(
          'http',
          `Local Ollama returned HTTP ${String(response.status)} while trying to ${action}.`,
          response.status,
        );
      }

      try {
        return (await response.json()) as T;
      } catch (error) {
        throw new VisionError(
          'invalid_response',
          `Local Ollama returned invalid JSON while trying to ${action}.`,
          null,
          { cause: error },
        );
      }
    } finally {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onAbort);
    }
  }
}

function validateAnalysisInput(input: VisionAnalysisInput): void {
  if (!Number.isInteger(input.imageWidth) || input.imageWidth < 1) {
    throw new Error('imageWidth must be a positive integer.');
  }

  if (!Number.isInteger(input.imageHeight) || input.imageHeight < 1) {
    throw new Error('imageHeight must be a positive integer.');
  }

  if (input.target.trim().length === 0) {
    throw new Error('Vision target description is required.');
  }

  if (input.target.length > 500) {
    throw new Error('Vision target description is too long.');
  }

  if (input.imageBase64.length === 0 || input.imageBase64.length > MAX_IMAGE_BYTES) {
    throw new Error('Vision screenshot data is empty or too large.');
  }
}

function buildVisionPrompt(input: VisionAnalysisInput): string {
  const trimmedContext = input.contextLabel?.trim();
  const context =
    trimmedContext !== undefined && trimmedContext.length > 0 ? trimmedContext : 'screen';

  return [
    'You are a precise local UI element detector.',
    `Analyze this ${context} screenshot for the user's target: ${input.target.trim()}`,
    '',
    'Return only JSON matching the provided schema.',
    'Coordinates MUST be normalized integers on a 0-1000 grid: x=0 is the left edge and x=1000 is the right edge; y=0 is the top edge and y=1000 is the bottom edge.',
    'width and height use the same 0-1000 grid. Keep x+width and y+height within 1000.',
    'Always include a confidence from 0 to 1 for every element.',
    'Include visible interactive controls and relevant text near the target.',
    'If nothing matches, return an empty elements array. Never guess coordinates.',
  ].join('\n');
}

function parseModelJson(content: string): unknown {
  const trimmed = content.trim();
  const withoutFence = trimmed
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim();

  try {
    return JSON.parse(withoutFence) as unknown;
  } catch {
    const firstBrace = withoutFence.indexOf('{');
    const lastBrace = withoutFence.lastIndexOf('}');

    if (firstBrace === -1 || lastBrace <= firstBrace) {
      throw new VisionError(
        'invalid_response',
        'Local vision model did not return valid JSON object content.',
      );
    }

    try {
      return JSON.parse(withoutFence.slice(firstBrace, lastBrace + 1)) as unknown;
    } catch {
      throw new VisionError(
        'invalid_response',
        'Local vision model returned malformed JSON. No coordinates were used.',
      );
    }
  }
}
