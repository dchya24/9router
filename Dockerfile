# syntax=docker/dockerfile:1.7
ARG NODE_IMAGE=node:22-alpine

# ── Builder: full deps (Next + React are devDependencies) → static export ──
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
# CN mirror for apk (used by builder and runner stages)
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.npm \
  npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
# Static dashboard export (next.config.mjs output:"export") → out/
RUN NEXT_EXPORT=1 npx next build --webpack

# ── Runner: production deps only (hono, jose, undici, better-sqlite3, …) ───
FROM ${NODE_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOST=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
ENV DASHBOARD_EXPORT_DIR=/app/out
# Containers never use the Antigravity MITM (sudo/DNS/hosts edits) — hard-off.
ENV NINEROUTER_DISABLE_MITM=1

# Production deps only — Next.js/React are devDependencies now, not installed here.
# better-sqlite3 ships per-platform prebuilds; if a download ever fails, the app
# falls back to node:sqlite (built into Node ≥22.5) via src/lib/db/driver.js.
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install --omit=dev --no-audit --no-fund

# Server source (routes, sse core, lib, shared) + hono-server + exported dashboard
COPY hono-server ./hono-server
COPY src ./src
COPY open-sse ./open-sse
COPY --from=builder /app/out ./out
COPY public ./public
# sql.js loads dist/sql-wasm.wasm by path at runtime (last-resort DB driver);
# node-machine-id is createRequire-loaded — both come from npm install above.

RUN mkdir -p /app/data && chown -R node:node /app

# Fix permissions at runtime (handles mounted volumes)
RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R node:node /app/data 2>/dev/null\nexec su-exec node "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
# Peer-header stamping + h2c downgrade live in hono-server/peer-server.js
# (custom-server.js parity).
CMD ["node", "--import", "./hono-server/register.mjs", "hono-server/server.js"]
