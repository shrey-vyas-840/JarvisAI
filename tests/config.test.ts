import { randomUUID } from 'node:crypto';
import { rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const ENV_KEYS = [
  'JARVIS_ENV',
  'JARVIS_LOG_LEVEL',
  'JARVIS_LOG_DIR',
  'JARVIS_WORKSPACE',
  'JARVIS_EXPORTS',
  'JARVIS_TEMP',
  'OLLAMA_BASE_URL',
  'OLLAMA_MODEL',
  'OLLAMA_NUM_CTX',
  'OLLAMA_THINK',
] as const;

describe('configuration', () => {
  it('uses safe local defaults', () => {
    const config = loadConfig({ env: {}, loadDotEnv: false });

    expect(config.appEnv).toBe('development');
    expect(config.log.level).toBe('info');
    expect(config.log.dir.endsWith('logs')).toBe(true);
    expect(config.paths.workspace.endsWith('JarvisWorkspace')).toBe(true);
    expect(config.paths.exports.endsWith('Exports')).toBe(true);
    expect(config.paths.temp.endsWith('Temp')).toBe(true);
    expect(config.ollama.baseUrl).toBe('http://127.0.0.1:11434');
    expect(config.ollama.model).toBe('qwen3.5:9b');
    expect(config.ollama.numCtx).toBe(4096);
    expect(config.ollama.think).toBe(false);
  });

  it('applies environment overrides', () => {
    const config = loadConfig({
      env: {
        JARVIS_ENV: 'production',
        JARVIS_LOG_LEVEL: 'debug',
        JARVIS_LOG_DIR: 'custom-logs',
        JARVIS_WORKSPACE: 'D:\\Work\\Jarvis',
        JARVIS_EXPORTS: 'D:\\Work\\Exports',
        JARVIS_TEMP: 'D:\\Work\\Temp',
        OLLAMA_BASE_URL: 'http://localhost:11434',
        OLLAMA_MODEL: 'test-model',
        OLLAMA_NUM_CTX: '8192',
        OLLAMA_THINK: 'true',
      },
      loadDotEnv: false,
    });

    expect(config.appEnv).toBe('production');
    expect(config.log.level).toBe('debug');
    expect(config.log.dir.endsWith('custom-logs')).toBe(true);
    expect(config.paths.workspace).toBe('D:\\Work\\Jarvis');
    expect(config.paths.exports).toBe('D:\\Work\\Exports');
    expect(config.paths.temp).toBe('D:\\Work\\Temp');
    expect(config.ollama.baseUrl).toBe('http://localhost:11434');
    expect(config.ollama.model).toBe('test-model');
    expect(config.ollama.numCtx).toBe(8192);
    expect(config.ollama.think).toBe(true);
  });

  it('accepts common false boolean values', () => {
    for (const value of ['false', '0', 'no', 'off']) {
      const config = loadConfig({ env: { OLLAMA_THINK: value }, loadDotEnv: false });
      expect(config.ollama.think).toBe(false);
    }
  });

  it('rejects invalid values and non-local Ollama URLs', () => {
    expect(() => loadConfig({ env: { JARVIS_ENV: 'staging' }, loadDotEnv: false })).toThrow();
    expect(() => loadConfig({ env: { JARVIS_LOG_LEVEL: 'verbose' }, loadDotEnv: false })).toThrow();
    expect(() =>
      loadConfig({ env: { OLLAMA_BASE_URL: 'http://192.168.1.10:11434' }, loadDotEnv: false }),
    ).toThrow();
    expect(() => loadConfig({ env: { OLLAMA_NUM_CTX: '128' }, loadDotEnv: false })).toThrow();
    expect(() => loadConfig({ env: { OLLAMA_THINK: 'maybe' }, loadDotEnv: false })).toThrow();
  });

  it('ignores a missing .env file', () => {
    const missingEnvFile = join(tmpdir(), `jarvis-missing-${randomUUID()}.env`);

    expect(() => loadConfig({ env: {}, loadDotEnv: true, envFile: missingEnvFile })).not.toThrow();
  });

  it('loads supported values from an env file', () => {
    const envFile = join(tmpdir(), `jarvis-${randomUUID()}.env`);
    const original = new Map<string, string | undefined>();

    for (const key of ENV_KEYS) {
      original.set(key, process.env[key]);
      Reflect.deleteProperty(process.env, key);
    }

    try {
      writeFileSync(envFile, 'OLLAMA_MODEL=from-dotenv\nOLLAMA_THINK=true\n', 'utf8');

      const config = loadConfig({ loadDotEnv: true, envFile });

      expect(config.ollama.model).toBe('from-dotenv');
      expect(config.ollama.think).toBe(true);
    } finally {
      for (const key of ENV_KEYS) {
        const value = original.get(key);

        if (value === undefined) {
          Reflect.deleteProperty(process.env, key);
        } else {
          process.env[key] = value;
        }
      }

      rmSync(envFile, { force: true });
    }
  });
});
