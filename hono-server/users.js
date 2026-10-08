// Multi-user dashboard auth (fork-owned; new file, no upstream files edited).
//
// Upstream ships a single shared dashboard password. This service layers
// username/password users on top WITHOUT touching upstream sources:
//
//   - own SQLite table `dashboardUsers` (created here, never via upstream
//     schema.js/migrate.js), bcrypt password hashes, admin|viewer roles
//   - fork login handler for POST /api/auth/login, registered BEFORE the
//     upstream route table so it takes precedence; with zero users (or zero
//     admins) it delegates 1:1 to the upstream handler — existing shared-
//     password deployments behave identically until an admin user exists
//   - users-mode login requires {username, password} and issues a JWT with
//     sub/role claims (hono-server/guard.js enforces read-only for viewers)
//   - admin CRUD at /api/users (admin-only; last admin cannot be deleted or
//     demoted), bootstrap via INITIAL_ADMIN_USER/INITIAL_ADMIN_PASSWORD
//   - kill switch: NINEROUTER_DISABLE_MULTI_USER=1 (fork routes never
//     register, upstream login serves again)
//
// Test coverage: tests/unit/users.test.js (fake adapter, no SQLite needed).

import crypto from "node:crypto";
import bcrypt from "bcryptjs";
import {
  createDashboardAuthToken,
  shouldUseSecureCookie,
  getDashboardAuthSession,
} from "@/lib/auth/dashboardSession";
import { getSettings } from "@/lib/localDb";
import { isOidcConfigured } from "@/lib/auth/oidc";
import { isSamlConfigured } from "@/lib/auth/saml.js";
import { checkLock, recordFail, recordSuccess, getClientIp } from "@/lib/auth/loginLimiter";

export const USERNAME_RE = /^[a-zA-Z0-9_.-]{3,32}$/;
export const MIN_PASSWORD_LENGTH = 8;
export const USER_ROLES = ["admin", "viewer"];
const BCRYPT_COST = 10;
// Compared against when the username does not exist, so a wrong username and
// a wrong password take the same time (no user enumeration via timing).
const DUMMY_HASH = "$2a$10$C6UzMDM.H6dfI/f/IKcEe.O1XR8ZmPqK0kXpqrX3BIeFqKRViQpAO";

// ── Pure validation (unit-tested) ────────────────────────────────────────────

export function validateUsername(username) {
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return "Username must be 3-32 chars: letters, digits, dot, underscore, hyphen.";
  }
  return null;
}

export function validatePassword(password) {
  if (typeof password !== "string" || password.length < MIN_PASSWORD_LENGTH) {
    return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  }
  return null;
}

export function validateRole(role) {
  if (!USER_ROLES.includes(role)) return `Role must be one of: ${USER_ROLES.join(", ")}.`;
  return null;
}

export function hashPassword(password) {
  return bcrypt.hashSync(password, BCRYPT_COST);
}

export function userSummary(row) {
  if (!row) return null;
  return { id: row.id, username: row.username, role: row.role, createdAt: row.createdAt, updatedAt: row.updatedAt };
}

// ── Storage (adapter-injected, same surface the drivers expose) ─────────────

export async function ensureUsersTable(adapter) {
  adapter.exec(
    `CREATE TABLE IF NOT EXISTS dashboardUsers (
       id TEXT PRIMARY KEY,
       username TEXT NOT NULL UNIQUE,
       passwordHash TEXT NOT NULL,
       role TEXT NOT NULL DEFAULT 'admin',
       createdAt TEXT NOT NULL,
       updatedAt TEXT NOT NULL
     )`
  );
}

function countBy(adapter, where, params) {
  const row = adapter.get(`SELECT COUNT(*) AS n FROM dashboardUsers WHERE ${where}`, params);
  return Number(row?.n ?? 0);
}

export function countUsers(adapter) {
  return countBy(adapter, "1=1", []);
}
export function countAdmins(adapter) {
  return countBy(adapter, "role = ?", ["admin"]);
}

// Users-mode is active only when at least one user AND one admin exist — the
// admin-less state falls back to the shared password so an operator can never
// lock themselves out of the dashboard by deleting/demoting every admin.
export async function usersModeActive(adapter) {
  return (await countUsers(adapter)) > 0 && (await countAdmins(adapter)) > 0;
}

export function findUserByUsername(adapter, username) {
  return adapter.get("SELECT * FROM dashboardUsers WHERE username = ?", [username]) || null;
}
export function findUserById(adapter, id) {
  return adapter.get("SELECT * FROM dashboardUsers WHERE id = ?", [id]) || null;
}
export function listUsers(adapter) {
  return (adapter.all("SELECT * FROM dashboardUsers ORDER BY createdAt ASC") || []).map(userSummary);
}

export async function createUser(adapter, input) {
  const usernameError = validateUsername(input?.username);
  if (usernameError) return { error: usernameError };
  const passwordError = validatePassword(input?.password);
  if (passwordError) return { error: passwordError };
  const roleError = validateRole(input?.role);
  if (roleError) return { error: roleError };
  if (findUserByUsername(adapter, input.username)) return { error: "Username already exists." };
  const now = new Date().toISOString();
  const row = {
    id: crypto.randomUUID(),
    username: input.username,
    passwordHash: hashPassword(input.password),
    role: input.role,
    createdAt: now,
    updatedAt: now,
  };
  adapter.run(
    "INSERT INTO dashboardUsers (id, username, passwordHash, role, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)",
    [row.id, row.username, row.passwordHash, row.role, row.createdAt, row.updatedAt]
  );
  return { user: userSummary(row) };
}

export async function updateUser(adapter, id, input) {
  const existing = findUserById(adapter, id);
  if (!existing) return { error: "User not found." };
  const updates = {};
  if (input?.password !== undefined) {
    const passwordError = validatePassword(input.password);
    if (passwordError) return { error: passwordError };
    updates.passwordHash = hashPassword(input.password);
  }
  if (input?.role !== undefined) {
    const roleError = validateRole(input.role);
    if (roleError) return { error: roleError };
    if (existing.role === "admin" && input.role !== "admin" && (await countAdmins(adapter)) <= 1) {
      return { error: "Cannot demote the last admin." };
    }
    updates.role = input.role;
  }
  const keys = Object.keys(updates);
  if (!keys.length) return { error: "Nothing to update." };
  updates.updatedAt = new Date().toISOString();
  adapter.run(
    `UPDATE dashboardUsers SET ${keys.map((k) => `${k} = ?`).join(", ")}, updatedAt = ? WHERE id = ?`,
    [...keys.map((k) => updates[k]), updates.updatedAt, id]
  );
  return { user: userSummary(findUserById(adapter, id)) };
}

export async function deleteUser(adapter, id) {
  const existing = findUserById(adapter, id);
  if (!existing) return { error: "User not found." };
  if (existing.role === "admin" && (await countAdmins(adapter)) <= 1) {
    return { error: "Cannot delete the last admin." };
  }
  adapter.run("DELETE FROM dashboardUsers WHERE id = ?", [id]);
  return { ok: true };
}

export async function authenticateUser(adapter, username, password) {
  const row = typeof username === "string" ? findUserByUsername(adapter, username) : null;
  const ok = await bcrypt.compare(String(password ?? ""), row ? row.passwordHash : DUMMY_HASH);
  return ok && row ? userSummary(row) : null;
}

// INITIAL_ADMIN_USER/INITIAL_ADMIN_PASSWORD create the first admin at boot
// (idempotent: skipped when the username already exists or users exist
// without that env pair). Safe to leave set across restarts.
export async function bootstrapUsers(adapter, env = process.env) {
  const username = env.INITIAL_ADMIN_USER;
  const password = env.INITIAL_ADMIN_PASSWORD;
  if (!username || !password) return { created: false };
  if (findUserByUsername(adapter, username)) return { created: false };
  const res = await createUser(adapter, { username, password, role: "admin" });
  if (res.error) return { created: false, error: res.error };
  console.log(`[users] bootstrapped admin user "${username}" from INITIAL_ADMIN_* env`);
  return { created: true };
}

// ── Cookie helpers (Hono responses set cookies directly; upstream routes go
//    through the next/headers shim, fork handlers do not) ────────────────────

export function authCookieHeader(token, request) {
  const attrs = ["auth_token=" + token, "Path=/", "HttpOnly", "SameSite=Lax"];
  if (shouldUseSecureCookie(request)) attrs.push("Secure");
  attrs.push("Max-Age=" + 24 * 60 * 60);
  return attrs.join("; ");
}

function isTunnelRequest(request, settings) {
  const host = (request.headers.get("host") || "").split(":")[0].toLowerCase();
  const tunnelHost = settings.tunnelUrl ? new URL(settings.tunnelUrl).hostname.toLowerCase() : "";
  const tailscaleHost = settings.tailscaleUrl ? new URL(settings.tailscaleUrl).hostname.toLowerCase() : "";
  return (tunnelHost && host === tunnelHost) || (tailscaleHost && host === tailscaleHost);
}

async function readJsonBody(request) {
  try {
    return await request.json();
  } catch {
    return {};
  }
}

// ── Route registration (called from hono-server/server.js BEFORE the
//    upstream route table so these take precedence) ───────────────────────────

export function registerUserAuth(app, { on, api }) {
  if (process.env.NINEROUTER_DISABLE_MULTI_USER === "1") {
    console.log("[users] multi-user auth disabled via NINEROUTER_DISABLE_MULTI_USER=1");
    return;
  }

  // Legacy (zero users / zero admins): the upstream handler owns login
  // verbatim — rate limiting, SSO modes, must-change-password flow intact.
  const legacyLogin = on("POST", () => api("/login/route.js"));
  const legacyStatus = on("GET", () => api("/status/route.js"));

  app.post("/api/auth/login", async (c) => {
    const adapter = await loadAdapter();
    if (!(await usersModeActive(adapter))) return legacyLogin(c);
    return loginUserMode(c, adapter);
  });

  app.get("/api/auth/status", async (c) => {
    const adapter = await loadAdapter();
    const res = await legacyStatus(c);
    if (!res?.ok) return res;
    try {
      const data = await res.json();
      data.multiUser = await usersModeActive(adapter);
      const session = await getDashboardAuthSession(c.req.raw.headers.get("cookie")?.match(/(?:^|;\s*)auth_token=([^;]+)/)?.[1]);
      if (data.multiUser && session?.sub) {
        data.displayName = session.sub;
        data.loginMethod = "Password";
      }
      return c.json(data, 200, { "Cache-Control": "no-store" });
    } catch {
      return res;
    }
  });

  // ── Admin-only user management ────────────────────────────────────────────
  const requireAdmin = async (c) => {
    const token = c.req.raw.headers.get("cookie")?.match(/(?:^|;\s*)auth_token=([^;]+)/)?.[1];
    const session = await getDashboardAuthSession(token);
    // Legacy shared-password sessions carry no role — they are admin by
    // definition (that password IS the admin credential).
    if (!session?.authenticated) return { error: c.json({ error: "Unauthorized" }, 401) };
    if (session.role && session.role !== "admin") {
      return { error: c.json({ error: "Admin role required." }, 403) };
    }
    return { session };
  };

  // Self-service password change — any authenticated dashboard user (incl.
  // viewers, who are otherwise read-only). Requires the current password.
  // Registered BEFORE /api/users/:id so ":id" never captures "me".
  app.patch("/api/users/me", async (c) => {
    const token = c.req.raw.headers.get("cookie")?.match(/(?:^|;\s*)auth_token=([^;]+)/)?.[1];
    const session = await getDashboardAuthSession(token);
    if (!session?.sub) return c.json({ error: "Username session required." }, 400);
    const body = await readJsonBody(c.req.raw);
    if (typeof body.newPassword !== "string" || validatePassword(body.newPassword)) {
      return c.json({ error: validatePassword(body.newPassword) || "New password required." }, 400);
    }
    const adapter = await loadAdapter();
    const user = findUserByUsername(adapter, session.sub);
    if (!user) return c.json({ error: "User not found." }, 404);
    const ok = await bcrypt.compare(String(body.currentPassword ?? ""), user.passwordHash);
    if (!ok) return c.json({ error: "Current password is incorrect." }, 403);
    const res = await updateUser(adapter, user.id, { password: body.newPassword });
    if (res.error) return c.json({ error: res.error }, 400);
    return c.json({ ok: true });
  });

  app.get("/api/users", async (c) => {
    const guard = await requireAdmin(c);
    if (guard.error) return guard.error;
    return c.json({ users: listUsers(await loadAdapter()) }, 200, { "Cache-Control": "no-store" });
  });

  app.post("/api/users", async (c) => {
    const guard = await requireAdmin(c);
    if (guard.error) return guard.error;
    const body = await readJsonBody(c.req.raw);
    const res = await createUser(await loadAdapter(), body);
    if (res.error) return c.json({ error: res.error }, 400);
    return c.json({ user: res.user }, 201);
  });

  app.patch("/api/users/:id", async (c) => {
    const guard = await requireAdmin(c);
    if (guard.error) return guard.error;
    const body = await readJsonBody(c.req.raw);
    const res = await updateUser(await loadAdapter(), c.req.param("id"), body);
    if (res.error) return c.json({ error: res.error }, 400);
    return c.json({ user: res.user });
  });

  app.delete("/api/users/:id", async (c) => {
    const guard = await requireAdmin(c);
    if (guard.error) return guard.error;
    const res = await deleteUser(await loadAdapter(), c.req.param("id"));
    if (res.error) return c.json({ error: res.error }, 400);
    return c.json({ ok: true });
  });
}

async function loginUserMode(c, adapter) {
  const request = c.req.raw;
  const ip = getClientIp(request);
  const lock = checkLock(ip);
  if (lock.locked) {
    return c.json({ error: `Too many failed attempts. Try again in ${lock.retryAfter}s.`, retryAfter: lock.retryAfter }, 429, { "Retry-After": String(lock.retryAfter) });
  }

  const body = await readJsonBody(request);
  if (typeof body.username !== "string" || !body.username) {
    return c.json({ error: "Username required." }, 400);
  }

  const settings = await getSettings();

  if (isTunnelRequest(request, settings) && settings.tunnelDashboardAccess !== true) {
    return c.json({ error: "Dashboard access via tunnel is disabled" }, 403);
  }

  if (settings.authMode === "sso" || settings.authMode === "saml" || settings.authMode === "oidc") {
    const ssoType = settings.ssoType || (settings.authMode === "saml" ? "saml" : "oidc");
    if (ssoType === "saml" && isSamlConfigured(settings)) {
      return c.json({ error: "Password login is disabled. Use SAML SSO sign in." }, 403);
    }
    if (ssoType === "oidc" && isOidcConfigured(settings)) {
      return c.json({ error: "Password login is disabled. Use OIDC sign in." }, 403);
    }
  }

  const user = await authenticateUser(adapter, body.username, body.password);
  if (user) {
    recordSuccess(ip);
    const token = await createDashboardAuthToken({ sub: user.username, name: user.username, role: user.role });
    c.header("Set-Cookie", authCookieHeader(token, request));
    return c.json({ success: true, user: { username: user.username, role: user.role } }, 200, { "Cache-Control": "no-store" });
  }

  const { remainingBeforeLock } = recordFail(ip);
  const postLock = checkLock(ip);
  if (postLock.locked) {
    return c.json({ error: `Too many failed attempts. Try again in ${postLock.retryAfter}s.`, retryAfter: postLock.retryAfter }, 429, { "Retry-After": String(postLock.retryAfter) });
  }
  return c.json({ error: `Invalid username or password. ${remainingBeforeLock} attempt(s) left before lockout.`, remainingBeforeLock }, 401);
}

let adapterPromise = null;
async function loadAdapter() {
  if (!adapterPromise) {
    const { getAdapter } = await import("@/lib/db/driver.js");
    adapterPromise = getAdapter();
  }
  return adapterPromise;
}

// Boot hook: table + env bootstrap. Never throws — a broken users layer must
// not take the server down (login falls back to the shared password).
export async function initUserAuth() {
  if (process.env.NINEROUTER_DISABLE_MULTI_USER === "1") return;
  try {
    const adapter = await loadAdapter();
    await ensureUsersTable(adapter);
    await bootstrapUsers(adapter);
  } catch (e) {
    console.error("[users] init failed:", e?.message || e);
  }
}
