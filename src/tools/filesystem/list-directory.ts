import { lstatSync, readdirSync, type Dirent } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import { FilesystemError, ROOT_IDS, toFilesystemError } from './path-guard.js';
import { LIST_DIRECTORY_MAX_ENTRIES, type FilesystemToolOptions } from './types.js';

const argumentsSchema = z
  .object({
    root: z.enum(ROOT_IDS),
    relativePath: z.string().max(1024).default(''),
    limit: z
      .number()
      .int()
      .min(1)
      .max(LIST_DIRECTORY_MAX_ENTRIES)
      .default(LIST_DIRECTORY_MAX_ENTRIES),
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
        'Path relative to the approved root using forward or backslashes. Use an empty string for the root directory. Never use an absolute path or ..',
    },
    limit: {
      type: 'integer',
      minimum: 1,
      maximum: LIST_DIRECTORY_MAX_ENTRIES,
      default: LIST_DIRECTORY_MAX_ENTRIES,
      description: 'Maximum number of directory entries to return.',
    },
  },
  required: ['root'],
  additionalProperties: false,
};

interface ListEntry {
  name: string;
  type: 'file' | 'directory' | 'symlink' | 'other' | 'unknown';
  sizeBytes: number | null;
  lastModified: string | null;
  skipped: boolean;
  metadataError?: string;
}

export function createListDirectoryTool(options: FilesystemToolOptions): ToolDefinition {
  return {
    name: 'list_directory',
    description:
      'List the actual files and directories inside an approved root. Use the root identifier and a relative path. Symbolic links and junctions are reported but never followed.',
    parameters,
    argumentsSchema,
    execute: (rawArgs: unknown) => {
      const args = argumentsSchema.parse(rawArgs);
      const resolved = options.guard.resolve(args.root, args.relativePath);
      options.guard.assertSafe(resolved);

      if (!resolved.exists || resolved.stats === null) {
        throw new FilesystemError('not_found', 'Directory does not exist');
      }

      if (!resolved.stats.isDirectory()) {
        throw new FilesystemError('not_a_directory', 'Path is not a directory');
      }

      let dirents: Dirent[];

      try {
        dirents = readdirSync(resolved.absolutePath, { withFileTypes: true });
      } catch (error) {
        throw toFilesystemError(error);
      }

      const sorted = [...dirents].sort(compareDirents);
      const totalEntries = sorted.length;
      const selected = sorted.slice(0, args.limit);
      const entries = selected.map((entry) => describeEntry(resolved.absolutePath, entry));

      return {
        root: args.root,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        entries,
        entryCount: entries.length,
        totalEntries,
        limit: args.limit,
        truncated: totalEntries > entries.length,
        verificationStatus: 'verified',
      };
    },
    verify: (rawArgs: unknown, output: unknown) => {
      if (!isRecord(output)) {
        return false;
      }

      try {
        const args = argumentsSchema.parse(rawArgs);
        const resolved = options.guard.resolve(args.root, args.relativePath);
        options.guard.assertSafe(resolved);

        return (
          output.root === args.root &&
          output.absolutePath === resolved.absolutePath &&
          output.verificationStatus === 'verified' &&
          Array.isArray(output.entries) &&
          output.entries.length === output.entryCount &&
          output.truncated ===
            (typeof output.totalEntries === 'number' && output.totalEntries > output.entries.length)
        );
      } catch {
        return false;
      }
    },
    timeoutMs: 5_000,
    permission: 'read-only',
  };
}

function describeEntry(directory: string, entry: Dirent): ListEntry {
  const absolutePath = path.win32.join(directory, entry.name);

  try {
    const stats = lstatSync(absolutePath);

    if (stats.isSymbolicLink()) {
      return {
        name: entry.name,
        type: 'symlink',
        sizeBytes: null,
        lastModified: null,
        skipped: true,
      };
    }

    return {
      name: entry.name,
      type: stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other',
      sizeBytes: stats.isFile() ? stats.size : null,
      lastModified: stats.mtime.toISOString(),
      skipped: false,
    };
  } catch (error) {
    return {
      name: entry.name,
      type: 'unknown',
      sizeBytes: null,
      lastModified: null,
      skipped: true,
      metadataError: toFilesystemError(error).code,
    };
  }
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
