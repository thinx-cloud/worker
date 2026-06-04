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

`WORKER_SECRET` and `ROLLBAR_ACCESS_TOKEN` are **injected at runtime** (e.g.
`docker run -e ...`), not baked into the image. Do not re-add them as
`ARG`/`ENV` in the `Dockerfile` — that would persist them in image layers.

## Testing

`npm test` (Jest). Two pre-existing tests fail independently of feature work:
`runShell` (`chmodr is not a function`) and `socket must be closed`
(`w.close is not a function` — no `close()` method exists on `Worker`). These are
known broken tests, not regressions.
