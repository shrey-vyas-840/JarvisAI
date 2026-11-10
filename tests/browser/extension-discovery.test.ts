import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { discoverChromeExtensions } from '../../src/browser/extension-discovery.js';
import { PLAYWRITER_EXTENSION_ID } from '../../src/browser/chrome-discovery.js';

const SECOND_EXTENSION_ID = 'abcdefghijklmnopabcdefghijklmnop';

describe('Chrome extension discovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'jarvis-extension-test-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  function writeExtension(
    profile: string,
    id: string,
    version: string,
    manifest: Record<string, unknown>,
    messages?: Record<string, { message: string }>,
  ): void {
    const root = path.join(tempDir, profile, 'Extensions', id, version);
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, 'manifest.json'), JSON.stringify(manifest), 'utf8');

    if (messages) {
      const localeDir = path.join(root, '_locales', 'en');
      mkdirSync(localeDir, { recursive: true });
      writeFileSync(path.join(localeDir, 'messages.json'), JSON.stringify(messages), 'utf8');
    }
  }

  it('reads only extension metadata and resolves localized names', () => {
    writeFileSync(
      path.join(tempDir, 'Local State'),
      JSON.stringify({
        profile: {
          info_cache: {
            'Profile 4': { name: 'Work' },
          },
        },
      }),
      'utf8',
    );
    writeExtension('Profile 4', PLAYWRITER_EXTENSION_ID, '0.0.170', {
      name: 'Playwriter',
      version: '0.0.170',
    });
    writeExtension(
      'Profile 4',
      SECOND_EXTENSION_ID,
      '2.0.3',
      {
        name: '__MSG_extension_name__',
        version: '2.0.3',
        default_locale: 'en',
      },
      {
        extension_name: { message: 'Salesforce Inspector Reloaded' },
      },
    );

    const result = discoverChromeExtensions({ userDataDir: tempDir });

    expect(result.extensions).toHaveLength(2);
    expect(result.extensions[0]).toEqual({
      id: PLAYWRITER_EXTENSION_ID,
      name: 'Playwriter',
      version: '0.0.170',
      profileDirectory: 'Profile 4',
      profileName: 'Work',
      isPlaywriter: true,
    });
    expect(result.extensions[1]?.name).toBe('Salesforce Inspector Reloaded');
    expect(result.extensions[1]?.isPlaywriter).toBe(false);
  });

  it('selects the highest numeric version directory', () => {
    writeExtension('Default', SECOND_EXTENSION_ID, '1.9.0', {
      name: 'Old',
      version: '1.9.0',
    });
    writeExtension('Default', SECOND_EXTENSION_ID, '1.10.0', {
      name: 'New',
      version: '1.10.0',
    });

    const result = discoverChromeExtensions({ userDataDir: tempDir });
    expect(result.extensions).toHaveLength(1);
    expect(result.extensions[0]?.name).toBe('New');
    expect(result.extensions[0]?.version).toBe('1.10.0');
  });

  it('ignores invalid extension identifiers and corrupt manifests', () => {
    mkdirSync(path.join(tempDir, 'Default', 'Extensions', 'not-an-extension', '1.0.0'), {
      recursive: true,
    });
    const corruptDir = path.join(tempDir, 'Default', 'Extensions', SECOND_EXTENSION_ID, '1.0.0');
    mkdirSync(corruptDir, { recursive: true });
    writeFileSync(path.join(corruptDir, 'manifest.json'), '{ corrupt', 'utf8');

    expect(discoverChromeExtensions({ userDataDir: tempDir }).extensions).toEqual([]);
  });
});
