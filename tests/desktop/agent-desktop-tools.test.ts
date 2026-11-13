import { describe, expect, it, vi } from 'vitest';

import type {
  AgentDesktopClient,
  AgentDesktopSnapshotData,
  AgentDesktopWindow,
} from '../../src/desktop/agent-desktop-client.js';
import { AgentDesktopCommandError } from '../../src/desktop/agent-desktop-client.js';
import type { DesktopBackendSelector } from '../../src/desktop/backend-selector.js';
import type { ToolDefinition, ToolExecutionContext } from '../../src/core/tool-registry.js';
import { createAgentDesktopTools } from '../../src/tools/desktop/agent-desktop-tools.js';

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

const snapshot: AgentDesktopSnapshotData = {
  snapshot_id: 'sabc123',
  ref_count: 2,
  complete: true,
  tree: { role: 'window', name: 'Untitled - Notepad' },
};

function context(): ToolExecutionContext {
  return {
    executionId: 'exec-1',
    callId: 'call-1',
    signal: new AbortController().signal,
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    logger: {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as ToolExecutionContext;
}

function createTools(): {
  tools: ToolDefinition[];
  client: {
    listWindows: ReturnType<typeof vi.fn>;
    snapshot: ReturnType<typeof vi.fn>;
    find: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    is: ReturnType<typeof vi.fn>;
    act: ReturnType<typeof vi.fn>;
    press: ReturnType<typeof vi.fn>;
    wait: ReturnType<typeof vi.fn>;
  };
  selector: { select: ReturnType<typeof vi.fn> };
} {
  const client = {
    listWindows: vi.fn().mockResolvedValue(windows),
    snapshot: vi.fn().mockResolvedValue(snapshot),
    find: vi.fn().mockResolvedValue({ matches: [] }),
    get: vi.fn().mockResolvedValue({ value: 'hello' }),
    is: vi.fn().mockResolvedValue({ result: true }),
    act: vi.fn().mockResolvedValue({ disposition: { delivery: 'verified' } }),
    press: vi.fn().mockResolvedValue({ delivered: true }),
    wait: vi.fn().mockResolvedValue({ found: true }),
  };
  const selector = {
    select: vi.fn().mockResolvedValue({
      selected: 'agent-desktop',
      reason: 'agent-desktop is faster and healthy',
      probes: [],
      agentDesktopStatus: null,
    }),
  };

  return {
    tools: createAgentDesktopTools({
      client: client as unknown as AgentDesktopClient,
      selector: selector as unknown as DesktopBackendSelector,
    }),
    client,
    selector,
  };
}

function tool(tools: ToolDefinition[], name: string): ToolDefinition {
  const found = tools.find((candidate) => candidate.name === name);

  if (found === undefined) {
    throw new Error(`Missing tool ${name}`);
  }

  return found;
}

describe('agent-desktop tools', () => {
  it('exposes the seven accessibility tools without changing the legacy factory', () => {
    const { tools } = createTools();

    expect(tools.map((candidate) => candidate.name)).toEqual([
      'desktop_ax_status',
      'desktop_ax_list_windows',
      'desktop_ax_snapshot',
      'desktop_ax_find',
      'desktop_ax_read',
      'desktop_ax_action',
      'desktop_ax_wait',
    ]);
    expect(tools.every((candidate) => candidate.permission === 'read-only')).toBe(true);
  });

  it('probes the selector and reports the chosen backend', async () => {
    const { tools, selector } = createTools();

    const result = await tool(tools, 'desktop_ax_status').execute({}, context());

    expect(selector.select).toHaveBeenCalledWith({ force: true });
    expect(result).toMatchObject({ selected: 'agent-desktop' });
  });

  it('validates snapshot scope and applies interactive/compact defaults', async () => {
    const { tools, client } = createTools();
    const snapshotTool = tool(tools, 'desktop_ax_snapshot');

    await expect(snapshotTool.execute({}, context())).rejects.toThrow(
      /Provide app, window_id, or root/,
    );
    expect(client.snapshot).not.toHaveBeenCalled();

    const result = await snapshotTool.execute({ app: 'notepad.exe' }, context());

    expect(result).toMatchObject({
      backend: 'agent-desktop',
      snapshot: { snapshot_id: 'sabc123' },
    });
    expect(client.snapshot).toHaveBeenCalledWith(
      expect.objectContaining({
        app: 'notepad.exe',
        interactiveOnly: true,
        compact: true,
      }),
      expect.anything(),
    );
  });

  it('routes state and content reads to the correct client method', async () => {
    const { tools, client } = createTools();
    const readTool = tool(tools, 'desktop_ax_read');

    await readTool.execute({ ref: '@sabc123:e2', property: 'visible' }, context());
    expect(client.is).toHaveBeenCalledWith('@sabc123:e2', 'visible', expect.anything());

    await readTool.execute({ ref: '@sabc123:e2', property: 'text' }, context());
    expect(client.get).toHaveBeenCalledWith('@sabc123:e2', 'text', expect.anything());
  });

  it('routes press actions separately from ref actions', async () => {
    const { tools, client } = createTools();
    const actionTool = tool(tools, 'desktop_ax_action');

    await actionTool.execute({ action: 'press', key: 'ctrl+c', app: 'notepad.exe' }, context());
    expect(client.press).toHaveBeenCalledWith(
      expect.objectContaining({ combo: 'ctrl+c', app: 'notepad.exe' }),
    );

    await actionTool.execute({ action: 'click', ref: '@sabc123:e2' }, context());
    expect(client.act).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'click', ref: '@sabc123:e2' }),
    );
  });

  it('rejects invalid text actions before calling the backend', async () => {
    const { tools, client } = createTools();

    await expect(
      tool(tools, 'desktop_ax_action').execute({ action: 'type', ref: '@sabc123:e2' }, context()),
    ).rejects.toThrow(/text is required/);
    expect(client.act).not.toHaveBeenCalled();
  });

  it('propagates stale refs without retrying the action', async () => {
    const { tools, client } = createTools();
    const error = new AgentDesktopCommandError({
      code: 'STALE_REF',
      message: 'Ref is stale.',
      disposition: { delivery: 'not_delivered', retry: 'safe' },
    });
    client.act.mockRejectedValueOnce(error);

    await expect(
      tool(tools, 'desktop_ax_action').execute({ action: 'click', ref: '@sabc123:e2' }, context()),
    ).rejects.toBe(error);
    expect(client.act).toHaveBeenCalledTimes(1);
  });

  it('requires a comparison value for element value waits', async () => {
    const { tools, client } = createTools();

    await expect(
      tool(tools, 'desktop_ax_wait').execute(
        { mode: 'element', ref: '@sabc123:e2', predicate: 'value' },
        context(),
      ),
    ).rejects.toThrow(/value is required/);
    expect(client.wait).not.toHaveBeenCalled();
  });
});
