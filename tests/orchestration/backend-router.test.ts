import { describe, expect, it, vi, beforeEach } from 'vitest';

import { BackendRouter, inferBackendFromTool } from '../../src/orchestration/backend-router.js';
import type { ToolRegistry, Logger, ToolExecutionReceipt } from '../../src/orchestration/types.js';
import type { AgentDesktopClient } from '../../src/desktop/agent-desktop-client.js';
import type { DesktopManager } from '../../src/desktop/desktop-manager.js';

const mockLogger: Logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
};

function createMockRegistry(tools: string[]): ToolRegistry {
  return {
    execute: async (): Promise<ToolExecutionReceipt> => ({
      executionId: 'test',
      callId: 'test',
      toolName: 'test',
      status: 'success',
      approval: 'not_required',
      verification: 'not_applicable',
      result: {},
      error: null,
      durationMs: 0,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
    has: (name: string) => tools.includes(name),
    listNames: () => tools,
  };
}

function createMockAgentDesktopClient(): AgentDesktopClient {
  return {
    status: vi.fn().mockResolvedValue({
      version: '1.0.0',
      platform: 'windows',
      state_root: '',
      permissions: {},
      supported_surfaces: [],
      tracing: false,
    }),
    listWindows: vi.fn().mockResolvedValue([]),
    snapshot: vi.fn().mockResolvedValue({ snapshot_id: 'test', tree: {} }),
  } as unknown as AgentDesktopClient;
}

function createMockDesktopManager(): DesktopManager {
  return {
    listWindows: vi.fn().mockResolvedValue([]),
    getControls: vi.fn().mockResolvedValue([]),
  } as unknown as DesktopManager;
}

describe('BackendRouter', () => {
  let router: BackendRouter;
  let mockRegistry: ToolRegistry;

  beforeEach(() => {
    mockRegistry = createMockRegistry([
      'browser_navigate',
      'browser_click',
      'desktop_ax_snapshot',
      'desktop_ax_action',
      'desktop_list_windows',
      'desktop_click_control',
      'desktop_vision_locate',
    ]);
    const mockAgentDesktop = createMockAgentDesktopClient();
    const mockDesktopManager = createMockDesktopManager();
    router = new BackendRouter({
      registry: mockRegistry,
      logger: mockLogger,
      agentDesktopClient: mockAgentDesktop,
      desktopManager: mockDesktopManager,
      playwriterAvailable: () => Promise.resolve(true),
      visionAvailable: () => Promise.resolve(true),
    });
  });

  it('returns capabilities for all backends when available', async () => {
    const caps = await router.getCapabilities(true);

    expect(caps.length).toBe(4);
    const names = caps.map((c) => c.name).sort();
    expect(names).toEqual(['agent-desktop', 'playwriter', 'pywinauto', 'vision']);
  });

  it('marks unavailable backends when probe returns false', async () => {
    const router2 = new BackendRouter({
      registry: mockRegistry,
      logger: mockLogger,
      playwriterAvailable: () => Promise.resolve(false),
      visionAvailable: () => Promise.resolve(false),
    });

    const caps = await router2.getCapabilities(true);

    const playwriter = caps.find((c) => c.name === 'playwriter');
    const vision = caps.find((c) => c.name === 'vision');

    expect(playwriter?.available).toBe(false);
    expect(vision?.available).toBe(false);
  });

  it('selects backend that supports required tools', async () => {
    const selected = await router.selectBackend(['browser_navigate', 'browser_click'], 'browser');
    expect(selected?.name).toBe('playwriter');
  });

  it('selects desktop backend for desktop tools', async () => {
    const selected = await router.selectBackend(['desktop_ax_snapshot', 'desktop_ax_action'], 'desktop');
    expect(selected?.name).toBe('agent-desktop');
  });

  it('returns null when no backend supports required tools', async () => {
    const selected = await router.selectBackend(['nonexistent_tool']);
    expect(selected).toBeNull();
  });

  it('prefers lower latency backend', async () => {
    // Create a new router with mocked latencies
    const mockAgentDesktop = createMockAgentDesktopClient();
    const mockDesktopManager = createMockDesktopManager();
    
    vi.mocked(mockAgentDesktop.listWindows).mockResolvedValue([
      { id: 'w-1', app_name: 'notepad.exe', title: 'Notepad', pid: 1, accessible: true, visible: true, minimized: false, is_focused: true, bounds: { x: 0, y: 0, width: 800, height: 600 } },
    ]);
    vi.mocked(mockDesktopManager.listWindows).mockResolvedValue([
      { handle: 1, title: 'Notepad', process_id: 1, class_name: 'Notepad', backend: 'uia', rect: { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 } },
    ]);
    
    vi.mocked(mockAgentDesktop.snapshot).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 100));
      return { snapshot_id: 'test', tree: {} };
    });
    
    vi.mocked(mockDesktopManager.getControls).mockImplementation(async () => {
      await new Promise(r => setTimeout(r, 50));
      return [];
    });

    const router = new BackendRouter({
      registry: mockRegistry,
      logger: mockLogger,
      agentDesktopClient: mockAgentDesktop,
      desktopManager: mockDesktopManager,
      playwriterAvailable: () => Promise.resolve(false),
      visionAvailable: () => Promise.resolve(false),
    });

    const selected = await router.selectBackend(['desktop_list_windows'], 'desktop');
    expect(selected?.name).toBe('pywinauto');
  });

  it('routes browser_* tools to playwriter', async () => {
    const backend = await router.routeTool('browser_navigate');
    expect(backend).toBe('playwriter');
  });

  it('routes desktop_ax_* tools to agent-desktop', async () => {
    const backend = await router.routeTool('desktop_ax_snapshot');
    expect(backend).toBe('agent-desktop');
  });

  it('routes desktop_* (non-ax) tools to pywinauto', async () => {
    const backend = await router.routeTool('desktop_list_windows');
    expect(backend).toBe('pywinauto');
  });

  it('routes vision tools to vision', async () => {
    const backend = await router.routeTool('desktop_vision_locate');
    expect(backend).toBe('vision');
  });

  it('invalidates cache', async () => {
    await router.getCapabilities(true);
    router.invalidateCache();
    const caps = await router.getCapabilities(true);
    expect(caps).toBeDefined();
  });
});

describe('inferBackendFromTool', () => {
  it('maps correctly', () => {
    expect(inferBackendFromTool('browser_navigate')).toBe('playwriter');
    expect(inferBackendFromTool('desktop_ax_snapshot')).toBe('agent-desktop');
    expect(inferBackendFromTool('desktop_list_windows')).toBe('pywinauto');
    expect(inferBackendFromTool('desktop_vision_locate')).toBe('vision');
  });
});