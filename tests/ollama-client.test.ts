import { describe, expect, it } from 'vitest';

import {
  OllamaClient,
  OllamaRequestError,
  type OllamaToolDefinition,
} from '../src/llm/ollama-client.js';

interface RecordedRequest {
  url: string;
  body: Record<string, unknown>;
  signal: AbortSignal | null | undefined;
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

function chatResponse(content: string): Record<string, unknown> {
  return {
    model: 'qwen3.5:9b',
    message: { role: 'assistant', content },
    done: true,
    done_reason: 'stop',
    total_duration: 123,
    load_duration: 10,
    prompt_eval_count: 20,
    prompt_eval_duration: 30,
    eval_count: 40,
    eval_duration: 50,
  };
}

const statusTool: OllamaToolDefinition = {
  type: 'function',
  function: {
    name: 'get_jarvis_status',
    description: 'Return runtime status.',
    parameters: {
      type: 'object',
      properties: {},
      additionalProperties: false,
    },
  },
};

describe('OllamaClient', () => {
  it('sends a non-streaming structured chat request and maps the response', async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const body = init?.body;

      if (typeof body !== 'string') {
        throw new Error('Expected a string request body');
      }

      requests.push({
        url: requestUrl(input),
        body: JSON.parse(body) as Record<string, unknown>,
        signal: init?.signal,
      });

      return Promise.resolve(
        jsonResponse({
          ...chatResponse('JARVIS is ready.'),
          message: {
            role: 'assistant',
            content: 'JARVIS is ready.',
            tool_calls: [
              {
                type: 'function',
                id: 'call-1',
                function: {
                  name: 'get_jarvis_status',
                  arguments: {},
                  index: 0,
                },
              },
            ],
          },
        }),
      );
    };
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      fetch: fetchImpl,
    });

    const result = await client.chat({
      messages: [{ role: 'user', content: 'status' }],
      tools: [statusTool],
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe('http://127.0.0.1:11434/api/chat');
    expect(requests[0]?.body).toMatchObject({
      model: 'qwen3.5:9b',
      stream: false,
      think: false,
      options: {
        num_ctx: 4096,
        temperature: 0.2,
        num_predict: 512,
      },
    });
    expect(requests[0]?.body.tools).toEqual([statusTool]);
    expect(result.message.tool_calls).toEqual([
      {
        type: 'function',
        id: 'call-1',
        function: {
          name: 'get_jarvis_status',
          arguments: {},
          index: 0,
        },
      },
    ]);
    expect(result.doneReason).toBe('stop');
    expect(result.metrics).toEqual({
      totalDurationMs: 123,
      loadDurationMs: 10,
      promptEvalCount: 20,
      promptEvalDurationMs: 30,
      evalCount: 40,
      evalDurationMs: 50,
    });
  });

  it('retries one transient network failure', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = () => {
      attempts += 1;

      if (attempts === 1) {
        return Promise.reject(new Error('connection reset'));
      }

      return Promise.resolve(jsonResponse(chatResponse('Recovered')));
    };
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      fetch: fetchImpl,
    });

    const result = await client.chat({
      messages: [{ role: 'user', content: 'hello' }],
    });

    expect(attempts).toBe(2);
    expect(result.message.content).toBe('Recovered');
  });

  it('requests Ollama JSON mode for structured planner responses', async () => {
    const requests: RecordedRequest[] = [];
    const fetchImpl: typeof fetch = (input, init) => {
      const body = init?.body;
      if (typeof body !== 'string') throw new Error('Expected request body');
      requests.push({
        url: requestUrl(input),
        body: JSON.parse(body) as Record<string, unknown>,
        signal: init?.signal,
      });
      return Promise.resolve(jsonResponse(chatResponse('{"goal":"test","steps":[]}')));
    };
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      fetch: fetchImpl,
    });

    await client.chat({ messages: [{ role: 'user', content: 'plan' }], format: 'json' });

    expect(requests[0]?.body.format).toBe('json');
  });

  it('does not retry a non-retryable HTTP error', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      return Promise.resolve(jsonResponse({ error: 'bad request' }, 400));
    };
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      fetch: fetchImpl,
    });

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toMatchObject({
      name: 'OllamaRequestError',
      kind: 'http',
      status: 400,
    });
    expect(attempts).toBe(1);
  });

  it('rejects invalid response bodies without retrying', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      return Promise.resolve(jsonResponse({ unexpected: true }));
    };
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      fetch: fetchImpl,
    });

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toMatchObject({
      name: 'OllamaRequestError',
      kind: 'invalid_response',
    });
    expect(attempts).toBe(1);
  });

  it('times out an aborted request without retrying when retries are disabled', async () => {
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => {
            reject(new DOMException('Aborted', 'AbortError'));
          },
          { once: true },
        );
      });
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      timeoutMs: 5,
      retryCount: 0,
      fetch: fetchImpl,
    });

    await expect(
      client.chat({ messages: [{ role: 'user', content: 'hello' }] }),
    ).rejects.toMatchObject({
      kind: 'timeout',
    });
  });

  it('rejects an already-cancelled request without calling fetch', async () => {
    let attempts = 0;
    const fetchImpl: typeof fetch = () => {
      attempts += 1;
      return Promise.resolve(jsonResponse(chatResponse('unexpected')));
    };
    const client = new OllamaClient({
      baseUrl: 'http://127.0.0.1:11434',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      fetch: fetchImpl,
    });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.chat(
        { messages: [{ role: 'user', content: 'hello' }] },
        { signal: controller.signal },
      ),
    ).rejects.toBeInstanceOf(OllamaRequestError);
    expect(attempts).toBe(0);
  });
});
