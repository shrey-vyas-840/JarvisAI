export type BrowserErrorCode =
  | 'relay-unavailable'
  | 'extension-disconnected'
  | 'browser-not-registered'
  | 'no-matching-browser'
  | 'no-enabled-tabs'
  | 'session-init-failed'
  | 'stale-session'
  | 'navigation-failed'
  | 'readiness-timeout';

export interface BrowserErrorOptions {
  readonly cause?: unknown;
  readonly details?: Record<string, unknown> | undefined;
}

export class BrowserError extends Error {
  public readonly code: BrowserErrorCode;
  public readonly details: Record<string, unknown> | undefined;

  public constructor(code: BrowserErrorCode, message: string, options: BrowserErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'BrowserError';
    this.code = code;
    this.details = options.details;
  }
}

export function isBrowserError(error: unknown): error is BrowserError {
  return error instanceof BrowserError;
}

export function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'Unknown error';
}

export function isStaleSessionError(message: string): boolean {
  const normalized = message.toLowerCase();
  return [
    'target page, context or browser has been closed',
    'target closed',
    'session closed',
    'browser has been closed',
    'has been closed',
    'not connected',
    'websocket is already closed',
    'websocket closed',
    'connection closed',
    'execution context was destroyed',
    'cannot find context',
    'detached from the target',
  ].some((fragment) => normalized.includes(fragment));
}
