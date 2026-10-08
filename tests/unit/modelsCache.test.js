/**
 * /v1/models response cache (hono-server/models-cache.js).
 *
 * Exercises the middleware through a minimal Hono-shaped harness: an outer
 * middleware stands in for the guard (post-next response mutation, like the
 * restricted-key models filter), the route handler builds a JSON payload.
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  createModelsCacheMiddleware,
  clearModelsCache,
  modelsCacheStats,
  parseModelsCacheConfig,
  DEFAULT_TTL_MS,
} from "../../hono-server/models-cache.js";

function makeHarness({ ttlMs = DEFAULT_TTL_MS, routePayload, routeStatus = 200 } = {}) {
  const calls = { route: 0, outerPost: 0 };
  const cache = createModelsCacheMiddleware({ config: { ttlMs } });
  const outer = async (c, next) => {
    await next();
    calls.outerPost += 1;
    // Stand-in for the guard's restricted-key models filter: parse + rewrite.
    const ct = c.res.headers.get("content-type") || "";
    if (ct.includes("json") && c.res.status === 200 && c.req.headers.get("x-restricted") === "1") {
      const xCache = c.res.headers.get("x-cache");
      const body = await c.res.json();
      body.data = body.data.filter((m) => m.id.startsWith("ok/"));
      const headers = { "Content-Type": "application/json" };
      if (xCache) headers["X-Cache"] = xCache;
      c.res = new Response(JSON.stringify(body), { status: 200, headers });
    }
  };
  const route = async (c) => {
    calls.route += 1;
    if (routeStatus !== 200) return new Response("boom", { status: routeStatus });
    return new Response(JSON.stringify(routePayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };
  const app = { outer, cache, route };
  return {
    calls,
    async get(path, { internalHeader = false, restricted = false } = {}) {
      const headers = new Headers();
      if (internalHeader) headers.set("x-9r-internal-models-fetch", "1");
      if (restricted) headers.set("x-restricted", "1");
      const c = {
        req: { path, method: "GET", raw: { headers }, headers },
        res: null,
      };
      // Composition mirrors registration order: outer(guard) → cache → route.
      // Hono assigns a handler's returned Response to c.res; a middleware's
      // returned Response overrides whatever is in c.res.
      await outer(c, async () => {
        const fromCache = await cache(c, async () => {
          const rr =
            path === "/v1/models" || path === "/api/v1/models"
              ? await route(c)
              : new Response("not found", { status: 404 });
          c.res = rr;
          return rr;
        });
        if (fromCache) c.res = fromCache;
      });
      const body = c.res ? await c.res.clone().text() : null;
      return { status: c.res?.status, body, xCache: c.res?.headers.get("x-cache") };
    },
    async mutate(path) {
      const c = { req: { path, method: "POST", raw: { headers: new Headers() } }, res: null };
      let result;
      await cache(c, async () => {
        result = new Response("{}");
      });
      return result.status;
    },
  };
}

const PAYLOAD = { object: "list", data: [{ id: "ok/m1" }, { id: "other/m2" }] };

describe("models cache config", () => {
  it("defaults to 60 s and honours the env override", () => {
    expect(parseModelsCacheConfig({}).ttlMs).toBe(DEFAULT_TTL_MS);
    expect(parseModelsCacheConfig({ NINEROUTER_MODELS_CACHE_TTL_MS: "5000" }).ttlMs).toBe(5000);
    expect(parseModelsCacheConfig({ NINEROUTER_MODELS_CACHE_TTL_MS: "0" }).ttlMs).toBe(0);
    expect(parseModelsCacheConfig({ NINEROUTER_MODELS_CACHE_TTL_MS: "junk" }).ttlMs).toBe(DEFAULT_TTL_MS);
  });
});

describe("models cache middleware", () => {
  beforeEach(() => clearModelsCache());

  it("miss then hit on the same path, route called once", async () => {
    const h = makeHarness({ routePayload: PAYLOAD });
    const r1 = await h.get("/v1/models");
    expect(r1.status).toBe(200);
    expect(r1.xCache).toBe("MISS");
    const r2 = await h.get("/v1/models");
    expect(r2.xCache).toBe("HIT");
    expect(r2.body).toBe(r1.body);
    expect(h.calls.route).toBe(1);
    // The other surface is cached independently.
    await h.get("/api/v1/models");
    expect(h.calls.route).toBe(2);
  });

  it("serves fresh entries after TTL expiry", async () => {
    let t = 1_000_000;
    const cache = createModelsCacheMiddleware({ config: { ttlMs: 1000 }, now: () => t });
    const c = { req: { path: "/v1/models", method: "GET", raw: { headers: new Headers() } }, res: null };
    let routeCalls = 0;
    const run = async () => {
      const fromCache = await cache(c, async () => {
        routeCalls += 1;
        const rr = new Response(JSON.stringify(PAYLOAD), { status: 200, headers: { "Content-Type": "application/json" } });
        c.res = rr;
        return rr;
      });
      if (fromCache) c.res = fromCache;
      return c.res.clone().text();
    };
    await run();
    t += 999;
    expect(await run()).toBeTruthy();
    expect(routeCalls).toBe(1); // still fresh
    t += 2;
    await run();
    expect(routeCalls).toBe(2); // expired → refetch
  });

  it("outer guard still rewrites hits (restricted-key filtering works on cache)", async () => {
    const h = makeHarness({ routePayload: PAYLOAD });
    const full = await h.get("/v1/models");
    expect(JSON.parse(full.body).data).toHaveLength(2);
    const filtered = await h.get("/v1/models", { restricted: "1" });
    expect(filtered.xCache).toBe("HIT");
    const ids = JSON.parse(filtered.body).data.map((m) => m.id);
    expect(ids).toEqual(["ok/m1"]);
  });

  it("skips caching for internal cross-instance fetches", async () => {
    const h = makeHarness({ routePayload: PAYLOAD });
    await h.get("/v1/models", { internalHeader: true });
    await h.get("/v1/models", { internalHeader: true });
    expect(h.calls.route).toBe(2); // never cached
    const normal = await h.get("/v1/models");
    expect(normal.xCache).toBe("MISS"); // internal variant did not poison the cache
  });

  it("does not cache non-200 or non-JSON responses", async () => {
    const h = makeHarness({ routePayload: PAYLOAD, routeStatus: 500 });
    await h.get("/v1/models");
    await h.get("/v1/models");
    expect(h.calls.route).toBe(2);
    const ok = makeHarness({ routePayload: PAYLOAD });
    await ok.get("/v1/models");
    const again = await ok.get("/v1/models");
    expect(again.xCache).toBe("HIT");
  });

  it("invalidates on mutating provider/combo/models/settings requests", async () => {
    const h = makeHarness({ routePayload: PAYLOAD });
    await h.get("/v1/models");
    await h.mutate("/api/providers");
    let r = await h.get("/v1/models");
    expect(r.xCache).toBe("MISS");
    await h.get("/v1/models");
    await h.mutate("/api/combos/xyz");
    r = await h.get("/v1/models");
    expect(r.xCache).toBe("MISS");
    await h.get("/v1/models");
    await h.mutate("/api/models/alias");
    r = await h.get("/v1/models");
    expect(r.xCache).toBe("MISS");
    await h.get("/v1/models");
    await h.mutate("/api/settings");
    r = await h.get("/v1/models");
    expect(r.xCache).toBe("MISS");
    await h.get("/v1/models");
    await h.mutate("/api/keys"); // unrelated mutation keeps the cache
    r = await h.get("/v1/models");
    expect(r.xCache).toBe("HIT");
  });

  it("ttl 0 disables the cache entirely", async () => {
    const h = makeHarness({ ttlMs: 0 });
    await h.get("/v1/models");
    await h.get("/v1/models");
    expect(h.calls.route).toBe(2);
  });

  it("stats track hits/misses", async () => {
    clearModelsCache();
    const h = makeHarness({ routePayload: PAYLOAD });
    const before = modelsCacheStats();
    await h.get("/v1/models");
    await h.get("/v1/models");
    const s = modelsCacheStats();
    expect(s.hits - before.hits).toBe(1);
    expect(s.misses - before.misses).toBe(1);
    expect(s.cached).toBe(true);
  });
});
