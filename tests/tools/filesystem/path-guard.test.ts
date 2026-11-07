import { rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FilesystemError,
  PathGuard,
  isPathWithin,
  type FilesystemErrorCode,
} from '../../../src/tools/filesystem/path-guard.js';
import { createDirectoryLink, createTempRoots, writeText } from './helpers.js';

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

describe('PathGuard', () => {
  it('resolves valid workspace and exports paths', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'Reports/summary.txt', 'workspace summary');
      writeText(roots.exports, 'export.txt', 'exported data');

      const workspaceFile = roots.guard.resolve('workspace', 'Reports/summary.txt');
      const exportsFile = roots.guard.resolve('exports', 'export.txt');

      expect(workspaceFile).toMatchObject({
        rootId: 'workspace',
        rootPath: roots.workspace,
        relativePath: 'Reports\\summary.txt',
        exists: true,
      });
      expect(workspaceFile.absolutePath).toBe(path.join(roots.workspace, 'Reports', 'summary.txt'));
      expect(exportsFile).toMatchObject({
        rootId: 'exports',
        rootPath: roots.exports,
        relativePath: 'export.txt',
        exists: true,
      });
    } finally {
      roots.cleanup();
    }
  });

  it('allows an empty relative path for directory-root operations', () => {
    const roots = createTempRoots();

    try {
      const resolved = roots.guard.resolve('workspace', '');

      expect(resolved.rootId).toBe('workspace');
      expect(resolved.absolutePath).toBe(roots.workspace);
      expect(resolved.relativePath).toBe('');
      expect(resolved.exists).toBe(true);
      expect(resolved.stats?.isDirectory()).toBe(true);
    } finally {
      roots.cleanup();
    }
  });

  it('accepts forward slashes and resolves case-insensitively on Windows', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'Reports/Summary.txt', 'case test');

      const resolved = roots.guard.resolve('workspace', 'reports/summary.TXT');

      expect(resolved.exists).toBe(true);
      expect(resolved.relativePath).toBe('Reports\\Summary.txt');
      expect(isPathWithin(roots.workspace.toUpperCase(), resolved.absolutePath)).toBe(true);
    } finally {
      roots.cleanup();
    }
  });

  it('rejects parent-directory traversal', () => {
    const roots = createTempRoots();

    try {
      expectErrorCode(() => roots.guard.resolve('workspace', '..'), 'path_traversal');
      expectErrorCode(() => roots.guard.resolve('workspace', '../escape.txt'), 'path_traversal');
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'Reports/../../escape.txt'),
        'path_traversal',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'Reports\\..\\..\\escape.txt'),
        'path_traversal',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('rejects absolute paths, drive changes, UNC paths, and device paths', () => {
    const roots = createTempRoots();

    try {
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'C:\\Windows\\win.ini'),
        'absolute_path',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'D:\\AI\\JarvisAgent\\package.json'),
        'absolute_path',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', '\\Windows\\win.ini'),
        'absolute_path',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', '\\\\server\\share\\secret.txt'),
        'unc_path',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', '//server/share/secret.txt'),
        'unc_path',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', '\\\\.\\C:\\secret.txt'),
        'device_path',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', '\\\\?\\C:\\secret.txt'),
        'device_path',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('rejects alternate data streams and ambiguous Windows components', () => {
    const roots = createTempRoots();

    try {
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'file.txt:secret'),
        'alternate_data_stream',
      );
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'Reports/file.txt:stream'),
        'alternate_data_stream',
      );
      expectErrorCode(() => roots.guard.resolve('workspace', 'a//b'), 'invalid_path');
      expectErrorCode(() => roots.guard.resolve('workspace', 'a/'), 'invalid_path');
      expectErrorCode(() => roots.guard.resolve('workspace', './a'), 'invalid_component');
      expectErrorCode(() => roots.guard.resolve('workspace', 'bad<name'), 'invalid_component');
      expectErrorCode(() => roots.guard.resolve('workspace', 'name.'), 'invalid_component');
      expectErrorCode(() => roots.guard.resolve('workspace', ' name'), 'invalid_component');
      expectErrorCode(() => roots.guard.resolve('workspace', 'CON'), 'device_path');
      expectErrorCode(() => roots.guard.resolve('workspace', 'con.txt'), 'device_path');
      expectErrorCode(() => roots.guard.resolve('workspace', 'a\0b'), 'invalid_path');
    } finally {
      roots.cleanup();
    }
  });

  it('rejects nonexistent, non-directory, and symbolic-link roots', () => {
    const roots = createTempRoots();

    try {
      const missingRoot = path.join(roots.base, 'missing-root');
      expectErrorCode(
        () =>
          new PathGuard({ workspace: missingRoot, exports: roots.exports }).resolve(
            'workspace',
            '',
          ),
        'root_unavailable',
      );

      const fileRoot = writeText(roots.base, 'file-root.txt', 'not a directory');
      expectErrorCode(
        () =>
          new PathGuard({ workspace: fileRoot, exports: roots.exports }).resolve('workspace', ''),
        'root_unavailable',
      );

      const linkedRoot = path.join(roots.base, 'linked-root');
      createDirectoryLink(roots.workspace, linkedRoot);
      expectErrorCode(
        () =>
          new PathGuard({ workspace: linkedRoot, exports: roots.exports }).resolve('workspace', ''),
        'symlink_rejected',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('rejects junctions inside a root and never follows them', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.outside, 'secret.txt', 'OUTSIDE_SECRET');
      const junction = path.join(roots.workspace, 'escape');
      createDirectoryLink(roots.outside, junction);

      expectErrorCode(() => roots.guard.resolve('workspace', 'escape'), 'symlink_rejected');
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'escape/secret.txt'),
        'symlink_rejected',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('rejects symbolic links that exist safely inside a root', () => {
    const roots = createTempRoots();

    try {
      writeText(roots.workspace, 'inside/target.txt', 'inside');
      const link = path.join(roots.workspace, 'inside-link');
      createDirectoryLink(path.join(roots.workspace, 'inside'), link);

      expectErrorCode(() => roots.guard.resolve('workspace', 'inside-link'), 'symlink_rejected');
      expectErrorCode(
        () => roots.guard.resolve('workspace', 'inside-link/target.txt'),
        'symlink_rejected',
      );
    } finally {
      roots.cleanup();
    }
  });

  it('revalidates a resolved target after it changes', () => {
    const roots = createTempRoots();

    try {
      const filePath = writeText(roots.workspace, 'swap.txt', 'initial');
      const resolved = roots.guard.resolve('workspace', 'swap.txt');

      expect(resolved.exists).toBe(true);
      expect(() => {
        roots.guard.assertSafe(resolved);
      }).not.toThrow();

      rmSync(filePath, { force: true });
      createDirectoryLink(roots.outside, filePath);

      expectErrorCode(() => {
        roots.guard.assertSafe(resolved);
      }, 'symlink_rejected');
    } finally {
      roots.cleanup();
    }
  });

  it('rejects unknown root identifiers', () => {
    const roots = createTempRoots();

    try {
      expectErrorCode(() => roots.guard.resolve('temp', 'file.txt'), 'invalid_root');
      expectErrorCode(() => roots.guard.resolve('Workspace', 'file.txt'), 'invalid_root');
    } finally {
      roots.cleanup();
    }
  });

  it('does not let a sibling directory pass the containment check', () => {
    const roots = createTempRoots();

    try {
      writeFileSync(path.join(roots.base, 'workspace-evil.txt'), 'outside', 'utf8');

      expect(isPathWithin(roots.workspace, path.join(roots.base, 'workspace-evil.txt'))).toBe(
        false,
      );
    } finally {
      roots.cleanup();
    }
  });
});
