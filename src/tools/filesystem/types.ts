import type { PathGuard } from './path-guard.js';

export interface FilesystemToolOptions {
  readonly guard: PathGuard;
}

export const LIST_DIRECTORY_MAX_ENTRIES = 200;
export const READ_TEXT_FILE_MAX_BYTES = 1024 * 1024;
export const READ_TEXT_FILE_MAX_CHARACTERS = 20_000;
export const WRITE_TEXT_FILE_MAX_BYTES = 64 * 1024;
export const SEARCH_TEXT_MAX_DEPTH = 5;
export const SEARCH_TEXT_MAX_FILES = 500;
export const SEARCH_TEXT_MAX_FILE_BYTES = 256 * 1024;
export const SEARCH_TEXT_MAX_MATCHES = 100;
export const SEARCH_TEXT_MAX_EXCERPT_CHARACTERS = 200;
export const SEARCH_TEXT_MAX_UNREADABLE_REPORTED = 50;
