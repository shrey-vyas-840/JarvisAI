import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '../../../src/core/tool-registry.js';
import {
  FilesystemError,
  type FilesystemErrorCode,
} from '../../../src/tools/filesystem/path-guard.js';
import { createReadTextFileTool } from '../../../src/tools/filesystem/read-text-file.js';
import {
  READ_TEXT_FILE_MAX_BYTES,
  READ_TEXT_FILE_MAX_CHARACTERS,
} from '../../../src/tools/filesystem/types.js';
import { asRecord, createContext, createTempRoots, writeBinary, writeText } from './helpers.js';

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

describe('read_text_file tool', () => {
  it('reads a real UTF-8 text file', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'Reports/summary.txt', 'Hello, JARVIS.\nSecond line.');
      const tool = createReadTextFileTool({ guard: roots.guard });
      const output = execute(tool, {
        root: 'workspace',
        relativePath: 'Reports/summary.txt',
      });

      expect(output).toMatchObject({
        root: 'workspace',
        relativePath: 'Reports\\summary.txt',
        encoding: 'utf-8',
        content: 'Hello, JARVIS.\nSecond line.',
        sizeBytes: 27,
        returnedCharacters: 27,
        totalCharacters: 27,
        maxCharacters: READ_TEXT_FILE_MAX_CHARACTERS,
        truncated: false,
        verificationStatus: 'verified',
      });
    } finally {
      roots.cleanup();
    }
  });

  it('reads an empty file', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'empty.txt', '');
      const tool = createReadTextFileTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: 'empty.txt' });

      expect(output).toMatchObject({
        content: '',
        sizeBytes: 0,
        returnedCharacters: 0,
        totalCharacters: 0,
        truncated: false,
      });
    } finally {
      roots.cleanup();
    }
  });

  it('reads UTF-8 multibyte text with correct byte and character counts', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'utf8.txt', 'héllo 世界');
      const tool = createReadTextFileTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: 'utf8.txt' });

      expect(output.content).toBe('héllo 世界');
      expect(output.totalCharacters).toBe('héllo 世界'.length);
      expect(output.sizeBytes).toBe(Buffer.byteLength('héllo 世界', 'utf8'));
    } finally {
      roots.cleanup();
    }
  });

  it('truncates oversized output and reports it accurately', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'large.txt', 'a'.repeat(READ_TEXT_FILE_MAX_CHARACTERS + 1));
      const tool = createReadTextFileTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: 'large.txt' });

      expect(output).toMatchObject({
        returnedCharacters: READ_TEXT_FILE_MAX_CHARACTERS,
        totalCharacters: READ_TEXT_FILE_MAX_CHARACTERS + 1,
        truncated: true,
      });
      expect(String(output.content)).toHaveLength(READ_TEXT_FILE_MAX_CHARACTERS);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects files larger than the read limit', () => {
    const roots = createTempRoots();

    try {
      writeBinary(
        roots.workspace,
        'too-large.txt',
        Buffer.alloc(READ_TEXT_FILE_MAX_BYTES + 1, 0x61),
      );
      const tool = createReadTextFileTool({ guard: roots.guard });

      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'too-large.txt' }, createContext()),
        'file_too_large',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('rejects binary content and invalid UTF-8', () => {
    const roots = createTempRoots();

    try {
      writeBinary(roots.workspace, 'binary.bin', Buffer.from([0x61, 0x00, 0x62]));
      writeBinary(roots.workspace, 'invalid.txt', Buffer.from([0xc3, 0x28]));
      const tool = createReadTextFileTool({ guard: roots.guard });

      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'binary.bin' }, createContext()),
        'binary_file',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'invalid.txt' }, createContext()),
        'unsupported_encoding',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('rejects credential-like files', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, '.env', 'API_KEY=secret');
      writeText(roots.workspace, 'keys/id_rsa', 'private');
      const tool = createReadTextFileTool({ guard: roots.guard });

      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: '.env' }, createContext()),
        'sensitive_file',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'keys/id_rsa' }, createContext()),
        'sensitive_file',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('rejects missing files, directories, and unsafe paths', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'dir/file.txt', 'text');
      const tool = createReadTextFileTool({ guard: roots.guard });

      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'missing.txt' }, createContext()),
        'not_found',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: 'dir' }, createContext()),
        'not_a_file',
      );
      expectErrorCode(
        () => tool.execute({ root: 'workspace', relativePath: '..\\escape.txt' }, createContext()),
        'path_traversal',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('verifies a real read and rejects tampered output', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'file.txt', 'verified content');
      const tool = createReadTextFileTool({ guard: roots.guard });
      const args = { root: 'workspace', relativePath: 'file.txt' };
      const output = execute(tool, args);

      expect(tool.verify?.(args, output, createContext())).toBe(true);
      expect(tool.verify?.(args, { ...output, content: 'tampered' }, createContext())).toBe(false);
      expect(tool.verify?.(args, { ...output, truncated: true }, createContext())).toBe(false);
    } finally {
      roots.cleanup();
    }
  });
});
