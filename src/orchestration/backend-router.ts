import type { BackendName, ToolRegistry, Logger } from './types.js';
import { DesktopBackendSelector } from '../desktop/backend-selector.js';
import type { AgentDesktopClient } from '../desktop/agent-desktop-client.js';
import type { DesktopManager } from '../desktop/desktop-manager.js';
import type { BrowserManager } from '../browser/browser-manager.js';

export interface BackendCapabilities {
  readonly name: BackendName;
  readonly available: boolean;
  readonly latencyMs: number | null;
  readonly supports: readonly string[];
  readonly scope: 'browser' | 'desktop' | 'vision' | 'hybrid';
}

export interface BackendRouterOptions {
  readonly registry: ToolRegistry;
  readonly logger: Logger;
  readonly agentDesktopClient?: AgentDesktopClient;
  readonly desktopManager?: DesktopManager;
  readonly browserManager?: BrowserManager;
  readonly playwriterAvailable?: () => Promise<boolean>;
  readonly visionAvailable?: () => Promise<boolean>;
}

export class BackendRouter {
  private readonly logger: Logger;
  private readonly agentDesktopClient: AgentDesktopClient | undefined;
  private readonly desktopManager: DesktopManager | undefined;
  private readonly browserManager: BrowserManager | undefined;
  private readonly desktopSelector?: DesktopBackendSelector;
  private readonly playwriterAvailable: () => Promise<boolean>;
  private readonly visionAvailable: () => Promise<boolean>;
  private cachedCapabilities: BackendCapabilities[] | null = null;
  private cachedAt = 0;
  private readonly cacheTtlMs = 30_000;
  private readonly negativeCacheTtlMs = 5_000;

  public constructor(options: BackendRouterOptions) {
    this.logger = options.logger;
    this.agentDesktopClient = options.agentDesktopClient ?? undefined;
    this.desktopManager = options.desktopManager ?? undefined;
    this.browserManager = options.browserManager ?? undefined;
    this.playwriterAvailable = options.playwriterAvailable ?? (() => Promise.resolve(false));
    this.visionAvailable = options.visionAvailable ?? (() => Promise.resolve(false));

    if (this.agentDesktopClient && this.desktopManager) {
      this.desktopSelector = new DesktopBackendSelector({
        agentDesktop: this.agentDesktopClient,
        pywinauto: this.desktopManager,
      });
    }
  }

  public async getCapabilities(force = false): Promise<BackendCapabilities[]> {
    const now = Date.now();
    if (!force && this.cachedCapabilities) {
      const cacheAgeMs = now - this.cachedAt;
      const hasUnavailable = this.cachedCapabilities.some((capability) => !capability.available);
      const ttlMs = hasUnavailable ? this.negativeCacheTtlMs : this.cacheTtlMs;
      if (cacheAgeMs < ttlMs) {
        if (hasUnavailable) {
          this.logger.debug('backend_router.negative_cache_hit', { cacheAgeMs });
        }
        return this.cachedCapabilities;
      }
    }

    const capabilities: BackendCapabilities[] = [];

    // Check Playwriter availability via browser manager if available
    const playwriterAvail = await this.isPlaywriterAvailable();

    capabilities.push({
      name: 'playwriter',
      available: playwriterAvail,
      latencyMs: playwriterAvail ? 0 : null,
      supports: [
        'browser_connect_profile',
        'browser_new_tab',
        'browser_navigate',
        'browser_click',
        'browser_fill_field',
        'browser_get_page_snapshot',
        'browser_get_page_url',
        'browser_get_page_title',
        'browser_get_page_text',
        'browser_list_extensions',
        'browser_vision_locate',
        'browser_wait',
      ],
      scope: 'browser',
    });

    if (this.desktopSelector) {
      const selection = await this.desktopSelector.select({ force });
      const adAvailable =
        selection.probes.find((p) => p.backend === 'agent-desktop')?.available ?? false;
      const pwAvailable =
        selection.probes.find((p) => p.backend === 'pywinauto')?.available ?? false;

      capabilities.push({
        name: 'agent-desktop',
        available: adAvailable,
        latencyMs:
          selection.probes.find((p) => p.backend === 'agent-desktop')?.treeLatencyMs ?? null,
        supports: [
          'desktop_ax_status',
          'desktop_ax_list_windows',
          'desktop_ax_snapshot',
          'desktop_ax_find',
          'desktop_ax_read',
          'desktop_ax_action',
          'desktop_ax_wait',
        ],
        scope: 'desktop',
      });

      capabilities.push({
        name: 'pywinauto',
        available: pwAvailable,
        latencyMs: selection.probes.find((p) => p.backend === 'pywinauto')?.treeLatencyMs ?? null,
        supports: [
          'desktop_list_windows',
          'desktop_get_controls',
          'desktop_click_control',
          'desktop_type_text',
          'desktop_read_document_text',
          'desktop_close_verified_document',
          'desktop_press_key',
          'desktop_wait_for_window',
          'desktop_focus_window',
        ],
        scope: 'desktop',
      });
    }

    const visionAvail = await this.visionAvailable();
    capabilities.push({
      name: 'vision',
      available: visionAvail,
      latencyMs: visionAvail ? 0 : null,
      supports: ['desktop_vision_locate', 'browser_vision_locate'],
      scope: 'vision',
    });

    const desktopProbeFailed =
      this.desktopSelector !== undefined &&
      capabilities.some((capability) => capability.scope === 'desktop' && !capability.available);
    this.cachedCapabilities = desktopProbeFailed ? null : capabilities;
    this.cachedAt = desktopProbeFailed ? 0 : now;
    return capabilities;
  }

  public async selectBackend(
    requiredTools: readonly string[],
    preferredScope?: 'browser' | 'desktop' | 'vision',
  ): Promise<BackendCapabilities | null> {
    const capabilities = await this.getCapabilities();

    const candidates = capabilities.filter((c) => {
      if (!c.available) {
        return false;
      }
      if (preferredScope && c.scope !== preferredScope && c.scope !== 'hybrid') {
        return false;
      }
      return requiredTools.every((tool) => this.backendSupportsTool(c, tool));
    });

    if (candidates.length === 0) {
      return null;
    }

    candidates.sort((a, b) => {
      const aLatency = a.latencyMs ?? Number.POSITIVE_INFINITY;
      const bLatency = b.latencyMs ?? Number.POSITIVE_INFINITY;
      return aLatency - bLatency;
    });

    return candidates[0] ?? null;
  }

  public async routeTool(toolName: string): Promise<BackendName> {
    const capabilities = await this.getCapabilities();

    for (const cap of capabilities) {
      if (cap.available && cap.supports.includes(toolName)) {
        return cap.name;
      }
    }

    if (toolName.startsWith('browser_')) {
      return 'playwriter';
    }
    if (toolName.startsWith('desktop_ax_')) {
      return 'agent-desktop';
    }
    if (
      toolName.startsWith('desktop_') &&
      !toolName.startsWith('desktop_ax_') &&
      !toolName.startsWith('desktop_vision')
    ) {
      return 'pywinauto';
    }
    if (toolName.includes('vision')) {
      return 'vision';
    }

    this.logger.warn('backend_router.no_match', {
      toolName,
      capabilities: capabilities.map((c) => c.name),
    });
    return 'local';
  }

  public invalidateCache(): void {
    this.cachedCapabilities = null;
    this.cachedAt = 0;
  }

  private async isPlaywriterAvailable(): Promise<boolean> {
    if (!this.browserManager) return this.playwriterAvailable();
    try {
      const status = await this.browserManager.getRelayProcessStatus();
      return status.listening && (status.owner === 'jarvis' || status.owner === 'external');
    } catch {
      return this.playwriterAvailable();
    }
  }

  private backendSupportsTool(capability: BackendCapabilities, toolName: string): boolean {
    if (capability.supports.includes(toolName)) return true;
    if (capability.name === 'playwriter') return toolName.startsWith('browser_');
    if (capability.name === 'agent-desktop') return toolName.startsWith('desktop_ax_');
    if (capability.name === 'pywinauto') {
      return toolName.startsWith('desktop_') && !toolName.startsWith('desktop_ax_');
    }
    return capability.name === 'vision' && toolName.includes('vision');
  }
}

export function inferBackendFromTool(toolName: string): BackendName {
  if (toolName.startsWith('browser_')) {
    return 'playwriter';
  }
  if (toolName.startsWith('desktop_ax_')) {
    return 'agent-desktop';
  }
  if (toolName.startsWith('desktop_') && !toolName.startsWith('desktop_vision')) {
    return 'pywinauto';
  }
  if (toolName.startsWith('desktop_vision') || toolName.startsWith('browser_vision')) {
    return 'vision';
  }
  return 'local';
}

export function getBackendForStep(step: { tool: string; backend?: BackendName }): BackendName {
  if (step.backend) {
    return step.backend;
  }
  return inferBackendFromTool(step.tool);
}
