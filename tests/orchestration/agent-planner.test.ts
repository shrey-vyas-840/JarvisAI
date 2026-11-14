import { describe, expect, it } from 'vitest';

import { AgentPlanningError, parseAgentPlan } from '../../src/orchestration/agent-planner.js';
import type { OllamaToolDefinition } from '../../src/llm/ollama-client.js';

const tools: OllamaToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_text_file',
      description: 'Read a text file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_text_file',
      description: 'Write a text file.',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  },
];

function planJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    goal: 'Read and then write a file safely.',
    steps: [
      {
        id: 'read',
        description: 'Inspect the source file.',
        tool: 'read_text_file',
        args: { path: 'workspace/source.txt' },
        dependsOn: [],
        argumentSources: {},
        preconditions: ['The file path is within the configured workspace.'],
        expectedOutcome: 'The source text is observed.',
        verificationMethod: 'Inspect the returned text.',
        failurePolicy: 'Stop dependent writes if the read fails.',
        requiresVerifiedReceipt: false,
      },
      {
        id: 'write',
        description: 'Write a new artifact only after the read.',
        tool: 'write_text_file',
        args: { path: 'workspace/output.txt' },
        dependsOn: ['read'],
        argumentSources: { content: { stepId: 'read', resultPath: ['text'] } },
        preconditions: ['The source result is verified.'],
        expectedOutcome: 'A new file is written without overwrite.',
        verificationMethod: 'Read the output file back.',
        failurePolicy: 'Do not retry if delivery is uncertain.',
        requiresVerifiedReceipt: false,
      },
    ],
    ...overrides,
  });
}

describe('parseAgentPlan', () => {
  it('converts a model plan into backend-derived orchestrator steps', () => {
    const result = parseAgentPlan(planJson(), tools);

    expect(result.steps.map((step) => step.tool)).toEqual(['read_text_file', 'write_text_file']);
    expect(result.steps.every((step) => step.backend === 'local')).toBe(true);
    expect(result.steps[1]?.argumentSources?.content).toEqual({
      stepId: 'read',
      resultPath: ['text'],
    });
  });

  it('rejects unknown tools and invalid result dependencies before execution', () => {
    expect(() =>
      parseAgentPlan(
        planJson({
          steps: [
            {
              id: 'unknown',
              description: 'Bad tool.',
              tool: 'not_registered',
              args: {},
              dependsOn: [],
              argumentSources: {},
              preconditions: [],
              expectedOutcome: 'Never.',
              verificationMethod: 'Never.',
              failurePolicy: 'Stop.',
              requiresVerifiedReceipt: false,
            },
          ],
        }),
        tools,
      ),
    ).toThrow(AgentPlanningError);

    const invalidSource = planJson().replace('"dependsOn":["read"]', '"dependsOn":[]');
    expect(() => parseAgentPlan(invalidSource, tools)).toThrow('must depend on source step');
  });
});
