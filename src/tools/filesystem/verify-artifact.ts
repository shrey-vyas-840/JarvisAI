import { readFile } from 'node:fs/promises';

import ExcelJS from 'exceljs';
import { z } from 'zod';

import type { ToolDefinition } from '../../core/tool-registry.js';
import { FilesystemError, ROOT_IDS } from './path-guard.js';
import type { FilesystemToolOptions } from './types.js';

const WorkbookClass =
  (ExcelJS as unknown as { default?: typeof ExcelJS }).default?.Workbook ?? ExcelJS.Workbook;

const argumentsSchema = z
  .object({
    root: z.enum(ROOT_IDS),
    relativePath: z.string().max(1024).default(''),
    kind: z.enum(['auto', 'file', 'directory', 'text', 'image', 'spreadsheet']).default('auto'),
    expectedText: z.string().max(32768).optional(),
    expectedRows: z.number().int().positive().max(100000).optional(),
    expectedColumns: z.number().int().positive().max(10000).optional(),
  })
  .strict();

export function createVerifyArtifactTool(options: FilesystemToolOptions): ToolDefinition {
  return {
    name: 'verify_artifact',
    description:
      'Independently inspect an existing file or directory inside the configured workspace or exports root. Detects text, common image formats and dimensions, and XLSX workbook dimensions using read-only parsing. Optional expected text, row count, and column count are compared exactly; this does not create or modify an artifact.',
    permission: 'read-only',
    timeoutMs: 30000,
    parameters: {
      type: 'object',
      properties: {
        root: { type: 'string', enum: [...ROOT_IDS] },
        relativePath: { type: 'string' },
        kind: {
          type: 'string',
          enum: ['auto', 'file', 'directory', 'text', 'image', 'spreadsheet'],
        },
        expectedText: { type: 'string' },
        expectedRows: { type: 'integer', minimum: 1 },
        expectedColumns: { type: 'integer', minimum: 1 },
      },
      required: ['root', 'relativePath'],
      additionalProperties: false,
    },
    argumentsSchema,
    execute: async (rawArgs: unknown) => verifyArtifact(argumentsSchema.parse(rawArgs), options),
    verify: async (rawArgs: unknown, output: unknown) => {
      if (!isRecord(output) || output.verified !== true) return false;
      try {
        const expected = await verifyArtifact(argumentsSchema.parse(rawArgs), options);
        return expected.verified === true && output.absolutePath === expected.absolutePath;
      } catch {
        return false;
      }
    },
  };
}

type VerifyArgs = z.infer<typeof argumentsSchema>;

async function verifyArtifact(
  args: VerifyArgs,
  options: FilesystemToolOptions,
): Promise<Record<string, unknown>> {
  const resolved = options.guard.resolve(args.root, args.relativePath);
  options.guard.assertSafe(resolved);
  if (!resolved.exists || resolved.stats === null) {
    throw new FilesystemError('not_found', 'Artifact does not exist');
  }
  if (resolved.stats.isSymbolicLink()) {
    throw new FilesystemError('symlink_rejected', 'Symbolic links and junctions are not allowed');
  }
  const base = {
    root: args.root,
    relativePath: resolved.relativePath,
    absolutePath: resolved.absolutePath,
    sizeBytes: resolved.stats.isFile() ? resolved.stats.size : null,
  };
  if (resolved.stats.isDirectory()) {
    if (args.kind !== 'auto' && args.kind !== 'directory') {
      throw new FilesystemError('invalid_path', 'Expected a file but found a directory');
    }
    return { ...base, kind: 'directory', verified: true };
  }
  if (!resolved.stats.isFile()) {
    throw new FilesystemError('invalid_path', 'Artifact is neither a regular file nor a directory');
  }
  const bytes = await readFile(resolved.absolutePath);
  if (bytes.length === 0) throw new FilesystemError('invalid_path', 'Artifact is empty');
  const detected = detectArtifactKind(bytes, resolved.relativePath);
  const kind = args.kind === 'auto' || args.kind === 'file' ? detected.kind : args.kind;
  if (args.kind !== 'auto' && args.kind !== 'file' && kind !== args.kind) {
    throw new FilesystemError(
      'invalid_path',
      `Expected ${args.kind} artifact but detected ${detected.kind}`,
    );
  }
  if (kind === 'text') {
    const text = bytes.toString('utf8');
    const exactMatch = args.expectedText === undefined ? null : text === args.expectedText;
    if (exactMatch === false)
      throw new FilesystemError('invalid_path', 'Text artifact does not match expected contents');
    return { ...base, kind, characterCount: text.length, exactMatch, verified: true };
  }
  if (kind === 'image') {
    if (
      detected.width === undefined ||
      detected.height === undefined ||
      detected.format === undefined
    ) {
      throw new FilesystemError('invalid_path', 'Image format or dimensions could not be verified');
    }
    return {
      ...base,
      kind,
      format: detected.format,
      width: detected.width,
      height: detected.height,
      verified: true,
    };
  }
  if (kind === 'spreadsheet') {
    const workbook = new WorkbookClass();
    await workbook.xlsx.readFile(resolved.absolutePath);
    const worksheet = workbook.worksheets[0];
    if (worksheet === undefined)
      throw new FilesystemError('invalid_path', 'Workbook contains no worksheet');
    const rowCount = worksheet.rowCount;
    const columnCount = worksheet.columnCount;
    if (args.expectedRows !== undefined && rowCount !== args.expectedRows) {
      throw new FilesystemError(
        'invalid_path',
        `Expected ${String(args.expectedRows)} rows but found ${String(rowCount)}`,
      );
    }
    if (args.expectedColumns !== undefined && columnCount !== args.expectedColumns) {
      throw new FilesystemError(
        'invalid_path',
        `Expected ${String(args.expectedColumns)} columns but found ${String(columnCount)}`,
      );
    }
    return { ...base, kind, sheetName: worksheet.name, rowCount, columnCount, verified: true };
  }
  return { ...base, kind: 'file', format: detected.format ?? null, verified: true };
}

function detectArtifactKind(
  bytes: Buffer,
  relativePath: string,
): {
  kind: 'file' | 'text' | 'image' | 'spreadsheet';
  format?: string;
  width?: number;
  height?: number;
} {
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    return {
      kind: 'image',
      format: 'png',
      width: bytes.readUInt32BE(16),
      height: bytes.readUInt32BE(20),
    };
  }
  if (
    bytes.subarray(0, 6).toString('ascii') === 'GIF87a' ||
    bytes.subarray(0, 6).toString('ascii') === 'GIF89a'
  ) {
    return {
      kind: 'image',
      format: 'gif',
      width: bytes.readUInt16LE(6),
      height: bytes.readUInt16LE(8),
    };
  }
  if (bytes.subarray(0, 2).equals(Buffer.from([0xff, 0xd8]))) {
    const dimensions = readJpegDimensions(bytes);
    return dimensions === null
      ? { kind: 'image', format: 'jpeg' }
      : { kind: 'image', format: 'jpeg', ...dimensions };
  }
  if (
    bytes.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) &&
    relativePath.toLowerCase().endsWith('.xlsx')
  ) {
    return { kind: 'spreadsheet', format: 'xlsx' };
  }
  return isProbablyText(bytes) ? { kind: 'text', format: 'utf8' } : { kind: 'file' };
}

function isProbablyText(bytes: Buffer): boolean {
  return !bytes.subarray(0, Math.min(bytes.length, 1024)).some((value) => value === 0);
}

function readJpegDimensions(bytes: Buffer): { width: number; height: number } | null {
  let offset = 2;
  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1];
    if (marker === undefined) return null;
    offset += 2;
    if (marker === 0xd8 || marker === 0xd9) continue;
    if (offset + 2 > bytes.length) return null;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) return null;
    if (
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf)
    ) {
      return { height: bytes.readUInt16BE(offset + 3), width: bytes.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
