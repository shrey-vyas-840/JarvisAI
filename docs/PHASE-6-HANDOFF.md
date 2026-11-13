# Phase 6 Handoff - Milestone 1 Complete

**Date**: 2026-11-13
**Commit**: (pending)
**Milestone**: 1 - Agent Desktop Adapter & Backend Selection

## Summary
Completed Milestone 1 of Phase 6: integrated `vercel-labs/agent-desktop@1.3.0` as a minimal TypeScript adapter with automatic backend selection between Agent Desktop and pywinauto fallback.

## Verified Facts
- **Agent Desktop package**: `agent-desktop@1.3.0` (Apache-2.0, vercel-labs/agent-desktop, Node >=18, Windows x64/ARM64)
- **CLI protocol**: JSON envelope version 2.6
- **Platform support**: Windows confirmed, accessibility granted, surfaces include window, focused, menu, start-menu, taskbar, system-tray, action-center
- **Binary**: Working native executable at `node_modules/agent-desktop/bin/agent-desktop-win32-x64.exe` (postinstall skipped but binary present)
- **Security**: Snapshots may contain private UI text; UIPI blocks input to higher-integrity windows; blocklist prevents dangerous key combos

## Implementation Delivered

### New Files
1. **`src/desktop/agent-desktop-client.ts`** - Shell-free CLI adapter
   - JSON envelope validation, structured `AgentDesktopCommandError` with code/disposition
   - Ref validation (`@s<id>:e<index>`), stale-ref prevention guidance
   - Safety blocklist: alt+f4, win+l, win+d, alt+tab, win+r, win+x, win+e, ctrl+shift+esc, alt+shift+tab, win+shift+tab
   - Semantic actions headless; `type` uses `--headed`, `set-value` uses stdin
   - No automatic retries; `retry=safe` from error disposition only

2. **`src/desktop/backend-selector.ts`** - Automatic backend selection
   - Probes both backends: list-windows + accessibility-tree on focused window
   - Chooses lower tree latency when both healthy, else list latency, else fallback
   - 30s cache with forced refresh
   - Reports per-backend latencies, window counts, focused title, agent-desktop status

3. **`src/tools/desktop/agent-desktop-tools.ts`** - 7 new tools
   - `desktop_ax_status` - backend selection with latency breakdown
   - `desktop_ax_list_windows` - window enumeration
   - `desktop_ax_snapshot` - accessibility tree with scoped @ref IDs
   - `desktop_ax_find` - element search by role/name/text/value
   - `desktop_ax_read` - property read (state via `is`, content via `get`)
   - `desktop_ax_action` - click/toggle/check/uncheck/expand/collapse/set_value/type/clear/press
   - `desktop_ax_wait` - element/window/text/menu/event waits with predicates
   - All tools read-only permission, Zod schemas with exactOptionalPropertyTypes

4. **Tests** (22 new tests passing)
   - `tests/desktop/agent-desktop-client.test.ts` - client behavior, ref validation, error preservation, stdin routing, key blocking
   - `tests/desktop/backend-selector.test.ts` - probe selection, fallback, cache, tree latency comparison
   - `tests/desktop/agent-desktop-tools.test.ts` - tool routing, validation, stale-ref propagation, wait predicates

### Modified Files
- `src/cli.ts` - registers `createAgentDesktopTools` alongside existing desktop tools
- `src/core/system-prompt.ts` - updated computer-use order: browser DOM → Agent Desktop (with status recheck) → pywinauto → vision
- `package.json` / `package-lock.json` - exact `agent-desktop@1.3.0` dependency

## Benchmark Evidence (Windows 11, 7 runs each)

| Operation | Agent Desktop | pywinauto | Winner |
|-----------|--------------|-----------|--------|
| list-windows | 89 ms median | 41 ms median | pywinauto |
| snapshot (Notepad) | 216 ms | 245 ms (get-controls) | Agent Desktop |
| skeleton (Notepad) | 217 ms | — | — |
| focused window (VS Code) | 568 ms | 320 ms | pywinauto |

**Live Notepad test** (`jarvis-ad-notepad-test.txt`):
- `find` role `textfield` → `@s<id>:e1`
- `set-value` → verified delivery, value updated
- `type` (headed) → appended text, verified via `get`
- Fake ref `@sdeadbeef:e1` → `SNAPSHOT_NOT_FOUND` with `retry=safe`, no action sent
- Restored baseline, `ctrl+w` closed tab without save prompt

## Integration Status
- **Full gate green**: typecheck, lint, format, 264 tests (38 files), build
- **Existing desktop tools**: 17-tool factory unchanged, tests pass
- **Playwriter**: relay offline (Phase 5 blocker persists)
- **GitHub/Gemini**: auth manual, Gemini limits apply (Milestone 3)

## Blocker Updates
| Blocker | Status |
|---------|--------|
| Agent Desktop Windows support | **Resolved** - verified working |
| Playwriter relay offline | **Active** - browser live tests unavailable |
| GitHub/Gemini auth | **Active** - may need manual sign-in |
| pywinauto vs AD per-app performance | **Measured** - varies by app; selector uses focused-window tree latency |

## Next: Milestone 2 (Orchestration)
- Integrate with `AgentLoop`/`ToolRegistry`
- Sequential plan with states: PLANNED, RUNNING, WAITING_FOR_USER, COMPLETED, PARTIALLY_COMPLETED, FAILED
- Backend routing: Playwriter / Agent Desktop / pywinauto / vision
- Cross-app context preservation, verification, recovery
- Minimal persistence (no credentials, no unnecessary screenshots)
- Acceptance: 10+ sequential actions, Chrome↔Windows switch, simulated interruption resume

## Resume Commands
```bash
# Verify Milestone 1 state
cd D:\AI\JarvisAgent
npm test          # 264 tests pass
npm run typecheck # clean
npm run lint      # clean
npm run build     # success
git status        # shows new files + package changes
```

## Files to Commit (Milestone 1)
```
src/desktop/agent-desktop-client.ts
src/desktop/backend-selector.ts
src/tools/desktop/agent-desktop-tools.ts
tests/desktop/agent-desktop-client.test.ts
tests/desktop/backend-selector.test.ts
tests/desktop/agent-desktop-tools.test.ts
src/cli.ts
src/core/system-prompt.ts
package.json
package-lock.json
```