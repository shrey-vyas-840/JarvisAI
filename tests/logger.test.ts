import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { Logger } from '../src/logging/logger.js';

const fixedNow = () => new Date('2026-11-07T00:00:00.000Z');
const createdDirs: string[] = [];

function makeLogDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-logger-'));
  createdDirs.push(dir);
  return dir;
}

function readLog(dir: string): string {
  return readFileSync(join(dir, 'jarvis.log'), 'utf8');
}

afterEach(() => {
  for (const dir of createdDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('logger', () => {
  it('writes structured entries and redacts secrets', () => {
    const logDir = makeLogDir();
    const logger = new Logger({ level: 'debug', logDir, console: false, now: fixedNow });

    logger.info('hello', {
      password: 'hunter2',
      nested: { token: 'tok_live_123', safe: 'ok' },
      user: 'shrey',
    });

    const content = readLog(logDir);

    expect(content).toContain('"timestamp":"2026-11-07T00:00:00.000Z"');
    expect(content).toContain('"level":"info"');
    expect(content).toContain('"service":"jarvis"');
    expect(content).toContain('"message":"hello"');
    expect(content).toContain('"password":"[REDACTED]"');
    expect(content).toContain('"token":"[REDACTED]"');
    expect(content).toContain('"safe":"ok"');
    expect(content).toContain('"user":"shrey"');
    expect(content).not.toContain('hunter2');
    expect(content).not.toContain('tok_live_123');
  });

  it('redacts secrets in errors', () => {
    const logDir = makeLogDir();
    const logger = new Logger({ level: 'info', logDir, console: false, now: fixedNow });

    logger.error('request failed', {
      error: new Error('Authorization: Bearer abc'),
    });

    const content = readLog(logDir);

    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('abc');
  });

  it('filters messages below the configured level', () => {
    const logDir = makeLogDir();
    const logger = new Logger({ level: 'warn', logDir, console: false, now: fixedNow });

    logger.debug('debug message');
    logger.info('info message');

    expect(existsSync(join(logDir, 'jarvis.log'))).toBe(false);

    logger.warn('warn message');

    const content = readLog(logDir);

    expect(content).toContain('"level":"warn"');
    expect(content).not.toContain('debug message');
    expect(content).not.toContain('info message');
  });

  it('writes console output to the correct stream and redacts secrets', () => {
    const logDir = makeLogDir();
    const stdout: string[] = [];
    const stderr: string[] = [];
    const logger = new Logger({
      level: 'debug',
      logDir,
      file: false,
      now: fixedNow,
      stdout: (line: string) => {
        stdout.push(line);
      },
      stderr: (line: string) => {
        stderr.push(line);
      },
    });

    logger.info('info message', { apiKey: 'abc' });
    logger.error('error message', { token: 'def' });

    expect(stdout.join('')).toContain('"apiKey":"[REDACTED]"');
    expect(stdout.join('')).not.toContain('abc');
    expect(stderr.join('')).toContain('"token":"[REDACTED]"');
    expect(stderr.join('')).not.toContain('def');
  });

  it('rotates log files by size', () => {
    const logDir = makeLogDir();
    const logger = new Logger({
      level: 'info',
      logDir,
      console: false,
      now: fixedNow,
      maxFileSizeBytes: 200,
      maxFiles: 2,
    });

    logger.info('x'.repeat(300));
    logger.info('y'.repeat(300));
    logger.info('z'.repeat(300));

    expect(existsSync(join(logDir, 'jarvis.log'))).toBe(true);
    expect(existsSync(join(logDir, 'jarvis.log.1'))).toBe(true);
    expect(existsSync(join(logDir, 'jarvis.log.2'))).toBe(true);
  });

  it('merges child bindings into entries', () => {
    const logDir = makeLogDir();
    const logger = new Logger({ level: 'info', logDir, console: false, now: fixedNow });
    const child = logger.child({ requestId: 'req-123' });

    child.info('child message');

    const content = readLog(logDir);

    expect(content).toContain('"requestId":"req-123"');
    expect(content).toContain('"message":"child message"');
  });
});
