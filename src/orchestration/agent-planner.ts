import { z } from 'zod';

import type { OllamaToolDefinition } from '../llm/ollama-client.js';
import { inferBackendFromTool } from './backend-router.js';
import type { Step } from './types.js';

const MAX_STEPS = 48;
const MAX_TEXT_LENGTH = 1_500;
const MAX_CATALOG_TOOLS = 24;

const argumentSourceSchema = z.object({
  stepId: z.string().min(1).max(100),
  resultPath: z.array(z.string().min(1).max(100)).min(1).max(12),
});

const proposedStepSchema = z.object({
  id: z.string().min(1).max(100),
  description: z.string().min(1).max(MAX_TEXT_LENGTH).default('Planned tool step.'),
  tool: z.string().min(1).max(100),
  args: z.record(z.string(), z.unknown()).default({}),
  dependsOn: z.array(z.string().min(1).max(100)).default([]),
  argumentSources: z.record(z.string(), argumentSourceSchema).default({}),
  preconditions: z.array(z.string().min(1).max(MAX_TEXT_LENGTH)).max(12).default([]),
  expectedOutcome: z.string().min(1).max(MAX_TEXT_LENGTH).default('Observe the tool result.'),
  verificationMethod: z.string().min(1).max(MAX_TEXT_LENGTH).default('Inspect the receipt.'),
  failurePolicy: z
    .string()
    .min(1)
    .max(MAX_TEXT_LENGTH)
    .default('Inspect actual state before any retry.'),
  requiresVerifiedReceipt: z.boolean().default(false),
});

const proposedPlanSchema = z.object({
  goal: z.string().min(1).max(4_000),
  steps: z.array(proposedStepSchema).min(1).max(MAX_STEPS),
  continuationRequired: z.boolean().default(false),
});

export type ProposedPlan = z.infer<typeof proposedPlanSchema>;

export interface AgentPlanDefinition {
  readonly goal: string;
  readonly steps: Omit<Step, 'state' | 'retryCount'>[];
  readonly continuationRequired: boolean;
}

export class AgentPlanningError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = 'AgentPlanningError';
  }
}

export function createPlanningPrompt(
  userRequest: string,
  tools: readonly OllamaToolDefinition[],
  previousEvidence: unknown = null,
): string {
  const catalog = selectRelevantTools(userRequest, tools).map((tool) => ({
    name: tool.function.name,
    description: tool.function.description.slice(0, 160),
    parameters: compactParameters(tool.function.parameters),
  }));

  return [
    'Create a bounded execution plan for the user request. Return ONLY one JSON object; do not call a tool in this planning response.',
    'This is a general computer-use planner. Select only tools from the supplied catalog. Do not invent a tool or a capability.',
    'Return valid JSON, never Markdown or prose. The only required fields per step are id, tool, and args. Add dependencies and result sources only when needed.',
    'Use argumentSources for values returned by previous steps: {"argumentName":{"stepId":"prior","resultPath":["field"]}}. A referenced step must be listed in dependsOn.',
    'For browser work, create and retain JARVIS-owned tabs; bind subsequent operations to returned tab IDs. For desktop work, inspect and identify a target before any action and use independent read-back. Never bypass authentication, CAPTCHA, confirmation, or permissions.',
    'Never repeat an uncertain action. On a failure, inspect state first and only retry when the evidence says delivery did not occur and retry is safe.',
    'The JSON shape is: {"goal":string,"continuationRequired":boolean,"steps":[{"id":string,"tool":string,"args":object,"dependsOn":string[],"argumentSources":object,"description":string,"expectedOutcome":string,"verificationMethod":string,"failurePolicy":string,"requiresVerifiedReceipt":boolean}]}. Set continuationRequired=true only when further planning needs the actual results of this phase; do not guess selectors, window handles, tab IDs, or authentication state.',
    `User request: ${JSON.stringify(userRequest)}`,
    `Previous execution evidence (may be null): ${JSON.stringify(previousEvidence)}`,
    `Registered tool catalog: ${JSON.stringify(catalog)}`,
  ].join('\n');
}

export function parseAgentPlan(
  content: string,
  tools: readonly OllamaToolDefinition[],
): AgentPlanDefinition {
  const parsedJson = extractJsonObject(content);
  const parsed = proposedPlanSchema.safeParse(parsedJson);
  if (!parsed.success) {
    throw new AgentPlanningError(
      `Planner returned an invalid plan: ${parsed.error.issues[0]?.message ?? 'unknown schema error'}`,
    );
  }

  const names = new Set(tools.map((tool) => tool.function.name));
  const ids = new Set<string>();
  for (const step of parsed.data.steps) {
    if (!names.has(step.tool)) {
      throw new AgentPlanningError(`Planner selected an unregistered tool: ${step.tool}`);
    }
    if (ids.has(step.id)) {
      throw new AgentPlanningError(`Planner reused step id: ${step.id}`);
    }
    ids.add(step.id);
  }

  for (const step of parsed.data.steps) {
    for (const dependency of step.dependsOn) {
      if (dependency === step.id || !ids.has(dependency)) {
        throw new AgentPlanningError(`Step ${step.id} has an invalid dependency: ${dependency}`);
      }
    }
    for (const [argument, source] of Object.entries(step.argumentSources)) {
      if (!step.dependsOn.includes(source.stepId)) {
        throw new AgentPlanningError(
          `Step ${step.id} argument ${argument} must depend on source step ${source.stepId}`,
        );
      }
    }
  }
  assertAcyclic(parsed.data.steps);

  return {
    goal: parsed.data.goal,
    continuationRequired: parsed.data.continuationRequired,
    steps: parsed.data.steps.map((step) => ({
      id: step.id,
      description: step.description,
      tool: step.tool,
      args: step.args,
      backend: inferBackendFromTool(step.tool),
      dependsOn: step.dependsOn,
      ...(Object.keys(step.argumentSources).length === 0
        ? {}
        : { argumentSources: step.argumentSources }),
      ...(step.preconditions.length === 0 ? {} : { preconditions: step.preconditions }),
      expectedOutcome: step.expectedOutcome,
      verificationMethod: step.verificationMethod,
      failurePolicy: step.failurePolicy,
      requiresVerifiedReceipt: step.requiresVerifiedReceipt,
    })),
  };
}

function compactParameters(parameters: Record<string, unknown>): Record<string, unknown> {
  const properties = parameters.properties;
  return {
    type: parameters.type,
    required: parameters.required,
    ...(typeof properties === 'object' && properties !== null && !Array.isArray(properties)
      ? {
          properties: Object.fromEntries(
            Object.entries(properties).map(([name, schema]) => [
              name,
              compactPropertySchema(schema),
            ]),
          ),
        }
      : {}),
  };
}

function compactPropertySchema(schema: unknown): unknown {
  if (typeof schema !== 'object' || schema === null || Array.isArray(schema)) return schema;
  const value = schema as Record<string, unknown>;
  return {
    ...(value.type === undefined ? {} : { type: value.type }),
    ...(value.enum === undefined ? {} : { enum: value.enum }),
    ...(value.items === undefined ? {} : { items: value.items }),
  };
}

function selectRelevantTools(
  userRequest: string,
  tools: readonly OllamaToolDefinition[],
): OllamaToolDefinition[] {
  const terms = new Set(userRequest.toLowerCase().match(/[a-z][a-z0-9_]{2,}/g) ?? []);
  return [...tools]
    .map((tool, index) => {
      const haystack = `${tool.function.name} ${tool.function.description}`.toLowerCase();
      const score = [...terms].reduce((total, term) => total + Number(haystack.includes(term)), 0);
      return { tool, index, score };
    })
    .sort((left, right) => right.score - left.score || left.index - right.index)
    .slice(0, MAX_CATALOG_TOOLS)
    .map(({ tool }) => tool);
}

function extractJsonObject(content: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(content)?.[1];
  const candidate = (fenced ?? content).trim();
  const first = candidate.indexOf('{');
  const last = candidate.lastIndexOf('}');
  if (first < 0 || last <= first) {
    throw new AgentPlanningError('Planner did not return a JSON object');
  }
  try {
    return JSON.parse(candidate.slice(first, last + 1)) as unknown;
  } catch {
    throw new AgentPlanningError('Planner returned malformed JSON');
  }
}

function assertAcyclic(steps: readonly ProposedPlan['steps'][number][]): void {
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (id: string): void => {
    if (visited.has(id)) return;
    if (visiting.has(id))
      throw new AgentPlanningError(`Planner plan contains a dependency cycle at ${id}`);
    visiting.add(id);
    const step = byId.get(id);
    for (const dependency of step?.dependsOn ?? []) visit(dependency);
    visiting.delete(id);
    visited.add(id);
  };
  for (const step of steps) visit(step.id);
}
