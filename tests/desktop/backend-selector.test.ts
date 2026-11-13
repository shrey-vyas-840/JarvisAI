import { describe, expect, it, vi } from 'vitest';

import type {
  AgentDesktopClient,
  AgentDesktopStatusData,
  AgentDesktopWindow,
} from '../../src/desktop/agent-desktop-client.js';
import { DesktopBackendSelector } from '../../src/desktop/backend-selector.js';
import type { DesktopManager } from '../../src/desktop/desktop-manager.js';

const status: AgentDesktopStatusData = {
  version: '1.3.0',
  platform: 'windows',
  state_root: 'C:\\Users\\test\\.agent-desktop',
  permissions: {
    accessibility: { state: 'granted' },
  },
  supported_surfaces: ['window'],
  tracing: false,
};

const windows: AgentDesktopWindow[] = [
  {
    id: 'w-1',
    app_name: 'notepad.exe',
    title: 'Untitled - Notepad',
    pid: 1,
    accessible: true,
    visible: true,
    minimized: false,
    is_focused: true,
    bounds: { x: 0, y: 0, width: 800, height: 600 },
  },
];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function createSelector(options: {
  agentWindows?: () => Promise<AgentDesktopWindow[]>;
  agentSnapshot?: () => Promise<unknown>;
  pywinautoWindows?: () => Promise<unknown[]>;
  pywinautoControls?: () => Promise<unknown[]>;
}): {
  selector: DesktopBackendSelector;
  agentStatus: ReturnType<typeof vi.fn>;
  agentListWindows: ReturnType<typeof vi.fn>;
  agentSnapshot: ReturnType<typeof vi.fn>;
  pywinautoListWindows: ReturnType<typeof vi.fn>;
  pywinautoGetControls: ReturnType<typeof vi.fn>;
} {
  const agentStatus = vi.fn().mockResolvedValue(status);
  const agentListWindows = vi.fn(options.agentWindows ?? (() => Promise.resolve(windows)));
  const agentSnapshot = vi.fn(
    options.agentSnapshot ??
      (() =>
        Promise.resolve({
          snapshot_id: 's-test',
          tree: { role: 'window' },
        })),
  );
  const pywinautoListWindows = vi.fn(options.pywinautoWindows ?? (() => Promise.resolve(windows)));
  const pywinautoGetControls = vi.fn(
    options.pywinautoControls ?? (() => Promise.resolve([{ control_type: 'Edit' }])),
  );
  const agentDesktop = {
    status: agentStatus,
    listWindows: agentListWindows,
    snapshot: agentSnapshot,
  } as unknown as AgentDesktopClient;
  const pywinauto = {
    listWindows: pywinautoListWindows,
    getControls: pywinautoGetControls,
  } as unknown as DesktopManager;

  return {
    selector: new DesktopBackendSelector({ agentDesktop, pywinauto }),
    agentStatus,
    agentListWindows,
    agentSnapshot,
    pywinautoListWindows,
    pywinautoGetControls,
  };
}

describe('DesktopBackendSelector', () => {
  it('selects the faster healthy backend', async () => {
    const { selector } = createSelector({
      agentWindows: () => Promise.resolve(windows),
      agentSnapshot: async () => {
        await delay(5);
        return { snapshot_id: 's-test', tree: { role: 'window' } };
      },
      pywinautoWindows: () => Promise.resolve(windows),
      pywinautoControls: async () => {
        await delay(35);
        return [{ control_type: 'Edit' }];
      },
    });

    const result = await selector.select({ force: true });

    expect(result.selected).toBe('agent-desktop');
    expect(result.probes).toHaveLength(2);
    expect(result.probes.every((probe) => probe.available)).toBe(true);
  });

  it('falls back to pywinauto when agent-desktop is unavailable', async () => {
    const { selector } = createSelector({
      agentWindows: () => Promise.reject(new Error('agent unavailable')),
    });

    const result = await selector.select({ force: true });

    expect(result.selected).toBe('pywinauto');
    expect(result.probes[0]).toMatchObject({
      backend: 'agent-desktop',
      available: false,
      error: 'agent unavailable',
    });
  });

  it('reports no reliable backend when both probes fail', async () => {
    const { selector } = createSelector({
      agentWindows: () => Promise.reject(new Error('agent unavailable')),
      pywinautoWindows: () => Promise.reject(new Error('pywinauto unavailable')),
    });

    const result = await selector.select({ force: true });

    expect(result.selected).toBeNull();
    expect(result.reason).toContain('No reliable desktop backend');
    expect(result.agentDesktopStatus).toMatchObject({ platform: 'windows' });
  });

  it('caches a successful selection until forced or expired', async () => {
    const { selector, agentListWindows, pywinautoListWindows } = createSelector({});

    const first = await selector.select();
    const second = await selector.select();

    expect(second).toBe(first);
    expect(agentListWindows).toHaveBeenCalledTimes(1);
    expect(pywinautoListWindows).toHaveBeenCalledTimes(1);

    await selector.select({ force: true });

    expect(agentListWindows).toHaveBeenCalledTimes(2);
    expect(pywinautoListWindows).toHaveBeenCalledTimes(2);
  });
});
