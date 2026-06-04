# Concerns

> Mapped: 2026-06-04

Technical debt, security exposure, fragile areas, and known issues in the build-worker service. Findings reference actual files and lines.

## Severity overview

| Area | Severity | Summary |
|------|----------|---------|
| Command injection guards | **High** | Broken validation regex + `for...in` over array means the injection checks are effectively dead code |
| Job auth | **High** | Prefix-match secret comparison; auth only enforced when env var is set |
| Secrets in Docker image | **High** | `WORKER_SECRET` and Rollbar token baked as `ENV` into image layers |
| Container runs as root | **Medium** | `USER` directive commented out; root + docker socket |
| Inconsistent Rollbar env vars | **Medium** | `ROLLBAR_TOKEN` vs `ROLLBAR_ACCESS_TOKEN` — one init path is dead |
| Concurrency guard defeated | **Medium** | `this.running` reset to `false` immediately after async `spawn` |
| Polling loop never wired | **Medium** | `loop()` exists but `worker.js` never schedules it |
| Test/leftover logic in prod | **Low** | `:3000`→`:3001` retry fallback in `worker.js` |

## Security

### Command execution is the core risk surface
`class.js:142` runs remote-supplied commands with a shell:
```js
let shell = exec.spawn(command, { shell: true }); // lgtm [js/command-line-injection]
```
The `command` originates from the socket job payload (`job.cmd`). This is the service's whole purpose (offloading builds), so it is intentional — but the guards around it are weak:

1. **`validateJob` only blocks `;` and `&`** (`class.js:46-53`). Backticks, `$(...)`, `|`, `>`, `<`, newlines, and `||`/`&&` variants (a single `&` is blocked, but command substitution is not) pass through.
2. **`isArgumentSafe` regex is broken** (`class.js:102-105`):
   ```js
   var pattern = new RegExp("(?![;&]+)"); // negative lookahead, no anchor/consume
   return pattern.test(CMD);
   ```
   A bare negative lookahead with nothing to match against returns `true` for essentially every input — it does **not** reject `;` or `&`. The function is a no-op guard.
3. **The per-argument injection check is dead code** (`class.js:129-136`):
   ```js
   for (let tome in tomes) { // for...in over an array yields indices "0","1",...
       if ((tome.indexOf("--git=") !== -1) || (tome.indexOf("--branch=") !== -1)) {
   ```
   `for...in` iterates array **indices** (strings like `"0"`), not the elements, so `tome.indexOf("--git=")` is always `-1` and the safety check never fires on real argument values. Should be `for (let tome of tomes)`.

**Net effect:** the layered "defense" against injection is largely illusory. Treat any process that can emit a `job` event to this worker's socket as having command execution on the build host.

### Job authentication is a prefix match and optional
`class.js:74`:
```js
if (job.secret.indexOf(process.env.WORKER_SECRET) !== 0) { ... }
```
- Uses `indexOf(...) !== 0` (prefix match) instead of constant-time equality. Any secret that *starts with* the real secret passes; also non-constant-time (timing).
- The entire auth block is gated on `typeof(process.env.WORKER_SECRET) !== "undefined"` (`class.js:65`). If `WORKER_SECRET` is unset, **all jobs are accepted unauthenticated**.
- A `null` job secret is logged as a soft warning ("This will be error soon", `class.js:71`) rather than rejected hard.

### Secrets baked into Docker image layers
`Dockerfile:12,19` declare `WORKER_SECRET` as a build `ARG` and promote it to `ENV`:
```dockerfile
ARG WORKER_SECRET
ENV WORKER_SECRET=${WORKER_SECRET}
```
`ENV` values persist in the final image and are visible via `docker history` / image inspection. Same applies to `ROLLBAR_ACCESS_TOKEN` (`Dockerfile:11,17`). Secrets should be injected at runtime (`-e` / secrets mount), not at build time.

### Container runs as root with docker access
`Dockerfile:84` — `# USER worker` is commented out, so the container runs as **root**. Combined with the bundled docker static binary (`Dockerfile:56-60`) and `VOLUME /var/lib/docker`, a command-injection escape has root on the host's docker daemon. The non-root user setup (`Dockerfile:75-79`) is also commented out.

## Reliability / correctness

### Concurrency guard is defeated
`class.js:303-312`: the `job` handler sets `this.running = true` inside `runJob` (`class.js:89`) but then unconditionally resets it:
```js
this.runJob(socket, data);
this.running = false; // runShell's spawn is async — job is NOT actually done here
console.log(`... » Job synchronously completed.`);
```
`runShell` uses async `spawn`, so the "synchronously completed" comment is wrong. `this.running` is cleared before the build finishes, so the `if (this.running == true)` guard at `class.js:293` won't reliably block a second concurrent job. Multiple builds can overlap on one worker.

### Polling loop is never scheduled
`class.js:316-322` defines `loop()` which emits `poll`, and `node-schedule` is a dependency (`package.json:22`), but `worker.js` never imports `node-schedule` and never calls `worker.loop()`. The poll-based job pickup appears unwired in the current entrypoint — jobs only arrive via server-pushed `job` events. Either dead code or a missing scheduler.

### Inconsistent Rollbar configuration
- `class.js:1` initializes Rollbar from `process.env.ROLLBAR_TOKEN`.
- `worker.js:11` initializes Rollbar from `process.env.ROLLBAR_ACCESS_TOKEN`.
- `Dockerfile:11,17` only provides `ROLLBAR_ACCESS_TOKEN`.

So the `class.js` Rollbar init reads a variable (`ROLLBAR_TOKEN`) that is never set → that error-reporting path is effectively dead, and there are two competing Rollbar instances/configs.

### Leftover test logic in production entrypoint
`worker.js:48-57`: on `new Worker(srv)` failure, it retries against `srv.replace(":3000", ":3001")` with a comment "in test environment there is a test worker running on additional port 3001". Test-specific fallback shipped in the production start path.

### Duplicated/dead init in worker.js
`worker.js:22-27` checks `THINX_SERVER` and `process.exit(1)`, then `worker.js:38-41` checks the same condition again with identical messaging. The first guard makes the second unreachable for the undefined case.

## Fragility / maintainability

- **Static-analysis suppressions everywhere.** `class.js` carries multiple `// lgtm [...]`, `// deepcode ignore ...`, and an inline note "risk should be accepted" (`class.js:141,142,199,200,205,210,211`). These mark known, *unmitigated* path-injection / command-injection findings that were silenced rather than fixed.
- **Brittle path rewriting.** `class.js:111` `CMD.replace("./builder", "/opt/thinx/...")` replaces only the first literal occurrence and hardcodes an absolute container path; breaks if the build command shape changes.
- **Path sanitization is ad-hoc.** `build_id` is cleaned by chained `.replace(/\./g,'')` / `\\` / `/` (`class.js:120-122`), and `build_log_path` is hand-built (`class.js:199`) — manual escaping rather than `path.join` + allowlist.
- **`status_object` defaults to `"Failed"`** (`class.js:161-166`) and is only corrected if JSON parsing of the annotation succeeds; a malformed `JOB-RESULT` line silently reports a failed build.
- **Heavy `console.log` with timestamps everywhere**, no structured logger or log levels — operational noise, hard to filter.
- **Mixed `this`/arrow handling** and `var`/`let` mixing across `class.js` (e.g. `var string`, `var dstring`) — pre-ES6 idioms alongside modern ones.

## Supply chain / build

- **Docker binary pinned + arch-locked.** `Dockerfile:56-60` curls the docker `20.10.21` static binary for `x86_64` only over the network at build time — fails or mismatches on arm64 hosts, and is an unverified download (no checksum).
- **`edge/community` repo added** (`Dockerfile:7`) pulls from Alpine edge, which is a moving target and can break reproducibility.
- **`npm install . --omit=dev`** (`Dockerfile:73`) — no lockfile (`package-lock.json` not present in repo root listing) means non-reproducible dependency resolution.

## Testing gaps (see TESTING.md)

- Single assertion-light test file; most `io.emit("job", ...)` cases assert nothing, so the broken guards above would not be caught by the suite.
- No coverage threshold gate, so coverage can silently regress.

## Suggested priorities

1. Fix `isArgumentSafe` regex and the `for...in`→`for...of` bug, or replace shell parsing with an allowlist + `spawn` without `{ shell: true }`. (**High**)
2. Use constant-time equality for the job secret and fail closed when `WORKER_SECRET` is unset. (**High**)
3. Move `WORKER_SECRET` / Rollbar token to runtime injection; drop them from `ENV`. (**High**)
4. Run the container as a non-root user. (**Medium**)
5. Reconcile the two Rollbar env-var names. (**Medium**)
6. Fix the `this.running` lifecycle so the concurrency guard actually holds across the async build. (**Medium**)
