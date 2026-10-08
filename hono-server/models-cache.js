// /v1/models response cache (fork-owned; new file, no upstream files edited).
//
// Why: buildModelsList (upstream src/routes/v1/models) makes LIVE outbound
// calls per request — fetchCompatibleModelIds hits every OpenAI/Anthropic-
// compatible provider's /models endpoint (5 s timeout each) and the
// LIVE_MODEL_RESOLVERS (kiro/qoder/kimchi/github/clinepass/grok-cli/cursor/
// zed) each do their own network round-trip, sequentially. On the production
// data set a single unrestricted GET /v1/models took ~8.4 s (network-bound,
// identical on Node and Bun).
//
// Design: response cache in front of the route, behind the guard.
//   guard (outer) → models-cache (this) → route handler
// The cache stores the UNFILTERED full catalog: restricted-key filtering
// happens per-request in the guard AFTER this middleware sees the response,
// so per-key /v1/models results stay correct on hits.
// Invalidation: explicit clear on mutating /api/providers*, /api/combos*,
// /api/models*, /api/settings requests, plus a TTL backstop (live catalogs
// change rarely; upstream already sets skipDynamicFetch for internal fetches
// and those requests bypass the cache entirely so the two variants never
// mix). Kill switch: NINEROUTER_MODELS_CACHE_TTL_MS=0.
//
// Tests: tests/unit/modelsCache.test.js.

const CACHED_PATHS = new Set(["/v1/models", "/api/v1/models"]);
export const DEFAULT_TTL_MS = 60 * 1000;

export function parseModelsCacheConfig(env = process.env) {
  const n = Number.parseInt(String(env.NINEROUTER_MODELS_CACHE_TTL_MS ?? ""), 10);
  return { ttlMs: Number.isFinite(n) ? Math.max(0, n) : DEFAULT_TTL_MS };
}

// Injectable clock/size for tests; module state otherwise (single process).
const state = {
  entry: null, // { pathname, text, storedAt }
  hits: 0,
  misses: 0,
};

export function clearModelsCache() {
  state.entry = null;
}

export function modelsCacheStats() {
  return { hits: state.hits, misses: state.misses, cached: !!state.entry };
}

function cacheable(res) {
  return (
    res &&
    res.status === 200 &&
    String(res.headers.get("content-type") || "").includes("json")
  );
}

function hitResponse(entry) {
  const headers = new Headers();
  headers.set("Content-Type", "application/json");
  headers.set("Access-Control-Allow-Origin", "*");
  headers.set("X-Cache", "HIT");
  headers.set("Cache-Control", "no-store");
  return new Response(entry.text, { status: 200, headers });
}

export function createModelsCacheMiddleware({ config = parseModelsCacheConfig(), now = Date.now } = {}) {
  return async function modelsCache(c, next) {
    const pathname = c.req.path;
    const method = c.req.method;
    const isModelsGet = method === "GET" && CACHED_PATHS.has(pathname);
    const isInvalidating =
      ["POST", "PUT", "PATCH", "DELETE"].includes(method) &&
      (pathname.startsWith("/api/providers") ||
        pathname.startsWith("/api/combos") ||
        pathname.startsWith("/api/models") ||
        pathname.startsWith("/api/settings"));

    if (config.ttlMs <= 0 || (!isModelsGet && !isInvalidating)) return next();

    if (isInvalidating) {
      await next();
      // Clear after the mutation regardless of status — cheap and safe.
      if (state.entry) clearModelsCache();
      return;
    }

    // Never cache the cross-instance internal variant (different content).
    if (c.req.raw.headers.get("x-9r-internal-models-fetch") === "1") return next();

    const entry = state.entry;
    if (entry && entry.pathname === pathname && now() - entry.storedAt < config.ttlMs) {
      state.hits += 1;
      return hitResponse(entry);
    }

    await next();
    const res = c.res;
    if (!cacheable(res)) {
      state.misses += 1;
      return;
    }
    const text = await res.text();
    state.entry = { pathname, text, storedAt: now() };
    state.misses += 1;
    const headers = new Headers(res.headers);
    headers.set("X-Cache", "MISS");
    headers.set("Cache-Control", "no-store");
    c.res = new Response(text, { status: res.status, statusText: res.statusText, headers });
  };
}

export function registerModelsCache(app, overrides = {}) {
  if (overrides.env && overrides.env.NINEROUTER_MODELS_CACHE_TTL_MS !== undefined) {
    process.env.NINEROUTER_MODELS_CACHE_TTL_MS = overrides.env.NINEROUTER_MODELS_CACHE_TTL_MS;
  }
  app.use(createModelsCacheMiddleware(overrides.config ? { config: overrides.config } : {}));
  return true;
}
