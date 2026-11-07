import { lstatSync, readFileSync, readdirSync, type Dirent, type Stats } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import {
  isLikelyBinary,
  isSensitiveDirectoryName,
  isSensitiveFileName,
  isSensitivePath,
  tryDecodeUtf8,
} from './file-safety.js';
import { FilesystemError, ROOT_IDS, isPathWithin } from './path-guard.js';
import {
  SEARCH_TEXT_MAX_DEPTH,
  SEARCH_TEXT_MAX_EXCERPT_CHARACTERS,
  SEARCH_TEXT_MAX_FILE_BYTES,
  SEARCH_TEXT_MAX_FILES,
  SEARCH_TEXT_MAX_MATCHES,
  SEARCH_TEXT_MAX_UNREADABLE_REPORTED,
  type FilesystemToolOptions,
} from './types.js';

const extensionSchema = z
  .string()
  .trim()
  .min(1)
  .max(20)
  .regex(/^\.?[a-z0-9]+$/i, 'Extension must be alphanumeric with an optional leading dot')
  .transform((value) => (value.startsWith('.') ? value.toLowerCase() : `.${value.toLowerCase()}`));

const argumentsSchema = z
  .object({
    root: z.enum(ROOT_IDS),
    relativePath: z.string().max(1024).default(''),
    query: z.string().min(1).max(200),
    extensions: z.array(extensionSchema).max(10).optional(),
  })
  .strict();

const parameters: Record<string, unknown> = {
  type: 'object',
  properties: {
    root: {
      type: 'string',
      enum: [...ROOT_IDS],
      description: 'Approved root identifier: workspace or exports.',
    },
    relativePath: {
      type: 'string',
      description:
        'Directory path relative to the approved root using forward or backslashes. Use an empty string for the root. Never use an absolute path or ..',
    },
    query: {
      type: 'string',
      description:
        'Literal, case-sensitive text to search for. Regular expressions are not supported.',
    },
    extensions: {
      type: 'array',
      items: {
        type: 'string',
        description: 'File extension such as .txt or .md',
      },
      maxItems: 10,
      description: 'Optional file extension filters. Only matching files are inspected.',
    },
  },
  required: ['root', 'query'],
  additionalProperties: false,
};

interface SearchMatch {
  relativePath: string;
  absolutePath: string;
  lineNumber: number;
  excerpt: string;
}

interface SearchState {
  matches: SearchMatch[];
  filesInspected: number;
  directoriesVisited: number;
  unreadableCount: number;
  unreadablePaths: string[];
  skippedSymlinks: number;
  skippedSensitive: number;
  skippedBinary: number;
  skippedOversized: number;
  matchesLimitReached: boolean;
  filesLimitReached: boolean;
  depthLimitReached: boolean;
}

export function createSearchTextTool(options: FilesystemToolOptions): ToolDefinition {
  return {
    name: 'search_text',
    description:
      'Search for literal, case-sensitive text inside UTF-8 files in an approved root. Does not follow symbolic links or junctions. Skips binary and credential-like files and reports limits, truncation, and unreadable paths explicitly.',
    parameters,
    argumentsSchema,
    execute: (rawArgs: unknown) => {
      const args = argumentsSchema.parse(rawArgs);
      const resolved = options.guard.resolve(args.root, args.relativePath);
      options.guard.assertSafe(resolved);

      if (!resolved.exists || resolved.stats === null) {
        throw new FilesystemError('not_found', 'Search directory does not exist');
      }

      if (!resolved.stats.isDirectory()) {
        throw new FilesystemError('not_a_directory', 'Search path is not a directory');
      }

      const extensionFilters = new Set(args.extensions ?? []);
      const state: SearchState = {
        matches: [],
        filesInspected: 0,
        directoriesVisited: 0,
        unreadableCount: 0,
        unreadablePaths: [],
        skippedSymlinks: 0,
        skippedSensitive: 0,
        skippedBinary: 0,
        skippedOversized: 0,
        matchesLimitReached: false,
        filesLimitReached: false,
        depthLimitReached: false,
      };

      walkDirectory(
        resolved.absolutePath,
        0,
        resolved.rootPath,
        args.query,
        extensionFilters,
        state,
      );

      const truncated = {
        matches: state.matchesLimitReached,
        files: state.filesLimitReached,
        depth: state.depthLimitReached,
      };

      return {
        root: args.root,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        query: args.query,
        extensions: [...extensionFilters],
        matches: state.matches,
        matchCount: state.matches.length,
        maxMatches: SEARCH_TEXT_MAX_MATCHES,
        filesInspected: state.filesInspected,
        maxFilesInspected: SEARCH_TEXT_MAX_FILES,
        maxFileBytes: SEARCH_TEXT_MAX_FILE_BYTES,
        directoriesVisited: state.directoriesVisited,
        maxDepth: SEARCH_TEXT_MAX_DEPTH,
        truncated,
        skipped: {
          symlinks: state.skippedSymlinks,
          sensitiveFiles: state.skippedSensitive,
          binaryFiles: state.skippedBinary,
          oversizedFiles: state.skippedOversized,
        },
        unreadable: {
          count: state.unreadableCount,
          paths: state.unreadablePaths,
          truncated: state.unreadableCount > state.unreadablePaths.length,
        },
        complete:
          !truncated.matches && !truncated.files && !truncated.depth && state.unreadableCount === 0,
        verificationStatus: 'verified',
      };
    },
    verify: (rawArgs: unknown, output: unknown) => {
      if (!isRecord(output) || !Array.isArray(output.matches)) {
        return false;
      }

      try {
        const args = argumentsSchema.parse(rawArgs);
        const resolved = options.guard.resolve(args.root, args.relativePath);
        options.guard.assertSafe(resolved);

        if (
          output.root !== args.root ||
          output.absolutePath !== resolved.absolutePath ||
          output.verificationStatus !== 'verified' ||
          output.matchCount !== output.matches.length ||
          output.matches.length > SEARCH_TEXT_MAX_MATCHES
        ) {
          return false;
        }

        for (const match of output.matches) {
          if (!isRecord(match) || typeof match.absolutePath !== 'string') {
            return false;
          }

          if (!isPathWithin(resolved.rootPath, match.absolutePath)) {
            return false;
          }

          const stats = lstatSync(match.absolutePath);

          if (stats.isSymbolicLink() || !stats.isFile()) {
            return false;
          }
        }

        return true;
      } catch {
        return false;
      }
    },
    timeoutMs: 30_000,
    permission: 'read-only',
  };
}

function walkDirectory(
  directory: string,
  depth: number,
  rootPath: string,
  query: string,
  extensionFilters: ReadonlySet<string>,
  state: SearchState,
): boolean {
  if (shouldStop(state)) {
    return false;
  }

  state.directoriesVisited += 1;

  let dirents: Dirent[];

  try {
    dirents = readdirSync(directory, { withFileTypes: true });
  } catch {
    recordUnreadable(state, relativeTo(rootPath, directory));
    return true;
  }

  dirents.sort(compareDirents);

  for (const dirent of dirents) {
    if (shouldStop(state)) {
      return false;
    }

    const absolutePath = path.win32.join(directory, dirent.name);
    const relativePath = relativeTo(rootPath, absolutePath);

    if (dirent.isSymbolicLink()) {
      state.skippedSymlinks += 1;
      continue;
    }

    let stats: Stats;

    try {
      stats = lstatSync(absolutePath);
    } catch {
      recordUnreadable(state, relativePath);
      continue;
    }

    if (stats.isSymbolicLink()) {
      state.skippedSymlinks += 1;
      continue;
    }

    if (stats.isDirectory()) {
      if (isSensitiveDirectoryName(dirent.name)) {
        state.skippedSensitive += 1;
        continue;
      }

      if (depth + 1 > SEARCH_TEXT_MAX_DEPTH) {
        state.depthLimitReached = true;
        continue;
      }

      if (!walkDirectory(absolutePath, depth + 1, rootPath, query, extensionFilters, state)) {
        return false;
      }

      continue;
    }

    if (!stats.isFile()) {
      continue;
    }

    if (
      extensionFilters.size > 0 &&
      !extensionFilters.has(path.win32.extname(dirent.name).toLowerCase())
    ) {
      continue;
    }

    if (isSensitiveFileName(dirent.name) || isSensitivePath(relativePath)) {
      state.skippedSensitive += 1;
      continue;
    }

    if (stats.size > SEARCH_TEXT_MAX_FILE_BYTES) {
      state.skippedOversized += 1;
      continue;
    }

    if (state.filesInspected >= SEARCH_TEXT_MAX_FILES) {
      state.filesLimitReached = true;
      return false;
    }

    state.filesInspected += 1;

    let buffer: Buffer;

    try {
      buffer = readFileSync(absolutePath);
    } catch {
      recordUnreadable(state, relativePath);
      continue;
    }

    if (buffer.length > SEARCH_TEXT_MAX_FILE_BYTES) {
      state.skippedOversized += 1;
      continue;
    }

    if (isLikelyBinary(buffer)) {
      state.skippedBinary += 1;
      continue;
    }

    const text = tryDecodeUtf8(buffer);

    if (text === null) {
      state.skippedBinary += 1;
      continue;
    }

    const lines = text.split(/\r\n|\r|\n/);

    for (const [index, line] of lines.entries()) {
      const matchIndex = line.indexOf(query);

      if (matchIndex < 0) {
        continue;
      }

      state.matches.push({
        relativePath,
        absolutePath,
        lineNumber: index + 1,
        excerpt: createExcerpt(line, matchIndex, query.length),
      });

      if (state.matches.length >= SEARCH_TEXT_MAX_MATCHES) {
        state.matchesLimitReached = true;
        return false;
      }
    }
  }

  return true;
}

function shouldStop(state: SearchState): boolean {
  return state.matchesLimitReached || state.filesLimitReached;
}

function recordUnreadable(state: SearchState, relativePath: string): void {
  state.unreadableCount += 1;

  if (state.unreadablePaths.length < SEARCH_TEXT_MAX_UNREADABLE_REPORTED) {
    state.unreadablePaths.push(relativePath);
  }
}

function relativeTo(rootPath: string, targetPath: string): string {
  return path.win32.relative(rootPath, targetPath);
}

function createExcerpt(line: string, matchIndex: number, queryLength: number): string {
  const max = SEARCH_TEXT_MAX_EXCERPT_CHARACTERS;

  if (line.length <= max) {
    return line;
  }

  const context = Math.max(0, Math.floor((max - Math.min(queryLength, max)) / 2));
  let start = Math.max(0, matchIndex - context);
  const end = Math.min(line.length, start + max);

  if (end - start < max) {
    start = Math.max(0, end - max);
  }

  return line.slice(start, end);
}

function compareDirents(left: Dirent, right: Dirent): number {
  const leftLower = left.name.toLowerCase();
  const rightLower = right.name.toLowerCase();

  if (leftLower < rightLower) {
    return -1;
  }

  if (leftLower > rightLower) {
    return 1;
  }

  if (left.name < right.name) {
    return -1;
  }

  if (left.name > right.name) {
    return 1;
  }

  return 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
