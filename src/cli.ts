#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import {
  BrowserError,
  BrowserManager,
  discoverChromeExtensions,
  discoverChromeProfiles,
  readPngDimensions,
  RelayManager,
} from './browser/index.js';
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
import { mapImageRectToScreen, VisionAnalyzer } from './vision/index.js';

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
    extensions          List installed Chrome extension metadata
    status              Check Playwriter relay connectivity & extensions
    readiness           Verify the browser session with a harmless read
    tabs                List open tabs in the connected Chrome profile
  desktop <subcommand>  Windows desktop automation commands
    windows             List visible top-level application windows
    screen-info         Show virtual screen bounds, DPI, and scaling
    screenshot [name]   Capture the desktop into D:\\AI\\Temp
    vision "<target>"   Locate visible elements with the local vision model
  vision <subcommand>   Local vision diagnostics
    check               Verify the configured Ollama model supports images
    analyze <png> "<target>"
                        Analyze a local PNG inside the approved directories
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

  if (command === 'vision') {
    return runVisionCommand(options, io);
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
    io.stdout(`Relay Port Listening: ${status.listening ? 'YES' : 'NO'}\n`);
    if (status.version) {
      io.stdout(`Relay Version: ${status.version}\n`);
    }
    io.stdout(
      `Connected Chrome Extensions: ${status.connectedExtensions === null ? 'unknown' : String(status.connectedExtensions)}\n`,
    );
    if (status.extensionStatusError) {
      io.stdout(`Extension Status: ${status.extensionStatusError}\n`);
    }
    if (status.running && status.connectedExtensions !== null && status.connectedExtensions > 0) {
      try {
        const extensions = await relay.listConnectedExtensions();
        for (const ext of extensions) {
          io.stdout(
            `  - [${ext.id}] ${ext.browser} (email: ${ext.email ?? 'none'}, active tabs: ${String(ext.activeTabs)})\n`,
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Unknown error';
        io.stdout(`Extension Inventory: ${message}\n`);
      }
    }
    return 0;
  }

  if (subcommand === 'readiness') {
    const browser = new BrowserManager();
    try {
      const report = await browser.verifyReadiness();
      const readiness = report.readiness;
      io.stdout(
        `Browser Readiness: READY (${String(report.elapsedMs)}ms, ${String(report.attempts)} attempt(s))\n`,
      );
      io.stdout(
        `Relay: ${readiness.relayRunning ? 'RUNNING' : 'OFFLINE'} (listening: ${readiness.relayListening ? 'YES' : 'NO'}, version: ${readiness.relayVersion ?? 'unknown'})\n`,
      );
      io.stdout(
        `Connected Chrome Extensions: ${readiness.extensionCount === null ? 'unknown' : String(readiness.extensionCount)}\n`,
      );
      io.stdout(`Selected Browser: ${readiness.selectedBrowserId ?? 'none'}\n`);
      io.stdout(
        `Enabled Tabs: ${String(readiness.enabledTabs)} (responsive: ${String(readiness.responsiveTabs)})\n`,
      );
      io.stdout(`Session Ready: ${readiness.sessionReady ? 'YES' : 'NO'}\n`);
      io.stdout(`Last Successful Operation: ${readiness.lastSuccessfulOperation ?? 'none'}\n`);
      io.stdout(`Recovery Attempts: ${String(readiness.recoveryAttempts)}\n`);
      if (readiness.lastError) {
        io.stdout(`Last Error: ${readiness.lastError}\n`);
      }
      await browser.disconnect();
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      const code = error instanceof BrowserError ? error.code : 'unknown';
      io.stderr(`Browser not ready [${code}]: ${message}\n`);
      return 1;
    }
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

  if (subcommand === 'extensions') {
    const discovery = discoverChromeExtensions();
    io.stdout(`User Data Directory: ${discovery.userDataDir}\n`);
    io.stdout(`Installed Extensions (${String(discovery.extensions.length)}):\n`);
    for (const extension of discovery.extensions) {
      const tags = extension.isPlaywriter ? ' [Playwriter]' : '';
      io.stdout(
        `  * ${extension.profileDirectory}: ${extension.name} v${extension.version} [${extension.id}]${tags}\n`,
      );
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
        const stateTag = tab.responsive ? '' : ' [UNRESPONSIVE]';
        io.stdout(
          ` ${cur} [${String(tab.index)}] ${tab.title || '(no title)'} (${tab.url || 'no url'}) ${jarvisTag}${stateTag}\n`,
        );
      }
      await browser.disconnect();
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      const code = error instanceof BrowserError ? ` [${error.code}]` : '';
      io.stderr(`Failed to list tabs${code}: ${msg}\n`);
      return 1;
    }
  }

  io.stderr(
    `Unknown browser subcommand: ${subcommand}\nAvailable: profiles, extensions, status, readiness, tabs\n`,
  );
  return 1;
}

async function runDesktopCommand(options: readonly string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = options;

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

  if (subcommand === 'screen-info') {
    const desktop = new DesktopManager();
    try {
      const info = await desktop.getScreenInfo();
      io.stdout(`${JSON.stringify(info, null, 2)}\n`);
      desktop.dispose();
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      io.stderr(`Failed to read screen info: ${msg}\n`);
      desktop.dispose();
      return 1;
    }
  }

  if (subcommand === 'screenshot') {
    const desktop = new DesktopManager();
    try {
      const config = loadConfig();
      const filename = (rest.join(' ').trim() || `desktop-${String(Date.now())}.png`).replace(
        /[^a-zA-Z0-9_.-]/g,
        '_',
      );
      const result = await desktop.captureScreenshot({
        path: path.join(
          config.paths.temp,
          filename.endsWith('.png') ? filename : `${filename}.png`,
        ),
      });
      io.stdout(
        `Captured ${String(result.image_width)}x${String(result.image_height)} screenshot to ${result.saved_path ?? 'memory'}\n`,
      );
      desktop.dispose();
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      io.stderr(`Failed to capture screenshot: ${msg}\n`);
      desktop.dispose();
      return 1;
    }
  }

  if (subcommand === 'vision') {
    const target = rest.join(' ').trim();

    if (target.length === 0) {
      io.stderr('Usage: jarvis desktop vision "<element description>"\n');
      return 1;
    }

    const desktop = new DesktopManager();
    try {
      const config = loadConfig();
      const analyzer = new VisionAnalyzer({
        baseUrl: config.ollama.baseUrl,
        model: config.ollama.visionModel,
      });
      const capture = await desktop.captureScreenshot({ includeImage: true, maxDimension: 1600 });

      if (capture.image_base64 === undefined) {
        throw new Error('Desktop capture did not include image data.');
      }

      const analysis = await analyzer.analyze({
        imageBase64: capture.image_base64,
        imageWidth: capture.image_width,
        imageHeight: capture.image_height,
        target,
        contextLabel: 'Windows desktop',
      });

      io.stdout(
        `Local vision model: ${analysis.model} (${String(analysis.elapsedMs)} ms, ${String(analysis.elements.length)} elements)\n`,
      );

      for (const element of analysis.elements) {
        const rect = mapImageRectToScreen(
          {
            x: element.x,
            y: element.y,
            width: element.width,
            height: element.height,
          },
          {
            imageWidth: capture.image_width,
            imageHeight: capture.image_height,
            originalWidth: capture.original_width,
            originalHeight: capture.original_height,
            screenOriginX: capture.screen_origin_x,
            screenOriginY: capture.screen_origin_y,
          },
        );
        const confidence = element.confidence === undefined ? 'n/a' : element.confidence.toFixed(2);
        io.stdout(
          `  * "${element.label}" role=${element.role ?? 'unknown'} confidence=${confidence} center=(${String(rect.x + Math.floor(rect.width / 2))}, ${String(rect.y + Math.floor(rect.height / 2))})\n`,
        );
      }

      desktop.dispose();
      return 0;
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error';
      io.stderr(`Vision locate failed: ${msg}\n`);
      desktop.dispose();
      return 1;
    }
  }

  io.stderr(
    `Unknown desktop subcommand: ${subcommand}\nAvailable: windows, screen-info, screenshot, vision\n`,
  );
  return 1;
}

async function runVisionCommand(options: readonly string[], io: CliIo): Promise<number> {
  const [subcommand, ...rest] = options;

  try {
    const config = loadConfig();
    const analyzer = new VisionAnalyzer({
      baseUrl: config.ollama.baseUrl,
      model: config.ollama.visionModel,
    });

    if (!subcommand || subcommand === 'check') {
      const capability = await analyzer.getCapability();
      io.stdout(`Vision Model: ${capability.model}\n`);
      io.stdout(`Vision Supported: ${capability.supported ? 'YES' : 'NO'}\n`);
      io.stdout(`Capabilities: ${capability.capabilities.join(', ') || 'none reported'}\n`);
      return capability.supported ? 0 : 1;
    }

    if (subcommand === 'analyze') {
      const [fileArgument, ...targetParts] = rest;
      const target = targetParts.join(' ').trim();

      if (!fileArgument || target.length === 0) {
        io.stderr('Usage: jarvis vision analyze <png-path> "<element description>"\n');
        return 1;
      }

      const filePath = path.resolve(fileArgument);
      const allowedRoots = [config.paths.temp, config.paths.workspace, config.paths.exports];
      const isAllowed = allowedRoots.some((root) => {
        const relative = path.relative(path.resolve(root), filePath);
        return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
      });

      if (!isAllowed) {
        io.stderr('Image path must be inside JARVIS_TEMP, JARVIS_WORKSPACE, or JARVIS_EXPORTS.\n');
        return 1;
      }

      const buffer = readFileSync(filePath);
      const dimensions = readPngDimensions(buffer);
      const analysis = await analyzer.analyze({
        imageBase64: buffer.toString('base64'),
        imageWidth: dimensions.width,
        imageHeight: dimensions.height,
        target,
        contextLabel: `image ${path.basename(filePath)}`,
      });

      io.stdout(`${JSON.stringify(analysis, null, 2)}\n`);
      return 0;
    }

    io.stderr(`Unknown vision subcommand: ${subcommand}\nAvailable: check, analyze\n`);
    return 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    io.stderr(`Vision command failed: ${message}\n`);
    return 1;
  }
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
