import { FilesystemError } from './path-guard.js';

const SENSITIVE_FILE_PATTERNS: readonly RegExp[] = [
  /^\.env(?:\..*)?$/i,
  /^id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?$/i,
  /^\.?netrc$/i,
  /^\.git-credentials$/i,
  /^\.npmrc$/i,
  /^\.pypirc$/i,
  /^\.htpasswd$/i,
  /^credentials(?:\..*)?$/i,
  /^secrets?(?:\..*)?$/i,
  /^passwords?(?:\..*)?$/i,
  /^login data$/i,
  /\.(?:pem|key|pfx|p12|jks|keystore|kdbx|kdb|ppk|gpg|asc|keychain|ovpn)$/i,
];

const MAX_BINARY_SAMPLE_BYTES = 8192;
const MAX_CONTROL_CHARACTER_RATIO = 0.1;
const SENSITIVE_DIRECTORY_NAME =
  /^(?:\.ssh|\.aws|\.azure|\.gnupg|\.kube|\.docker|\.password-store)$/i;

export function isSensitiveFileName(name: string): boolean {
  return SENSITIVE_FILE_PATTERNS.some((pattern) => pattern.test(name));
}

export function isSensitiveDirectoryName(name: string): boolean {
  return SENSITIVE_DIRECTORY_NAME.test(name);
}

export function isSensitivePath(relativePath: string): boolean {
  return relativePath
    .split(/[\\/]/)
    .filter((part) => part.length > 0)
    .some((part) => isSensitiveFileName(part) || isSensitiveDirectoryName(part));
}

export function isLikelyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, MAX_BINARY_SAMPLE_BYTES));

  if (sample.length === 0) {
    return false;
  }

  if (sample.includes(0)) {
    return true;
  }

  let controlCount = 0;

  for (const byte of sample) {
    if (byte === 9 || byte === 10 || byte === 13) {
      continue;
    }

    if (byte < 32 || byte === 127) {
      controlCount += 1;
    }
  }

  return controlCount / sample.length > MAX_CONTROL_CHARACTER_RATIO;
}

export function tryDecodeUtf8(buffer: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    return null;
  }
}

export function decodeUtf8OrThrow(buffer: Buffer): string {
  const text = tryDecodeUtf8(buffer);

  if (text === null) {
    throw new FilesystemError(
      'unsupported_encoding',
      'File is not valid UTF-8 text and cannot be read safely',
    );
  }

  return text;
}

export function assertReadableTextFile(name: string, buffer: Buffer): string {
  if (isSensitiveFileName(name)) {
    throw new FilesystemError(
      'sensitive_file',
      'Files that may contain credentials or private keys are not readable',
    );
  }

  if (isLikelyBinary(buffer)) {
    throw new FilesystemError('binary_file', 'Binary files are not readable as text');
  }

  return decodeUtf8OrThrow(buffer);
}
