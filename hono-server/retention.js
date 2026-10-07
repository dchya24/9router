// Usage retention service (fork-owned; new file, no upstream files edited).
//
// Upstream prunes requestDetails by count (maxRecords, default 200) but
// usageHistory grows one row per request with no expiry — on a busy gateway
// the live DB grows without bound (observed: 1.3 GB data.sqlite on a VPS,
// plus 2.2 GB of legacy pre-schema-change backups).
//
// This service deletes rows older than NINEROUTER_RETENTION_DAYS (default 90)
// from usageHistory, usageDaily, and requestDetails, then VACUUMs the DB
// only when deletions happened AND the freelist is large enough to be worth
// the full-file rewrite. Started from hono-server/server.js; disable with
// NINEROUTER_DISABLE_RETENTION=1.

export const DEFAULT_RETENTION_DAYS = 90;
export const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DEFAULT_BATCH_SIZE = 5000;
export const DEFAULT_VACUUM_MIN_FREELIST_BYTES = 64 * 1024 * 1024;
export const STARTUP_DELAY_MS = 30 * 1000;
const MIN_INTERVAL_MS = 60 * 1000;

function parsePositiveInt(raw, fallback, min, max) {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function parseRetentionConfig(env = process.env) {
  return {
    enabled: env.NINEROUTER_DISABLE_RETENTION !== "1",
    retentionDays: parsePositiveInt(env.NINEROUTER_RETENTION_DAYS, DEFAULT_RETENTION_DAYS, 1, 3650),
    intervalMs: parsePositiveInt(
      env.NINEROUTER_RETENTION_INTERVAL_MS, DEFAULT_INTERVAL_MS, MIN_INTERVAL_MS, 30 * 24 * 60 * 60 * 1000
    ),
    batchSize: parsePositiveInt(env.NINEROUTER_RETENTION_BATCH_SIZE, DEFAULT_BATCH_SIZE, 100, 20000),
    vacuum: env.NINEROUTER_RETENTION_VACUUM !== "0",
    vacuumMinFreelistBytes: parsePositiveInt(
      env.NINEROUTER_RETENTION_VACUUM_MIN_BYTES, DEFAULT_VACUUM_MIN_FREELIST_BYTES, 0, Number.MAX_SAFE_INTEGER
    ),
  };
}

function toLocalDateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function computeCutoffs(nowMs = Date.now(), retentionDays = DEFAULT_RETENTION_DAYS) {
  const cutoffMs = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  return {
    // usageHistory/requestDetails timestamps are Date.toISOString(): same
    // format compares chronologically as plain TEXT in SQLite.
    historyCutoffIso: new Date(cutoffMs).toISOString(),
    // usageDaily dateKey is a LOCAL YYYY-MM-DD (see usageRepo).
    dailyCutoffKey: toLocalDateKey(new Date(cutoffMs)),
  };
}

// Tables pruned by ISO-timestamp range, in small batches so a multi-GB table
// never holds one giant write transaction (or one giant IN list).
const ID_TABLES = ["usageHistory", "requestDetails"];

async function tableExists(adapter, table) {
  try {
    const row = adapter.get(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?`, [table]);
    return !!(row && row.name);
  } catch {
    return false;
  }
}

async function pruneIdTable(adapter, table, cutoffIso, batchSize) {
  let deleted = 0;
  for (;;) {
    let rows;
    try {
      rows = adapter.all(
        `SELECT id FROM ${table} WHERE timestamp < ? ORDER BY timestamp ASC LIMIT ?`,
        [cutoffIso, batchSize]
      );
    } catch (e) {
      return { deleted, error: e?.message || String(e) };
    }
    if (!rows || rows.length === 0) break;
    const ids = rows.map((r) => r.id);
    let changes = ids.length;
    try {
      const res = adapter.run(`DELETE FROM ${table} WHERE id IN (${ids.map(() => "?").join(",")})`, ids);
      if (res && Number.isFinite(Number(res.changes))) changes = Number(res.changes);
    } catch (e) {
      return { deleted, error: e?.message || String(e) };
    }
    deleted += changes;
    if (rows.length < batchSize) break;
  }
  return { deleted };
}

async function pruneDailyTable(adapter, cutoffKey) {
  try {
    const res = adapter.run(`DELETE FROM usageDaily WHERE dateKey < ?`, [cutoffKey]);
    const changes = res && Number.isFinite(Number(res?.changes)) ? Number(res.changes) : 0;
    return { deleted: changes };
  } catch (e) {
    return { deleted: 0, error: e?.message || String(e) };
  }
}

async function freelistBytes(adapter) {
  try {
    const free = adapter.get(`PRAGMA freelist_count`);
    const size = adapter.get(`PRAGMA page_size`);
    const pages = Number(free?.freelist_count ?? 0);
    const pageSize = Number(size?.page_size ?? 0);
    if (!Number.isFinite(pages) || !Number.isFinite(pageSize)) return 0;
    return pages * pageSize;
  } catch {
    return 0;
  }
}

export async function pruneOnce(adapter, config = parseRetentionConfig(), nowMs = Date.now()) {
  const summary = {
    usageHistory: 0, requestDetails: 0, usageDaily: 0,
    vacuumed: false, freelistBytes: 0, errors: [],
  };
  const { historyCutoffIso, dailyCutoffKey } = computeCutoffs(nowMs, config.retentionDays);

  for (const table of ID_TABLES) {
    if (!(await tableExists(adapter, table))) continue;
    const { deleted, error } = await pruneIdTable(adapter, table, historyCutoffIso, config.batchSize);
    summary[table] = deleted;
    if (error) summary.errors.push(`${table}: ${error}`);
  }

  if (await tableExists(adapter, "usageDaily")) {
    const { deleted, error } = await pruneDailyTable(adapter, dailyCutoffKey);
    summary.usageDaily = deleted;
    if (error) summary.errors.push(`usageDaily: ${error}`);
  }

  const totalDeleted = summary.usageHistory + summary.requestDetails + summary.usageDaily;
  if (config.vacuum && totalDeleted > 0) {
    summary.freelistBytes = await freelistBytes(adapter);
    if (summary.freelistBytes >= config.vacuumMinFreelistBytes) {
      try {
        try { await adapter.checkpoint?.(); } catch {}
        adapter.exec("VACUUM");
        summary.vacuumed = true;
      } catch (e) {
        summary.errors.push(`vacuum: ${e?.message || e}`);
      }
    }
  }
  return summary;
}

let timer = null;
let initialTimer = null;
let started = false;

async function defaultLoadAdapter() {
  const { getAdapter } = await import("../src/lib/db/driver.js");
  return getAdapter();
}

export function startRetention(overrides = {}) {
  if (started) return false;
  const config = overrides.config || parseRetentionConfig(overrides.env);
  if (!config.enabled) {
    console.log("[retention] disabled via NINEROUTER_DISABLE_RETENTION=1");
    return false;
  }
  const loadAdapter = overrides.loadAdapter || defaultLoadAdapter;
  const intervalMs = overrides.intervalMs ?? config.intervalMs;
  const initialDelayMs = overrides.initialDelayMs ?? STARTUP_DELAY_MS;
  started = true;

  const run = async () => {
    try {
      const adapter = await loadAdapter();
      const t0 = Date.now();
      const summary = await pruneOnce(adapter, config);
      console.log(
        `[retention] prune done in ${Date.now() - t0}ms | usageHistory -${summary.usageHistory} ` +
        `| requestDetails -${summary.requestDetails} | usageDaily -${summary.usageDaily} ` +
        `| vacuumed: ${summary.vacuumed}` +
        (summary.errors.length ? ` | errors: ${summary.errors.join("; ")}` : "")
      );
    } catch (e) {
      console.error("[retention] prune failed:", e?.message || e);
    }
  };

  initialTimer = setTimeout(() => {
    initialTimer = null;
    run().catch(() => {});
  }, initialDelayMs);
  initialTimer.unref?.();
  timer = setInterval(() => {
    run().catch(() => {});
  }, intervalMs);
  timer.unref?.();
  return true;
}

export function stopRetention() {
  if (initialTimer) { clearTimeout(initialTimer); initialTimer = null; }
  if (timer) { clearInterval(timer); timer = null; }
  started = false;
}
