import { accessSync, constants } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import { FilesystemError, ROOT_IDS, toFilesystemError } from './path-guard.js';
import type { FilesystemToolOptions } from './types.js';

const argumentsSchema = z
  .object({
    root: z.enum(ROOT_IDS),
    relativePath: z.string().max(1024).default(''),
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
  },
  required: ['root'],
  additionalProperties: false,
};

export function createGetFileInfoTool(options: FilesystemToolOptions): ToolDefinition {
  return {
    name: 'get_file_info',
    description:
      'Return verified metadata for a file or directory inside an approved root: name, absolute path, relative path, type, size, timestamps, and read-only status. Never returns file contents.',
    parameters,
    argumentsSchema,
    execute: (rawArgs: unknown) => {
      const args = argumentsSchema.parse(rawArgs);
      const resolved = options.guard.resolve(args.root, args.relativePath);
      options.guard.assertSafe(resolved);

      if (!resolved.exists || resolved.stats === null) {
        throw new FilesystemError('not_found', 'File or directory does not exist');
      }

      const stats = resolved.stats;

      if (stats.isSymbolicLink()) {
        throw new FilesystemError(
          'symlink_rejected',
          'Symbolic links and junctions are not allowed',
        );
      }

      const type = stats.isDirectory() ? 'directory' : stats.isFile() ? 'file' : 'other';
      const name = path.win32.basename(resolved.absolutePath);

      return {
        root: args.root,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        name: name.length > 0 ? name : resolved.absolutePath,
        type,
        sizeBytes: stats.isFile() ? stats.size : null,
        createdAt: stats.birthtimeMs > 0 ? stats.birthtime.toISOString() : null,
        modifiedAt: stats.mtime.toISOString(),
        readOnly: detectReadOnly(resolved.absolutePath),
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

        if (!resolved.exists || resolved.stats === null) {
          return false;
        }

        const expectedType = resolved.stats.isDirectory()
          ? 'directory'
          : resolved.stats.isFile()
            ? 'file'
            : 'other';

        return (
          output.root === args.root &&
          output.absolutePath === resolved.absolutePath &&
          output.type === expectedType &&
          output.verificationStatus === 'verified'
        );
      } catch {
        return false;
      }
    },
    timeoutMs: 5_000,
    permission: 'read-only',
  };
}

function detectReadOnly(target: string): boolean | null {
  try {
    accessSync(target, constants.W_OK);
    return false;
  } catch (error) {
    const filesystemError = toFilesystemError(error);

    if (filesystemError.code === 'permission_denied') {
      return true;
    }

    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
