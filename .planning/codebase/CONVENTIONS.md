# Coding Conventions

**Analysis Date:** 2026-06-04

## Naming Patterns

**Files:**
- Flat, lowercase, single-word or dot-separated: `class.js`, `worker.js`, `test.js`
- No TypeScript — pure CommonJS JavaScript throughout
- Platform and language data stored as `descriptor.json` under `platforms/<name>/` and `languages/<name>/`

**Functions/Methods:**
- camelCase for all method names: `failJob`, `validateJob`, `runJob`, `runShell`, `isBuildIDValid`, `isArgumentSafe`, `setupSocket`
- Boolean-returning functions prefixed with `is`: `isBuildIDValid()`, `isArgumentSafe()`
- Action methods named as `verb + Noun`: `failJob`, `validateJob`, `runJob`, `runShell`, `setupSocket`

**Variables:**
- `let` for block-scoped mutable variables (dominant pattern)
- `const` for truly constant values (e.g., `const close_underlying_connection = true;`)
- `var` used inside callbacks and in older sections — mixed with `let` inconsistently (e.g., `var string`, `var logline`, `var pattern` in `class.js`)
- SCREAMING_SNAKE_CASE for command-like string constants: `CMD`, `BUILD_PATH`
- camelCase for everything else: `build_id`, `build_start`, `elapsed_hr`, `status_object`
- Underscore-separated multi-word variables: `build_id`, `build_start`, `build_log_path`, `server_port`

**Classes:**
- PascalCase: `Worker`
- Exported directly via `module.exports = class Worker { ... }`

## Code Style

**Formatting:**
- No formatter configured (no `.prettierrc`, `.editorconfig`, or `biome.json` present)
- Indentation is inconsistent: 4-space indent for most of `class.js`, but tab-indented sections exist inside `runShell` (lines 145–254 use tabs)
- No enforced line length limit

**Linting:**
- No `.eslintrc` or `eslint.config.*` present
- ESLint suppression comments used inline: `// eslint-disable-next-line no-unused-vars` in `worker.js`
- SonarCloud and Snyk inline suppressions also used: `// deepcode ignore CommandInjection`, `// lgtm [js/command-line-injection]`, `// lgtm [js/path-injection]`

## Import Organization

**Order (observed in `class.js`):**
1. Optional conditional requires (Rollbar, guarded by `typeof ... !== "undefined"`)
2. Node.js built-ins: `child_process`
3. Internal package reads: `./package.json`
4. Third-party modules: `socket.io-client`, `fs-extra`, `chmodr`

**Style:**
- CommonJS `require()` — no ES modules (`import`/`export`) anywhere
- No path aliases — all requires use relative paths (`./class.js`) or module names

## Error Handling

**Patterns:**
- `try/catch` used sparingly — only for JSON parsing (`JSON.parse`) in `class.js` line 168–174
- Errors logged via `console.log` with `[error]` tag prefix, but no `throw` or error propagation
- Functions return `false` to indicate failure (e.g., `validateJob` returns `false` when validation fails)
- Shell process errors emitted back to socket as `job-status` events with `state: "Failed"`
- No use of `Promise`, `async/await`, or error-first callbacks beyond the `fs.ensureFile` callback pattern
- Fatal startup errors cause `process.exit(1)` directly in `worker.js`

**Guard pattern** — undefined checks use a custom helper defined in `worker.js`:
```javascript
function exists(x) {
    return ((typeof(x) === "undefined") || (x === null)) ? false : true;
}
function undef(x) {
    return !exists(x);
}
```
In `class.js`, guards use inline `typeof ... === "undefined"` checks directly (the helpers are not imported or reused).

## Logging

**Framework:** `console.log` only — no structured logger

**Patterns:**
- Timestamp prefix using `new Date().getTime()` for infrastructure-level messages:
  ```javascript
  console.log(`${new Date().getTime()} [info] » Worker socket disconnected.`);
  ```
- Tagged prefix without timestamp for build-process messages:
  ```javascript
  console.log(`[error] Annotation status in '${annotation_string}' not parsed.`);
  console.log(`[info] BUILD TIME: ${elapsed_hr}`);
  console.log(`[OID:${owner}] [BUILD_COMPLETED] with code ${code}`);
  ```
- No log levels beyond `[info]`, `[error]`, `[critical]` — all go to stdout via `console.log`
- Rollbar used for production error reporting when `ROLLBAR_ACCESS_TOKEN` (worker.js) or `ROLLBAR_TOKEN` (class.js) env vars are present — note: two different env var names for the same service

## Comments

**When to Comment:**
- Security suppressions are heavily commented with `// deepcode ignore` and `// lgtm` annotations for static analysis tools
- Inline explanations for non-obvious logic (path sanitization, command injection handling)
- Section separators used as plain comment headers: `// Connectivity Events`, `// Business Logic Events`, `// Main Logic`

**JSDoc/TSDoc:** Not used anywhere in the codebase.

## Function Design

**Size:** Methods are large — `runShell` spans ~150 lines with deeply nested callbacks. No decomposition into smaller helpers.

**Parameters:** Positional parameters only. `runShell(CMD, owner, build_id, udid, path, socket)` — 6 positional args with no options object.

**Return Values:**
- Boolean `true`/`false` from validators: `isBuildIDValid`, `isArgumentSafe`, `validateJob`
- `undefined` (implicit) from action methods like `runShell`, `failJob`
- No Promises returned — all async work uses callbacks or event emitters

## Module Design

**Exports:**
- Single class export: `module.exports = class Worker { ... }` in `class.js`
- `worker.js` is an entry point — no exports

**Barrel Files:** Not used. No index files aggregating exports.

**Class structure:**
- Single `Worker` class encapsulates all logic: constructor, socket setup, job validation, shell execution
- No separation into smaller modules or services
- `test.js` imports `Worker` directly: `const Worker = require('./class.js')`

---

*Convention analysis: 2026-06-04*
