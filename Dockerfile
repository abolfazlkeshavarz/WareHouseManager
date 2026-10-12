# syntax=docker/dockerfile:1
#
# Warehouse app image: Node 22 (built-in SQLite, no native modules), no build step.
# Data (SQLite database + uploaded photos) lives in the /data volume, never in the image.

FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:22-alpine
ARG VERSION=dev
LABEL org.opencontainers.image.title="warehouse-app" \
      org.opencontainers.image.version="${VERSION}"

ENV NODE_ENV=production \
    DATA_DIR=/data \
    PORT=3000 \
    HOST=0.0.0.0 \
    TZ=Asia/Tehran

WORKDIR /app
COPY --from=deps --chown=node:node /app/node_modules ./node_modules
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node public ./public
COPY --chown=node:node scripts/cli.js scripts/backup.js ./scripts/

# /data is owned by the unprivileged "node" user; a fresh named volume inherits this.
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000

# Set last so a new commit does not invalidate the cached layers above.
ARG GIT_COMMIT=unknown
ARG BUILD_TIME=
ENV APP_COMMIT=${GIT_COMMIT} \
    APP_BUILT_AT=${BUILD_TIME}

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/health >/dev/null || exit 1

CMD ["node", "--no-warnings", "server/index.js"]
