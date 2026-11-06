# Architecture and Engineering Decisions

## ADR-001 — Thin custom TypeScript agent core

Decision: implement the Jarvis runtime as a small TypeScript/Node.js core rather than adopting the Cline SDK or Goose.

Reason: Jarvis needs exact control over native Ollama tool calls, Windows-specific tools, approvals, path guarding, and audit records. A small core is easier to audit and has a much smaller dependency and attack surface.

Consequence: the execution loop, tool registry, and permission layer are our responsibility and must be tested explicitly.

## ADR-002 — Native Ollama API

Decision: call `http://127.0.0.1:11434/api/chat` directly with `fetch`.

Reason: structured tool calls are already verified, and the native API avoids provider-framework abstraction.

Consequence: request/response validation and tool-message formatting remain in our code.

## ADR-003 — Playwriter for browser automation

Decision: use the installed Playwriter 0.9.0 and its local relay for Phase 4.

Reason: it is already working with the Chrome extension, the relay is local-only, and the package exposes a Node API.

Consequence: pin 0.9.0 locally in Phase 4. Do not run Playwright MCP as a competing controller.

## ADR-004 — Cline is a development tool, not a runtime dependency

Decision: use the Cline VS Code extension only for development assistance. Do not embed the Cline SDK or Goose in Jarvis.

Reason: both add substantial runtime and dependency complexity that is not needed for the approved architecture.

## ADR-005 — TypeScript 5.9.3

Decision: pin TypeScript 5.9.3.

Reason: TypeScript 7.0.2 is the current npm latest, but `typescript-eslint@8.72.1` declares a peer range of TypeScript `>=4.8.4 <6.1.0`. Using TypeScript 7 would break the approved lint stack. Revisit when the lint tooling supports it.

## ADR-006 — Node.js 24 built-ins

Decision: rely on Node.js 24 built-ins where practical: `fetch`, `process.loadEnvFile`, `crypto.randomUUID`, `readline/promises`, and later `node:sqlite`.

Reason: fewer dependencies and a smaller attack surface.

## ADR-007 — ES modules with Node-compatible resolution

Decision: set `"type": "module"` and use Node-compatible TypeScript module settings in Phase 1B.

Reason: the project targets Node.js 24 and should not depend on a bundler for normal execution.

## ADR-008 — Exact dependency pinning

Decision: all approved dependencies are pinned to exact versions in `package.json`, and `package-lock.json` is retained.

Reason: reproducible local builds and no silent upgrades.

## ADR-009 — Separate source and operating workspace

Decision: source code stays in `D:\AI\JarvisAgent`; model-facing file tools will be restricted to `D:\AI\JarvisWorkspace` and `D:\AI\Exports`.

Reason: prevents the agent from modifying its own implementation and limits filesystem risk.

## ADR-010 — Split TypeScript configuration for checking and building

Decision: use `tsconfig.json` for type-checking both `src` and `tests` with `noEmit`, and `tsconfig.build.json` to emit only `src` to `dist`.

Reason: tests should be type-checked without being shipped, and the build should produce a predictable `dist/cli.js` entry point for `npm start`.

Consequence: keep the two configurations aligned when compiler options change.

## ADR-011 — Validate configuration at the boundary

Decision: validate environment values with Zod in `src/config.ts`, resolve relative paths from the project root, and restrict `OLLAMA_BASE_URL` to loopback HTTP endpoints.

Reason: malformed configuration should fail before any tool or network action, and local-only inference should not be silently redirected to a remote host.

Consequence: new configuration fields must be added to the schema and `.env.example` together.

## ADR-012 — Structured logs with redaction and size rotation

Decision: write one JSON object per line, redact sensitive keys and secret-like strings, and use simple synchronous file writes with size-based rotation.

Reason: machine-readable logs support audit and debugging, while redaction reduces credential leakage. Synchronous writes keep ordering predictable at the current scale.

Consequence: revisit asynchronous buffering if log volume becomes significant. New sensitive key patterns must be added to the redaction list.

## ADR-013 — Testable CLI with injected I/O

Decision: expose `runCli(args, io)` with injectable stdout/stderr and return an exit code; use `pathToFileURL` to detect direct execution.

Reason: CLI behavior can be tested without spawning processes or calling `process.exit`, while the built and source entry points still run normally.

Consequence: future commands should follow the same pattern and keep side effects behind injectable dependencies.

## ADR-014 — Read-only health diagnostics

Decision: make `health` purely observational. It may check filesystem existence, run `npm --version` and `nvidia-smi`, send GET requests to local Ollama endpoints, and attempt a TCP connection to the Playwriter relay. It must not load models, run inference, create files or directories, start or stop services, or create browser sessions. Health must not use the file logger.

Reason: diagnostics must be safe to run repeatedly without changing runtime state or requiring approvals for side effects.

Consequence: health dependencies are injected for unit tests. `FAILED` maps to exit code `1`; `OK` and `WARNING` map to `0`.

## ADR-015 — Asynchronous CLI boundary

Decision: make `runCli` asynchronous. The direct-execution path awaits it and assigns `process.exitCode`.

Reason: health and future network commands need to await work without blocking patterns, while CLI behavior remains testable through injected I/O and dependencies.

Consequence: CLI tests must await `runCli`, and future commands should preserve the injected dependency pattern.

## ADR-016 — Native Ollama client boundary

Decision: keep all Ollama HTTP details in `src/llm/ollama-client.ts`. Send non-streaming `/api/chat` requests with `think:false`, validated context size, low temperature, and conservative prediction limits. Validate responses with Zod and expose typed errors and metrics.

Reason: the agent loop should consume a small, testable interface rather than raw HTTP responses, and malformed model responses must fail explicitly.

Consequence: model response-shape changes must be handled in the client schema. The client retries only transient network, timeout, 429, and 5xx failures.

## ADR-017 — Registered-only tools with execution receipts

Decision: execute only tools registered in `ToolRegistry`, validate arguments before execution, and return a typed receipt for every requested call. Tools declare permissions, timeouts, and optional verification.

Reason: the model must not be able to invoke arbitrary code, and the runtime needs auditable evidence of what actually happened.

Consequence: new tools must define a JSON Schema, a matching Zod schema, a permission, a timeout, and a verification check where the result is verifiable. Side-effecting tools will require an approval path before execution.

## ADR-018 — Bounded agent loop

Decision: cap the loop at 8 tool rounds, 12 tool calls, and 20,000 characters of tool output returned to the model. Execute tool calls sequentially and stop repeated identical calls.

Reason: local models can loop or over-produce tool calls, and unbounded rounds increase latency, resource use, and unintended side effects.

Consequence: limits are configurable through `AgentLoopOptions` for tests and future policy settings. Exceeding a limit produces an explicit `limit_reached` result rather than an ambiguous response.

## ADR-019 — Read-only diagnostic acceptance tool

Decision: make `get_jarvis_status` the first real tool. It returns actual runtime information and verifies its own output against the execution context.

Reason: it proves the complete model → structured tool call → validated execution → tool result → model answer path without filesystem, browser, or command side effects.

Consequence: Phase 3 should add capabilities through separate registered tools rather than expanding this diagnostic tool.

## ADR-020 — Agent CLI logging and cancellation

Decision: the default agent runner logs to the redacting file logger with console output disabled, and the CLI maps SIGINT to an aborted run with exit code `130`.

Reason: agent logs are long-lived audit data, while the CLI should keep model output readable. Cancellation must not be reported as success.

Consequence: future commands should preserve the separation between user-facing output and structured audit logs.
