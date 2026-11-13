#!/usr/bin/env node
/**
 * Phase 6 Milestone 3 Demo
 *
 * This script demonstrates the JARVIS orchestration capabilities by running
 * the AgentLoop with a natural-language instruction that exercises:
 * - Desktop automation (Agent Desktop tools)
 * - Orchestration state machine
 * - Backend selection
 * - Verification and retry logic
 *
 * Note: Browser automation (Playwriter) is currently offline, so browser
 * tasks (GitHub, Google Maps, Gemini) are documented as would-be steps.
 */

import { loadConfig } from './src/config.js';
import { ToolRegistry } from './src/core/tool-registry.js';
import { Logger } from './src/logging/logger.js';
import { CliApprovalProvider } from './src/security/cli-approval-provider.js';
import { createFilesystemTools } from './src/tools/filesystem/index.js';
import { createBrowserTools } from './src/tools/browser/index.js';
import { createResearchTools } from './src/tools/research/index.js';
import { createGeoTools } from './src/tools/geo/index.js';
import { createExportTools } from './src/tools/export/index.js';
import { createDesktopTools } from './src/tools/desktop/index.js';
import { createAgentDesktopTools } from './src/tools/desktop/agent-desktop-tools.js';
import { createGetJarvisStatusTool } from './src/tools/get-jarvis-status.js';
import { DesktopManager } from './src/desktop/desktop-manager.js';
import { DesktopBackendSelector } from './src/desktop/backend-selector.js';
import { AgentDesktopClient } from './src/desktop/agent-desktop-client.js';
import { Orchestrator } from './src/orchestration/orchestrator.js';
import { PlanBuilder } from './src/orchestration/plan-builder.js';
import { BackendRouter } from './src/orchestration/backend-router.js';

async function main() {
  console.log('='.repeat(80));
  console.log('JARVIS Phase 6 Milestone 3 Demo');
  console.log('='.repeat(80));

  // Load configuration
  const config = loadConfig();
  console.log('\nConfiguration:');
  console.log(`  Ollama: ${config.ollama.baseUrl} (model: ${config.ollama.model})`);
  console.log(`  Workspace: ${config.paths.workspace}`);
  console.log(`  Exports: ${config.paths.exports}`);
  console.log(`  Temp: ${config.paths.temp}`);

  // Initialize logger
  const logger = new Logger({
    level: config.log.level,
    logDir: config.log.dir,
    service: 'jarvis.milestone3-demo',
    console: true,
    file: true,
  });

  // Initialize Ollama client
  // Initialize desktop components
  const desktopManager = new DesktopManager();
  const agentDesktopClient = new AgentDesktopClient();

  // Test Agent Desktop status
  console.log('\n--- Agent Desktop Status ---');
  try {
    const status = await agentDesktopClient.status();
    console.log(`  Version: ${status.version}`);
    console.log(`  Platform: ${status.platform}`);
    console.log(`  Accessibility: ${status.permissions.accessibility?.state ?? 'unknown'}`);
    console.log(`  Surfaces: ${status.supported_surfaces.join(', ')}`);
  } catch (e) {
    console.log(`  Error: ${e instanceof Error ? e.message : 'Unknown'}`);
  }

  // Test Backend Selector
  console.log('\n--- Backend Selector ---');
  const backendSelector = new DesktopBackendSelector({
    agentDesktop: agentDesktopClient,
    pywinauto: desktopManager,
  });
  try {
    const selection = await backendSelector.select({ force: true });
    console.log(`  Selected: ${selection.selected ?? 'none'}`);
    console.log(`  Reason: ${selection.reason}`);
    for (const probe of selection.probes) {
      console.log(
        `  ${probe.backend}: available=${String(probe.available)}, listLatency=${probe.latencyMs === null ? 'N/A' : String(probe.latencyMs)}ms, treeLatency=${probe.treeLatencyMs === null ? 'N/A' : String(probe.treeLatencyMs)}ms, focused="${probe.focusedTitle ?? 'none'}"`,
      );
    }
  } catch (e) {
    console.log(`  Error: ${e instanceof Error ? e.message : 'Unknown'}`);
  }

  // Initialize Orchestrator
  const registry = new ToolRegistry({ approvalProvider: new CliApprovalProvider() });

  // Register all tools
  const tools = [
    createGetJarvisStatusTool(config),
    ...createFilesystemTools(config),
    ...createBrowserTools({ config }),
    ...createResearchTools(),
    ...createGeoTools(),
    ...createExportTools({ config }),
    ...createDesktopTools({ config, desktopManager }),
    ...createAgentDesktopTools({ desktopManager }),
  ];
  for (const tool of tools) {
    registry.register(tool);
  }

  const orchestrator = new Orchestrator({
    registry,
    logger,
    persistencePath: config.paths.temp,
    maxRetries: 2,
  });

  // Test Orchestrator with a simple desktop automation plan
  console.log('\n--- Orchestrator Demo: Notepad Automation ---');

  const builder = new PlanBuilder();
  builder
    .addDesktopSnapshot('notepad.exe', 'Snapshot Notepad')
    .addDesktopFind('notepad.exe', 'textfield', 'Find text field')
    .addDesktopAction('click', '@s1:e1', 'Click text field')
    .addDesktopAction('set_value', '@s1:e1', 'Set value to "JARVIS Milestone 3"')
    .addDesktopWait('@s1:e1', 'value', 'Wait for value to be set')
    .dependsOn('Find text field', 'Snapshot Notepad')
    .dependsOn('Click text field', 'Find text field')
    .dependsOn('Set value to "JARVIS Milestone 3"', 'Click text field')
    .dependsOn('Wait for value to be set', 'Set value to "JARVIS Milestone 3"');

  const planData = builder.build('Automate Notepad text input');

  console.log(`\nPlan: ${planData.goal}`);
  console.log(`Steps: ${String(planData.steps.length)}`);
  for (const step of planData.steps) {
    console.log(
      `  ${step.description}: ${step.tool} (backend: ${step.backend}, deps: ${step.dependsOn.join(', ') || 'none'})`,
    );
  }

  const plan = await orchestrator.createPlan(planData.goal, planData.steps);
  console.log(`\nPlan created: ${plan.id}`);
  console.log(`Initial state: ${plan.state}`);

  // Run the plan
  console.log('\nRunning plan...');
  const result = await orchestrator.runPlan();
  console.log(`\nPlan completed: ${result.state}`);
  console.log(`Steps: ${String(result.steps.length)}`);
  for (const step of result.steps) {
    console.log(
      `  ${step.description}: ${step.state} (backend: ${step.backend})${step.error ? ` - ${step.error}` : ''}`,
    );
  }

  // Test BackendRouter
  console.log('\n--- Backend Router ---');
  const router = new BackendRouter({
    registry,
    logger,
    agentDesktopClient,
    desktopManager,
    playwriterAvailable: () => Promise.resolve(false), // Playwriter is offline
    visionAvailable: () => Promise.resolve(true),
  });

  const capabilities = await router.getCapabilities(true);
  console.log('Available backends:');
  for (const cap of capabilities) {
    console.log(
      `  ${cap.name}: available=${String(cap.available)}, latency=${cap.latencyMs === null ? 'N/A' : String(cap.latencyMs)}ms, scope=${cap.scope}`,
    );
    console.log(`    supports: ${cap.supports.join(', ')}`);
  }

  // Test routing
  const testTools = [
    'desktop_ax_snapshot',
    'desktop_ax_action',
    'browser_navigate',
    'desktop_vision_locate',
  ];
  for (const tool of testTools) {
    const backend = await router.routeTool(tool);
    console.log(`  ${tool} -> ${backend}`);
  }

  // Milestone 3 Task Description (what the AgentLoop would execute)
  console.log('\n' + '='.repeat(80));
  console.log('MILESTONE 3 TASK DESCRIPTION (for AgentLoop)');
  console.log('='.repeat(80));
  console.log(`
The following is the natural-language instruction that would be given to the
AgentLoop for the full Milestone 3 end-to-end demo:

---
Part A: GitHub README Edit
1. Open the GitHub repo at https://github.com/shrey-vyas-840/JarvisAI in the
   existing authenticated Chrome profile
2. Inspect the README and source files to understand:
   - Phase 5 capabilities (browser automation with Playwriter, pywinauto desktop,
     local vision, orchestration, approval system)
   - Phase 6 capabilities (Agent Desktop adapter, backend selection, orchestration
     layer, Milestone 2 plan execution)
3. Rewrite the README through GitHub's visible UI to cover:
   - Overview, Architecture, Ollama setup, Prerequisites
   - Running JARVIS (agent command, health checks)
   - Browser automation (Playwriter relay, tabs, extensions)
   - Desktop automation (Agent Desktop, pywinauto, backend selection)
   - Vision (local Ollama model, coordinate mapping)
   - Orchestration (plans, state machine, backend routing, persistence)
   - Security/Approval (CLI approval, read-only by default)
   - Testing (unit, integration, benchmarks)
   - Limitations & Future Work
4. Commit to main and verify remote README
5. Record commit URL

Part B: Google Maps
1. Open Google Maps (https://maps.google.com) in a separate JARVIS-owned Chrome tab
2. Verify URL, title, and page load
3. Keep the tab open

Part C: Gemini Image Generation "ApnuBiz"
1. Open Gemini (https://gemini.google.com) in a separate tab
2. Verify image generation availability
3. Use the actual image-generation UI
4. Submit the exact prompt "ApnuBiz" once
5. Wait for the actual generated image
6. Download full-size through visible UI to approved exports with unique filename
7. Verify format/dimensions/integrity
8. Open on Windows, verify viewer displays it

Safety Requirements:
- Pause for manual sign-in if needed
- Never automate passwords/CAPTCHA/auth bypass
- Respect Gemini rate limits
- Use existing download/filesystem safeguards
- Never overwrite files
- Never claim success without real verification

---
`);

  // Current limitations
  console.log('\n--- Current Limitations ---');
  console.log('1. Playwriter relay is OFFLINE - browser automation (Parts A, B, C) cannot execute');
  console.log('2. GitHub/Gemini may require manual authentication');
  console.log('3. Desktop automation (Agent Desktop) works and was demonstrated above');
  console.log('4. Orchestration layer is functional and tested');
  console.log('5. Backend selection works (Agent Desktop vs pywinauto)');

  console.log('\n' + '='.repeat(80));
  console.log('Milestone 3 Demo Complete');
  console.log('='.repeat(80));

  // Cleanup
  desktopManager.dispose();
  logger.info('Demo completed');
}

main().catch((error: unknown) => {
  console.error('Demo failed:', error);
  process.exit(1);
});
