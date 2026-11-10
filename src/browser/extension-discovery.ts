import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';

import { getDefaultUserDataDir, PLAYWRITER_EXTENSION_ID } from './chrome-discovery.js';

export interface ChromeExtensionInfo {
  readonly id: string;
  readonly name: string;
  readonly version: string;
  readonly profileDirectory: string;
  readonly profileName: string | null;
  readonly isPlaywriter: boolean;
}

export interface ChromeExtensionDiscoveryResult {
  readonly userDataDir: string;
  readonly extensions: readonly ChromeExtensionInfo[];
}

export interface ExtensionDiscoveryOptions {
  readonly userDataDir?: string | undefined;
}

interface RawManifest {
  readonly name?: unknown;
  readonly version?: unknown;
  readonly default_locale?: unknown;
}

interface RawMessageEntry {
  readonly message?: unknown;
}

const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
const PROFILE_PATTERN = /^(Default|Profile \d+)$/;

export function discoverChromeExtensions(
  options: ExtensionDiscoveryOptions = {},
): ChromeExtensionDiscoveryResult {
  const userDataDir = options.userDataDir ?? getDefaultUserDataDir();

  if (!existsSync(userDataDir)) {
    return { userDataDir, extensions: [] };
  }

  const profileNames = readProfileNames(userDataDir);
  const extensions: ChromeExtensionInfo[] = [];

  for (const profileDirectory of listProfileDirectories(userDataDir)) {
    const extensionsDir = path.join(userDataDir, profileDirectory, 'Extensions');

    if (!existsSync(extensionsDir)) {
      continue;
    }

    for (const extensionId of listDirectoryNames(extensionsDir)) {
      if (!EXTENSION_ID_PATTERN.test(extensionId)) {
        continue;
      }

      const extensionDir = path.join(extensionsDir, extensionId);
      const versionDir = findLatestVersionDirectory(extensionDir);

      if (versionDir === null) {
        continue;
      }

      const manifestPath = path.join(extensionDir, versionDir, 'manifest.json');
      const manifest = readManifest(manifestPath);

      if (manifest === null) {
        continue;
      }

      const rawName = typeof manifest.name === 'string' ? manifest.name : extensionId;
      const resolvedName = resolveExtensionName(
        manifest,
        rawName,
        path.join(extensionDir, versionDir),
      );

      extensions.push({
        id: extensionId,
        name: resolvedName,
        version: typeof manifest.version === 'string' ? manifest.version : versionDir,
        profileDirectory,
        profileName: profileNames.get(profileDirectory) ?? null,
        isPlaywriter: extensionId === PLAYWRITER_EXTENSION_ID,
      });
    }
  }

  extensions.sort((a, b) => {
    const profileCompare = a.profileDirectory.localeCompare(b.profileDirectory, undefined, {
      numeric: true,
    });
    if (profileCompare !== 0) {
      return profileCompare;
    }
    return a.name.localeCompare(b.name);
  });

  return { userDataDir, extensions };
}

function listProfileDirectories(userDataDir: string): string[] {
  return listDirectoryNames(userDataDir).filter((name) => PROFILE_PATTERN.test(name));
}

function listDirectoryNames(directory: string): string[] {
  try {
    return readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function findLatestVersionDirectory(extensionDir: string): string | null {
  const versions = listDirectoryNames(extensionDir);

  if (versions.length === 0) {
    return null;
  }

  versions.sort(compareVersions);
  return versions[versions.length - 1] ?? null;
}

function readManifest(manifestPath: string): RawManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;

    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      return null;
    }

    return parsed;
  } catch {
    return null;
  }
}

function resolveExtensionName(
  manifest: RawManifest,
  rawName: string,
  extensionRoot: string,
): string {
  const messageKey = /^__MSG_(.+)__$/.exec(rawName.trim())?.[1];

  if (messageKey !== undefined) {
    const locale =
      typeof manifest.default_locale === 'string' && manifest.default_locale.trim().length > 0
        ? manifest.default_locale.trim()
        : 'en';
    const localized = readLocalizedMessage(extensionRoot, locale, messageKey);

    if (localized !== null) {
      return sanitizeName(localized);
    }
  }

  return sanitizeName(rawName);
}

function readLocalizedMessage(
  extensionRoot: string,
  locale: string,
  messageKey: string,
): string | null {
  const locales = [...new Set([locale, 'en', 'en_US'])];

  for (const candidateLocale of locales) {
    const messagesPath = path.join(extensionRoot, '_locales', candidateLocale, 'messages.json');

    try {
      const parsed = JSON.parse(readFileSync(messagesPath, 'utf8')) as unknown;

      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        continue;
      }

      const normalizedKey = messageKey.toLowerCase();

      for (const [key, value] of Object.entries(parsed as Record<string, RawMessageEntry>)) {
        if (key.toLowerCase() !== normalizedKey) {
          continue;
        }

        if (typeof value.message === 'string' && value.message.trim().length > 0) {
          return value.message;
        }
      }
    } catch {
      // Try the next locale.
    }
  }

  return null;
}

function sanitizeName(name: string): string {
  const cleaned = name
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return cleaned.length > 0 ? cleaned.slice(0, 120) : 'Unnamed extension';
}

function readProfileNames(userDataDir: string): Map<string, string> {
  const result = new Map<string, string>();
  const localStatePath = path.join(userDataDir, 'Local State');

  try {
    const parsed = JSON.parse(readFileSync(localStatePath, 'utf8')) as {
      profile?: {
        info_cache?: Record<string, { name?: unknown; gaia_name?: unknown }>;
      };
    };
    const infoCache = parsed.profile?.info_cache ?? {};

    for (const [directory, entry] of Object.entries(infoCache)) {
      const name =
        typeof entry.name === 'string'
          ? entry.name
          : typeof entry.gaia_name === 'string'
            ? entry.gaia_name
            : null;

      if (name !== null && name.trim().length > 0) {
        result.set(directory, sanitizeName(name));
      }
    }
  } catch {
    // Profile names are optional metadata.
  }

  return result;
}

function compareVersions(left: string, right: string): number {
  const leftParts = left.split('.');
  const rightParts = right.split('.');
  const length = Math.max(leftParts.length, rightParts.length);

  for (let index = 0; index < length; index += 1) {
    const leftPart = leftParts[index] ?? '0';
    const rightPart = rightParts[index] ?? '0';
    const leftNumber = Number.parseInt(leftPart, 10);
    const rightNumber = Number.parseInt(rightPart, 10);

    if (Number.isNaN(leftNumber) || Number.isNaN(rightNumber)) {
      const textCompare = leftPart.localeCompare(rightPart, undefined, { numeric: true });
      if (textCompare !== 0) {
        return textCompare;
      }
      continue;
    }

    if (leftNumber !== rightNumber) {
      return leftNumber - rightNumber;
    }
  }

  return 0;
}
