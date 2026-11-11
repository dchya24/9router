# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

9Router (`9router-app`) — a local AI routing gateway + Next.js dashboard. It exposes one OpenAI-compatible endpoint (`/v1/*`) and routes traffic across 40+ upstream providers with format translation, model-combo fallback, multi-account fallback, OAuth/API-key credential management, token refresh, quota/usage tracking, and optional cloud sync.

Two published artifacts live in this one repo:
- The **dashboard + gateway** (root `package.json`, `9router-app`) — the Next.js server that does the actual routing.
- The **CLI launcher** (`cli/`, published to npm as `9router`) — a separate package that installs/starts the server and manages the tray. It has its own `package.json`, version, and build.

The code lives in `src/` (Next.js app + dashboard/compat APIs), `open-sse/` (the provider-agnostic routing/translation engine), `cli/` (the launcher package), and `tests/`.

## Commands

Dashboard/gateway (run from repo root):
```bash
cp .env.example .env
npm install
PORT=20128 NEXT_PUBLIC_BASE_URL=http://localhost:20128 npm run dev   # dev (webpack, port 20127 by default via next dev)
npm run build && PORT=20128 HOSTNAME=0.0.0.0 npm run start           # production
```
- Runtime: Bun only. `npm start` runs `bun hono-server/server.js`; `bunfig.toml`
  preloads `hono-server/bun-shims.js` so no `--preload` flag is needed.
- Default runtime port is **20128** (dashboard at `/dashboard`, API at `/v1`).
- Lint: `npx eslint .` (config `eslint.config.mjs`, extends `eslint-config-next`).

CLI package (`cli/`):
```bash
npm run cli:pack       # build + npm pack from root
cd cli && npm run dev  # nodemon watch
```

Tests (vitest, in `tests/`, an **independent** ESM package). The DB layer is Bun-only, so the suite
MUST run under Bun, from the **repo root** (several tests resolve fixture/source paths from CWD):
```bash
npm install                                # ROOT deps first — tests import from src/ (open, undici, jose, …)
cd tests && bun install --frozen-lockfile  # tests' own deps (vitest) → tests/node_modules
cd ..
bun --bun x vitest run --config tests/vitest.config.js              # full suite
bun --bun x vitest run --config tests/vitest.config.js unit/retention.test.js   # single file
npm run test:gate                          # full suite + regression gate (see below)
```
> **The suite is NOT all-green on a plain checkout** (~1,976 pass / 102 fail / 46 skip on Bun 1.4.4).
> Do not read a raw run as a verdict — gate it against the committed baseline:
> ```bash
> bun --bun tests/node_modules/vitest/vitest.mjs run --config tests/vitest.config.js \
>   --testTimeout=20000 --reporter=json --outputFile=test-results.json
> node tests/__baseline__/verify-no-regression.mjs test-results.json
> ```
> The gate fails only when a test outside `tests/__baseline__/known-fails.txt` fails, and its test IDs are
> repo-relative (`tests/unit/foo.test.js :: <name>`), so it works in any checkout. After an intentional,
> understood change in failures, re-baseline with `… verify-no-regression.mjs <report> --update`.
> CI runs the same gate (`.github/workflows/tests.yml`, Bun 1.4.4 pinned, 20 s test timeout).
>
> Known red on a plain checkout: cursor protobuf (`cursor-agent-proto`, 35), Kiro thinking
> (`openai-to-kiro`, 19 + `claude-kiro-direct`, 9), OAuth cursor auto-import (8), translator normalization,
> `request-details-tab`/`db-concurrent` (they import `better-sqlite3`, which Bun cannot load), plus a few
> network-dependent tests. `real/*.real.test.js` make live provider calls — skip unless credentials are set.
- `*.real.test.js` under `tests/translator/real/` make live provider calls — skip unless credentials are set.
- Regression baselines: `tests/__baseline__/verify-*.mjs` compare against committed snapshots (providers, aliases, OAuth URLs). Run these after touching provider registry / alias logic.

## Architecture

Two authoritative docs already exist — read them before working in these areas rather than re-deriving:
- `docs/ARCHITECTURE.md` — full system: request lifecycle, combo/account fallback, OAuth + token refresh, cloud sync, data model.
- `open-sse/AGENTS.md` — the routing/translation engine's own conventions and "how to add a provider/executor/translator". **Read this before editing anything under `open-sse/`.**

### Request flow (the thing to understand first)
`src/app/api/v1/*` route (Next rewrite maps `/v1/*` → `/api/v1/*` in `next.config.mjs`)
→ `src/sse/handlers/chat.js` (parse, combo expansion, account-selection loop)
→ `open-sse/handlers/chatCore.js` (detect source format, translate request, dispatch to executor, retry/refresh, stream setup)
→ `open-sse/executors/*` (per-provider upstream call; `default.js` handles any OpenAI-compatible provider)
→ `open-sse/translator/*` (client format ↔ provider format)
→ SSE back to client.

`src/sse/` is the app-side entry glue; `open-sse/` is the provider-agnostic engine (also usable standalone). Cross that boundary consciously.

### Translator engine (`open-sse/translator/`)
- Pivots through **OpenAI as the intermediate format**. A translator registered on an exact `source:target` pair (e.g. `claude:kiro`) runs as a **direct route**, skipping the lossy double-hop. Prefer a direct route for fragile pairs (thinking blocks, tool ids, non-base64 images, `is_error`).
- Translators **self-register** via `register(from, to, reqFn, resFn)` as an import side effect — a new translator file MUST be imported in `open-sse/translator/index.js` or it never runs.
- Never hardcode role/block/model strings — use `open-sse/translator/schema/` and `open-sse/config/` constants. Config-driven and DRY is enforced by convention here.

### Provider registry (`open-sse/providers/registry/*`)
- One file per provider. `providers/registry/index.js` is an **auto-generated** static import list — regenerate it with `scripts/migrate-registry.mjs` / `injectDisplayToRegistry.mjs`, don't hand-edit.
- Add a provider: copy `providers/REGISTRY_TEMPLATE.js`, add models to `config/providerModels.js`. Only add an executor for non-OpenAI-compatible upstreams.

### Persistence — IMPORTANT (ARCHITECTURE.md is stale here)
State is **no longer `db.json`**. It's a SQLite layer under `src/lib/db/` (`driver.js`) that uses Bun's built-in `bun:sqlite` adapter. The Node fallbacks (`better-sqlite3`, `node:sqlite`, `sql.js`) were deleted with the Node server path, so a non-Bun runtime now fails loudly.
- `src/lib/localDb.js` is a **backward-compat shim** re-exporting `src/lib/db/index.js`. New code should import from `@/lib/db/index.js`; per-entity logic lives in `src/lib/db/repos/*`. Schema/migrations in `src/lib/db/migrations/`.
- DB file location resolves via `src/lib/db/paths.js` (`DATA_DIR`, else `~/.9router/`).
- Usage/logs (`src/lib/usageDb.js`, `usage.json` + `log.txt`) still live under `~/.9router` and do **not** follow `DATA_DIR`.

### PXPIPE token saver (`open-sse/rtk/pxpipe.js`)
Pre-translate hook that folds bulky image context into Claude-format bodies to cut tokens. **Fail-open**: any error returns null and leaves the body untouched — never throw out of it. RTK/Headroom/Caveman/Ponytail were removed from this fork, along with the Token Saver, CLI Tools, Proxy Pools and Skills dashboard pages.

## Conventions & gotchas

- Plain JavaScript (ESM), no TypeScript. `@/*` path alias → `src/*` (`jsconfig.json`).
- Dashboard routes that are intentionally URL-only (no sidebar entry): `/dashboard/pxpipe` and `/dashboard/media-providers/*`.
- `custom-server.js` wraps the Next standalone server to derive client IP from the TCP socket and strip attacker-controlled `X-Forwarded-For` — trusting forwarding headers only from a loopback reverse proxy. Preserve this when touching request/IP/rate-limit code.
- Security-sensitive env: `JWT_SECRET` (session cookie), `INITIAL_PASSWORD` (default `123456` — must override), `API_KEY_SECRET`, `MACHINE_ID_SALT`. Full env contract in `.env.example` and ARCHITECTURE.md's env matrix.
- Binary/protobuf upstreams (kiro EventStream, cursor protobuf, commandcode NDJSON) don't round-trip through OpenAI — they're handled inside their own executor, not the translator.
- Versioning: root and `cli/` are versioned independently; changes are logged in `CHANGELOG.md`. Commit style is Conventional Commits (`fix(translator): …`, `feat(...)`).
