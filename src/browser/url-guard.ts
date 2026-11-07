export interface UrlValidationResult {
  readonly valid: boolean;
  readonly sanitizedUrl?: string;
  readonly error?: string;
}

export interface UrlGuardOptions {
  readonly allowLocalhost?: boolean;
}

const FORBIDDEN_SCHEMES = new Set([
  'javascript:',
  'file:',
  'data:',
  'vbscript:',
  'about:',
  'blob:',
]);

const PRIVATE_IP_PATTERNS = [
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2[0-9]|3[0-1])\./,
  /^169\.254\./,
  /^::1$/,
  /^fc00:/i,
  /^fe80:/i,
];

export function validateBrowserUrl(
  rawUrl: string,
  options: UrlGuardOptions = {},
): UrlValidationResult {
  const trimmed = rawUrl.trim();
  if (!trimmed) {
    return { valid: false, error: 'URL cannot be empty.' };
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { valid: false, error: `Invalid URL format: "${trimmed}".` };
  }

  const protocol = parsed.protocol.toLowerCase();
  if (FORBIDDEN_SCHEMES.has(protocol)) {
    return {
      valid: false,
      error: `Security restriction: Dangerous or disallowed URL scheme "${protocol}" is prohibited.`,
    };
  }

  if (protocol !== 'http:' && protocol !== 'https:') {
    return {
      valid: false,
      error: `Disallowed URL protocol "${protocol}". Only http: and https: protocols are permitted.`,
    };
  }

  const hostname = parsed.hostname.toLowerCase();
  const hostClean = hostname.replace(/^\[|\]$/g, '');
  if (!hostname) {
    return { valid: false, error: 'URL must include a valid host name.' };
  }

  if (!options.allowLocalhost) {
    if (hostClean === 'localhost' || hostClean === '0.0.0.0') {
      return {
        valid: false,
        error: `Security restriction: Access to localhost or loopback ("${hostname}") is blocked.`,
      };
    }

    for (const pattern of PRIVATE_IP_PATTERNS) {
      if (pattern.test(hostClean)) {
        return {
          valid: false,
          error: `Security restriction: Navigation to private/local network address ("${hostname}") is prohibited.`,
        };
      }
    }
  }

  return {
    valid: true,
    sanitizedUrl: parsed.href,
  };
}
