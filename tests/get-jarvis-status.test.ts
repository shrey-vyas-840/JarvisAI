import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';
import type { ToolExecutionContext } from '../src/core/tool-registry.js';
import { Logger } from '../src/logging/logger.js';
import { createGetJarvisStatusTool } from '../src/tools/get-jarvis-status.js';

const logger = new Logger({ level: 'debug', logDir: 'unused', console: false, file: false });

function context(): ToolExecutionContext {
  return {
    executionId: 'exec-1',
    callId: 'call-1',
    logger,
    signal: new AbortController().signal,
    now: () => new Date('2026-11-07T00:00:00.000Z'),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a record');
  }

  return value as Record<string, unknown>;
}

describe('get_jarvis_status tool', () => {
  it('returns deterministic verified runtime status', () => {
    const config = loadConfig({ env: {}, loadDotEnv: false });
    const tool = createGetJarvisStatusTool(config, {
      now: () => new Date('2026-11-07T00:00:00.000Z'),
      nodeVersion: '24.18.0',
      platform: 'win32',
      arch: 'x64',
    });

    const result = record(tool.execute({}, context()));

    expect(result).toEqual({
      application: 'JARVIS',
      version: '0.1.0',
      nodeVersion: '24.18.0',
      platform: 'win32',
      architecture: 'x64',
      runtimeStatus: 'operational',
      model: 'qwen3.5:9b',
      numCtx: 4096,
      timestamp: '2026-11-07T00:00:00.000Z',
      executionId: 'exec-1',
      callId: 'call-1',
      verificationStatus: 'verified',
    });
    expect(tool.verify?.({}, result, context())).toBe(true);
  });

  it('rejects status output that does not match the configured runtime', () => {
    const config = loadConfig({ env: {}, loadDotEnv: false });
    const tool = createGetJarvisStatusTool(config);

    const valid = record(tool.execute({}, context()));
    const invalid = { ...valid, model: 'different-model' };

    expect(tool.verify?.({}, invalid, context())).toBe(false);
    expect(tool.verify?.({ unexpected: true }, valid, context())).toBe(false);
  });
});
