# CLAUDE.md — THiNX Build Worker

Project memory for the THiNX Cloud Build Worker (`build-worker`). Loaded automatically each session.

## What this service is

A swarm build worker: it connects over socket.io to the THiNX API, receives build
`job` events, and runs the build command on the host via `child_process.spawn`.
Entry point `worker.js` → `class.js` (`Worker`).

## Operational constraints

### The container must run as root (intentional, do not "fix")

The Docker container runs as **root** (the `USER` directive in `Dockerfile` is
deliberately commented out). This is **required**, not an oversight:

- The worker spawns **builder containers** by talking to the host's Docker daemon
  via `docker.sock`. Doing that needs root (or membership in a `docker` group that
  is effectively root-equivalent).
- This is how THiNX build orchestration currently works, and **no better method
  has been researched yet**.
- THiNX must run in **both plain Docker and Docker Swarm**, so a swarm-level
  orchestrator cannot be made a hard requirement — the worker has to be able to
  launch builders itself in either environment.

If you revisit container hardening: rootless Docker / a brokered build-launch API
would be the direction to research, but until that exists, **root is the accepted
trade-off**. Do not drop `USER root` expecting it to be a safe cleanup.

Security note: because the worker has root + `docker.sock` and executes
remote-supplied build commands, the command-injection guards in
`class.js` (`isArgumentSafe`, `validateJob`) and job authentication
(`WORKER_SECRET`, constant-time `secretsMatch`) are the primary containment layer.
Keep them strict.

## Secrets

`WORKER_SECRET` and the Rollbar token are read through `secrets.js`
(`readSecret`, a copy of the API's `lib/thinx/secrets.js` — keep the two in
sync): a swarm secret file `/run/secrets/<NAME>` wins, then the env var, then
nothing. A mounted `WORKER_SECRET` therefore overrides a stale env value, which
is what makes a secret rotation take effect. Rollbar tries `ROLLBAR_SERVER_TOKEN`,
then `ROLLBAR_ACCESS_TOKEN` (`rollbarServerToken()`), and is initialised once, in
`worker.js`; `class.js` creates no Rollbar client. With no token the worker logs
one info line naming `ROLLBAR_SERVER_TOKEN` and runs without Rollbar; with no
`WORKER_SECRET` it refuses every job. `readSecret` caches per name for the life
of the process, so a newly mounted secret needs a task restart.

Both are still **injected at runtime** (swarm secret or `docker run -e ...`), not
baked into the image. Do not re-add them as `ARG`/`ENV` in the `Dockerfile` —
that would persist them in image layers. Never log their values.

## Testing

`npm test` (Jest). The full suite passes (146/146 under bash as of 2026-10-04). A green run is
the baseline — treat any failure as a regression from your own change.

`builder.test.js` covers the shell side: `swarmbuild` and the platformio helpers
live in `builder-lib.sh` (sourced by `builder`) and run against a stub `docker`
on `PATH`. `builder` runs under `/bin/sh`, which is **busybox ash** in the image
(bash is installed but unused), so keep `builder-lib.sh` to what both accept;
the tests run under bash and, where installed, `busybox sh`.

CircleCI's `test` job runs `npm install`, then `npm test` in
`thinxcloud/console-build-env` (bash, no busybox), and `docker/publish`
requires it: a red suite blocks the `thinxcloud/worker:latest` push. The
busybox pass only runs where busybox is installed (e.g. a copy of the repo in
`dhi.io/node:26-alpine3.24-dev` with its own `npm ci`; jest 30's resolver is
platform-specific, so the macOS `node_modules` cannot be reused there).

The two long-standing failures noted here previously (`runShell` /
`chmodr is not a function`, and `socket must be closed` / `w.close is not a
function`) are both fixed. `Worker` still has no `close()`; the socket test now
calls `disconnect(true)` on the server-side socket instead.

### thinx.yml is never eval'd

thinx.yml is repository content. `builder` and `infer_platform` read it only
through `thinx_yml_load FILE builder|infer` in `builder-lib.sh`: awk parses it
the way the old `parse_yaml` did, and a fixed `case` allowlist assigns only the
names the caller reads, with values kept literal (no eval, no `export`,
nothing printed). Do not reintroduce `eval`/`source` on anything derived from
the repository. If builder needs a new thinx.yml key, add it to that `case`.
Never echo `devsec_*` values; they are Wi-Fi credentials and keys.

### Build containers never get docker.sock

Only the worker itself mounts `/var/run/docker.sock` (docker-swarm.yml). The
build services `swarmbuild` creates and the `docker run` builder containers on
the non-swarm path get no socket mount: they run repository content, and with
the socket they would be root on the node. The builder images' entrypoints
(`cmd.sh`) never call docker and the images ship no docker CLI. Do not add the
mount back; `builder.test.js` checks both paths.

### Build services are created detached

`swarmbuild` runs `docker service create --detach`. Without it docker waits
for the service to converge, and a build task that fails fast under
`--restart-condition=none` never does: create never returned, the poll loop
never started and the worker hung until someone removed the service
(production, 2026-10-04). The poll loop is the one completion detector.

### micropython contract (suculent/micropython-docker-build)

`upy_build` in `builder-lib.sh` (and the image's `cmd.sh` / README) define it:
the repository is mounted at `/opt/workspace` (swarm and `docker run` alike)
and the image runs its own command; it freezes the repository's `*.py` (root,
then `modules/`) into the firmware and writes `build/firmware.bin`. The image
runs as an unprivileged user, so the worker recreates `build/` mode 777 first
(removing whatever the repository had there). Success is the build's status
plus a regular, non-symlink `build/firmware.bin` over 10000 bytes, copied to
`DEPLOYMENT_PATH/firmware.bin`. File mode (`micropython.build.type: file`) is
`upy_files`: the root and `modules/` `*.py` are copied as they are, and
`OUTFILE` is `boot.py`, else `main.py`.
