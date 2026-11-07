import { mkdirSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '../../../src/core/tool-registry.js';
import {
  FilesystemError,
  type FilesystemErrorCode,
} from '../../../src/tools/filesystem/path-guard.js';
import { createListDirectoryTool } from '../../../src/tools/filesystem/list-directory.js';
import {
  asArray,
  asRecord,
  createContext,
  createDirectoryLink,
  createTempRoots,
  writeText,
} from './helpers.js';

function expectErrorCode(action: () => unknown, code: FilesystemErrorCode): void {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(FilesystemError);
    expect((error as FilesystemError).code).toBe(code);
    return;
  }

  throw new Error(`Expected a FilesystemError with code ${code}`);
}

function execute(tool: ToolDefinition, args: Record<string, unknown>): Record<string, unknown> {
  return asRecord(tool.execute(args, createContext()));
}

describe('list_directory tool', () => {
  it('lists files and directories with deterministic sorting and safe metadata', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'a.txt', 'a');
      writeText(roots.workspace, 'B.txt', 'bb');
      writeText(roots.workspace, 'sub/nested.txt', 'nested');
      writeText(roots.workspace, 'empty/.keep', '');

      const tool = createListDirectoryTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '' });
      const entries = asArray(output.entries).map(asRecord);

      expect(output).toMatchObject({
        root: 'workspace',
        relativePath: '',
        absolutePath: roots.workspace,
        entryCount: 4,
        totalEntries: 4,
        limit: 200,
        truncated: false,
        verificationStatus: 'verified',
      });
      expect(entries.map((entry) => entry.name)).toEqual(['a.txt', 'B.txt', 'empty', 'sub']);
      expect(entries.map((entry) => entry.type)).toEqual([
        'file',
        'file',
        'directory',
        'directory',
      ]);
      expect(entries[0]).toMatchObject({ sizeBytes: 1, skipped: false });
      expect(entries[2]).toMatchObject({ sizeBytes: null, skipped: false });

      const secondOutput = execute(tool, { root: 'workspace', relativePath: '' });

      expect(secondOutput.entries).toEqual(output.entries);
    } finally {
      roots.cleanup();
    }
  });

  it('supports an empty directory', () => {
    const roots = createTempRoots();

    try {
      mkdirSync(path.join(roots.workspace, 'empty'));
      const tool = createListDirectoryTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: 'empty' });

      expect(output).toMatchObject({
        relativePath: 'empty',
        entryCount: 0,
        totalEntries: 0,
        truncated: false,
      });
      expect(output.entries).toEqual([]);
    } finally {
      roots.cleanup();
    }
  });

  it('truncates large directories explicitly', () => {
    const roots = createTempRoots();

    try {
      for (let index = 0; index < 5; index += 1) {
        writeText(roots.workspace, `file-${String(index)}.txt`, 'x');
      }

      const tool = createListDirectoryTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', limit: 2 });

      expect(output).toMatchObject({
        entryCount: 2,
        totalEntries: 5,
        limit: 2,
        truncated: true,
      });
      expect(asArray(output.entries).map((entry) => asRecord(entry).name)).toEqual([
        'file-0.txt',
        'file-1.txt',
      ]);
    } finally {
      roots.cleanup();
    }
  });

  it('reports symbolic links without following them', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.outside, 'secret.txt', 'OUTSIDE_SECRET');
      createDirectoryLink(roots.outside, path.join(roots.workspace, 'escape'));
      writeText(roots.workspace, 'inside.txt', 'inside');

      const tool = createListDirectoryTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '' });
      const entries = asArray(output.entries).map(asRecord);
      const link = entries.find((entry) => entry.name === 'escape');

      expect(link).toMatchObject({
        name: 'escape',
        type: 'symlink',
        skipped: true,
        sizeBytes: null,
        lastModified: null,
      });
    } finally {
      roots.cleanup();
    }
  });

  it('rejects missing, non-directory, and unsafe paths', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'file.txt', 'text');
      const tool = createListDirectoryTool({ guard: roots.guard });

      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'missing' }, createContext()),
        'not_found',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'file.txt' }, createContext()),
        'not_a_directory',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: '..' }, createContext()),
        'path_traversal',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('verifies a real listing and rejects tampered output', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'file.txt', 'text');
      const tool = createListDirectoryTool({ guard: roots.guard });
      const args = { root: 'workspace', relativePath: '' };
      const output = execute(tool, args);

      expect(tool.verify?.(args, output, createContext())).toBe(true);

      const tampered = { ...output, absolutePath: roots.outside };

      expect(tool.verify?.(args, tampered, createContext())).toBe(false);
      expect(tool.verify?.(args, { entries: [] }, createContext())).toBe(false);
    } finally {
      roots.cleanup();
    }
  });
});
