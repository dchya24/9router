# syntax=docker/dockerfile:1.7
# Bun-only image: Bun.serve serves the Hono app and bun:sqlite is the database
# driver (both built into the runtime). Node appears only as a build-time
# toolchain — the dashboard export and the runtime dependency install.
ARG NODE_IMAGE=node:22-alpine
ARG BUN_IMAGE=oven/bun:1.4-alpine

# ── Builder: full deps (Next + React are devDependencies) → static export ──
FROM ${NODE_IMAGE} AS builder
WORKDIR /app
RUN sed -i 's|dl-cdn.alpinelinux.org|mirrors.aliyun.com|g' /etc/apk/repositories

COPY package.json bun.lock ./
RUN --mount=type=cache,target=/root/.npm \
  npm install

COPY . ./
ENV NEXT_TELEMETRY_DISABLED=1
RUN NEXT_EXPORT=1 npx next build --webpack

# ── Runtime dependencies: node/npm exist only in this build stage ────────────
# No SQLite driver is installed: bun:sqlite is built in and the Node adapters
# (better-sqlite3, node:sqlite, sql.js) were removed with the Node server path.
FROM ${NODE_IMAGE} AS production-deps
WORKDIR /app
COPY package.json ./
RUN --mount=type=cache,target=/root/.npm \
  npm install --omit=dev --no-audit --no-fund --ignore-scripts

# ── Runner: Bun ─────────────────────────────────────────────────────────────
FROM ${BUN_IMAGE} AS runner
WORKDIR /app

LABEL org.opencontainers.image.title="9router" \
      org.opencontainers.image.base.name="oven/bun"

ENV NODE_ENV=production
ENV PORT=20128
ENV HOST=0.0.0.0
ENV NEXT_TELEMETRY_DISABLED=1
ENV DATA_DIR=/app/data
ENV DASHBOARD_EXPORT_DIR=/app/out
# Containers never use the Antigravity MITM (sudo/DNS/hosts edits) — hard-off.
ENV NINEROUTER_DISABLE_MITM=1
# Workload gates: tunnel/tailscale watchdogs, headroom reverse proxy, pxpipe
# loader. Unset any of these to re-enable that surface.
ENV NINEROUTER_DISABLE_TUNNEL=1
ENV NINEROUTER_DISABLE_HEADROOM=1
ENV NINEROUTER_DISABLE_PXPIPE=1

# --chown avoids a later `chown -R /app`, which would re-copy every file into a
# new layer and roughly double the app payload in the image.
COPY --chown=bun:bun --from=production-deps /app/node_modules ./node_modules
COPY --chown=bun:bun jsconfig.json bunfig.toml package.json ./
COPY --chown=bun:bun hono-server ./hono-server
COPY --chown=bun:bun src ./src
COPY --chown=bun:bun open-sse ./open-sse
COPY --chown=bun:bun --from=builder /app/out ./out

RUN mkdir -p /app/data && chown bun:bun /app/data

# Fix permissions at runtime (handles mounted volumes) — same pattern as before,
# dropping to the image's default `bun` user.
RUN apk --no-cache upgrade && apk --no-cache add su-exec && \
  printf '#!/bin/sh\nchown -R bun:bun /app/data 2>/dev/null\nexec su-exec bun "$@"\n' > /entrypoint.sh && \
  chmod +x /entrypoint.sh

EXPOSE 20128

ENTRYPOINT ["/entrypoint.sh"]
CMD ["bun", "--preload", "./hono-server/bun-shims.js", "hono-server/server.js"]
