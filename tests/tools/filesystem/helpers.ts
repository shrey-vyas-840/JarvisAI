import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { ToolExecutionContext } from '../../../src/core/tool-registry.js';
import { Logger } from '../../../src/logging/logger.js';
import type {
  ApprovalOutcome,
  ApprovalProvider,
  ApprovalRequest,
} from '../../../src/security/approval-types.js';
import { PathGuard } from '../../../src/tools/filesystem/path-guard.js';

const logger = new Logger({ level: 'debug', logDir: 'unused', console: false, file: false });
const fixedNow = () => new Date('2026-11-07T00:00:00.000Z');

export interface TempRoots {
  base: string;
  workspace: string;
  exports: string;
  outside: string;
  guard: PathGuard;
  cleanup: () => void;
}

export function createTempRoots(): TempRoots {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), 'jarvis-fs-')));
  const workspace = path.join(base, 'workspace');
  const exportsDir = path.join(base, 'exports');
  const outside = path.join(base, 'outside');

  mkdirSync(workspace, { recursive: true });
  mkdirSync(exportsDir, { recursive: true });
  mkdirSync(outside, { recursive: true });

  return {
    base,
    workspace,
    exports: exportsDir,
    outside,
    guard: new PathGuard({ workspace, exports: exportsDir }),
    cleanup: () => {
      rmSync(base, { recursive: true, force: true });
    },
  };
}

export function createContext(signal = new AbortController().signal): ToolExecutionContext {
  return {
    executionId: 'exec-fs',
    callId: 'call-fs',
    logger,
    signal,
    now: fixedNow,
  };
}

export function writeText(root: string, relativePath: string, content: string): string {
  const absolutePath = path.join(root, relativePath);

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content, 'utf8');

  return absolutePath;
}

export function writeBinary(root: string, relativePath: string, content: Buffer): string {
  const absolutePath = path.join(root, relativePath);

  mkdirSync(path.dirname(absolutePath), { recursive: true });
  writeFileSync(absolutePath, content);

  return absolutePath;
}

export function createDirectoryLink(target: string, linkPath: string): void {
  if (process.platform === 'win32') {
    symlinkSync(target, linkPath, 'junction');
    return;
  }

  symlinkSync(target, linkPath, 'dir');
}

export function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('Expected a record');
  }

  return value as Record<string, unknown>;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export class FakeApprovalProvider implements ApprovalProvider {
  public readonly requests: ApprovalRequest[] = [];

  private readonly outcomes: ApprovalOutcome[];

  public constructor(...outcomes: ApprovalOutcome[]) {
    this.outcomes = outcomes.length > 0 ? outcomes : ['unavailable'];
  }

  public requestApproval(request: ApprovalRequest): Promise<ApprovalOutcome> {
    this.requests.push(request);

    return Promise.resolve(this.outcomes.shift() ?? 'unavailable');
  }
}
