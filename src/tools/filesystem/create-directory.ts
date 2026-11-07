import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import type { ApprovalRequest } from '../../security/approval-types.js';
import { isSensitivePath } from './file-safety.js';
import { FilesystemError, ROOT_IDS, toFilesystemError, type ResolvedPath } from './path-guard.js';
import type { FilesystemToolOptions } from './types.js';

const argumentsSchema = z
  .object({
    root: z.enum(ROOT_IDS),
    relativePath: z.string().min(1).max(1024),
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
        'New directory path relative to the approved root using forward or backslashes. The parent directory must already exist. Never use an absolute path or ..',
    },
  },
  required: ['root', 'relativePath'],
  additionalProperties: false,
};

export function createCreateDirectoryTool(options: FilesystemToolOptions): ToolDefinition {
  return {
    name: 'create_directory',
    description:
      'Create one new directory inside an approved root after explicit human approval. The parent directory must already exist, the target must not exist, recursive creation is not allowed, and symbolic links or junctions are rejected. Existing paths are never overwritten.',
    parameters,
    argumentsSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = argumentsSchema.parse(rawArgs);
      const resolved = prepareCreateDirectory(options.guard, args.root, args.relativePath);

      return {
        toolName: 'create_directory',
        operation: 'Create new directory',
        root: args.root,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        action:
          'Create one new directory. The parent directory must already exist and the target must not exist.',
        warning:
          'This creates exactly one directory. Existing paths are rejected, recursive creation is not allowed, and symbolic links or junctions are never followed.',
      };
    },
    execute: (rawArgs: unknown) => {
      const args = argumentsSchema.parse(rawArgs);
      const resolved = prepareCreateDirectory(options.guard, args.root, args.relativePath);

      try {
        mkdirSync(resolved.absolutePath);
      } catch (error) {
        throw toFilesystemError(error, 'write_failed');
      }

      const created = options.guard.resolve(args.root, args.relativePath);
      options.guard.assertSafe(created);

      if (!created.exists || created.stats === null) {
        throw new FilesystemError(
          'verification_failed',
          'Directory creation returned but the directory could not be found',
        );
      }

      if (!created.stats.isDirectory()) {
        throw new FilesystemError(
          'verification_failed',
          'Created path exists but is not a directory',
        );
      }

      return {
        root: args.root,
        relativePath: created.relativePath,
        absolutePath: created.absolutePath,
        type: 'directory',
        created: true,
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
          output.relativePath === resolved.relativePath &&
          output.type === 'directory' &&
          output.created === true &&
          output.verificationStatus === 'verified' &&
          resolved.exists &&
          resolved.stats !== null &&
          resolved.stats.isDirectory() &&
          !resolved.stats.isSymbolicLink()
        );
      } catch {
        return false;
      }
    },
    timeoutMs: 10_000,
    permission: 'requires-approval',
  };
}

function prepareCreateDirectory(
  guard: FilesystemToolOptions['guard'],
  root: string,
  relativePath: string,
): ResolvedPath {
  const resolved = guard.resolve(root, relativePath);
  guard.assertSafe(resolved);

  if (resolved.relativePath.length === 0) {
    throw new FilesystemError('invalid_path', 'Approved root directories cannot be created');
  }

  if (resolved.exists) {
    throw new FilesystemError('already_exists', 'Target already exists');
  }

  if (isSensitivePath(resolved.relativePath)) {
    throw new FilesystemError(
      'sensitive_file',
      'Sensitive directories such as credential or private-key locations are not writable',
    );
  }

  const parentRelative = parentRelativePath(resolved.relativePath);
  const parent = guard.resolve(root, parentRelative);
  guard.assertSafe(parent);

  if (!parent.exists || parent.stats === null) {
    throw new FilesystemError('not_found', 'Parent directory does not exist');
  }

  if (!parent.stats.isDirectory()) {
    throw new FilesystemError('not_a_directory', 'Parent path is not a directory');
  }

  const rechecked = guard.resolve(root, relativePath);
  guard.assertSafe(rechecked);

  if (rechecked.exists) {
    throw new FilesystemError('already_exists', 'Target already exists');
  }

  return rechecked;
}

function parentRelativePath(relativePath: string): string {
  const parent = path.win32.dirname(relativePath);

  return parent === '.' ? '' : parent;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
