# Bench: stock 9router vs Hono fork — simultaneous A/B on a clean VPS (2026-10-07)

First controlled apples-to-apples memory comparison. Previous datapoints compared
against either local fresh benches (sub-MB data dir) or the crowded production
VPS (`docs/MEMORY_OPTIMIZATION.md` §9) — this one removes both confounders by
running **both apps simultaneously on the same box with the same data**.

## Design

- **Box:** fresh Tencent Cloud VPS "vpsdeen" (Singapore), Ubuntu 24.04, 2 vCPU
  (AMD EPYC 7K62), 3.7 GB RAM, 1.9 GB swap. Nothing else installed.
- **Data:** consistent snapshot of the production DB (VPS "vpsdell", ~290 MB
  effective datapoint in §9) taken via `VACUUM INTO` from a read-only
  `node:sqlite` connection (601 MB compacted, md5-verified after transfer).
  Two identical copies — one per leg. Excludes the 2.2 GB legacy `backups/`.
- **Node:** v22.22.2 via nvm on both legs (same as production).
- **Legs, run simultaneously (default env, no disable-gates on either):**
  - **stock** = upstream `decolua/9router` tag `v0.5.69` installed from npm,
    launched exactly like production: `9router --tray --skip-update -p 20128
    --host 127.0.0.1` → 2 processes (cli tray wrapper + `next-server v16.3.4`).
  - **fork** = this repo at `da47ed1a` (retention commit), built with
    `NEXT_EXPORT=1 npm run build`, launched `DATA_DIR=… PORT=20129
    HOST=127.0.0.1 node --import ./hono-server/register.mjs
    hono-server/server.js` → 1 process.
- **Load:** 1.5 req/s per leg for 30 min, safe endpoints only (no provider
  calls): `/v1/models` (Bearer key, exercises guard + model filtering),
  `/api/providers` (authed DB read), `/` (dashboard shell). All 200/307.
- **Sampling:** every 10 s from `/proc/<pid>/status`: VmRSS, VmSWAP, VmHWM.
  Idle 60 min, load 30 min. Analysis drops the first 300 s of each phase
  (warm-up). Raw data: `docs/bench-data/samples-{idle,load}.csv`.

## Results (RSS, MB)

| Phase | Leg | p20 | p50 | p80 | max | swap max |
|-------|-----|-----|-----|-----|-----|----------|
| idle (55 min) | stock (2 procs) | 184.0 | 184.0 | 184.0 | 184.0 | 0 |
| idle (55 min) | **fork (1 proc)** | **117.9** | **117.9** | **118.7** | **118.7** | 0 |
| load (25 min) | stock (2 procs) | 190.7 | 193.1 | 195.0 | 200.8 | 0 |
| load (25 min) | **fork (1 proc)** | **134.7** | **136.0** | **138.2** | **147.1** | 0 |

Per-process peak (VmHWM max across the leg): stock 150.3 MB (next-server, at
boot), fork 138.3 MB idle / 147.1 MB under load.

**Deltas:** idle −65.8 MB (fork 36 % lighter, 1.56× ratio); load p50 −57.1 MB
(30 % lighter). Stock's idle RSS is dead flat (184.0 across all 328 samples);
fork breathes between 117.9–118.7.

## Context vs earlier datapoints

- Local fresh benches (§8, sub-MB data dir): hono default-env ~102 MB, gated
  89.8 MB. Here fork idle is 117.9 MB — the +16–28 MB is the real 601 MB
  production DB's SQLite page cache, which is exactly the comparison we wanted.
- Production VPS (§9): stock v0.5.65 ≈ 290 MB total (incl. 52 MB tray wrapper,
  14-day uptime, crowded 2 GB host, ~18 MB swap). Bench stock fresh is
  184–200 MB — consistent with stock growing with uptime; the §9 datapoint
  remains the "real-world after 14 days" reference, not replaced by this.

## Caveats

- The fork's retention service pruned its DB copy at first boot
  (`usageHistory −13,546` rows > 90 days). Both copies were identical before
  that; the pruned rows are a few MB at most — no material effect.
- Stock leg is a fresh boot, not a 14-day-old process — the benchmark measures
  steady-state fresh RSS, not aged growth (see §9 for the aged datapoint).
- Stock runs a tray-wrapper CLI process (58 MB, part of its architecture);
  the fork eliminated that layer — counting both processes is the point.
- `NINEROUTER_DISABLE_*` gates were NOT set on the fork (default env, parity
  with stock's default env). Gated numbers from §8 are not comparable to this.

## Reproduce

```bash
# snapshot prod DB read-only (no writes to source)
node -e 'import("node:sqlite").then(async ({DatabaseSync}) => {
  const db = new DatabaseSync(process.env.HOME + "/.9router/db/data.sqlite", { readOnly: true });
  db.exec("VACUUM INTO '"'"'/tmp/bench-data.sqlite'"'"'"); })'
# legs (after npm i -g 9router@0.5.69, and building the fork)
9router --tray --skip-update -p 20128 --host 127.0.0.1          # stock, ~/.9router
DATA_DIR=$HOME/bench/data-fork PORT=20129 HOST=127.0.0.1 \
  node --import ./hono-server/register.mjs hono-server/server.js  # fork
```

Sampler + analyzer: `docs/bench-data/` (CSV columns: `ts,leg,pid,rss_kb,swap_kb,hwm_kb`;
filter to the three app pids — sampler bash launchers can appear in the CSV).
