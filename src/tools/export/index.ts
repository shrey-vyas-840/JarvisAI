import path from 'node:path';
import { z } from 'zod';

import type { AppConfig } from '../../config.js';
import type { ToolDefinition } from '../../core/tool-registry.js';
import { buildBusinessWorkbookBuffer, writeAndVerifyWorkbook } from '../../export/excel-builder.js';
import type { ApprovalRequest } from '../../security/approval-types.js';

export interface ExportToolsOptions {
  readonly config: AppConfig;
}

const businessRecordSchema = z.object({
  name: z.string(),
  category: z.string(),
  address: z.string().nullable(),
  postcode: z.string().nullable(),
  locality: z.string().nullable(),
  city: z.string().nullable(),
  phone: z.string().nullable(),
  website: z.string().nullable(),
  openingHours: z.string().nullable(),
  latitude: z.number(),
  longitude: z.number(),
  sourceId: z.string(),
  sourceUrl: z.string(),
  dataSource: z.string(),
  dataLicense: z.string(),
  attribution: z.string(),
  retrievalTimestamp: z.string(),
});

export function createExportTools(options: ExportToolsOptions): ToolDefinition[] {
  const exportsDir = options.config.paths.exports;

  const exportSchema = z.object({
    filename: z
      .string()
      .min(1)
      .describe(
        'Target workbook filename inside D:\\AI\\Exports, ending in .xlsx (e.g. "ahmedabad_restaurants.xlsx").',
      ),
    searchRequest: z.string().min(1).describe('The user research request or query description.'),
    region: z.string().min(1).describe('Region, locality, or postal code.'),
    category: z.string().min(1).describe('Business category (e.g. "restaurants", "cafes").'),
    businesses: z
      .array(businessRecordSchema)
      .describe('List of business records retrieved from open data to export.'),
  });

  const tool: ToolDefinition = {
    name: 'export_businesses_xlsx',
    description:
      'Generate a verified, professionally formatted Microsoft Excel (.xlsx) workbook containing business research records, search summary, and full OpenStreetMap ODbL attribution. Saves strictly into D:\\AI\\Exports and enforces exclusive creation (refuses to overwrite existing files). Requires explicit user approval before writing.',
    permission: 'requires-approval',
    timeoutMs: 30000,
    parameters: {
      type: 'object',
      properties: {
        filename: {
          type: 'string',
          description: 'Filename ending in .xlsx (saved inside D:\\AI\\Exports).',
        },
        searchRequest: {
          type: 'string',
          description: 'Original research query.',
        },
        region: {
          type: 'string',
          description: 'Target region or postal code.',
        },
        category: {
          type: 'string',
          description: 'Business category.',
        },
        businesses: {
          type: 'array',
          description: 'List of business records to include.',
          items: {
            type: 'object',
          },
        },
      },
      required: ['filename', 'searchRequest', 'region', 'category', 'businesses'],
    },
    argumentsSchema: exportSchema,
    approvalRequest: (rawArgs: unknown): ApprovalRequest => {
      const args = exportSchema.parse(rawArgs);
      const safeFilename = path.basename(args.filename.trim());
      const absolutePath = path.join(exportsDir, safeFilename);

      return {
        toolName: 'export_businesses_xlsx',
        operation: 'Export Business Research to Excel',
        root: 'exports',
        relativePath: safeFilename,
        absolutePath,
        action: `Generate 3-worksheet XLSX workbook containing ${String(args.businesses.length)} ${args.category} records in "${args.region}".`,
        warning: `This will create a new Excel workbook at "${absolutePath}". Overwriting is prohibited. Licensing: ODbL 1.0.`,
      };
    },
    execute: async (rawArgs: unknown) => {
      const args = exportSchema.parse(rawArgs);
      const buffer = await buildBusinessWorkbookBuffer({
        businesses: args.businesses,
        searchRequest: args.searchRequest,
        region: args.region,
        category: args.category,
        totalRetrieved: args.businesses.length,
      });

      const receipt = await writeAndVerifyWorkbook(exportsDir, args.filename, buffer);

      return {
        exported: true,
        filename: path.basename(receipt.targetPath),
        absolutePath: receipt.targetPath,
        bytes: receipt.bytes,
        sha256: receipt.sha256,
        sheets: receipt.sheetNames,
        businessRowCount: receipt.businessRowCount,
        sampleBusinessName: receipt.sampleBusinessName,
        verified: receipt.verified,
        dataLicense: 'Open Database License (ODbL) 1.0',
        attribution: '© OpenStreetMap contributors',
      };
    },
  };

  return [tool];
}
