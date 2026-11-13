import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
export type LogMetadata = Record<string, unknown>;

export interface LoggerOptions {
  level: LogLevel;
  logDir: string;
  service?: string;
  console?: boolean;
  file?: boolean;
  maxFileSizeBytes?: number;
  maxFiles?: number;
  now?: () => Date;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
}

export interface LoggerLike {
  debug(message: string, metadata?: LogMetadata): void;
  info(message: string, metadata?: LogMetadata): void;
  warn(message: string, metadata?: LogMetadata): void;
  error(message: string, metadata?: LogMetadata): void;
}

export const NOOP_LOGGER: LoggerLike = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

interface LogEntry {
  timestamp: string;
  level: LogLevel;
  service: string;
  message: string;
  metadata?: unknown;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

const LOG_FILE_NAME = 'jarvis.log';
const DEFAULT_MAX_FILE_SIZE_BYTES = 5 * 1024 * 1024;
const DEFAULT_MAX_FILES = 3;
const SENSITIVE_KEY_PATTERN =
  /(?:api[_-]?key|authorization|bearer|cookie|credential|passphrase|password|passwd|private[_-]?key|secret|session[_-]?id|token)/i;

export class Logger {
  private readonly level: LogLevel;
  private readonly logDir: string;
  private readonly service: string;
  private readonly consoleEnabled: boolean;
  private readonly fileEnabled: boolean;
  private readonly maxFileSizeBytes: number;
  private readonly maxFiles: number;
  private readonly now: () => Date;
  private readonly stdout: (line: string) => void;
  private readonly stderr: (line: string) => void;
  private readonly bindings: LogMetadata;
  private readonly filePath: string;

  public constructor(options: LoggerOptions, bindings: LogMetadata = {}) {
    this.level = options.level;
    this.logDir = options.logDir;
    this.service = options.service ?? 'jarvis';
    this.consoleEnabled = options.console ?? true;
    this.fileEnabled = options.file ?? true;
    this.maxFileSizeBytes = options.maxFileSizeBytes ?? DEFAULT_MAX_FILE_SIZE_BYTES;
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.now = options.now ?? (() => new Date());
    this.stdout =
      options.stdout ??
      ((line: string) => {
        process.stdout.write(line);
      });
    this.stderr =
      options.stderr ??
      ((line: string) => {
        process.stderr.write(line);
      });
    this.bindings = bindings;
    this.filePath = join(this.logDir, LOG_FILE_NAME);

    if (this.maxFileSizeBytes < 1) {
      throw new Error('maxFileSizeBytes must be at least 1');
    }

    if (this.maxFiles < 1) {
      throw new Error('maxFiles must be at least 1');
    }

    if (this.fileEnabled) {
      mkdirSync(this.logDir, { recursive: true });
    }
  }

  public child(bindings: LogMetadata): Logger {
    return new Logger(
      {
        level: this.level,
        logDir: this.logDir,
        service: this.service,
        console: this.consoleEnabled,
        file: this.fileEnabled,
        maxFileSizeBytes: this.maxFileSizeBytes,
        maxFiles: this.maxFiles,
        now: this.now,
        stdout: this.stdout,
        stderr: this.stderr,
      },
      { ...this.bindings, ...bindings },
    );
  }

  public debug(message: string, metadata?: LogMetadata): void {
    this.write('debug', message, metadata);
  }

  public info(message: string, metadata?: LogMetadata): void {
    this.write('info', message, metadata);
  }

  public warn(message: string, metadata?: LogMetadata): void {
    this.write('warn', message, metadata);
  }

  public error(message: string, metadata?: LogMetadata): void {
    this.write('error', message, metadata);
  }

  private write(level: LogLevel, message: string, metadata?: LogMetadata): void {
    if (!this.shouldLog(level)) {
      return;
    }

    const entry: LogEntry = {
      timestamp: this.now().toISOString(),
      level,
      service: this.service,
      message: redactString(message),
    };
    const mergedMetadata = { ...this.bindings, ...metadata };

    if (Object.keys(mergedMetadata).length > 0) {
      entry.metadata = redactSensitive(mergedMetadata);
    }

    const line = `${JSON.stringify(entry)}\n`;

    if (this.consoleEnabled) {
      if (level === 'warn' || level === 'error') {
        this.stderr(line);
      } else {
        this.stdout(line);
      }
    }

    if (this.fileEnabled) {
      try {
        this.rotateIfNeeded();
        appendFileSync(this.filePath, line, 'utf8');
      } catch (error) {
        this.stderr(`[logger] failed to write log file: ${formatUnknownError(error)}\n`);
      }
    }
  }

  private shouldLog(level: LogLevel): boolean {
    return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[this.level];
  }

  private rotateIfNeeded(): void {
    if (!existsSync(this.filePath)) {
      return;
    }

    const { size } = statSync(this.filePath);

    if (size < this.maxFileSizeBytes) {
      return;
    }

    rmSync(`${this.filePath}.${String(this.maxFiles)}`, { force: true });

    for (let index = this.maxFiles - 1; index >= 1; index -= 1) {
      const source = `${this.filePath}.${String(index)}`;

      if (!existsSync(source)) {
        continue;
      }

      const target = `${this.filePath}.${String(index + 1)}`;
      rmSync(target, { force: true });
      renameSync(source, target);
    }

    renameSync(this.filePath, `${this.filePath}.1`);
  }
}

export function redactSensitive(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (typeof value === 'string') {
    return redactString(value);
  }

  if (value instanceof Error) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    return {
      name: value.name,
      message: redactString(value.message),
      stack: value.stack === undefined ? undefined : redactString(value.stack),
      cause: value.cause === undefined ? undefined : redactValue(value.cause, seen),
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    return value.map((item) => redactValue(item, seen));
  }

  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return '[Circular]';
    }

    seen.add(value);

    const result: Record<string, unknown> = {};

    for (const [key, nestedValue] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY_PATTERN.test(key) ? '[REDACTED]' : redactValue(nestedValue, seen);
    }

    return result;
  }

  return value;
}

function redactString(value: string): string {
  return value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, '[REDACTED]')
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, '[REDACTED]')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi, '$1[REDACTED]@');
}

function formatUnknownError(error: unknown): string {
  return error instanceof Error ? redactString(error.message) : 'Unknown logger file error';
}
