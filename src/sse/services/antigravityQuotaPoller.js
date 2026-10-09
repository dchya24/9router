/**
 * Antigravity quota poller (fork feature; ban-resistant rotation).
 *
 * Keeps the in-memory quota cache (./antigravityQuota.js) warm BEFORE any
 * request fails, so the auth.js pre-filter / quota-spread strategy always
 * works from live data instead of learning via 429s. Polls
 * fetchAvailableModels — the same endpoint the real Antigravity IDE calls
 * for its usage panel — once per interval per active account.
 *
 * Reuses refreshAntigravityQuota(): its 30s per-connection gate and in-flight
 * dedup make overlapping ticks harmless. Ticks are jittered (±15%) and
 * rescheduled recursively so slow refreshes never pile up.
 *
 * Bootstrap lives in hono-server/server.js (mirrors the retention block);
 * NINEROUTER_DISABLE_AG_QUOTA_POLLER=1 skips startup. Interval comes from
 * settings.antigravityQuotaPollIntervalMs each tick: default 180000,
 * clamped to >= MIN_POLL_INTERVAL_MS, 0 disables. Polling runs only while
 * the effective Antigravity fallback strategy is "quota-spread".
 */

import { getSettings, getProviderConnections } from "@/lib/localDb";
import { refreshAntigravityQuota } from "./antigravityQuota.js";
import * as log from "../utils/logger.js";

const MIN_POLL_INTERVAL_MS = 60_000;
const DEFAULT_POLL_INTERVAL_MS = 180_000;
const FIRST_TICK_DELAY_MS = 5_000;

let timer = null;
let running = false;

function jitteredDelay(intervalMs) {
  return Math.round(intervalMs * (0.85 + Math.random() * 0.3));
}

/**
 * One poll pass over all active Antigravity connections. Exported for
 * manual triggers and tests; safe to call concurrently (gate + dedup below).
 */
export async function runAntigravityQuotaPollTick() {
  let settings;
  try {
    settings = await getSettings();
  } catch (e) {
    log.warn("AG_QUOTA", `poll skipped; settings read failed: ${e?.message || e}`);
    return;
  }

  const providerOverride = settings.providerStrategies?.antigravity || {};
  const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";
  if (strategy !== "quota-spread") {
    log.debug("AG_QUOTA", `poll skipped; Antigravity strategy is ${strategy}`);
    return;
  }

  const connections = await getProviderConnections({ provider: "antigravity", isActive: true });
  for (const connection of connections) {
    if (!connection.accessToken) continue;
    try {
      await refreshAntigravityQuota(connection.id, connection.accessToken, connection.providerSpecificData);
    } catch (e) {
      log.warn("AG_QUOTA", `${connection.id?.slice(0, 8)} | poll refresh failed: ${e?.message || e}`);
    }
  }
  log.debug("AG_QUOTA", `poll tick done | accounts: ${connections.length}`);
}

async function tickAndReschedule() {
  let intervalMs = DEFAULT_POLL_INTERVAL_MS;
  try {
    const settings = await getSettings();
    intervalMs = Number(settings.antigravityQuotaPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  } catch (e) {
    log.warn("AG_QUOTA", `poll settings read failed, using default interval: ${e?.message || e}`);
  }

  if (!Number.isFinite(intervalMs) || intervalMs <= 0) {
    log.info("AG_QUOTA", "poller disabled (antigravityQuotaPollIntervalMs=0)");
    running = false;
    return;
  }

  try {
    await runAntigravityQuotaPollTick();
  } catch (e) {
    log.warn("AG_QUOTA", `poll tick failed: ${e?.message || e}`);
  }

  if (!running) return;
  timer = setTimeout(tickAndReschedule, jitteredDelay(Math.max(intervalMs, MIN_POLL_INTERVAL_MS)));
  if (typeof timer.unref === "function") timer.unref();
}

function startAntigravityQuotaPoller() {
  if (running) return;
  running = true;
  // First tick ~5s after enable: reads the interval, polls once, then
  // self-reschedules on the jittered loop.
  timer = setTimeout(() => {
    timer = null;
    tickAndReschedule().catch(e => {
      log.warn("AG_QUOTA", `poller failed to schedule: ${e?.message || e}`);
    });
  }, FIRST_TICK_DELAY_MS);
  if (typeof timer.unref === "function") timer.unref();
  log.info("AG_QUOTA", "poller started (warm quota cache for ban-resistant rotation)");
}

export function configureAntigravityQuotaPoller(settings = {}) {
  const providerOverride = settings.providerStrategies?.antigravity || {};
  const strategy = providerOverride.fallbackStrategy || settings.fallbackStrategy || "fill-first";
  const intervalMs = Number(settings.antigravityQuotaPollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
  const shouldRun =
    process.env.NINEROUTER_DISABLE_AG_QUOTA_POLLER !== "1" &&
    strategy === "quota-spread" &&
    Number.isFinite(intervalMs) &&
    intervalMs > 0;

  if (!shouldRun) {
    stopAntigravityQuotaPoller();
    return;
  }

  startAntigravityQuotaPoller();
}

export function stopAntigravityQuotaPoller() {
  running = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
}
