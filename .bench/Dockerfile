FROM ubuntu:24.04 AS base
RUN apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install --no-install-recommends -y bash ca-certificates curl git xz-utils unzip zip procps python3 file lsof libatomic1 && rm -rf /var/lib/apt/lists/*
COPY node/ /usr/local/
RUN npm install -g --ignore-scripts --no-audit --no-fund pnpm@10.12.1 && npm cache clean --force && test "$(node -v)" = v24.22.1 && test "$(pnpm -v)" = 10.12.1
RUN useradd -m -u 1001 ci
FROM base AS deps
WORKDIR /fetch
COPY pnpm-lock.yaml pnpm-workspace.yaml ./
COPY patches/ patches/
RUN pnpm fetch --store-dir=/opt/ci-store --frozen-lockfile
FROM base
COPY --from=deps --chown=ci:ci /opt/ci-store /opt/ci-store
ENV npm_config_store_dir=/opt/ci-store
USER ci
