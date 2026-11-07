#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

import { BrowserManager, discoverChromeProfiles, RelayManager } from './browser/index.js';
import { loadConfig, type AppConfig } from './config.js';
import { AgentLoop, type AgentRunResult } from './core/agent-loop.js';
import { ToolRegistry } from './core/tool-registry.js';
import { DesktopManager } from './desktop/desktop-manager.js';
import { runHealthChecks } from './health/checks.js';
import { formatHealthReport } from './health/format.js';
import { OllamaClient } from './llm/ollama-client.js';
import { Logger } from './logging/logger.js';
import { CliApprovalProvider } from './security/cli-approval-provider.js';
import { createBrowserTools } from './tools/browser/index.js';
import { createDesktopTools } from './tools/desktop/index.js';
import { createExportTools } from './tools/export/index.js';
import { createFilesystemTools } from './tools/filesystem/index.js';
import { createGeoTools } from './tools/geo/index.js';
import { createGetJarvisStatusTool } from './tools/get-jarvis-status.js';
import { createResearchTools } from './tools/research/index.js';
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
  jarvis <command> [subcommand] [options]

Commands:
  version               Print the JARVIS version
  health                Run read-only environment health checks
  browser <subcommand>  Inspect browser profiles and relay status
    profiles            List discovered Chrome profiles on this PC
    status              Check Playwriter relay connectivity & extensions
    tabs                List open tabs in the connected Chrome profile
  desktop <subcommand>  Windows desktop automation commands
    windows             List visible top-level application windows
  agent <text>          Run the local AI agent with all registered tools
                        Consequential actions require interactive approval
  help                  Show this help

Options:
  -h, --help            Show this help
  -v, --version         Print the JARVIS version
  --json                Print the health report as JSON
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

  if (command === 'browser') {
    return runBrowserCommand(options, io);
  }

  if (command === 'desktop') {
    return runDesktopCommand(options, io);
  }

  if (command === 'agent') {
    return runAgentCommand(options, io, dependencies);
  }

  io.stderr(`Unknown command or option: ${command}\n\n${HELP_TEXT}`);
  return 1;
}

async function runBrowserCommand(options: readonly string[], io: CliIo): Promise<number> {
  const [subcommand] = options;

  if (!subcommand || subcommand === 'status') {
    const relay = new RelayManager();
    const status = await relay.getStatus();
    io.stdout(
      `Playwriter Relay at ${status.host}:${String(status.port)}: ${status.running ? 'RUNNING' : 'OFFLINE'}\n`,
    );
    if (status.version) {
      io.stdout(`Relay Version: ${status.version}\n`);
    }
    io.stdout(`Connected Chrome Extensions: ${String(status.connectedExtensions)}\n`);
    if (status.running) {
      const extensions = await relay.listConnectedExtensions();
      for (const ext of extensions) {
        io.stdout(
          `  - [${ext.id}] ${ext.browser} (email: ${ext.email ?? 'none'}, active tabs: ${String(ext.activeTabs)})\n`,
        );
      }
    }
    return 0;
  }

  if (subcommand === 'profiles') {
    const discovery = discoverChromeProfiles();
    io.stdout(`Chrome Executable: ${discovery.executablePath ?? 'NOT FOUND'}\n`);
    io.stdout(`User Data Directory: ${discovery.userDataDir}\n`);
    io.stdout(`Chrome Running: ${discovery.isChromeRunning ? 'YES' : 'NO'}\n`);
    io.stdout(`Discovered Profiles (${String(discovery.profiles.length)}):\n`);
    for (const p of discovery.profiles) {
      const extTag = p.hasPlaywriterExtension
        ? '[Playwriter Extension Installed]'
        : '[Extension Not Found]';
      io.stdout(`  * ${p.directory}: "${p.name}" (email: ${p.email ?? 'none'}) ${extTag}\n`);
    }
    return 0;
  }

  if (subcommand === 'tabs') {
    const browser = new BrowserManager();
    try {
      await browser.connect();
      const tabs = await browser.listTabs();
      io.stdout(`Active Chrome Tabs (${String(tabs.length)}):\n`);
      for (const tab of tabs) {
        const cur = tab.isCurrent ? '*' : ' ';
        const jarvisTag = tab.isJarvisOwned ? '[JARVIS]' : '[USER]';
        io.stdout(` ${cur} [${String(tab.index)}] ${tab.title} (${tab.url}) ${jarvisTag}\n`);
      }
      await browser.disconnect();
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      io.stderr(`Failed to list tabs: ${msg}\n`);
      return 1;
    }
  }

  io.stderr(`Unknown browser subcommand: ${subcommand}\nAvailable: profiles, status, tabs\n`);
  return 1;
}

async function runDesktopCommand(options: readonly string[], io: CliIo): Promise<number> {
  const [subcommand] = options;

  if (!subcommand || subcommand === 'windows') {
    const desktop = new DesktopManager();
    try {
      const windows = await desktop.listWindows();
      io.stdout(`Visible Desktop Windows (${String(windows.length)}):\n`);
      for (const win of windows) {
        io.stdout(
          `  * [Handle: ${String(win.handle)}, PID: ${String(win.process_id)}] "${win.title}" (${String(win.rect.width)}x${String(win.rect.height)})\n`,
        );
      }
      desktop.dispose();
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      io.stderr(`Failed to list windows: ${msg}\n`);
      desktop.dispose();
      return 1;
    }
  }

  io.stderr(`Unknown desktop subcommand: ${subcommand}\nAvailable: windows\n`);
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
  const registry = new ToolRegistry({ approvalProvider: new CliApprovalProvider() });

  const tools = [
    createGetJarvisStatusTool(config),
    ...createFilesystemTools(config),
    ...createBrowserTools({ config }),
    ...createResearchTools(),
    ...createGeoTools(),
    ...createExportTools({ config }),
    ...createDesktopTools({ config }),
  ];

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
