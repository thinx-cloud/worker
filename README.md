# THiNX Remote BuildWorker

This component is responsible for communication with THiNX Build Server over websocket and performing build-jobs with motivation of offloading CPU power to adjacent nodes.

Builder connects to THiNX automatically using a websocket. In some cases, address of the main server should be given.

## Security Precautions

This container is mighty. It will perform any shell command submitted, after passing the validation (which is not a measure in open-source code).

Use the `WORKER_SECRET` variable on boths sides (API/Worker) to make sure worker cannot be used by unauthorized actor.

## Supported Environment Variables

| Name.                   | Usage.                                          |
|:------------------------|:------------------------------------------------|
| `THINX_SERVER`          | Build Server URL, defaults to localhost:3000    |
| `ROLLBAR_ACCESS_TOKEN`  | Authentication token for Rollbar (optional)     |
| `ROLLBAR_ENVIRONMENT`   | Enviroment for Rollbar (required if token set)  |
| `WORKER_SECRET`         | If set, jobs will be validated for this secret. |
| `WORKER`                | Set to `1` by the image; enables `JOB-RESULT`.  |

## Build Result Reporting (`jo`)

`builder` does not call the THiNX notifier itself. When `WORKER` is `1` it serializes the
build outcome into JSON with [`jo`](https://github.com/jpmens/jo) and prints it to stdout
behind a `JOB-RESULT:` marker (`builder:1392`):

```
JOB-RESULT: {"build_id":"...","commit":"...","status":"...","sha":"...", ...}
```

`class.js` scrapes the spawned child process stdout for that marker, parses everything
from the first `{`, and reports the result back to the API over socket.io.

This is the only channel by which a build result leaves the builder, and it fails
quietly: if the line is missing or malformed the parse throws, and the job is reported
as `state: "Failed"` however the build actually went.

`jo` is therefore a hard runtime dependency, not a build-time convenience. It ships in
neither Alpine `main` nor `community`, which is why the `Dockerfile` appends the
`edge/community` repository before `apk add jo`. Do not drop that line.

## Building in Development

The image builds Docker CLI 29.8.1 from pinned, checksum-verified source with
`golang.org/x/net v0.59.0` and `google.golang.org/grpc v1.84.0`. The build checks
both versions in the compiled binary. Only the CLI is installed; jobs use the
host Docker daemon through `/var/run/docker.sock`, which must be mounted into
the worker. The image does not include a Docker daemon, containerd, or runc.

```bash

 docker build -t thinxcloud/worker .
 
 docker run \
  -e THINX_SERVER=<required> \
  -e WORKER_SECRET=<required> \
  -e ROLLBAR_ACCESS_TOKEN=<optional> \
  -e ROLLBAR_ENVIRONMENT=production \
  -ti thinxcloud/worker

```
