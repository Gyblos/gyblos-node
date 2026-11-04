# Seller node image: the daemon and the `gyblos` CLI, no engine. Data (keys, journals, tokenizer) lives in
# the /data volume and the configuration is mounted read-only; secrets come only from the environment.
FROM node:24.22.1-bookworm-slim AS build
ENV CI=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
RUN corepack enable && corepack prepare pnpm@10.12.1 --activate
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && pnpm store prune

FROM node:24.22.1-bookworm-slim
ENV GYBLOS_HOME=/data GYBLOS_CONFIG=/config/gyblos.toml
COPY --from=build --chown=node:node /app /app
RUN install -d -o node -g node -m 0700 /data
USER node
WORKDIR /app
VOLUME /data
# The daemon withdraws its listing and saves its public sequence on the first SIGINT.
STOPSIGNAL SIGINT
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["start"]
