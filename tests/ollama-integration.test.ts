import { createServer, type Server } from 'node:http';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import { AgentLoop } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import { OllamaClient } from '../src/llm/ollama-client.js';
import { Logger } from '../src/logging/logger.js';
import { createGetJarvisStatusTool } from '../src/tools/get-jarvis-status.js';

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a record');
  }

  return value as Record<string, unknown>;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();

  if (address === null || typeof address === 'string') {
    throw new Error('Expected a TCP server address');
  }

  return address.port;
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

describe('Ollama integration', () => {
  it('runs a real HTTP round trip with a structured diagnostic tool call', async () => {
    const config = loadConfig({ env: {}, loadDotEnv: false });
    const requestBodies: Record<string, unknown>[] = [];
    let requestCount = 0;
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];

      request.on('data', (chunk: Buffer) => {
        chunks.push(chunk);
      });
      request.on('end', () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;

        requestBodies.push(body);
        requestCount += 1;

        const payload =
          requestCount === 1
            ? {
                model: config.ollama.model,
                message: {
                  role: 'assistant',
                  content: '',
                  tool_calls: [
                    {
                      function: {
                        name: 'get_jarvis_status',
                        arguments: {},
                      },
                    },
                  ],
                },
                done: true,
                done_reason: 'stop',
              }
            : {
                model: config.ollama.model,
                message: {
                  role: 'assistant',
                  content: 'JARVIS is operational.',
                },
                done: true,
                done_reason: 'stop',
              };

        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(JSON.stringify(payload));
      });
    });
    const port = await listen(server);

    try {
      const logger = new Logger({
        level: 'debug',
        logDir: 'unused',
        console: false,
        file: false,
      });
      const client = new OllamaClient({
        baseUrl: `http://127.0.0.1:${String(port)}`,
        model: config.ollama.model,
        numCtx: config.ollama.numCtx,
      });
      const registry = new ToolRegistry();

      registry.register(createGetJarvisStatusTool(config));

      const result = await new AgentLoop({ client, registry, logger }).run({
        userMessage: 'Call get_jarvis_status exactly once.',
        executionId: 'integration-exec',
      });

      expect(result.status).toBe('success');
      expect(result.finalResponse).toBe('JARVIS is operational.');
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]).toMatchObject({
        toolName: 'get_jarvis_status',
        status: 'success',
        verification: 'verified',
      });
      expect(requestBodies).toHaveLength(2);
      expect(requestBodies[0]).toMatchObject({
        model: config.ollama.model,
        stream: false,
        think: false,
        options: { num_ctx: config.ollama.numCtx },
      });

      const tools = asArray(requestBodies[0]?.tools);

      expect(asRecord(tools[0]).function).toMatchObject({
        name: 'get_jarvis_status',
      });

      const secondMessages = asArray(requestBodies[1]?.messages);
      const toolMessage = secondMessages.map(asRecord).find((message) => message.role === 'tool');
      const toolPayload = JSON.parse(String(toolMessage?.content)) as Record<string, unknown>;

      expect(toolMessage?.tool_name).toBe('get_jarvis_status');
      expect(toolPayload).toMatchObject({
        status: 'success',
        verification: 'verified',
        result: {
          application: 'JARVIS',
          model: config.ollama.model,
          executionId: 'integration-exec',
        },
      });
    } finally {
      await close(server);
    }
  });
});
