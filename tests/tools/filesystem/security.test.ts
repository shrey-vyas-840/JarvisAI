import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../../../src/config.js';
import { AgentLoop, type ChatClient } from '../../../src/core/agent-loop.js';
import { ToolRegistry } from '../../../src/core/tool-registry.js';
import type {
  OllamaChatRequest,
  OllamaChatResult,
  OllamaToolCall,
} from '../../../src/llm/ollama-client.js';
import { Logger } from '../../../src/logging/logger.js';
import {
  createFilesystemTools,
  registerFilesystemTools,
} from '../../../src/tools/filesystem/index.js';
import type { TempRoots } from './helpers.js';
import { asArray, asRecord, createTempRoots, writeText } from './helpers.js';

const logger = new Logger({ level: 'debug', logDir: 'unused', console: false, file: false });

class FakeClient implements ChatClient {
  public readonly requests: OllamaChatRequest[] = [];
  private readonly responses: OllamaChatResult[];

  public constructor(responses: readonly OllamaChatResult[]) {
    this.responses = [...responses];
  }

  public chat(request: OllamaChatRequest): Promise<OllamaChatResult> {
    this.requests.push(request);
    const response = this.responses.shift();

    if (response === undefined) {
      return Promise.reject(new Error('No fake response remains'));
    }

    return Promise.resolve(response);
  }
}

function response(content: string, toolCalls: readonly OllamaToolCall[] = []): OllamaChatResult {
  return {
    model: 'qwen3.5:9b',
    message: {
      role: 'assistant',
      content,
      ...(toolCalls.length > 0 ? { tool_calls: [...toolCalls] } : {}),
    },
    done: true,
    doneReason: 'stop',
    metrics: {
      totalDurationMs: null,
      loadDurationMs: null,
      promptEvalCount: null,
      promptEvalDurationMs: null,
      evalCount: null,
      evalDurationMs: null,
    },
  };
}

function toolCall(name: string, args: Record<string, unknown>): OllamaToolCall {
  return { function: { name, arguments: args } };
}

function createConfig(roots: TempRoots): ReturnType<typeof loadConfig> {
  return loadConfig({
    env: {
      JARVIS_WORKSPACE: roots.workspace,
      JARVIS_EXPORTS: roots.exports,
    },
    loadDotEnv: false,
  });
}

function createLoop(client: ChatClient, registry: ToolRegistry): AgentLoop {
  let nextId = 0;

  return new AgentLoop({
    client,
    registry,
    logger,
    now: () => new Date('2026-11-07T00:00:00.000Z'),
    idFactory: () => {
      nextId += 1;
      return `id-${String(nextId)}`;
    },
  });
}

function toolMessages(request: OllamaChatRequest | undefined): Record<string, unknown>[] {
  return asArray(request?.messages)
    .map(asRecord)
    .filter((message) => message.role === 'tool');
}

describe('filesystem tools through the ToolRegistry', () => {
  it('registers seven tools with read-only and approval-gated permissions', () => {
    const roots = createTempRoots();

    try {
      const config = createConfig(roots);
      const tools = createFilesystemTools(config);

      expect(tools.map((tool) => [tool.name, tool.permission])).toEqual([
        ['list_directory', 'read-only'],
        ['read_text_file', 'read-only'],
        ['search_text', 'read-only'],
        ['get_file_info', 'read-only'],
        ['create_directory', 'requires-approval'],
        ['write_text_file', 'requires-approval'],
        ['verify_artifact', 'read-only'],
      ]);

      for (const tool of tools) {
        expect(asRecord(tool.parameters)).toMatchObject({
          type: 'object',
          additionalProperties: false,
        });
      }

      const registry = new ToolRegistry();
      registerFilesystemTools(registry, config);

      const ollamaTools = registry.getOllamaTools();
      const names = ollamaTools.map((tool) => tool.function.name);

      expect(names).toEqual([
        'list_directory',
        'read_text_file',
        'search_text',
        'get_file_info',
        'create_directory',
        'write_text_file',
        'verify_artifact',
      ]);

      const readTool = ollamaTools.find((tool) => tool.function.name === 'read_text_file');
      const readParameters = asRecord(readTool?.function.parameters);
      const properties = asRecord(readParameters.properties);
      const rootProperty = asRecord(properties.root);

      expect(readParameters).toMatchObject({
        type: 'object',
        required: ['root', 'relativePath'],
        additionalProperties: false,
      });
      expect(rootProperty.enum).toEqual(['workspace', 'exports']);
      expect(asRecord(properties.relativePath).type).toBe('string');
    } finally {
      roots.cleanup();
    }
  });

  it('executes a real read requested by the model and returns the real result', async () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'hello.txt', 'Hello from the real workspace file.');
      const config = createConfig(roots);
      const registry = new ToolRegistry();

      registerFilesystemTools(registry, config);

      const client = new FakeClient([
        response('', [
          toolCall('read_text_file', {
            root: 'workspace',
            relativePath: 'hello.txt',
          }),
        ]),
        response('The file contains: Hello from the real workspace file.'),
      ]);
      const result = await createLoop(client, registry).run({
        userMessage: 'Read hello.txt from the workspace.',
        executionId: 'fs-integration-read',
      });

      expect(result.status).toBe('success');
      expect(result.finalResponse).toBe('The file contains: Hello from the real workspace file.');
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]).toMatchObject({
        toolName: 'read_text_file',
        status: 'success',
        verification: 'verified',
        result: {
          root: 'workspace',
          content: 'Hello from the real workspace file.',
          truncated: false,
          verificationStatus: 'verified',
        },
      });

      const requestedNames = asArray(client.requests[0]?.tools).map(
        (tool) => asRecord(asRecord(tool).function).name,
      );

      expect(requestedNames).toContain('read_text_file');

      const [toolMessage] = toolMessages(client.requests[1]);
      const payload = JSON.parse(String(toolMessage?.content)) as Record<string, unknown>;

      expect(toolMessage?.tool_name).toBe('read_text_file');
      expect(payload).toMatchObject({
        status: 'success',
        verification: 'verified',
        result: { content: 'Hello from the real workspace file.' },
      });
    } finally {
      roots.cleanup();
    }
  });

  it('executes list_directory and get_file_info through the registry', async () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'alpha.txt', 'one');
      writeText(roots.workspace, 'folder/beta.txt', 'two');
      const config = createConfig(roots);
      const registry = new ToolRegistry();

      registerFilesystemTools(registry, config);

      const client = new FakeClient([
        response('', [
          toolCall('list_directory', { root: 'workspace', relativePath: '' }),
          toolCall('get_file_info', { root: 'workspace', relativePath: '' }),
        ]),
        response('The workspace contains alpha.txt and folder.'),
      ]);
      const result = await createLoop(client, registry).run({
        userMessage: 'List the workspace and inspect its metadata.',
      });

      expect(result.status).toBe('success');
      expect(result.receipts).toHaveLength(2);
      expect(result.receipts[0]).toMatchObject({
        toolName: 'list_directory',
        status: 'success',
        verification: 'verified',
      });
      expect(result.receipts[1]).toMatchObject({
        toolName: 'get_file_info',
        status: 'success',
        verification: 'verified',
      });

      const listResult = asRecord(result.receipts[0]?.result);
      const infoResult = asRecord(result.receipts[1]?.result);

      expect(asArray(listResult.entries).map((entry) => asRecord(entry).name)).toEqual([
        'alpha.txt',
        'folder',
      ]);
      expect(infoResult).toMatchObject({ type: 'directory', name: 'workspace' });

      const messages = toolMessages(client.requests[1]);

      expect(messages.map((message) => message.tool_name)).toEqual([
        'list_directory',
        'get_file_info',
      ]);
    } finally {
      roots.cleanup();
    }
  });

  it('returns real failures to the model without claiming success', async () => {
    const roots = createTempRoots();

    try {
      const config = createConfig(roots);
      const registry = new ToolRegistry();

      registerFilesystemTools(registry, config);

      const client = new FakeClient([
        response('', [
          toolCall('read_text_file', {
            root: 'workspace',
            relativePath: 'missing.txt',
          }),
        ]),
        response('I could not read the file because it does not exist.'),
      ]);
      const result = await createLoop(client, registry).run({
        userMessage: 'Read missing.txt.',
      });

      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]).toMatchObject({
        toolName: 'read_text_file',
        status: 'failure',
        verification: 'not_applicable',
        result: null,
      });
      expect(result.receipts[0]?.error).toContain('not_found');

      const [toolMessage] = toolMessages(client.requests[1]);
      const payload = JSON.parse(String(toolMessage?.content)) as Record<string, unknown>;

      expect(payload).toMatchObject({ status: 'failure', result: null });
      expect(String(payload.error)).toContain('not_found');
    } finally {
      roots.cleanup();
    }
  });

  it('rejects outside-root access from a model tool call and reads nothing outside', async () => {
    const roots = createTempRoots();

    try {
      const outsideFile = writeText(roots.outside, 'secret.txt', 'OUTSIDE_SECRET_DO_NOT_READ');
      const config = createConfig(roots);
      const registry = new ToolRegistry();

      registerFilesystemTools(registry, config);

      const client = new FakeClient([
        response('', [
          toolCall('read_text_file', {
            root: 'workspace',
            relativePath: outsideFile,
          }),
          toolCall('read_text_file', {
            root: 'workspace',
            relativePath: '..\\outside\\secret.txt',
          }),
        ]),
        response('Both filesystem requests were rejected by the path guard.'),
      ]);
      const result = await createLoop(client, registry).run({
        userMessage: 'Read the file outside the workspace.',
      });

      expect(result.receipts).toHaveLength(2);
      expect(result.receipts[0]).toMatchObject({
        toolName: 'read_text_file',
        status: 'failure',
        result: null,
      });
      expect(result.receipts[0]?.error).toContain('absolute_path');
      expect(result.receipts[1]?.error).toContain('path_traversal');

      const messages = toolMessages(client.requests[1]);

      expect(JSON.stringify(messages)).not.toContain('OUTSIDE_SECRET_DO_NOT_READ');
      expect(
        messages.every((message) => String(message.content).includes('"status":"failure"')),
      ).toBe(true);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects invalid arguments and unknown tools without executing them', async () => {
    const roots = createTempRoots();

    try {
      const config = createConfig(roots);
      const registry = new ToolRegistry();

      registerFilesystemTools(registry, config);

      const client = new FakeClient([
        response('', [
          toolCall('list_directory', { root: 'temp', relativePath: '' }),
          toolCall('delete_file', { root: 'workspace', relativePath: 'alpha.txt' }),
        ]),
        response('Those requests were rejected.'),
      ]);
      const result = await createLoop(client, registry).run({
        userMessage: 'Try invalid tool calls.',
      });

      expect(result.receipts).toHaveLength(2);
      expect(result.receipts[0]?.status).toBe('failure');
      expect(result.receipts[0]?.error).toContain('Invalid arguments');
      expect(result.receipts[1]?.status).toBe('failure');
      expect(result.receipts[1]?.error).toBe('Unknown tool');
      expect(result.receipts.every((receipt) => receipt.result === null)).toBe(true);
    } finally {
      roots.cleanup();
    }
  });

  it('does not treat a file outside the root as a listable directory', async () => {
    const roots = createTempRoots();

    try {
      writeText(roots.outside, 'secret.txt', 'outside');
      const config = createConfig(roots);
      const registry = new ToolRegistry();

      registerFilesystemTools(registry, config);

      const client = new FakeClient([
        response('', [
          toolCall('list_directory', {
            root: 'workspace',
            relativePath: path.join('..', 'outside'),
          }),
        ]),
        response('The outside directory was rejected.'),
      ]);
      const result = await createLoop(client, registry).run({
        userMessage: 'List the outside directory.',
      });

      expect(result.receipts[0]?.status).toBe('failure');
      expect(result.receipts[0]?.error).toContain('path_traversal');
      expect(result.receipts[0]?.result).toBeNull();
    } finally {
      roots.cleanup();
    }
  });
});
