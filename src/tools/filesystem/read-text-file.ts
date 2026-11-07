import { readFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import { assertReadableTextFile, isSensitiveFileName, isSensitivePath } from './file-safety.js';
import { FilesystemError, ROOT_IDS, toFilesystemError } from './path-guard.js';
import {
  READ_TEXT_FILE_MAX_BYTES,
  READ_TEXT_FILE_MAX_CHARACTERS,
  type FilesystemToolOptions,
} from './types.js';

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
        'File path relative to the approved root using forward or backslashes. Never use an absolute path or ..',
    },
  },
  required: ['root', 'relativePath'],
  additionalProperties: false,
};

export function createReadTextFileTool(options: FilesystemToolOptions): ToolDefinition {
  return {
    name: 'read_text_file',
    description:
      'Read a real UTF-8 text file within an approved root. Rejects binary files, credential-like files, files larger than 1 MiB, and files that are not valid UTF-8. Output is limited and reports truncation explicitly.',
    parameters,
    argumentsSchema,
    execute: (rawArgs: unknown) => {
      const args = argumentsSchema.parse(rawArgs);
      const resolved = options.guard.resolve(args.root, args.relativePath);
      options.guard.assertSafe(resolved);

      if (!resolved.exists || resolved.stats === null) {
        throw new FilesystemError('not_found', 'File does not exist');
      }

      if (!resolved.stats.isFile()) {
        throw new FilesystemError('not_a_file', 'Path is not a regular file');
      }

      if (resolved.stats.size > READ_TEXT_FILE_MAX_BYTES) {
        throw new FilesystemError(
          'file_too_large',
          `File exceeds the ${String(READ_TEXT_FILE_MAX_BYTES)} byte read limit`,
        );
      }

      const fileName = path.win32.basename(resolved.absolutePath);

      if (isSensitiveFileName(fileName) || isSensitivePath(resolved.relativePath)) {
        throw new FilesystemError(
          'sensitive_file',
          'Files that may contain credentials or private keys are not readable',
        );
      }

      let buffer: Buffer;

      try {
        buffer = readFileSync(resolved.absolutePath);
      } catch (error) {
        throw toFilesystemError(error);
      }

      options.guard.assertSafe(resolved);

      if (buffer.length > READ_TEXT_FILE_MAX_BYTES) {
        throw new FilesystemError(
          'file_too_large',
          `File exceeds the ${String(READ_TEXT_FILE_MAX_BYTES)} byte read limit`,
        );
      }

      const text = assertReadableTextFile(fileName, buffer);
      const totalCharacters = text.length;
      const truncated = totalCharacters > READ_TEXT_FILE_MAX_CHARACTERS;
      const content = truncated ? text.slice(0, READ_TEXT_FILE_MAX_CHARACTERS) : text;

      return {
        root: args.root,
        relativePath: resolved.relativePath,
        absolutePath: resolved.absolutePath,
        sizeBytes: buffer.length,
        encoding: 'utf-8',
        content,
        returnedCharacters: content.length,
        totalCharacters,
        maxCharacters: READ_TEXT_FILE_MAX_CHARACTERS,
        truncated,
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
          output.encoding === 'utf-8' &&
          typeof output.content === 'string' &&
          typeof output.sizeBytes === 'number' &&
          output.sizeBytes <= READ_TEXT_FILE_MAX_BYTES &&
          output.returnedCharacters === output.content.length &&
          output.returnedCharacters ===
            Math.min(output.totalCharacters as number, READ_TEXT_FILE_MAX_CHARACTERS) &&
          output.truncated === (output.totalCharacters as number) > READ_TEXT_FILE_MAX_CHARACTERS
        );
      } catch {
        return false;
      }
    },
    timeoutMs: 10_000,
    permission: 'read-only',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
