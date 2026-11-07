import { createInterface } from 'node:readline/promises';

import type { ApprovalOutcome, ApprovalProvider, ApprovalRequest } from './approval-types.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const AFFIRMATIVE_ANSWERS = new Set(['y', 'yes', 'approve', 'approved']);

export interface CliApprovalProviderOptions {
  readonly output?: (text: string) => void;
  readonly input?: NodeJS.ReadableStream;
  readonly outputStream?: NodeJS.WritableStream;
  readonly interactive?: boolean;
  readonly readLine?: (options: { readonly signal: AbortSignal }) => Promise<string>;
  readonly timeoutMs?: number;
}

export class CliApprovalProvider implements ApprovalProvider {
  private readonly output: (text: string) => void;
  private readonly input: NodeJS.ReadableStream;
  private readonly outputStream: NodeJS.WritableStream;
  private readonly interactive: boolean;
  private readonly readLine:
    ((options: { readonly signal: AbortSignal }) => Promise<string>) | null;
  private readonly timeoutMs: number;

  public constructor(options: CliApprovalProviderOptions = {}) {
    this.output =
      options.output ??
      ((text: string) => {
        process.stderr.write(text);
      });
    this.input = options.input ?? process.stdin;
    this.outputStream = options.outputStream ?? process.stderr;
    this.interactive = options.interactive ?? (process.stdin.isTTY && process.stderr.isTTY);
    this.readLine = options.readLine ?? null;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    if (!Number.isInteger(this.timeoutMs) || this.timeoutMs < 1) {
      throw new Error('Approval timeout must be a positive integer');
    }
  }

  public async requestApproval(
    request: ApprovalRequest,
    options: { readonly signal: AbortSignal },
  ): Promise<ApprovalOutcome> {
    if (!this.interactive) {
      return 'unavailable';
    }

    if (options.signal.aborted) {
      return 'cancelled';
    }

    this.output(formatApprovalPrompt(request));

    const timeoutController = new AbortController();
    const timer = setTimeout(() => {
      timeoutController.abort(new ApprovalTimeoutError());
    }, this.timeoutMs);
    const combinedSignal = AbortSignal.any([options.signal, timeoutController.signal]);

    try {
      const answer = await this.ask(combinedSignal);

      return isAffirmative(answer) ? 'approved' : 'denied';
    } catch (error) {
      if (timeoutController.signal.reason instanceof ApprovalTimeoutError) {
        this.output('\nApproval timed out; the operation was denied.\n');
        return 'denied';
      }

      if (isAbortError(error)) {
        return 'cancelled';
      }

      return 'unavailable';
    } finally {
      clearTimeout(timer);
    }
  }

  private ask(signal: AbortSignal): Promise<string> {
    if (this.readLine !== null) {
      return this.readLine({ signal });
    }

    return this.readFromTerminal(signal);
  }

  private async readFromTerminal(signal: AbortSignal): Promise<string> {
    const readline = createInterface({
      input: this.input,
      output: this.outputStream,
      terminal: this.interactive,
    });

    try {
      return await readline.question('', { signal });
    } finally {
      readline.close();
    }
  }
}

export function formatApprovalPrompt(request: ApprovalRequest): string {
  const lines = [
    '',
    'JARVIS APPROVAL REQUIRED',
    '',
    `Operation: ${safeDisplay(request.operation)}`,
  ];

  if (request.root !== undefined) {
    lines.push(`Root: ${safeDisplay(request.root)}`);
  }
  if (request.relativePath !== undefined) {
    lines.push(`Relative path: ${safeDisplay(request.relativePath)}`);
  }
  if (request.absolutePath !== undefined) {
    lines.push(`Absolute path: ${safeDisplay(request.absolutePath)}`);
  }

  lines.push(`Action: ${safeDisplay(request.action)}`, `Warning: ${safeDisplay(request.warning)}`);

  if (request.content !== undefined) {
    lines.push(
      `Size: ${String(request.content.bytes)} bytes`,
      `SHA-256: ${request.content.sha256}`,
      'Content (escaped JSON string):',
      escapePromptContent(request.content.text),
    );
  }

  lines.push(
    '',
    'No response, EOF, invalid input, timeout, or Ctrl+C denies this operation.',
    'Approve this exact operation? (y/N): ',
  );

  return `${lines.join('\n')}\n`;
}

export function isAffirmative(answer: string): boolean {
  return AFFIRMATIVE_ANSWERS.has(answer.trim().toLowerCase());
}

const UNSAFE_VISUAL_CHARACTER =
  /[\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/u;
const UNSAFE_VISUAL_CHARACTERS =
  /[\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2060-\u2069\ufeff]/gu;

function escapePromptContent(text: string): string {
  return JSON.stringify(text).replace(UNSAFE_VISUAL_CHARACTERS, (character) => {
    const code = character.codePointAt(0);
    return code === undefined ? character : `\\u${code.toString(16).padStart(4, '0')}`;
  });
}

function safeDisplay(value: string): string {
  let result = '';

  for (const character of value) {
    const code = character.codePointAt(0);

    if (character === '\\') {
      result += '\\\\';
    } else if (character === '\n') {
      result += '\\n';
    } else if (character === '\r') {
      result += '\\r';
    } else if (character === '\t') {
      result += '\\t';
    } else if (code !== undefined && (code < 32 || code === 127 || (code >= 128 && code <= 159))) {
      result += `\\x${code.toString(16).padStart(2, '0')}`;
    } else if (code !== undefined && UNSAFE_VISUAL_CHARACTER.test(character)) {
      result += `\\u${code.toString(16).padStart(4, '0')}`;
    } else {
      result += character;
    }
  }

  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === 'AbortError';
}

class ApprovalTimeoutError extends Error {
  public constructor() {
    super('Approval timed out');
    this.name = 'ApprovalTimeoutError';
  }
}
