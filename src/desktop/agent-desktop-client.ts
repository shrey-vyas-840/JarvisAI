import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';

export const AGENT_DESKTOP_REF_PATTERN = /^@[A-Za-z0-9]+:e\d+$/;

export type AgentDesktopSurface =
  | 'window'
  | 'focused'
  | 'menu'
  | 'menubar'
  | 'sheet'
  | 'popover'
  | 'alert'
  | 'desktop'
  | 'taskbar'
  | 'system-tray'
  | 'quick-settings'
  | 'notification-center'
  | 'toolbar'
  | 'dock'
  | 'spotlight'
  | 'menu-bar-extras'
  | 'system-tray-overflow'
  | 'start-menu'
  | 'action-center';

export type AgentDesktopRefAction =
  'click' | 'toggle' | 'check' | 'uncheck' | 'expand' | 'collapse' | 'set-value' | 'type' | 'clear';

export type AgentDesktopReadProperty = 'text' | 'value' | 'title' | 'bounds' | 'role' | 'states';

export type AgentDesktopStateProperty =
  'visible' | 'enabled' | 'checked' | 'focused' | 'expanded' | 'selected';

export type AgentDesktopWaitEvent =
  | 'window-opened'
  | 'window-closed'
  | 'app-launched'
  | 'app-terminated'
  | 'focus-changed'
  | 'surface-appeared'
  | 'surface-dismissed';

export interface AgentDesktopDisposition {
  readonly delivery?: string;
  readonly retry?: string;
  readonly verification_scope?: string;
}

export interface AgentDesktopErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly details?: unknown;
  readonly recovery?: unknown;
  readonly suggestion?: string;
  readonly disposition?: AgentDesktopDisposition;
}

export interface AgentDesktopEnvelope<T> {
  readonly version: string;
  readonly ok: boolean;
  readonly command: string;
  readonly data?: T;
  readonly error?: AgentDesktopErrorPayload;
}

export interface AgentDesktopRunOptions {
  readonly signal?: AbortSignal | undefined;
  readonly timeoutMs?: number | undefined;
  readonly stdin?: string | undefined;
}

export interface AgentDesktopRunOutput {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
}

export type AgentDesktopRunner = (
  args: readonly string[],
  options: AgentDesktopRunOptions,
) => Promise<AgentDesktopRunOutput>;

export interface AgentDesktopClientOptions {
  readonly binaryPath?: string | undefined;
  readonly runner?: AgentDesktopRunner | undefined;
  readonly defaultTimeoutMs?: number | undefined;
  readonly maxOutputBytes?: number | undefined;
}

export interface AgentDesktopMethodOptions {
  readonly signal?: AbortSignal | undefined;
}

export interface AgentDesktopWindow {
  readonly id: string;
  readonly app_name: string;
  readonly title: string;
  readonly pid: number;
  readonly accessible: boolean;
  readonly visible: boolean;
  readonly minimized: boolean;
  readonly is_focused: boolean;
  readonly bounds: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
}

export interface AgentDesktopStatusData {
  readonly version: string;
  readonly platform: string;
  readonly state_root: string;
  readonly permissions: Record<string, { readonly state: string }>;
  readonly supported_surfaces: readonly string[];
  readonly tracing: boolean;
}

export interface AgentDesktopSnapshotData {
  readonly snapshot_id: string;
  readonly tree: unknown;
  readonly app?: string;
  readonly window?: {
    readonly id?: string;
    readonly title?: string;
  };
  readonly complete?: boolean;
  readonly truncated?: boolean;
  readonly ref_count?: number;
  readonly [key: string]: unknown;
}

export interface AgentDesktopMatch {
  readonly ref_id?: string;
  readonly role: string;
  readonly name?: string;
  readonly value?: string;
  readonly states?: readonly string[];
  readonly bounds?: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly [key: string]: unknown;
}

export interface AgentDesktopFindData {
  readonly snapshot_id: string;
  readonly matches: readonly AgentDesktopMatch[];
  readonly roles_present?: readonly string[];
  readonly [key: string]: unknown;
}

export interface AgentDesktopSnapshotParams {
  readonly app?: string | undefined;
  readonly windowId?: string | undefined;
  readonly surface?: AgentDesktopSurface | undefined;
  readonly root?: string | undefined;
  readonly maxDepth?: number | undefined;
  readonly interactiveOnly?: boolean | undefined;
  readonly compact?: boolean | undefined;
  readonly skeleton?: boolean | undefined;
  readonly includeBounds?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AgentDesktopFindParams {
  readonly app?: string | undefined;
  readonly windowId?: string | undefined;
  readonly surface?: AgentDesktopSurface | undefined;
  readonly root?: string | undefined;
  readonly role?: string | undefined;
  readonly name?: string | undefined;
  readonly text?: string | undefined;
  readonly value?: string | undefined;
  readonly description?: string | undefined;
  readonly nativeId?: string | undefined;
  readonly exact?: boolean | undefined;
  readonly first?: boolean | undefined;
  readonly limit?: number | undefined;
  readonly timeoutMs?: number | undefined;
}

export interface AgentDesktopActionParams {
  readonly action: AgentDesktopRefAction;
  readonly ref: string;
  readonly text?: string | undefined;
  readonly timeoutMs?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface AgentDesktopPressParams {
  readonly combo: string;
  readonly app?: string | undefined;
  readonly windowId?: string | undefined;
  readonly signal?: AbortSignal | undefined;
}

export type AgentDesktopWaitParams =
  | {
      readonly mode: 'delay';
      readonly ms: number;
      readonly signal?: AbortSignal | undefined;
    }
  | {
      readonly mode: 'element';
      readonly ref: string;
      readonly predicate?: 'exists' | 'enabled' | 'visible' | 'actionable' | 'value' | undefined;
      readonly value?: string | undefined;
      readonly timeoutMs?: number | undefined;
      readonly app?: string | undefined;
      readonly signal?: AbortSignal | undefined;
    }
  | {
      readonly mode: 'window';
      readonly title: string;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    }
  | {
      readonly mode: 'text';
      readonly text: string;
      readonly app?: string | undefined;
      readonly count?: number | undefined;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    }
  | {
      readonly mode: 'menu';
      readonly state: 'open' | 'closed';
      readonly app?: string | undefined;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    }
  | {
      readonly mode: 'event';
      readonly event: AgentDesktopWaitEvent;
      readonly windowId?: string | undefined;
      readonly timeoutMs?: number | undefined;
      readonly signal?: AbortSignal | undefined;
    };

export class AgentDesktopCommandError extends Error {
  public readonly code: string;
  public readonly details: unknown;
  public readonly recovery: unknown;
  public readonly suggestion: string | undefined;
  public readonly disposition: AgentDesktopDisposition | undefined;

  public constructor(payload: AgentDesktopErrorPayload) {
    const retry = payload.disposition?.retry;
    const delivery = payload.disposition?.delivery;
    const dispositionText =
      retry === undefined && delivery === undefined
        ? ''
        : ` (delivery=${delivery ?? 'unknown'}, retry=${retry ?? 'unknown'})`;
    const suggestionText =
      payload.suggestion === undefined ? '' : ` Suggestion: ${payload.suggestion}`;

    super(`${payload.code}: ${payload.message}${dispositionText}${suggestionText}`);
    this.name = 'AgentDesktopCommandError';
    this.code = payload.code;
    this.details = payload.details;
    this.recovery = payload.recovery;
    this.suggestion = payload.suggestion;
    this.disposition = payload.disposition;
  }
}

export class AgentDesktopClient {
  private readonly runner: AgentDesktopRunner;
  private readonly binaryPath: string;
  private readonly defaultTimeoutMs: number;

  public constructor(options: AgentDesktopClientOptions = {}) {
    this.binaryPath = options.binaryPath ?? resolveAgentDesktopBinary();
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? 15_000;
    this.runner =
      options.runner ??
      ((args, runOptions) =>
        runAgentDesktopProcess(this.binaryPath, args, runOptions, options.maxOutputBytes));
  }

  public async status(options: AgentDesktopMethodOptions = {}): Promise<AgentDesktopStatusData> {
    return this.run<AgentDesktopStatusData>(['status'], {
      signal: options.signal,
    });
  }

  public async version(options: AgentDesktopMethodOptions = {}): Promise<unknown> {
    return this.run<unknown>(['version'], { signal: options.signal });
  }

  public async listWindows(
    app?: string,
    options: AgentDesktopMethodOptions & { readonly timeoutMs?: number | undefined } = {},
  ): Promise<AgentDesktopWindow[]> {
    const args = ['list-windows'];

    if (app !== undefined) {
      assertNonEmpty(app, 'app');
      args.push('--app', app);
    }

    if (options.timeoutMs !== undefined) {
      args.push('--timeout-ms', String(options.timeoutMs));
    }

    return this.run<AgentDesktopWindow[]>(args, {
      signal: options.signal,
      timeoutMs: Math.max(this.defaultTimeoutMs, (options.timeoutMs ?? 0) + 5_000),
    });
  }

  public async snapshot(
    params: AgentDesktopSnapshotParams,
    options: AgentDesktopMethodOptions = {},
  ): Promise<AgentDesktopSnapshotData> {
    const args = ['snapshot'];

    if (params.app !== undefined) {
      assertNonEmpty(params.app, 'app');
      args.push('--app', params.app);
    }

    if (params.windowId !== undefined) {
      assertNonEmpty(params.windowId, 'window_id');
      args.push('--window-id', params.windowId);
    }

    if (params.surface !== undefined) {
      args.push('--surface', params.surface);
    }

    if (params.root !== undefined) {
      assertRef(params.root);
      args.push('--root', params.root);
    }

    if (params.maxDepth !== undefined) {
      args.push('--max-depth', String(params.maxDepth));
    }

    if (params.interactiveOnly === true) {
      args.push('-i');
    }

    if (params.compact === true) {
      args.push('--compact');
    }

    if (params.skeleton === true) {
      args.push('--skeleton');
    }

    if (params.includeBounds === true) {
      args.push('--include-bounds');
    }

    if (params.timeoutMs !== undefined) {
      args.push('--timeout-ms', String(params.timeoutMs));
    }

    const data = await this.run<AgentDesktopSnapshotData>(args, {
      signal: options.signal,
      timeoutMs: Math.max(this.defaultTimeoutMs, (params.timeoutMs ?? 0) + 5_000),
    });

    assertSnapshot(data);

    return data;
  }

  public async find(
    params: AgentDesktopFindParams,
    options: AgentDesktopMethodOptions = {},
  ): Promise<AgentDesktopFindData> {
    const args = ['find'];

    if (params.app !== undefined) {
      assertNonEmpty(params.app, 'app');
      args.push('--app', params.app);
    }

    if (params.windowId !== undefined) {
      assertNonEmpty(params.windowId, 'window_id');
      args.push('--window-id', params.windowId);
    }

    if (params.surface !== undefined) {
      args.push('--surface', params.surface);
    }

    if (params.root !== undefined) {
      assertRef(params.root);
      args.push('--root', params.root);
    }

    pushOptionalArg(args, '--role', params.role);
    pushOptionalArg(args, '--name', params.name);
    pushOptionalArg(args, '--text', params.text);
    pushOptionalArg(args, '--value', params.value);
    pushOptionalArg(args, '--description', params.description);
    pushOptionalArg(args, '--native-id', params.nativeId);

    if (params.exact === true) {
      args.push('--exact');
    }

    if (params.first === true) {
      args.push('--first');
    } else if (params.limit !== undefined) {
      args.push('--limit', String(params.limit));
    }

    if (params.timeoutMs !== undefined) {
      args.push('--timeout-ms', String(params.timeoutMs));
    }

    const data = await this.run<AgentDesktopFindData>(args, {
      signal: options.signal,
      timeoutMs: Math.max(this.defaultTimeoutMs, (params.timeoutMs ?? 0) + 5_000),
    });

    if (!isRecord(data) || typeof data.snapshot_id !== 'string' || !Array.isArray(data.matches)) {
      throw new Error('Agent Desktop returned an invalid find response.');
    }

    return data;
  }

  public async get(
    ref: string,
    property: AgentDesktopReadProperty,
    options: AgentDesktopMethodOptions = {},
  ): Promise<unknown> {
    assertRef(ref);

    return this.run<unknown>(['get', ref, '--property', property], {
      signal: options.signal,
    });
  }

  public async is(
    ref: string,
    property: AgentDesktopStateProperty,
    options: AgentDesktopMethodOptions = {},
  ): Promise<unknown> {
    assertRef(ref);

    return this.run<unknown>(['is', ref, '--property', property], {
      signal: options.signal,
    });
  }

  public async act(params: AgentDesktopActionParams): Promise<unknown> {
    assertRef(params.ref);

    const args = [params.action, params.ref];

    if (params.timeoutMs !== undefined) {
      args.push('--timeout-ms', String(params.timeoutMs));
    }

    let stdin: string | undefined;

    if (params.action === 'type' || params.action === 'set-value') {
      if (params.text === undefined) {
        throw new Error(`Text is required for the ${params.action} action.`);
      }

      const byteLength = Buffer.byteLength(params.text, 'utf8');
      const limit = params.action === 'type' ? 10_000 : 131_072;

      if (byteLength > limit) {
        throw new Error(
          `Text is too long for ${params.action}: ${String(byteLength)} bytes exceeds ${String(limit)}.`,
        );
      }

      stdin = params.text;
      args.push('--stdin');

      if (params.action === 'type') {
        args.push('--headed');
      }
    }

    return this.run<unknown>(args, {
      signal: params.signal,
      stdin,
      timeoutMs:
        params.timeoutMs === undefined
          ? this.defaultTimeoutMs
          : Math.max(this.defaultTimeoutMs, params.timeoutMs + 5_000),
    });
  }

  public async press(params: AgentDesktopPressParams): Promise<unknown> {
    const combo = params.combo.trim().toLowerCase();

    if (!/^[a-z0-9+]+$/.test(combo)) {
      throw new Error('Key combo must contain only letters, digits, and "+" separators.');
    }

    if (isBlockedKeyCombo(combo)) {
      throw new Error(`Key combo "${combo}" is blocked by JARVIS safety policy.`);
    }

    const args = ['press', combo];

    if (params.app !== undefined) {
      assertNonEmpty(params.app, 'app');
      args.push('--app', params.app);
    }

    if (params.windowId !== undefined) {
      assertNonEmpty(params.windowId, 'window_id');
      args.push('--window-id', params.windowId);
    }

    return this.run<unknown>(args, {
      signal: params.signal,
      timeoutMs: 20_000,
    });
  }

  public async wait(params: AgentDesktopWaitParams): Promise<unknown> {
    const args = ['wait'];
    let commandTimeoutMs = this.defaultTimeoutMs;

    if (params.mode === 'delay') {
      args.push(String(params.ms));
    } else {
      const waitTimeoutMs = params.timeoutMs ?? 15_000;
      commandTimeoutMs = Math.max(this.defaultTimeoutMs, waitTimeoutMs + 5_000);

      if (params.mode === 'element') {
        assertRef(params.ref);
        args.push('--element', params.ref);

        if (params.predicate !== undefined) {
          args.push('--predicate', params.predicate);
        }

        if (params.value !== undefined) {
          args.push('--value', params.value);
        }

        if (params.app !== undefined) {
          args.push('--app', params.app);
        }
      } else if (params.mode === 'window') {
        assertNonEmpty(params.title, 'window title');
        args.push('--window', params.title);
      } else if (params.mode === 'text') {
        assertNonEmpty(params.text, 'text');
        args.push('--text', params.text);

        if (params.app !== undefined) {
          args.push('--app', params.app);
        }

        if (params.count !== undefined) {
          args.push('--count', String(params.count));
        }
      } else if (params.mode === 'menu') {
        args.push(params.state === 'open' ? '--menu' : '--menu-closed');

        if (params.app !== undefined) {
          args.push('--app', params.app);
        }
      } else {
        args.push('--event', params.event);

        if (params.windowId !== undefined) {
          args.push('--window-id', params.windowId);
        }
      }

      args.push('--timeout', String(waitTimeoutMs));
    }

    return this.run<unknown>(args, {
      signal: params.signal,
      timeoutMs: commandTimeoutMs,
    });
  }

  private async run<T>(args: readonly string[], options: AgentDesktopRunOptions): Promise<T> {
    const output = await this.runner(args, {
      signal: options.signal,
      timeoutMs: options.timeoutMs ?? this.defaultTimeoutMs,
      stdin: options.stdin,
    });
    const envelope = parseEnvelope(output.stdout);

    if (!envelope.ok) {
      const error = envelope.error;

      if (error === undefined) {
        throw new Error('Agent Desktop returned ok=false without an error payload.');
      }

      throw new AgentDesktopCommandError(error);
    }

    if (output.exitCode !== 0) {
      throw new Error(
        `Agent Desktop exited with code ${String(output.exitCode)} after reporting success.`,
      );
    }

    return envelope.data as T;
  }
}

export function isQualifiedAgentDesktopRef(value: string): boolean {
  return AGENT_DESKTOP_REF_PATTERN.test(value);
}

export function resolveAgentDesktopBinary(): string {
  const require = createRequire(import.meta.url);

  try {
    const packageJsonPath = require.resolve('agent-desktop/package.json');
    const binDir = path.join(path.dirname(packageJsonPath), 'bin');
    const binaryName =
      process.platform === 'win32' ? `agent-desktop-win32-${process.arch}.exe` : 'agent-desktop';
    const candidate = path.join(binDir, binaryName);

    if (existsSync(candidate)) {
      return candidate;
    }
  } catch {
    // Fall through to PATH.
  }

  return process.platform === 'win32' ? 'agent-desktop.exe' : 'agent-desktop';
}

function runAgentDesktopProcess(
  binaryPath: string,
  args: readonly string[],
  options: AgentDesktopRunOptions,
  maxOutputBytes = 16 * 1024 * 1024,
): Promise<AgentDesktopRunOutput> {
  return new Promise<AgentDesktopRunOutput>((resolve, reject) => {
    if (signalIsAborted(options.signal)) {
      reject(new Error('Agent Desktop command cancelled before start.'));
      return;
    }

    let settled = false;
    let stdout = '';
    let stderr = '';
    let stdoutBytes = 0;
    let stderrBytes = 0;
    const child = spawn(binaryPath, [...args], {
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const finish = (callback: () => void): void => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener('abort', onAbort);
      callback();
    };
    const onAbort = (): void => {
      child.kill();
      finish(() => {
        reject(new Error('Agent Desktop command cancelled.'));
      });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(() => {
        reject(new Error(`Agent Desktop command timed out after ${String(options.timeoutMs)}ms.`));
      });
    }, options.timeoutMs ?? 15_000);

    options.signal?.addEventListener('abort', onAbort, { once: true });

    if (signalIsAborted(options.signal)) {
      onAbort();
      return;
    }

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');

    child.stdout.on('data', (chunk: string) => {
      stdoutBytes += Buffer.byteLength(chunk, 'utf8');

      if (stdoutBytes > maxOutputBytes) {
        child.kill();
        finish(() => {
          reject(new Error('Agent Desktop output exceeded the safety limit.'));
        });
        return;
      }

      stdout += chunk;
    });

    child.stderr.on('data', (chunk: string) => {
      stderrBytes += Buffer.byteLength(chunk, 'utf8');

      if (stderrBytes <= maxOutputBytes) {
        stderr += chunk;
      }
    });

    child.on('error', (error) => {
      finish(() => {
        reject(error);
      });
    });

    child.on('close', (exitCode) => {
      finish(() => {
        resolve({ stdout, stderr, exitCode });
      });
    });

    child.stdin.on('error', () => {
      // The process may exit before consuming stdin.
    });

    if (options.stdin !== undefined) {
      child.stdin.end(options.stdin, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

function parseEnvelope(stdout: string): AgentDesktopEnvelope<unknown> {
  const trimmed = stdout.trim();

  if (trimmed.length === 0) {
    throw new Error('Agent Desktop returned no JSON output.');
  }

  let parsed: unknown;

  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error('Agent Desktop returned malformed JSON output.');
  }

  if (
    !isRecord(parsed) ||
    typeof parsed.version !== 'string' ||
    typeof parsed.ok !== 'boolean' ||
    typeof parsed.command !== 'string'
  ) {
    throw new Error('Agent Desktop returned an invalid JSON envelope.');
  }

  if (!parsed.ok) {
    const error = parsed.error;

    if (!isRecord(error) || typeof error.code !== 'string' || typeof error.message !== 'string') {
      throw new Error('Agent Desktop returned an invalid error envelope.');
    }
  }

  return parsed as unknown as AgentDesktopEnvelope<unknown>;
}

function assertSnapshot(data: unknown): asserts data is AgentDesktopSnapshotData {
  if (!isRecord(data) || typeof data.snapshot_id !== 'string' || !isRecord(data.tree)) {
    throw new Error('Agent Desktop returned an invalid snapshot response.');
  }
}

function assertRef(ref: string): void {
  if (!isQualifiedAgentDesktopRef(ref)) {
    throw new Error(
      'Ref must be a qualified agent-desktop ref from a fresh snapshot, for example @s8f3k2p9:e1.',
    );
  }
}

function assertNonEmpty(value: string, label: string): void {
  if (value.trim().length === 0) {
    throw new Error(`${label} must not be empty.`);
  }
}

function pushOptionalArg(args: string[], flag: string, value: string | undefined): void {
  if (value !== undefined) {
    assertNonEmpty(value, flag);
    args.push(flag, value);
  }
}

function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function isBlockedKeyCombo(combo: string): boolean {
  const blocked = new Set([
    'alt+f4',
    'win+l',
    'win+d',
    'alt+tab',
    'win+r',
    'win+x',
    'win+e',
    'ctrl+shift+esc',
    'alt+shift+tab',
    'win+shift+tab',
  ]);

  return blocked.has(combo);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
