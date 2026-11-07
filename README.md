# JARVIS Agent

Local-first personal AI operator for Windows, built incrementally around Node.js 24, TypeScript, Ollama, and Playwriter.

## Current status

Phase 0 (environment audit) is complete.

Phase 1 (project foundation, configuration, logging, CLI, and read-only health checks) is complete and published.

Phase 2 (native Ollama integration, registered tools, bounded agent loop, and live diagnostic execution) is complete.

Phase 3 (secure read-only filesystem tools) is complete.

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
```

The agent command uses the configured local Ollama model, executes only registered tools, and writes structured audit logs to `logs/jarvis.log`. `npm run dev` starts the TypeScript source entry point in watch mode.

## Agent limits

- 8 tool rounds per run.
- 12 tool calls per run.
- 20,000 characters of tool output returned to the model.
- Sequential tool execution.
- One transient HTTP retry.
- Explicit cancellation, timeout, failure, and verification records.

## Filesystem tools

Read-only and restricted to the configured `workspace` and `exports` roots:

- `list_directory`: lists up to 200 entries and never follows links.
- `read_text_file`: reads UTF-8 text up to 1 MiB and 20,000 characters.
- `search_text`: literal case-sensitive search to depth 5, up to 500 files, 256 KiB per file, 100 matches, and 200-character excerpts.
- `get_file_info`: returns verified metadata without file contents.

Paths must be relative to a root identifier. Traversal, absolute/rooted paths, drive changes, UNC/device paths, alternate data streams, reserved device names, and symlink/junction escapes are rejected. Credential-like files, binary files, and invalid UTF-8 are not readable.

## Directory layout

```text
D:\AI\JarvisAgent
|-- src/       application source
|   |-- core/  agent loop, system prompt, and tool registry
|   |-- health/ read-only environment diagnostics
|   |-- llm/   native Ollama client
|   |-- logging/ structured redacting logger
|   `-- tools/ registered tools
|       `-- filesystem/ path-guarded read-only filesystem tools
|-- tests/     automated tests
|-- docs/      architecture, status, decisions, test reports, handoff
|-- data/      local application state (not committed)
|-- logs/      local logs (not committed)
|-- scripts/   maintenance scripts
```

The read-only filesystem tools operate on `D:\AI\JarvisWorkspace` and `D:\AI\Exports`. Source code remains separate in `D:\AI\JarvisAgent` and is not reachable through the tools.

## Safety

- Local-only services, bound to `127.0.0.1`.
- No cloud inference or paid APIs.
- No unrestricted command execution.
- Only registered tools can execute; all five registered tools are read-only.
- Tool arguments are validated before execution.
- Filesystem access is limited to approved roots with fail-closed Windows path validation and no link following.
- Credential-like files, binary content, and invalid UTF-8 are rejected or skipped.
- No writes, creations, moves, or deletions.
- No secrets in source, logs, or Git.
- Logs redact sensitive keys and secret-like strings.
- No automatic destructive actions.

See `docs/` for the current architecture, decisions, and handoff state.

## Next step

Phase 4 or write-capable filesystem tools require explicit approval and a confirmed scope. Side-effecting tools must add an approval mechanism before execution. See `docs/PHASE-3-HANDOFF.md`.
