# Docker

Run 9Router in a container. This fork builds a **single-process Hono image** —
one small Node process serves the dashboard (static export), all APIs, the
LLM proxy surface, and the security guard. There is no Next.js server process
and the Antigravity MITM is disabled by default (`NINEROUTER_DISABLE_MITM=1`).

- Upstream image (unchanged behavior): [`decolua/9router`](https://hub.docker.com/r/decolua/9router)
- This fork: build locally (below) or point CI at this repo — the image
  layout and ports are identical, so the commands work for either.

---

# 👤 For Users

## Quick start

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  --name 9router \
  9router:hono-test
```

> Use `decolua/9router:latest` here instead if you want the upstream image.
> `9router:hono-test` is the tag the local build in this repo produces.

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

The fork runs as a single small Node process — no Next.js server — so a VPS
needs only Node 22 (or Docker) and a data directory. Because a VPS is
internet-exposed, set `REQUIRE_API_KEY=true`, a strong `INITIAL_PASSWORD`, and
a random `JWT_SECRET` before the first boot.

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
# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs

git clone https://github.com/dchya24/9router.git /opt/9router && cd /opt/9router
npm install
NEXT_EXPORT=1 npm run build     # static dashboard -> out/
npm prune --omit=dev            # runtime deps only
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
ExecStart=/usr/bin/node --import ./hono-server/register.mjs hono-server/server.js
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
| `NINEROUTER_DISABLE_MITM` | `1` (in image) | hard-off Antigravity MITM; remove to enable |
| `NINEROUTER_DISABLE_BG_REFRESH` | unset | set `1` to skip OAuth token refresh scheduler |

```bash
docker run -d \
  -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  -e INITIAL_PASSWORD=change-me \
  --name 9router \
  9router:hono-test
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
docker pull decolua/9router:latest   # upstream image
# or rebuild the local image:
docker build -t 9router:hono-test .
docker rm -f 9router
# re-run the quick start command
```

---

# 🛠 For Developers

## Build image locally

```bash
docker build -t 9router:hono-test .

docker run --rm -p 20128:20128 \
  -v "$HOME/.9router:/app/data" \
  -e DATA_DIR=/app/data \
  9router:hono-test
```

Image anatomy (multi-stage):

- **builder** — installs all deps (Next/React are devDependencies) and runs
  the static dashboard export
- **runner** — production deps only (`hono`, `jose`, `undici`,
  `better-sqlite3`, `sql.js`, …) + `hono-server/`, `src/`, `open-sse/`, and
  the exported dashboard. No Next.js server, no build tools.

Runtime entry: `node --import ./hono-server/register.mjs hono-server/server.js`
(the `--import` loader resolves the `@/` and `open-sse` aliases and shims
`next/headers` for the migrated auth routes).

## What the process does at boot

1. Peer-header stamping + h2c downgrade wrap the HTTP server
   (`hono-server/peer-server.js`, parity with the old custom-server.js).
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
pushes to the registry configured in `.github/workflows/docker-publish.yml`.

```bash
git tag v0.5.65-hono.1 && git push origin v0.5.65-hono.1
```
