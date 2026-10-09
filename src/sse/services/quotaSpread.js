/**
 * Quota-spread connection selection (fork feature; ban-resistant rotation).
 *
 * Picks the Antigravity account with the most remaining quota for the
 * requested model instead of hammering one account until it hits 429.
 * Pure module — no imports — so selection rules are trivially unit-testable.
 *
 * Scoring:
 * - remaining % from the in-memory quota cache (antigravityQuota.js);
 *   unknown quota counts as 100 (an unread account is assumed healthy —
 *   the proactive poller should have filled the cache).
 * - recent `lastErrorAt` subtracts a penalty even after the cooldown lock
 *   expires, so a just-errored account is not immediately promoted again.
 *
 * Selection:
 * - reserve margin: accounts below the margin are skipped while any
 *   candidate has headroom (all-below degrades to "pick the healthiest").
 * - jitter band: candidates near the best score are interchangeable and one
 *   is chosen at random, so the rotation sequence is not deterministic.
 * - empty/unknown cache degrades to fill-first (first candidate by priority).
 */

export const QUOTA_SPREAD_DEFAULT_MARGIN_PCT = 15;
export const QUOTA_SPREAD_JITTER_BAND_PCT = 10;
export const QUOTA_SPREAD_ERROR_PENALTY_PCT = 20;
export const QUOTA_SPREAD_ERROR_PENALTY_WINDOW_MS = 10 * 60_000;

const clampPct = v => Math.max(0, Math.min(100, v));

/**
 * Effective score for one connection, or null when it must be excluded.
 * @returns {{ remaining: number, effective: number, known: boolean } | null}
 */
export function scoreQuotaSpreadConnection(connection, model, quotaCache, now = Date.now()) {
  if (!connection) return null;
  if (!model) return { remaining: 100, effective: 100, known: false };

  const quota = quotaCache?.get?.(connection.id)?.[model];
  const known = quota && Number.isFinite(quota.remainingPercentage);
  const remaining = known ? clampPct(quota.remainingPercentage) : 100;

  let effective = remaining;
  if (connection.lastErrorAt) {
    const age = now - new Date(connection.lastErrorAt).getTime();
    if (Number.isFinite(age) && age >= 0 && age < QUOTA_SPREAD_ERROR_PENALTY_WINDOW_MS) {
      effective -= QUOTA_SPREAD_ERROR_PENALTY_PCT;
    }
  }

  return { remaining, effective, known: !!known };
}

/**
 * Select one connection from an already-filtered candidate list.
 * @param {Array} availableConnections - non-empty; exclude/modelLock/quota-0% pre-filters already applied
 * @param {string|null} model - requested model id
 * @param {Map|null} quotaCache - connectionId → { [model]: { remainingPercentage, resetAt } }
 * @param {{ marginPct?: number, jitterBandPct?: number, now?: number }} [options]
 * @returns {object|null} chosen connection
 */
export function selectQuotaSpreadConnection(availableConnections, model, quotaCache, options = {}) {
  if (!Array.isArray(availableConnections) || availableConnections.length === 0) return null;

  const marginPct = options.marginPct ?? QUOTA_SPREAD_DEFAULT_MARGIN_PCT;
  const jitterBandPct = options.jitterBandPct ?? QUOTA_SPREAD_JITTER_BAND_PCT;
  const now = options.now ?? Date.now();

  const scored = availableConnections
    .map(connection => ({ connection, score: scoreQuotaSpreadConnection(connection, model, quotaCache, now) }))
    .filter(entry => entry.score !== null);

  if (scored.length === 0) return null;

  // No quota data at all (cache cold or model unknown) → true fill-first.
  if (!scored.some(entry => entry.score.known)) return availableConnections[0];

  // Reserve margin: never push an account against the wall while a
  // healthier candidate exists. All-below-margin keeps the full pool.
  const aboveMargin = scored.filter(entry => entry.score.remaining >= marginPct);
  const pool = aboveMargin.length > 0 ? aboveMargin : scored;

  let best = pool;
  const maxEffective = Math.max(...pool.map(entry => entry.score.effective));
  const band = pool.filter(entry => maxEffective - entry.score.effective <= jitterBandPct);
  if (band.length > 0) best = band;

  return best[Math.floor(Math.random() * best.length)].connection;
}
