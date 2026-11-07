import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { PROJECT_ROOT } from '../config.js';

export interface DesktopWindowInfo {
  readonly handle: number;
  readonly title: string;
  readonly process_id: number;
  readonly class_name: string;
  readonly backend: string;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly right: number;
    readonly bottom: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface DesktopControlInfo {
  readonly control_type: string;
  readonly title: string;
  readonly automation_id: string;
  readonly is_enabled: boolean;
  readonly is_visible: boolean;
  readonly is_password: boolean;
  readonly rect: {
    readonly left: number;
    readonly top: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface DesktopManagerOptions {
  readonly pythonPath?: string | undefined;
  readonly sidecarScriptPath?: string | undefined;
  readonly defaultTimeoutMs?: number | undefined;
}

interface PendingRequest {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: unknown) => void;
  readonly timer: NodeJS.Timeout;
}

export class DesktopManager {
  private readonly pythonPath: string;
  private readonly sidecarScriptPath: string;
  private readonly defaultTimeoutMs: number;
  private sidecarProcess: ChildProcess | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private reqCounter = 0;

  public constructor(options: DesktopManagerOptions = {}) {
    const defaultVenvPython = path.join(
      PROJECT_ROOT,
      'tools',
      'desktop',
      '.venv',
      'Scripts',
      'python.exe',
    );
    this.pythonPath =
      options.pythonPath ?? (existsSync(defaultVenvPython) ? defaultVenvPython : 'python');
    this.sidecarScriptPath =
      options.sidecarScriptPath ?? path.join(PROJECT_ROOT, 'tools', 'desktop', 'sidecar.py');
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15000;
  }

  public async executeAction<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.ensureSidecarRunning();
    const reqId = `req-${String(++this.reqCounter)}-${String(Date.now())}`;

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(reqId);
        reject(
          new Error(
            `Desktop action "${action}" timed out after ${String(this.defaultTimeoutMs)}ms.`,
          ),
        );
      }, this.defaultTimeoutMs);

      this.pendingRequests.set(reqId, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
      });

      const payload = JSON.stringify({ id: reqId, action, params }) + '\n';
      try {
        this.sidecarProcess?.stdin?.write(payload);
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(reqId);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  public async listWindows(): Promise<DesktopWindowInfo[]> {
    return this.executeAction<DesktopWindowInfo[]>('list_windows');
  }

  public async inspectWindow(params: {
    handle?: number | undefined;
    title?: string | undefined;
  }): Promise<DesktopWindowInfo> {
    return this.executeAction<DesktopWindowInfo>('inspect_window', params);
  }

  public async focusWindow(params: {
    handle?: number | undefined;
    title?: string | undefined;
  }): Promise<{ focused: boolean; handle: number; title: string }> {
    return this.executeAction('focus_window', params);
  }

  public async getControls(params: {
    handle?: number | undefined;
    title?: string | undefined;
    limit?: number | undefined;
  }): Promise<DesktopControlInfo[]> {
    return this.executeAction<DesktopControlInfo[]>('get_controls', params);
  }

  public async clickControl(params: {
    handle?: number | undefined;
    title?: string | undefined;
    control_title?: string | undefined;
    automation_id?: string | undefined;
    control_type?: string | undefined;
  }): Promise<{ clicked: boolean; control: string }> {
    return this.executeAction('click_control', params);
  }

  public async typeText(params: {
    text: string;
    handle?: number | undefined;
    title?: string | undefined;
    automation_id?: string | undefined;
  }): Promise<{ typed: boolean; length: number }> {
    return this.executeAction('type_text', params);
  }

  public async pressKey(params: { key: string }): Promise<{ pressed: boolean; key: string }> {
    return this.executeAction('press_key', params);
  }

  public async scroll(params: {
    direction: 'down' | 'up';
    amount?: number | undefined;
  }): Promise<{ scrolled: boolean }> {
    return this.executeAction('scroll', params);
  }

  public async mouseClick(params: {
    x: number;
    y: number;
    button?: 'left' | 'right' | undefined;
    double?: boolean | undefined;
  }): Promise<{ clicked: boolean; x: number; y: number }> {
    return this.executeAction('mouse_click', params);
  }

  public async mouseMove(params: {
    x: number;
    y: number;
  }): Promise<{ moved: boolean; x: number; y: number }> {
    return this.executeAction('mouse_move', params);
  }

  public async mouseDrag(params: {
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }): Promise<{ dragged: boolean }> {
    return this.executeAction('mouse_drag', params);
  }

  public async captureScreenshot(params: {
    path: string;
    handle?: number | undefined;
  }): Promise<{ captured: boolean; width: number; height: number; saved_path: string }> {
    return this.executeAction('capture_screenshot', params);
  }

  public async launchApplication(params: {
    name: string;
  }): Promise<{ launched: boolean; application: string; pid: number }> {
    return this.executeAction('launch_application', params);
  }

  public dispose(): void {
    if (this.sidecarProcess) {
      try {
        this.sidecarProcess.stdin?.end();
        this.sidecarProcess.kill();
      } catch {
        // Ignored
      }
      this.sidecarProcess = null;
    }

    for (const [, req] of this.pendingRequests) {
      clearTimeout(req.timer);
      req.reject(new Error('Desktop sidecar process terminated.'));
    }
    this.pendingRequests.clear();
  }

  private ensureSidecarRunning(): void {
    if (
      this.sidecarProcess &&
      !this.sidecarProcess.killed &&
      this.sidecarProcess.exitCode === null
    ) {
      return;
    }

    if (!existsSync(this.sidecarScriptPath)) {
      throw new Error(`Desktop automation sidecar not found at "${this.sidecarScriptPath}".`);
    }

    this.sidecarProcess = spawn(this.pythonPath, [this.sidecarScriptPath], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });

    if (!this.sidecarProcess.stdout) {
      throw new Error('Failed to open standard output for desktop sidecar process.');
    }

    const rl = createInterface({
      input: this.sidecarProcess.stdout,
      terminal: false,
    });

    rl.on('line', (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const parsed = JSON.parse(trimmed) as {
          id: string;
          success: boolean;
          data?: unknown;
          error?: string;
        };

        const pending = this.pendingRequests.get(parsed.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.pendingRequests.delete(parsed.id);

          if (parsed.success) {
            pending.resolve(parsed.data);
          } else {
            pending.reject(new Error(parsed.error ?? 'Desktop action failed.'));
          }
        }
      } catch {
        // Malformed line
      }
    });

    this.sidecarProcess.on('exit', () => {
      this.dispose();
    });
  }
}
