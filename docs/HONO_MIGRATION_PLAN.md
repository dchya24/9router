# Hono Migration Plan — Proxy API on bare Node

_Status: **Phase 3 complete; Phase 4 dashboard-static working (2026-09-04)** —
every route lives in Hono, and the dashboard now builds as a static export
served by Hono itself. A pure-Hono process (`node --import
./hono-server/register.mjs hono-server/server.js`, no Next) serves guard,
APIs, proxy surface, and dashboard E2E. Remaining: production packaging
(Dockerfile, CLI, start scripts) — see Phase 4 below._

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
| Next standalone + custom-server | ~115–154 MB (varies)   | ~148+ MB |
| Hono (full `/v1` + usage + guard loaded) | ~90–97 MB     | ~125 MB |

Savings grow as more of the 130+ dashboard API groups migrate off Next. Next's
RSS swings more between runs than Hono's; the direction is consistent across
every run.

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

### 🚧→✅ Phase 3 — Admin API groups onto Hono (COMPLETE)
Migrate dashboard API groups one at a time, cheapest first:
`usage` → `providers`/`models` → `cli-tools` → `proxy-pools`/`settings`/combos/keys.

**Security middleware — done, prerequisite for every group.** The real auth
layer is not per-route code but the Next.js 16 middleware at `src/proxy.js`
(`middleware` renamed in v16) → `src/dashboardGuard.js`: deny-by-default for
`/api/*` with a public allow-list, `LOCAL_ONLY` gates, `ALWAYS_PROTECTED`
routes, an API-key gate on the LLM surface (`canAccessPublicLlmApi`), and
dashboard page protection. `hono-server/guard.js` ports it 1:1, plus the
`custom-server.js` peer-header stamping (`x-9r-real-ip`, `x-9r-peer-token`,
`x-9r-via-proxy`, XFF stripping) that `isLocalRequest()` depends on. Verified
verdict-parity against Next direct for: 401/200/403 paths, redirect chains
(`/` → `/dashboard` → `/login`), remote-access key gate, and authed access via
JWT cookie. **While both servers run, the guard exists in two copies — any
change to `dashboardGuard.js` must be mirrored in `hono-server/guard.js`.**

**Front-proxy mode — done.** With `NEXT_UPSTREAM=http://127.0.0.1:<port>`
set, Hono owns the public port and proxies every unregistered path (unmigrated
APIs, dashboard pages, static assets) to the Next standalone instance on a
private port, with undici's stale `content-encoding`/`content-length` headers
stripped. Next's own middleware re-validates proxied requests.

**Groups migrated — ALL of them (Phase 3 complete).** `usage` (10),
`providers` (10), `models` (7), `keys` (2), `combos` (2), `proxy-pools` (6),
`settings` (4), `version` (3), `pricing` (1), `tags` (1), `init` (1),
`health` (1), `locale` (1), `translator` (6), `mcp` (2), `pxpipe` (8),
`headroom` (6), `media-providers` (5), `tunnel` (7), `auth` (11), `oauth` (14),
`cli-tools` (19), `shutdown` (1), `provider-nodes` (3) = **131 admin routes**,
on top of the 23-route proxy surface.

**Auth cookie flows — done via a `next/headers` shim.** Route files keep their
`import { cookies } from "next/headers"` untouched; the alias loader maps it
to `hono-server/shims/next-headers.mjs`, an AsyncLocalStorage-based shim whose
cookie store implements the same API (`get`/`set`/`delete`, same serialization
order and casing as the `cookie` package Next uses). The Hono adapter opens a
per-request context (`runWithRequest`) and applies pending Set-Cookie values
to the response. A minimal `next/server` shim also satisfies `dashboardGuard`
(whose middleware-only code is never executed here). Verified vs Next: login
200 + **identical Set-Cookie attributes** (`Path=/; HttpOnly; SameSite=lax`),
wrong-password 401 body parity, `/auth/status` authed/unauthed parity,
logout cookie-clearing chain, SAML/OIDC unconfigured redirects (307 → identical
login error URLs), oauth unknown-provider 401 parity.
Codemod `NextResponse.json(` → `Response.json(` + drop the `next/server`
import, register in the route table (incl. dynamic `[id]`/`[connectionId]`/
`[plugin]` routes, the EventEmitter-based `/usage/stream` SSE, and the ported
`/locale` route — its `next/headers` cookie write became a plain `Set-Cookie`
header, byte-identical to what Next emitted). Verified through the Hono front
against a production-backup import: all migrated GET endpoints
**byte-identical** to Next direct (incl. dynamic `:id` routes), and full
write-path round-trips through the shared DB (models/disabled, api keys —
create via Hono → visible to Next → delete via Hono → clean).

**Instrumentation port — done, with a Next bug found.** `register()` from
`src/instrumentation.js` now runs in the Hono server (console-log capture,
catalog override install, model-catalog sync). The parity check then exposed
that the Next standalone build **never runs its instrumentation**:
`/api/models/catalog-sync` reports `lastSync: null` on Next while Hono syncs
correctly — so Hono's model caps are refined by the models.dev catalog while
Next standalone serves unrefined static-table caps. Pre-existing Next bug;
the end-state Hono deployment is strictly better here.

**Hardening found during testing:**
- CJS files under `src/` can `require("@/…")` (e.g. `stdioSseBridge.js`) —
  ESM loader hooks don't see those, so `register.mjs` also patches
  `Module._resolveFilename` with the same alias mapping.
- An unhandled rejection (failed lazy module load mid-request) crashes Node by
  default; the server now logs and keeps serving.

Remaining groups: apply the same three steps (codemod → register → verify),
then re-run `mem-bench.mjs` to track the curve.

### 🚧 Phase 4 — Static dashboard + decommission Next (dashboard-static works; packaging remains)

Done:
- **API tree relocated**: `src/app/api` → `src/routes` (plain source files; no
  longer Next routes, so `output: "export"` is possible while Hono keeps
  loading them directly). All `@/app/api` imports and tests updated.
- **Dead deps removed**: `express`, `http-proxy-middleware` (never imported).
- **Static export**: `next.config.mjs` → `output: "export"` (rewrites and the
  proxy body-size experimental removed), `src/proxy.js` middleware deleted
  (its logic lives in `hono-server/guard.js`).
- **Page conversions for export**: dynamic pages export
  `generateStaticParams` (client components moved to their own files); the
  four machineId pages fetch `/api/machine-id` (new authed route) client-side
  instead of a server render; root page is a client redirect; console-log
  `force-dynamic` dropped; `manifest.js` forced static.
- **`hono-server/static.js`**: serves the export dir with clean-URL resolution
  (`.html`, `/index.html`) and a trim-until-shell SPA fallback — deep links
  like `/dashboard/providers/<uuid>` serve the parent shell; client
  components hydrate from the real URL.
- E2E (pure Hono, no Next process): `/`→`/dashboard`→`/login` redirect chain,
  login sets cookie, authed `/dashboard` + deep-link shells + `_next` assets
  200, `/api/machine-id` authed JSON, `/v1/models` proxy intact, unauthed
  `/api/keys` still 401. Bench unchanged: ~89–97 MB.

Remaining:
- Production packaging: Dockerfile (build static + run hono-server; drop
  standalone copy steps), `cli/` launcher (spawns hono-server instead of
  custom-server), `start.sh`/npm scripts, `cli-build-artifacts` test fixtures.
- Post-cleanup: delete `custom-server.js`, `scripts/copy-standalone-assets.mjs`,
  and the front-proxy code path once confident.

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
| `hono-server/server.js` | Entry: route table, rewrites, front-proxy (`NEXT_UPSTREAM`), serve |
| `hono-server/guard.js` | Port of Next middleware + peer-header stamping (auth backbone) |
| `hono-server/alias-loader.mjs` | Node resolve hook for `@/`, `open-sse`, CJS shim |
| `hono-server/register.mjs` | Loader registration (`--import` target) |
| `hono-server/shims/node-machine-id.mjs` | CJS→ESM interop shim |
| `scripts/mem-bench.mjs` | Warm-idle memory benchmark (`next` / `hono`) |
