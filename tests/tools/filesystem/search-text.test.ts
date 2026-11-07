import path from 'node:path';

import { describe, expect, it } from 'vitest';

import type { ToolDefinition } from '../../../src/core/tool-registry.js';
import {
  FilesystemError,
  type FilesystemErrorCode,
} from '../../../src/tools/filesystem/path-guard.js';
import { createSearchTextTool } from '../../../src/tools/filesystem/search-text.js';
import {
  SEARCH_TEXT_MAX_EXCERPT_CHARACTERS,
  SEARCH_TEXT_MAX_FILES,
  SEARCH_TEXT_MAX_MATCHES,
} from '../../../src/tools/filesystem/types.js';
import {
  asArray,
  asRecord,
  createContext,
  createDirectoryLink,
  createTempRoots,
  writeBinary,
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

function matches(output: Record<string, unknown>): Record<string, unknown>[] {
  return asArray(output.matches).map(asRecord);
}

describe('search_text tool', () => {
  it('finds literal text with real line numbers and file paths', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'a.txt', 'alpha\nbeta\nALPHA\nalpha again\n');
      writeText(roots.workspace, 'b.md', 'markdown alpha\n');
      writeText(roots.workspace, 'sub/c.txt', 'nested alpha\n');
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'alpha' });
      const found = matches(output);

      expect(output).toMatchObject({
        root: 'workspace',
        relativePath: '',
        query: 'alpha',
        matchCount: 4,
        maxMatches: SEARCH_TEXT_MAX_MATCHES,
        filesInspected: 3,
        complete: true,
        verificationStatus: 'verified',
      });
      expect(found.map((match) => [match.relativePath, match.lineNumber])).toEqual([
        ['a.txt', 1],
        ['a.txt', 4],
        ['b.md', 1],
        ['sub\\c.txt', 1],
      ]);
      expect(found.every((match) => typeof match.absolutePath === 'string')).toBe(true);
      expect(found.every((match) => typeof match.excerpt === 'string')).toBe(true);
    } finally {
      roots.cleanup();
    }
  });

  it('applies optional extension filters', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'a.txt', 'alpha\n');
      writeText(roots.workspace, 'b.md', 'alpha\n');
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, {
        root: 'workspace',
        relativePath: '',
        query: 'alpha',
        extensions: ['md'],
      });

      expect(output.extensions).toEqual(['.md']);
      expect(output.filesInspected).toBe(1);
      expect(matches(output).map((match) => match.relativePath)).toEqual(['b.md']);
    } finally {
      roots.cleanup();
    }
  });

  it('limits excerpt length around a long matching line', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'long.txt', `${'x'.repeat(500)}NEEDLE${'y'.repeat(500)}\n`);
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'NEEDLE' });
      const [match] = matches(output);
      const excerpt = String(match?.excerpt);

      expect(excerpt).toContain('NEEDLE');
      expect(excerpt.length).toBeLessThanOrEqual(SEARCH_TEXT_MAX_EXCERPT_CHARACTERS);
    } finally {
      roots.cleanup();
    }
  });

  it('skips binary and credential-like files', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'safe.txt', 'alpha\n');
      writeBinary(roots.workspace, 'binary.bin', Buffer.from([0x61, 0x00, 0x62]));
      writeText(roots.workspace, '.env', 'alpha=secret\n');
      writeText(roots.workspace, 'keys/id_rsa', 'alpha private\n');
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'alpha' });

      expect(output.matchCount).toBe(1);
      expect(matches(output)[0]?.relativePath).toBe('safe.txt');
      expect(asRecord(output.skipped)).toMatchObject({
        binaryFiles: 1,
        sensitiveFiles: 2,
      });
      expect(output.complete).toBe(true);
    } finally {
      roots.cleanup();
    }
  });

  it('skips files larger than the search size limit', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'safe.txt', 'alpha\n');
      writeBinary(roots.workspace, 'big.txt', Buffer.alloc(256 * 1024 + 1, 0x61));
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'alpha' });

      expect(output.matchCount).toBe(1);
      expect(asRecord(output.skipped)).toMatchObject({ oversizedFiles: 1 });
    } finally {
      roots.cleanup();
    }
  });

  it('respects the recursion depth limit and reports it', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'deep/1/2/3/4/deep.txt', 'alpha\n');
      writeText(roots.workspace, 'deep/1/2/3/4/5/too-deep.txt', 'alpha\n');
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'alpha' });

      expect(output.matchCount).toBe(1);
      expect(matches(output)[0]?.relativePath).toBe('deep\\1\\2\\3\\4\\deep.txt');
      expect(asRecord(output.truncated)).toMatchObject({ depth: true });
      expect(output.complete).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('truncates at the match limit and never claims completion', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'many.txt', 'alpha\n'.repeat(SEARCH_TEXT_MAX_MATCHES + 10));
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'alpha' });

      expect(output.matchCount).toBe(SEARCH_TEXT_MAX_MATCHES);
      expect(asRecord(output.truncated)).toMatchObject({ matches: true });
      expect(output.complete).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('truncates at the inspected-file limit and never claims completion', () => {
    const roots = createTempRoots();

    try {
      for (let index = 0; index < SEARCH_TEXT_MAX_FILES + 5; index += 1) {
        writeText(
          roots.workspace,
          `files/file-${String(index).padStart(3, '0')}.txt`,
          'nothing here',
        );
      }

      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'alpha' });

      expect(output.filesInspected).toBe(SEARCH_TEXT_MAX_FILES);
      expect(asRecord(output.truncated)).toMatchObject({ files: true });
      expect(output.complete).toBe(false);
    } finally {
      roots.cleanup();
    }
  });

  it('never follows junctions into unapproved directories', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.outside, 'secret.txt', 'alpha OUTSIDE_SECRET\n');
      writeText(roots.workspace, 'safe.txt', 'alpha\n');
      createDirectoryLink(roots.outside, path.join(roots.workspace, 'escape'));
      const tool = createSearchTextTool({ guard: roots.guard });
      const output = execute(tool, { root: 'workspace', relativePath: '', query: 'alpha' });
      const found = matches(output);

      expect(output.matchCount).toBe(1);
      expect(found[0]?.relativePath).toBe('safe.txt');
      expect(asRecord(output.skipped)).toMatchObject({ symlinks: 1 });
      expect(JSON.stringify(output)).not.toContain('OUTSIDE_SECRET');
    } finally {
      roots.cleanup();
    }
  });

  it('rejects missing directories, files, and unsafe paths', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'file.txt', 'alpha\n');
      const tool = createSearchTextTool({ guard: roots.guard });

      expectErrorCode(
        () =>
          tool.execute(
            { root: 'workspace', relativePath: 'missing', query: 'alpha' },
            createContext(),
          ),
        'not_found',
      );
      expectErrorCode(
        () =>
          tool.execute(
            { root: 'workspace', relativePath: 'file.txt', query: 'alpha' },
            createContext(),
          ),
        'not_a_directory',
      );
      expectErrorCode(
        () =>
          tool.execute({ root: 'workspace', relativePath: '..', query: 'alpha' }, createContext()),
        'path_traversal',
      );
      expectErrorCode(
        () =>
          tool.execute(
            { root: 'workspace', relativePath: 'C:\\Windows', query: 'alpha' },
            createContext(),
          ),
        'absolute_path',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('verifies real matches and rejects tampered output', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'a.txt', 'alpha\n');
      const tool = createSearchTextTool({ guard: roots.guard });
      const args = { root: 'workspace', relativePath: '', query: 'alpha' };
      const output = execute(tool, args);

      expect(tool.verify?.(args, output, createContext())).toBe(true);

      const tampered = {
        ...output,
        matches: [
          {
            relativePath: '..\\outside\\secret.txt',
            absolutePath: path.join(roots.outside, 'secret.txt'),
            lineNumber: 1,
            excerpt: 'alpha',
          },
        ],
        matchCount: 1,
      };

      expect(tool.verify?.(args, tampered, createContext())).toBe(false);
    } finally {
      roots.cleanup();
    }
  });
});
