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
import { DesktopAcceptanceRunner } from './desktop/acceptance-runner.js';
import { AgentDesktopClient } from './desktop/agent-desktop-client.js';
import { DesktopBackendSelector } from './desktop/backend-selector.js';
import { runHealthChecks } from './health/checks.js';
import { formatHealthReport } from './health/format.js';
import { OllamaClient } from './llm/ollama-client.js';
import { Logger } from './logging/logger.js';
import { BackendRouter } from './orchestration/backend-router.js';
import { CliApprovalProvider } from './security/cli-approval-provider.js';
import { createBrowserTools } from './tools/browser/index.js';
import { createAgentDesktopTools } from './tools/desktop/agent-desktop-tools.js';
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
  createDesktopManager?: () => DesktopManager;
}

export const HELP_TEXT = `${getVersionLabel()}

Usage:
  jarvis <command> [subcommand] [options]

Commands:
  version               Print the JARVIS version
  health                Run read-only environment health checks
  start                 Start JARVIS: check dependencies, start Playwriter relay, verify browser readiness
  status                Print comprehensive JARVIS status (Ollama, Agent Desktop, Playwriter, browser)
  stop                  Stop JARVIS-owned Playwriter relay (does not close Chrome)
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
    acceptance          Run isolated desktop interaction and verification
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

  if (command === 'start') {
    return runStartCommand(io, dependencies);
  }

  if (command === 'status') {
    return runStatusCommand(io, dependencies);
  }

  if (command === 'stop') {
    return runStopCommand(io, dependencies);
  }

  if (command === 'browser') {
    return runBrowserCommand(options, io);
  }

  if (command === 'desktop') {
    return runDesktopCommand(
      options,
      io,
      dependencies.createDesktopManager ?? (() => new DesktopManager()),
      dependencies.loadConfig,
    );
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

async function runStartCommand(io: CliIo, dependencies: CliDependencies): Promise<number> {
  const config = dependencies.loadConfig();

  io.stdout('JARVIS STARTUP\n\n');

  // 1. Check Node.js
  io.stdout(`Node.js        ${process.version}\n`);

  // 2. Check Ollama
  let ollamaReady = false;
  let ollamaModel = 'unknown';
  try {
    const response = await fetch(`${config.ollama.baseUrl}/api/tags`);
    if (response.ok) {
      const data: unknown = await response.json();
      ollamaModel = findOllamaModel(data, config.ollama.model);
      ollamaReady = true;
    }
  } catch {
    // Ollama not reachable
  }
  io.stdout(`Ollama         ${ollamaReady ? 'READY' : 'NOT READY'}\n`);
  io.stdout(`Model          ${ollamaModel}\n`);

  // 3. Check Agent Desktop
  let agentDesktopReady = false;
  try {
    const agentDesktopClient = (await import('./desktop/agent-desktop-client.js'))
      .AgentDesktopClient;
    const ad = new agentDesktopClient();
    const status = await ad.status();
    agentDesktopReady = status.permissions.accessibility?.state === 'granted';
  } catch {
    // Not ready
  }
  io.stdout(`Agent Desktop  ${agentDesktopReady ? 'READY' : 'NOT READY'}\n`);

  // 4. Start Playwriter relay
  io.stdout('Playwriter     STARTING...\n');
  const startLogger = new Logger({
    level: config.log.level,
    logDir: config.log.dir,
    service: 'jarvis.start',
    console: false,
    file: true,
  });
  const browser = new BrowserManager({ logger: startLogger });

  let relayReady = false;
  let relayStatus: { listening: boolean; pid: number | null } = { listening: false, pid: null };

  try {
    await browser.ensureRelayRunning();
    const pmStatus = await browser.getRelayProcessStatus();
    relayStatus = { listening: pmStatus.listening, pid: pmStatus.pid };
    relayReady = pmStatus.listening;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    io.stdout(`Playwriter     FAILED: ${msg}\n`);
  }

  if (relayReady) {
    io.stdout(
      `Playwriter     RUNNING (PID: ${relayStatus.pid === null ? 'unknown' : String(relayStatus.pid)})\n`,
    );
  } else {
    io.stdout('Playwriter     FAILED\n');
  }

  // 5. Check Chrome extension connection
  let extensionConnected = false;
  let enabledTabs = 0;
  let responsiveTabs = 0;

  if (relayReady) {
    try {
      await browser.connect();
      const readiness = await browser.verifyReadiness({ retries: 1 });
      const r = readiness.readiness;
      extensionConnected = r.extensionCount !== null && r.extensionCount > 0;
      enabledTabs = r.enabledTabs;
      responsiveTabs = r.responsiveTabs;
      await browser.disconnect();
    } catch {
      // Extension not connected
    }
  }

  io.stdout(`Extension      ${extensionConnected ? 'CONNECTED' : 'NOT CONNECTED'}\n`);
  io.stdout(`Enabled Tabs   ${String(enabledTabs)}\n`);
  io.stdout(`Responsive     ${String(responsiveTabs)}\n`);

  // 6. Browser readiness verification
  let browserReady = false;
  if (extensionConnected && responsiveTabs > 0) {
    try {
      const browser2 = new BrowserManager({ logger: startLogger });
      await browser2.connect();
      await browser2.verifyReadiness({ retries: 1 });
      browserReady = true;
      await browser2.disconnect();
    } catch {
      // Not ready
    }
  }
  io.stdout(`Browser        ${browserReady ? 'READY' : 'NOT READY'}\n`);

  // Summary
  io.stdout('\n');
  if (ollamaReady && agentDesktopReady && relayReady && extensionConnected && browserReady) {
    io.stdout('JARVIS IS READY.\n');
    return 0;
  } else {
    io.stdout('JARVIS NOT READY.\n');

    if (!relayReady) {
      io.stdout('\nPlaywriter relay failed to start. Check logs in logs/playwriter/');
    }
    if (relayReady && !extensionConnected) {
      io.stdout(
        '\nRELAY READY\nEXTENSION NOT CONNECTED\n\nOpen your existing Chrome profile and click the Playwriter extension\non the tab you want JARVIS to control.\n\nWaiting for connection...',
      );
      // Wait for extension connection with timeout
      const waitBrowser = new BrowserManager({ logger: startLogger });
      try {
        await waitBrowser.ensureRelayRunning();
        const startWait = Date.now();
        const timeoutMs = 60_000;
        while (Date.now() - startWait < timeoutMs) {
          try {
            await waitBrowser.connect();
            const readiness = await waitBrowser.verifyReadiness({ retries: 0 });
            if (
              readiness.readiness.extensionCount !== null &&
              readiness.readiness.extensionCount > 0
            ) {
              io.stdout('\nExtension connected! JARVIS IS READY.\n');
              await waitBrowser.disconnect();
              return 0;
            }
          } catch {
            // Still waiting
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        io.stdout('\nTimeout waiting for extension connection.\n');
        await waitBrowser.disconnect();
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown error';
        io.stdout(`\nError waiting for extension: ${msg}\n`);
      }
    } else {
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  return browserReady ? 0 : 1;
}

async function runBrowserCommand(options: readonly string[], io: CliIo): Promise<number> {
  const [subcommand] = options;
  const relay = new RelayManager();

  if (!subcommand || subcommand === 'status') {
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

async function runDesktopCommand(
  options: readonly string[],
  io: CliIo,
  createDesktopManager: () => DesktopManager,
  loadAppConfig: () => AppConfig,
): Promise<number> {
  const [subcommand, ...rest] = options;

  if (subcommand === 'acceptance') {
    const config = loadAppConfig();
    const desktop = createDesktopManager();
    const agentDesktop = new AgentDesktopClient();
    const selector = new DesktopBackendSelector({ agentDesktop, pywinauto: desktop });
    try {
      const report = await new DesktopAcceptanceRunner({
        tempDirectory: config.paths.temp,
        desktop,
        agentDesktop,
        selector,
      }).run();
      io.stdout(`${JSON.stringify(report, null, 2)}\n`);
      return report.status === 'passed' ? 0 : 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      io.stderr(`Desktop acceptance runner failed: ${message}\n`);
      return 1;
    } finally {
      desktop.dispose();
    }
  }

  if (!subcommand || subcommand === 'windows') {
    const desktop = createDesktopManager();
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
    const desktop = createDesktopManager();
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
    const desktop = createDesktopManager();
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

    const desktop = createDesktopManager();
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
    `Unknown desktop subcommand: ${subcommand}\nAvailable: windows, screen-info, screenshot, vision, acceptance\n`,
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
    if (result.plan !== undefined) {
      writePlanSummary(io, result);
    }

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
    if (
      /\b(report|return|show)\b/i.test(userMessage) &&
      /\b(actual|result|verified|returned)\b/i.test(userMessage)
    ) {
      const evidence = result.receipts.filter((receipt) => receipt.status === 'success');
      if (evidence.length > 0) {
        io.stdout(
          `\nVerified tool results:\n${JSON.stringify(
            evidence.map((receipt) => ({
              tool: receipt.toolName,
              verification: receipt.verification,
              result: receipt.result,
            })),
            null,
            2,
          )}\n`,
        );
      }
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    io.stderr(`Agent run failed: ${message}\n`);
    return 1;
  } finally {
    process.removeListener('SIGINT', onSigint);
  }
}

function writePlanSummary(io: CliIo, result: AgentRunResult): void {
  const plan = result.plan;
  if (plan === undefined) return;
  const statePath = (plan.stateHistory ?? []).map((entry) => entry.state).join(' -> ');
  io.stdout(`Plan ID: ${plan.id}\nPlan state: ${statePath}\nFinal state: ${plan.state}\n`);
  for (const step of plan.steps) {
    const receipt = step.receipt;
    io.stdout(
      `Step ${step.id}: ${step.tool} via ${step.selectedBackend ?? step.backend}; ${step.state}; receipt ${receipt?.status ?? 'none'}/${receipt?.verification ?? 'none'}\n`,
    );
    if (step.modelProposedTools !== undefined) {
      io.stdout(
        `  Model proposal: ${step.modelProposedTools.join(', ') || 'no tool call'}; expected: ${step.tool}\n`,
      );
    }
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
  const desktopManager = new DesktopManager();
  const browserManager = new BrowserManager();
  const agentDesktopClient = new AgentDesktopClient();
  const desktopSelector = new DesktopBackendSelector({
    agentDesktop: agentDesktopClient,
    pywinauto: desktopManager,
  });

  const tools = [
    createGetJarvisStatusTool(config),
    ...createFilesystemTools(config),
    ...createBrowserTools({ config, browserManager }),
    ...createResearchTools(),
    ...createGeoTools(),
    ...createExportTools({ config }),
    ...createDesktopTools({ config, desktopManager }),
    ...createAgentDesktopTools({
      client: agentDesktopClient,
      selector: desktopSelector,
      desktopManager,
    }),
  ];

  for (const tool of tools) {
    registry.register(tool);
    logger.info('tool.registered', {
      toolName: tool.name,
      permission: tool.permission,
      timeoutMs: tool.timeoutMs,
    });
  }

  const backendRouter = new BackendRouter({
    registry,
    logger,
    browserManager,
    agentDesktopClient,
    desktopManager,
  });

  const loop = new AgentLoop({
    client,
    registry,
    logger,
    backendRouter,
    planningEnabled: true,
    limits: { maxToolCalls: 48, maxToolRounds: 4 },
  });

  try {
    return await loop.run({ userMessage, signal: options.signal });
  } finally {
    await browserManager.disconnect();
    desktopManager.dispose();
  }
}

async function runStatusCommand(io: CliIo, dependencies: CliDependencies): Promise<number> {
  const config = dependencies.loadConfig();
  io.stdout('JARVIS STATUS\n\n');

  // 1. Ollama
  let ollamaReady = false;
  let ollamaModel = 'unknown';
  try {
    const response = await fetch(`${config.ollama.baseUrl}/api/tags`);
    if (response.ok) {
      const data: unknown = await response.json();
      ollamaModel = findOllamaModel(data, config.ollama.model);
      ollamaReady = true;
    }
  } catch {
    // Not ready
  }
  io.stdout(`Ollama         ${ollamaReady ? 'READY' : 'NOT READY'} (${ollamaModel})\n`);

  // 2. Agent Desktop
  let agentDesktopReady = false;
  let adVersion = 'unknown';
  try {
    const agentDesktopClient = (await import('./desktop/agent-desktop-client.js'))
      .AgentDesktopClient;
    const ad = new agentDesktopClient();
    const status = await ad.status();
    agentDesktopReady = status.permissions.accessibility?.state === 'granted';
    adVersion = status.version;
  } catch {
    // Not ready
  }
  io.stdout(`Agent Desktop  ${agentDesktopReady ? 'READY' : 'NOT READY'} (v${adVersion})\n`);

  // 3. Playwriter Relay
  let relayReady = false;
  let relayPid: number | null = null;
  let relayOwner = 'unknown';
  let extensionConnected = false;
  let extensionEmail = 'none';
  let enabledTabs = 0;
  let responsiveTabs = 0;
  let browserReady = false;

  try {
    const logger = new Logger({
      level: config.log.level,
      logDir: config.log.dir,
      service: 'jarvis.status',
      console: false,
      file: false,
    });
    const browser = new BrowserManager({ logger });
    const pmStatus = await browser.getRelayProcessStatus();
    relayPid = pmStatus.pid;
    relayOwner = pmStatus.owner;
    relayReady = pmStatus.listening;

    if (relayReady) {
      await browser.connect();
      const readiness = await browser.verifyReadiness({ retries: 1 });
      const r = readiness.readiness;
      extensionConnected = r.extensionCount !== null && r.extensionCount > 0;
      enabledTabs = r.enabledTabs;
      responsiveTabs = r.responsiveTabs;
      browserReady = r.sessionReady;
      if (r.extensionCount !== null && r.extensionCount > 0) {
        // Get extension email
        const profile = browser.getConnectedProfile();
        extensionEmail = profile?.email ?? 'connected';
      }
      await browser.disconnect();
    }
    await browser.dispose();
  } catch {
    // Relay not available
  }

  io.stdout(
    `Playwriter     ${relayReady ? 'RUNNING' : 'OFFLINE'} (PID: ${relayPid === null ? 'N/A' : String(relayPid)}, Owner: ${relayOwner})\n`,
  );
  io.stdout(
    `Extension      ${extensionConnected ? 'CONNECTED' : 'NOT CONNECTED'} (${extensionEmail})\n`,
  );
  io.stdout(`Enabled Tabs   ${String(enabledTabs)}\n`);
  io.stdout(`Responsive     ${String(responsiveTabs)}\n`);
  io.stdout(`Browser        ${browserReady ? 'READY' : 'NOT READY'}\n`);

  // Summary
  io.stdout('\n');
  if (ollamaReady && agentDesktopReady && relayReady && extensionConnected && browserReady) {
    io.stdout('JARVIS IS READY.\n');
  } else {
    io.stdout('JARVIS NOT READY.\n');
  }
  return ollamaReady && agentDesktopReady && relayReady && extensionConnected && browserReady
    ? 0
    : 1;
}

async function runStopCommand(io: CliIo, dependencies: CliDependencies): Promise<number> {
  const config = dependencies.loadConfig();
  const logger = new Logger({
    level: config.log.level,
    logDir: config.log.dir,
    service: 'jarvis.stop',
    console: true,
    file: true,
  });

  io.stdout('Stopping JARVIS-owned Playwriter relay...\n');

  try {
    const browser = new BrowserManager({ logger });
    const pmStatus = await browser.getRelayProcessStatus();

    if (!pmStatus.running || pmStatus.owner !== 'jarvis') {
      io.stdout('No JARVIS-owned relay running.\n');
      await browser.dispose();
      return 0;
    }

    io.stdout(
      `Stopping relay (PID: ${pmStatus.pid === null ? 'unknown' : String(pmStatus.pid)})...\n`,
    );
    await browser.stopRelay();
    io.stdout('Relay stopped.\n');
    await browser.dispose();
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'Unknown error';
    io.stderr(`Failed to stop relay: ${msg}\n`);
    return 1;
  }
}

function findOllamaModel(payload: unknown, configuredModel: string): string {
  if (typeof payload !== 'object' || payload === null || !('models' in payload)) {
    return configuredModel;
  }
  const models: unknown = payload.models;
  if (!Array.isArray(models)) return configuredModel;
  const match = models.find((model) => isNamedModel(model, configuredModel));
  return match?.name ?? configuredModel;
}

function isNamedModel(value: unknown, name: string): value is { name: string } {
  if (typeof value !== 'object' || value === null || !('name' in value)) return false;
  const modelName: unknown = value.name;
  return typeof modelName === 'string' && modelName === name;
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
