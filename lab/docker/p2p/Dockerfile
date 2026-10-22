ARG NODE_IMAGE
ARG OLLAMA_IMAGE
FROM ${OLLAMA_IMAGE} AS ollama
FROM ${NODE_IMAGE} AS runtime
ARG PNPM_VERSION
ARG SOURCE_SHA256
ENV HOME=/app/.local TMPDIR=/app/.local/tmp TSX_DISABLE_CACHE=1
WORKDIR /app
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate
COPY --from=ollama /bin/ollama /usr/local/bin/ollama
COPY --from=ollama /usr/lib/ollama/llama-server /usr/lib/ollama/*.so* /usr/lib/ollama/*LICENSE /usr/local/lib/ollama/
RUN test -x /usr/local/lib/ollama/llama-server
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.json ./
COPY packages/ ./packages/
COPY apps/ ./apps/
COPY lab/harness/ ./lab/harness/
COPY lab/p2p/ ./lab/p2p/
COPY lab/tools/ ./lab/tools/
COPY tooling/ ./tooling/
RUN pnpm install --frozen-lockfile --ignore-scripts && mkdir -p .local/tmp && chown -R node:node .local
LABEL org.gyblos.source-sha256=${SOURCE_SHA256}
USER node
CMD ["node", "--import", "tsx", "apps/cli/src/p2p/actor.ts"]
