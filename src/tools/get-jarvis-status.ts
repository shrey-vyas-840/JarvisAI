import { z } from 'zod';

import type { AppConfig } from '../config.js';
import type { ToolDefinition } from '../core/tool-registry.js';
import { VERSION } from '../version.js';

export interface GetJarvisStatusOptions {
  now?: () => Date;
  nodeVersion?: string;
  platform?: NodeJS.Platform;
  arch?: string;
}

const GET_JARVIS_STATUS_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  properties: {},
  additionalProperties: false,
};

export function createGetJarvisStatusTool(
  config: AppConfig,
  options: GetJarvisStatusOptions = {},
): ToolDefinition {
  const now = options.now ?? (() => new Date());
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;

  return {
    name: 'get_jarvis_status',
    description:
      'Return verified JARVIS runtime status, including version, Node.js version, platform, configured Ollama model, context size, timestamp, and execution identifier.',
    parameters: GET_JARVIS_STATUS_PARAMETERS,
    argumentsSchema: z.object({}).strict(),
    execute: (args, context) => {
      if (!isRecord(args) || Object.keys(args).length > 0) {
        throw new Error('get_jarvis_status does not accept arguments');
      }

      return {
        application: 'JARVIS',
        version: VERSION,
        nodeVersion,
        platform,
        architecture: arch,
        runtimeStatus: 'operational',
        model: config.ollama.model,
        numCtx: config.ollama.numCtx,
        timestamp: now().toISOString(),
        executionId: context.executionId,
        callId: context.callId,
        verificationStatus: 'verified',
      };
    },
    verify: (args, output, context) => {
      if (!isRecord(args) || Object.keys(args).length > 0 || !isRecord(output)) {
        return false;
      }

      return (
        output.application === 'JARVIS' &&
        output.version === VERSION &&
        output.model === config.ollama.model &&
        output.numCtx === config.ollama.numCtx &&
        output.executionId === context.executionId &&
        output.callId === context.callId &&
        typeof output.timestamp === 'string'
      );
    },
    timeoutMs: 5_000,
    permission: 'read-only',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
