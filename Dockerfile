# docker build -t suculent/thinx-worker .

FROM node:19-alpine

LABEL name="thinxcloud/worker" version="1.7.86"

RUN echo "http://dl-cdn.alpinelinux.org/alpine/edge/community" >> /etc/apk/repositories

ARG THINX_SERVER
ARG ROLLBAR_ACCESS_TOKEN
ARG ROLLBAR_ENVIRONMENT
ARG WORKER_SECRET
ARG REVISION
ARG DATA_PATH

ENV THINX_SERVER=${THINX_SERVER}
ENV ROLLBAR_ACCESS_TOKEN=${ROLLBAR_ACCESS_TOKEN}
ENV ROLLBAR_ENVIRONMENT=${ROLLBAR_ENVIRONMENT}
ENV WORKER_SECRET=${WORKER_SECRET}
ENV REVISION=${REVISION}
ENV WORKER=1
ENV DATA_PATH=${DATA_PATH}

WORKDIR /opt/thinx/thinx-device-api

RUN apk update && apk upgrade

COPY ./devsec-src ./devsec-src

RUN apk add --no-cache \
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

ENV VER="20.10.12"
RUN curl -sL -o /tmp/docker-$VER.tgz https://download.docker.com/linux/static/stable/x86_64/docker-$VER.tgz && \
    tar -xz -C /tmp -f /tmp/docker-$VER.tgz && \
    rm -rf /tmp/docker-$VER.tgz && \
   mv /tmp/docker/* /usr/bin

# set up subuid/subgid so that "--userns-remap=default" works out-of-the-box
RUN set -x \
	&& addgroup dockremap -g 65536 \
	&& adduser --system dockremap -g 65536 \
	&& echo 'dockremap:165536:65536' >> /etc/subuid \
	&& echo 'dockremap:165536:65536' >> /etc/subgid

VOLUME /var/lib/docker

# Running npm install for production purpose will not run dev dependencies.
RUN npm install -g npm@8.6.0 && \
    npm install . --only-prod

# Create a user group 'thinx' (problem with rights across containers)
# RUN addgroup -S thinx && \
    # adduser -S -D -h /opt/thinx/thinx-device-api worker thinx && \
    # chown -R worker:thinx /opt/thinx/thinx-device-api && \
    # chmod +x ./devsec

RUN chmod +x ./devsec

# Switch to 'transformer' or 'node' user
# USER worker problem with rights across containers)

# Open the mapped port DEPRECATED! Remove after testing.
EXPOSE 4000

CMD [ "node", "worker.js" ]
