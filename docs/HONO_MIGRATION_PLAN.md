# Hono Migration Plan — Proxy API on bare Node

_Status: **Phase 4 complete (2026-09-04)** — single-process Hono deployment,

## Fork features (additive, zero upstream files edited)

Pattern used for every fork feature: **new files only** plus edits to files the
fork already owns (`hono-server/*`) or one-line additive entries in shared
lists. Upstream files under `src/sse`, `open-sse`, `src/lib` stay untouched, so
`git merge upstream/master` stays conflict-free.

### Per-API-key model restrictions (2026-09-10)

Restrict which models an API key may call, enforced on the whole LLM surface.

| Piece | Path | Upstream? |
| --- | --- | --- |
| Storage (kv scope `keyModelRestrictions`) | `src/lib/db/repos/keyModelRestrictionsRepo.js` | new file |
| Management API `/api/key-models` | `src/routes/key-models/route.js` | new file |
| Enforcement | `hono-server/guard.js` (`enforceKeyModelRestrictions`) | fork-owned |
| UI `/dashboard/keys` | `src/app/(dashboard)/dashboard/keys/page.js` | new file |
| Nav entry | `src/shared/components/Sidebar.js` | +1 line |

Semantics: **exact model id match** (`sm/gpt-4.1-nano`) — no implicit provider
aliasing, so a pattern cannot silently grant access through another provider.
A trailing `*` is an explicit opt-in glob (`sm/gpt-4.1-*`). Empty list =
unrestricted. Rejected calls get `403 {code:"model_not_allowed"}` before any
provider work happens. Both body `.model` and Gemini's path form
(`/v1beta/models/<model>:action`) are checked; the body is peeked from a clone
so the handler still receives a readable body.

Enforcement lives in the guard (not in upstream `src/sse/services/auth.js`) on
purpose: it is the only file the fork owns on the hot path, and it already
runs before every `/v1` request.

## Upstream sync workflow (fork maintenance)

This fork tracks `decolua/9router` (`git remote add upstream https://github.com/decolua/9router.git`).
First proven sync: v0.5.65 → v0.5.69 (19 commits, 2026-09-07).

```bash
git fetch upstream
git checkout -b sync/upstream-vX
git merge upstream/master
# conflicts concentrate in: Dockerfile (keep ours), src/routes/** route files
#   (keep upstream logic, drop next/server imports, re-run the codemod below)
node --input-type=module -e "…codemod: strip next/server import, NextResponse.json -> Response.json across src/routes…"   # see git history
# new/changed upstream tests may reference the old path:
#   sed -i 's|src/app/api/|src/routes/|g' <test file>
cd tests && bun install && bunx vitest run --exclude '**/*.concurrent.test.js'
# regenerate version-dependent snapshots if the release bump changes User-Agent:
bunx vitest run translator/golden-url-header.test.js -u
npm run build && NINEROUTER_DISABLE_MITM=1 PORT=20128 npm start   # smoke
git checkout master && git merge --ff-only sync/upstream-vX && git push origin master
```

Workflow notes from the first run:
- **git rename detection does most of the work**: upstream edits to
  `src/app/api/**` auto-merged into the relocated `src/routes/**`. Only 2
  conflicts in 63 changed files.
- **When smoke-testing after a sync, kill the old server process
  deterministically** — `fuser -k <port>/tcp` can silently fail and the stale
  pre-merge process keeps answering on the port (masks the merge as "not
  applied"). Kill by /proc scan for node processes whose cmdline contains
  `hono-server/server.js`.
- The release bump changes `User-Agent`, so `golden-url-header` snapshots
  need `-u` regeneration once per sync.

Docker image rebuilt and E2E-verified. Remaining (optional): merge branch,
CLI smoke test on real hardware, multi-user auth feature._

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
- ~~Production packaging~~ **done** (see below).
- ~~Post-cleanup~~ **done**: `custom-server.js` and
  `scripts/copy-standalone-assets.mjs` deleted.

### ✅ Phase 4 — Packaging (Docker + CLI + custom-server removal)

- **Dependencies reclassified**: Next/React and all UI-only packages moved to
  `devDependencies` — the runtime installs hono, jose, undici,
  better-sqlite3, sql.js, etc. only (81 MB node_modules in image vs full).
- **`hono-server/peer-server.js`**: 1:1 port of `custom-server.js` (TCP-socket
  IP stamping, forwarding-header stripping, peer token, h2c downgrade) wired
  via `serve({ createServer })`. `custom-server.js` **deleted**; its security
  test rewritten against the new module (`tests/unit/peer-server-headers.test.js`).
- **`Dockerfile` rebuilt**: multi-stage — builder installs all deps and runs
  the static export; runner copies production deps + source + export
  (`COPY --from=builder`). No Next standalone, no build tools in runner.
  **522 MB (119 MB content) vs prior ~1.1 GB standalone image.**
- **Over-prerendering fix**: dynamic pages export a single placeholder shell
  (client components hydrate from the URL; Hono's static handler serves the
  shell for any param) — export shrank 78 MB → 13 MB (3.2k pages → ~40).
- **`cli/scripts/build-cli.js`** rewritten: bundles `hono-server/` + `src/` +
  `open-sse/` + the static export instead of the Next standalone; the CLI
  launcher (`cli/cli.js`) spawns hono-server via `--import register.mjs`.
- **Container E2E verified**: healthz, login page, authed dashboard +
  deep-links + provider pages, `/api/providers`, `/api/usage/stats` 200;
  unauthed `/api/keys` 401; remote `/v1/models` without key 401.
- Tests: `cli-build-artifacts.test.js` rewritten for the new bundle layout;
  `auth-status.test.js` updated off the deleted `next/server` mock;
  `custom-server-h2c`/`standalone-assets` tests removed with their subjects.
  All other failures in the suite pre-date the migration (verified via git
  stash baseline run).

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
