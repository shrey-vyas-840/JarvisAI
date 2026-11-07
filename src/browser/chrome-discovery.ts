import { spawn, execSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import type { ChromeDiscoveryResult, ChromeProfileInfo } from './types.js';

export const PLAYWRITER_EXTENSION_ID = 'jfeammnjpkecdekppnclgkkffahnhfhe';

export interface ChromeDiscoveryOptions {
  readonly userDataDir?: string | undefined;
  readonly executablePath?: string | undefined;
}

export function getDefaultUserDataDir(): string {
  const localAppData =
    process.env.LOCALAPPDATA ?? path.join(process.env.USERPROFILE ?? '', 'AppData', 'Local');
  return path.join(localAppData, 'Google', 'Chrome', 'User Data');
}

export function findChromeExecutable(customPath?: string): string | null {
  if (customPath !== undefined) {
    return existsSync(customPath) ? customPath : null;
  }

  const standardPaths = [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
    path.join(process.env.LOCALAPPDATA ?? '', 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ];

  for (const p of standardPaths) {
    if (p && existsSync(p)) {
      return p;
    }
  }

  if (process.platform === 'win32') {
    try {
      const regOutput = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe" /ve',
        { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
      );
      const match = /REG_SZ\s+(.+)$/m.exec(regOutput);
      if (match?.[1]) {
        const resolved = match[1].trim();
        if (existsSync(resolved)) {
          return resolved;
        }
      }
    } catch {
      // Ignore registry query failures
    }
  }

  return null;
}

export function isChromeRunning(): boolean {
  if (process.platform !== 'win32') {
    return false;
  }

  try {
    const tasklistOutput = execSync('tasklist /FI "IMAGENAME eq chrome.exe" /NH', {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'ignore'],
      timeout: 3000,
    });
    return tasklistOutput.toLowerCase().includes('chrome.exe');
  } catch {
    return false;
  }
}

export function hasPlaywriterExtensionInstalled(userDataDir: string, profileDir: string): boolean {
  try {
    const extensionDir = path.join(userDataDir, profileDir, 'Extensions', PLAYWRITER_EXTENSION_ID);
    return existsSync(extensionDir);
  } catch {
    return false;
  }
}

interface RawProfileEntry {
  readonly name?: string;
  readonly shortcut_name?: string;
  readonly gaia_name?: string;
  readonly user_name?: string;
  readonly last_downloaded_gaia_picture_url_with_size?: string;
}

interface RawLocalState {
  readonly profile?: {
    readonly info_cache?: Record<string, RawProfileEntry>;
  };
}

export function discoverChromeProfiles(
  options: ChromeDiscoveryOptions = {},
): ChromeDiscoveryResult {
  const userDataDir = options.userDataDir ?? getDefaultUserDataDir();
  const executablePath = findChromeExecutable(options.executablePath);
  const chromeRunning = isChromeRunning();

  const profiles: ChromeProfileInfo[] = [];

  if (!existsSync(userDataDir)) {
    return {
      executablePath,
      userDataDir,
      profiles: [],
      isChromeRunning: chromeRunning,
    };
  }

  const localStatePath = path.join(userDataDir, 'Local State');
  const discoveredDirs = new Set<string>();

  if (existsSync(localStatePath)) {
    try {
      const content = readFileSync(localStatePath, 'utf8');
      const parsed = JSON.parse(content) as RawLocalState;
      const infoCache = parsed.profile?.info_cache ?? {};

      for (const [dirKey, entry] of Object.entries(infoCache)) {
        discoveredDirs.add(dirKey);
        const displayName = entry.name ?? entry.shortcut_name ?? entry.gaia_name ?? dirKey;
        const hasExtension = hasPlaywriterExtensionInstalled(userDataDir, dirKey);

        profiles.push({
          directory: dirKey,
          name: displayName,
          gaiaName: entry.gaia_name,
          email: entry.user_name,
          avatarUrl: entry.last_downloaded_gaia_picture_url_with_size,
          hasPlaywriterExtension: hasExtension,
          isChromeRunning: chromeRunning,
        });
      }
    } catch {
      // Local state could not be parsed; fallback to checking directory list
    }
  }

  // Also check if directories like "Default" exist on disk if not found in info_cache
  try {
    const diskEntries = readdirSync(userDataDir, { withFileTypes: true });
    for (const entry of diskEntries) {
      if (entry.isDirectory()) {
        const name = entry.name;
        if ((name === 'Default' || name.startsWith('Profile ')) && !discoveredDirs.has(name)) {
          discoveredDirs.add(name);
          const hasExtension = hasPlaywriterExtensionInstalled(userDataDir, name);
          profiles.push({
            directory: name,
            name,
            hasPlaywriterExtension: hasExtension,
            isChromeRunning: chromeRunning,
          });
        }
      }
    }
  } catch {
    // Ignore readdir error
  }

  // Sort profiles deterministically: Default first, then numerical Profile N
  profiles.sort((a, b) => {
    if (a.directory === 'Default') return -1;
    if (b.directory === 'Default') return 1;
    return a.directory.localeCompare(b.directory, undefined, { numeric: true });
  });

  return {
    executablePath,
    userDataDir,
    profiles,
    isChromeRunning: chromeRunning,
  };
}

export interface LaunchProfileResult {
  readonly success: boolean;
  readonly executablePath: string;
  readonly profileDirectory: string;
  readonly pid?: number | undefined;
  readonly error?: string | undefined;
}

export function launchChromeProfile(
  profileDirectory: string,
  options: ChromeDiscoveryOptions = {},
): LaunchProfileResult {
  const executablePath = findChromeExecutable(options.executablePath);
  if (!executablePath) {
    return {
      success: false,
      executablePath: '',
      profileDirectory,
      error: 'Chrome executable could not be found on this system.',
    };
  }

  // Sanitize profile directory parameter - must be simple directory name like "Profile 4" or "Default"
  if (/[\r\n"';&|`$]/.test(profileDirectory) || profileDirectory.includes('..')) {
    return {
      success: false,
      executablePath,
      profileDirectory,
      error: 'Invalid profile directory name.',
    };
  }

  try {
    const child = spawn(executablePath, [`--profile-directory=${profileDirectory}`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: false,
    });
    child.unref();

    return {
      success: true,
      executablePath,
      profileDirectory,
      pid: child.pid,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown launch failure';
    return {
      success: false,
      executablePath,
      profileDirectory,
      error: message,
    };
  }
}
