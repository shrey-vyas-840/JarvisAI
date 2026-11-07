import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '../../../src/core/tool-registry.js';
import {
  FilesystemError,
  type FilesystemErrorCode,
} from '../../../src/tools/filesystem/path-guard.js';
import { createGetFileInfoTool } from '../../../src/tools/filesystem/get-file-info.js';
import {
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

describe('get_file_info tool', () => {
  it('returns file metadata without contents', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'Reports/summary.txt', 'metadata only');
      const tool = createGetFileInfoTool({ guard: roots.guard });
      const output = execute(tool, {
        root: 'workspace',
        relativePath: 'Reports/summary.txt',
      });

      expect(output).toMatchObject({
        root: 'workspace',
        relativePath: 'Reports\\summary.txt',
        absolutePath: path.join(roots.workspace, 'Reports', 'summary.txt'),
        name: 'summary.txt',
        type: 'file',
        sizeBytes: 13,
        verificationStatus: 'verified',
      });
      expect(typeof output.createdAt === 'string' || output.createdAt === null).toBe(true);
      expect(typeof output.modifiedAt).toBe('string');
      expect(typeof output.readOnly === 'boolean' || output.readOnly === null).toBe(true);
      expect(output).not.toHaveProperty('content');
    } finally {
      roots.cleanup();
    }
  });

  it('returns directory metadata, including the workspace root', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'sub/file.txt', 'text');
      const tool = createGetFileInfoTool({ guard: roots.guard });
      const rootOutput = execute(tool, { root: 'workspace', relativePath: '' });
      const subOutput = execute(tool, { root: 'workspace', relativePath: 'sub' });

      expect(rootOutput).toMatchObject({
        relativePath: '',
        absolutePath: roots.workspace,
        name: 'workspace',
        type: 'directory',
        sizeBytes: null,
      });
      expect(subOutput).toMatchObject({
        relativePath: 'sub',
        name: 'sub',
        type: 'directory',
        sizeBytes: null,
      });
    } finally {
      roots.cleanup();
    }
  });

  it('rejects missing paths, links, and unsafe paths', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.outside, 'secret.txt', 'outside');
      createDirectoryLink(roots.outside, path.join(roots.workspace, 'escape'));
      const tool = createGetFileInfoTool({ guard: roots.guard });

      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'missing.txt' }, createContext()),
        'not_found',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'escape' }, createContext()),
        'symlink_rejected',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: '../escape.txt' }, createContext()),
        'path_traversal',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'C:\\Windows' }, createContext()),
        'absolute_path',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('verifies real metadata and rejects tampered output', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'file.txt', 'text');
      const tool = createGetFileInfoTool({ guard: roots.guard });
      const args = { root: 'workspace', relativePath: 'file.txt' };
      const output = execute(tool, args);

      expect(tool.verify?.(args, output, createContext())).toBe(true);
      expect(tool.verify?.(args, { ...output, type: 'directory' }, createContext())).toBe(false);
      expect(tool.verify?.(args, { ...output, absolutePath: roots.outside }, createContext())).toBe(
        false,
      );
    } finally {
      roots.cleanup();
    }
  });
});
