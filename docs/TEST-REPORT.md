# Test Report

## Phase 1D — 2026-11-07

### Commands executed

```powershell
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
node dist/cli.js health
node dist/cli.js health --json
npx tsx src/cli.ts health
npx tsx src/cli.ts version
npm start -- health
```

### Actual results

- `npm run typecheck` (`tsc --noEmit`): passed with no diagnostics.
- `npm run lint` (`eslint .`): passed with no diagnostics.
- `npm run format:check`: passed with `All matched files use Prettier code style!`.
- `npm test` (`vitest run`):
  - Vitest `v5.1.0`.
  - 5 test files passed.
  - 31 tests passed.
  - Duration: 521 ms.
- `npm run build` (`tsc -p tsconfig.build.json`): passed.
- Build output included:
  - `dist/cli.js`
  - `dist/config.js`
  - `dist/health/checks.js`
  - `dist/health/format.js`
  - `dist/health/types.js`
  - `dist/logging/logger.js`
  - `dist/version.js`
- `node dist/cli.js health`: `Overall: OK`; exit code `0`.
- Health check results:
  - Node.js `24.18.0`: `OK`.
  - npm `11.16.0`: `OK`.
  - Required directories: `OK`.
  - Ollama `0.40.15`: `OK`.
  - Model `qwen3.5:9b`, size `6550825550`: `OK`.
  - Playwriter `0.9.0` package and CLI shim: `OK`.
  - Playwriter relay `127.0.0.1:19988`: `OK`.
  - NVIDIA GPU information: `OK`, 1 GPU.
- `node dist/cli.js health --json`: exit code `0`; status `OK`; 8 checks; version `0.1.0`.
- `npx tsx src/cli.ts health`: exit code `0`.
- `npx tsx src/cli.ts version`: printed `JARVIS 0.1.0`.
- `npm start -- health`: exit code `0`.

### Coverage added

- Node.js major-version threshold.
- npm availability and warning behavior.
- Required directory presence and `FAILED`/`WARNING` aggregation.
- Ollama API/version and installed-model checks through injected fetch.
- Playwriter package/CLI and relay reachability through injected dependencies.
- NVIDIA command success and failure behavior.
- Worst-status aggregation and human-readable formatting.
- CLI health human/JSON output, exit-code mapping, unknown options, and configuration errors.

### Notes

- Health checks are read-only. No model loading, inference, file/directory creation, service start/stop, browser session creation, or Playwriter relay/session changes occurred.
- Unit tests use injected fake fetch, command, and TCP dependencies plus temporary directories. The final CLI health run used the actual local environment.
- An initial `eslint --stdin` probe failed because the virtual filename was outside the TypeScript project service. The probe file was removed, and `eslint .` passed.
- No Git commit was created.

## Phase 1C — 2026-11-07

### Commands executed

```powershell
npm run format
npm run typecheck
npm run lint
npm run format:check
npm test
npm run build
node dist/cli.js version
node dist/cli.js --help
node dist/cli.js unknown
npx tsx src/cli.ts version
npm start -- version
```

### Actual results

- `npm run typecheck` (`tsc --noEmit`): passed with no diagnostics.
- `npm run lint` (`eslint .`): passed with no diagnostics.
- `npm run format:check`: passed with `All matched files use Prettier code style!`.
- `npm test` (`vitest run`):
  - Vitest `v5.1.0`.
  - 4 test files passed.
  - 20 tests passed.
  - Duration: 504 ms.
- `npm run build` (`tsc -p tsconfig.build.json`): passed.
- Build output included:
  - `dist/cli.js`
  - `dist/config.js`
  - `dist/version.js`
  - `dist/logging/logger.js`
- `node dist/cli.js version`: printed `JARVIS 0.1.0`; exit code `0`.
- `node dist/cli.js --help`: printed the help text; exit code `0`.
- `node dist/cli.js unknown`: printed the unknown-command error and help to stderr; exit code `1`.
- `npx tsx src/cli.ts version`: printed `JARVIS 0.1.0`; exit code `0`.
- `npm start -- version`: printed `JARVIS 0.1.0`; exit code `0`.

### Coverage added

- Configuration defaults and environment overrides.
- Boolean environment parsing.
- Rejection of invalid environment values and non-local Ollama URLs.
- Missing `.env` file handling.
- Positive `.env` loading.
- Structured log entry shape.
- Redaction of sensitive metadata keys and secret-like strings.
- Log level filtering.
- Console stdout/stderr routing.
- Size-based log rotation.
- Child logger bindings.
- CLI version, help, aliases, and unknown-command behavior.

### Notes

- Initial verification found a CLI test typing issue, numeric template-literal lint errors, dynamic `delete` lint errors, and Prettier formatting differences. All were corrected before the final passing run.
- `npm run dev` was not started because it runs `tsx watch`; the equivalent source entry point was verified with `npx tsx src/cli.ts version`.
- No Git commit was created.

## Phase 1B — 2026-11-07

### Commands executed

```powershell
npm run typecheck
npm run lint
npm run format:check
npm run format
npm test
npm run build
node --input-type=module -e "import { getVersionLabel } from './dist/version.js'; console.log(getVersionLabel());"
```

### Actual results

- `npm run typecheck` (`tsc --noEmit`): passed with no diagnostics.
- `npm run lint` (`eslint .`): passed with no diagnostics.
- `npm run format:check`: initially reported `docs/PHASE-0-BASELINE.md`; after `npm run format`, the recheck passed with `All matched files use Prettier code style!`.
- `npm test` (`vitest run`):
  - Vitest `v5.1.0`.
  - 1 test file passed.
  - 3 tests passed.
  - Duration: 191 ms.
- `npm run build` (`tsc -p tsconfig.build.json`): passed.
- Build output: `dist/version.js` and `dist/version.js.map`.
- Runtime import from `dist/version.js` printed `JARVIS 0.1.0`.

### Notes

- Vitest executed successfully, which confirms the earlier esbuild `allow-scripts` install warning did not prevent the test toolchain from working.
- No Git commit was created.

## Phase 1A — 2026-11-07

Phase 1A was scaffold-only. No application tests, type checking, linting, or build were run in that sub-stage.

### Commands executed

```powershell
git init -b main
npm install --no-audit --no-fund
npm ls --depth=0
node -e "const p=require('./package-lock.json'); ..."
node -e "const e=require('esbuild'); ..."
git status --short --branch
```

### Actual results

- Git repository initialized on branch `main`.
- `npm install` completed: `added 135 packages in 37s`.
- `npm ls --depth=0` showed exactly the approved top-level versions:
  - `@eslint/js@10.0.1`
  - `@types/node@24.19.2`
  - `eslint-config-prettier@10.1.8`
  - `eslint@10.14.0`
  - `prettier@3.9.10`
  - `tsx@4.23.15`
  - `typescript-eslint@8.72.1`
  - `typescript@5.9.3`
  - `vitest@5.1.0`
  - `zod@4.6.7`
- `package-lock.json` exists with `lockfileVersion: 3` and 186 package entries.
- `node_modules/@esbuild/win32-x64/esbuild.exe` exists (11,694,592 bytes).
- `require('esbuild')` succeeds and reports version `0.28.2`.
- `git status` showed no commits and only the new scaffold files as untracked.

### Warnings and limitations

- npm 11.16.0 emitted an `allow-scripts` warning for `esbuild@0.28.2` (postinstall not covered). The binary was present and loadable, and Vitest ran successfully in Phase 1B.
- No Git commit was created.
