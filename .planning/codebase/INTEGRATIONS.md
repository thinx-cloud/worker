# External Integrations

**Analysis Date:** 2026-06-04

## APIs & External Services

**THiNX API (primary integration):**
- THiNX Build Server - WebSocket-based job dispatch and result reporting
  - SDK/Client: `socket.io-client` 4.8.3
  - Connection: `THINX_SERVER` env var (required; process exits without it)
  - Auth: `WORKER_SECRET` env var (optional shared secret; sent via `socket.auth.token` on `connect_error`)
  - Events emitted by worker: `register`, `poll`, `job-status`, `log`
  - Events received by worker: `connect`, `disconnect`, `connect_error`, `client id`, `job`
  - Implementation: `class.js` (`setupSocket`, `runJob`, `failJob`)

## Data Storage

**Databases:**
- None - This service is stateless; no database connections

**File Storage:**
- Local filesystem - Build logs written to `{DATA_PATH}/{build_id}/build.log`
  - Managed with `fs-extra` (`fs.ensureFile`, `fs.appendFileSync`)
  - Permissions set recursively with `chmodr` (mode `0o665`)
  - Implementation: `class.js` (`runShell` method)

**Caching:**
- None

## Authentication & Identity

**Auth Provider:**
- Custom shared-secret validation
  - `WORKER_SECRET` env var checked against `job.secret` field in each incoming job payload
  - On `connect_error`, secret is set as `socket.auth.token` for Socket.IO handshake auth
  - Implementation: `class.js` (`validateJob` method, `setupSocket` connect_error handler)

## Monitoring & Observability

**Error Tracking:**
- Rollbar
  - SDK: `rollbar` 2.26.5
  - Auth: `ROLLBAR_ACCESS_TOKEN` env var (checked in `worker.js`) / `ROLLBAR_TOKEN` env var (checked in `class.js`) — note: two different env var names used inconsistently
  - Environment label: `ROLLBAR_ENVIRONMENT` env var
  - Handles uncaught exceptions and unhandled rejections automatically when configured
  - Worker startup info event sent: `r.info("Worker started", {...})` in `worker.js`

**Logs:**
- `console.log` / `console.error` to stdout with millisecond timestamps
- Per-build log file appended at `{path}/{build_id}/build.log`
- Build log lines also emitted over Socket.IO as `log` events to THiNX API

## CI/CD & Deployment

**Hosting:**
- Docker Hub: image published as `thinxcloud/worker:latest`
- Container requires Docker socket / Docker-in-Docker volume for firmware builds

**CI Pipeline:**
- CircleCI (`.circleci/config.yml`)
  - Orbs: `circleci/docker@2.8.0`, `circleci/node@1.1.6`, `sonarsource/sonarcloud@1.0.3`, `gitguardian/ggshield@1.1.4`
  - Test job: runs `npm install` inside `thinxcloud/console-build-env:latest`
  - Publish job: builds and pushes Docker image on successful test
  - Contexts used: `coveralls-worker`, `rollbar`, `sonarcloud`, `dockerhub`
- SonarCloud - Code quality analysis; `jest-sonar-reporter` generates test results in SonarQube format
- GitGuardian - Secret scanning via `ggshield` CircleCI orb

**Security Scanning:**
- Snyk - `npm run snyk` / `npm run snyk-protect` scripts in `package.json`
- Checkmarx SAST - `.cxast` config file present

## Environment Configuration

**Required env vars:**
- `THINX_SERVER` - WebSocket URL of THiNX API (e.g., `http://api:3000`)

**Optional env vars:**
- `WORKER_SECRET` - Shared secret for job authentication
- `ROLLBAR_ACCESS_TOKEN` - Rollbar token (used in `worker.js`)
- `ROLLBAR_TOKEN` - Rollbar token (used in `class.js`) — same purpose, different name
- `ROLLBAR_ENVIRONMENT` - Environment label sent to Rollbar
- `DATA_PATH` - Base path for build log files
- `REVISION` - Build revision label (passed at Docker build time as `ARG`)
- `ENVIRONMENT` - Environment name logged at startup

**Secrets location:**
- Injected as Docker environment variables at container runtime
- Build-time ARGs in `Dockerfile`: `THINX_SERVER`, `ROLLBAR_ACCESS_TOKEN`, `ROLLBAR_ENVIRONMENT`, `WORKER_SECRET`, `REVISION`, `DATA_PATH`

## Webhooks & Callbacks

**Incoming:**
- None - The worker does not expose an HTTP server or inbound webhook endpoint

**Outgoing:**
- Socket.IO events to THiNX API WebSocket server (see APIs section above)

## Docker-in-Docker (Build Execution)

**Build command execution:**
- Worker spawns shell subprocesses (`child_process.spawn`) to run firmware build scripts
- The `builder` script path is rewritten to `/opt/thinx/thinx-device-api/builder` (`class.js` `runShell`)
- Docker CLI 20.10.21 is installed inside the image (`Dockerfile`) to allow builds that themselves invoke Docker
- `VOLUME /var/lib/docker` declared in `Dockerfile` for Docker daemon storage

---

*Integration audit: 2026-06-04*
