# Security Model

Last updated: 2026-11-07

This document describes the implemented security boundaries for the JARVIS agent. It is a local, single-user design. It is not a multi-tenant sandbox and does not protect against an attacker who already controls the Windows user account or the JARVIS process.

## Assets

- Source code and repository history in `D:\AI\JarvisAgent`.
- Files under `D:\AI\JarvisWorkspace` and `D:\AI\Exports`.
- Local Ollama model and endpoint.
- Structured audit logs in `logs/`.
- Configuration and any local secrets loaded from the environment or `.env`.

## Trust boundaries

- The local model is untrusted for authority. It may request tools, but it cannot approve its own writes, access arbitrary paths, or execute unregistered code.
- Tool arguments are untrusted input. They are validated with Zod before execution.
- The filesystem is untrusted for path identity. Reparse points, alternate names, and path changes are rejected or revalidated.
- The interactive human at the CLI is the approval authority for side-effecting tools.
- `ToolRegistry` is the execution boundary. Only registered tools run.
- The CLI approval provider is the only implemented approval channel. Missing, non-interactive, or failed approval channels fail closed.

## Filesystem roots and path guard

- Only two root identifiers are exposed: `workspace` (`D:\AI\JarvisWorkspace`) and `exports` (`D:\AI\Exports`).
- Tools accept a root identifier plus a relative path. They never accept an arbitrary absolute path.
- `PathGuard` rejects traversal, absolute and rooted paths, drive changes, UNC paths, device paths, alternate data streams, invalid components, reserved device names, and symlink/junction escapes.
- Resolved targets are checked for containment and revalidated immediately before use.
- Symbolic links and junctions are rejected, even when they point inside an approved root.
- Credential-like filenames and directories are rejected for reads and writes. Binary and invalid UTF-8 content is rejected for text tools.

## Approval

- `create_directory` and `write_text_file` require approval for each execution.
- Approval is requested immediately before the side effect. Denied or unavailable approval prevents the handler from running.
- The prompt shows the operation, root, relative and absolute paths, action, warning, and, for file writes, byte count, SHA-256, and the full content as an escaped JSON string.
- Only explicit `y`, `yes`, `approve`, or `approved` answers authorize.
- Enter, EOF, empty or invalid input, timeout, Ctrl+C, non-interactive execution, a missing provider, and provider errors never authorize.
- Denial or unavailable approval stops the agent run so later side-effecting calls in that run do not execute.
- Approval is per operation. There is no global allow-all switch.
- The model cannot approve, simulate approval, or bypass the provider.

## Create-only write semantics

- `create_directory` creates exactly one directory. The parent must already exist. Recursive creation and root creation are rejected.
- `write_text_file` creates exactly one new file. The parent must already exist. Existing files are never overwritten.
- File creation uses exclusive creation (`openSync` with `wx`). A file that appears after approval is rejected without modifying the existing file.
- Content is limited to 64 KiB of valid UTF-8 text. NUL characters and unpaired surrogates are rejected.
- After creation, the file is read back and compared exactly, including byte length and SHA-256.
- If writing, syncing, or closing fails after creation, the file may remain partially written. JARVIS reports the failure and does not delete or repair the file automatically.

## Receipts and logging

- Every tool execution produces a receipt with execution ID, call ID, tool name, status, approval status, verification status, result, error, and timestamps.
- Approval audit events record the tool, operation, root, relative path, absolute path, byte count, and SHA-256 where applicable.
- File content and approval answers are not written to logs.
- Logs use the existing redacting logger for sensitive keys and secret-like strings.
- The model receives structured tool results with explicit status and verification fields. Failed or unverified writes are not reported as success.

## Local-only services

- Ollama is restricted to loopback HTTP endpoints by configuration.
- Browser automation is not part of Phase 3B.
- No cloud inference, paid API, telemetry, or remote tool execution is used.

## Verified controls (2026-11-07)

Interactive acceptance in a real PowerShell terminal produced these results:

- `create_directory` created `phase3b-acceptance-dir` only after genuine manual approval, and the directory was independently verified.
- The first `write_text_file` created `hello.txt` after manual approval, but its content missed the requested final period. The discrepancy is recorded; the first attempt is not treated as evidence that the requested exact text was produced.
- The exact-content retest created `hello-exact.txt` containing `Hello from JARVIS Phase 3B.` at 27 bytes. PowerShell ordinal comparison returned `True`, and exact read-back plus SHA-256 verification passed.
- A second write to existing `hello.txt` was rejected with `already_exists`, and no overwrite occurred.
- A traversal write to `..\JarvisAgent\phase3b-escape.txt` was rejected with `path_traversal`, and `D:\AI\JarvisAgent\phase3b-escape.txt` does not exist.
- A non-interactive live attempt failed closed with `Approval is unavailable` and made no change.
- The accepted workspace files were preserved. No deletion, move, rename, or overwrite was performed.

## Known limitations and residual risks

- Approval is a human-in-the-loop control, not a sandbox. A compromised local user account, terminal, or JARVIS process can bypass it.
- Path checks and the subsequent filesystem operation are not a single atomic kernel operation. Revalidation and exclusive creation reduce but do not eliminate time-of-check/time-of-use races on a filesystem being actively modified by another process.
- The approval prompt JSON-escapes content and additionally escapes control, bidirectional, zero-width, and line/paragraph separator characters. Other confusable or combining characters may still affect visual appearance; the SHA-256 is provided for exact identification.
- There is no rollback, backup, automatic cleanup, or deletion. A failed verification can leave a created file in place.
- There is no encryption at rest, process isolation, Windows ACL management, or protection from other processes running as the same user.
- The 5-minute approval timeout and 64 KiB file limit are fixed defaults in this phase.
- Denial stops the current agent run, but it is not a persistent policy remembered across runs.
- Console and file logs may retain operational metadata until rotation or manual cleanup.

## Change rules

- Any new root requires a configuration change, a new root identifier, schema updates, and tests.
- Any new side-effecting tool must declare an approval request builder and pass through `ToolRegistry`.
- Overwrite, delete, move, rename, recursive creation, and binary writes require a separate reviewed design and are not implied by the existing approval mechanism.
- Any new approval channel must preserve per-operation semantics, explicit approval, fail-closed behavior, and content-free audit logging.
