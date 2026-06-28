# Technology Stack

**Analysis Date:** 2026-06-04

## Languages

**Primary:**
- JavaScript (CommonJS) - Node.js server-side, all application logic in `worker.js` and `class.js`
- C/C++ - DevSec binary built from sources in `devsec-src/devsec.cpp`, `devsec-src/main.cpp`, `devsec-src/devsec.h`

**Secondary:**
- Shell (bash) - Build scripts; `devsec-src/build.sh`

## Runtime

**Environment:**
- Node.js 25.9.0 (Alpine-based Docker image: `node:25.9.0-alpine3.23`)
- Dockerfile: `Dockerfile`

**Package Manager:**
- npm 11.6.2 (pinned in Dockerfile, upgraded during image build)
- Lockfile: `package-lock.json` (present)

## Frameworks

**Core:**
- Express 5.2.1 - HTTP server framework (listed as dependency; not visibly used in current application code, available for future REST endpoint addition)
- Socket.IO (server) 4.8.3 - WebSocket server; used in `test.js` as mock server
- Socket.IO (client) 4.8.3 - WebSocket client; primary transport to THiNX API in `class.js`

**Testing:**
- Jest 30.2.0 - Test runner and assertion library; config in `package.json` (`jest` key)
- jest-junit 16.0.0 - JUnit XML reporter for CI
- jest-sonar-reporter 2.0.0 - SonarCloud test results reporter

**Build/Dev:**
- Docker - Containerized deployment; `Dockerfile`
- CircleCI - CI/CD pipeline; `.circleci/config.yml`

## Key Dependencies

**Critical:**
- `socket.io-client` 4.8.3 - Core transport between worker and THiNX API (`class.js`)
- `fs-extra` 11.3.5 - Filesystem operations; build log file management in `class.js`
- `chmodr` 2.0.2 - Recursive chmod on build output directories in `class.js`

**Infrastructure:**
- `rollbar` 2.26.5 - Remote error tracking; conditionally initialized in `worker.js` and `class.js`
- `helmet` 8.1.0 - HTTP security headers (available via Express)
- `node-schedule` 2.1.1 - Cron-style job scheduling (available; `loop()` method in `class.js`)
- `uuid` 14.0.0 - UUID generation (available)
- `chalk` 5.6.2 - Terminal color output (available)

**Pinned Overrides (vulnerability mitigations in `package.json`):**
- `async` 2.6.4
- `moment` 2.29.4
- `mkdirp` 3.0.1
- `path-to-regexp` 8.4.0

## Configuration

**Environment:**
- All configuration via environment variables (no config files)
- Required: `THINX_SERVER` - THiNX API WebSocket URL (process exits if absent)
- Optional: `ROLLBAR_ACCESS_TOKEN` (`worker.js`) / `ROLLBAR_TOKEN` (`class.js`) - note: inconsistent naming between the two files
- Optional: `ROLLBAR_ENVIRONMENT` - Environment label for Rollbar
- Optional: `WORKER_SECRET` - Shared secret for job authentication between API and worker
- Optional: `DATA_PATH` - Build data path
- Optional: `REVISION` - Build revision label
- Internal: `WORKER=1` - Always set to 1 in Docker image

**Build:**
- `Dockerfile` - Multi-stage Alpine build; installs system tools (git, jq, jo, make, gcc, curl, zip), compiles DevSec C++ binary, installs Docker CLI 20.10.21 for Docker-in-Docker builds
- `.dockerignore` - Excludes files from Docker build context

## Platform Requirements

**Development:**
- Node.js >=18.14.0 (Jest requirement); Node.js 25.9.0 in production image
- npm for dependency installation

**Production:**
- Docker container: `thinxcloud/worker:latest`
- Requires Docker-in-Docker (VOLUME `/var/lib/docker`; Docker CLI installed in image)
- Alpine Linux 3.23 base
- Network access to `THINX_SERVER` WebSocket endpoint

---

*Stack analysis: 2026-06-04*
