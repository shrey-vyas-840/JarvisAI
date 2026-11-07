import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  buildBusinessWorkbookBuffer,
  writeAndVerifyWorkbook,
} from '../../src/export/excel-builder.js';
import type { OsmBusinessRecord } from '../../src/geo/osm-types.js';

describe('Excel Workbook Generation & Verification', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'jarvis-excel-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Best effort cleanup
    }
  });

  const mockBusinesses: OsmBusinessRecord[] = [
    {
      name: 'Agashiye',
      category: 'restaurants',
      address: 'The House of MG, Opp. Sidi Saiyyed Mosque',
      postcode: '380001',
      locality: 'Lal Darwaja',
      city: 'Ahmedabad',
      phone: '+91 79 25506941',
      website: 'https://houseofmg.com/agashiye',
      openingHours: 'Mo-Su 12:00-15:30,19:00-23:00',
      latitude: 23.0286,
      longitude: 72.5802,
      sourceId: 'node/1001',
      sourceUrl: 'https://www.openstreetmap.org/node/1001',
      dataSource: 'OpenStreetMap',
      dataLicense: 'Open Database License (ODbL) 1.0',
      attribution: '© OpenStreetMap contributors',
      retrievalTimestamp: '2026-11-07T12:00:00Z',
    },
    {
      name: 'Gordhan Thal',
      category: 'restaurants',
      address: 'SG Highway',
      postcode: '380054',
      locality: 'Bodakdev',
      city: 'Ahmedabad',
      phone: null,
      website: null,
      openingHours: null,
      latitude: 23.045,
      longitude: 72.512,
      sourceId: 'node/1002',
      sourceUrl: 'https://www.openstreetmap.org/node/1002',
      dataSource: 'OpenStreetMap',
      dataLicense: 'Open Database License (ODbL) 1.0',
      attribution: '© OpenStreetMap contributors',
      retrievalTimestamp: '2026-11-07T12:00:00Z',
    },
  ];

  it('builds an in-memory workbook buffer with 3 properly structured worksheets', async () => {
    const buffer = await buildBusinessWorkbookBuffer({
      businesses: mockBusinesses,
      searchRequest: 'Find traditional restaurants in Ahmedabad',
      region: 'Ahmedabad',
      category: 'restaurants',
    });

    expect(buffer).toBeInstanceOf(Buffer);
    expect(buffer.length).toBeGreaterThan(1000);
  });

  it('writes and verifies workbook round-trip', async () => {
    const buffer = await buildBusinessWorkbookBuffer({
      businesses: mockBusinesses,
      searchRequest: 'Find traditional restaurants in Ahmedabad',
      region: 'Ahmedabad',
      category: 'restaurants',
    });

    const receipt = await writeAndVerifyWorkbook(tempDir, 'ahmedabad_restaurants.xlsx', buffer);

    expect(receipt.verified).toBe(true);
    expect(receipt.businessRowCount).toBe(2);
    expect(receipt.sampleBusinessName).toBe('Agashiye');
    expect(receipt.sheetNames).toEqual(['Businesses', 'Search Summary', 'Sources and Attribution']);
    expect(receipt.bytes).toBeGreaterThan(1000);
    expect(receipt.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it('strictly rejects overwriting an existing workbook file', async () => {
    const buffer = await buildBusinessWorkbookBuffer({
      businesses: mockBusinesses,
      searchRequest: 'Test',
      region: 'Ahmedabad',
      category: 'restaurants',
    });

    await writeAndVerifyWorkbook(tempDir, 'existing.xlsx', buffer);

    // Second write attempt with the same filename must be rejected
    await expect(writeAndVerifyWorkbook(tempDir, 'existing.xlsx', buffer)).rejects.toThrow(
      /File already exists.*Overwrite is prohibited/,
    );
  });

  it('rejects directory traversal and unsafe filenames', async () => {
    const buffer = Buffer.from('dummy');
    await expect(writeAndVerifyWorkbook(tempDir, '../outside.xlsx', buffer)).rejects.toThrow();
    await expect(writeAndVerifyWorkbook(tempDir, 'report.csv', buffer)).rejects.toThrow(
      /must end with .xlsx/,
    );
  });
});
