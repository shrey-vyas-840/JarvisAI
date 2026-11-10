import { describe, expect, it } from 'vitest';

import { VisionAnalyzer } from '../../src/vision/vision-analyzer.js';
import { VisionError } from '../../src/vision/types.js';

interface RecordedRequest {
  readonly url: string;
  readonly body: Record<string, unknown>;
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function requestUrl(input: string | URL | Request): string {
  if (typeof input === 'string') {
    return input;
  }

  if (input instanceof URL) {
    return input.href;
  }

  return input.url;
}

function createFetch(
  show: Record<string, unknown>,
  chat: Record<string, unknown>,
): { fetch: typeof fetch; requests: RecordedRequest[] } {
  const requests: RecordedRequest[] = [];
  const fetchImpl: typeof fetch = (input, init) => {
    if (typeof init?.body !== 'string') {
      throw new Error('Expected JSON request body');
    }

    requests.push({
      url: requestUrl(input),
      body: JSON.parse(init.body) as Record<string, unknown>,
    });

    return Promise.resolve(jsonResponse(requestUrl(input).endsWith('/api/show') ? show : chat));
  };

  return { fetch: fetchImpl, requests };
}

describe('VisionAnalyzer', () => {
  it('sends a structured local vision request and keeps only in-bounds elements', async () => {
    const { fetch: fetchImpl, requests } = createFetch(
      { capabilities: ['completion', 'vision', 'tools'] },
      {
        model: 'qwen3.5:9b',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            summary: 'Chrome toolbar is visible.',
            elements: [
              {
                x: 10,
                y: 20,
                width: 50,
                height: 30,
                label: 'Extensions',
                role: 'button',
                confidence: 0.92,
              },
              {
                x: 900,
                y: 700,
                width: 200,
                height: 200,
                label: 'Out of bounds',
              },
            ],
          }),
        },
      },
    );
    const analyzer = new VisionAnalyzer({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      fetch: fetchImpl,
    });

    const result = await analyzer.analyze({
      imageBase64: 'iVBORw0KGgo=',
      imageWidth: 500,
      imageHeight: 400,
      target: 'the Chrome extensions button',
      contextLabel: 'Chrome window',
    });

    expect(result.elements).toHaveLength(1);
    expect(result.elements[0]).toMatchObject({
      x: 5,
      y: 8,
      width: 25,
      height: 12,
      label: 'Extensions',
    });
    expect(result.invalidElementCount).toBe(1);
    expect(result.summary).toBe('Chrome toolbar is visible.');
    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toBe('http://127.0.0.1:11434/api/show');

    const chatBody = requests[1]?.body;
    expect(chatBody).toMatchObject({
      model: 'qwen3.5:9b',
      stream: false,
      think: false,
      options: {
        temperature: 0,
      },
    });
    expect(chatBody?.format).toMatchObject({ type: 'object' });
    expect(chatBody?.messages).toEqual([
      expect.objectContaining({
        role: 'user',
        images: ['iVBORw0KGgo='],
      }),
    ]);
    expect(JSON.stringify(chatBody?.messages)).toContain('0-1000 grid');
    expect(JSON.stringify(requests)).not.toContain('data:image');
  });

  it('refuses to analyze images when the configured model has no vision capability', async () => {
    const { fetch: fetchImpl, requests } = createFetch(
      { capabilities: ['completion', 'tools'] },
      { message: { content: '{}' } },
    );
    const analyzer = new VisionAnalyzer({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'text-only',
      fetch: fetchImpl,
    });

    await expect(
      analyzer.analyze({
        imageBase64: 'iVBORw0KGgo=',
        imageWidth: 100,
        imageHeight: 100,
        target: 'button',
      }),
    ).rejects.toMatchObject({
      name: 'VisionError',
      kind: 'unsupported_model',
    });
    expect(requests).toHaveLength(1);
  });

  it('rejects malformed model output without using coordinates', async () => {
    const { fetch: fetchImpl } = createFetch(
      { capabilities: ['vision'] },
      { message: { content: 'not json at all' } },
    );
    const analyzer = new VisionAnalyzer({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      fetch: fetchImpl,
    });

    await expect(
      analyzer.analyze({
        imageBase64: 'iVBORw0KGgo=',
        imageWidth: 100,
        imageHeight: 100,
        target: 'button',
      }),
    ).rejects.toBeInstanceOf(VisionError);
  });

  it('accepts models that expose a vision projector without a capabilities array', async () => {
    const { fetch: fetchImpl } = createFetch(
      { projector_info: { clip: { has_vision_encoder: true } } },
      {
        message: {
          content: '{"elements":[]}',
        },
      },
    );
    const analyzer = new VisionAnalyzer({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      fetch: fetchImpl,
    });

    const result = await analyzer.analyze({
      imageBase64: 'iVBORw0KGgo=',
      imageWidth: 100,
      imageHeight: 100,
      target: 'button',
    });

    expect(result.elements).toEqual([]);
  });
});
