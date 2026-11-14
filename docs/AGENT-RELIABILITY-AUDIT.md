# General-purpose agent reliability audit

Audit date: 2026-11-14. This document describes the current working tree; it is not a claim of live multi-application acceptance.

## Working capabilities

| Area                                                                    | Current state                    | Evidence / limitation                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tool registration, Zod validation, bounded execution, approval receipts | Automated-tested                 | ToolRegistry validates unknown and malformed calls, records approval and verification receipts.                                                                                                                                                                             |
| General model-generated planning                                        | Implemented and automated-tested | Production `agent` asks Qwen for a JSON plan built from the live registered tool catalog; the runtime validates tools, dependencies, source references, and cycles before Orchestrator execution, then returns phase evidence for bounded continuation or replanning.       |
| Orchestrator dependency execution                                       | Automated-tested                 | Dependencies, retries, blocked steps, plan transitions, and receipt storage are tested. A failed prerequisite blocks dependents while independent steps continue.                                                                                                           |
| Browser sessions                                                        | Partially live-verified          | The external relay and Chrome profile were previously live-probed; the normal-session browser task has not yet been re-run with the new generic planner. Browser controls can now be bound to a stable JARVIS tab ID for snapshots, text searches, clicks, and field fills. |
| pywinauto desktop UIA                                                   | Live-verified                    | The normal-session disposable Notepad acceptance passed: unique artifact, exact UIA target identification, write/read-back, disk verification, reset, and cleanup.                                                                                                          |
| Agent Desktop                                                           | Blocked                          | Its snapshot probe reports a private-file DACL granting an untrusted principal. No ACL changes are being made; pywinauto remains the selected fallback.                                                                                                                     |
| Generic desktop data entry                                              | Implemented and automated-tested | `desktop_set_control_value` requires a unique UIA control, exact window identity and pre-value, uses ValuePattern only, and independently reads back. It refuses password, stale, ambiguous, or keyboard-fallback targets.                                                  |
| Excel desktop capability                                                | Partially implemented            | Excel is an allowlisted generic desktop application. A live UI workflow still needs normal-session acceptance; no direct-file library is treated as Excel UI evidence.                                                                                                      |
| Artifact verification                                                   | Implemented and automated-tested | `verify_artifact` independently checks directories, exact text content, common image signatures/dimensions, and XLSX row/column dimensions using read-only parsing.                                                                                                         |
| Vision / UIA cross-check                                                | Implemented                      | Local vision remains available as a fallback after browser/desktop accessibility inspection. It is not used for low-confidence actions.                                                                                                                                     |

## Defects repaired in this working tree

- The ordinary CLI previously used either a free-running tool loop or a narrow hard-coded URL workflow. The production path now uses a model-authored plan rather than request keywords or an application-specific sequence.
- Backend routing previously treated non-browser/non-desktop registered tools as `vision`; local tools now execute locally, and backend capability routing recognizes the registered browser and pywinauto tool families rather than a stale short list.
- The CLI now shares the same Agent Desktop client and desktop manager with the backend router, so runtime backend probes apply to the tools being executed.
- Browser tool operations that must stay in a JARVIS-owned tab can receive the returned stable tab ID rather than relying on whichever tab happens to be active.

## Remaining limits before black-box multi-application acceptance

- The model planner is bounded and validates plans, but requires a normal interactive Windows session for browser/desktop execution. CodexSandboxOffline must not be used as live desktop evidence.
- The planner supports bounded automatic continuation and replanning. Live complex application interaction still depends on the model selecting adequate observation and verification steps.
- The generic Excel path must be live-tested through visible Excel UI with independent range and saved-artifact read-back; `verify_artifact` is supplemental saved-workbook evidence only.
- A local image-viewer read-back is not yet available as a registered reusable tool.
- Authentication, CAPTCHA, confirmation dialogs, and quota restrictions remain user-controlled blockers and are never bypassed.

## Normal-session launch

From a non-administrator PowerShell session in `D:\AI\JarvisAgent`, after a production build:

```powershell
node dist/cli.js agent "<ordinary natural-language request>"
```

Use `node dist/cli.js desktop acceptance` only for its isolated desktop regression test; it is not the normal task execution path.
