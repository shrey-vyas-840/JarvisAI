# Phase 3 Handoff Plan

Status: **not started**
Approval: **required before any Phase 3 implementation**

Phase 2 is complete and has a verified local agent execution path. Phase 3 should extend that path through the existing registered-tool contract without weakening the Phase 2 safety properties.

## Proposed Phase 3 scope

The exact Phase 3 scope has not been approved. The recommended next increment is a small set of filesystem tools restricted to the approved operating roots:

- `D:\AI\JarvisWorkspace`
- `D:\AI\Exports`

Recommended first increment:

- Read-only tools:
  - `list_directory`
  - `read_text_file`
  - `search_text`
  - `get_file_info`
- Strict path handling:
  - Resolve every path against an approved root.
  - Reject traversal outside approved roots.
  - Reject symlink escapes where applicable.
  - Reject absolute paths that do not resolve under an approved root.
- Output and input limits:
  - Maximum file size for reads.
  - Maximum returned bytes or characters.
  - Maximum directory entries and search results.
  - Clear truncation metadata.
- Verification:
  - Confirm that each returned path is within an approved root.
  - Confirm actual file metadata when applicable.
  - Return structured failures rather than partial claims.

Do not add write, delete, move, shell, browser, memory, voice, or UI tools in this increment unless explicitly approved.

## Proposed second increment

Only after read-only filesystem tools are verified:

- Write tools with `requires-approval` permission:
  - `write_text_file`
  - `create_directory`
  - `move_path`
- Approval must happen before execution, not after.
- Writes must be restricted to approved roots.
- Existing-file overwrite must require explicit approval.
- Destructive deletion should remain out of scope until a separate approval model exists.
- Record a pre-write and post-write receipt with path, size, and verification result.

## Required behavior

- Reuse `ToolDefinition`, `ToolRegistry`, and execution receipts.
- Do not bypass argument validation.
- Keep tool execution sequential.
- Preserve the Phase 2 agent limits unless a reviewed change is approved.
- Log tool registration, requests, starts, completions, validation failures, and failures.
- Return failures to the model as structured tool results.
- Never report a failed, denied, timed-out, or cancelled operation as successful.
- Do not expose secrets, tokens, or unrelated file contents.
- Do not access `D:\AI\JarvisAgent` source, model storage, credentials, or arbitrary user directories through the tools.

## Required tests

- Path normalization and traversal rejection.
- Approved-root boundary tests for every filesystem tool.
- Symlink escape tests where supported.
- File-size and output-size limits.
- Missing files, permission errors, and invalid encodings.
- Directory listing and search truncation.
- Tool verification failure and timeout behavior.
- Approval-required tools that do not execute before approval.
- Agent-loop integration with at least one real read-only filesystem tool.
- Regression tests for all Phase 2 behavior.

## Live acceptance criteria

- Ollama `qwen3.5:9b` is available locally.
- A live instruction causes a real structured tool call.
- The tool reads or lists only inside an approved test root.
- The returned result is verified and sent back to the model.
- The final response reflects the actual result.
- Logs show the tool lifecycle and receipt status.
- No source, secret, model, browser, or unrelated filesystem changes occur.
- GPU execution is observed and recorded.

## Prerequisites and decisions needed

Before implementation, confirm:

- The exact Phase 3 scope.
- Which tools are approved for the first increment.
- Whether write tools are included.
- The approval UX for side-effecting tools.
- The maximum read size and output size.
- Whether symlinks are allowed at all.
- Whether search recursion and file-type filters are required.

## Non-goals

- Playwriter or browser automation; that remains a later phase.
- Shell command execution.
- Memory, voice, and UI.
- MCP integrations.
- Model management or downloading.
- Changes to Phase 2 agent limits without review.

## Exact next task

Wait for explicit user approval. Then confirm the Phase 3 scope and implement only the approved read-only filesystem increment first.
