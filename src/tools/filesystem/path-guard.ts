import { lstatSync, realpathSync, type Stats } from 'node:fs';
import path from 'node:path';

export const ROOT_IDS = ['workspace', 'exports'] as const;
export type RootId = (typeof ROOT_IDS)[number];

export type FilesystemErrorCode =
  | 'invalid_root'
  | 'invalid_path'
  | 'path_traversal'
  | 'absolute_path'
  | 'unc_path'
  | 'device_path'
  | 'alternate_data_stream'
  | 'invalid_component'
  | 'root_unavailable'
  | 'outside_root'
  | 'symlink_rejected'
  | 'not_found'
  | 'not_a_file'
  | 'not_a_directory'
  | 'permission_denied'
  | 'file_too_large'
  | 'unsupported_encoding'
  | 'binary_file'
  | 'sensitive_file'
  | 'unreadable';

export class FilesystemError extends Error {
  public readonly code: FilesystemErrorCode;

  public constructor(code: FilesystemErrorCode, detail: string) {
    super(`${code}: ${detail}`);
    this.name = 'FilesystemError';
    this.code = code;
  }
}

export interface PathGuardRoots {
  readonly workspace: string;
  readonly exports: string;
}

export interface ResolvedPath {
  readonly rootId: RootId;
  readonly rootPath: string;
  readonly absolutePath: string;
  readonly relativePath: string;
  readonly exists: boolean;
  readonly stats: Stats | null;
}

const INVALID_COMPONENT_CHARACTERS = /[<>:"|?*]/;
const RESERVED_DEVICE_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;
const DRIVE_ROOTED_PATH = /^[A-Za-z]:[\\/]/;
const MAX_RELATIVE_PATH_LENGTH = 1024;
const MAX_COMPONENT_LENGTH = 255;

export class PathGuard {
  private readonly configuredRoots: Record<RootId, string>;

  public constructor(roots: PathGuardRoots) {
    this.configuredRoots = {
      workspace: normalizeConfiguredRoot(roots.workspace, 'workspace'),
      exports: normalizeConfiguredRoot(roots.exports, 'exports'),
    };
  }

  public getConfiguredRoot(rootId: RootId): string {
    return this.configuredRoots[rootId];
  }

  public resolve(rootId: string, relativePath: string): ResolvedPath {
    if (!isRootId(rootId)) {
      throw new FilesystemError('invalid_root', 'Unknown root identifier');
    }

    if (typeof relativePath !== 'string') {
      throw new FilesystemError('invalid_path', 'Path must be a string');
    }

    const normalizedRelative = validateRelativePath(relativePath);
    const rootLexical = this.configuredRoots[rootId];
    const rootStats = lstatOrNull(rootLexical);

    if (rootStats === null) {
      throw new FilesystemError('root_unavailable', `Approved root "${rootId}" is not available`);
    }

    if (rootStats.isSymbolicLink()) {
      throw new FilesystemError(
        'symlink_rejected',
        'Approved roots may not be symbolic links or junctions',
      );
    }

    if (!rootStats.isDirectory()) {
      throw new FilesystemError('root_unavailable', `Approved root "${rootId}" is not a directory`);
    }

    const rootReal = realpathOrThrow(rootLexical, 'root_unavailable');
    const candidate =
      normalizedRelative.length === 0 ? rootReal : path.win32.join(rootReal, normalizedRelative);

    if (!isPathWithin(rootReal, candidate)) {
      throw new FilesystemError('outside_root', 'Requested path is outside the approved root');
    }

    this.inspectComponents(rootReal, normalizedRelative);

    const targetStats = lstatOrNull(candidate);

    if (targetStats?.isSymbolicLink()) {
      throw new FilesystemError('symlink_rejected', 'Symbolic links and junctions are not allowed');
    }

    let absolutePath = candidate;

    if (targetStats !== null) {
      const realTarget = realpathOrThrow(candidate, 'unreadable');

      if (!isPathWithin(rootReal, realTarget)) {
        throw new FilesystemError('outside_root', 'Resolved path escapes the approved root');
      }

      absolutePath = realTarget;
    }

    if (!isPathWithin(rootReal, absolutePath)) {
      throw new FilesystemError('outside_root', 'Requested path is outside the approved root');
    }

    const relative = path.win32.relative(rootReal, absolutePath);

    return {
      rootId,
      rootPath: rootReal,
      absolutePath,
      relativePath: relative,
      exists: targetStats !== null,
      stats: targetStats,
    };
  }

  /**
   * Revalidate a previously resolved path immediately before use. This catches
   * a path that changed between resolution and access, including link swaps.
   */
  public assertSafe(resolved: ResolvedPath): void {
    if (!isPathWithin(resolved.rootPath, resolved.absolutePath)) {
      throw new FilesystemError('outside_root', 'Requested path is outside the approved root');
    }

    this.inspectComponents(resolved.rootPath, resolved.relativePath);

    if (!resolved.exists) {
      return;
    }

    const stats = lstatOrNull(resolved.absolutePath);

    if (stats === null) {
      throw new FilesystemError('not_found', 'The requested path no longer exists');
    }

    if (stats.isSymbolicLink()) {
      throw new FilesystemError('symlink_rejected', 'Symbolic links and junctions are not allowed');
    }

    const realTarget = realpathOrThrow(resolved.absolutePath, 'unreadable');

    if (!isPathWithin(resolved.rootPath, realTarget)) {
      throw new FilesystemError('outside_root', 'Resolved path escapes the approved root');
    }
  }

  private inspectComponents(root: string, relativePath: string): void {
    if (relativePath.length === 0) {
      return;
    }

    const parts = relativePath.split(path.win32.sep);
    let current = root;

    for (const [index, part] of parts.entries()) {
      current = path.win32.join(current, part);
      const stats = lstatOrNull(current);

      if (stats === null) {
        return;
      }

      if (stats.isSymbolicLink()) {
        throw new FilesystemError(
          'symlink_rejected',
          'Symbolic links and junctions are not allowed',
        );
      }

      if (index < parts.length - 1 && !stats.isDirectory()) {
        throw new FilesystemError('not_a_directory', 'A path component is not a directory');
      }
    }
  }
}

export function isRootId(value: string): value is RootId {
  return (ROOT_IDS as readonly string[]).includes(value);
}

export function isPathWithin(rootPath: string, candidatePath: string): boolean {
  const root = normalizeForComparison(rootPath);
  const candidate = normalizeForComparison(candidatePath);

  return candidate === root || candidate.startsWith(`${root}${path.win32.sep}`);
}

export function toFilesystemError(
  error: unknown,
  fallback: FilesystemErrorCode = 'unreadable',
): FilesystemError {
  if (error instanceof FilesystemError) {
    return error;
  }

  const code = getErrorCode(error);

  if (code === 'ENOENT') {
    return new FilesystemError('not_found', 'The requested path does not exist');
  }

  if (code === 'EACCES' || code === 'EPERM') {
    return new FilesystemError('permission_denied', 'Permission denied');
  }

  if (code === 'ENOTDIR') {
    return new FilesystemError('not_a_directory', 'A path component is not a directory');
  }

  if (code === 'EISDIR') {
    return new FilesystemError('not_a_file', 'The requested path is a directory');
  }

  return new FilesystemError(fallback, 'Filesystem operation failed');
}

function normalizeConfiguredRoot(value: string, rootId: RootId): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new FilesystemError('invalid_root', `Root "${rootId}" is not configured`);
  }

  if (value.includes('\0')) {
    throw new FilesystemError('invalid_root', `Root "${rootId}" contains a null character`);
  }

  const resolved = path.win32.resolve(value);

  if (!DRIVE_ROOTED_PATH.test(resolved)) {
    throw new FilesystemError(
      'invalid_root',
      `Root "${rootId}" must be a drive-rooted local directory`,
    );
  }

  if (resolved.slice(3).includes(':')) {
    throw new FilesystemError(
      'invalid_root',
      `Root "${rootId}" must not contain alternate data streams`,
    );
  }

  return resolved;
}

function validateRelativePath(input: string): string {
  if (input.length > MAX_RELATIVE_PATH_LENGTH) {
    throw new FilesystemError('invalid_path', 'Path is too long');
  }

  if (input.includes('\0')) {
    throw new FilesystemError('invalid_path', 'Path contains a null character');
  }

  if (/^[\\/]{2}[?.][\\/]/.test(input)) {
    throw new FilesystemError('device_path', 'Device paths are not allowed');
  }

  if (/^[\\/]{2}/.test(input)) {
    throw new FilesystemError('unc_path', 'UNC network paths are not allowed');
  }

  if (/^[A-Za-z]:/.test(input)) {
    throw new FilesystemError('absolute_path', 'Absolute drive paths are not allowed');
  }

  if (/^[\\/]/.test(input)) {
    throw new FilesystemError('absolute_path', 'Rooted or absolute paths are not allowed');
  }

  if (input.includes(':')) {
    throw new FilesystemError('alternate_data_stream', 'Alternate data streams are not allowed');
  }

  const withBackslashes = input.replace(/\//g, '\\');

  if (withBackslashes.length === 0) {
    return '';
  }

  const parts = withBackslashes.split('\\');

  for (const part of parts) {
    if (part.length === 0) {
      throw new FilesystemError('invalid_path', 'Path contains an empty component');
    }

    if (part === '..') {
      throw new FilesystemError('path_traversal', 'Parent-directory traversal is not allowed');
    }

    if (part === '.') {
      throw new FilesystemError('invalid_component', 'Ambiguous path components are not allowed');
    }

    validateComponent(part);
  }

  return parts.join('\\');
}

function validateComponent(component: string): void {
  if (component.length > MAX_COMPONENT_LENGTH) {
    throw new FilesystemError('invalid_component', 'A path component is too long');
  }

  if (INVALID_COMPONENT_CHARACTERS.test(component) || containsControlCharacter(component)) {
    throw new FilesystemError('invalid_component', 'A path component contains invalid characters');
  }

  if (component !== component.trim()) {
    throw new FilesystemError(
      'invalid_component',
      'Path components with leading or trailing whitespace are not allowed',
    );
  }

  if (/[. ]$/.test(component)) {
    throw new FilesystemError(
      'invalid_component',
      'Path components ending in a dot or space are not allowed',
    );
  }

  if (RESERVED_DEVICE_NAME.test(component)) {
    throw new FilesystemError('device_path', 'Reserved device names are not allowed');
  }
}

function containsControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0);

    if (code !== undefined && (code < 32 || code === 127)) {
      return true;
    }
  }

  return false;
}

function lstatOrNull(target: string): Stats | null {
  try {
    return lstatSync(target);
  } catch (error) {
    if (getErrorCode(error) === 'ENOENT') {
      return null;
    }

    throw toFilesystemError(error);
  }
}

function realpathOrThrow(target: string, fallback: FilesystemErrorCode): string {
  try {
    return realpathSync.native(target);
  } catch (error) {
    throw toFilesystemError(error, fallback);
  }
}

function normalizeForComparison(value: string): string {
  const normalized = path.win32.normalize(path.win32.resolve(value)).toLowerCase();

  return normalized.replace(/[\\/]+$/, '');
}

function getErrorCode(error: unknown): string | null {
  if (typeof error === 'object' && error !== null && 'code' in error) {
    const value = (error as { code?: unknown }).code;

    return typeof value === 'string' ? value : null;
  }

  return null;
}
