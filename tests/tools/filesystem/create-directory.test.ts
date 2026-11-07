import { existsSync, mkdirSync, rmdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../../src/core/tool-registry.js';
import type { ApprovalOutcome } from '../../../src/security/approval-types.js';
import { createCreateDirectoryTool } from '../../../src/tools/filesystem/create-directory.js';
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

  registry.register(createCreateDirectoryTool({ guard: roots.guard }));

  return { roots, provider, registry };
}

describe('create_directory', () => {
  it('creates one directory only after approval and verifies the real result', async () => {
    const { roots, provider, registry } = setup('approved');

    try {
      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: 'notes' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        toolName: 'create_directory',
        status: 'success',
        approval: 'approved',
        verification: 'verified',
        error: null,
        result: {
          root: 'workspace',
          relativePath: 'notes',
          absolutePath: path.join(roots.workspace, 'notes'),
          type: 'directory',
          created: true,
          verificationStatus: 'verified',
        },
      });
      expect(existsSync(path.join(roots.workspace, 'notes'))).toBe(true);
      expect(provider.requests).toHaveLength(1);
      expect(provider.requests[0]).toMatchObject({
        toolName: 'create_directory',
        operation: 'Create new directory',
        root: 'workspace',
        relativePath: 'notes',
        absolutePath: path.join(roots.workspace, 'notes'),
      });
    } finally {
      roots.cleanup();
    }
  });

  it('rejects an existing directory before asking for approval', async () => {
    const { roots, provider, registry } = setup();

    try {
      mkdirSync(path.join(roots.workspace, 'existing'));

      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: 'existing' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'required',
        verification: 'not_applicable',
      });
      expect(receipt.error).toContain('already_exists');
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects an existing file before asking for approval', async () => {
    const { roots, provider, registry } = setup();

    try {
      writeFileSync(path.join(roots.workspace, 'existing.txt'), 'keep me');

      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: 'existing.txt' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'required',
      });
      expect(receipt.error).toContain('already_exists');
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it('does not create missing parents recursively', async () => {
    const { roots, provider, registry } = setup();

    try {
      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: 'missing/child' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'required',
      });
      expect(receipt.error).toContain('not_found');
      expect(receipt.error).toContain('Parent directory does not exist');
      expect(provider.requests).toHaveLength(0);
      expect(existsSync(path.join(roots.workspace, 'missing'))).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it.each([
    ['../outside', 'path_traversal'],
    ['..\\outside', 'path_traversal'],
    ['D:\\AI\\JarvisWorkspace\\absolute', 'absolute_path'],
    ['\\\\server\\share', 'unc_path'],
  ])('rejects unsafe path %j with %s before approval', async (relativePath, code) => {
    const { roots, provider, registry } = setup();

    try {
      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath },
        createContext(),
      );

      expect(receipt).toMatchObject({ status: 'failure', approval: 'required' });
      expect(receipt.error).toContain(code);
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects creation through a junction or symlink', async () => {
    const { roots, provider, registry } = setup();

    try {
      createDirectoryLink(roots.outside, path.join(roots.workspace, 'escape'));

      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: 'escape/child' },
        createContext(),
      );

      expect(receipt).toMatchObject({ status: 'failure', approval: 'required' });
      expect(receipt.error).toContain('symlink_rejected');
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects sensitive locations before approval', async () => {
    const { roots, provider, registry } = setup();

    try {
      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: '.ssh' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'required',
      });
      expect(receipt.error).toContain('sensitive_file');
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it.each(['denied', 'unavailable', 'cancelled'] as const)(
    'does not create a directory when approval is %s',
    async (outcome) => {
      const roots = createTempRoots();
      const provider = new FakeApprovalProvider(outcome);
      const registry = new ToolRegistry({ approvalProvider: provider });
      registry.register(createCreateDirectoryTool({ guard: roots.guard }));

      try {
        const receipt = await registry.execute(
          'create_directory',
          { root: 'workspace', relativePath: 'refused' },
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
        expect(existsSync(path.join(roots.workspace, 'refused'))).toBe(false);
      } finally {
        roots.cleanup();
      }
    },
  );

  it('fails when no approval provider is configured', async () => {
    const roots = createTempRoots();
    const registry = new ToolRegistry();
    registry.register(createCreateDirectoryTool({ guard: roots.guard }));

    try {
      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: 'no-provider' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'approval_unavailable',
        approval: 'unavailable',
        error: 'Approval provider is unavailable',
        result: null,
      });
      expect(existsSync(path.join(roots.workspace, 'no-provider'))).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects invalid arguments without executing or asking for approval', async () => {
    const { roots, provider, registry } = setup();

    try {
      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace' },
        createContext(),
      );

      expect(receipt).toMatchObject({
        status: 'failure',
        approval: 'not_required',
      });
      expect(receipt.error).toContain('Invalid arguments');
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });

  it('verifies the actual directory and rejects stale output', () => {
    const roots = createTempRoots();
    const tool = createCreateDirectoryTool({ guard: roots.guard });
    const args = { root: 'workspace', relativePath: 'verified' };

    try {
      mkdirSync(path.join(roots.workspace, 'verified'));
      const output = {
        root: 'workspace',
        relativePath: 'verified',
        absolutePath: path.join(roots.workspace, 'verified'),
        type: 'directory',
        created: true,
        verificationStatus: 'verified',
      };

      expect(tool.verify?.(args, output, createContext())).toBe(true);

      rmdirSync(path.join(roots.workspace, 'verified'));

      expect(tool.verify?.(args, output, createContext())).toBe(false);
      expect(
        tool.verify?.(
          args,
          { ...output, absolutePath: path.join(roots.workspace, 'elsewhere') },
          createContext(),
        ),
      ).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects recursive-looking absolute paths outside the approved root', async () => {
    const { roots, provider, registry } = setup();

    try {
      writeText(roots.outside, 'secret.txt', 'outside');

      const receipt = await registry.execute(
        'create_directory',
        { root: 'workspace', relativePath: '..\\outside\\child' },
        createContext(),
      );

      expect(receipt).toMatchObject({ status: 'failure', approval: 'required' });
      expect(receipt.error).toContain('path_traversal');
      expect(provider.requests).toHaveLength(0);
    } finally {
      roots.cleanup();
    }
  });
});
