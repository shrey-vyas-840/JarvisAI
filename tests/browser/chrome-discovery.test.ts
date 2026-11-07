import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';

import {
  discoverChromeProfiles,
  hasPlaywriterExtensionInstalled,
  launchChromeProfile,
  PLAYWRITER_EXTENSION_ID,
} from '../../src/browser/chrome-discovery.js';

describe('Chrome Profile Discovery', () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'jarvis-chrome-test-'));
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Cleanup best effort
    }
  });

  it('discovers profiles from valid Local State metadata', () => {
    const localState = {
      profile: {
        info_cache: {
          'Profile 1': {
            name: 'Personal',
            user_name: 'test@example.com',
          },
          'Profile 2': {
            name: 'Work',
            gaia_name: 'Work User',
          },
          Default: {
            name: 'Default User',
          },
        },
      },
    };

    writeFileSync(path.join(tempDir, 'Local State'), JSON.stringify(localState), 'utf8');

    // Create extension folder for Profile 2
    const extDir = path.join(tempDir, 'Profile 2', 'Extensions', PLAYWRITER_EXTENSION_ID);
    mkdirSync(extDir, { recursive: true });

    const result = discoverChromeProfiles({ userDataDir: tempDir });

    expect(result.profiles).toHaveLength(3);
    // Deterministic sorting puts Default first
    expect(result.profiles[0]?.directory).toBe('Default');
    expect(result.profiles[0]?.name).toBe('Default User');
    expect(result.profiles[0]?.hasPlaywriterExtension).toBe(false);

    const workProfile = result.profiles.find((p) => p.directory === 'Profile 2');
    expect(workProfile).toBeDefined();
    expect(workProfile?.name).toBe('Work');
    expect(workProfile?.hasPlaywriterExtension).toBe(true);

    const personalProfile = result.profiles.find((p) => p.directory === 'Profile 1');
    expect(personalProfile).toBeDefined();
    expect(personalProfile?.email).toBe('test@example.com');
  });

  it('handles missing Local State gracefully and discovers directory folders', () => {
    mkdirSync(path.join(tempDir, 'Default'), { recursive: true });
    mkdirSync(path.join(tempDir, 'Profile 1'), { recursive: true });

    const result = discoverChromeProfiles({ userDataDir: tempDir });
    expect(result.profiles).toHaveLength(2);
    expect(result.profiles[0]?.directory).toBe('Default');
    expect(result.profiles[1]?.directory).toBe('Profile 1');
  });

  it('handles corrupted JSON in Local State without crashing', () => {
    writeFileSync(path.join(tempDir, 'Local State'), '{ invalid json ...', 'utf8');
    mkdirSync(path.join(tempDir, 'Profile 1'), { recursive: true });

    const result = discoverChromeProfiles({ userDataDir: tempDir });
    expect(result.profiles).toHaveLength(1);
    expect(result.profiles[0]?.directory).toBe('Profile 1');
  });

  it('correctly detects presence of Playwriter extension', () => {
    const extDir = path.join(tempDir, 'Profile 1', 'Extensions', PLAYWRITER_EXTENSION_ID);
    mkdirSync(extDir, { recursive: true });

    expect(hasPlaywriterExtensionInstalled(tempDir, 'Profile 1')).toBe(true);
    expect(hasPlaywriterExtensionInstalled(tempDir, 'Profile 2')).toBe(false);
  });

  it('rejects unsafe profile names in launcher', () => {
    const fakeExe = path.join(tempDir, 'fake-chrome.exe');
    writeFileSync(fakeExe, 'binary', 'utf8');

    const badResult1 = launchChromeProfile('Profile 1; rm -rf /', { executablePath: fakeExe });
    expect(badResult1.success).toBe(false);
    expect(badResult1.error).toContain('Invalid profile directory name');

    const badResult2 = launchChromeProfile('../secret', { executablePath: fakeExe });
    expect(badResult2.success).toBe(false);
    expect(badResult2.error).toContain('Invalid profile directory name');
  });

  it('returns failure when Chrome executable is not found', () => {
    const result = launchChromeProfile('Profile 1', {
      executablePath: path.join(tempDir, 'nonexistent-chrome.exe'),
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('Chrome executable could not be found');
  });
});
