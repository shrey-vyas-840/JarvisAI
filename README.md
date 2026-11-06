# JARVIS Agent

Local-first personal AI operator for Windows, built incrementally around Node.js 24, TypeScript, Ollama, and Playwriter.

## Current status

Phase 0 (environment audit) is complete.

Phase 1 (project foundation, configuration, logging, CLI, and read-only health checks) is complete and published.

Phase 2 (native Ollama integration, registered tools, bounded agent loop, and live diagnostic execution) is complete.

Phase 3 has not started and requires explicit approval.

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
```

The agent command uses the configured local Ollama model, executes only registered tools, and writes structured audit logs to `logs/jarvis.log`. `npm run dev` starts the TypeScript source entry point in watch mode.

## Agent limits

- 8 tool rounds per run.
- 12 tool calls per run.
- 20,000 characters of tool output returned to the model.
- Sequential tool execution.
- One transient HTTP retry.
- Explicit cancellation, timeout, failure, and verification records.

## Directory layout

```text
D:\AI\JarvisAgent
|-- src/       application source
|   |-- core/  agent loop, system prompt, and tool registry
|   |-- health/ read-only environment diagnostics
|   |-- llm/   native Ollama client
|   |-- logging/ structured redacting logger
|   `-- tools/ registered tools
|-- tests/     automated tests
|-- docs/      architecture, status, decisions, test reports, handoff
|-- data/      local application state (not committed)
|-- logs/      local logs (not committed)
|-- scripts/   maintenance scripts
```

The agent operates on `D:\AI\JarvisWorkspace` and `D:\AI\Exports` in future phases. Source code remains separate in `D:\AI\JarvisAgent`.

## Safety

- Local-only services, bound to `127.0.0.1`.
- No cloud inference or paid APIs.
- No unrestricted command execution.
- Only registered tools can execute; Phase 2 registers one read-only diagnostic tool.
- Tool arguments are validated before execution.
- No filesystem access outside approved roots.
- No secrets in source, logs, or Git.
- Logs redact sensitive keys and secret-like strings.
- No automatic destructive actions.

See `docs/` for the current architecture, decisions, and handoff state.

## Next step

Await explicit approval for Phase 3 and confirm its scope. Do not add filesystem, shell, browser, memory, voice, or UI features until approved. See `docs/PHASE-3-HANDOFF.md`.
