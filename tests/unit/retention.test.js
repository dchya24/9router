/**
 * Usage retention service (hono-server/retention.js).
 *
 * Uses an in-memory fake adapter with the same surface the real drivers
 * expose (run/get/all/exec/transaction + optional checkpoint) so the tests
 * run without SQLite, a data dir, or env side effects.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  parseRetentionConfig,
  computeCutoffs,
  pruneOnce,
  startRetention,
  stopRetention,
  DEFAULT_RETENTION_DAYS,
} from "../../hono-server/retention.js";

const NOW = Date.parse("2026-09-18T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const isoAgo = (days) => new Date(NOW - days * DAY).toISOString();
const keyAgo = (days) => {
  const d = new Date(NOW - days * DAY);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};

function makeFakeAdapter({ tables = ["usageHistory", "requestDetails", "usageDaily"], freelistBytes = 0 } = {}) {
  const rows = {
    usageHistory: [
      { id: 1, timestamp: isoAgo(120) },
      { id: 2, timestamp: isoAgo(100) },
      { id: 3, timestamp: isoAgo(10) },
      { id: 4, timestamp: isoAgo(1) },
    ],
    requestDetails: [
      { id: "old", timestamp: isoAgo(200) },
      { id: "new", timestamp: isoAgo(2) },
    ],
    usageDaily: [
      { dateKey: keyAgo(120), data: "{}" },
      { dateKey: keyAgo(5), data: "{}" },
    ],
  };
  const calls = { exec: [], run: [] };
  return {
    rows,
    calls,
    get(sql, params = []) {
      if (/sqlite_master/.test(sql)) {
        const name = params[0];
        return tables.includes(name) ? { name } : undefined;
      }
      if (/freelist_count/.test(sql)) return { freelist_count: Math.floor(freelistBytes / 4096) };
      if (/page_size/.test(sql)) return { page_size: 4096 };
      return undefined;
    },
    all(sql, params = []) {
      const m = sql.match(/FROM (\w+)/);
      if (!m) return [];
      const table = m[1];
      if (!tables.includes(table)) throw new Error(`no such table: ${table}`);
      const cutoff = params[0];
      return rows[table]
        .filter((r) => r.timestamp < cutoff)
        .sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1))
        .slice(0, params[1])
        .map((r) => ({ id: r.id }));
    },
    run(sql, params = []) {
      calls.run.push(sql);
      if (/DELETE FROM usageDaily/.test(sql)) {
        const before = rows.usageDaily.length;
        rows.usageDaily = rows.usageDaily.filter((r) => !(r.dateKey < params[0]));
        return { changes: before - rows.usageDaily.length };
      }
      const m = sql.match(/DELETE FROM (\w+)/);
      const ids = new Set(params);
      const before = rows[m[1]].length;
      rows[m[1]] = rows[m[1]].filter((r) => !ids.has(r.id));
      return { changes: before - rows[m[1]].length };
    },
    exec(sql) {
      calls.exec.push(sql);
      if (/VACUUM/.test(sql)) freelistBytes = 0;
    },
    checkpoint: vi.fn(),
  };
}

const config = (overrides = {}) => ({
  enabled: true,
  retentionDays: 90,
  intervalMs: 24 * 60 * 60 * 1000,
  batchSize: 5000,
  vacuum: true,
  vacuumMinFreelistBytes: 64 * 1024 * 1024,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  stopRetention();
  vi.useRealTimers();
  vi.resetModules();
});

describe("parseRetentionConfig", () => {
  it("defaults to 90 days, enabled, vacuum on", () => {
    const c = parseRetentionConfig({});
    expect(c).toMatchObject({
      enabled: true,
      retentionDays: 90,
      vacuum: true,
      vacuumMinFreelistBytes: 64 * 1024 * 1024,
    });
  });

  it("honors env overrides and the disable flag", () => {
    const c = parseRetentionConfig({
      NINEROUTER_DISABLE_RETENTION: "1",
      NINEROUTER_RETENTION_DAYS: "30",
      NINEROUTER_RETENTION_VACUUM: "0",
    });
    expect(c.enabled).toBe(false);
    expect(c.retentionDays).toBe(30);
    expect(c.vacuum).toBe(false);
  });

  it("clamps garbage to safe values", () => {
    const c = parseRetentionConfig({
      NINEROUTER_RETENTION_DAYS: "abc",
      NINEROUTER_RETENTION_BATCH_SIZE: "-5",
    });
    expect(c.retentionDays).toBe(DEFAULT_RETENTION_DAYS);
    expect(c.batchSize).toBe(100);
  });
});

describe("computeCutoffs", () => {
  it("derives ISO + local-date cutoffs from retention days", () => {
    const { historyCutoffIso, dailyCutoffKey } = computeCutoffs(NOW, 90);
    expect(historyCutoffIso).toBe(new Date(NOW - 90 * DAY).toISOString());
    expect(dailyCutoffKey).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("pruneOnce", () => {
  it("deletes rows older than the cutoff, keeps recent rows", async () => {
    const adapter = makeFakeAdapter();
    const summary = await pruneOnce(adapter, config(), NOW);
    expect(summary.usageHistory).toBe(2);
    expect(summary.requestDetails).toBe(1);
    expect(summary.usageDaily).toBe(1);
    expect(adapter.rows.usageHistory.map((r) => r.id)).toEqual([3, 4]);
    expect(adapter.rows.requestDetails.map((r) => r.id)).toEqual(["new"]);
  });

  it("skips missing tables without error", async () => {
    const adapter = makeFakeAdapter({ tables: ["usageHistory"] });
    const summary = await pruneOnce(adapter, config(), NOW);
    expect(summary.usageHistory).toBe(2);
    expect(summary.requestDetails).toBe(0);
    expect(summary.usageDaily).toBe(0);
    expect(summary.errors).toEqual([]);
  });

  it("batches deletes for large tables", async () => {
    const adapter = makeFakeAdapter();
    adapter.rows.usageHistory = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      timestamp: isoAgo(100),
    }));
    const summary = await pruneOnce(adapter, config({ batchSize: 5 }), NOW);
    expect(summary.usageHistory).toBe(12);
    expect(adapter.rows.usageHistory).toEqual([]);
  });

  it("vacuums only when deletions happened and freelist is large", async () => {
    const big = makeFakeAdapter({ freelistBytes: 100 * 1024 * 1024 });
    const s1 = await pruneOnce(big, config(), NOW);
    expect(s1.vacuumed).toBe(true);
    expect(big.calls.exec).toContain("VACUUM");

    const small = makeFakeAdapter({ freelistBytes: 1024 });
    const s2 = await pruneOnce(small, config(), NOW);
    expect(s2.vacuumed).toBe(false);
    expect(small.calls.exec).not.toContain("VACUUM");

    const fresh = makeFakeAdapter({ freelistBytes: 100 * 1024 * 1024 });
    fresh.rows.usageHistory = [{ id: 1, timestamp: isoAgo(1) }];
    fresh.rows.requestDetails = [{ id: "n", timestamp: isoAgo(1) }];
    fresh.rows.usageDaily = [{ dateKey: keyAgo(1), data: "{}" }];
    const s3 = await pruneOnce(fresh, config(), NOW);
    expect(s3.usageHistory).toBe(0);
    expect(s3.vacuumed).toBe(false);
  });

  it("collects errors instead of throwing on adapter failure", async () => {
    const adapter = makeFakeAdapter();
    adapter.run = () => {
      throw new Error("db locked");
    };
    const summary = await pruneOnce(adapter, config({ vacuum: false }), NOW);
    expect(summary.errors.length).toBeGreaterThan(0);
  });
});

describe("startRetention", () => {
  it("returns false once, and when disabled", () => {
    expect(startRetention({ config: config({ enabled: false }), loadAdapter: async () => makeFakeAdapter() })).toBe(false);
    expect(startRetention({ config: config(), loadAdapter: async () => makeFakeAdapter() })).toBe(true);
    expect(startRetention({ config: config(), loadAdapter: async () => makeFakeAdapter() })).toBe(false);
  });

  it("runs the first prune after the startup delay and logs a summary", async () => {
    const logs = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...a) => logs.push(a.join(" ")));
    try {
      const adapter = makeFakeAdapter();
      startRetention({ config: config(), loadAdapter: async () => adapter, initialDelayMs: 1000 });
      expect(adapter.rows.usageHistory).toHaveLength(4);
      await vi.advanceTimersByTimeAsync(1000);
      expect(adapter.rows.usageHistory).toHaveLength(2);
      expect(logs.some((l) => /\[retention\] prune done/.test(l))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it("uses unref timers so retention never pins the process", async () => {
    const realSetInterval = global.setInterval;
    const seen = [];
    vi.spyOn(global, "setInterval").mockImplementation(((fn, ms, ...rest) => {
      const t = realSetInterval(fn, ms, ...rest);
      seen.push(typeof t.unref === "function");
      return t;
    }));
    try {
      startRetention({ config: config(), loadAdapter: async () => makeFakeAdapter(), initialDelayMs: 1000 });
      expect(seen).toEqual([true]);
    } finally {
      global.setInterval.mockRestore();
    }
  });
});
