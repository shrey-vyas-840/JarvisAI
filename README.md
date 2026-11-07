# JARVIS Agent

Local-first personal AI operator for Windows, built incrementally around Node.js 24, TypeScript, Ollama, and Playwriter.

## Current status

Phase 0 (environment audit) is complete.

Phase 1 (project foundation, configuration, logging, CLI, and read-only health checks) is complete and published.

Phase 2 (native Ollama integration, registered tools, bounded agent loop, and live diagnostic execution) is complete.

Phase 3 (secure read-only filesystem tools) is complete.

Phase 3B (approval-gated directory and text-file creation) is complete and live-tested with manual interactive approval.

## Stack

- Node.js 24 and TypeScript 5.9
- Ollama native API with `qwen3.5:9b`
- Zod for configuration and tool-argument validation
- Vitest for tests
- ESLint and Prettier for code quality
- Playwriter 0.9.0 for browser automation in a later phase

Cline is an optional VS Code development assistant. The Jarvis runtime does not depend on Cline, the Cline SDK, or Goose.

## Development commands

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npm start -- version
npm start -- --help
npm start -- health
npm start -- health --json
npm start -- agent "Call get_jarvis_status exactly once. Then summarize the returned runtime information."
npm start -- agent "List the workspace root and report the actual entries."
npm start -- agent "Create a new directory named phase3b-demo in the workspace root. Use exactly one create_directory call."
npm start -- agent "Create a new text file named hello.txt in the workspace root containing exactly: Hello from JARVIS. Use exactly one write_text_file call."
```

The agent command uses the configured local Ollama model, executes only registered tools, and writes structured audit logs to `logs/jarvis.log`. Filesystem writes require an interactive approval prompt that defaults to No. In a non-interactive shell, write tools fail closed with `Approval is unavailable`. `npm run dev` starts the TypeScript source entry point in watch mode.

## Agent limits

- 8 tool rounds per run.
- 12 tool calls per run.
- 20,000 characters of tool output returned to the model.
- Sequential tool execution.
- One transient HTTP retry.
- Explicit cancellation, timeout, failure, and verification records.

## Filesystem tools

Restricted to the configured `workspace` and `exports` roots.

Read-only tools:

- `list_directory`: lists up to 200 entries and never follows links.
- `read_text_file`: reads UTF-8 text up to 1 MiB and 20,000 characters.
- `search_text`: literal case-sensitive search to depth 5, up to 500 files, 256 KiB per file, 100 matches, and 200-character excerpts.
- `get_file_info`: returns verified metadata without file contents.

Approval-gated tools:

- `create_directory`: creates exactly one new directory after explicit CLI approval. The parent must already exist, recursive creation is rejected, and existing paths are never overwritten.
- `write_text_file`: creates one new UTF-8 text file after explicit CLI approval. The parent must already exist, content is limited to 64 KiB, existing files are never overwritten, and the file is read back and verified exactly.

Approval is per operation and fails closed. The prompt shows the operation, root, relative and absolute paths, action, warning, size, SHA-256, and full escaped content for file writes. Only `y`, `yes`, `approve`, or `approved` authorize; Enter, EOF, invalid input, timeout, Ctrl+C, non-interactive execution, and missing providers never authorize. Denial stops further side-effecting operations in the run.

Paths must be relative to a root identifier. Traversal, absolute/rooted paths, drive changes, UNC/device paths, alternate data streams, reserved device names, and symlink/junction escapes are rejected. Credential-like files, binary files, and invalid UTF-8 are not readable. Creation does not follow links, and partial files are reported rather than silently deleted.

## Directory layout

```text
D:\AI\JarvisAgent
|-- src/       application source
|   |-- core/  agent loop, system prompt, and tool registry
|   |-- health/ read-only environment diagnostics
|   |-- llm/   native Ollama client
|   |-- logging/ structured redacting logger
|   `-- tools/ registered tools
|       `-- filesystem/ path-guarded filesystem tools
|-- tests/     automated tests
|-- docs/      architecture, status, decisions, test reports, handoff
|-- data/      local application state (not committed)
|-- logs/      local logs (not committed)
|-- scripts/   maintenance scripts
```

The filesystem tools operate on `D:\AI\JarvisWorkspace` and `D:\AI\Exports`. Source code remains separate in `D:\AI\JarvisAgent` and is not reachable through the tools.

## Safety

- Local-only services, bound to `127.0.0.1`.
- No cloud inference or paid APIs.
- No unrestricted command execution.
- Only registered tools can execute. Five are read-only and two require explicit per-operation approval.
- Tool arguments are validated before execution.
- Filesystem access is limited to approved roots with fail-closed Windows path validation and no link following.
- Credential-like files, binary content, and invalid UTF-8 are rejected or skipped.
- No existing file is overwritten; `create_directory` and `write_text_file` create new paths only.
- Writes require interactive human approval and fail closed in non-interactive execution.
- No deletion, move, rename, or overwrite operations.
- No secrets in source, logs, or Git.
- Logs redact sensitive keys and secret-like strings. File content is not written to logs.
- No automatic destructive actions.

See `docs/` for the current architecture, decisions, and handoff state.

## Next step

Phase 3B is complete and published, including live approval-gated directory and text-file creation, exact-content verification, overwrite rejection, and traversal rejection. Phase 4 or additional write capabilities require explicit approval and a confirmed scope. See `docs/PHASE-3B-HANDOFF.md`.
