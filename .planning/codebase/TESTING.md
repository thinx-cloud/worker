# Testing

> Mapped: 2026-06-04

How the build-worker service is tested: framework, structure, mocking strategy, and coverage.

## Framework

- **Runner:** Jest `^30.2.0` (`devDependencies` in `package.json`)
- **Test command:** `npm test` → `jest --coverage --detectOpenHandles`
  - `--coverage` produces a coverage report on every run.
  - `--detectOpenHandles` is used because the suite opens real sockets/HTTP servers that can leak handles.
- **Reporters:**
  - `jest-sonar-reporter` `^2.0.0` — configured via `package.json` `jest.testResultsProcessor` for SonarQube ingestion.
  - `jest-junit` `^16.0.0` — JUnit XML output (CI consumption).
- **Static analysis / SCA:** `snyk test` (`npm run snyk`) and `snyk-protect` are wired as scripts but are SCA, not unit tests.

## Structure

- Single test file: `test.js` at the repo root (191 lines).
- Tests the `Worker` class exported from `class.js` (`const Worker = require('./class.js')`).
- One top-level `describe("Worker", ...)` block containing ~18 sequential `test()` cases.
- No `test/` or `__tests__/` directory — flat, single-file layout.

## Test setup / teardown

- `beforeAll((done) => {...})` — spins up a **real in-process Socket.IO server** over a Node `http` server to stand in for the THiNX API:
  - `const httpServer = createServer(); io = new Server(httpServer);`
  - Registers handlers for the service's business events: `connection`, `connect`, `disconnect`, `connect_error`, `register`, `poll`, `job-status`.
  - Tracks workers in a `that.workers` map keyed by `socket.id`.
- `afterAll(() => { if (typeof io !== "undefined") io.close(); })` — closes the mock server.
- `server_port = 4000`; the Worker is pointed at `http://localhost:${server_port}`.

## Mocking strategy

- **No jest mocks / spies** (`jest.fn`, `jest.mock`, `jest.spyOn`) are used.
- Instead, the suite uses a **live socket.io server as a test double** — real network round-trips on localhost rather than stubbed transports. This is integration-style testing of the socket contract, not isolated unit testing.
- Test job fixture is an inline object (`test.js:24-32`) with `secret: process.env.WORKER_SECRET || null`, so auth behavior depends on the environment.

## What is exercised

- **Construction:** `new Worker(THINX_SERVER)` with mandatory config.
- **Job dispatch over socket:** `io.emit("job", ...)` with valid, `null`, `undefined`, and malformed payloads.
- **Command-injection guards:** jobs with `cmd: ";"`, `cmd: "&"`, `cmd: "ls -la"` — feeding the `isArgumentSafe` path.
- **Direct method calls:** `failJob`, `validateJob`, `isBuildIDValid`, `isArgumentSafe`, `runShell`, `close`.
- **Assertions:** only a few cases assert (`isBuildIDValid` → `toBe(true)`, `isArgumentSafe` → `toBe(true)`). Most emit-based cases assert nothing and pass as long as no exception throws ("smoke" coverage).

## Coverage

- Coverage is collected on every run (`--coverage`), output consumed by SonarQube via `jest-sonar-reporter`.
- No explicit `collectCoverageFrom` / coverage thresholds are configured in `package.json` — Jest uses defaults (covers files touched by tests). No `coverageThreshold` gate, so coverage cannot fail the build.

## Notable issues / fragility

- **`runShell` `done()` may not fire deterministically** (`test.js:181-185`): the test passes a callback that calls `done()`, but `runShell` actually executes a shell command (`echo hello`). If the callback contract changes or the command errors, the async test could hang until Jest's timeout rather than failing cleanly.
- **Environment-coupled auth:** several behaviors hinge on `process.env.WORKER_SECRET`; without it set, the auth/`connect_error` path is only partially exercised.
- **Assertion-light:** the majority of `io.emit("job", ...)` cases have no `expect(...)`, so regressions in job handling that don't throw would pass silently.
- **Shared mutable `that`/`this` state** across handlers mixes arrow-function `this` and `that = this` at the describe scope, which is brittle.
- **Real sockets + HTTP server** require `--detectOpenHandles` and explicit `io.close()`; a missed teardown leaks handles between runs.

## Running tests

```bash
npm test            # jest --coverage --detectOpenHandles
npm run snyk        # dependency vulnerability scan (SCA, not unit tests)
```
