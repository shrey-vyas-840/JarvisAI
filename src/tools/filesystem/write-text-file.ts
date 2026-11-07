import { createHash } from 'node:crypto';
import { closeSync, fsyncSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import type { ApprovalRequest } from '../../security/approval-types.js';
import { isSensitivePath } from './file-safety.js';
import { FilesystemError, ROOT_IDS, toFilesystemError, type ResolvedPath } from './path-guard.js';
import { WRITE_TEXT_FILE_MAX_BYTES, type FilesystemToolOptions } from './types.js';

const contentSchema = z
  .string()
  .refine((value) => !value.includes('\0'), 'Content must not contain NUL characters')
  .refine((value) => isWellFormedText(value), 'Content must be valid Unicode text')
  .refine(
    (value) => Buffer.byteLength(value, 'utf8') <= WRITE_TEXT_FILE_MAX_BYTES,
    `Content must not exceed ${String(WRITE_TEXT_FILE_MAX_BYTES)} UTF-8 bytes`,
  );

const argumentsSchema = z
  .object({
    root: z.enum(ROOT_IDS),
    relativePath: z.string().min(1).max(1024),
    content: contentSchema,
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
        'New text file path relative to the approved root using forward or backslashes. The parent directory must already exist. Never use an absolute path or ..',
    },
    content: {
      type: 'string',
      description: `UTF-8 text to write. Maximum ${String(WRITE_TEXT_FILE_MAX_BYTES)} bytes. Binary or invalid text is rejected.`,
    },
  },
  required: ['root', 'relativePath', 'content'],
  additionalProperties: false,
};

interface PreparedWrite {
  readonly resolved: ResolvedPath;
  readonly contentBytes: number;
  readonly contentSha256: string;
}

export function createWriteTextFileTool(options: FilesystemToolOptions): ToolDefinition {
  return {
    name: 'write_text_file',
    description:
      'Create a new UTF-8 text file inside an approved root after explicit human approval. The parent directory must already exist, the target must not exist, the write uses exclusive creation, and the file is read back and verified exactly. Existing files are never overwritten.',
    parameters,
    argumentsSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = argumentsSchema.parse(rawArgs);
      const prepared = prepareWriteTextFile(
        options.guard,
        args.root,
        args.relativePath,
        args.content,
      );

      return {
        toolName: 'write_text_file',
        operation: 'Create new text file',
        root: args.root,
        relativePath: prepared.resolved.relativePath,
        absolutePath: prepared.resolved.absolutePath,
        action:
          'Create one new UTF-8 text file. The parent directory must already exist and the target must not exist.',
        warning:
          'A new file will be created. Existing files are never overwritten, and no deletion or recovery action will be taken if verification fails.',
        content: {
          text: args.content,
          bytes: prepared.contentBytes,
          sha256: prepared.contentSha256,
        },
      };
    },
    execute: (rawArgs: unknown) => {
      const args = argumentsSchema.parse(rawArgs);
      const prepared = prepareWriteTextFile(
        options.guard,
        args.root,
        args.relativePath,
        args.content,
      );

      writeNewFile(prepared.resolved.absolutePath, args.content);

      const created = options.guard.resolve(args.root, args.relativePath);
      options.guard.assertSafe(created);

      if (!created.exists || created.stats === null) {
        throw new FilesystemError(
          'verification_failed',
          'File creation returned but the file could not be found',
        );
      }

      if (!created.stats.isFile()) {
        throw new FilesystemError('verification_failed', 'Created path is not a regular file');
      }

      let buffer: Buffer;

      try {
        buffer = readFileSync(created.absolutePath);
      } catch (error) {
        throw toFilesystemError(error, 'verification_failed');
      }

      options.guard.assertSafe(created);

      const readBack = decodeExactUtf8(buffer);
      const readBackSha256 = sha256(buffer);

      if (
        readBack !== args.content ||
        buffer.length !== prepared.contentBytes ||
        readBackSha256 !== prepared.contentSha256
      ) {
        throw new FilesystemError(
          'verification_failed',
          'File was created but its content does not match the approved content',
        );
      }

      return {
        root: args.root,
        relativePath: created.relativePath,
        absolutePath: created.absolutePath,
        type: 'file',
        encoding: 'utf-8',
        bytesWritten: prepared.contentBytes,
        sha256: prepared.contentSha256,
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

        if (
          !resolved.exists ||
          resolved.stats === null ||
          !resolved.stats.isFile() ||
          resolved.stats.isSymbolicLink()
        ) {
          return false;
        }

        const buffer = readFileSync(resolved.absolutePath);
        options.guard.assertSafe(resolved);

        const text = decodeExactUtf8(buffer);
        const expectedBytes = Buffer.byteLength(args.content, 'utf8');
        const expectedSha256 = sha256(Buffer.from(args.content, 'utf8'));

        return (
          output.root === args.root &&
          output.absolutePath === resolved.absolutePath &&
          output.relativePath === resolved.relativePath &&
          output.type === 'file' &&
          output.encoding === 'utf-8' &&
          output.created === true &&
          output.verificationStatus === 'verified' &&
          output.bytesWritten === expectedBytes &&
          output.sha256 === expectedSha256 &&
          text === args.content &&
          buffer.length === expectedBytes
        );
      } catch {
        return false;
      }
    },
    timeoutMs: 30_000,
    permission: 'requires-approval',
  };
}

function prepareWriteTextFile(
  guard: FilesystemToolOptions['guard'],
  root: string,
  relativePath: string,
  content: string,
): PreparedWrite {
  const resolved = guard.resolve(root, relativePath);
  guard.assertSafe(resolved);

  if (resolved.relativePath.length === 0) {
    throw new FilesystemError('invalid_path', 'Approved root directories cannot be files');
  }

  if (resolved.exists) {
    throw new FilesystemError(
      'already_exists',
      'Target already exists; existing files are never overwritten',
    );
  }

  if (isSensitivePath(resolved.relativePath)) {
    throw new FilesystemError(
      'sensitive_file',
      'Sensitive files and directories such as credential or private-key locations are not writable',
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
    throw new FilesystemError(
      'already_exists',
      'Target already exists; existing files are never overwritten',
    );
  }

  const contentBytes = Buffer.byteLength(content, 'utf8');

  if (contentBytes > WRITE_TEXT_FILE_MAX_BYTES) {
    throw new FilesystemError(
      'content_too_large',
      `Content exceeds the ${String(WRITE_TEXT_FILE_MAX_BYTES)} byte write limit`,
    );
  }

  if (content.includes('\0') || !isWellFormedText(content)) {
    throw new FilesystemError('invalid_content', 'Content must be valid UTF-8 text without NUL');
  }

  return {
    resolved: rechecked,
    contentBytes,
    contentSha256: sha256(Buffer.from(content, 'utf8')),
  };
}

function writeNewFile(absolutePath: string, content: string): void {
  let fileDescriptor: number;

  try {
    fileDescriptor = openSync(absolutePath, 'wx');
  } catch (error) {
    throw toFilesystemError(error, 'write_failed');
  }

  let failure: unknown = null;

  try {
    writeFileSync(fileDescriptor, content, { encoding: 'utf8' });
    fsyncSync(fileDescriptor);
  } catch (error) {
    failure = error;
  }

  try {
    closeSync(fileDescriptor);
  } catch (error) {
    if (failure === null) {
      failure = error;
    }
  }

  if (failure !== null) {
    throw new FilesystemError(
      'write_failed',
      `File was created at ${absolutePath} but writing or closing did not complete; the file may be partial. Cause: ${formatError(failure)}`,
    );
  }
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function decodeExactUtf8(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(buffer);
  } catch {
    throw new FilesystemError(
      'verification_failed',
      'File was created but its content could not be decoded as UTF-8',
    );
  }
}

function parentRelativePath(relativePath: string): string {
  const parent = path.win32.dirname(relativePath);

  return parent === '.' ? '' : parent;
}

function isWellFormedText(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);

    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);

      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }

      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }

  return true;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown filesystem error';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
