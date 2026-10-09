// Bun-native peer header stamping.
//
// x-9r-real-ip is treated as trustworthy by dashboardGuard, loginLimiter, and
// isLocalRequest, so it must be derived from the TCP peer — never from client
// input. Bun exposes the peer address as `c.env.requestIP(request)`; the
// per-process token proves to downstream readers that this middleware wrote the
// header rather than the client.
//
// Replaces peer-server.js, which wrapped Node's http.createServer for the same
// job. That wrapper also hand-downgraded h2c upgrades because a Node HTTP/1.1
// server closes them; Bun.serve answers an h2c upgrade request with a normal
// HTTP/1.1 response, so no downgrade is needed.

import crypto from "node:crypto";

const PEER_TOKEN_BYTES = 24;

// Ported from custom-server.js: the token is generated once per process.
export function ensurePeerToken() {
  if (!process.env.NINEROUTER_PEER_TOKEN) {
    process.env.NINEROUTER_PEER_TOKEN = crypto.randomBytes(PEER_TOKEN_BYTES).toString("hex");
  }
  return process.env.NINEROUTER_PEER_TOKEN;
}

function isLoopbackAddress(ip) {
  if (!ip) return false;
  const value = String(ip).trim().toLowerCase();
  return value === "::1" || value.startsWith("127.");
}

// Bun.serve hands Hono the server object as the fetch environment (verified:
// c.env.requestIP is a function and c.env.incoming does not exist).
function socketAddress(c) {
  return c.env?.requestIP?.(c.req.raw)?.address || "";
}

// Rewrites the peer headers on the live request so every downstream reader —
// guard, routes, request-detail snapshots — sees the same state.
export async function stampPeerHeaders(c) {
  const raw = c.req.raw;
  const socketIp = socketAddress(c);
  const xff = raw.headers.get("x-forwarded-for");
  const xRealIp = raw.headers.get("x-real-ip");
  const viaProxy = !!(xff || xRealIp);
  // Trust forwarding headers only when the TCP peer is a local reverse proxy.
  // Direct/public sockets stay keyed by the unspoofable peer address.
  const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
  const ip = isLoopbackAddress(socketIp) && proxyIp ? proxyIp : socketIp;

  raw.headers.delete("x-9r-real-ip");
  raw.headers.delete("x-forwarded-for");
  raw.headers.delete("x-9r-via-proxy");
  raw.headers.delete("x-9r-peer-token");
  raw.headers.set("x-9r-real-ip", ip);
  raw.headers.set("x-9r-peer-token", ensurePeerToken());
  if (viaProxy) raw.headers.set("x-9r-via-proxy", "1");
}
