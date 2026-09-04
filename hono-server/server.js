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
// NINEROUTER_DISABLE_MITM=1: never auto-start the Antigravity MITM process,
// skip DNS restores/cleanup, and make the /api/cli-tools/antigravity-mitm*
// endpoints answer 503. Recommended for container deployments.

import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { registerGuards } from "./guard.js";
import { runWithRequest } from "./shims/next-headers.mjs";
import { createStaticHandler } from "./static.js";
import { createWrappingServer } from "./peer-server.js";

const PORT = Number(process.env.PORT || 20127);
const HOST = process.env.HOST || "0.0.0.0";

const app = new Hono();

// Peer-header stamping + port of the Next middleware (deny-by-default auth).
// Must register before any route.
registerGuards(app);

// ─── Lazy route module loading (mirrors Next's per-route lazy bundles) ──────
const modCache = new Map();

function loaderFor(baseDir) {
  return (rel) => {
    const key = `${baseDir}${rel}`;
    if (!modCache.has(key)) {
      modCache.set(key, import(new URL(`../src/routes/${baseDir}${rel}`, import.meta.url).href));
    }
    return modCache.get(key);
  };
}
const v1 = loaderFor("v1");
const v1beta = loaderFor("v1beta");
const api = loaderFor("usage");
const apiProviders = loaderFor("providers");
const apiModels = loaderFor("models");
const apiKeys = loaderFor("keys");
const apiCombos = loaderFor("combos");
const apiPools = loaderFor("proxy-pools");
const apiSettings = loaderFor("settings");
const apiVersion = loaderFor("version");
const apiPricing = loaderFor("pricing");
const apiTags = loaderFor("tags");
const apiInit = loaderFor("init");
const apiHealth = loaderFor("health");
const apiTranslator = loaderFor("translator");
const apiMcp = loaderFor("mcp");
const apiPxpipe = loaderFor("pxpipe");
const apiHeadroom = loaderFor("headroom");
const apiMedia = loaderFor("media-providers");
const apiTunnel = loaderFor("tunnel");
const apiAuth = loaderFor("auth");
const apiOauth = loaderFor("oauth");
const apiCliTools = loaderFor("cli-tools");
const apiShutdown = loaderFor("shutdown");
const apiProviderNodes = loaderFor("provider-nodes");
const apiMachineId = loaderFor("machine-id");

// Adapts a Next route handler to a Hono handler.
// opts.catchAll: param name receiving path segments after catchAllPrefix.
// opts.id: single dynamic param passed through.
// opts.params: list of dynamic param names (e.g. oauth [provider]/[action]).
// The handler runs inside the next-headers shim context, so cookies()/
// headers() work; pending Set-Cookie values are applied to the response.
function on(method, modLoader, opts = {}) {
  return async (c) => {
    const mod = await modLoader();
    const fn = mod[method];
    if (typeof fn !== "function") {
      return c.json({ error: `Method ${method} not allowed` }, 405);
    }
    const params = {};
    if (opts.id) params[opts.id] = c.req.param(opts.id);
    if (opts.params) for (const name of opts.params) params[name] = c.req.param(name);
    if (opts.catchAll) {
      const rest = c.req.path.startsWith(opts.catchAllPrefix)
        ? c.req.path.slice(opts.catchAllPrefix.length)
        : c.req.path;
      params[opts.catchAll] = rest.split("/").filter(Boolean);
    }
    const secondArg = (opts.id || opts.params || opts.catchAll)
      ? { params: Promise.resolve(params) }
      : undefined;

    let res;
    try {
      const { result, pending } = runWithRequest(c.req.raw, () => fn(c.req.raw, secondArg));
      res = await result;
      if (pending?.length && res) {
        const headers = new Headers(res.headers);
        for (const cookie of pending) headers.append("set-cookie", cookie);
        res = new Response(res.body, { status: res.status, statusText: res.statusText, headers });
      }
    } catch (e) {
      console.error(`[hono] ${method} ${c.req.path} failed:`, e?.stack || e);
      return c.json({ error: { message: e?.message || "Internal error", type: "server_error" } }, 500);
    }
    return res ?? c.json({ error: { message: "Empty response", type: "server_error" } }, 500);
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

// ─── Admin API groups (Phase 3, migrated per group) ─────────────────────────
const USAGE_ROUTES = [
  ["GET", "/usage/chart", () => api("/chart/route.js")],
  ["GET", "/usage/history", () => api("/history/route.js")],
  ["GET", "/usage/logs", () => api("/logs/route.js")],
  ["GET", "/usage/providers", () => api("/providers/route.js")],
  ["GET", "/usage/request-details", () => api("/request-details/route.js")],
  ["GET", "/usage/request-logs", () => api("/request-logs/route.js")],
  ["GET", "/usage/stats", () => api("/stats/route.js")],
  // Live usage SSE — EventTarget emitter + ReadableStream, no Next APIs
  ["GET", "/usage/stream", () => api("/stream/route.js")],
  // /usage/[connectionId]
  ["GET", "/usage/:connectionId", () => api("/[connectionId]/route.js"), { id: "connectionId" }],
  ["GET", "/usage/:connectionId/codex-reset-credits", () => api("/[connectionId]/codex-reset-credits/route.js"), { id: "connectionId" }],
  ["POST", "/usage/:connectionId/codex-reset-credits", () => api("/[connectionId]/codex-reset-credits/route.js"), { id: "connectionId" }],
];
register("/api", USAGE_ROUTES);

// ─── Admin group: providers ─────────────────────────────────────────────────
const PROVIDERS_ROUTES = [
  ["GET", "/providers", () => apiProviders("/route.js")],
  ["POST", "/providers", () => apiProviders("/route.js")],
  ["GET", "/providers/client", () => apiProviders("/client/route.js")],
  ["GET", "/providers/suggested-models", () => apiProviders("/suggested-models/route.js")],
  ["GET", "/providers/kilo/free-models", () => apiProviders("/kilo/free-models/route.js")],
  ["POST", "/providers/test-batch", () => apiProviders("/test-batch/route.js")],
  ["POST", "/providers/validate", () => apiProviders("/validate/route.js")],
  // /providers/[id]
  ["GET", "/providers/:id", () => apiProviders("/[id]/route.js"), { id: "id" }],
  ["PUT", "/providers/:id", () => apiProviders("/[id]/route.js"), { id: "id" }],
  ["DELETE", "/providers/:id", () => apiProviders("/[id]/route.js"), { id: "id" }],
  ["GET", "/providers/:id/models", () => apiProviders("/[id]/models/route.js"), { id: "id" }],
  ["POST", "/providers/:id/test", () => apiProviders("/[id]/test/route.js"), { id: "id" }],
  ["POST", "/providers/:id/test-models", () => apiProviders("/[id]/test-models/route.js"), { id: "id" }],
];
register("/api", PROVIDERS_ROUTES);

// ─── Admin group: models ────────────────────────────────────────────────────
const MODELS_ROUTES = [
  ["GET", "/models", () => apiModels("/route.js")],
  ["PUT", "/models", () => apiModels("/route.js")],
  ["GET", "/models/alias", () => apiModels("/alias/route.js")],
  ["PUT", "/models/alias", () => apiModels("/alias/route.js")],
  ["DELETE", "/models/alias", () => apiModels("/alias/route.js")],
  ["GET", "/models/availability", () => apiModels("/availability/route.js")],
  ["POST", "/models/availability", () => apiModels("/availability/route.js")],
  ["GET", "/models/catalog-sync", () => apiModels("/catalog-sync/route.js")],
  ["POST", "/models/catalog-sync", () => apiModels("/catalog-sync/route.js")],
  ["GET", "/models/custom", () => apiModels("/custom/route.js")],
  ["POST", "/models/custom", () => apiModels("/custom/route.js")],
  ["DELETE", "/models/custom", () => apiModels("/custom/route.js")],
  ["GET", "/models/disabled", () => apiModels("/disabled/route.js")],
  ["POST", "/models/disabled", () => apiModels("/disabled/route.js")],
  ["DELETE", "/models/disabled", () => apiModels("/disabled/route.js")],
  ["POST", "/models/test", () => apiModels("/test/route.js")],
];
register("/api", MODELS_ROUTES);

// ─── Admin group: keys ──────────────────────────────────────────────────────
const KEYS_ROUTES = [
  ["GET", "/keys", () => apiKeys("/route.js")],
  ["POST", "/keys", () => apiKeys("/route.js")],
  ["GET", "/keys/:id", () => apiKeys("/[id]/route.js"), { id: "id" }],
  ["PUT", "/keys/:id", () => apiKeys("/[id]/route.js"), { id: "id" }],
  ["DELETE", "/keys/:id", () => apiKeys("/[id]/route.js"), { id: "id" }],
];
register("/api", KEYS_ROUTES);

// ─── Admin group: combos ────────────────────────────────────────────────────
const COMBOS_ROUTES = [
  ["GET", "/combos", () => apiCombos("/route.js")],
  ["POST", "/combos", () => apiCombos("/route.js")],
  ["GET", "/combos/:id", () => apiCombos("/[id]/route.js"), { id: "id" }],
  ["PUT", "/combos/:id", () => apiCombos("/[id]/route.js"), { id: "id" }],
  ["DELETE", "/combos/:id", () => apiCombos("/[id]/route.js"), { id: "id" }],
];
register("/api", COMBOS_ROUTES);

// ─── Admin group: proxy-pools ───────────────────────────────────────────────
const POOLS_ROUTES = [
  ["GET", "/proxy-pools", () => apiPools("/route.js")],
  ["POST", "/proxy-pools", () => apiPools("/route.js")],
  ["POST", "/proxy-pools/cloudflare-deploy", () => apiPools("/cloudflare-deploy/route.js")],
  ["POST", "/proxy-pools/deno-deploy", () => apiPools("/deno-deploy/route.js")],
  ["POST", "/proxy-pools/vercel-deploy", () => apiPools("/vercel-deploy/route.js")],
  ["GET", "/proxy-pools/:id", () => apiPools("/[id]/route.js"), { id: "id" }],
  ["PUT", "/proxy-pools/:id", () => apiPools("/[id]/route.js"), { id: "id" }],
  ["DELETE", "/proxy-pools/:id", () => apiPools("/[id]/route.js"), { id: "id" }],
  ["POST", "/proxy-pools/:id/test", () => apiPools("/[id]/test/route.js"), { id: "id" }],
];
register("/api", POOLS_ROUTES);

// ─── Admin group: settings ──────────────────────────────────────────────────
const SETTINGS_ROUTES = [
  ["GET", "/settings", () => apiSettings("/route.js")],
  ["PATCH", "/settings", () => apiSettings("/route.js")],
  ["GET", "/settings/database", () => apiSettings("/database/route.js")],
  ["POST", "/settings/database", () => apiSettings("/database/route.js")],
  ["POST", "/settings/proxy-test", () => apiSettings("/proxy-test/route.js")],
  ["GET", "/settings/require-login", () => apiSettings("/require-login/route.js")],
];
register("/api", SETTINGS_ROUTES);

// ─── Admin batch: version, pricing, tags, init, health, translator, mcp ────
register("/api", [
  ["GET", "/version", () => apiVersion("/route.js")],
  // version/shutdown + version/update: registered but never called in tests
  // (destructive — they stop/update the host process).
  ["POST", "/version/shutdown", () => apiVersion("/shutdown/route.js")],
  ["POST", "/version/update", () => apiVersion("/update/route.js")],
  ["GET", "/pricing", () => apiPricing("/route.js")],
  ["PATCH", "/pricing", () => apiPricing("/route.js")],
  ["DELETE", "/pricing", () => apiPricing("/route.js")],
  ["OPTIONS", "/tags", () => apiTags("/route.js")],
  ["GET", "/tags", () => apiTags("/route.js")],
  ["GET", "/init", () => apiInit("/route.js")],
  ["OPTIONS", "/health", () => apiHealth("/route.js")],
  ["GET", "/health", () => apiHealth("/route.js")],
  ["POST", "/locale", () => loaderFor("locale")("/route.js")],
  ["GET", "/translator/console-logs", () => apiTranslator("/console-logs/route.js")],
  ["DELETE", "/translator/console-logs", () => apiTranslator("/console-logs/route.js")],
  ["GET", "/translator/console-logs/stream", () => apiTranslator("/console-logs/stream/route.js")],
  ["GET", "/translator/load", () => apiTranslator("/load/route.js")],
  ["POST", "/translator/save", () => apiTranslator("/save/route.js")],
  ["POST", "/translator/send", () => apiTranslator("/send/route.js")],
  ["POST", "/translator/translate", () => apiTranslator("/translate/route.js")],
  // /api/mcp is LOCAL_ONLY (guard) — MCP server SSE + message endpoints
  ["GET", "/mcp/:plugin/sse", () => apiMcp("/[plugin]/sse/route.js"), { id: "plugin" }],
  ["POST", "/mcp/:plugin/message", () => apiMcp("/[plugin]/message/route.js"), { id: "plugin" }],
]);

// ─── Admin batch: pxpipe, headroom, media-providers, tunnel ────────────────
// pxpipe start/stop/restart/install and headroom/tunnel lifecycle POSTs spawn
// or control host processes — registered here, never exercised in tests.
register("/api", [
  ["POST", "/pxpipe/health", () => apiPxpipe("/health/route.js")],
  ["POST", "/pxpipe/install", () => apiPxpipe("/install/route.js")],
  ["GET", "/pxpipe/logs", () => apiPxpipe("/logs/route.js")],
  ["POST", "/pxpipe/restart", () => apiPxpipe("/restart/route.js")],
  ["POST", "/pxpipe/start", () => apiPxpipe("/start/route.js")],
  ["GET", "/pxpipe/stats", () => apiPxpipe("/stats/route.js")],
  ["GET", "/pxpipe/status", () => apiPxpipe("/status/route.js")],
  ["POST", "/pxpipe/stop", () => apiPxpipe("/stop/route.js")],
]);
register("/api", [
  ["GET", "/headroom/extras", () => apiHeadroom("/extras/route.js")],
  ["POST", "/headroom/extras", () => apiHeadroom("/extras/route.js")],
  ["DELETE", "/headroom/extras", () => apiHeadroom("/extras/route.js")],
  ["POST", "/headroom/restart", () => apiHeadroom("/restart/route.js")],
  ["POST", "/headroom/start", () => apiHeadroom("/start/route.js")],
  ["GET", "/headroom/status", () => apiHeadroom("/status/route.js")],
  ["POST", "/headroom/stop", () => apiHeadroom("/stop/route.js")],
  // Reverse proxy to the headroom app (all methods; LOCAL_ONLY /headroom/start,
  // /stop, /proxy paths are gated by the guard above).
  ["GET", "/headroom/proxy/*", () => apiHeadroom("/proxy/[...path]/route.js"), { catchAll: "path", catchAllPrefix: "/api/headroom/proxy" }],
  ["POST", "/headroom/proxy/*", () => apiHeadroom("/proxy/[...path]/route.js"), { catchAll: "path", catchAllPrefix: "/api/headroom/proxy" }],
  ["PUT", "/headroom/proxy/*", () => apiHeadroom("/proxy/[...path]/route.js"), { catchAll: "path", catchAllPrefix: "/api/headroom/proxy" }],
  ["PATCH", "/headroom/proxy/*", () => apiHeadroom("/proxy/[...path]/route.js"), { catchAll: "path", catchAllPrefix: "/api/headroom/proxy" }],
  ["DELETE", "/headroom/proxy/*", () => apiHeadroom("/proxy/[...path]/route.js"), { catchAll: "path", catchAllPrefix: "/api/headroom/proxy" }],
  ["HEAD", "/headroom/proxy/*", () => apiHeadroom("/proxy/[...path]/route.js"), { catchAll: "path", catchAllPrefix: "/api/headroom/proxy" }],
  ["OPTIONS", "/headroom/proxy/*", () => apiHeadroom("/proxy/[...path]/route.js"), { catchAll: "path", catchAllPrefix: "/api/headroom/proxy" }],
]);
register("/api", [
  ["GET", "/media-providers/tts/voices", () => apiMedia("/tts/voices/route.js")],
  ["GET", "/media-providers/tts/deepgram/voices", () => apiMedia("/tts/deepgram/voices/route.js")],
  ["GET", "/media-providers/tts/elevenlabs/voices", () => apiMedia("/tts/elevenlabs/voices/route.js")],
  ["GET", "/media-providers/tts/inworld/voices", () => apiMedia("/tts/inworld/voices/route.js")],
  ["GET", "/media-providers/tts/minimax/voices", () => apiMedia("/tts/minimax/voices/route.js")],
]);
register("/api", [
  ["POST", "/tunnel/disable", () => apiTunnel("/disable/route.js")],
  ["POST", "/tunnel/enable", () => apiTunnel("/enable/route.js")],
  ["GET", "/tunnel/status", () => apiTunnel("/status/route.js")],
  ["GET", "/tunnel/tailscale-check", () => apiTunnel("/tailscale-check/route.js")],
  ["POST", "/tunnel/tailscale-disable", () => apiTunnel("/tailscale-disable/route.js")],
  ["POST", "/tunnel/tailscale-enable", () => apiTunnel("/tailscale-enable/route.js")],
  ["POST", "/tunnel/tailscale-install", () => apiTunnel("/tailscale-install/route.js")],
]);

// ─── Admin group: auth (cookie flows run via the next-headers shim) ────────
register("/api", [
  ["POST", "/auth/login", () => apiAuth("/login/route.js")],
  ["POST", "/auth/logout", () => apiAuth("/logout/route.js")],
  ["GET", "/auth/status", () => apiAuth("/status/route.js")],
  ["POST", "/auth/reset-password", () => apiAuth("/reset-password/route.js")],
  ["GET", "/auth/oidc/start", () => apiAuth("/oidc/start/route.js")],
  ["GET", "/auth/oidc/callback", () => apiAuth("/oidc/callback/route.js")],
  ["POST", "/auth/oidc/test", () => apiAuth("/oidc/test/route.js")],
  ["GET", "/auth/saml/metadata", () => apiAuth("/saml/metadata/route.js")],
  ["GET", "/auth/saml/start", () => apiAuth("/saml/start/route.js")],
  ["POST", "/auth/saml/acs", () => apiAuth("/saml/acs/route.js")],
  ["POST", "/auth/saml/test", () => apiAuth("/saml/test/route.js")],
]);

// ─── Admin group: oauth (credential import endpoints) ──────────────────────
register("/api", [
  ["POST", "/oauth/codex/bulk-import", () => apiOauth("/codex/bulk-import/route.js")],
  ["POST", "/oauth/codex/import-token", () => apiOauth("/codex/import-token/route.js")],
  ["GET", "/oauth/cursor/auto-import", () => apiOauth("/cursor/auto-import/route.js")],
  ["POST", "/oauth/cursor/import", () => apiOauth("/cursor/import/route.js")],
  ["GET", "/oauth/cursor/import", () => apiOauth("/cursor/import/route.js")],
  ["POST", "/oauth/gitlab/pat", () => apiOauth("/gitlab/pat/route.js")],
  ["POST", "/oauth/grok-cli/bulk-import", () => apiOauth("/grok-cli/bulk-import/route.js")],
  ["POST", "/oauth/iflow/cookie", () => apiOauth("/iflow/cookie/route.js")],
  ["POST", "/oauth/kiro/api-key", () => apiOauth("/kiro/api-key/route.js")],
  ["GET", "/oauth/kiro/auto-import", () => apiOauth("/kiro/auto-import/route.js")],
  ["POST", "/oauth/kiro/import-cli-proxy", () => apiOauth("/kiro/import-cli-proxy/route.js")],
  ["POST", "/oauth/kiro/import", () => apiOauth("/kiro/import/route.js")],
  ["GET", "/oauth/kiro/social-authorize", () => apiOauth("/kiro/social-authorize/route.js")],
  ["POST", "/oauth/kiro/social-exchange", () => apiOauth("/kiro/social-exchange/route.js")],
  // Generic OAuth flow: /api/oauth/{provider}/{action}
  ["GET", "/oauth/:provider/:action", () => apiOauth("/[provider]/[action]/route.js"), { params: ["provider", "action"] }],
  ["POST", "/oauth/:provider/:action", () => apiOauth("/[provider]/[action]/route.js"), { params: ["provider", "action"] }],
]);

// ─── Admin group: cli-tools (LAST batch — every /api route now lives here) ──
// *-settings POST/DELETE write real tool config files on the host — registered
// but never exercised in tests. antigravity-mitm + cowork-settings are
// LOCAL_ONLY (guard gates them to CLI token or local+authed).
register("/api", [
  ["GET", "/cli-tools/all-statuses", () => apiCliTools("/all-statuses/route.js")],
  ["GET", "/cli-tools/antigravity-mitm", () => apiCliTools("/antigravity-mitm/route.js")],
  ["POST", "/cli-tools/antigravity-mitm", () => apiCliTools("/antigravity-mitm/route.js")],
  ["DELETE", "/cli-tools/antigravity-mitm", () => apiCliTools("/antigravity-mitm/route.js")],
  ["PATCH", "/cli-tools/antigravity-mitm", () => apiCliTools("/antigravity-mitm/route.js")],
  ["GET", "/cli-tools/antigravity-mitm/alias", () => apiCliTools("/antigravity-mitm/alias/route.js")],
  ["PUT", "/cli-tools/antigravity-mitm/alias", () => apiCliTools("/antigravity-mitm/alias/route.js")],
  ["GET", "/cli-tools/cowork-mcp-registry", () => apiCliTools("/cowork-mcp-registry/route.js")],
  ["POST", "/cli-tools/cowork-mcp-tools", () => apiCliTools("/cowork-mcp-tools/route.js")],
]);
const CLI_SETTINGS = [
  ["claude-settings", ["GET", "POST", "DELETE"]],
  ["cline-settings", ["GET", "POST", "DELETE"]],
  ["codex-settings", ["GET", "POST", "DELETE"]],
  ["copilot-settings", ["GET", "POST", "DELETE"]],
  ["cowork-settings", ["GET", "POST", "DELETE"]],
  ["deepseek-tui-settings", ["GET", "POST", "DELETE"]],
  ["devin-settings", ["GET"]],
  ["droid-settings", ["GET", "POST", "DELETE"]],
  ["grok-build-settings", ["GET", "POST", "DELETE"]],
  ["hermes-settings", ["GET", "POST", "DELETE"]],
  ["jcode-settings", ["GET", "POST", "DELETE"]],
  ["kilo-settings", ["GET", "POST", "DELETE"]],
  ["openclaw-settings", ["GET", "POST", "DELETE"]],
  ["opencode-settings", ["GET", "POST", "PATCH", "DELETE"]],
];
for (const [name, methods] of CLI_SETTINGS) {
  for (const method of methods) {
    register("/api", [[method, `/cli-tools/${name}`, () => apiCliTools(`/${name}/route.js`)]]);
  }
}

// ─── ALWAYS_PROTECTED: kills the host process — never called in tests ──────
register("/api", [["POST", "/shutdown", () => apiShutdown("/route.js")]]);

// ─── Admin group: provider-nodes (validate is LOCAL_ONLY-guarded) ──────────
register("/api", [
  ["GET", "/provider-nodes", () => apiProviderNodes("/route.js")],
  ["POST", "/provider-nodes", () => apiProviderNodes("/route.js")],
  ["PUT", "/provider-nodes/:id", () => apiProviderNodes("/[id]/route.js"), { id: "id" }],
  ["DELETE", "/provider-nodes/:id", () => apiProviderNodes("/[id]/route.js"), { id: "id" }],
  ["POST", "/provider-nodes/validate", () => apiProviderNodes("/validate/route.js")],
]);

// ─── Static-dashboard helper: machine id for client pages ──────────────────
register("/api", [["GET", "/machine-id", () => apiMachineId("/route.js")]]);

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

// ─── Front-proxy / static-dashboard modes ───────────────────────────────────
// NEXT_UPSTREAM (transition): unmigrated dashboard pages are proxied to a Next
// standalone server on a private port. Otherwise (end-state): the exported
// dashboard (Next output:"export") is served straight from disk.
const NEXT_UPSTREAM = process.env.NEXT_UPSTREAM;
if (NEXT_UPSTREAM) {
  const upstream = new URL(NEXT_UPSTREAM);
  app.notFound(async (c) => {
    const url = new URL(c.req.url);
    const target = new URL(url.pathname + url.search, upstream);
    const method = c.req.method;
    const hasBody = !["GET", "HEAD"].includes(method);
    try {
      const res = await fetch(target, {
        method,
        headers: c.req.raw.headers,
        ...(hasBody ? { body: c.req.raw.body, duplex: "half" } : {}),
        redirect: "manual",
      });
      // undici decodes gzip/br but keeps the headers; dropping them stops
      // clients from trying to decode the already-decoded stream.
      const headers = new Headers(res.headers);
      headers.delete("content-encoding");
      headers.delete("content-length");
      headers.delete("transfer-encoding");
      return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
    } catch (e) {
      return c.json(
        { error: { message: `Upstream ${NEXT_UPSTREAM} unavailable: ${e?.message || e}`, type: "upstream_error" } },
        502
      );
    }
  });
} else {
  const exportDir = process.env.DASHBOARD_EXPORT_DIR || "out";
  const staticHandler = createStaticHandler(exportDir);
  if (staticHandler) {
    app.notFound(staticHandler);
  } else {
    app.notFound((c) => c.json({ error: { message: "Not found", type: "invalid_request_error" } }, 404));
  }
}

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

// ─── Instrumentation parity (src/instrumentation.js register()) ─────────────
// Console-log capture feeds /api/translator/console-logs; the catalog override
// + sync back open-sse capabilities used by /v1/models.
if (process.env.NINEROUTER_DISABLE_INSTRUMENTATION !== "1") {
  try {
    const { initConsoleLogCapture } = await import("@/lib/consoleLogBuffer");
    initConsoleLogCapture();
    const { installCatalogSource } = await import("open-sse/providers/catalogOverride.js");
    await installCatalogSource();
    const { startModelCatalogSync } = await import("@/lib/modelCatalog/sync.js");
    startModelCatalogSync();
  } catch (e) {
    console.error("[hono] instrumentation init failed:", e?.message || e);
  }
}

const server = serve({ fetch: app.fetch, port: PORT, hostname: HOST, createServer: createWrappingServer }, (info) => {
  console.log(`[hono] 9Router proxy surface listening on http://${HOST}:${info.port}`);
});

// A long-running local proxy must not die on one bad request. Log loudly; the
// default Node behavior (crash on unhandled rejection) killed the process when
// a lazy module load failed mid-request.
process.on("unhandledRejection", (reason) => {
  console.error("[hono] unhandled rejection:", reason?.stack || reason);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.once(sig, () => {
    server.close(() => process.exit(0));
    // Fallback force-exit if connections linger
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
