# docker build -t suculent/thinx-worker .

FROM golang:1.26.8-alpine3.24 AS docker-cli

RUN apk add --no-cache ca-certificates curl git
WORKDIR /src/docker-cli

# Docker CLI v29.8.1, pinned by source commit and archive checksum.
RUN curl -fSL https://codeload.github.com/docker/cli/tar.gz/477f1252f2391a2b34fdce2e7bd03a0eee660005 -o /tmp/cli.tar.gz \
    && echo "4609135885a5afea23961dc07bb070febe3a9976165ff104b3138d46757006f8  /tmp/cli.tar.gz" | sha256sum -c - \
    && tar -xzf /tmp/cli.tar.gz --strip-components=1 \
    && rm /tmp/cli.tar.gz

# Upstream uses vendor.mod instead of go.mod. Build in module mode so the
# requested versions replace the vendored dependencies and remain auditable.
RUN cp vendor.mod go.mod && cp vendor.sum go.sum \
    && go get golang.org/x/net@v0.59.0 google.golang.org/grpc@v1.85.0-dev.0.20260825072537-93e31b48545e \
    && CGO_ENABLED=0 go build -mod=mod -trimpath -tags grpcnotrace \
       -ldflags "-s -w -X github.com/docker/cli/cli/version.Version=29.8.1 -X github.com/docker/cli/cli/version.GitCommit=477f125-deps" \
       -o /out/docker ./cmd/docker \
    && go version -m /out/docker | awk '\
       $1 == "dep" && $2 == "golang.org/x/net" { net = ($3 == "v0.59.0") } \
       $1 == "dep" && $2 == "google.golang.org/grpc" { grpc = ($3 == "v1.85.0-dev.0.20260825072537-93e31b48545e") } \
       END { exit !(net && grpc) }' \
    && /out/docker --version \
    && /out/docker run --help >/dev/null \
    && /out/docker service create --help >/dev/null

FROM dhi.io/node:26-alpine3.24-dev

LABEL name="thinxcloud/worker" version="1.7.168"

RUN echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories

# Non-secret build configuration only. Secrets (WORKER_SECRET, ROLLBAR_ACCESS_TOKEN)
# MUST be provided at runtime (e.g. `docker run -e WORKER_SECRET=... -e ROLLBAR_ACCESS_TOKEN=...`
# or via a secrets manager) so they are never baked into image layers / `docker history`.
ARG THINX_SERVER
ARG ROLLBAR_ENVIRONMENT
ARG REVISION
ARG DATA_PATH

ENV THINX_SERVER=${THINX_SERVER}
ENV ROLLBAR_ENVIRONMENT=${ROLLBAR_ENVIRONMENT}
ENV REVISION=${REVISION}
ENV WORKER=1
ENV DATA_PATH=${DATA_PATH}

WORKDIR /opt/thinx/thinx-device-api

RUN apk update && apk upgrade

COPY ./devsec-src ./devsec-src

RUN apk update && apk add --no-cache \
    bash \
    curl \
    g++ \
    gcc \
    git \
    jq \
    jo \
    libgcc \
    libc-dev \
    libstdc++ \ 
    linux-headers \
    make \
    perl-utils \
    zip \
    && cd ./devsec-src && ./build.sh && cd .. \
    && rm -rf ./devsec-src \
    && apk del \
    g++ \
    gcc

COPY . .

# this may not bee needed if belongs to linter only, however it may be required by infer
COPY ./platforms ./platforms

# Jobs use the host's Docker socket; daemon/containerd/runc binaries are not needed.
COPY --from=docker-cli /out/docker /usr/bin/docker

# set up subuid/subgid so that "--userns-remap=default" works out-of-the-box
# -G is explicit: the hardened base has no "nogroup", which busybox adduser --system
# would otherwise fall back to.
RUN set -x \
	&& addgroup dockremap -g 65536 \
	&& adduser --system -G dockremap dockremap -g 65536 \
	&& echo 'dockremap:165536:65536' >> /etc/subuid \
	&& echo 'dockremap:165536:65536' >> /etc/subgid

VOLUME /var/lib/docker

# Running npm install for production purpose will not run dev dependencies.
#
# npm is a build-time tool only and is removed in the same layer it was used
# in — a later `rm` would leave it in the earlier layer and save nothing. This
# mirrors the main Dockerfile.
#
# Safe because the runtime never calls it: CMD is `node worker.js`, and nothing
# under services/worker shells out to npm or npx (the only subprocess is
# runShell -> ./builder in class.js). builders/install-tools.sh does run
# `npm install eslint`, but that executes inside the separate builder images
# (arduino/platformio/...), not here.
#
# Both copies go: /usr/local (if present) and /usr/lib (from the base image),
# plus the ~/.npm cache. This also removes npm's vendored brace-expansion,
# which is what Aikido flags at
# usr/lib/node_modules/npm/node_modules/brace-expansion — no npm release
# currently bundles a fixed (>=5.0.11) copy, so removal is the only fix.
RUN npm install . --omit=dev \
 && npm cache clean --force \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/lib/node_modules/npm /usr/bin/npm /usr/bin/npx \
           /root/.npm

# Create a user group 'thinx' (problem with rights across containers)
# RUN addgroup -S thinx && \
    # adduser -S -D -h /opt/thinx/thinx-device-api worker thinx && \
    # chown -R worker:thinx /opt/thinx/thinx-device-api && \
    # chmod +x ./devsec

RUN chmod +x ./devsec

# Switch to 'transformer' or 'node' user
# USER worker problem with rights across containers)

CMD [ "node", "worker.js" ]
