# Hono Migration Plan — Proxy API on bare Node

_Status: Phase 2 spike complete & validated (2026-09-03). Next up: Phase 3._

## Goal

Reduce the server's memory footprint. Today one Next.js process serves the
dashboard **and** the LLM proxy surface (`/v1/*`, `/v1beta/*`). The framework
runtime is the dominant fixed cost; the proxy core itself (`src/sse/*`,
`open-sse/*`, `src/lib/db/*`) is already pure Web-API code with no Next
imports. Moving the proxy surface onto a thin Hono server lets Next shrink —
and eventually disappear — from the request path.

Measured (Node 20, warm-idle RSS, identical warmup protocol — see
`scripts/mem-bench.mjs`):

| Target                          | Warm-idle RSS (median) | p80     |
| ------------------------------- | ---------------------- | ------- |
| Next standalone + custom-server | ~115 MB                | ~148 MB |
| Hono (`/v1` surface loaded)     | ~90–97 MB              | ~125 MB |

Savings grow as more of the 130+ dashboard API groups migrate off Next; the
numbers above only reflect the `/v1` surface.

## Architecture

### Design principle: zero logic duplication

`hono-server/server.js` does **not** re-implement any route. It imports the
original Next route modules from `src/app/api/v1/**` and calls their exported
handlers, adapting Hono's context to the Next signature:

```js
// Next route module (Web-API only):
export async function POST(request, { params }) { ... }
// hono-server adapter:
const mod = await loader();                       // lazy module load, like Next
return mod.POST(c.req.raw, { params: Promise.resolve(params) });
```

Constraints this imposes on migrated route files:

- Must stay Web-API only (`Request` in, `Response` out) — no `next/server`
  imports (verified: all 23 `/v1` + `/v1beta` routes already comply).
- Dynamic params must be read from `{ params }` (a Promise, Next 15+ style).
- Module-level `ensureInitialized()` / translator init keeps working unchanged.
- Next-specific exports (`dynamic`, `maxDuration`) are inert at runtime.

### Module resolution on bare Node

`hono-server/alias-loader.mjs` (registered via
`node --import ./hono-server/register.mjs`) resolves the jsconfig aliases:

- `@/*` → `<root>/src/*` (with `.js` / `/index.js` fallbacks)
- `open-sse`, `open-sse/*` → `<root>/open-sse/…`
- `node-machine-id` → `hono-server/shims/node-machine-id.mjs` (UMD bundle whose
  named exports cjs-module-lexer cannot detect; the only CJS interop issue in
  the entire dependency graph — verified by scanning all 94 bare packages with
  named imports)

### Route table (mounted at both `/api/v1` and `/v1`, plus `/v1beta`)

All 23 routes: chat/completions, messages, messages/count_tokens, models,
models/info, models catch-all, responses, responses/compact, embeddings,
search, images/generations, audio/speech, audio/transcriptions, audio/voices,
videos/{generations,edits,extensions}, videos/:id, api/chat (Ollama),
web/fetch, v1beta/models, v1beta/models/[...path]. Next's rewrites are
replicated via internal re-dispatch: `/v1/v1/*`, `/responses`, `/codex/*`.
Lazy per-route loading mirrors Next's behavior (empty surface ≈ 86 MB cold).

## Validation results (2026-09-03)

Isolated `DATA_DIR` imported from a real production backup via the app's own
`importDb()` (12 connections, 4 API keys, 551 live models):

| Test                                          | Result |
| --------------------------------------------- | ------ |
| SSE streaming `/v1/chat/completions`          | ✅ incremental `delta.content` |
| SSE streaming `/v1/messages` (Anthropic fmt)  | ✅ `message_start` → `content_block_delta` |
| GLM-5.3-flash reasoning tokens                | ✅ `reasoning_content` deltas stream |
| Non-streaming completion                      | ✅ |
| Tool calls (function calling)                 | ✅ `finish_reason: tool_calls` |
| Gemini `/v1beta:streamGenerateContent`        | ✅ Gemini SSE incl. `thought: true` |
| Client abort mid-stream                       | ✅ upstream fetch cancelled, server healthy |
| Usage tracking → `usageHistory` rows          | ✅ provider/model/tokens/cost recorded |
| Auth (invalid/valid keys, error formats)      | ✅ OpenAI/Claude/Gemini-shaped errors |
| **Parity vs Next standalone** (same data dir) | ✅ byte-identical chunk shapes and error bodies |

Known pre-existing issue (reproduced identically on Next — **not** a migration
regression): `/v1beta/models/{a}/{b}/{c}:action` (3+ path segments) fails
because the route only supports ≤2 segments (`alias:action` or
`provider/model:action`). Slashed model IDs must use model aliases. Candidate
fix as a standalone change later.

## Migration phases

### ✅ Phase 0 — Baseline benchmark (`scripts/mem-bench.mjs`)
Warm-idle protocol: spawn → healthy → cold RSS → warmup every route group →
settle → 30 samples → median/p20/p80. `npm run bench:mem -- next hono`.
Env: `BENCH_WARMUP=full` (also loads admin bundles on Next),
`BENCH_PORT`, `SAMPLES`, `SAMPLE_INTERVAL_MS`, `SETTLE_MS`.

### ✅ Phase 2 — Hono proxy surface (`hono-server/`)
Run: `npm run hono:start` (default port 20127; `PORT`/`HOST` env). Shares the
same `DATA_DIR`/SQLite DB as Next, so both servers can run side by side during
migration. `package.json` adds `hono` + `@hono/node-server` deps only.

### Phase 3 — Admin API groups onto Hono (next up)
Migrate dashboard API groups one at a time, cheapest first:
`usage` → `providers`/`models` → `cli-tools` → `proxy-pools`/`settings`/combos/keys.
For each group:
1. Replace `NextResponse.json()` → `Response.json()` (mechanical, ~120 files
   overall; do per group).
2. Drop route files from Next into Hono's route table (the adapter already
   handles them).
3. While Next still serves the dashboard, Hono becomes the front server on
   :20127 and internally proxies not-yet-migrated `/api/*` paths to a
   Next instance on a private port (re-dispatch pattern already proven in
   `server.js`).
4. Re-run `mem-bench.mjs` after each group to track the curve.

### Phase 3.5 — Port custom-server security wrapper (required before full front)
Currently documented as TODO in `hono-server/server.js`:
- `x-9r-real-ip` stamping + forwarding-header sanitization + peer token
  (needed by login rate-limiting and request-detail redaction).
- h2c upgrade downgrade (JBR clients).
- 128 MB `proxyClientMaxBodySize` equivalent (Hono has no body limit today).

### Phase 4 — Auth + decommission Next
- Migrate auth group (login/logout/status, SAML, OIDC). These use
  `cookies()`/`headers()` from `next/headers` and need real porting to
  Hono cookie handling — the only genuinely Next-coupled surface.
- Serve the dashboard as static files from Hono (dashboard is ~all client
  components; only `dashboard/console-log` does server-side fetching and must
  move to client fetch).
- Remove Next from the Docker image (`serverExternalPackages`, standalone
  copy steps, ~size + memory win), drop unused `express` +
  `http-proxy-middleware` deps (already dead weight).
- Optional: evaluate Bun runtime (`bun:sqlite` built-in removes the native
  dependency; repo already has `dev:bun`/`start:bun` scripts).

### Post-migration candidates
- Fix the v1beta multi-segment path limitation.
- User/password multi-user auth (single shared password today; JWT claims
  already generic via `createDashboardAuthToken(claims)` — needs a `users`
  table, username lookup at login, `sub`/`role` claims, and a bootstrap
  migration of the existing password into an admin user).

## Files

| Path | Purpose |
| ---- | ------- |
| `hono-server/server.js` | Entry: route table, rewrites, bg token refresh, serve |
| `hono-server/alias-loader.mjs` | Node resolve hook for `@/`, `open-sse`, CJS shim |
| `hono-server/register.mjs` | Loader registration (`--import` target) |
| `hono-server/shims/node-machine-id.mjs` | CJS→ESM interop shim |
| `scripts/mem-bench.mjs` | Warm-idle memory benchmark (`next` / `hono`) |
