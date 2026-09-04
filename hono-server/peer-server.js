// Port of custom-server.js for the Hono server: derive the client IP from the
// TCP socket (unspoofable), strip client-supplied forwarding headers, and
// downgrade h2c upgrades to plain HTTP/1.1 (JBR 25 sends h2c that the HTTP/1.1
// server would otherwise close).
//
// Wired in via serve({ createServer }) so every connection — including ones
// created by this module — passes through the same wrapper.
import http from "node:http";
import crypto from "node:crypto";

// Per-process secret proving x-9r-real-ip was stamped below rather than sent
// by the client. Named like x-9r-cli-token so the request-detail header
// sanitizer redacts it too.
export function ensurePeerToken() {
  if (!process.env.NINEROUTER_PEER_TOKEN) {
    process.env.NINEROUTER_PEER_TOKEN = crypto.randomBytes(24).toString("hex");
  }
  return process.env.NINEROUTER_PEER_TOKEN;
}

function isLoopbackSocket(ip) {
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

export function createWrappingServer(options, handler) {
  ensurePeerToken();
  const server = http.createServer(options, (req, res) => {
    const socketIp = req.socket?.remoteAddress || "";
    const xff = req.headers["x-forwarded-for"];
    const xRealIp = req.headers["x-real-ip"];
    const viaProxy = !!(xff || xRealIp);
    // Trust forwarding headers only when the TCP peer is a local reverse proxy.
    // Direct/public sockets remain keyed by the unspoofable peer address.
    const proxyIp = xRealIp || (xff ? String(xff).split(",")[0].trim() : "");
    const ip = isLoopbackSocket(socketIp) && proxyIp ? proxyIp : socketIp;
    delete req.headers["x-9r-real-ip"];
    delete req.headers["x-forwarded-for"];
    delete req.headers["x-9r-via-proxy"];
    delete req.headers["x-9r-peer-token"];
    req.headers["x-9r-real-ip"] = ip;
    req.headers["x-9r-peer-token"] = process.env.NINEROUTER_PEER_TOKEN;
    if (viaProxy) req.headers["x-9r-via-proxy"] = "1";
    handler(req, res);
  });

  // h2c upgrade downgrade: replay the upgraded request through the HTTP/1.1
  // handler once the (content-length-bounded) body has arrived.
  const origEmit = server.emit;
  server.emit = function (event, ...eventArgs) {
    const [req, socket, head] = eventArgs;
    if (event !== "upgrade" || String(req.headers.upgrade || "").toLowerCase() !== "h2c") {
      return origEmit.call(this, event, ...eventArgs);
    }

    const contentLength = Number(req.headers["content-length"] || 0);
    if (!Number.isSafeInteger(contentLength) || contentLength < 0) {
      socket.destroy();
      return true;
    }
    const chunks = [head];
    let received = head.length;
    const serve = () => {
      const replay = new http.IncomingMessage(socket);
      Object.assign(replay, { method: req.method, url: req.url, headers: req.headers, complete: true });
      if (received) replay.push(Buffer.concat(chunks, received).subarray(0, contentLength));
      replay.push(null);
      const res = new http.ServerResponse(replay);
      res.shouldKeepAlive = false;
      res.assignSocket(socket);
      res.once("finish", () => socket.end());
      Promise.resolve()
        .then(() => handler(replay, res))
        .catch((error) => {
          console.error("Failed to downgrade h2c request", error);
          socket.destroy();
        });
    };
    if (received >= contentLength) serve();
    else {
      socket.on("data", function readBody(chunk) {
        chunks.push(chunk);
        received += chunk.length;
        if (received < contentLength) return;
        socket.off("data", readBody);
        serve();
      });
      socket.resume();
    }
    delete req.headers.upgrade;
    delete req.headers["http2-settings"];
    req.headers.connection = "close";
    return true;
  };

  return server;
}
