// Shim for "next/headers" so route files using cookies()/headers() run
// unmodified on bare Node. Next binds these to the request via
// AsyncLocalStorage; this shim mirrors that mechanism, with the Hono adapter
// opening the context per request (runWithRequest) and applying pending
// Set-Cookie values to the response afterwards.
import { AsyncLocalStorage } from "node:async_hooks";

const storage = new AsyncLocalStorage();

function decodeSafe(v) {
  try { return decodeURIComponent(v); } catch { return v; }
}

function parseCookieHeader(header) {
  const out = new Map();
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = decodeSafe(part.slice(idx + 1).trim());
    if (name && !out.has(name)) out.set(name, value);
  }
  return out;
}

function toCookieDate(d) {
  return d instanceof Date ? d.toUTCString() : new Date(d).toUTCString();
}

// Attribute order mirrors the `cookie` package Next serializes with; values
// (like SameSite) pass through verbatim — Next emits `SameSite=lax` lowercase.
function serializeCookie(name, value, opts = {}) {
  let s = `${name}=${value}`;
  if (opts.maxAge != null) s += `; Max-Age=${Math.floor(opts.maxAge)}`;
  if (opts.domain) s += `; Domain=${opts.domain}`;
  if (opts.path) s += `; Path=${opts.path}`;
  if (opts.expires) s += `; Expires=${toCookieDate(opts.expires)}`;
  if (opts.httpOnly) s += "; HttpOnly";
  if (opts.secure) s += "; Secure";
  if (opts.priority) s += `; Priority=${opts.priority}`;
  if (opts.sameSite) s += `; SameSite=${opts.sameSite}`;
  if (opts.partitioned) s += "; Partitioned";
  return s;
}

function createStore(request) {
  const requestCookies = parseCookieHeader(request.headers.get("cookie"));
  const pending = [];
  const pendingValues = new Map();

  const store = {
    get size() { return requestCookies.size + pendingValues.size; },
    get(name) {
      const value = pendingValues.has(name) ? pendingValues.get(name) : requestCookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll() {
      const all = [...requestCookies];
      for (const [name, value] of pendingValues) {
        const i = all.findIndex(([n]) => n === name);
        if (i >= 0) all[i] = [name, value]; else all.push([name, value]);
      }
      return all.map(([name, value]) => ({ name, value }));
    },
    has(name) { return requestCookies.has(name) || pendingValues.has(name); },
    set(...args) {
      let name, value, opts;
      if (args.length === 1 && typeof args[0] === "object") {
        ({ name, value, ...opts } = args[0]);
      } else {
        [name, value, opts = {}] = args;
      }
      pending.push(serializeCookie(name, value, opts));
      pendingValues.set(name, value);
      return store;
    },
    delete(name, opts = {}) {
      pending.push(serializeCookie(name, "", { path: "/", maxAge: 0, expires: new Date(0), ...opts }));
      pendingValues.delete(name);
    },
  };
  return { store, pending };
}

function createHeadersView(request) {
  return {
    get: (name) => request.headers.get(name),
    has: (name) => request.headers.has(name),
    entries: () => request.headers.entries(),
    keys: () => request.headers.keys(),
    values: () => request.headers.values(),
  };
}

// Runs fn with a request-bound context. Returns { result, pending } where
// pending is the list of Set-Cookie strings produced while fn ran.
export function runWithRequest(request, fn) {
  const { store, pending } = createStore(request);
  const ctx = {
    request,
    cookies: Promise.resolve(store),
    headers: Promise.resolve(createHeadersView(request)),
  };
  const result = storage.run(ctx, fn);
  return { result, pending, store };
}

export function cookies() {
  const ctx = storage.getStore();
  if (!ctx) return Promise.reject(new Error("cookies was called outside a request scope"));
  return ctx.cookies;
}

export function headers() {
  const ctx = storage.getStore();
  if (!ctx) return Promise.reject(new Error("headers was called outside a request scope"));
  return ctx.headers;
}

// next/headers also exposes these; route code here never calls them, but keep
// the surface honest.
export function draftMode() {
  return Promise.resolve({ isEnabled: false });
}
