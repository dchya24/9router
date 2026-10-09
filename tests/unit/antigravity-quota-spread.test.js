import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  selectQuotaSpreadConnection,
  scoreQuotaSpreadConnection,
  QUOTA_SPREAD_DEFAULT_MARGIN_PCT,
} from "@/sse/services/quotaSpread.js";

const pollerMocks = vi.hoisted(() => ({
  getSettings: vi.fn(),
  getProviderConnections: vi.fn(),
  refreshAntigravityQuota: vi.fn(),
}));

vi.mock("@/lib/localDb", () => ({
  getSettings: pollerMocks.getSettings,
  getProviderConnections: pollerMocks.getProviderConnections,
}));
vi.mock("@/sse/services/antigravityQuota.js", () => ({
  refreshAntigravityQuota: pollerMocks.refreshAntigravityQuota,
}));
vi.mock("@/sse/utils/logger.js", () => ({
  debug: vi.fn(), info: vi.fn(), warn: vi.fn(),
}));

const { configureAntigravityQuotaPoller, stopAntigravityQuotaPoller, runAntigravityQuotaPollTick } = await import("@/sse/services/antigravityQuotaPoller.js");

const MODEL = "gemini-3.5-flash-high";
const FUTURE = "2099-01-01T00:00:00.000Z";

function quotaCacheFrom(map) {
  // Same shape as getAntigravityQuotaCache(): Map connectionId → { [model]: {...} }
  return new Map(Object.entries(map));
}

beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.999); // deterministic: pick last of band
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("scoreQuotaSpreadConnection", () => {
  it("treats unknown quota as healthy (100)", () => {
    const score = scoreQuotaSpreadConnection({ id: "a" }, MODEL, quotaCacheFrom({}));
    expect(score).toEqual({ remaining: 100, effective: 100, known: false });
  });

  it("reads remainingPercentage from the cache", () => {
    const cache = quotaCacheFrom({ a: { [MODEL]: { remainingPercentage: 42, resetAt: FUTURE } } });
    const score = scoreQuotaSpreadConnection({ id: "a" }, MODEL, cache);
    expect(score.remaining).toBe(42);
    expect(score.known).toBe(true);
  });

  it("demotes recently-errored accounts", () => {
    const now = Date.now();
    const fresh = { id: "a" };
    const errored = { id: "b", lastErrorAt: new Date(now - 60_000).toISOString() };
    expect(scoreQuotaSpreadConnection(errored, MODEL, null, now).effective)
      .toBe(100 - 20);
    expect(scoreQuotaSpreadConnection(fresh, MODEL, null, now).effective).toBe(100);
  });

  it("ignores old errors beyond the penalty window", () => {
    const now = Date.now();
    const old = { id: "b", lastErrorAt: new Date(now - 11 * 60_000).toISOString() };
    expect(scoreQuotaSpreadConnection(old, MODEL, null, now).effective).toBe(100);
  });
});

describe("selectQuotaSpreadConnection", () => {
  it("picks the account with the most remaining quota", () => {
    const cache = quotaCacheFrom({
      a: { [MODEL]: { remainingPercentage: 5 } },
      b: { [MODEL]: { remainingPercentage: 80 } },
    });
    const conns = [{ id: "a" }, { id: "b" }];
    expect(selectQuotaSpreadConnection(conns, MODEL, cache).id).toBe("b");
  });

  it("excludes accounts below the reserve margin while headroom exists", () => {
    const cache = quotaCacheFrom({
      a: { [MODEL]: { remainingPercentage: 80 } },
      b: { [MODEL]: { remainingPercentage: 5 } }, // below default 15% margin
    });
    const conns = [{ id: "a" }, { id: "b" }];
    expect(selectQuotaSpreadConnection(conns, MODEL, cache).id).toBe("a");
  });

  it("keeps the healthiest account when all are below the margin", () => {
    const cache = quotaCacheFrom({
      a: { [MODEL]: { remainingPercentage: 1 } },
      b: { [MODEL]: { remainingPercentage: 9 } },
    });
    const conns = [{ id: "a" }, { id: "b" }];
    expect(selectQuotaSpreadConnection(conns, MODEL, cache).id).toBe("b");
  });

  it("randomizes inside the jitter band", () => {
    const cache = quotaCacheFrom({
      a: { [MODEL]: { remainingPercentage: 70 } },
      b: { [MODEL]: { remainingPercentage: 65 } }, // within 10pt band
      c: { [MODEL]: { remainingPercentage: 20 } },
    });
    const conns = [{ id: "a" }, { id: "b" }, { id: "c" }];
    // random=0.999 → last index of the band (a,b)
    expect(selectQuotaSpreadConnection(conns, MODEL, cache).id).toBe("b");
    vi.spyOn(Math, "random").mockReturnValue(0.0); // first index of the band
    expect(selectQuotaSpreadConnection(conns, MODEL, cache).id).toBe("a");
  });

  it("falls back to fill-first when the cache has no data at all", () => {
    const conns = [{ id: "a" }, { id: "b" }];
    expect(selectQuotaSpreadConnection(conns, MODEL, quotaCacheFrom({})).id).toBe("a");
    expect(selectQuotaSpreadConnection(conns, MODEL, null).id).toBe("a");
  });

  it("uses fill-first semantics when no model is given", () => {
    const cache = quotaCacheFrom({
      b: { [MODEL]: { remainingPercentage: 90 } },
    });
    const conns = [{ id: "a" }, { id: "b" }];
    expect(selectQuotaSpreadConnection(conns, null, cache).id).toBe("a");
  });

  it("returns null for an empty candidate list", () => {
    expect(selectQuotaSpreadConnection([], MODEL, null)).toBeNull();
  });

  it("honors a custom margin", () => {
    const cache = quotaCacheFrom({
      a: { [MODEL]: { remainingPercentage: 18 } },
      b: { [MODEL]: { remainingPercentage: 40 } },
    });
    const conns = [{ id: "a" }, { id: "b" }];
    expect(selectQuotaSpreadConnection(conns, MODEL, cache, { marginPct: 25 }).id).toBe("b");
  });

  it("exposes the documented default margin", () => {
    expect(QUOTA_SPREAD_DEFAULT_MARGIN_PCT).toBe(15);
  });
});

describe("antigravityQuotaPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    pollerMocks.refreshAntigravityQuota.mockClear();
    pollerMocks.getSettings.mockClear();
    pollerMocks.getProviderConnections.mockClear();
    pollerMocks.getSettings.mockResolvedValue({});
    pollerMocks.getProviderConnections.mockResolvedValue([]);
    pollerMocks.refreshAntigravityQuota.mockResolvedValue({});
  });

  afterEach(() => {
    stopAntigravityQuotaPoller();
    vi.useRealTimers();
  });

  it("does not refresh quota unless quota-spread is selected", async () => {
    await runAntigravityQuotaPollTick();
    expect(pollerMocks.getProviderConnections).not.toHaveBeenCalled();
    expect(pollerMocks.refreshAntigravityQuota).not.toHaveBeenCalled();
  });

  it("refreshes every active antigravity connection when provider strategy is quota-spread", async () => {
    pollerMocks.getSettings.mockResolvedValue({ providerStrategies: { antigravity: { fallbackStrategy: "quota-spread" } } });
    pollerMocks.getProviderConnections.mockResolvedValue([
      { id: "conn-1", accessToken: "t1", providerSpecificData: {} },
      { id: "conn-2", accessToken: "t2" },
      { id: "conn-3" }, // no token → skipped
    ]);
    await runAntigravityQuotaPollTick();
    expect(pollerMocks.refreshAntigravityQuota).toHaveBeenCalledTimes(2);
    expect(pollerMocks.refreshAntigravityQuota).toHaveBeenCalledWith("conn-1", "t1", {});
    expect(pollerMocks.refreshAntigravityQuota).toHaveBeenCalledWith("conn-2", "t2", undefined);
  });

  it("inherits quota-spread from the global strategy unless Antigravity overrides it", async () => {
    pollerMocks.getSettings.mockResolvedValue({ fallbackStrategy: "quota-spread" });
    pollerMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", accessToken: "t1" }]);
    await runAntigravityQuotaPollTick();
    expect(pollerMocks.refreshAntigravityQuota).toHaveBeenCalledTimes(1);

    pollerMocks.refreshAntigravityQuota.mockClear();
    pollerMocks.getProviderConnections.mockClear();
    pollerMocks.getSettings.mockResolvedValue({
      fallbackStrategy: "quota-spread",
      providerStrategies: { antigravity: { fallbackStrategy: "fill-first" } },
    });
    await runAntigravityQuotaPollTick();
    expect(pollerMocks.getProviderConnections).not.toHaveBeenCalled();
    expect(pollerMocks.refreshAntigravityQuota).not.toHaveBeenCalled();
  });

  it("inherits the global strategy when the provider override is empty", async () => {
    pollerMocks.getSettings.mockResolvedValue({
      fallbackStrategy: "quota-spread",
      providerStrategies: { antigravity: { fallbackStrategy: "" } },
    });
    pollerMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", accessToken: "t1" }]);
    await runAntigravityQuotaPollTick();
    expect(pollerMocks.refreshAntigravityQuota).toHaveBeenCalledTimes(1);
  });

  it("fails closed when settings cannot be read", async () => {
    pollerMocks.getSettings.mockRejectedValue(new Error("settings unavailable"));
    await runAntigravityQuotaPollTick();
    expect(pollerMocks.getProviderConnections).not.toHaveBeenCalled();
    expect(pollerMocks.refreshAntigravityQuota).not.toHaveBeenCalled();
  });

  it("does not schedule a timer unless quota-spread is selected", () => {
    configureAntigravityQuotaPoller({});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("schedules a first tick ~5s after quota-spread is selected and keeps looping", async () => {
    pollerMocks.getSettings.mockResolvedValue({ providerStrategies: { antigravity: { fallbackStrategy: "quota-spread" } } });
    pollerMocks.getProviderConnections.mockResolvedValue([{ id: "conn-1", accessToken: "t1" }]);
    configureAntigravityQuotaPoller({ providerStrategies: { antigravity: { fallbackStrategy: "quota-spread" } } });
    await vi.advanceTimersByTimeAsync(5_100);
    expect(pollerMocks.refreshAntigravityQuota).toHaveBeenCalledTimes(1);
    // default interval 180s, jittered ≥85% → second tick well within 5 min
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(pollerMocks.refreshAntigravityQuota.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  it("stops polling when quota-spread is disabled", async () => {
    configureAntigravityQuotaPoller({ providerStrategies: { antigravity: { fallbackStrategy: "quota-spread" } } });
    configureAntigravityQuotaPoller({});
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pollerMocks.refreshAntigravityQuota).not.toHaveBeenCalled();
  });

  it("does not start polling when the interval is 0", async () => {
    configureAntigravityQuotaPoller({
      antigravityQuotaPollIntervalMs: 0,
      providerStrategies: { antigravity: { fallbackStrategy: "quota-spread" } },
    });
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pollerMocks.refreshAntigravityQuota).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stop clears pending ticks", async () => {
    configureAntigravityQuotaPoller({ providerStrategies: { antigravity: { fallbackStrategy: "quota-spread" } } });
    stopAntigravityQuotaPoller();
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(pollerMocks.refreshAntigravityQuota).not.toHaveBeenCalled();
  });
});
