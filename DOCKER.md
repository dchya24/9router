# Docker

Run 9Router in a container. The default image uses **Bun + Hono in one
process** to serve the static dashboard, APIs, LLM proxy, and security guard.
There is no Next.js server process, and the Antigravity MITM is disabled by
default (`NINEROUTER_DISABLE_MITM=1`). Node is a build-time toolchain only:
the running server is Bun.

Image (this fork): `ghcr.io/dchya24/9router` — published by CI on `v*` tags
(e.g. `0.5.69-hono.4` + `latest`), using Bun by default. Build locally with
`docker build -t 9router .`.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  ghcr.io/dchya24/9router:latest
```

If building locally, the default Dockerfile uses Bun:

```bash
docker build -t 9router . && docker run -d \
  -p 20128:20128 -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data \
  --name 9router 9router
```

App listens on port `20128`. Open: http://localhost:20128

First boot initializes an empty SQLite DB in the mounted data dir. The
dashboard asks you to set a password on first login (or set
`INITIAL_PASSWORD` before first launch).

## Docker Compose

```yaml
services:
  9router:
    build: .            # or image: <your-registry>/9router:latest
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      # INITIAL_PASSWORD: change-me-before-first-login
    restart: unless-stopped
```

## Manage container

```bash
docker logs -f 9router        # view logs
docker stop 9router           # stop
docker start 9router          # start again
docker rm -f 9router          # remove
```

## Data persistence

```bash
-v "$HOME/.9router:/app/data" \
-e DATA_DIR=/app/data
```

Without `DATA_DIR`, the app falls back to `~/.9router/` (macOS/Linux) or
`%APPDATA%\9router\` (Windows). In the container, `DATA_DIR=/app/data` makes
the bind mount work.

Data layout under `$DATA_DIR/`:

```text
$DATA_DIR/
├── db/
│   ├── data.sqlite       # main SQLite database
│   └── backups/          # auto backups
├── model-catalog.json    # synced model capabilities cache
└── ...                   # certs, logs, runtime configs
```

Host path: `$HOME/.9router/db/data.sqlite`
Container path: `/app/data/db/data.sqlite`

---

# 🌍 VPS deployment

The fork runs as a single Bun process by default (Node 22 is the fallback),
with no Next.js server. Because a VPS is internet-exposed, set
`REQUIRE_API_KEY=true`, a strong `INITIAL_PASSWORD`, and a random `JWT_SECRET`
before the first boot.

## Option A — Docker

```bash
git clone https://github.com/dchya24/9router.git && cd 9router
docker build -t 9router .

# custom port: map host 8080 -> container 20128
docker run -d --name 9router \
  -p 8080:20128 \
  -v /var/lib/9router:/app/data \
  -e DATA_DIR=/app/data \
  -e INITIAL_PASSWORD=<strong-password> \
  -e JWT_SECRET=<openssl rand -hex 32> \
  -e REQUIRE_API_KEY=true \
  --restart unless-stopped \
  9router
```

Or `docker-compose.yml`:

```yaml
services:
  9router:
    build: .
    ports:
      - "8080:20128"       # host:container — change 8080 to any port
    volumes:
      - /var/lib/9router:/app/data
    environment:
      DATA_DIR: /app/data
      INITIAL_PASSWORD: <strong-password>
      JWT_SECRET: <random>
      REQUIRE_API_KEY: "true"
    restart: unless-stopped
```

## Option B — from source (systemd)

```bash
# Bun runtime (install Bun using its official installer)
curl -fsSL https://bun.sh/install | bash

git clone https://github.com/dchya24/9router.git /opt/9router && cd /opt/9router
npm install
NEXT_EXPORT=1 npm run build     # static dashboard -> out/
npm prune --omit=dev --omit=optional # runtime deps only; Bun uses bun:sqlite
bun --preload ./hono-server/bun-shims.js hono-server/server.js
```

`/etc/systemd/system/9router.service` — custom port via `PORT`:

```ini
[Unit]
Description=9Router (Hono)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/9router
Environment=PORT=8080
Environment=HOST=0.0.0.0
Environment=DATA_DIR=/var/lib/9router
Environment=NODE_ENV=production
Environment=NINEROUTER_DISABLE_MITM=1
Environment=INITIAL_PASSWORD=<strong-password>
Environment=JWT_SECRET=<random>
Environment=REQUIRE_API_KEY=true
ExecStart=/root/.bun/bin/bun --preload ./hono-server/bun-shims.js hono-server/server.js
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload && sudo systemctl enable --now 9router
sudo ufw allow 8080/tcp    # only the app port + SSH
```

## How the custom port works

- Source runs read `PORT` (default 20127) and `HOST` (default 0.0.0.0).
- The container reads `PORT` (image default 20128); the simplest way to change
  the public port is the host-side mapping `-p <host>:20128`.
- HTTPS: put nginx/Caddy/Cloudflare in front and set `AUTH_COOKIE_SECURE=true`.

## Optional env vars

| Variable | Default | Notes |
| --- | --- | --- |
| `DATA_DIR` | `/app/data` | keep the bind mount pointing here |
| `PORT` | `20128` | container listen port |
| `HOST` | `0.0.0.0` | bind all interfaces; set `127.0.0.1` for local-only |
| `INITIAL_PASSWORD` | unset | pre-set the first dashboard password |
| `JWT_SECRET` | generated to `$DATA_DIR/jwt-secret` | set for multi-replica sharing |
| `REQUIRE_API_KEY` | `false` | require an API key for the `/v1` surface |
| `INITIAL_ADMIN_USER` / `INITIAL_ADMIN_PASSWORD` | unset | create the first multi-user admin at boot (idempotent); once ≥1 user AND ≥1 admin exist, dashboard login requires username+password |
| `NINEROUTER_DISABLE_MULTI_USER` | unset | set `1` to disable the multi-user layer entirely (shared-password login only) |
| `NINEROUTER_DISABLE_MITM` | `1` (in image) | hard-off Antigravity MITM; remove to enable |
| `NINEROUTER_DISABLE_BG_REFRESH` | unset | set `1` to skip OAuth token refresh scheduler |

## Bun runtime

The server runs **unmodified under Bun** (native `bun:sqlite` via the driver
chain, `@/*` aliases resolved natively). From source:

```bash
npm install && npm run build        # dashboard export → out/ (unchanged)
npm start   # bun --preload ./hono-server/bun-shims.js hono-server/server.js
```

The default `Dockerfile` builds the Bun runtime on `oven/bun:1.4-alpine`
(builder stays on Node so the dashboard export uses the existing toolchain).
Validated on Bun 1.4.2 — see `docs/BENCH_VPS_BUN.md` (idle ~59 MB vs ~97 MB on
Node in the comparable benchmark). The Bun runner omits the optional SQLite
drivers (`better-sqlite3`, `sql.js`); it uses the built-in `bun:sqlite`. Keep
the Bun minor version pinned and revalidate before upgrades.

```bash
docker build -t 9router:bun .
docker run -d -p 20128:20128 -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data -e INITIAL_PASSWORD=change-me --name 9router 9router:bun
```


```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e INITIAL_PASSWORD=change-me \
  --name 9router \
  9router:bun
```

## Optional Headroom sidecar

The 9Router image does not bundle Python or Headroom. To use Headroom in
Docker, run it as a separate service and point 9Router at that proxy:

```yaml
services:
  9router:
    build: .
    ports:
      - "20128:20128"
    volumes:
      - "$HOME/.9router:/app/data"
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
    depends_on:
      - headroom

  headroom:
    image: ghcr.io/chopratejas/headroom:latest
    ports:
      - "8787:8787"
```

In the dashboard, open `Endpoint` → `Token Saver` → `Headroom`, confirm the
URL is `http://headroom:8787`, recheck status, then enable Headroom.

If Headroom runs on the Docker host instead of as a sidecar, use
`http://host.docker.internal:8787` on macOS/Windows. On Linux, add
`--add-host=host.docker.internal:host-gateway` or the equivalent compose
`extra_hosts` entry.

## Update to latest

```bash
docker pull ghcr.io/dchya24/9router:latest
# or rebuild the local image:
docker build -t 9router .
docker rm -f 9router
# re-run the quick start command
```

---

# 🛠 For Developers

## Build image locally

```bash
docker build -t 9router .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router

```

Image anatomy (multi-stage):

- **builder** — installs all deps (Next/React are devDependencies) and runs
  the static dashboard export
- **Production dependency stage** — installs runtime packages with Node/npm,
  excluding the optional SQLite drivers (`better-sqlite3`, `sql.js`) for Bun.
  The runtime image receives only `node_modules`, not npm itself.
- **Bun runner** — `hono-server/`, `src/`, `open-sse/`, dependencies, and the
  exported dashboard. It does not copy duplicate `public/` assets or Next.js.
- **No SQLite driver is installed** — `bun:sqlite` is built into the runtime.

Runtime entry is `bun --preload ./hono-server/bun-shims.js hono-server/server.js`
(`bunfig.toml` sets the same preload, so plain `bun hono-server/server.js` works).

## What the process does at boot

1. Peer-header stamping + h2c downgrade wrap the HTTP server
   (Bun-native: `hono-server/peer-headers.js` reads the peer address from
   `requestIP`).
2. Deny-by-default auth guard (`hono-server/guard.js`) — public allow-list,
   JWT session cookie, CLI token, API-key gate on `/v1`.
3. Background OAuth token refresh scheduler (disable with
   `NINEROUTER_DISABLE_BG_REFRESH=1`).
4. Model-catalog sync from models.dev (disable with
   `NINEROUTER_DISABLE_INSTRUMENTATION=1`).
5. No MITM, no tunnel watchdogs, no DNS edits (`NINEROUTER_DISABLE_MITM=1`).

## Run without Docker (source)

```bash
npm install
npm run build                          # static dashboard export → out/
NINEROUTER_DISABLE_MITM=1 PORT=20128 npm start              # hono-server
```

`npm start` runs the Hono server only; `npm run dev` still runs the Next dev
server for dashboard development.

## Publish (automatic via CI)

Push a git tag `v*` → GitHub Actions builds multi-platform (amd64+arm64) and
pushes to **this fork's own GHCR** (no extra secrets — the built-in
`GITHUB_TOKEN` is used):

```bash
git tag v0.5.69-hono.3 && git push origin v0.5.69-hono.3
# → ghcr.io/dchya24/9router:0.5.69-hono.3 + :latest
```

> The first push creates the GHCR package as **private**. For anonymous
> `docker pull`, flip it to public: repo page → Packages → 9router → Package
> settings → Change visibility. On the VPS you can then simply
> `docker pull ghcr.io/dchya24/9router:latest` instead of building.

Then run on the VPS:

```bash
docker run -d --name 9router \
  -p 8080:20128 \
  -v /var/lib/9router:/app/data \
  -e DATA_DIR=/app/data \
  --restart unless-stopped \
  ghcr.io/dchya24/9router:latest
```
