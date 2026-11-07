#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { loadConfig, type AppConfig } from './config.js';
import { AgentLoop, type AgentRunResult } from './core/agent-loop.js';
import { ToolRegistry } from './core/tool-registry.js';
import { runHealthChecks } from './health/checks.js';
import { formatHealthReport } from './health/format.js';
import { OllamaClient } from './llm/ollama-client.js';
import { Logger } from './logging/logger.js';
import { createFilesystemTools } from './tools/filesystem/index.js';
import { createGetJarvisStatusTool } from './tools/get-jarvis-status.js';
import { getVersionLabel } from './version.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export type AgentRunner = (
  config: AppConfig,
  userMessage: string,
  options: { signal: AbortSignal },
) => Promise<AgentRunResult>;

export interface CliDependencies {
  loadConfig: () => AppConfig;
  runHealthChecks: typeof runHealthChecks;
  runAgent?: AgentRunner;
}

export const HELP_TEXT = `${getVersionLabel()}

Usage:
  jarvis <command> [options]

Commands:
  version       Print the JARVIS version
  health        Run read-only environment health checks
  agent <text>  Run a local Ollama agent with registered tools
  help          Show this help

Options:
  -h, --help    Show this help
  -v, --version Print the JARVIS version
  --json        Print the health report as JSON
`;

const defaultIo: CliIo = {
  stdout: (text: string) => {
    process.stdout.write(text);
  },
  stderr: (text: string) => {
    process.stderr.write(text);
  },
};

const defaultDependencies: CliDependencies = {
  loadConfig,
  runHealthChecks,
  runAgent: runDefaultAgent,
};

export async function runCli(
  args: readonly string[],
  io: CliIo = defaultIo,
  dependencies: CliDependencies = defaultDependencies,
): Promise<number> {
  const [command, ...options] = args;

  if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
    io.stdout(HELP_TEXT);
    return 0;
  }

  if (command === 'version' || command === '--version' || command === '-v') {
    io.stdout(`${getVersionLabel()}\n`);
    return 0;
  }

  if (command === 'health') {
    return runHealthCommand(options, io, dependencies);
  }

  if (command === 'agent') {
    return runAgentCommand(options, io, dependencies);
  }

  io.stderr(`Unknown command or option: ${command}\n\n${HELP_TEXT}`);
  return 1;
}

async function runHealthCommand(
  options: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const json = options.includes('--json');
  const unknownOptions = options.filter((option) => option !== '--json');

  if (unknownOptions.length > 0) {
    io.stderr(`Unknown health option: ${unknownOptions.join(', ')}\n`);
    return 1;
  }

  try {
    const config = dependencies.loadConfig();
    const report = await dependencies.runHealthChecks(config);

    if (json) {
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
    } else {
      io.stdout(formatHealthReport(report));
    }

    return report.status === 'FAILED' ? 1 : 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    io.stderr(`Health check failed: ${message}\n`);
    return 1;
  }
}

async function runAgentCommand(
  options: readonly string[],
  io: CliIo,
  dependencies: CliDependencies,
): Promise<number> {
  const userMessage = options.join(' ').trim();

  if (userMessage.length === 0) {
    io.stderr('Agent message is required.\n\nUsage: jarvis agent "<message>"\n');
    return 1;
  }

  const controller = new AbortController();
  const onSigint = (): void => {
    controller.abort();
  };
  const runAgent = dependencies.runAgent ?? runDefaultAgent;

  process.once('SIGINT', onSigint);

  try {
    const config = dependencies.loadConfig();
    const result = await runAgent(config, userMessage, { signal: controller.signal });

    if (result.status === 'cancelled') {
      io.stderr(`Agent run cancelled: ${result.error ?? 'cancelled'}\n`);
      return 130;
    }

    if (result.status !== 'success') {
      if (result.finalResponse.length > 0) {
        io.stdout(`${result.finalResponse}\n`);
      }

      io.stderr(`Agent run failed: ${result.error ?? result.status}\n`);
      return 1;
    }

    io.stdout(`${result.finalResponse}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    io.stderr(`Agent run failed: ${message}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

export async function runDefaultAgent(
  config: AppConfig,
  userMessage: string,
  options: { signal: AbortSignal },
): Promise<AgentRunResult> {
  const logger = new Logger({
    level: config.log.level,
    logDir: config.log.dir,
    service: 'jarvis.agent',
    console: false,
    file: true,
  });
  const client = new OllamaClient({
    baseUrl: config.ollama.baseUrl,
    model: config.ollama.model,
    numCtx: config.ollama.numCtx,
  });
  const registry = new ToolRegistry();
  const tools = [createGetJarvisStatusTool(config), ...createFilesystemTools(config)];

  for (const tool of tools) {
    registry.register(tool);
    logger.info('tool.registered', {
      toolName: tool.name,
      permission: tool.permission,
      timeoutMs: tool.timeoutMs,
    });
  }

  const loop = new AgentLoop({
    client,
    registry,
    logger,
  });

  return loop.run({ userMessage, signal: options.signal });
}

const entryPoint = process.argv[1];

if (entryPoint !== undefined && import.meta.url === pathToFileURL(entryPoint).href) {
  try {
    process.exitCode = await runCli(process.argv.slice(2));
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    process.stderr.write(`Fatal error: ${message}\n`);
    process.exitCode = 1;
  }
}
