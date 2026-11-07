import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import ExcelJS from 'exceljs';

import type { OsmBusinessRecord } from '../geo/osm-types.js';

const WorkbookClass =
  (ExcelJS as unknown as { default?: typeof ExcelJS }).default?.Workbook ?? ExcelJS.Workbook;

export interface BuildWorkbookInput {
  readonly businesses: readonly OsmBusinessRecord[];
  readonly searchRequest: string;
  readonly region: string;
  readonly category: string;
  readonly queryTimestamp?: string;
  readonly totalRetrieved?: number;
}

export interface VerificationReceipt {
  readonly verified: boolean;
  readonly targetPath: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly sheetNames: string[];
  readonly businessRowCount: number;
  readonly sampleBusinessName: string | null;
}

export async function buildBusinessWorkbookBuffer(input: BuildWorkbookInput): Promise<Buffer> {
  const wb = new WorkbookClass();
  wb.creator = 'JARVIS AI Operator';
  wb.created = new Date();

  // -------------------------------------------------------------
  // Sheet 1: Businesses
  // -------------------------------------------------------------
  const wsBusinesses = wb.addWorksheet('Businesses', {
    views: [{ state: 'frozen', ySplit: 2 }],
  });

  // Title Row (Row 1)
  wsBusinesses.mergeCells('A1:P1');
  const titleCell = wsBusinesses.getCell('A1');
  titleCell.value = `JARVIS Business Research Export — ${input.category.toUpperCase()} (${input.region})`;
  titleCell.font = { bold: true, size: 13, color: { argb: 'FFFFFFFF' } };
  titleCell.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E79' }, // Dark navy
  };
  titleCell.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  wsBusinesses.getRow(1).height = 26;

  // Header Row (Row 2)
  const headers = [
    'Business Name',
    'Category',
    'Address',
    'Postcode',
    'Locality',
    'City',
    'Phone',
    'Website',
    'Opening Hours',
    'Latitude',
    'Longitude',
    'Source ID',
    'Source URL',
    'Data Source',
    'Data License',
    'Retrieval Timestamp',
  ];

  const headerRow = wsBusinesses.getRow(2);
  headerRow.values = headers;
  headerRow.font = { bold: true, size: 10, color: { argb: 'FFFFFFFF' } };
  headerRow.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF2F5597' }, // Slate blue
  };
  headerRow.height = 22;

  // Data Rows
  for (let i = 0; i < input.businesses.length; i++) {
    const b = input.businesses[i];
    if (!b) continue;

    const row = wsBusinesses.addRow([
      b.name,
      b.category,
      b.address ?? '',
      b.postcode ?? '',
      b.locality ?? '',
      b.city ?? '',
      b.phone ?? '',
      b.website ? { text: b.website, hyperlink: b.website } : '',
      b.openingHours ?? '',
      b.latitude,
      b.longitude,
      b.sourceId,
      { text: b.sourceUrl, hyperlink: b.sourceUrl },
      b.dataSource,
      b.dataLicense,
      b.retrievalTimestamp,
    ]);

    // Number formatting for lat/lon
    row.getCell(10).numFmt = '0.000000';
    row.getCell(11).numFmt = '0.000000';
    row.height = 18;

    // Alternate row zebra striping
    if (i % 2 === 1) {
      row.fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFF2F2F2' },
      };
    }
  }

  // Auto-filter
  wsBusinesses.autoFilter = {
    from: { row: 2, column: 1 },
    to: { row: 2 + input.businesses.length, column: headers.length },
  };

  // Column widths
  wsBusinesses.columns = [
    { width: 28 }, // Name
    { width: 14 }, // Category
    { width: 32 }, // Address
    { width: 12 }, // Postcode
    { width: 16 }, // Locality
    { width: 16 }, // City
    { width: 18 }, // Phone
    { width: 28 }, // Website
    { width: 20 }, // Opening Hours
    { width: 14 }, // Lat
    { width: 14 }, // Lon
    { width: 16 }, // Source ID
    { width: 32 }, // Source URL
    { width: 16 }, // Source
    { width: 28 }, // License
    { width: 24 }, // Retrieval Timestamp
  ];

  // -------------------------------------------------------------
  // Sheet 2: Search Summary
  // -------------------------------------------------------------
  const wsSummary = wb.addWorksheet('Search Summary');
  wsSummary.columns = [{ width: 26 }, { width: 60 }];

  wsSummary.mergeCells('A1:B1');
  const sumTitle = wsSummary.getCell('A1');
  sumTitle.value = 'Search Execution Summary';
  sumTitle.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  sumTitle.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E79' },
  };
  wsSummary.getRow(1).height = 24;

  const totalRetrieved = input.totalRetrieved ?? input.businesses.length;
  const summaryData: [string, string | number][] = [
    ['User Search Request', input.searchRequest],
    ['Target Region / Postcode', input.region],
    ['Category Requested', input.category],
    ['Query Timestamp', input.queryTimestamp ?? new Date().toISOString()],
    ['Primary Data Source', 'OpenStreetMap via Overpass API'],
    ['Total Results Retrieved', totalRetrieved],
    ['Results Included in Sheet', input.businesses.length],
    ['Results Omitted (Missing Name)', Math.max(0, totalRetrieved - input.businesses.length)],
    [
      'Coverage Limitations',
      'OpenStreetMap coverage varies by region. Unmapped businesses are omitted. No ratings or review counts are fabricated.',
    ],
    [
      'Google Maps Separation Policy',
      'Google Maps content is prohibited from bulk scraping or database export. Compliant open data was utilized instead.',
    ],
  ];

  for (const [metric, val] of summaryData) {
    const row = wsSummary.addRow([metric, val]);
    row.getCell(1).font = { bold: true };
    row.height = 20;
  }

  // -------------------------------------------------------------
  // Sheet 3: Sources and Attribution
  // -------------------------------------------------------------
  const wsAttr = wb.addWorksheet('Sources and Attribution');
  wsAttr.columns = [{ width: 26 }, { width: 65 }];

  wsAttr.mergeCells('A1:B1');
  const attrTitle = wsAttr.getCell('A1');
  attrTitle.value = 'Data Sources, Licensing & Mandatory Attribution';
  attrTitle.font = { bold: true, size: 12, color: { argb: 'FFFFFFFF' } };
  attrTitle.fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FF1F4E79' },
  };
  wsAttr.getRow(1).height = 24;

  const attrData: [string, string][] = [
    ['Data Provider', 'OpenStreetMap Foundation (OSMF)'],
    ['Project Homepage', 'https://www.openstreetmap.org/'],
    [
      'Data License',
      'Open Database License (ODbL) 1.0 (https://opendatacommons.org/licenses/odbl/)',
    ],
    ['Mandatory Attribution', '© OpenStreetMap contributors'],
    ['Copyright & License Information', 'https://www.openstreetmap.org/copyright'],
    ['Data Access API', 'Overpass API (https://wiki.openstreetmap.org/wiki/Overpass_API)'],
    ['Export Timestamp', new Date().toISOString()],
    [
      'Legal & Compliance Notice',
      'This dataset is made available under the Open Database License. Any rights in individual contents of the database are licensed under the Database Contents License. When redistributing or publishing works based on this dataset, you must attribute OpenStreetMap contributors.',
    ],
  ];

  for (const [k, v] of attrData) {
    const row = wsAttr.addRow([k, v]);
    row.getCell(1).font = { bold: true };
    row.height = 20;
  }

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer);
}

export async function writeAndVerifyWorkbook(
  exportsDir: string,
  filename: string,
  buffer: Buffer,
): Promise<VerificationReceipt> {
  const safeFilename = path.basename(filename.trim());
  if (!safeFilename.endsWith('.xlsx')) {
    throw new Error('Workbook filename must end with .xlsx');
  }

  if (/[^a-zA-Z0-9_.-]/.test(safeFilename) || safeFilename.includes('..')) {
    throw new Error(`Invalid characters in filename: "${safeFilename}"`);
  }

  if (!existsSync(exportsDir)) {
    mkdirSync(exportsDir, { recursive: true });
  }

  const targetPath = path.join(exportsDir, safeFilename);

  // Exclusive creation: reject overwrite!
  if (existsSync(targetPath)) {
    throw new Error(`File already exists: "${targetPath}". Overwrite is prohibited.`);
  }

  // Write file with exclusive flag 'wx'
  writeFileSync(targetPath, buffer, { flag: 'wx' });

  // Read-back verification with ExcelJS
  const readBackWb = new WorkbookClass();
  await readBackWb.xlsx.readFile(targetPath);

  const sheetNames = readBackWb.worksheets.map((ws) => ws.name);
  const requiredSheets = ['Businesses', 'Search Summary', 'Sources and Attribution'];
  for (const req of requiredSheets) {
    if (!sheetNames.includes(req)) {
      throw new Error(`Verification failed: missing expected worksheet "${req}".`);
    }
  }

  const businessSheet = readBackWb.getWorksheet('Businesses');
  if (!businessSheet) {
    throw new Error('Verification failed: cannot retrieve Businesses worksheet.');
  }

  const rowCount = businessSheet.actualRowCount;
  const sampleCell = businessSheet.getCell('A3').value;
  let sampleBusinessName: string | null = null;
  if (typeof sampleCell === 'string') {
    sampleBusinessName = sampleCell;
  } else if (typeof sampleCell === 'number' || typeof sampleCell === 'boolean') {
    sampleBusinessName = String(sampleCell);
  } else if (sampleCell !== null && sampleCell !== undefined) {
    sampleBusinessName = JSON.stringify(sampleCell);
  }

  const writtenBytes = readFileSync(targetPath);
  const sha256 = createHash('sha256').update(writtenBytes).digest('hex');

  return {
    verified: true,
    targetPath,
    bytes: writtenBytes.length,
    sha256,
    sheetNames,
    businessRowCount: Math.max(0, rowCount - 2), // Minus 2 header rows
    sampleBusinessName,
  };
}
