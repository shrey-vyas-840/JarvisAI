# Phase 0 Baseline

Date: 2026-11-07
Status: Complete (read-only audit)

This document records the verified environment and architecture decisions that Phase 1 is built on. It is not a substitute for re-checking live state when a later phase depends on it.

## Verified environment

| Item                 | Verified result                                                  |
| -------------------- | ---------------------------------------------------------------- |
| OS                   | Windows 11 Home Single Language, 10.0.26300, 64-bit              |
| PowerShell           | 5.1.26100.9818                                                   |
| RAM                  | 31.7 GB                                                          |
| Disks                | C: 474.7 GB total, 323 GB free; D: 931.5 GB total, 876.9 GB free |
| GPU                  | NVIDIA RTX 4060 Laptop, 8188 MiB, driver 560.94, CUDA 12.6       |
| Node.js              | v24.18.0                                                         |
| npm                  | 11.16.0                                                          |
| Git                  | 2.55.0.windows.2                                                 |
| VS Code              | 1.141.0                                                          |
| Cline extension      | `saoudrizwan.claude-dev@4.1.26`                                  |
| Ollama               | 0.40.15                                                          |
| Ollama API           | `http://127.0.0.1:11434`                                         |
| Ollama model storage | `D:\AI\OllamaModels`                                             |
| Installed model      | `qwen3.5:9b` (Q4_K_M, 6.6 GB on disk)                            |
| Playwriter           | 0.9.0                                                            |
| Playwriter relay     | `127.0.0.1:19988`                                                |
| Chrome               | 156.0.8078.80                                                    |
| Python               | 3.12.10 (available; `uv` and FFmpeg are not installed)           |

## Verified model behaviour

Native `/api/chat` was tested with `qwen3.5:9b`, `num_ctx=4096`, `stream=false`.

- With `think=true` and a 64-token prediction budget, the model returned thinking text and no tool call.
- With `think=false`, the model returned a structured `tool_calls` entry.
- A follow-up request containing the assistant tool call and a tool result produced a normal final answer.

The protocol round-trip was verified. It was not a real Jarvis tool execution; the tool result was supplied manually. Phase 2 must prove real execution.

GPU observation at 4096 context:

```text
qwen3.5:9b  5.6 GB  100% GPU  4096  llamacpp
```

NVIDIA reported 6349 MiB used and 1609 MiB free. No CPU fallback was observed. Do not increase context without measuring VRAM, latency, and fallback.

## Framework evaluation

- **Cline**: the VS Code extension is installed and useful for development. The Cline SDK is Apache-2.0 and supports Ollama, but it is a 0.x API with a large provider/telemetry dependency tree. It is not the Jarvis runtime.
- **Goose**: Apache-2.0, Rust, ACP/MCP, Ollama support. Not adopted; it would add a separate runtime and duplicate the planned security and UI layers.
- **Playwright MCP**: Apache-2.0, extension mode is viable, but it requires another browser extension and would compete with the already-working Playwriter installation. Fallback only.
- **Playwriter**: MIT, local relay, Chrome extension connected, Node API available. Primary browser adapter for Phase 4.
- **MCP SDK**: MIT, use later for trusted integrations only.

## Architecture decision

Build a thin TypeScript agent core with:

- Native Ollama `/api/chat` adapter.
- Zod-validated tool definitions.
- A real execution loop with approvals, audit, timeouts, cancellation, retries, and verification.
- Playwriter as the browser adapter.
- Local-only services bound to `127.0.0.1`.
- No Cline SDK, Goose, or cloud inference in the runtime.

## Known constraints

- Qwen3.5 defaults to thinking; disable thinking for tool turns unless a larger token budget is tested.
- 4096 context is safe on the 8 GB GPU; do not raise blindly.
- Windows long paths are disabled (`LongPathsEnabled=0`); address only if it becomes a practical problem.
- Playwriter CLI is 0.9.0 while npm reports a newer version; stay pinned until Phase 4 verifies compatibility.
- FFmpeg and `uv` are not installed; they belong to later creative/voice phases.
