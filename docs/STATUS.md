# JARVIS Status

## 2026-11-14 Phase 6 recovery update

- Full quality gate is green on the current working tree: typecheck, full ESLint, Prettier check, build, and 297 tests across 41 files pass. `npx eslint src/cli.ts --no-cache` reports no errors. The prior IDE CLI warnings were stale relative to fresh ESLint output.
- Full lint failures were rooted in the root-level `milestone3-demo.ts` not being part of the TypeScript project service, existing orchestration lint issues, and test typing. ESLint now explicitly permits the real demo as a default-project file; the demo and orchestration/test issues are corrected without weakening strict TypeScript rules.
- The previous desktop CLI test failure was caused by spawning the real desktop sidecar in the test. The CLI now accepts an injected desktop manager and the test uses a fixture; production behavior remains unchanged.
- Orchestration now refreshes accessibility snapshot and uniquely resolves a target after a safely undelivered stale `snapshot_id` error. Exhausted steps become FAILED, dependent steps are SKIPPED, plan state is terminal, and uncertain action delivery is not retried. Focused tests cover stale-reference recovery and uncertain delivery.
- Live browser readiness passed against the existing external Playwriter 0.9.0 relay at `127.0.0.1:19988`, with one connected extension and one responsive tab. No Chrome or relay process was restarted or stopped.
- Current desktop readiness is BLOCKED. Agent Desktop state access failed because the state file is owned by another Windows principal; selector probing also failed at `EnumWindows`. pywinauto is unavailable because global Python is absent and the project venv references a missing Python 3.12 installation. The backend selector selected no desktop backend.
- Because the desktop backend gate is not satisfied, the GitHub README, Google Maps, and Gemini image acceptance workflow was not started. See [PHASE-6-READINESS.md](PHASE-6-READINESS.md) for capability evidence and remaining work.
- Starting commit: `87f6b229fe67ed2bb7e213f50e5ab7e6c70234c5`; current work is not yet committed. See the recovery checkpoint in `PHASE-6-HANDOFF.md` for current Git status and next commands.

Last updated: 2026-11-13

## 2026-11-13 TypeScript recovery

- Current `npm run typecheck` and `npm run build` pass. ESLint passes for `src/cli.ts`, `src/browser`, `src/logging`, and the new Playwriter process-manager test.
- The RelayStatus errors came from three new dynamic import type references pointing at `relay-manager.js`; `browser-manager.ts` now refers directly to the single definition in `browser/types.ts`. The browser barrel again exports `types.ts`.
- Playwriter stdout/stderr redirection now passes numeric descriptors from `openSync` to `spawn` and closes both parent descriptors. Logger consumers share the four-method `LoggerLike` shape.
- Full lint, formatting, and test gates remain blocked by existing orchestration lint/style findings, a missing `milestone3-demo.ts` file referenced by ESLint, and the desktop-windows CLI test failing in this environment. See `issue.md` for the error ledger and exact command results.
- Runtime: CLI help/version passed; JARVIS status and browser status report Ollama READY, Playwriter 0.9.0 with one connected Chrome extension, and browser READY. Agent Desktop reported NOT READY. `start` reused the externally owned relay and did not claim full JARVIS readiness; `stop` correctly left that external relay running.

## Current position

- Phase 0: complete.
- Phase 1: complete and published.
- Phase 2: complete.
- Phase 3: complete; read-only filesystem tools implemented and verified.
- Phase 3B: approval-gated `create_directory` and `write_text_file` implemented, unit/integration tested, and live-tested with manual interactive approval.
- Phase 4: live acceptance complete (2026-11-08); browser automation, web research, OpenStreetMap adapter, Excel builder, and Windows desktop sidecar implemented, unit-tested, and 5/5 live host tests LIVE_VERIFIED.
- Phase 5: implementation complete, committed as `734e777`, and host gate green on 2026-11-13 after a desktop input reliability fix; local Ollama vision, screenshot capture, extension discovery, browser session readiness/recovery, and `desktop_vision_click` are implemented and tested. Desktop live Tests 1–3, browser live Test 4, and extension popup Test 5A (Adblock Plus) are LIVE_VERIFIED. Browser Test 5 (extension report workflow) remains BLOCKED_BY_MANUAL_ACTION because no suitable audit/report extension is installed.

## What exists now

- TypeScript/Node project scaffold with exact pinned dependencies and `package-lock.json`.
- Strict TypeScript configuration for type checking and a separate build configuration.
- ESLint 10 flat configuration with type-aware TypeScript rules.
- Prettier configuration and formatting check.
- Vitest configuration and 245 passing tests across 35 files on the real host.
- npm scripts for development, build, start, typecheck, lint, format, format check, and test.
- Zod-validated configuration with safe local defaults, absolute path resolution, and optional `.env` loading.
- Structured JSON logger with secret redaction, console/file output, level filtering, child bindings, and size-based rotation.
- Testable CLI with `version`, `health`, `health --json`, `agent`, `help`, `--version`, `--help`, `-v`, and `-h`.
- Read-only health diagnostics for Node, npm, required directories, workspace, Ollama API/version/model, Playwriter package/CLI, relay port, and NVIDIA status.
- Native Ollama `/api/chat` client with structured tool-call handling, response validation, timeout/cancellation, and one transient retry.
- Registered-only tool system with JSON Schema tool definitions, Zod argument validation, execution receipts, permissions, verification, and timeouts.
- Bounded agent loop with 8 tool rounds, 12 tool calls, 20,000-character tool-output limit, sequential execution, cancellation, and repeated-call detection.
- `get_jarvis_status` read-only diagnostic tool returning verified version, Node/platform, configured model/context, timestamp, execution ID, and call ID.
- Six filesystem tools registered in the default agent runtime:
  - `list_directory`: bounded directory listing with actual entry metadata.
  - `read_text_file`: UTF-8 text reads with byte/character limits and binary/sensitive-file rejection.
  - `search_text`: bounded literal text search with depth, file, size, match, and excerpt limits.
  - `get_file_info`: verified file or directory metadata without contents.
  - `create_directory`: approval-gated creation of one new directory with an existing parent, no recursion, no overwrite, link rejection, and post-create verification.
  - `write_text_file`: approval-gated creation of one new UTF-8 text file, maximum 64 KiB, exclusive creation, no overwrite, exact read-back/SHA-256 verification, and partial-file reporting.
- Injected `ApprovalProvider` integration in `ToolRegistry` with per-operation approval, approval audit events, and receipt approval status.
- `CliApprovalProvider` using `readline/promises`, explicit affirmative answers only, a default No prompt, a 5-minute timeout, and fail-closed behavior for non-interactive execution, EOF, invalid input, provider errors, and Ctrl+C.
- `PathGuard` restricted to the `workspace` (`D:\AI\JarvisWorkspace`) and `exports` (`D:\AI\Exports`) roots.
  - Rejects traversal, absolute and rooted paths, drive changes, UNC and device paths, alternate data streams, invalid components, reserved device names, and symlink/junction escapes.
  - Revalidates the resolved target immediately before use and fails closed.
- Filesystem safety filtering rejects credential-like filenames and directories, binary content, and invalid UTF-8.
- System prompt guidance for approved roots, relative paths, per-operation approval, no-overwrite behavior, and write verification.
- `jarvis agent "<message>"` local agent command with file logging, SIGINT cancellation, and exit-code mapping.
- Live Phase 2 acceptance run completed against `qwen3.5:9b`: 2 rounds, 1 structured `get_jarvis_status` call, successful verification, 8.249 seconds, 100% GPU, 5.6 GB model, 4096 context.
- Live Phase 3 acceptance runs completed against `qwen3.5:9b`:
  - Real `list_directory` and `get_file_info` calls returned verified, accurate results for the empty workspace root.
  - A non-existent text-file request accurately reported that the workspace was empty.
  - Outside-root absolute-path and traversal attempts failed with `absolute_path` and `path_traversal` respectively.
  - Each run used structured tool calls, 2 rounds, and a verified receipt; the negative tool calls failed without reading outside the approved root.
- Phase 3B automated verification: typecheck, lint, format check, build, and 175 tests across 21 files passed.
- Phase 3B live fail-closed check completed against `qwen3.5:9b`: a real structured `create_directory` call in a non-interactive shell produced `Approval is unavailable`, the agent stopped, no directory was created, and the log recorded `approval.unavailable` without file content.
- Phase 3B interactive acceptance completed with genuine manual approval prompts:
  - `create_directory` created `phase3b-acceptance-dir`, independently verified.
  - The first `write_text_file` created `hello.txt` but the content missed the requested final period; the discrepancy is recorded and was not reported as the requested exact text.
  - The exact-content retest created `hello-exact.txt` containing `Hello from JARVIS Phase 3B.` at 27 bytes; PowerShell ordinal comparison returned `True` and tool verification passed.
  - A second write to existing `hello.txt` was rejected with `already_exists`; no overwrite occurred.
  - A traversal write to `..\JarvisAgent\phase3b-escape.txt` was rejected with `path_traversal`; the external file does not exist.
  - The accepted workspace files were preserved and not deleted.
- Latest health run (2026-11-08): `Overall: OK`; all 8 checks passed, including the Playwriter relay at `127.0.0.1:19988`; exit code `0` for text and JSON output.
- Phase 4 live acceptance (2026-11-08):
  - Chrome/Playwriter: connected to profile `vs.shrey@gmail.com`, listed and opened tabs, and navigated to `https://example.com` with title, URL, and body text extracted.
  - Windows desktop: launched Notepad, inspected and focused handle `198384`, typed `JARVIS desktop acceptance test successful.`, and verified the exact text plus `42 characters` through UI Automation; no file saved.
  - OpenStreetMap: Ahmedabad fallback returned 5 elements and 4 named records with locations, null-preserving fields, and ODbL 1.0 attribution; postcode `380061` and `Ghatlodia` have no OSM boundary data.
  - Excel: after explicit approval, created `D:\AI\Exports\jarvis-phase4-acceptance.xlsx` (10,677 bytes; SHA-256 `42c0e159e4f3edb54b7d35c0be3025fd6833f68879d41edf85da2f3da852a326`); read-back verified 3 sheets, 4 business rows, summary, attribution, and overwrite rejection.
  - Crawler: evaluated 432 robots.txt rules and crawled `https://www.wikipedia.org/` (1 page, 8,899 characters, 784 ms) with same-domain boundaries enforced.
- Phase 4 host verification: typecheck, lint, format check, and build passed; `npm test` reported 30 files and 212 tests passing.
- Phase 5 host verification (2026-11-13, committed tree): typecheck, lint, format check, and build passed; `npm test` reported 35 files and 245 tests passing.
- Phase 5 desktop live acceptance:
  - Notepad typing/read-back: a dedicated empty temp file was typed with `JARVIS Phase 5 safe notepad test 1794208064352` (46 characters); UI Automation read-back matched exactly; the disposable tab was closed and the temp file deleted.
  - Local vision accuracy: Qwen 3.5 9B located the Notepad “Edit” menu with confidence 0.98 at a 7 px center error versus UI Automation; inference took 4.34 s.
  - Observe→act→verify: `desktop_vision_click` captured fresh, clicked the located Edit menu once at screen `(1254, 210)`, re-captured, and UI Automation confirmed the menu opened (`Undo`, `Cut`, `Copy`, `Paste`, `Find`, `Replace`, and more). Action latency 4.7 s; no automatic retry.
- Phase 5 vision coordinate protocol: the model returns normalized 0–1000 coordinates; the analyzer validates them on that grid, converts to image pixels, and drops out-of-grid rectangles. This fixed offset/out-of-bounds clicks caused by treating normalized values as pixels.
- Phase 5 browser reliability (2026-11-10): `browser status` now parses the relay's actual `/extensions/status` payload and reports `unknown` instead of a false `0` when inventory fails. Active-tab selection now skips unresponsive targets (an attached ChatGPT target with an empty URL and a non-resolving `title()` caused hangs), all title reads are bounded, a readiness check proves the session with a harmless read, and stale-session navigation retries once after reconnecting.
- Phase 5 browser live acceptance (2026-11-10): readiness READY in 870 ms; `browser tabs` completed in 2.6 s; navigate to `https://example.com/` returned `Example Domain`; a JARVIS-owned `https://example.org/` tab opened and closed cleanly; readiness recheck READY in 187 ms.
- Phase 5 extension popup live acceptance (2026-11-13): opened the installed Adblock Plus popup through the Chrome Extensions menu, inspected its UI Automation tree, and drove a checkbox through `DesktopManager.mouseClick` for repeated on/off cycles (`[1,1]` initial → `[0,0]` → `[1,1]` → `[0,0]` → `[1,1]`) with state read-back after each click. The starting state was restored and the popup was closed; no extension files or settings were left modified.
- Phase 5 desktop input reliability fix (2026-11-13): replaced pywinauto's absolute mouse helpers with `SetCursorPos` plus mouse events, added wheel-event scrolling and drag support, and added a `SetForegroundWindow` fallback so physical input is delivered to the intended target instead of an unrelated foreground window.
- Phase 5 implementation is committed on `main` as `734e777`; the 2026-11-13 input fix and documentation are in the follow-up commit.
- Git repository on branch `main`, published to GitHub; Phase 1 commit `49aa18fc6660d1aa5f7f06d1aed5c5ac530395bb`; Phase 2 commit `59c6b10fc7a1871d22e7c52497f18f6b64b900bb`; Phase 3 commit `e713aea` preserved; Phase 4 implementation checkpoint `86b6ea83c818a1896f6bf928b6779623e81c720d`; Phase 5 commit `734e777`.
- Documentation baseline, Phase 2 handoff, Phase 3 handoff/status, Phase 3 completion records, `docs/SECURITY.md`, `docs/PHASE-3B-HANDOFF.md`, `docs/PHASE-4-HANDOFF.md`, and `docs/DATA-SOURCES.md`.

## What does not exist yet

- Overwrite, delete, move, rename, recursive directory creation, and binary-file writes.
- A live extension report/PDF workflow: no suitable audit/report extension is installed in the inspected profiles.
- Voice, local memory, creative image/video generation.
- Live testing of browser click/fill/submit/download, multi-page crawl rate delay, Google Maps navigation, Chrome profile launch, switching to a user tab, and desktop mouse buttons other than left click.
- OSM postcode/locality boundaries for `380061` and `Ghatlodia`; Overpass on this host requires IPv4-first DNS.

## Safety state

- Phase 1 health checks perform only read-only local operations.
- Registered tools comprise the read-only diagnostic/filesystem tools, the two approval-gated filesystem writes, and the Phase 4 browser, research, geo, Excel, and desktop tools.
- The read-only filesystem tools are `list_directory`, `read_text_file`, `search_text`, and `get_file_info`.
- `create_directory` and `write_text_file` require explicit per-operation approval and never overwrite existing paths.
- Filesystem tools accept only the `workspace` and `exports` root identifiers and relative paths.
- Absolute paths, traversal, drive changes, UNC/device paths, alternate data streams, invalid components, reserved device names, and symlink/junction escapes are rejected before access.
- The path guard revalidates each resolved target before use and fails closed when a path changes or leaves an approved root.
- Credential-like files and directories, binary files, and invalid UTF-8 are rejected for text reads and writes, and excluded from search.
- Approval fails closed for missing providers, non-interactive execution, Enter, EOF, invalid input, timeout, Ctrl+C, and provider errors.
- Denied or unavailable approval stops the run before later side-effecting operations execute.
- The agent calls only the local Ollama endpoint and only executes tools registered in the in-process registry.
- Tool arguments are validated with Zod before execution; unknown tools and invalid arguments are rejected.
- Tool results are returned to the model with explicit status, approval, and verification fields; failures and timeouts are not reported as success.
- Agent logs use the redacting file logger and do not include full prompts, file contents, approval answers, or secrets.
- The live non-interactive Phase 3B check made no writes in the approved roots.
- The interactive Phase 3B acceptance created `phase3b-acceptance-dir`, `hello.txt`, and `hello-exact.txt` only after explicit manual approval.
- The negative overwrite and traversal acceptance attempts made no changes; the traversal target outside the root does not exist.
- Interactive positive write acceptance is complete, and the accepted workspace files are preserved.
- The Playwriter relay binds only to loopback `127.0.0.1`; the live browser connection used the loopback relay.
- The live Excel export required explicit human approval, created only the approved new file, and rejected a second write to the same path.
- The live desktop test typed into an unsaved Notepad document and did not save a file; the user's other Notepad tab was untouched.
- OpenStreetMap output retained ODbL 1.0 attribution and left unavailable fields `null` instead of inventing values.
- Phase 5 local vision sends screenshots only to the local Ollama endpoint; vision-only captures are not persisted, and vision rectangles outside the valid grid are dropped rather than clamped.
- `desktop_vision_click` performs at most one click per call, re-observes afterward, and never auto-repeats a click; missing confidence fails closed.
- A pre-existing Windows 11 Notepad user tab was affected by the first live attempt because Notepad is single-instance. The original 646-character buffer was restored exactly from evidence, the test text was removed, the clipboard was cleared, and the buffer was never saved; the on-disk file was untouched.
- All later Notepad tests use a dedicated empty temp file, verify it is empty before typing, and delete the temp file afterward.
- The extension popup test modified only a user-visible toggle in Adblock Plus, verified each state through UI Automation, restored both toggles to their starting value, and closed the popup. No extension files, profiles, or settings were edited.
- Desktop input now activates the intended target before a physical click and reports the final cursor position, so a click cannot silently land in another foreground window.
- No secrets are stored in source, documentation, logs, or Git.
