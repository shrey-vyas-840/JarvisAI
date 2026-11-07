import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { AgentLoop, type ChatClient } from '../src/core/agent-loop.js';
import { ToolRegistry } from '../src/core/tool-registry.js';
import type {
  OllamaChatRequest,
  OllamaChatResult,
  OllamaToolCall,
} from '../src/llm/ollama-client.js';
import { Logger } from '../src/logging/logger.js';
import { createCreateDirectoryTool } from '../src/tools/filesystem/create-directory.js';
import { createWriteTextFileTool } from '../src/tools/filesystem/write-text-file.js';
import {
  createTempRoots,
  FakeApprovalProvider,
  type TempRoots,
} from './tools/filesystem/helpers.js';

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

function createRegistry(roots: TempRoots, provider: FakeApprovalProvider): ToolRegistry {
  const registry = new ToolRegistry({ approvalProvider: provider });

  registry.register(createCreateDirectoryTool({ guard: roots.guard }));
  registry.register(createWriteTextFileTool({ guard: roots.guard }));

  return registry;
}

describe('AgentLoop approval-gated filesystem integration', () => {
  it('executes approved create_directory then write_text_file with real verified results', async () => {
    const roots = createTempRoots();
    const provider = new FakeApprovalProvider('approved', 'approved');
    const registry = createRegistry(roots, provider);
    const client = new FakeClient([
      response('', [
        toolCall('create_directory', { root: 'workspace', relativePath: 'projects' }),
        toolCall('write_text_file', {
          root: 'workspace',
          relativePath: 'projects/README.md',
          content: '# JARVIS\n\nApproved text file.\n',
        }),
      ]),
      response('Created the project directory and README file.'),
    ]);

    try {
      const result = await createLoop(client, registry).run({
        userMessage: 'Create a project directory and README in the workspace.',
        executionId: 'approval-integration',
      });

      expect(result.status).toBe('success');
      expect(result.finalResponse).toBe('Created the project directory and README file.');
      expect(result.receipts).toHaveLength(2);
      expect(result.receipts[0]).toMatchObject({
        toolName: 'create_directory',
        status: 'success',
        approval: 'approved',
        verification: 'verified',
      });
      expect(result.receipts[1]).toMatchObject({
        toolName: 'write_text_file',
        status: 'success',
        approval: 'approved',
        verification: 'verified',
      });
      expect(existsSync(path.join(roots.workspace, 'projects'))).toBe(true);
      expect(readFileSync(path.join(roots.workspace, 'projects', 'README.md'), 'utf8')).toBe(
        '# JARVIS\n\nApproved text file.\n',
      );
      expect(provider.requests).toHaveLength(2);
      expect(provider.requests.map((request) => request.toolName)).toEqual([
        'create_directory',
        'write_text_file',
      ]);

      const toolMessages = client.requests[1]?.messages.filter(
        (message) => message.role === 'tool',
      );

      expect(toolMessages).toHaveLength(2);
      expect(toolMessages?.[0]?.content).toContain('"status":"success"');
      expect(toolMessages?.[0]?.content).toContain('"verification":"verified"');
      expect(toolMessages?.[1]?.content).toContain('"status":"success"');
    } finally {
      roots.cleanup();
    }
  });

  it('stops the run after denial and never executes later side-effecting calls', async () => {
    const roots = createTempRoots();
    const provider = new FakeApprovalProvider('denied', 'approved');
    const registry = createRegistry(roots, provider);
    const client = new FakeClient([
      response('', [
        toolCall('write_text_file', {
          root: 'workspace',
          relativePath: 'first.txt',
          content: 'first',
        }),
        toolCall('create_directory', { root: 'workspace', relativePath: 'second' }),
      ]),
    ]);

    try {
      const result = await createLoop(client, registry).run({
        userMessage: 'Create two filesystem entries.',
        executionId: 'approval-denied',
      });

      expect(result.status).toBe('failure');
      expect(result.error).toBe('Operation denied by user');
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]).toMatchObject({
        toolName: 'write_text_file',
        status: 'denied',
        approval: 'denied',
        verification: 'not_applicable',
        result: null,
      });
      expect(result.toolCallCount).toBe(1);
      expect(client.requests).toHaveLength(1);
      expect(provider.requests).toHaveLength(1);
      expect(existsSync(path.join(roots.workspace, 'first.txt'))).toBe(false);
      expect(existsSync(path.join(roots.workspace, 'second'))).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('stops the run when approval is unavailable and never executes the write', async () => {
    const roots = createTempRoots();
    const registry = new ToolRegistry();
    registry.register(createWriteTextFileTool({ guard: roots.guard }));
    const client = new FakeClient([
      response('', [
        toolCall('write_text_file', {
          root: 'workspace',
          relativePath: 'unavailable.txt',
          content: 'text',
        }),
      ]),
    ]);

    try {
      const result = await createLoop(client, registry).run({
        userMessage: 'Write a file.',
        executionId: 'approval-unavailable',
      });

      expect(result.status).toBe('failure');
      expect(result.error).toBe('Approval provider is unavailable');
      expect(result.receipts).toHaveLength(1);
      expect(result.receipts[0]).toMatchObject({
        status: 'approval_unavailable',
        approval: 'unavailable',
        result: null,
      });
      expect(existsSync(path.join(roots.workspace, 'unavailable.txt'))).toBe(false);
      expect(client.requests).toHaveLength(1);
    } finally {
      roots.cleanup();
    }
  });
});
