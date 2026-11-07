import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/core/tool-registry.js';
import type { ApprovalOutcome } from '../../../src/security/approval-types.js';
import { createWriteTextFileTool } from '../../../src/tools/filesystem/write-text-file.js';
import {
  createContext,
  createDirectoryLink,
  createTempRoots,
  FakeApprovalProvider,
  writeText,
} from './helpers.js';

function setup(...outcomes: ApprovalOutcome[]): {
  roots: ReturnType<typeof createTempRoots>;
  provider: FakeApprovalProvider;
  registry: ToolRegistry;
} {
  const roots = createTempRoots();
  const provider = new FakeApprovalProvider(...outcomes);
  const registry = new ToolRegistry({ approvalProvider: provider });

  registry.register(createWriteTextFileTool({ guard: roots.guard }));

  return { roots, provider, registry };
}

function sha256(value: string): string {
  return createHash('sha256').update(Buffer.from(value, 'utf8')).digest('hex');
}

describe('write_text_file', () => {
  it('creates a new UTF-8 file only after approval and verifies exact content', async () => {
    const { roots, provider, registry } = setup('approved');
    const content = 'Hello, JARVIS!\nSecond line\nEmoji: 😀\nTab:\tend\n';

    try {
      mkdirSync(path.join(roots.workspace, 'notes'));

      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'notes/hello.txt', content },
        createContext(),
      );

      expect(receipt).toMatchObject({
        toolName: 'write_text_file',
        status: 'success',
        approval: 'approved',
        verification: 'verified',
        error: null,
        result: {
          root: 'workspace',
          relativePath: 'notes\\hello.txt',
          absolutePath: path.join(roots.workspace, 'notes', 'hello.txt'),
          type: 'file',
          encoding: 'utf-8',
          bytesWritten: Buffer.byteLength(content, 'utf8'),
          sha256: sha256(content),
          created: true,
          verificationStatus: 'verified',
        },
      });

      expect(readFileSync(path.join(roots.workspace, 'notes', 'hello.txt'), 'utf8')).toBe(content);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        toolName: 'write_text_file',
        operation: 'Create new text file',
        root: 'workspace',
        relativePath: 'notes\\hello.txt',
        absolutePath: path.join(roots.workspace, 'notes', 'hello.txt'),
        content: {
          text: content,
          bytes: Buffer.byteLength(content, 'utf8'),
          sha256: sha256(content),
        },
      });
    } finally {
      roots.cleanup();
    }
  });

  it('creates an empty text file when approved', async () => {
    const { roots, registry } = setup('approved');

    try {
      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'empty.txt', content: '' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'success',
        approval: 'approved',
        verification: 'verified',
        result: { bytesWritten: 0, created: true },
      });
      expect(readFileSync(path.join(roots.workspace, 'empty.txt'), 'utf8')).toBe('');
    } finally {
      roots.cleanup();
    }
  });

  it('preserves a leading byte-order mark and verifies exact bytes', async () => {
    const { roots, registry } = setup('approved');
    const content = '\uFEFFhello';

    try {
      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'bom.txt', content },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'success',
        approval: 'approved',
        verification: 'verified',
        result: { bytesWritten: 8 },
      });
      expect(readFileSync(path.join(roots.workspace, 'bom.txt'), 'utf8')).toBe(content);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects an existing file before asking for approval and never changes it', async () => {
    const { roots, provider, registry } = setup('approved');

    try {
      writeText(roots.workspace, 'existing.txt', 'original content');

      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'existing.txt', content: 'replacement' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'required',
        verification: 'not_applicable',
        error:
          'Approval request could not be prepared: already_exists: Target already exists; existing files are never overwritten',
      });
      expect(provider.requests).toHaveLength(0);
      expect(readFileSync(path.join(roots.workspace, 'existing.txt'), 'utf8')).toBe(
        'original content',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('does not create missing parent directories', async () => {
    const { roots, provider, registry } = setup('approved');

    try {
      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'missing/file.txt', content: 'text' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'required',
        error: 'Approval request could not be prepared: not_found: Parent directory does not exist',
      });
      expect(provider.requests).toHaveLength(0);
      expect(existsSync(path.join(roots.workspace, 'missing'))).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it.each([
    ['../outside.txt', 'path_traversal'],
    ['..\\outside.txt', 'path_traversal'],
    ['D:\\AI\\JarvisWorkspace\\absolute.txt', 'absolute_path'],
    ['\\\\server\\share\\file.txt', 'unc_path'],
  ])('rejects unsafe path %j with %s before approval', async (relativePath, code) => {
    const { roots, provider, registry } = setup('approved');

    try {
      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath, content: 'text' },
        createContext(),
      );

      expect(receipt).toMatchObject({ status: 'failure', approval: 'required' });
      expect(receipt.error).toContain(code);
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects writing through a junction or symlink', async () => {
    const { roots, provider, registry } = setup('approved');

    try {
      createDirectoryLink(roots.outside, path.join(roots.workspace, 'escape'));

      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'escape/file.txt', content: 'text' },
        createContext(),
      );

      expect(receipt).toMatchObject({ status: 'failure', approval: 'required' });
      expect(receipt.error).toContain('symlink_rejected');
      expect(provider.requests).toHaveLength(0);
      expect(existsSync(path.join(roots.outside, 'file.txt'))).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it.each(['.env', 'id_rsa', 'credentials.json', '.ssh/config'])(
    'rejects sensitive target %j before approval',
    async (relativePath) => {
      const { roots, provider, registry } = setup('approved');

      try {
        const receipt = await registry.execute(
          'write_text_file',
          { root: 'workspace', relativePath, content: 'secret' },
          createContext(),
        );

        expect(receipt).toMatchObject({ status: 'failure', approval: 'required' });
        expect(receipt.error).toContain('sensitive_file');
        expect(provider.requests).toHaveLength(0);
      } finally {
        roots.cleanup();
      }
    },
  );

  it.each(['denied', 'unavailable', 'cancelled'] as const)(
    'does not write when approval is %s',
    async (outcome) => {
      const roots = createTempRoots();
      const provider = new FakeApprovalProvider(outcome);
      const registry = new ToolRegistry({ approvalProvider: provider });
      registry.register(createWriteTextFileTool({ guard: roots.guard }));

      try {
        const receipt = await registry.execute(
          'write_text_file',
          { root: 'workspace', relativePath: 'refused.txt', content: 'text' },
          createContext(),
        );

        expect(receipt).toMatchObject({
          status:
            outcome === 'denied'
              ? 'denied'
              : outcome === 'cancelled'
                ? 'cancelled'
                : 'approval_unavailable',
          approval: outcome,
          verification: 'not_applicable',
          result: null,
        });
        expect(provider.requests).toHaveLength(1);
        expect(existsSync(path.join(roots.workspace, 'refused.txt'))).toBe(false);
      } finally {
        roots.cleanup();
      }
    },
  );

  it('fails when no approval provider is configured', async () => {
    const roots = createTempRoots();
    const registry = new ToolRegistry();
    registry.register(createWriteTextFileTool({ guard: roots.guard }));

    try {
      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'no-provider.txt', content: 'text' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'approval_unavailable',
        approval: 'unavailable',
        error: 'Approval provider is unavailable',
        result: null,
      });
      expect(existsSync(path.join(roots.workspace, 'no-provider.txt'))).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('fails closed when the approval provider throws', async () => {
    const roots = createTempRoots();
    const provider = new FakeApprovalProvider('approved');

    provider.requestApproval = () => Promise.reject(new Error('provider crashed'));

    const registry = new ToolRegistry({ approvalProvider: provider });
    registry.register(createWriteTextFileTool({ guard: roots.guard }));

    try {
      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'provider-error.txt', content: 'text' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'approval_unavailable',
        approval: 'unavailable',
        error: 'Approval provider failed',
        result: null,
      });
      expect(existsSync(path.join(roots.workspace, 'provider-error.txt'))).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects invalid arguments without approval', async () => {
    const { roots, provider, registry } = setup('approved');
    const invalidArguments: Record<string, unknown>[] = [
      { root: 'workspace', relativePath: 'x.txt' },
      { root: 'workspace', relativePath: 'x.txt', content: 5 },
      { root: 'workspace', relativePath: '', content: 'text' },
      { root: 'workspace', relativePath: 'x.txt', content: 'text', extra: true },
      { root: 'workspace', relativePath: 'x.txt', content: 'a\0b' },
      { root: 'workspace', relativePath: 'x.txt', content: '\uD800' },
    ];

    try {
      for (const args of invalidArguments) {
        const receipt = await registry.execute('write_text_file', args, createContext());

        expect(receipt).toMatchObject({
          status: 'failure',
          approval: 'not_required',
          verification: 'not_applicable',
          result: null,
        });
        expect(receipt.error).toContain('Invalid arguments');
      }

      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it('accepts exactly 64 KiB and rejects one byte more', async () => {
    const { roots, provider, registry } = setup('approved', 'approved');
    const exact = 'a'.repeat(64 * 1024);

    try {
      const accepted = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'exact.txt', content: exact },
        createContext(),
      );

      expect(accepted).toMatchObject({
        status: 'success',
        approval: 'approved',
        verification: 'verified',
        result: { bytesWritten: 64 * 1024 },
      });
      expect(readFileSync(path.join(roots.workspace, 'exact.txt'), 'utf8')).toBe(exact);

      const rejected = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'too-large.txt', content: `${exact}a` },
        createContext(),
      );

      expect(rejected).toMatchObject({
        status: 'failure',
        approval: 'not_required',
        result: null,
      });
      expect(rejected.error).toContain('Invalid arguments');
      expect(existsSync(path.join(roots.workspace, 'too-large.txt'))).toBe(false);
      expect(provider.requests).toHaveLength(1);
    } finally {
      roots.cleanup();
    }
  });

  it('enforces the byte limit for multi-byte text', async () => {
    const { roots, provider, registry } = setup('approved');

    try {
      const exact = '😀'.repeat(16 * 1024);

      expect(Buffer.byteLength(exact, 'utf8')).toBe(64 * 1024);

      const accepted = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'emoji.txt', content: exact },
        createContext(),
      );

      expect(accepted.status).toBe('success');

      const rejected = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'emoji-too-large.txt', content: `${exact}😀` },
        createContext(),
      );

      expect(rejected.status).toBe('failure');
      expect(rejected.error).toContain('Invalid arguments');
      expect(provider.requests).toHaveLength(1);
    } finally {
      roots.cleanup();
    }
  });

  it('detects a file that appears after approval without overwriting it', async () => {
    const roots = createTempRoots();
    const absolutePath = path.join(roots.workspace, 'raced.txt');
    const provider: FakeApprovalProvider = new FakeApprovalProvider('approved');

    provider.requestApproval = (request) => {
      provider.requests.push(request);
      writeFileSync(absolutePath, 'created by another operation', 'utf8');

      return Promise.resolve('approved');
    };

    const registry = new ToolRegistry({ approvalProvider: provider });
    registry.register(createWriteTextFileTool({ guard: roots.guard }));

    try {
      const receipt = await registry.execute(
        'write_text_file',
        { root: 'workspace', relativePath: 'raced.txt', content: 'approved content' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'approved',
        verification: 'not_applicable',
        result: null,
      });
      expect(receipt.error).toContain('already_exists');
      expect(readFileSync(absolutePath, 'utf8')).toBe('created by another operation');
    } finally {
      roots.cleanup();
    }
  });

  it('verifies exact content and rejects stale or modified output without deleting the file', () => {
    const roots = createTempRoots();
    const tool = createWriteTextFileTool({ guard: roots.guard });
    const content = 'verified content';
    const args = { root: 'workspace', relativePath: 'verify.txt', content };
    const absolutePath = path.join(roots.workspace, 'verify.txt');

    try {
      writeFileSync(absolutePath, content, 'utf8');
      const output = {
        root: 'workspace',
        relativePath: 'verify.txt',
        absolutePath,
        type: 'file',
        encoding: 'utf-8',
        bytesWritten: Buffer.byteLength(content, 'utf8'),
        sha256: sha256(content),
        created: true,
        verificationStatus: 'verified',
      };

      expect(tool.verify?.(args, output, createContext())).toBe(true);
      expect(tool.verify?.({ ...args, content: 'different' }, output, createContext())).toBe(false);
      expect(tool.verify?.(args, { ...output, sha256: 'wrong' }, createContext())).toBe(false);
      expect(
        tool.verify?.(
          args,
          { ...output, absolutePath: path.join(roots.workspace, 'other.txt') },
          createContext(),
        ),
      ).toBe(false);

      writeFileSync(absolutePath, 'tampered', 'utf8');

      expect(tool.verify?.(args, output, createContext())).toBe(false);
      expect(existsSync(absolutePath)).toBe(true);
      expect(readFileSync(absolutePath, 'utf8')).toBe('tampered');
    } finally {
      roots.cleanup();
    }
  });
});
