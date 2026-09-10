// Port of the Next.js 16 middleware (src/proxy.js → src/dashboardGuard.js)
// plus the custom-server.js peer-header stamping it depends on.
//
// Next runs that middleware for every non-static request before rewrites; any
// path this server answers directly must apply the same deny-by-default rules,
// otherwise migrated admin APIs lose their auth. Paths handed to NEXT_UPSTREAM
// are guarded here AND again inside Next — same rules, same verdicts.

import crypto from "node:crypto";
import { getSettings, validateApiKey } from "@/lib/localDb";
import { getConsistentMachineId } from "@/shared/utils/machineId";
import { verifyDashboardAuthToken } from "@/lib/auth/dashboardSession";
import { hasTrustedPeerHeaders } from "@/lib/auth/trustedPeer";
import {
  getKeyModelRestrictions,
  findApiKeyIdByRawKey,
  modelAllowed,
} from "@/lib/db/repos/keyModelRestrictionsRepo.js";

// Mirrors custom-server.js: per-process secret proving x-9r-real-ip was
// stamped from the TCP socket rather than supplied by the client.
export function ensurePeerToken() {
  if (!process.env.NINEROUTER_PEER_TOKEN) {
    process.env.NINEROUTER_PEER_TOKEN = crypto.randomBytes(24).toString("hex");
  }
}

const CLI_TOKEN_HEADER = "x-9r-cli-token";
const CLI_TOKEN_SALT = "9r-cli-auth";

let cachedCliToken = null;
async function getCliToken() {
  if (!cachedCliToken) cachedCliToken = await getConsistentMachineId(CLI_TOKEN_SALT);
  return cachedCliToken;
}

async function hasValidCliToken(request) {
  const token = request.headers.get(CLI_TOKEN_HEADER);
  if (!token) return false;
  return token === await getCliToken();
}

// Public API paths — no auth required (LLM API has its own key auth inside handler).
const PUBLIC_API_PATHS = [
  "/api/health",
  "/api/init",
  "/api/locale",
  "/api/auth/login",
  "/api/auth/logout",
  "/api/auth/status",
  "/api/auth/oidc",
  "/api/auth/saml",
  "/api/version",
  "/api/settings/require-login",
];

// Public top-level prefixes (LLM API endpoints with their own API key auth).
const PUBLIC_PREFIXES = ["/v1", "/v1beta", "/api/v1", "/api/v1beta", "/codex", "/responses"];

// Always require JWT token regardless of requireLogin setting
const ALWAYS_PROTECTED = [
  "/api/shutdown",
  "/api/settings/database",
  "/api/version/shutdown",
  "/api/version/update",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
];

// Routes that spawn child processes or read host secrets — restrict to localhost.
const LOCAL_ONLY_PATHS = [
  "/api/cli-tools/cowork-settings",
  "/api/cli-tools/antigravity-mitm",
  "/api/mcp/",
  "/api/tunnel/tailscale-install",
  "/api/tunnel/tailscale-enable",
  "/api/tunnel/tailscale-disable",
  "/api/tunnel/tailscale-check",
  "/api/tunnel/enable",
  "/api/tunnel/disable",
  "/api/oauth/cursor/auto-import",
  "/api/oauth/kiro/auto-import",
  "/api/auth/reset-password",
  "/api/headroom/start",
  "/api/headroom/stop",
  "/api/headroom/proxy",
];

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1"]);

function isLoopbackHostname(h) {
  if (!h) return false;
  let name = String(h).trim().toLowerCase();
  if (name.startsWith("[")) {
    const end = name.indexOf("]");
    if (end === -1) return false;
    name = name.slice(1, end);
  } else if (name.indexOf(":") !== -1 && name.indexOf(":") === name.lastIndexOf(":")) {
    name = name.slice(0, name.indexOf(":"));
  }
  if (name.startsWith("::ffff:")) name = name.slice(7);
  return LOOPBACK_HOSTS.has(name);
}

function isLoopbackPeer(request) {
  if (hasTrustedPeerHeaders(request)) {
    return isLoopbackHostname(request.headers.get("x-9r-real-ip"));
  }
  if (process.env.NODE_ENV === "development") {
    return isLoopbackHostname(request.headers.get("host"));
  }
  return false;
}

export function isLocalRequest(request) {
  if (request.headers.get("x-9r-via-proxy")) return false;
  if (!isLoopbackPeer(request)) return false;
  const origin = request.headers.get("origin");
  if (origin) {
    try {
      if (!isLoopbackHostname(new URL(origin).hostname)) return false;
    } catch { return false; }
  }
  return true;
}

function isPublicLlmApi(pathname) {
  return PUBLIC_PREFIXES.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

function extractApiKey(request) {
  const authHeader = request.headers.get("Authorization");
  if (authHeader?.startsWith("Bearer ")) return authHeader.slice(7);
  const apiKeyHeader = request.headers.get("x-api-key");
  if (apiKeyHeader) return apiKeyHeader;
  const googleApiKeyHeader = request.headers.get("x-goog-api-key");
  if (googleApiKeyHeader) return googleApiKeyHeader;
  try {
    return new URL(request.url).searchParams.get("key") || null;
  } catch {
    return null;
  }
}

async function hasValidApiKey(request) {
  const apiKey = extractApiKey(request);
  if (!apiKey) return false;
  return await validateApiKey(apiKey);
}

async function canAccessPublicLlmApi(request) {
  if (isLocalRequest(request)) return true;
  if (await hasValidCliToken(request)) return true;
  return await hasValidApiKey(request);
}

// ─── Fork feature: per-API-key model restrictions ──────────────────────────
// Pattern matching lives in the fork repo module so it is unit-testable
// (modelMatchesPattern / modelAllowed).
function extractRequestedModel(request, pathname) {
  // Gemini native: model lives in the path — /v1beta/models/<model>:action
  const gemini = pathname.match(/\/models\/([^:]+):/);
  if (gemini) return decodeURIComponent(gemini[1]);
  return null; // JSON body peek is done by the caller (clone-based)
}

async function enforceKeyModelRestrictions(request, pathname) {
  const rawKey = extractApiKey(request);
  if (!rawKey) return null; // local / cli-token access carries no key → unrestricted

  const keyId = await findApiKeyIdByRawKey(rawKey);
  if (!keyId) return null;

  const patterns = await getKeyModelRestrictions(keyId);
  if (!patterns) return null;

  let model = extractRequestedModel(request, pathname);
  if (!model) {
    const hasBody = !["GET", "HEAD"].includes(request.method);
    if (hasBody) {
      try {
        const peek = await request.clone().json();
        model = typeof peek?.model === "string" ? peek.model : null;
      } catch { /* non-JSON body (multipart/form) — not restrictable here */ }
    }
  }
  if (!model) return null;

  if (modelAllowed(patterns, model)) return null;
  return Response.json(
    { error: { message: `Model "${model}" is not allowed for this API key`, type: "access_denied", code: "model_not_allowed" } },
    { status: 403 }
  );
}

async function canAccessLocalOnlyRoute(request) {
  if (await hasValidCliToken(request)) return true;
  if (isLocalRequest(request) && await isAuthenticated(request)) return true;
  return false;
}

function readCookie(request, name) {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    if (part.slice(0, idx).trim() === name) return part.slice(idx + 1).trim();
  }
  return null;
}

async function hasValidToken(request) {
  return await verifyDashboardAuthToken(readCookie(request, "auth_token"));
}

// Read settings directly from DB to avoid self-fetch deadlock in middleware
async function loadSettings() {
  try {
    return await getSettings();
  } catch {
    return null;
  }
}

async function isAuthenticated(request) {
  if (await hasValidToken(request)) return true;
  const settings = await loadSettings();
  if (settings && settings.requireLogin === false) return true;
  return false;
}

function isPublicApi(pathname) {
  if (isPublicLlmApi(pathname)) return true;
  return PUBLIC_API_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

// Stamps the same peer headers custom-server.js writes for Next, so guard
// logic (and route handlers) see identical request state on this server.
async function stampPeerHeaders(c) {
  const raw = c.req.raw;
  const socket = c.env?.incoming?.socket;
  const socketIp = socket?.remoteAddress || "";
  const xff = raw.headers.get("x-forwarded-for");
  const xRealIp = raw.headers.get("x-real-ip");
  const viaProxy = !!(xff || xRealIp);
  const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
  const loopback = isLoopbackHostname(socketIp) || socketIp === "::ffff:127.0.0.1";
  const ip = loopback && proxyIp ? proxyIp : socketIp;
  raw.headers.delete("x-9r-real-ip");
  raw.headers.delete("x-forwarded-for");
  raw.headers.delete("x-9r-via-proxy");
  raw.headers.delete("x-9r-peer-token");
  raw.headers.set("x-9r-real-ip", ip);
  raw.headers.set("x-9r-peer-token", process.env.NINEROUTER_PEER_TOKEN);
  if (viaProxy) raw.headers.set("x-9r-via-proxy", "1");
}

export function registerGuards(app) {
  ensurePeerToken();

  // Peer-header stamping — runs for everything, cheap, no I/O.
  app.use("*", async (c, next) => {
    await stampPeerHeaders(c);
    await next();
  });

  // Port of proxy(). Matcher exclusions copied from src/proxy.js config.
  app.use("*", async (c, next) => {
    const pathname = c.req.path;
    if (
      pathname.startsWith("/_next/static")
      || pathname.startsWith("/_next/image")
      || pathname === "/favicon.ico"
    ) {
      return next();
    }

    // Local-only gate for spawn-capable / host-secret routes.
    if (LOCAL_ONLY_PATHS.some((p) => pathname.startsWith(p))) {
      if (!(await canAccessLocalOnlyRoute(c.req.raw))) {
        return c.json({ error: "Local only: CLI token required" }, 403);
      }
    }

    // Always protected — valid JWT or local CLI token.
    if (ALWAYS_PROTECTED.some((p) => pathname.startsWith(p))) {
      if (await hasValidCliToken(c.req.raw) || await hasValidToken(c.req.raw)) {
        return next();
      }
      return c.json({ error: "Unauthorized" }, 401);
    }

    if (isPublicLlmApi(pathname)) {
      if (!(await canAccessPublicLlmApi(c.req.raw))) {
        return c.json({ error: "API key required for remote API access" }, 401);
      }
      const denied = await enforceKeyModelRestrictions(c.req.raw, pathname);
      if (denied) return denied;
      return next();
    }

    // Deny-by-default for /api/* — public allow-list bypasses, rest requires auth.
    if (pathname.startsWith("/api/")) {
      if (isPublicApi(pathname)) return next();
      if (await hasValidCliToken(c.req.raw) || await isAuthenticated(c.req.raw)) {
        return next();
      }
      return c.json({ error: "Unauthorized" }, 401);
    }

    // Protect dashboard pages (relevant while NEXT_UPSTREAM proxies them).
    if (pathname.startsWith("/dashboard")) {
      let requireLogin = true;
      let tunnelDashboardAccess = true;
      try {
        const settings = await loadSettings();
        if (settings) {
          requireLogin = settings.requireLogin !== false;
          tunnelDashboardAccess = settings.tunnelDashboardAccess === true;
          if (!tunnelDashboardAccess) {
            const host = (c.req.raw.headers.get("host") || "").split(":")[0].toLowerCase();
            const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
            const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
            if ((tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost)) {
              return c.redirect(new URL("/login", c.req.url).toString(), 307);
            }
          }
        }
      } catch {
        // keep defaults (require login, block tunnel)
      }
      if (!requireLogin) return next();
      const token = readCookie(c.req.raw, "auth_token");
      if (token) {
        if (await verifyDashboardAuthToken(token)) return next();
        return c.redirect(new URL("/login", c.req.url).toString(), 307);
      }
      return c.redirect(new URL("/login", c.req.url).toString(), 307);
    }

    if (pathname === "/") {
      return c.redirect(new URL("/dashboard", c.req.url).toString(), 307);
    }

    return next();
  });
}
