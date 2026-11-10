import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export const PROJECT_ROOT = projectRoot;
const defaultEnvFile = resolve(projectRoot, '.env');
const defaultLogDir = resolve(projectRoot, 'logs');
const defaultWorkspace = resolve(projectRoot, '..', 'JarvisWorkspace');
const defaultExports = resolve(projectRoot, '..', 'Exports');
const defaultTemp = resolve(projectRoot, '..', 'Temp');

const pathFromEnv = z
  .string()
  .trim()
  .min(1)
  .transform((value) => resolve(projectRoot, value));

const booleanFromEnv = z
  .preprocess((value) => {
    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value !== 'string') {
      return value;
    }

    const normalized = value.trim().toLowerCase();

    if (['true', '1', 'yes', 'on'].includes(normalized)) {
      return true;
    }

    if (['false', '0', 'no', 'off'].includes(normalized)) {
      return false;
    }

    return value;
  }, z.boolean())
  .default(false);

const ollamaBaseUrlFromEnv = z
  .url()
  .refine((value) => {
    const url = new URL(value);
    return (
      url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]', '::1'].includes(url.hostname)
    );
  }, 'OLLAMA_BASE_URL must be a local HTTP endpoint')
  .default('http://127.0.0.1:11434');

const envSchema = z.object({
  JARVIS_ENV: z.enum(['development', 'test', 'production']).default('development'),
  JARVIS_LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  JARVIS_LOG_DIR: pathFromEnv.default(defaultLogDir),
  JARVIS_WORKSPACE: pathFromEnv.default(defaultWorkspace),
  JARVIS_EXPORTS: pathFromEnv.default(defaultExports),
  JARVIS_TEMP: pathFromEnv.default(defaultTemp),
  OLLAMA_BASE_URL: ollamaBaseUrlFromEnv,
  OLLAMA_MODEL: z.string().trim().min(1).default('qwen3.5:9b'),
  OLLAMA_VISION_MODEL: z.string().trim().min(1).optional(),
  OLLAMA_NUM_CTX: z.coerce.number().int().min(512).max(131072).default(4096),
  OLLAMA_THINK: booleanFromEnv,
});

export const configSchema = envSchema.transform((env) => ({
  appEnv: env.JARVIS_ENV,
  log: {
    level: env.JARVIS_LOG_LEVEL,
    dir: env.JARVIS_LOG_DIR,
  },
  ollama: {
    baseUrl: env.OLLAMA_BASE_URL,
    model: env.OLLAMA_MODEL,
    visionModel: env.OLLAMA_VISION_MODEL ?? env.OLLAMA_MODEL,
    numCtx: env.OLLAMA_NUM_CTX,
    think: env.OLLAMA_THINK,
  },
  paths: {
    workspace: env.JARVIS_WORKSPACE,
    exports: env.JARVIS_EXPORTS,
    temp: env.JARVIS_TEMP,
  },
}));

export type AppConfig = z.infer<typeof configSchema>;

export interface LoadConfigOptions {
  env?: NodeJS.ProcessEnv;
  loadDotEnv?: boolean;
  envFile?: string;
}

export function loadConfig(options: LoadConfigOptions = {}): AppConfig {
  if (options.loadDotEnv ?? true) {
    loadEnvFileIfPresent(options.envFile ?? defaultEnvFile);
  }

  return configSchema.parse(options.env ?? process.env);
}

function loadEnvFileIfPresent(filePath: string): void {
  try {
    process.loadEnvFile(filePath);
  } catch (error) {
    if (!isMissingFileError(error)) {
      throw error;
    }
  }
}

function isMissingFileError(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
