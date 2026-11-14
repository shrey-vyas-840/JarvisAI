import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';

import type { AgentDesktopClient } from './agent-desktop-client.js';
import type { DesktopBackendSelector, DesktopBackendSelection } from './backend-selector.js';
import type { DesktopManager, DesktopWindowInfo } from './desktop-manager.js';

export type DesktopAcceptanceStatus = 'passed' | 'failed' | 'uncertain' | 'not_run';

export interface DesktopAcceptanceStep {
  readonly name: string;
  readonly status: DesktopAcceptanceStatus;
  readonly evidence?: Readonly<Record<string, unknown>>;
  readonly error?: string;
}

export interface DesktopAcceptanceBackendRun {
  readonly backend: 'agent-desktop' | 'pywinauto';
  readonly status: DesktopAcceptanceStatus;
  readonly elapsedMs?: number;
  readonly steps: readonly DesktopAcceptanceStep[];
}

export interface DesktopAcceptanceReport {
  readonly status: DesktopAcceptanceStatus;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly identity: {
    readonly username: string;
    readonly domain: string | null;
    readonly sessionName: string | null;
    readonly processId: number;
    readonly interactiveSession: boolean | null;
  };
  readonly artifact: { readonly path: string | null; readonly removed: boolean };
  readonly backendSelection: DesktopBackendSelection | null;
  readonly backends: readonly DesktopAcceptanceBackendRun[];
  readonly cleanup: DesktopAcceptanceStep;
}

export interface DesktopAcceptanceRunnerOptions {
  readonly tempDirectory: string;
  readonly desktop: DesktopManager;
  readonly agentDesktop: AgentDesktopClient;
  readonly selector: DesktopBackendSelector;
  readonly now?: () => Date;
  readonly wait?: (ms: number) => Promise<void>;
}

interface DocumentTarget {
  readonly window: DesktopWindowInfo;
  readonly tabTitle: string;
  readonly controlType: 'Document' | 'Edit';
}

export class DesktopAcceptanceRunner {
  private readonly options: DesktopAcceptanceRunnerOptions;
  private readonly now: () => Date;
  private readonly wait: (ms: number) => Promise<void>;

  public constructor(options: DesktopAcceptanceRunnerOptions) {
    this.options = options;
    this.now = options.now ?? (() => new Date());
    this.wait = options.wait ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  public async run(): Promise<DesktopAcceptanceReport> {
    const startedAt = this.now().toISOString();
    const steps: DesktopAcceptanceBackendRun[] = [];
    const identity = getRuntimeIdentity();
    let selection: DesktopBackendSelection | null = null;
    let filePath: string | null = null;
    let removed = false;
    let cleanup: DesktopAcceptanceStep;

    if (
      identity.username.toLowerCase().includes('codexsandboxoffline') ||
      identity.interactiveSession === false
    ) {
      cleanup = {
        name: 'cleanup',
        status: 'not_run',
        error: 'Desktop acceptance requires a normal interactive Windows user session.',
      };
      return this.buildReport('not_run', startedAt, null, false, null, steps, cleanup, identity);
    }

    try {
      selection = await this.options.selector.select({ force: true });
      const pendingBackends = selection.probes
        .filter((probe) => probe.available)
        .sort(
          (left, right) => (left.treeLatencyMs ?? Infinity) - (right.treeLatencyMs ?? Infinity),
        );
      if (pendingBackends.length === 0) {
        for (const probe of selection.probes) {
          steps.push({
            backend: probe.backend,
            status: 'not_run',
            steps: [
              {
                name: 'backend probe',
                status: 'failed',
                evidence: {
                  error: probe.error,
                  windowCount: probe.windowCount,
                  treeLatencyMs: probe.treeLatencyMs,
                },
              },
            ],
          });
        }
        cleanup = {
          name: 'cleanup',
          status: 'not_run',
          error: 'No desktop backend passed its capability probe.',
        };
        return this.buildReport(
          'not_run',
          startedAt,
          null,
          false,
          selection,
          steps,
          cleanup,
          identity,
        );
      }

      const marker = `JARVIS-DESKTOP-ACCEPTANCE-${randomUUID()}`;
      const fileName = `jarvis-desktop-acceptance-${randomUUID()}.txt`;
      filePath = path.join(this.options.tempDirectory, fileName);
      const file = await open(filePath, 'wx');
      await file.close();
      if ((await stat(filePath)).size !== 0)
        throw new Error('New acceptance document was not empty on disk.');

      const opened = await this.options.desktop.openAcceptanceDocument({
        path: filePath,
        allowed_root: this.options.tempDirectory,
      });
      if (path.resolve(opened.path) !== path.resolve(filePath)) {
        throw new Error('Desktop sidecar did not confirm opening the exact acceptance document.');
      }
      const basename = path.basename(filePath);
      for (const probe of selection.probes.filter((candidate) => !candidate.available)) {
        steps.push({
          backend: probe.backend,
          status: 'not_run',
          steps: [
            {
              name: 'backend probe',
              status: 'failed',
              evidence: {
                error: probe.error,
                windowCount: probe.windowCount,
                treeLatencyMs: probe.treeLatencyMs,
              },
            },
          ],
        });
      }

      for (const [index, probe] of pendingBackends.entries()) {
        const backendStartedAt = performance.now();
        const backendRun =
          probe.backend === 'agent-desktop'
            ? await this.runAgentDesktop(basename, marker, filePath)
            : await this.runPywinauto(basename, marker, filePath);
        const run: DesktopAcceptanceBackendRun = {
          ...backendRun,
          elapsedMs: Math.round(performance.now() - backendStartedAt),
        };
        steps.push(run);
        if (run.status === 'uncertain') {
          for (const skipped of pendingBackends.slice(index + 1)) {
            steps.push({
              backend: skipped.backend,
              status: 'not_run',
              steps: [
                {
                  name: 'backend test',
                  status: 'not_run',
                  error: 'Stopped because the preceding backend returned an uncertain outcome.',
                },
              ],
            });
          }
          break;
        }
      }

      const verifiedClean =
        steps.some((run) => run.status === 'passed') &&
        steps.every((run) => run.status !== 'uncertain');
      if (verifiedClean) {
        try {
          const testedPwy = steps.find(
            (run) => run.backend === 'pywinauto' && run.status === 'passed',
          );
          if (testedPwy) {
            const target = await this.findPywinautoTarget(basename);
            const closed = await this.options.desktop.closeVerifiedDocument({
              handle: target.window.handle,
              expected_window_title: target.window.title,
              tab_title: target.tabTitle,
              control_type: target.controlType,
              expected_text: '',
            });
            if (closed.outcome !== 'verified') {
              throw new Error('The exact acceptance tab did not confirm closure.');
            }
          } else {
            await this.closeAgentAcceptanceTab(basename);
          }
          const artifactInfo = await lstat(filePath);
          const finalContents = await readFile(filePath, 'utf8');
          if (
            artifactInfo.isSymbolicLink() ||
            !artifactInfo.isFile() ||
            artifactInfo.size !== 0 ||
            finalContents.replace(/^\uFEFF/, '') !== '' ||
            !path.basename(filePath).startsWith('jarvis-desktop-acceptance-')
          ) {
            throw new Error(
              'Acceptance artifact identity or empty contents changed; refusing deletion.',
            );
          }
          await unlink(filePath);
          removed = true;
          cleanup = {
            name: 'cleanup',
            status: 'passed',
            evidence: { closedTab: basename, removed: true },
          };
        } catch (error) {
          cleanup = { name: 'cleanup', status: 'uncertain', error: describeError(error) };
        }
      } else {
        cleanup = {
          name: 'cleanup',
          status: 'not_run',
          error:
            'Artifact preserved because the UI and disk were not both verified in a clean state.',
        };
      }
    } catch (error) {
      cleanup = {
        name: 'cleanup',
        status: filePath === null ? 'not_run' : 'uncertain',
        error: describeError(error),
      };
    }

    const statuses = steps
      .filter((run) => run.status !== 'not_run')
      .flatMap((run) => run.steps.map((step) => step.status));
    const hasRunBackend = steps.some((run) => run.status === 'passed');
    const status: DesktopAcceptanceStatus =
      cleanup.status === 'uncertain' || statuses.includes('uncertain')
        ? 'uncertain'
        : cleanup.status === 'failed' || statuses.includes('failed')
          ? 'failed'
          : hasRunBackend &&
              steps.every((run) => run.status === 'passed' || run.status === 'not_run') &&
              cleanup.status === 'passed'
            ? 'passed'
            : 'not_run';

    return this.buildReport(
      status,
      startedAt,
      filePath,
      removed,
      selection,
      steps,
      cleanup,
      identity,
    );
  }

  private buildReport(
    status: DesktopAcceptanceStatus,
    startedAt: string,
    filePath: string | null,
    removed: boolean,
    selection: DesktopBackendSelection | null,
    steps: DesktopAcceptanceBackendRun[],
    cleanup: DesktopAcceptanceStep,
    identity: DesktopAcceptanceReport['identity'],
  ): DesktopAcceptanceReport {
    return {
      status,
      startedAt,
      completedAt: this.now().toISOString(),
      identity,
      artifact: { path: filePath, removed },
      backendSelection: selection,
      backends: steps,
      cleanup,
    };
  }

  private async runPywinauto(
    basename: string,
    marker: string,
    filePath: string,
  ): Promise<DesktopAcceptanceBackendRun> {
    const steps: DesktopAcceptanceStep[] = [];
    let mayHaveDispatched = false;
    try {
      const target = await this.findPywinautoTarget(basename);
      steps.push({
        name: 'window, tab and editor identification',
        status: 'passed',
        evidence: {
          handle: target.window.handle,
          processId: target.window.process_id,
          title: target.window.title,
          tab: target.tabTitle,
          controlType: target.controlType,
        },
      });
      const args = this.pywArgs(target);
      const before = await this.options.desktop.readDocumentText(args);
      if (before.text !== '') throw new Error('The acceptance editor was not empty before input.');
      const stableArgs = {
        ...args,
        tab_runtime_id: before.target.tab_runtime_id,
        allow_title_change: true,
      };
      steps.push({
        name: 'starting state',
        status: 'passed',
        evidence: { characterCount: before.character_count, readPattern: before.read_pattern },
      });
      mayHaveDispatched = true;
      const write = await this.options.desktop.typeText({
        ...stableArgs,
        text: marker,
        expected_text: '',
      });
      if (write.outcome !== 'verified' || write.readback !== marker) {
        steps.push({
          name: 'write',
          status: write.delivery === 'dispatched' ? 'uncertain' : 'failed',
          evidence: { delivery: write.delivery, outcome: write.outcome, error: write.error },
        });
        return { backend: 'pywinauto', status: steps.at(-1)?.status ?? 'failed', steps };
      }
      steps.push({
        name: 'write',
        status: 'passed',
        evidence: { delivery: write.delivery, target: write.target, method: write.method },
      });
      const readback = await this.options.desktop.readDocumentText(stableArgs);
      if (readback.text !== marker)
        throw new Error('Independent UI Automation read-back differed from the marker.');
      steps.push({
        name: 'independent editor read-back',
        status: 'passed',
        evidence: {
          exactMatch: true,
          characterCount: readback.character_count,
          readPattern: readback.read_pattern,
        },
      });
      const save = await this.options.desktop.saveVerifiedDocument({
        ...stableArgs,
        expected_text: marker,
      });
      const disk = await this.waitForDiskText(filePath, marker);
      if (disk !== marker) throw new Error('Disk contents did not match after save.');
      steps.push({
        name: 'save and disk verification',
        status: 'passed',
        evidence: { saveDelivery: save.outcome, diskExactMatch: true, characterCount: disk.length },
      });
      const reset = await this.options.desktop.typeText({
        ...stableArgs,
        text: '',
        expected_text: marker,
      });
      if (reset.outcome !== 'verified' || reset.readback !== '')
        throw new Error('Could not verify a clean editor state after the backend test.');
      await this.options.desktop.saveVerifiedDocument({ ...stableArgs, expected_text: '' });
      if ((await this.waitForDiskText(filePath, '')) !== '')
        throw new Error('Clean file contents did not persist to disk.');
      steps.push({
        name: 'reset and disk verification',
        status: 'passed',
        evidence: { editorEmpty: true, diskEmpty: true },
      });
      return { backend: 'pywinauto', status: 'passed', steps };
    } catch (error) {
      steps.push({ name: 'backend execution', status: 'failed', error: describeError(error) });
      return { backend: 'pywinauto', status: mayHaveDispatched ? 'uncertain' : 'failed', steps };
    }
  }

  private async runAgentDesktop(
    basename: string,
    marker: string,
    filePath: string,
  ): Promise<DesktopAcceptanceBackendRun> {
    const steps: DesktopAcceptanceStep[] = [];
    let mayHaveDispatched = false;
    try {
      const windows = await this.waitForAgentWindow(basename);
      if (windows.length !== 1)
        throw new Error(
          `Expected one Agent Desktop window for the unique test file, found ${String(windows.length)}.`,
        );
      const window = windows[0];
      if (!window) throw new Error('Agent Desktop did not return the target window.');
      const snapshot = await this.options.agentDesktop.snapshot({
        windowId: window.id,
        interactiveOnly: false,
        compact: false,
        includeBounds: true,
      });
      let resolved = await this.resolveAgentEditor(window.id, basename);
      if (resolved.tabSelectedNow) {
        steps.push({
          name: 'select exact test tab',
          status: 'passed',
          evidence: { snapshotId: resolved.tabSnapshotId, ref: resolved.tabRef },
        });
      }
      steps.push({
        name: 'window, tab and editor identification',
        status: 'passed',
        evidence: {
          windowId: window.id,
          windowTitle: window.title,
          tabRef: resolved.tabRef,
          editorRef: resolved.editorRef,
          initialSnapshotId: snapshot.snapshot_id,
          tabSnapshotId: resolved.tabSnapshotId,
          editorSnapshotId: resolved.editorSnapshotId,
          processId: window.pid,
        },
      });
      const before = await this.readAgentEditorValue(resolved.editorRef);
      if (before !== '') throw new Error('The acceptance editor was not empty before input.');
      steps.push({ name: 'starting state', status: 'passed', evidence: { characterCount: 0 } });
      mayHaveDispatched = true;
      await this.options.agentDesktop.act({
        action: 'set-value',
        ref: resolved.editorRef,
        text: marker,
      });
      resolved = await this.resolveAgentEditor(window.id, basename);
      const after = await this.readAgentEditorValue(resolved.editorRef);
      if (after !== marker) {
        steps.push({
          name: 'write',
          status: 'uncertain',
          evidence: {
            dispatched: true,
            readbackMatched: false,
            snapshotId: resolved.editorSnapshotId,
          },
        });
        return { backend: 'agent-desktop', status: 'uncertain', steps };
      }
      steps.push({
        name: 'write and independent editor read-back',
        status: 'passed',
        evidence: {
          exactMatch: true,
          characterCount: after.length,
          ref: resolved.editorRef,
          snapshotId: resolved.editorSnapshotId,
        },
      });
      await this.options.agentDesktop.press({ combo: 'ctrl+s', windowId: window.id });
      if ((await this.waitForDiskText(filePath, marker)) !== marker)
        throw new Error('Disk contents did not match after Agent Desktop save.');
      steps.push({
        name: 'save and disk verification',
        status: 'passed',
        evidence: { exactMatch: true, characterCount: marker.length },
      });
      resolved = await this.resolveAgentEditor(window.id, basename);
      await this.options.agentDesktop.act({
        action: 'set-value',
        ref: resolved.editorRef,
        text: '',
      });
      resolved = await this.resolveAgentEditor(window.id, basename);
      if ((await this.readAgentEditorValue(resolved.editorRef)) !== '')
        throw new Error('Agent Desktop could not restore the empty acceptance document.');
      await this.options.agentDesktop.press({ combo: 'ctrl+s', windowId: window.id });
      if ((await this.waitForDiskText(filePath, '')) !== '')
        throw new Error('Empty file state did not persist after Agent Desktop reset.');
      steps.push({
        name: 'reset and disk verification',
        status: 'passed',
        evidence: { editorEmpty: true, diskEmpty: true },
      });
      return { backend: 'agent-desktop', status: 'passed', steps };
    } catch (error) {
      steps.push({ name: 'backend execution', status: 'failed', error: describeError(error) });
      return {
        backend: 'agent-desktop',
        status: mayHaveDispatched ? 'uncertain' : 'failed',
        steps,
      };
    }
  }

  private async findPywinautoTarget(basename: string): Promise<DocumentTarget> {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const windows = await this.options.desktop.listWindows();
      const matches: {
        window: DesktopWindowInfo;
        tabTitle: string;
        controlType: 'Document' | 'Edit';
      }[] = [];
      for (const window of windows) {
        const appIdentity = `${window.class_name} ${window.title}`.toLowerCase();
        if (
          !appIdentity.includes('notepad') &&
          !window.title.toLowerCase().includes(basename.toLowerCase())
        ) {
          continue;
        }
        const controls = await this.options.desktop.getControls({
          handle: window.handle,
          limit: 100,
        });
        const tabs = controls.filter(
          (control) => control.control_type === 'TabItem' && control.title.includes(basename),
        );
        const editors = controls.filter(
          (control) =>
            (control.control_type === 'Document' || control.control_type === 'Edit') &&
            control.is_visible &&
            control.is_enabled,
        );
        if (tabs.length === 1 && editors.length === 1) {
          const tab = tabs[0];
          const editor = editors[0];
          if (
            tab &&
            editor &&
            (editor.control_type === 'Document' || editor.control_type === 'Edit')
          ) {
            matches.push({ window, tabTitle: tab.title, controlType: editor.control_type });
          }
        }
      }
      if (matches.length === 1) {
        const target = matches[0];
        if (target) return target;
      }
      await this.wait(250);
    }
    throw new Error(
      'Could not uniquely identify the acceptance window, tab, and editor through pywinauto.',
    );
  }

  private async waitForAgentWindow(basename: string) {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const windows = await this.options.agentDesktop.listWindows('notepad.exe');
      const matches = [];
      for (const window of windows) {
        try {
          const found = await this.options.agentDesktop.find({
            windowId: window.id,
            name: basename,
            exact: false,
            limit: 20,
          });
          if (
            found.matches.some(
              (match) => /tab/i.test(match.role) && typeof match.ref_id === 'string',
            )
          )
            matches.push(window);
        } catch {
          // Continue checking other Notepad windows; exact unique filename is the selector.
        }
      }
      if (matches.length > 0) return matches;
      await this.wait(250);
    }
    return [];
  }

  private async closeAgentAcceptanceTab(basename: string): Promise<void> {
    const windows = await this.waitForAgentWindow(basename);
    if (windows.length !== 1) {
      throw new Error(
        `Expected one acceptance window before cleanup, found ${String(windows.length)}.`,
      );
    }
    const window = windows[0];
    if (!window) throw new Error('Acceptance window disappeared before cleanup.');
    const result = await this.options.agentDesktop.find({
      windowId: window.id,
      name: basename,
      exact: false,
      limit: 20,
    });
    const tabs = result.matches.filter((match) => /tab/i.test(match.role));
    if (tabs.length !== 1)
      throw new Error('Could not uniquely resolve the acceptance tab for cleanup.');
    const ref = tabs[0]?.ref_id;
    if (typeof ref !== 'string')
      throw new Error('Acceptance tab did not include a fresh actionable reference.');
    if ((await this.options.agentDesktop.is(ref, 'selected')) !== true) {
      await this.options.agentDesktop.act({ action: 'click', ref });
      const refreshed = await this.options.agentDesktop.find({
        windowId: window.id,
        name: basename,
        exact: false,
        limit: 20,
      });
      const refreshedTabs = refreshed.matches.filter((match) => /tab/i.test(match.role));
      if (refreshedTabs.length !== 1 || typeof refreshedTabs[0]?.ref_id !== 'string') {
        throw new Error('Could not confirm the acceptance tab after selecting it for cleanup.');
      }
      if ((await this.options.agentDesktop.is(refreshedTabs[0].ref_id, 'selected')) !== true) {
        throw new Error('Acceptance tab was not selected before closing.');
      }
    }
    await this.options.agentDesktop.press({ combo: 'ctrl+w', windowId: window.id });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      await this.wait(100);
      const candidates = await this.options.agentDesktop.listWindows('notepad.exe');
      let remains = false;
      for (const candidate of candidates) {
        const fresh = await this.options.agentDesktop.find({
          windowId: candidate.id,
          name: basename,
          exact: false,
          limit: 20,
        });
        remains ||= fresh.matches.some((match) => /tab/i.test(match.role));
      }
      if (!remains) return;
    }
    throw new Error('Acceptance tab remains visible after its close request.');
  }

  private async resolveAgentEditor(
    windowId: string,
    basename: string,
  ): Promise<{
    tabRef: string;
    editorRef: string;
    tabSnapshotId: string;
    editorSnapshotId: string;
    tabSelectedNow: boolean;
  }> {
    let tabQuery = await this.options.agentDesktop.find({
      windowId,
      name: basename,
      exact: false,
      limit: 20,
    });
    let tabs = tabQuery.matches.filter(
      (match) => /tab/i.test(match.role) && typeof match.ref_id === 'string',
    );
    if (tabs.length !== 1) {
      throw new Error(`Expected one accessible acceptance tab, found ${String(tabs.length)}.`);
    }
    let tabRef = tabs[0]?.ref_id;
    if (!tabRef) throw new Error('Acceptance tab did not return an actionable ref.');
    let selected = await this.options.agentDesktop.is(tabRef, 'selected');
    let tabSelectedNow = false;
    if (selected !== true) {
      await this.options.agentDesktop.act({ action: 'click', ref: tabRef });
      tabQuery = await this.options.agentDesktop.find({
        windowId,
        name: basename,
        exact: false,
        limit: 20,
      });
      tabs = tabQuery.matches.filter(
        (match) => /tab/i.test(match.role) && typeof match.ref_id === 'string',
      );
      if (tabs.length !== 1)
        throw new Error('Could not re-identify the acceptance tab after selecting it.');
      tabRef = tabs[0]?.ref_id;
      if (!tabRef) throw new Error('Selected acceptance tab did not return a ref.');
      selected = await this.options.agentDesktop.is(tabRef, 'selected');
      if (selected !== true) throw new Error('The exact acceptance tab did not become selected.');
      tabSelectedNow = true;
    }

    let editorQuery = await this.options.agentDesktop.find({ windowId, role: 'edit', limit: 20 });
    let editors = editorQuery.matches.filter((match) => typeof match.ref_id === 'string');
    if (editors.length === 0) {
      editorQuery = await this.options.agentDesktop.find({
        windowId,
        role: 'document',
        limit: 20,
      });
      editors = editorQuery.matches.filter((match) => typeof match.ref_id === 'string');
    }
    if (editors.length !== 1) {
      throw new Error(
        `Expected one accessible editor in the selected tab, found ${String(editors.length)}.`,
      );
    }
    const editorRef = editors[0]?.ref_id;
    if (!editorRef) throw new Error('Acceptance editor did not return an actionable ref.');

    return {
      tabRef,
      editorRef,
      tabSnapshotId: tabQuery.snapshot_id,
      editorSnapshotId: editorQuery.snapshot_id,
      tabSelectedNow,
    };
  }

  private async readAgentEditorValue(ref: string): Promise<string> {
    try {
      return asText(await this.options.agentDesktop.get(ref, 'value'));
    } catch (valueError) {
      try {
        return asText(await this.options.agentDesktop.get(ref, 'text'));
      } catch (textError) {
        throw new Error(
          `Agent Desktop could not read the exact editor value or text (${describeError(valueError)}; ${describeError(textError)}).`,
          { cause: textError },
        );
      }
    }
  }

  private async waitForDiskText(filePath: string, expected: string): Promise<string> {
    const deadline = Date.now() + 5000;
    let actual = '';
    while (Date.now() < deadline) {
      actual = (await readFile(filePath, 'utf8')).replace(/^\uFEFF/, '');
      if (actual === expected) return actual;
      await this.wait(100);
    }
    return actual;
  }

  private pywArgs(target: DocumentTarget) {
    return {
      handle: target.window.handle,
      expected_window_title: target.window.title,
      tab_title: target.tabTitle,
      control_type: target.controlType,
    } as const;
  }
}

function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'object' && value !== null) {
    if ('value' in value && typeof value.value === 'string') return value.value;
    if ('text' in value && typeof value.text === 'string') return value.text;
  }
  throw new Error('Accessibility provider returned no unambiguous text value.');
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getRuntimeIdentity(): DesktopAcceptanceReport['identity'] {
  const username = process.env.USERNAME ?? process.env.USER ?? 'unknown';
  const sessionName = process.env.SESSIONNAME ?? null;
  const interactiveSession =
    sessionName === null ? null : /^(console|rdp-tcp#\d+)$/i.test(sessionName);
  return {
    username,
    domain: process.env.USERDOMAIN ?? null,
    sessionName,
    processId: process.pid,
    interactiveSession,
  };
}
