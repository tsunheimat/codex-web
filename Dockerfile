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
    HOME=/home/codex-web \
    CODEX_HOME=/home/codex-web/.codex \
    CODEX_WEBUI_BROWSE_ROOT=/workspace \
    CODEX_WEBUI_ALLOW_ANY_PROJECT=false \
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
    && mkdir -p /app /workspace /home/codex-web "${CODEX_HOME}"

WORKDIR /app

COPY --from=build /app/package.json /app/package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/src/server ./src/server
COPY --from=build /app/scratch/asar ./scratch/asar
COPY container-init.sh /usr/local/bin/codex-web-init.sh

RUN chmod 0555 /usr/local/bin/codex-web-init.sh

EXPOSE 8214

VOLUME ["/workspace", "/home/codex-web/.codex"]

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "src/server/main.js", "--host", "0.0.0.0", "--port", "8214"]
