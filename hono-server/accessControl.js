// Fork: ownership rules for self-service API keys (multi-user mode).
//
// A viewer may create keys and read/manage only the keys they own. Admins and
// legacy shared-password sessions (no JWT `sub` claim) stay privileged, which
// keeps pre-multi-user deployments byte-identical. Unowned keys (created by a
// legacy session or before owner binding existed) are invisible to viewers.
//
// Pure functions only: hono-server/guard.js and the route overrides in
// hono-server/users.js share them, and tests/unit/accessControl.test.js
// exercises them without Hono or SQLite.

const MUTATING_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

// Session endpoints a viewer may always call.
const VIEWER_MUTABLE_PATHS = new Set(["/api/auth/logout", "/api/auth/login", "/api/users/me"]);

// Self-service key management. Ownership itself is enforced in the users.js
// route overrides — the guard only lets the request reach them.
const VIEWER_SELF_SERVICE_WRITES = [
  { method: "POST", re: /^\/api\/keys$/ },
  { method: "PUT", re: /^\/api\/keys\/[^/]+$/ },
  { method: "DELETE", re: /^\/api\/keys\/[^/]+$/ },
  { method: "PUT", re: /^\/api\/key-models$/ },
  { method: "DELETE", re: /^\/api\/key-models$/ },
];

function normalizePath(pathname) {
  const path = String(pathname || "");
  return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
}

// True when a viewer session may write to this path (or the path is safe for
// any authenticated user). Shared-password sessions carry no role and are
// never blocked here — the caller checks the session role first.
export function viewerWriteBlocked(method, pathname) {
  if (!MUTATING_METHODS.has(method)) return false;
  const path = normalizePath(pathname);
  if (!path.startsWith("/api/")) return false;
  if (VIEWER_MUTABLE_PATHS.has(path)) return false;
  return !VIEWER_SELF_SERVICE_WRITES.some((r) => r.method === method && r.re.test(path));
}

// No username session (legacy shared password / CLI token) or a non-viewer
// role => full admin surface, exactly like before multi-user existed.
export function sessionIsPrivileged(session) {
  if (!session?.sub) return true;
  return session.role !== "viewer";
}

export function canManageKey(session, ownerUsername) {
  if (sessionIsPrivileged(session)) return true;
  return Boolean(ownerUsername) && ownerUsername === session.sub;
}

// owners: { [keyId]: username } from userModelPolicy.getAllApiKeyOwners().
export function filterKeysForSession(keys, owners, session) {
  const list = Array.isArray(keys) ? keys : [];
  if (sessionIsPrivileged(session)) return list;
  return list.filter((k) => canManageKey(session, owners?.[k?.id]));
}

// Same filter for /api/key-models rows ({ keyId, keyName, patterns }).
export function filterRestrictionsForSession(restrictions, owners, session) {
  const list = Array.isArray(restrictions) ? restrictions : [];
  if (sessionIsPrivileged(session)) return list;
  return list.filter((r) => canManageKey(session, owners?.[r?.keyId]));
}
