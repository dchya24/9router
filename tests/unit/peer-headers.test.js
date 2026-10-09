// Bun-native peer header stamping.
//
// This replaces peer-server.js, which wrapped Node's http.createServer to read
// the TCP socket and hand-downgrade h2c upgrades. Under Bun.serve both jobs are
// native: `c.env.requestIP()` yields the unspoofable peer address (verified:
// Bun answers an h2c upgrade request with a normal HTTP/1.1 response), so the
// middleware lives in the Hono layer and the wrapper is gone.
//
// The property under test is unchanged: a client must not be able to smuggle
// its own x-9r-* peer headers in, because downstream code (dashboardGuard,
// loginLimiter, isLocalRequest) treats x-9r-real-ip as trustworthy, and its
// trustworthiness rests on the per-process token stamped here.
//
// Requires the Bun runtime:
//   bun --bun x vitest run --config tests/vitest.config.js tests/unit/peer-headers.test.js
import { Hono } from "hono";
import { afterAll, describe, expect, it } from "vitest";
import { ensurePeerToken, stampPeerHeaders } from "../../hono-server/peer-headers.js";
import { __test__ as requestDetails } from "@/lib/db/repos/requestDetailsRepo.js";

const app = new Hono();
app.use("*", async (c, next) => {
  await stampPeerHeaders(c);
  await next();
});
app.get("/", (c) =>
  c.json({
    realIp: c.req.header("x-9r-real-ip") ?? null,
    peerToken: c.req.header("x-9r-peer-token") ?? null,
    viaProxy: c.req.header("x-9r-via-proxy") ?? null,
    forwardedFor: c.req.header("x-forwarded-for") ?? null,
  })
);

const server = Bun.serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
afterAll(() => server.stop(true));

async function get(headers = {}) {
  const res = await fetch(`http://127.0.0.1:${server.port}/`, { headers });
  return res.json();
}

describe("Bun peer header stamping", () => {
  it("generates a peer trust token at boot", () => {
    expect(ensurePeerToken()).toMatch(/^[0-9a-f]{48}$/);
  });

  it("replaces a client-supplied x-9r-real-ip with the socket address", async () => {
    const { realIp } = await get({ "x-9r-real-ip": "203.0.113.55" });
    expect(realIp).toMatch(/^(::ffff:)?127\.0\.0\.1$/);
  });

  it("stamps the trust token so downstream can tell the middleware ran", async () => {
    const { peerToken } = await get();
    expect(peerToken).toBe(process.env.NINEROUTER_PEER_TOKEN);
  });

  it("drops a client-supplied peer trust token", async () => {
    const { peerToken } = await get({ "x-9r-peer-token": "forged-token" });
    expect(peerToken).toBe(process.env.NINEROUTER_PEER_TOKEN);
    expect(peerToken).not.toBe("forged-token");
  });

  it("drops a client-supplied x-9r-via-proxy marker", async () => {
    const { viaProxy } = await get({ "x-9r-via-proxy": "1" });
    expect(viaProxy).toBeNull();
  });

  it("marks via-proxy and adopts the forwarded IP for a loopback proxy hop", async () => {
    const { viaProxy, realIp, forwardedFor } = await get({
      "x-forwarded-for": "203.0.113.9, 10.0.0.1",
    });
    expect(viaProxy).toBe("1");
    expect(realIp).toBe("203.0.113.9");
    expect(forwardedFor).toBeNull();
  });

  // chat.js snapshots every client header into the request detail. Anything that grants
  // access must not survive into a record the dashboard renders and cloud sync uploads.
  it("keeps the peer token out of persisted request details", () => {
    const sanitized = requestDetails.sanitizeHeaders({
      "x-9r-peer-token": "secret",
      "x-9r-cli-token": "secret",
      authorization: "Bearer sk-x",
      "x-9r-real-ip": "127.0.0.1",
    });

    expect(sanitized["x-9r-peer-token"]).toBeUndefined();
    expect(sanitized["x-9r-cli-token"]).toBeUndefined();
    expect(sanitized.authorization).toBeUndefined();
    expect(sanitized["x-9r-real-ip"]).toBe("127.0.0.1");
  });
});
