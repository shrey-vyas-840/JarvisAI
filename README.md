# JARVIS Agent

Local-first personal AI operator for Windows, built incrementally around Node.js 24, TypeScript, Ollama, and Playwriter.

## Current status

Phase 0 (environment audit) is complete.

Phase 1A (project scaffold) is complete.

Phase 1B (development infrastructure) is complete.

Phase 1C (configuration, logging, and CLI) is complete.

Phase 1D (read-only health diagnostics) is complete. Phase 1 is complete.

No agent runtime logic, Ollama chat integration, agent loop, tools, or UI exists yet.

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
```

`npm run dev` starts the TypeScript source entry point in watch mode.

## Directory layout

```text
D:\AI\JarvisAgent
|-- src/       application source
|-- tests/     automated tests
|-- docs/      architecture, status, decisions, test reports, handoff
|-- data/      local application state (not committed)
|-- logs/      local logs (not committed)
|-- scripts/   maintenance scripts
```

The agent operates on `D:\AI\JarvisWorkspace` and `D:\AI\Exports`. Source code remains separate in `D:\AI\JarvisAgent`.

## Safety

- Local-only services, bound to `127.0.0.1`.
- No cloud inference or paid APIs.
- No unrestricted command execution.
- No filesystem access outside approved roots.
- No secrets in source, logs, or Git.
- No automatic destructive actions.

See `docs/` for the current architecture, decisions, and handoff state.

## Next step

Await explicit approval for Phase 2. Do not start Ollama chat integration, the agent loop, tools, browser automation, memory, voice, or UI until approved.
