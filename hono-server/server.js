#!/usr/bin/env node
// 9Router proxy surface on Hono + bare Node (Fase 2 spike).
//
// Design: instead of duplicating route logic, this server imports the original
// Next route modules from src/app/api/** and calls their exported handlers
// (POST/GET/OPTIONS). Every migrated route file must stay Web-API-only:
//   - receives (Request, { params: Promise<object> })   (Next 15 signature)
//   - returns a standard Response (streaming included)
// Handlers may keep using next/headers cookies()/headers() later — the hybrid
// invocation context preserves it; on bare Node those routes are not imported.
//
// Not yet ported from custom-server.js (no proxy surface depends on them):
//   - x-9r-real-ip / peer-token header stamping (needed when auth routes move)
//   - h2c upgrade downgrade
//   - 128mb proxyClientMaxBodySize (Hono imposes no body limit)
//
// Env: PORT (default 20127), HOST (default 0.0.0.0), DATA_DIR.

import { serve } from "@hono/node-server";
import { Hono } from "hono";

const PORT = Number(process.env.PORT || 20127);
const HOST = process.env.HOST || "0.0.0.0";

const app = new Hono();

// ─── Lazy route module loading (mirrors Next's per-route lazy bundles) ──────
const modCache = new Map();

function loaderFor(baseDir) {
  return (rel) => {
    const key = `${baseDir}${rel}`;
    if (!modCache.has(key)) {
      modCache.set(key, import(new URL(`../src/app/api/${baseDir}${rel}`, import.meta.url).href));
    }
    return modCache.get(key);
  };
}
const v1 = loaderFor("v1");
const v1beta = loaderFor("v1beta");

// Adapts a Next route handler to a Hono handler.
// opts.catchAll: param name receiving path segments after catchAllPrefix.
// opts.id: single dynamic param passed through.
function on(method, modLoader, opts = {}) {
  return async (c) => {
    const mod = await modLoader();
    const fn = mod[method];
    if (typeof fn !== "function") {
      return c.json({ error: `Method ${method} not allowed` }, 405);
    }
    const params = {};
    if (opts.id) params[opts.id] = c.req.param(opts.id);
    if (opts.catchAll) {
      const rest = c.req.path.startsWith(opts.catchAllPrefix)
        ? c.req.path.slice(opts.catchAllPrefix.length)
        : c.req.path;
      params[opts.catchAll] = rest.split("/").filter(Boolean);
    }
    return fn(c.req.raw, { params: Promise.resolve(params) });
  };
}

function register(prefix, routes) {
  for (const [method, path, mod, opts] of routes) {
    app.on(method, prefix + path, on(method, mod, opts));
  }
}

const V1_ROUTES = [
  ["OPTIONS", "/chat/completions", () => v1("/chat/completions/route.js")],
  ["POST", "/chat/completions", () => v1("/chat/completions/route.js")],
  ["OPTIONS", "/messages", () => v1("/messages/route.js")],
  ["POST", "/messages", () => v1("/messages/route.js")],
  ["OPTIONS", "/messages/count_tokens", () => v1("/messages/count_tokens/route.js")],
  ["POST", "/messages/count_tokens", () => v1("/messages/count_tokens/route.js")],
  ["OPTIONS", "/models", () => v1("/models/route.js")],
  ["GET", "/models", () => v1("/models/route.js")],
  ["OPTIONS", "/models/info", () => v1("/models/info/route.js")],
  ["GET", "/models/info", () => v1("/models/info/route.js")],
  // /models/{kind} and /models/{provider}/{model} — Next [...model] catch-all
  ["GET", "/models/*", () => v1("/models/[...model]/route.js"), {
    catchAll: "model",
    catchAllPrefix: null, // filled per-prefix below
  }],
  ["OPTIONS", "/responses", () => v1("/responses/route.js")],
  ["POST", "/responses", () => v1("/responses/route.js")],
  ["OPTIONS", "/responses/compact", () => v1("/responses/compact/route.js")],
  ["POST", "/responses/compact", () => v1("/responses/compact/route.js")],
  ["OPTIONS", "/embeddings", () => v1("/embeddings/route.js")],
  ["POST", "/embeddings", () => v1("/embeddings/route.js")],
  ["OPTIONS", "/search", () => v1("/search/route.js")],
  ["POST", "/search", () => v1("/search/route.js")],
  ["OPTIONS", "/images/generations", () => v1("/images/generations/route.js")],
  ["POST", "/images/generations", () => v1("/images/generations/route.js")],
  ["OPTIONS", "/audio/speech", () => v1("/audio/speech/route.js")],
  ["POST", "/audio/speech", () => v1("/audio/speech/route.js")],
  ["OPTIONS", "/audio/transcriptions", () => v1("/audio/transcriptions/route.js")],
  ["POST", "/audio/transcriptions", () => v1("/audio/transcriptions/route.js")],
  ["OPTIONS", "/audio/voices", () => v1("/audio/voices/route.js")],
  ["GET", "/audio/voices", () => v1("/audio/voices/route.js")],
  ["OPTIONS", "/videos/generations", () => v1("/videos/generations/route.js")],
  ["POST", "/videos/generations", () => v1("/videos/generations/route.js")],
  ["OPTIONS", "/videos/edits", () => v1("/videos/edits/route.js")],
  ["POST", "/videos/edits", () => v1("/videos/edits/route.js")],
  ["OPTIONS", "/videos/extensions", () => v1("/videos/extensions/route.js")],
  ["POST", "/videos/extensions", () => v1("/videos/extensions/route.js")],
  ["OPTIONS", "/videos/:id", () => v1("/videos/[id]/route.js")],
  ["GET", "/videos/:id", () => v1("/videos/[id]/route.js"), { id: "id" }],
  // Ollama-compatible endpoint (also reachable via /v1/v1/* rewrite below)
  ["OPTIONS", "/api/chat", () => v1("/api/chat/route.js")],
  ["POST", "/api/chat", () => v1("/api/chat/route.js")],
  // /api/v1 root re-exports the models list (src/app/api/v1/route.js)
  ["OPTIONS", "/", () => v1("/route.js")],
  ["GET", "/", () => v1("/route.js")],
];

const V1BETA_ROUTES = [
  ["OPTIONS", "/models", () => v1beta("/models/route.js")],
  ["GET", "/models", () => v1beta("/models/route.js")],
  // Gemini native: /v1beta/models/{model}:generateContent|:streamGenerateContent
  ["OPTIONS", "/models/*", () => v1beta("/models/[...path]/route.js"), {
    catchAll: "path",
    catchAllPrefix: null,
  }],
  ["POST", "/models/*", () => v1beta("/models/[...path]/route.js"), {
    catchAll: "path",
    catchAllPrefix: null,
  }],
];

// Register under both the canonical /api/* surface and the rewritten /v1 surface
// (Next's rewrites: /v1/:path* → /api/v1/:path*).
for (const [prefix, routes, catchAllPrefix] of [
  ["/api/v1", V1_ROUTES, "/api/v1/models"],
  ["/v1", V1_ROUTES, "/v1/models"],
]) {
  const resolved = routes.map(([m, p, mod, opts]) =>
    opts && opts.catchAll
      ? [m, p, mod, { ...opts, catchAllPrefix }]
      : [m, p, mod]
  );
  register(prefix, resolved);
}
for (const [prefix, routes, catchAllPrefix] of [
  ["/api/v1beta", V1BETA_ROUTES, "/api/v1beta/models"],
  ["/v1beta", V1BETA_ROUTES, "/v1beta/models"],
]) {
  const resolved = routes.map(([m, p, mod, opts]) =>
    opts && opts.catchAll
      ? [m, p, mod, { ...opts, catchAllPrefix }]
      : [m, p, mod]
  );
  register(prefix, resolved);
}

// ─── Remaining Next rewrites, via internal re-dispatch ──────────────────────
async function redispatch(c, newPath) {
  const url = new URL(c.req.url);
  url.pathname = newPath;
  const raw = c.req.raw;
  const hasBody = !["GET", "HEAD"].includes(raw.method);
  const req = new Request(url, {
    method: raw.method,
    headers: raw.headers,
    ...(hasBody ? { body: raw.body, duplex: "half" } : {}),
  });
  return app.fetch(req, c.env);
}
// "/v1/v1/:path*" → "/api/v1/:path*" (double-prefix clients)
app.all("/v1/v1", (c) => redispatch(c, "/api/v1"));
app.all("/v1/v1/*", (c) => redispatch(c, c.req.path.replace(/^\/v1\/v1/, "/api/v1")));
// "/responses" → "/api/v1/responses" (OpenAI Responses API clients)
app.all("/responses", (c) => redispatch(c, "/api/v1/responses"));
// "/codex/:path*" → "/api/v1/responses" (Codex CLI)
app.all("/codex", (c) => redispatch(c, "/api/v1/responses"));
app.all("/codex/*", (c) => redispatch(c, "/api/v1/responses"));

// ─── Ops endpoints ──────────────────────────────────────────────────────────
app.get("/healthz", (c) => c.json({ ok: true, server: "hono" }));

app.notFound((c) => c.json({ error: { message: "Not found", type: "invalid_request_error" } }, 404));

app.onError((err, c) => {
  console.error("[hono] unhandled error:", err && err.stack ? err.stack : err);
  return c.json({ error: { message: err?.message || "Internal error", type: "server_error" } }, 500);
});

// ─── Background token refresh (custom-server parity) ────────────────────────
if (process.env.NINEROUTER_DISABLE_BG_REFRESH !== "1") {
  try {
    const m = await import("../src/sse/services/backgroundTokenRefresh.js");
    m.startBackgroundTokenRefresh();
    const stop = () => {
      try { m.stopBackgroundTokenRefresh(); } catch { /* ignore */ }
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  } catch (e) {
    console.error("[hono] background token refresh failed to start:", e?.message || e);
  }
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST }, (info) => {
  console.log(`[hono] 9Router proxy surface listening on http://${HOST}:${info.port}`);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    server.close(() => process.exit(0));
    // Fallback force-exit if connections linger
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
