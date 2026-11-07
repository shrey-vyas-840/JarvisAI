import { describe, expect, it } from 'vitest';

import {
  CliApprovalProvider,
  formatApprovalPrompt,
  isAffirmative,
} from '../../src/security/cli-approval-provider.js';
import type { ApprovalRequest } from '../../src/security/approval-types.js';

function request(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    toolName: 'write_text_file',
    operation: 'Create new text file',
    root: 'workspace',
    relativePath: 'notes/test.txt',
    absolutePath: 'D:\\AI\\JarvisWorkspace\\notes\\test.txt',
    action: 'Create one new UTF-8 text file.',
    warning: 'Existing files are never overwritten.',
    content: {
      text: 'hello\nworld',
      bytes: 11,
      sha256: 'abc123',
    },
    ...overrides,
  };
}

function context(): { signal: AbortSignal } {
  return { signal: new AbortController().signal };
}

describe('CliApprovalProvider', () => {
  it.each([['y'], ['Y'], ['yes'], [' YES '], ['approve'], ['approved']])(
    'approves explicit affirmative answer %j',
    async (answer) => {
      const provider = new CliApprovalProvider({
        interactive: true,
        output: () => undefined,
        readLine: () => Promise.resolve(answer),
      });

      await expect(provider.requestApproval(request(), context())).resolves.toBe('approved');
    },
  );

  it.each([[''], ['n'], ['no'], ['maybe'], ['yep'], ['approve all']])(
    'denies non-affirmative answer %j',
    async (answer) => {
      const provider = new CliApprovalProvider({
        interactive: true,
        output: () => undefined,
        readLine: () => Promise.resolve(answer),
      });

      await expect(provider.requestApproval(request(), context())).resolves.toBe('denied');
    },
  );

  it('fails closed when not interactive and never reads a line', async () => {
    let reads = 0;
    let output = '';
    const provider = new CliApprovalProvider({
      interactive: false,
      output: (text) => {
        output += text;
      },
      readLine: () => {
        reads += 1;
        return Promise.resolve('yes');
      },
    });

    await expect(provider.requestApproval(request(), context())).resolves.toBe('unavailable');
    expect(reads).toBe(0);
    expect(output).toBe('');
  });

  it('fails closed on EOF or readline errors', async () => {
    const provider = new CliApprovalProvider({
      interactive: true,
      output: () => undefined,
      readLine: () => Promise.reject(new Error('readline was closed')),
    });

    await expect(provider.requestApproval(request(), context())).resolves.toBe('unavailable');
  });

  it('reports cancellation when the caller aborts', async () => {
    const controller = new AbortController();
    const provider = new CliApprovalProvider({
      interactive: true,
      output: () => undefined,
      readLine: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    });

    const approval = provider.requestApproval(request(), { signal: controller.signal });
    controller.abort();

    await expect(approval).resolves.toBe('cancelled');
  });

  it('denies on timeout and shows a timeout message', async () => {
    let output = '';
    const provider = new CliApprovalProvider({
      interactive: true,
      timeoutMs: 10,
      output: (text) => {
        output += text;
      },
      readLine: ({ signal }) =>
        new Promise<string>((_resolve, reject) => {
          signal.addEventListener(
            'abort',
            () => {
              reject(new DOMException('Aborted', 'AbortError'));
            },
            { once: true },
          );
        }),
    });

    await expect(provider.requestApproval(request(), context())).resolves.toBe('denied');
    expect(output).toContain('Approval timed out');
  });

  it('rejects invalid timeout values', () => {
    expect(() => new CliApprovalProvider({ timeoutMs: 0 })).toThrow(
      'Approval timeout must be a positive integer',
    );
    expect(() => new CliApprovalProvider({ timeoutMs: 1.5 })).toThrow(
      'Approval timeout must be a positive integer',
    );
  });
});

describe('formatApprovalPrompt', () => {
  it('shows full metadata, escaped content, hash, and a default No prompt', () => {
    const prompt = formatApprovalPrompt(
      request({
        operation: 'Create\nfile',
        content: {
          text: 'line 1\nline 2\u001b[31m',
          bytes: 18,
          sha256: 'deadbeef',
        },
      }),
    );

    expect(prompt).toContain('JARVIS APPROVAL REQUIRED');
    expect(prompt).toContain('Operation: Create\\nfile');
    expect(prompt).toContain('Root: workspace');
    expect(prompt).toContain('Relative path: notes/test.txt');
    expect(prompt).toContain('Absolute path: D:\\\\AI\\\\JarvisWorkspace\\\\notes\\\\test.txt');
    expect(prompt).toContain('Size: 18 bytes');
    expect(prompt).toContain('SHA-256: deadbeef');
    expect(prompt).toContain('Content (escaped JSON string):');
    expect(prompt).toContain('"line 1\\nline 2\\u001b[31m"');
    expect(prompt).not.toContain('\u001b');
    expect(prompt).toContain('Approve this exact operation? (y/N):');
  });

  it('escapes invisible formatting characters in content and metadata', () => {
    const prompt = formatApprovalPrompt(
      request({
        relativePath: 'notes/\u202etxt.exe',
        content: {
          text: 'safe\u202eevil\u2028end',
          bytes: 15,
          sha256: 'cafebabe',
        },
      }),
    );

    expect(prompt).not.toContain('\u202e');
    expect(prompt).not.toContain('\u2028');
    expect(prompt).toContain('Relative path: notes/\\u202etxt.exe');
    expect(prompt).toContain('"safe\\u202eevil\\u2028end"');
  });

  it('does not show a content section for non-content operations', () => {
    const base = request();
    const prompt = formatApprovalPrompt({
      toolName: base.toolName,
      operation: 'Create new directory',
      root: base.root,
      relativePath: base.relativePath,
      absolutePath: base.absolutePath,
      action: base.action,
      warning: base.warning,
    });

    expect(prompt).not.toContain('Content (escaped JSON string):');
    expect(prompt).not.toContain('SHA-256:');
  });
});

describe('isAffirmative', () => {
  it('accepts only explicit yes values case-insensitively', () => {
    expect(isAffirmative('yes')).toBe(true);
    expect(isAffirmative(' Y ')).toBe(true);
    expect(isAffirmative('approved')).toBe(true);
    expect(isAffirmative('')).toBe(false);
    expect(isAffirmative('yess')).toBe(false);
    expect(isAffirmative('approve all')).toBe(false);
  });
});
