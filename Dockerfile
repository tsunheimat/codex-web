# syntax=docker/dockerfile:1.7

ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS build

ENV PATH=/app/node_modules/.bin:$PATH \
    npm_config_update_notifier=false

WORKDIR /app

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      ca-certificates \
      curl \
      g++ \
      git \
      make \
      patch \
      pkg-config \
      python3 \
      unzip \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

RUN npm ci --ignore-scripts \
    && npm rebuild better-sqlite3 node-pty sharp --foreground-scripts

COPY assets ./assets
COPY patches ./patches
COPY scripts/prepare ./scripts/prepare
COPY scripts/prepare_asar ./scripts/prepare_asar
COPY src ./src
COPY vite.browser.config.ts ./

RUN ./scripts/prepare \
    && npm run build:browser \
    && npm run build:server \
    && npm prune --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ARG CODEX_VERSION=0.145.0

ENV NODE_ENV=production \
    CODEX_HOME=/home/codex-web/.codex \
    CODEX_WEBUI_BROWSE_ROOT=/workspace \
    CODEX_CLI_PATH=/usr/local/bin/codex \
    npm_config_update_notifier=false

RUN apt-get update \
    && apt-get install -y --no-install-recommends \
      bash \
      ca-certificates \
      git \
      openssh-client \
      tini \
    && rm -rf /var/lib/apt/lists/* \
    && npm install --global "@openai/codex@${CODEX_VERSION}" \
    && npm cache clean --force \
    && groupadd --gid 10001 codex-web \
    && useradd \
      --uid 10001 \
      --gid codex-web \
      --create-home \
      --home-dir /home/codex-web \
      --shell /usr/sbin/nologin \
      codex-web \
    && mkdir -p /app /workspace "${CODEX_HOME}" \
    && chown -R codex-web:codex-web /app /workspace /home/codex-web

WORKDIR /app

COPY --from=build --chown=codex-web:codex-web /app/package.json /app/package-lock.json ./
COPY --from=build --chown=codex-web:codex-web /app/node_modules ./node_modules
COPY --from=build --chown=codex-web:codex-web /app/src/server ./src/server
COPY --from=build --chown=codex-web:codex-web /app/scratch/asar ./scratch/asar

EXPOSE 8214

VOLUME ["/workspace", "/home/codex-web/.codex"]

USER codex-web

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server/main.js", "--host", "0.0.0.0", "--port", "8214"]
