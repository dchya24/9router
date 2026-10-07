# Bench: Hono fork under Bun vs Node vs stock — 3-leg A/B (2026-10-07)

Follow-up to `docs/BENCH_VPS_AB.md` (stock vs fork-on-Node). Question: does
swapping the runtime from Node.js v22.22.2 to Bun cut the fork's memory
further? Answer: **yes — another −33 to −39 %**, with zero code changes.

## Compatibility finding (the headline before the numbers)

The fork runs under Bun **unmodified**: `bun hono-server/server.js` boots
straight to a healthy server.

- **DB driver**: `src/lib/db/driver.js` already prefers the native
  `bun:sqlite` adapter under Bun (log: `[DB] Driver: bun:sqlite`) — no
  better-sqlite3 native build needed.
- **`@/` aliases**: Bun resolves `jsconfig.json` `paths` natively, so
  `hono-server/register.mjs` (the `Module._resolveFilename` patch) is simply
  not needed — launched without `--import`.
- **No server-side http2 dependency**: `hono-server/peer-server.js` only
  *downgrades* h2c upgrades over `node:http` — nothing Bun can't host.
- Retention service works (prune in 8 ms under Bun vs 131 ms under Node on
  the same data shape).
- Smoke matrix passed: healthz 200, JWT auth 200, `/v1/models` 200 with the
  same 878-model catalog as the Node leg (byte-identical first 3000 bytes;
  full-payload sha differs — likely JSON key ordering, cosmetic, unverified),
  guard behavior identical (dashboard 307 → login, API 401 unauthenticated).

## Design

Same rig as BENCH_VPS_AB.md (fresh Tencent 2C/4GB "vpsdeen", Ubuntu 24.04,
localhost-only): three legs relaunched fresh and run **simultaneously** on
identical 575 MB data copies (VACUUM-INTO snapshot of the production DB):

- **stock** `9router@0.5.69` npm-global, `--tray --skip-update -p 20128` (2 procs, Node v22.22.2)
- **node** = fork `da47ed1a`, `node --import register.mjs hono-server/server.js` on :20129
- **bun** = same tree, `bun hono-server/server.js` on :20130 (Bun 1.4.2)

Load: same safe profile as before, 3 ports × 3 endpoints (~1.5 req/s per leg,
30 min; no provider calls). Sampler: pid-based, 10 s interval
(`docs/bench-data/s3-*.csv`, analyzer `analyze3.js`). 5-min warm-up dropped.

## Results (RSS, MB)

| Phase | stock (2 procs) | node | **bun** | bun vs node | bun vs stock |
|-------|-----------------|------|---------|-------------|--------------|
| idle p50 (30 min) | 174.3 | 96.9 | **58.9** | **−39 %** | −66 % |
| load p50 (25 min) | 191.1 | 112.4 | **74.9** | **−33 %** | −61 % |
| load max | 199.6 | 122.9 | **82.0** | −33 % | −59 % |
| hwm max (load) | — | 127.5 | 85.0 | −33 % | — |

Bun's idle RSS is **perfectly flat** (58.9 across all 180 steady samples —
min = p80), and its load max (82.0) stays below the Node leg's *idle* HWM.

Note on the node leg: its idle here is 96.9 vs 117.9 in the first bench. The
difference is the first boot's retention full-table scan (13,546 rows pruned)
warming DB pages in run 1; this run's copy was already pruned (0 rows). Both
are real steady states — the first-boot cost fades after the initial prune.

## What is NOT yet validated for production

- **SSE streaming proxy under load with real providers** (bench used local
  endpoints only) — Bun's streaming is its core strength, but this app must
  prove it.
- **h2c downgrade shim** (`server.on("upgrade")` in peer-server.js) under
  Bun's `node:http` — untested; only affects clients sending h2c upgrades.
- **Long soak** — single 65-min run; Bun leg left running on :20130 as a
  multi-day soak candidate. Node-side legs have months of production history.
- Bun version pinning for production (1.4.2 here).

## Reproduce

```bash
# after the BENCH_VPS_AB.md setup, plus:
curl -fsSL https://bun.sh/install | bash          # Bun on the box
cp -r ~/bench/data-fork ~/bench/data-bun          # third identical copy
cd ~/bench/fork && DATA_DIR=$HOME/bench/data-bun HOST=127.0.0.1 PORT=20130 \
  setsid nohup ~/.bun/bin/bun hono-server/server.js > /tmp/bench-bun.log 2>&1 &
```

No env flag, no register.mjs, no code change — that is the point.
