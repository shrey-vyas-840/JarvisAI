import type { DesktopManager } from './desktop-manager.js';
import type { AgentDesktopClient, AgentDesktopStatusData } from './agent-desktop-client.js';

export type DesktopBackendName = 'agent-desktop' | 'pywinauto';

export interface DesktopBackendProbe {
  readonly backend: DesktopBackendName;
  readonly available: boolean;
  readonly latencyMs: number | null;
  readonly treeLatencyMs: number | null;
  readonly windowCount: number | null;
  readonly focusedTitle: string | null;
  readonly error: string | null;
}

export interface DesktopBackendSelection {
  readonly selected: DesktopBackendName | null;
  readonly reason: string;
  readonly checkedAt: string;
  readonly probes: readonly DesktopBackendProbe[];
  readonly agentDesktopStatus: AgentDesktopStatusData | null;
}

export interface DesktopBackendSelectorOptions {
  readonly agentDesktop: AgentDesktopClient;
  readonly pywinauto: DesktopManager;
  readonly cacheTtlMs?: number | undefined;
  readonly now?: (() => number) | undefined;
  readonly isoNow?: (() => Date) | undefined;
  readonly probeTimeoutMs?: number | undefined;
}

export class DesktopBackendSelector {
  private readonly agentDesktop: AgentDesktopClient;
  private readonly pywinauto: DesktopManager;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;
  private readonly isoNow: () => Date;
  private readonly probeTimeoutMs: number;
  private cached: DesktopBackendSelection | null = null;
  private cachedAt = 0;

  public constructor(options: DesktopBackendSelectorOptions) {
    this.agentDesktop = options.agentDesktop;
    this.pywinauto = options.pywinauto;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.now = options.now ?? (() => performance.now());
    this.isoNow = options.isoNow ?? (() => new Date());
    this.probeTimeoutMs = options.probeTimeoutMs ?? 20_000;
  }

  public async select(
    options: { readonly force?: boolean | undefined } = {},
  ): Promise<DesktopBackendSelection> {
    const current = this.now();

    if (
      options.force !== true &&
      this.cached !== null &&
      current - this.cachedAt <= this.cacheTtlMs
    ) {
      return this.cached;
    }

    const agentProbe = await this.probeAgentDesktop();
    const [pywinautoProbe, agentDesktopStatus] = await Promise.all([
      this.probePywinauto(agentProbe.focusedTitle),
      this.readAgentDesktopStatus(),
    ]);
    const selection = chooseBackend(agentProbe, pywinautoProbe, this.isoNow(), agentDesktopStatus);

    // Cache only a fully healthy comparison. A failed accessibility probe can be
    // transient (for example, a provider startup/DACL hiccup), so the next caller
    // must be able to observe recovery without waiting for the success TTL.
    const allBackendsHealthy = selection.probes.every((probe) => probe.available);
    this.cached = allBackendsHealthy ? selection : null;
    this.cachedAt = allBackendsHealthy ? current : 0;

    return selection;
  }

  public invalidate(): void {
    this.cached = null;
    this.cachedAt = 0;
  }

  private async probeAgentDesktop(): Promise<DesktopBackendProbe> {
    const started = this.now();

    try {
      const windows = await withTimeout(
        this.agentDesktop.listWindows(undefined, { timeoutMs: this.probeTimeoutMs }),
        this.probeTimeoutMs,
        'Agent Desktop probe timed out',
      );
      const listLatencyMs = Math.round(this.now() - started);
      const focused = windows.find((window) => window.is_focused);
      let treeLatencyMs: number | null = null;
      let accessibilityError: string | null = null;

      if (focused === undefined) {
        accessibilityError =
          'No focused window was available for the accessibility snapshot probe.';
      } else {
        const treeStarted = this.now();

        try {
          await withTimeout(
            this.agentDesktop.snapshot({
              windowId: focused.id,
              interactiveOnly: true,
              compact: true,
              timeoutMs: this.probeTimeoutMs,
            }),
            this.probeTimeoutMs,
            'Agent Desktop accessibility-tree probe timed out',
          );
          treeLatencyMs = Math.round(this.now() - treeStarted);
        } catch (error) {
          treeLatencyMs = null;
          accessibilityError = `Accessibility snapshot probe failed: ${formatError(error)}`;
        }
      }

      return {
        backend: 'agent-desktop',
        available: treeLatencyMs !== null,
        latencyMs: listLatencyMs,
        treeLatencyMs,
        windowCount: windows.length,
        focusedTitle: focused?.title ?? null,
        error: accessibilityError,
      };
    } catch (error) {
      return {
        backend: 'agent-desktop',
        available: false,
        latencyMs: null,
        treeLatencyMs: null,
        windowCount: null,
        focusedTitle: null,
        error: formatError(error),
      };
    }
  }

  private async probePywinauto(focusedTitle: string | null): Promise<DesktopBackendProbe> {
    const started = this.now();

    try {
      const windows = await withTimeout(
        this.pywinauto.listWindows(),
        this.probeTimeoutMs,
        'pywinauto probe timed out',
      );
      const listLatencyMs = Math.round(this.now() - started);
      const target =
        windows.find((window) => window.title === focusedTitle) ??
        windows.find(
          (window) =>
            window.title.length > 0 &&
            window.class_name !== 'Shell_TrayWnd' &&
            window.class_name !== 'Progman',
        );
      let treeLatencyMs: number | null = null;
      let accessibilityError: string | null = null;

      if (target !== undefined) {
        const treeStarted = this.now();

        try {
          await withTimeout(
            this.pywinauto.getControls({ title: target.title, limit: 20 }),
            this.probeTimeoutMs,
            'pywinauto accessibility-tree probe timed out',
          );
          treeLatencyMs = Math.round(this.now() - treeStarted);
        } catch (error) {
          treeLatencyMs = null;
          accessibilityError = `Accessibility control probe failed: ${formatError(error)}`;
        }
      } else {
        accessibilityError =
          'No application window was available for the UI Automation control probe.';
      }

      return {
        backend: 'pywinauto',
        available: treeLatencyMs !== null,
        latencyMs: listLatencyMs,
        treeLatencyMs,
        windowCount: windows.length,
        focusedTitle: target?.title ?? null,
        error: accessibilityError,
      };
    } catch (error) {
      return {
        backend: 'pywinauto',
        available: false,
        latencyMs: null,
        treeLatencyMs: null,
        windowCount: null,
        focusedTitle: null,
        error: formatError(error),
      };
    }
  }

  private async readAgentDesktopStatus(): Promise<AgentDesktopStatusData | null> {
    try {
      return await withTimeout(
        this.agentDesktop.status(),
        this.probeTimeoutMs,
        'Agent Desktop status probe timed out',
      );
    } catch {
      return null;
    }
  }
}

function chooseBackend(
  agentProbe: DesktopBackendProbe,
  pywinautoProbe: DesktopBackendProbe,
  checkedAt: Date,
  agentDesktopStatus: AgentDesktopStatusData | null,
): DesktopBackendSelection {
  const probes = [agentProbe, pywinautoProbe];
  let selected: DesktopBackendName | null = null;
  let reason: string;

  if (agentProbe.available && pywinautoProbe.available) {
    const useTreeLatency =
      agentProbe.treeLatencyMs !== null && pywinautoProbe.treeLatencyMs !== null;
    const agentLatency =
      (useTreeLatency ? agentProbe.treeLatencyMs : agentProbe.latencyMs) ??
      Number.POSITIVE_INFINITY;
    const pywinautoLatency =
      (useTreeLatency ? pywinautoProbe.treeLatencyMs : pywinautoProbe.latencyMs) ??
      Number.POSITIVE_INFINITY;

    selected = agentLatency <= pywinautoLatency ? 'agent-desktop' : 'pywinauto';
    reason = useTreeLatency
      ? `Selected ${selected} because both backends are healthy and it had the lower measured accessibility-tree latency (${String(agentLatency)}ms vs ${String(pywinautoLatency)}ms).`
      : `Selected ${selected} because both backends are healthy and it had the lower measured list-windows latency (${String(agentLatency)}ms vs ${String(pywinautoLatency)}ms).`;
  } else if (agentProbe.available) {
    selected = 'agent-desktop';
    reason = 'Selected agent-desktop because it is healthy and pywinauto is unavailable.';
  } else if (pywinautoProbe.available) {
    selected = 'pywinauto';
    reason = 'Selected pywinauto because it is healthy and agent-desktop is unavailable.';
  } else {
    reason = 'No reliable desktop backend is currently available.';
  }

  return {
    selected,
    reason,
    checkedAt: checkedAt.toISOString(),
    probes,
    agentDesktopStatus,
  };
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;

  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(new Error(message));
        }, timeoutMs);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown backend probe error';
}
