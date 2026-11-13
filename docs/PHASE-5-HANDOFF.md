# Phase 5 Handoff Record

Status: **implementation complete and committed — host gate green — desktop live tests 1–3 verified — browser live test 4 verified — extension popup test 5A verified — extension report test 5 blocked by missing target extension**
Last updated: 2026-11-13 (desktop mouse reliability fix + extension popup live acceptance)

This document is the durable resume point for Phase 5. Update it after every milestone, live test, or before any long-running operation.

---

## 1. Git state

- Branch: `main`
- Phase 5 implementation commit: `734e777` (`feat(automation): complete Phase 5 vision and browser reliability`)
- `origin/main` before the Phase 5 push: `69a2f57` (`test(automation): record Phase 4 live acceptance results`)
- Follow-up desktop input reliability fix and this acceptance record: commit after `734e777` (see `git log -1`).
- Remote: `https://github.com/shrey-vyas-840/JarvisAI.git`
- No staged or uncommitted changes after the Phase 5 milestone commit. The host gate and live acceptance results in this document are from the committed tree.

---

## 2. What Phase 5 implements

| Area                        | Implementation                                                                                                                                                               | Location                                                                                       |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Desktop screenshot capture  | DPI-aware `ImageGrab.grab(bbox, all_screens=True)`, optional downscaling for vision, base64 transport, origin + scale metadata                                               | `tools/desktop/sidecar.py` (`capture_screenshot`, `capture_bbox`, `get_screen_info`)           |
| Screen geometry             | Virtual screen bounds, primary size, DPI, DPI scale                                                                                                                          | sidecar `get_screen_info`; CLI `desktop screen-info`                                           |
| Window wait                 | Polling `wait_for_window` by title/class, per-action timeout support                                                                                                         | sidecar; `DesktopManager.executeAction`; `desktop_wait_for_window`                             |
| Coordinate validation       | Virtual-screen and target-window bounds checks before click/drag/move/scroll                                                                                                 | sidecar                                                                                        |
| Typing into control         | `control_title` / `automation_id` focus target with password rejection                                                                                                       | sidecar `type_text`                                                                            |
| Local vision analyzer       | Ollama `/api/show` capability probe, `/api/chat` image input, JSON-schema output, Zod validation, normalized-coordinate conversion                                           | `src/vision/vision-analyzer.ts`, `src/vision/types.ts`                                         |
| Coordinate mapping          | Normalized 0–1000 model output → image pixels → physical screen / browser viewport CSS pixels                                                                                | `src/vision/coordinates.ts`                                                                    |
| Desktop vision locate       | Capture → local vision → mapped screen coordinates/centers                                                                                                                   | `desktop_vision_locate`                                                                        |
| Desktop vision click        | Fresh capture → local vision → confidence gate → one mapped click → re-capture → optional second vision verification                                                         | `desktop_vision_click`                                                                         |
| Browser vision locate/click | Page screenshot → local vision → viewport mapping; click with confidence gate                                                                                                | `browser_vision_locate`, `browser_vision_click`                                                |
| Extension discovery         | Read-only metadata from Chrome profile `Extensions` + `Local State`                                                                                                          | `src/browser/extension-discovery.ts`; CLI `browser extensions`; tool `browser_list_extensions` |
| Browser session reliability | Correct `/extensions/status` parsing, unknown-vs-zero status, bounded tab reads, responsive active-tab selection, readiness proof, stale-session recovery, structured errors | `src/browser/relay-manager.ts`, `src/browser/browser-manager.ts`, `src/browser/errors.ts`      |
| PNG dimensions              | Read width/height from PNG IHDR for browser screenshots                                                                                                                      | `src/browser/png-dimensions.ts`                                                                |
| Config                      | `OLLAMA_VISION_MODEL` (defaults to `OLLAMA_MODEL`)                                                                                                                           | `src/config.ts`                                                                                |
| System prompt               | Backend hierarchy (DOM → UIA → local vision), observe/act/verify, security guidance                                                                                          | `src/core/system-prompt.ts`                                                                    |
| CLI                         | `desktop screen-info`, `desktop screenshot`, `desktop vision`, `vision check`, `vision analyze`, `browser extensions`                                                        | `src/cli.ts`                                                                                   |

No new npm dependencies and no new Python dependencies were introduced; Pillow was already present in the sidecar venv.

### Vision coordinate protocol (important)

Qwen 3.5 9B returns **normalized 0–1000 grid coordinates**, not image pixels. The original implementation treated them as pixels, which produced badly offset or out-of-bounds clicks. The current implementation:

- Requiring `confidence` in the model JSON schema.
- Instructing the model to use the 0–1000 grid for `x`, `y`, `width`, and `height`.
- Validating normalized bounds against the 0–1000 grid before conversion.
- Converting to pixels with `normalizedRectToImageRect` before screen/viewport mapping.
- Dropping any normalized rectangle outside the grid as invalid rather than clamping it.

Live measurement after the fix: Notepad “Edit” menu located with confidence 0.98 and a 7 px center error versus UI Automation ground truth.

---

## 3. Phase 5 capability matrix

Legend: `LIVE_VERIFIED`, `IMPLEMENTED_AND_UNIT_TESTED`, `IMPLEMENTED_BUT_NOT_LIVE_TESTED`, `PARTIALLY_IMPLEMENTED`, `LIVE_FAILED`, `NOT_IMPLEMENTED`, `BLOCKED_BY_MANUAL_ACTION`.

| Requirement                                           | Existing files                                                                             | Tests                                                                                                           | Current status                                                     | Missing work / next action                                                      |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------- |
| Screen capture (desktop/window)                       | `tools/desktop/sidecar.py`, `src/desktop/desktop-manager.ts`, `src/tools/desktop/index.ts` | mocked desktop tools; live Notepad captures                                                                     | `LIVE_VERIFIED`                                                    | Preserve                                                                        |
| Screenshot storage & privacy                          | sidecar, desktop tool, browser screenshot tool                                             | registration/mocks; live temp-only capture                                                                      | `LIVE_VERIFIED` (temp-only; vision-only capture is not persisted)  | Preserve                                                                        |
| PNG dimension parsing                                 | `src/browser/png-dimensions.ts`                                                            | `tests/browser/png-dimensions.test.ts` (3)                                                                      | `LIVE_VERIFIED` (browser screenshot 1920×799 in Test 4)            | Preserve                                                                        |
| Local Ollama image input                              | `src/vision/vision-analyzer.ts`                                                            | `tests/vision/vision-analyzer.test.ts`                                                                          | `LIVE_VERIFIED` (real image round-trip)                            | Preserve                                                                        |
| Structured visual understanding + Zod validation      | `src/vision/types.ts`, analyzer                                                            | unit tests                                                                                                      | `LIVE_VERIFIED`                                                    | Preserve                                                                        |
| DPI/scale coordinate mapping                          | `src/vision/coordinates.ts`, sidecar DPI awareness                                         | `tests/vision/coordinates.test.ts`                                                                              | `LIVE_VERIFIED` (7 px error vs UIA on Notepad)                     | Preserve                                                                        |
| Desktop window inspection/enumeration/focus           | sidecar, `DesktopManager`, tools                                                           | mocked; live                                                                                                    | `LIVE_VERIFIED`                                                    | Preserve                                                                        |
| Desktop get controls                                  | sidecar `get_controls`, tool                                                               | mocked; live Notepad/UIA                                                                                        | `LIVE_VERIFIED`                                                    | Preserve                                                                        |
| Desktop typing / key press                            | sidecar, tools                                                                             | mocked; live typing and shortcuts                                                                               | `LIVE_VERIFIED`                                                    | Preserve                                                                        |
| Desktop click / double / right / move / scroll / drag | sidecar, tools                                                                             | mocked; live single left click and extension checkbox toggles                                                   | `LIVE_VERIFIED` for left click; other buttons not live-tested      | Test only if needed                                                             |
| Wait for window/state                                 | sidecar `wait_for_window`, tool                                                            | mocked; live Notepad wait                                                                                       | `LIVE_VERIFIED`                                                    | Preserve                                                                        |
| Vision-guided desktop action                          | `desktop_vision_locate`, `desktop_vision_click`                                            | unit + live Notepad menu click                                                                                  | `LIVE_VERIFIED`                                                    | Preserve; never auto-repeat clicks                                              |
| Vision-guided browser action                          | `browser_vision_locate`, `browser_vision_click`                                            | registration/unit + live Wikipedia Test 4                                                                       | `LIVE_VERIFIED`; viewport fallback + safe post-click title read    | Preserve                                                                        |
| Browser relay/session readiness                       | `relay-manager.ts`, `browser-manager.ts`, `errors.ts`                                      | `tests/browser/relay-manager.test.ts` (6), `browser-manager-connection.test.ts` (10), `browser-manager.test.ts` | `LIVE_VERIFIED` (status, readiness, tabs, navigate, new/close tab) | Preserve; do not treat an open relay port as a ready session                    |
| Chrome extension discovery                            | `extension-discovery.ts`, CLI, tool                                                        | `tests/browser/extension-discovery.test.ts` (3)                                                                 | `IMPLEMENTED_AND_UNIT_TESTED`; live CLI read 34 extensions         | Preserve                                                                        |
| Extension popup interaction                           | composable desktop tools only; no dedicated abstraction                                    | live Adblock Plus popup: open, inspect, toggle, restore, close                                                  | `LIVE_VERIFIED` with Adblock Plus; no dedicated abstraction        | Reuse the UIA + physical-click sequence for another extension when needed       |
| Extension report workflow (GBP audit/PDF)             | none                                                                                       | none                                                                                                            | `BLOCKED_BY_MANUAL_ACTION`                                         | Requires an installed audit/report extension; do not install one to pass a test |
| Observe–Act–Verify orchestration                      | AgentLoop + system prompt; vision click re-observes                                        | agent-loop tests; live Notepad menu + browser nav                                                               | `LIVE_VERIFIED` for vision-click flows                             | Preserve                                                                        |
| Safe bounded retries                                  | AgentLoop limits + repeated-call detection; vision click never auto-retries                | agent-loop tests                                                                                                | `IMPLEMENTED_AND_UNIT_TESTED`                                      | Preserve                                                                        |
| AgentLoop integration                                 | all tools registered in `runAgentCommand`                                                  | existing tests                                                                                                  | `IMPLEMENTED_AND_UNIT_TESTED`                                      | Optional live AgentLoop browser run; tools already live-verified directly       |
| Execution receipts                                    | `ToolRegistry` receipts                                                                    | existing tests                                                                                                  | `IMPLEMENTED`; new tools do not add a `verify` hook                | Preserve                                                                        |
| Security / approvals                                  | password block, URL guard, approvals, relay loopback                                       | existing tests                                                                                                  | `IMPLEMENTED_AND_UNIT_TESTED`                                      | Regression test                                                                 |
| Documentation                                         | this file, `STATUS.md`, `PHASE-LOG.md`, `TEST-REPORT.md`                                   | —                                                                                                               | `COMPLETE` for Phase 5 at this milestone                           | Keep updated through milestones                                                 |

---

## 4. Host verification (2026-11-13)

```text
npm run typecheck    PASSED
npm run lint         PASSED
npm run format:check PASSED
npm test             35 test files passed, 245 tests passed (2.44 s)
npm run build        PASSED
```

The lint and Prettier failures from the interrupted session were fixed. An earlier repair replaced the `mouse_click` double-click branch because `pywinauto 0.6.9` does not accept a `double` keyword; the 2026-11-13 fix below supersedes the pywinauto mouse helpers entirely.

The 2026-11-13 acceptance rerun found a second input defect: `pywinauto.mouse.click(coords=...)` passed physical screen coordinates as absolute normalized coordinates, which moved the cursor to the wrong place, and `set_focus()` did not activate Chrome extension popups. The sidecar now positions the cursor with `SetCursorPos`, sends button events at the current cursor, scrolls with `MOUSEEVENTF_WHEEL`, and falls back to `SetForegroundWindow` when a target does not become foreground. A background target is activated before any physical click so input cannot land in an unrelated foreground window.

---

## 5. Live verification performed (2026-11-09 through 2026-11-13)

Evidence is in `C:\Users\SHREYV~1\AppData\Local\Temp\opencode\jarvis-phase5\`.

### Test 1 — Desktop typing/read-back — `LIVE_VERIFIED`

- Opened a dedicated empty temp file in Notepad (never a user tab), focused it, and guarded that the document was empty before typing.
- Typed `JARVIS Phase 5 safe notepad test 1794208064352` (46 characters).
- UI Automation read-back matched exactly (`readBackExact: true`).
- Saved only to the disposable temp file, closed the tab, and deleted the temp file.
- Evidence: `notepad-safe-window.png` plus console JSON from `notepad-safe.mts`.

### Test 2 — Local vision accuracy — `LIVE_VERIFIED`

- Captured the dedicated Notepad window (773×758).
- Qwen 3.5 9B returned `Edit menu item` at normalized confidence `0.98`, mapped to image `(77, 64, 47, 31)`.
- UI Automation ground truth: image center `(102, 72)`.
- Center error: **7 px**. Inference latency: **4.34 s**.
- Evidence: console JSON from `notepad-safe.mts` (`distanceFromGroundTruth: 7`).

### Test 3 — Observe → Act → Verify — `LIVE_VERIFIED`

- Observed menu bar: `File`, `Edit`, `View`, `System`.
- `desktop_vision_click` captured fresh, located “the Edit menu item near the top of the window” (confidence `0.98`), clicked screen `(1254, 210)`, and re-captured.
- Re-observation via UI Automation showed the Edit menu opened: `Undo`, `Cut`, `Copy`, `Paste`, `Delete`, `Find`, `Replace`, `Go to`, `Select all`, `Time/Date`.
- Action latency: **4.7 s**. The click was a single left click and was not repeated.
- Cleanup: Escape closed the menu; the disposable tab was closed and the temp file deleted.
- Evidence: console JSON from `observe-act-verify.mts` (`verified: true`).

### Test 4 — Browser session / navigation — `LIVE_VERIFIED` (2026-11-10)

Playwriter relay `0.9.0` is running at `127.0.0.1:19988`. The extension is activated in Profile 4 (`vs.shrey@gmail.com`, stable key `install:Chrome:1iuprv21hdwovw`) and reports `activeTargets: 2`.

Root causes fixed before the rerun:

- JARVIS probed the non-existent `/extensions` endpoint (404), swallowed the error, and printed a false `Connected Chrome Extensions: 0`. The relay actually exposes `/extensions/status` with a wrapped `{ "extensions": [...] }` payload. The relay list is now parsed correctly; an unreadable inventory reports `unknown`, never `0`.
- `connect()` blindly made `context.pages()[0]` active. That target was the real ChatGPT tab with an empty committed URL whose `title()` never resolved, so `listTabs()` hung forever (observed >120 s) and navigation failed intermittently. Tab reads are now bounded, empty-URL targets are marked `UNRESPONSIVE`, and JARVIS selects the first responsive tab (or opens its own tab) instead of trusting index 0.

Live acceptance output after the fix:

```text
browser status      RUNNING, listening YES, version 0.9.0, extensions 1 (vs.shrey@gmail.com, active tabs 2)
browser readiness   READY in 870 ms, 1 attempt, enabled tabs 2, responsive tabs 1, session ready
browser tabs        completed in 2.6 s; tab 0 shown as [UNRESPONSIVE] (no URL), tab 1 Example Domain
connect             893 ms, session id 8
navigate            https://example.com/ → "Example Domain", recovered false
new tab             https://example.org/ → responsive, JARVIS-owned, 2.8 s
close JARVIS tab    closed, 2 user tabs remain
readiness again     READY in 187 ms
```

Stale-session recovery is covered by unit tests (first navigation rejects with a closed-target error, JARVIS reconnects once, then navigation succeeds). It was not induced against the live browser because that would require disrupting the user's Chrome/relay session.

### Test 5A — Extension popup interaction — `LIVE_VERIFIED` (2026-11-13)

Target: installed `Adblock Plus - free ad blocker` `4.51.0` (`cfhdojbkjhnklbpkdaibdccddilifddb`) in Profile 4 (Chrome handle `131750`). No extension files, settings, or profiles were modified.

- Opened the Chrome `Extensions` menu through the toolbar control (`automation_id: view_1006`), then opened the Adblock Plus popup with JARVIS physical mouse clicks.
- Inspected the popup through UI Automation: `Adblock Plus` document, `Options` button (`options`), comparison links, two checkboxes, and the page/global text. Both checkboxes started at `toggle_state: 1`.
- Found and fixed the desktop input defect described in Section 4, leaving both toggles at `[0, 0]`. Then drove the checkbox at screen `(1705, 237)` through `DesktopManager.mouseClick` in a three-click cycle: `[0, 0] → [1, 1] → [0, 0] → [1, 1]`. Each state was read back independently after the click.
- The final state was restored to the starting `[1, 1]`, the popup was closed, and no extension setting was left changed.
- Evidence: console JSON from `jarvis-toggle-cycle.mts` plus `toggle-state.py` under `C:\Users\SHREYV~1\AppData\Local\Temp\opencode\jarvis-phase5\`; no screenshots or private artifacts were committed.

### Test 5 — Extension report workflow — `BLOCKED_BY_MANUAL_ACTION`

- No suitable business-audit/PDF-report extension is installed in the inspected profiles (4/5/9/10/11/12). The extension report workflow cannot be tested without the user identifying or installing one. Do not install an extension just to pass a test. Test 5A verifies generic popup interaction, not a report workflow.
- Note: the Playwriter extension reports `playwriterVersion: 0.8.0` while the relay/package is `0.9.0`. JARVIS now treats this as diagnostic metadata only and does not block on it.

---

## 6. Incident record — pre-existing Notepad user tab

The first Notepad live attempt revealed that Windows 11 Notepad is single-instance. Launching `notepad.exe` while user tabs were open typed the test text into an existing tab (`Swagger Opener Commands.txt`, which contained an API key). Recovery:

- The full original buffer was reconstructed from captured evidence and restored **exactly** (646 characters, `exactRestored: true`) via clipboard `Ctrl+A` / `Ctrl+V`.
- The test text was removed, the clipboard was cleared, and the buffer was **never saved**; the on-disk file was untouched.
- The affected tab lost its filename association and now appears as an untitled modified tab containing the original text.
- All later Notepad tests open a dedicated empty temp file, guard that it is empty, and never target user tabs.

Undo/redo did not restore the buffer (`Ctrl+Z` undid a large paste; `Ctrl+Y` had no effect); restoration used clipboard replacement.

---

## 7. Known issues / limitations

1. One attached Chrome target can have an empty URL and a `title()` call that never resolves. JARVIS now marks such tabs unresponsive, bounds every title read, and never selects them as the active page; they are still visible in `browser tabs` for operator awareness.
2. The model returns normalized 0–1000 coordinates. This is now handled, but any future model swap must be re-measured; some models return pixel coordinates and would need a different adapter.
3. Precision is about 7 px on a clear menu target. Small or densely packed targets (for example calculator keypad keys) may still be mis-centered; never auto-repeat a click, and prefer UIA/DOM when available.
4. Confidence is now required by the JSON schema, but a model may still omit it; missing confidence is treated as 0 by the desktop click filter (fail closed).
5. Vision rectangles must fit fully inside the captured image after normalization; partially clipped elements are dropped, not clamped.
6. `desktop_get_controls` can return deep UIA trees and hit timeouts on complex apps; use `limit` and window-scoped inspection.
7. The extension may report an older `playwriterVersion` than the relay (`0.8.0` vs `0.9.0` here). This is surfaced as diagnostics only; update the extension through Chrome when convenient, but JARVIS no longer depends on the versions matching.
8. Extension popup automation has no dedicated abstraction. The composable desktop tools were live-verified against Adblock Plus (Test 5A), but each new extension may expose different UIA control names; inspect before clicking and verify state after every action.
9. A requested profile that is not connected now fails with `no-matching-browser` instead of silently falling back to another profile.

---

## 8. Manual actions / dependencies

- Playwriter extension activation (Profile 4) is complete; do not ask the user to repeat it unless fresh diagnostics show zero connected extensions.
- **Manual action:** identify/install a suitable audit or report extension if the extension report workflow is required. Do not install one solely to pass a test.
- No new npm/Python dependencies are required for the remaining baseline work.

---

## 9. Next steps

1. Phase 5 implementation is committed in `734e777`; the 2026-11-13 input fix and documentation land in the follow-up commit.
2. `STATUS.md`, `PHASE-LOG.md`, and `TEST-REPORT.md` are updated with the 2026-11-13 host gate, extension popup acceptance, and remaining blocker.
3. Optionally run the extension report workflow (Test 5) only if the user supplies or identifies a suitable audit/report extension. Do not install one solely to pass a test.
4. Only after Phase 5 is pushed, evaluate `vercel-labs/agent-desktop` through the smallest safe adapter and benchmark latency/token usage.

### Resume commands

```powershell
git status --short
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
npx tsx src/cli.ts browser status
npx tsx src/cli.ts browser readiness
npx tsx src/cli.ts browser tabs
```
