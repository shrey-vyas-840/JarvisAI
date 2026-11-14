import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DesktopAcceptanceRunner } from '../../src/desktop/acceptance-runner.js';
import type { DesktopBackendSelection } from '../../src/desktop/backend-selector.js';
import type {
  DesktopControlInfo,
  DesktopDocumentTextResult,
  DesktopManager,
  DesktopWindowInfo,
} from '../../src/desktop/desktop-manager.js';
import type { AgentDesktopClient } from '../../src/desktop/agent-desktop-client.js';

const targetWindow: DesktopWindowInfo = {
  handle: 100,
  title: 'Notepad',
  process_id: 200,
  class_name: 'Notepad',
  backend: 'uia',
  rect: { left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600 },
};

function selection(available: 'agent-desktop' | 'pywinauto' | 'none'): DesktopBackendSelection {
  return {
    selected: available === 'none' ? null : available,
    reason: 'test selection',
    checkedAt: new Date(0).toISOString(),
    probes: [
      {
        backend: 'agent-desktop',
        available: available === 'agent-desktop',
        latencyMs: 10,
        treeLatencyMs: available === 'agent-desktop' ? 10 : null,
        windowCount: 1,
        focusedTitle: 'Notepad',
        error: available === 'agent-desktop' ? null : 'accessibility denied',
      },
      {
        backend: 'pywinauto',
        available: available === 'pywinauto',
        latencyMs: 20,
        treeLatencyMs: available === 'pywinauto' ? 20 : null,
        windowCount: 1,
        focusedTitle: 'Notepad',
        error: available === 'pywinauto' ? null : 'not available',
      },
    ],
    agentDesktopStatus: null,
  };
}

describe('DesktopAcceptanceRunner', () => {
  let tempDirectory: string;

  beforeEach(async () => {
    tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'jarvis-acceptance-'));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(tempDirectory, { recursive: true, force: true });
  });

  it('refuses to touch the desktop from the Codex sandbox identity', async () => {
    vi.stubEnv('USERNAME', 'CodexSandboxOffline');
    vi.stubEnv('SESSIONNAME', 'Console');
    const select = vi.fn();
    const openAcceptanceDocument = vi.fn();
    const runner = new DesktopAcceptanceRunner({
      tempDirectory,
      desktop: { openAcceptanceDocument } as unknown as DesktopManager,
      agentDesktop: {} as AgentDesktopClient,
      selector: { select } as never,
    });

    const report = await runner.run();

    expect(report.status).toBe('not_run');
    expect(report.identity.interactiveSession).toBe(true);
    expect(select).not.toHaveBeenCalled();
    expect(openAcceptanceDocument).not.toHaveBeenCalled();
    expect(report.artifact.path).toBeNull();
  });

  it('does not create or open an artifact when neither backend passes its probe', async () => {
    const openAcceptanceDocument = vi.fn();
    const runner = new DesktopAcceptanceRunner({
      tempDirectory,
      desktop: { openAcceptanceDocument } as unknown as DesktopManager,
      agentDesktop: {} as AgentDesktopClient,
      selector: { select: vi.fn().mockResolvedValue(selection('none')) } as never,
    });

    const report = await runner.run();

    expect(report.status).toBe('not_run');
    expect(report.artifact.path).toBeNull();
    expect(openAcceptanceDocument).not.toHaveBeenCalled();
    expect(report.backends.every((backend) => backend.status === 'not_run')).toBe(true);
  });

  it('runs a pywinauto test, verifies UI and disk contents, then removes only its artifact', async () => {
    let contents = '';
    let testPath = '';
    const tabControl: DesktopControlInfo = {
      control_type: 'TabItem',
      title: 'jarvis-desktop-acceptance-unique.txt',
      automation_id: '',
      is_enabled: true,
      is_visible: true,
      is_password: false,
      rect: { left: 0, top: 0, width: 10, height: 10 },
    };
    const editorControl: DesktopControlInfo = {
      control_type: 'Document',
      title: '',
      automation_id: 'editor',
      is_enabled: true,
      is_visible: true,
      is_password: false,
      rect: { left: 0, top: 10, width: 100, height: 100 },
    };
    const desktop: Partial<DesktopManager> = {
      openAcceptanceDocument: vi.fn().mockImplementation(({ path: filePath }: { path: string }) => {
        testPath = filePath;
        return Promise.resolve({ opened: true as const, pid: 200, path: filePath });
      }),
      listWindows: vi.fn().mockResolvedValue([targetWindow]),
      getControls: vi
        .fn()
        .mockImplementation((): Promise<DesktopControlInfo[]> =>
          Promise.resolve([{ ...tabControl, title: path.basename(testPath) }, editorControl]),
        ),
      readDocumentText: vi.fn().mockImplementation((): Promise<DesktopDocumentTextResult> =>
        Promise.resolve({
          outcome: 'verified' as const,
          backend: 'pywinauto' as const,
          target: {
            window_handle: 100,
            window_title: 'Notepad',
            tab_title: 'jarvis-desktop-acceptance-unique.txt',
            tab_runtime_id: [1, 2],
            control_type: 'Document',
            automation_id: 'editor',
            runtime_id: [3, 4],
          },
          read_pattern: 'TextPattern' as const,
          text: contents,
          character_count: contents.length,
        }),
      ),
      typeText: vi
        .fn()
        .mockImplementation(({ text }: { text: string }): Promise<DesktopDocumentTextResult> => {
          contents = text;
          return Promise.resolve({
            outcome: 'verified' as const,
            backend: 'pywinauto' as const,
            target: {
              window_handle: 100,
              window_title: 'Notepad',
              tab_title: 'jarvis-desktop-acceptance-unique.txt',
              tab_runtime_id: [1, 2],
              control_type: 'Document',
              automation_id: 'editor',
              runtime_id: [3, 4],
            },
            read_pattern: 'TextPattern' as const,
            delivery: 'dispatched' as const,
            method: 'ValuePattern.SetValue',
            readback_matches: true,
            readback: text,
          });
        }),
      saveVerifiedDocument: vi.fn().mockImplementation(() =>
        writeFile(testPath, contents, 'utf8').then(() => ({
          outcome: 'dispatched' as const,
          delivery: 'dispatched' as const,
        })),
      ),
      closeVerifiedDocument: vi.fn().mockResolvedValue({ outcome: 'verified', closed: true }),
    };
    const runner = new DesktopAcceptanceRunner({
      tempDirectory,
      desktop: desktop as DesktopManager,
      agentDesktop: {} as AgentDesktopClient,
      selector: { select: vi.fn().mockResolvedValue(selection('pywinauto')) } as never,
      wait: vi.fn().mockResolvedValue(undefined),
    });

    const report = await runner.run();

    expect(report.cleanup).toMatchObject({ status: 'passed' });
    expect(report.status).toBe('passed');
    expect(report.backends.find((run) => run.backend === 'pywinauto')?.status).toBe('passed');
    expect(report.backends.find((run) => run.backend === 'agent-desktop')?.status).toBe('not_run');
    expect(report.artifact.removed).toBe(true);
    expect(report.cleanup.status).toBe('passed');
    expect(await readFile(testPath, 'utf8').catch(() => null)).toBeNull();
  });

  it('runs the same verified flow with Agent Desktop and closes only its selected test tab', async () => {
    let contents = '';
    let testPath = '';
    let isClosed = false;
    let snapshotNumber = 0;
    const agentDesktop: Partial<AgentDesktopClient> = {
      listWindows: vi.fn().mockImplementation(() =>
        Promise.resolve(
          isClosed
            ? []
            : [
                {
                  id: 'w-test',
                  app_name: 'notepad.exe',
                  title: path.basename(testPath),
                  pid: 200,
                  accessible: true,
                  visible: true,
                  minimized: false,
                  is_focused: true,
                  bounds: { x: 0, y: 0, width: 800, height: 600 },
                },
              ],
        ),
      ),
      snapshot: vi.fn().mockImplementation(() =>
        Promise.resolve({
          snapshot_id: `s${String(++snapshotNumber)}`,
          tree: { role: 'window' },
        }),
      ),
      find: vi.fn().mockImplementation((params: { name?: string; role?: string }) => {
        const snapshot_id = `s${String(++snapshotNumber)}`;
        if (isClosed) return Promise.resolve({ snapshot_id, matches: [] });
        if (params.name !== undefined) {
          return Promise.resolve({
            snapshot_id,
            matches: [
              {
                ref_id: `@s${String(snapshotNumber)}:e1`,
                role: 'tab',
                name: path.basename(testPath),
              },
            ],
          });
        }
        return Promise.resolve({
          snapshot_id,
          matches:
            params.role === 'edit'
              ? [{ ref_id: `@s${String(snapshotNumber)}:e2`, role: 'edit' }]
              : [],
        });
      }),
      is: vi.fn().mockResolvedValue(true),
      get: vi.fn().mockImplementation(() => Promise.resolve(contents)),
      act: vi.fn().mockImplementation((params: { action: string; text?: string }) => {
        if (params.action === 'set-value') contents = params.text ?? '';
        return Promise.resolve({ applied: true });
      }),
      press: vi.fn().mockImplementation(({ combo }: { combo: string }) => {
        if (combo === 'ctrl+s')
          return writeFile(testPath, contents, 'utf8').then(() => ({ pressed: true }));
        if (combo === 'ctrl+w') isClosed = true;
        return Promise.resolve({ pressed: true });
      }),
    };
    const desktop: Partial<DesktopManager> = {
      openAcceptanceDocument: vi.fn().mockImplementation(({ path: filePath }: { path: string }) => {
        testPath = filePath;
        return Promise.resolve({ opened: true as const, pid: 200, path: filePath });
      }),
    };
    const runner = new DesktopAcceptanceRunner({
      tempDirectory,
      desktop: desktop as DesktopManager,
      agentDesktop: agentDesktop as AgentDesktopClient,
      selector: { select: vi.fn().mockResolvedValue(selection('agent-desktop')) } as never,
      wait: vi.fn().mockResolvedValue(undefined),
    });

    const report = await runner.run();

    expect(report.status).toBe('passed');
    expect(report.backends.find((run) => run.backend === 'agent-desktop')?.status).toBe('passed');
    expect(report.backends.find((run) => run.backend === 'pywinauto')?.status).toBe('not_run');
    expect(vi.mocked(agentDesktop.act)).toHaveBeenCalledTimes(2);
    expect(vi.mocked(agentDesktop.press)).toHaveBeenCalledWith({
      combo: 'ctrl+w',
      windowId: 'w-test',
    });
    expect(report.cleanup.status).toBe('passed');
    expect(report.artifact.removed).toBe(true);
    await expect(readFile(testPath, 'utf8')).rejects.toThrow();
  });

  it('stops after uncertain input and preserves the artifact for diagnosis', async () => {
    let testPath = '';
    const typeText = vi.fn().mockResolvedValue({
      outcome: 'uncertain',
      backend: 'pywinauto',
      delivery: 'dispatched',
      readback_matches: false,
      readback: null,
      target: {
        window_handle: 100,
        window_title: 'Notepad',
        tab_title: 'jarvis-desktop-acceptance-unique.txt',
        tab_runtime_id: [1, 2],
        control_type: 'Document',
        automation_id: 'editor',
        runtime_id: [3, 4],
      },
      read_pattern: 'TextPattern',
    });
    const desktop: Partial<DesktopManager> = {
      openAcceptanceDocument: vi.fn().mockImplementation(({ path: filePath }: { path: string }) => {
        testPath = filePath;
        return Promise.resolve({ opened: true as const, pid: 200, path: filePath });
      }),
      listWindows: vi.fn().mockResolvedValue([targetWindow]),
      getControls: vi.fn().mockImplementation((): Promise<DesktopControlInfo[]> =>
        Promise.resolve([
          {
            control_type: 'TabItem',
            title: path.basename(testPath),
            automation_id: '',
            is_visible: true,
            is_enabled: true,
            is_password: false,
            rect: { left: 0, top: 0, width: 0, height: 0 },
          },
          {
            control_type: 'Document',
            title: '',
            automation_id: '',
            is_visible: true,
            is_enabled: true,
            is_password: false,
            rect: { left: 0, top: 0, width: 0, height: 0 },
          },
        ]),
      ),
      readDocumentText: vi.fn().mockResolvedValue({
        outcome: 'verified',
        backend: 'pywinauto',
        target: {
          window_handle: 100,
          window_title: 'Notepad',
          tab_title: 'jarvis-desktop-acceptance-test.txt',
          tab_runtime_id: [1, 2],
          control_type: 'Document',
          automation_id: '',
          runtime_id: [3],
        },
        read_pattern: 'TextPattern',
        text: '',
        character_count: 0,
      }),
      typeText,
    };
    const runner = new DesktopAcceptanceRunner({
      tempDirectory,
      desktop: desktop as DesktopManager,
      agentDesktop: {} as AgentDesktopClient,
      selector: { select: vi.fn().mockResolvedValue(selection('pywinauto')) } as never,
      wait: vi.fn().mockResolvedValue(undefined),
    });

    const report = await runner.run();

    expect(report.status).toBe('uncertain');
    expect(typeText).toHaveBeenCalledTimes(1);
    expect(report.cleanup.status).toBe('not_run');
    expect(report.artifact.removed).toBe(false);
  });
});
