#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { loadConfig, type AppConfig } from './config.js';
import { runHealthChecks } from './health/checks.js';
import { formatHealthReport } from './health/format.js';
import { getVersionLabel } from './version.js';

export interface CliIo {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
}

export interface CliDependencies {
  loadConfig: () => AppConfig;
  runHealthChecks: typeof runHealthChecks;
}

export const HELP_TEXT = `${getVersionLabel()}

Usage:
  jarvis <command> [options]

Commands:
  version       Print the JARVIS version
  health        Run read-only environment health checks
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
