FROM golang:1.25-bookworm AS builder

ARG CRONOS_TAG=v1.7.0

RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    ca-certificates \
    git \
    make \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /src
RUN git clone --depth 1 --branch ${CRONOS_TAG} https://github.com/crypto-org-chain/cronos.git .

# Disable ledger to avoid extra native deps in container build.
RUN make build LEDGER_ENABLED=false

FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    bash \
    ca-certificates \
    curl \
    jq \
    tini \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /src/build/cronosd /usr/local/bin/cronosd

ENTRYPOINT ["cronosd"]
