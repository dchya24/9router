/**
 * Multi-user dashboard auth (hono-server/users.js).
 *
 * In-memory fake adapter over a plain row array — same driver surface
 * (run/get/all/exec) the real adapters expose, so no SQLite/data dir needed.
 * bcrypt runs for real (cost 10, a handful of hashes ≈ ok).
 */

import { describe, it, expect, beforeEach } from "vitest";
import {
  validateUsername,
  validatePassword,
  validateRole,
  hashPassword,
  userSummary,
  ensureUsersTable,
  countUsers,
  countAdmins,
  usersModeActive,
  findUserByUsername,
  listUsers,
  createUser,
  updateUser,
  deleteUser,
  authenticateUser,
  bootstrapUsers,
  authCookieHeader,
  USERNAME_RE,
  MIN_PASSWORD_LENGTH,
} from "../../hono-server/users.js";

function makeFakeAdapter(seed = []) {
  const rows = seed.map((u, i) => ({
    id: u.id || `id-${i + 1}`,
    username: u.username,
    passwordHash: u.passwordHash || hashPassword(u.password || "password123"),
    role: u.role || "admin",
    createdAt: u.createdAt || new Date(2026, 0, 1).toISOString(),
    updatedAt: u.updatedAt || new Date(2026, 0, 1).toISOString(),
  }));
  return {
    rows,
    exec: () => {},
    get(sql, params) {
      if (sql.includes("COUNT(*)")) {
        if (sql.includes("role = ?")) return { n: rows.filter((r) => r.role === params[0]).length };
        return { n: rows.length };
      }
      if (sql.includes("WHERE username = ?")) return rows.find((r) => r.username === params[0]) || null;
      if (sql.includes("WHERE id = ?")) return rows.find((r) => r.id === params[0]) || null;
      throw new Error(`fake adapter: unexpected get: ${sql}`);
    },
    all() {
      return [...rows].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    },
    run(sql, params) {
      if (sql.startsWith("INSERT")) {
        rows.push({ id: params[0], username: params[1], passwordHash: params[2], role: params[3], createdAt: params[4], updatedAt: params[5] });
        return { changes: 1 };
      }
      if (sql.startsWith("UPDATE")) {
        const row = rows.find((r) => r.id === params[params.length - 1]);
        if (!row) return { changes: 0 };
        const cols = sql.match(/SET (.*) WHERE/)[1].split(", ").map((c) => c.split(" =")[0].trim());
        cols.forEach((col, i) => { row[col] = params[i]; });
        return { changes: 1 };
      }
      if (sql.startsWith("DELETE")) {
        const i = rows.findIndex((r) => r.id === params[0]);
        if (i === -1) return { changes: 0 };
        rows.splice(i, 1);
        return { changes: 1 };
      }
      throw new Error(`fake adapter: unexpected run: ${sql}`);
    },
  };
}

describe("validation", () => {
  it("accepts sane usernames and rejects bad ones", () => {
    expect(validateUsername("admin")).toBeNull();
    expect(validateUsername("a.b-c_9")).toBeNull();
    expect(validateUsername("ab")).not.toBeNull();
    expect(validateUsername("has space")).not.toBeNull();
    expect(validateUsername("no!specials")).not.toBeNull();
    expect(validateUsername("x".repeat(33))).not.toBeNull();
    expect(validateUsername(42)).not.toBeNull();
  });

  it("enforces the minimum password length", () => {
    expect(validatePassword("a".repeat(MIN_PASSWORD_LENGTH))).toBeNull();
    expect(validatePassword("a".repeat(MIN_PASSWORD_LENGTH - 1))).not.toBeNull();
    expect(validatePassword(undefined)).not.toBeNull();
  });

  it("only allows known roles", () => {
    expect(validateRole("admin")).toBeNull();
    expect(validateRole("viewer")).toBeNull();
    expect(validateRole("root")).not.toBeNull();
  });

  it("userSummary never leaks the password hash", () => {
    const s = userSummary({ id: "1", username: "u", passwordHash: "secret", role: "viewer", createdAt: "t", updatedAt: "t" });
    expect(s).toEqual({ id: "1", username: "u", role: "viewer", createdAt: "t", updatedAt: "t" });
    expect(JSON.stringify(s)).not.toContain("secret");
  });
});

describe("users mode", () => {
  it("inactive with zero users (legacy shared password)", async () => {
    expect(await usersModeActive(makeFakeAdapter())).toBe(false);
  });

  it("inactive when users exist but no admin (lockout escape hatch)", async () => {
    expect(await usersModeActive(makeFakeAdapter([{ username: "v", role: "viewer", password: "password123" }]))).toBe(false);
  });

  it("active when at least one admin exists", async () => {
    expect(await usersModeActive(makeFakeAdapter([{ username: "a", role: "admin", password: "password123" }]))).toBe(true);
  });
});

describe("CRUD + last-admin protection", () => {
  it("creates users and rejects duplicates / bad input", async () => {
    const a = makeFakeAdapter();
    const res = await createUser(a, { username: "alice", password: "password123", role: "admin" });
    expect(res.user.username).toBe("alice");
    expect(res.user.role).toBe("admin");
    expect(await createUser(a, { username: "alice", password: "password123", role: "viewer" })).toEqual({ error: "Username already exists." });
    expect((await createUser(a, { username: "x", password: "password123", role: "admin" })).error).toBeTruthy();
    expect((await createUser(a, { username: "bob", password: "short", role: "admin" })).error).toBeTruthy();
    expect((await createUser(a, { username: "bob", password: "password123", role: "boss" })).error).toBeTruthy();
    expect(countUsers(a)).toBe(1);
  });

  it("never deletes or demotes the last admin", async () => {
    const a = makeFakeAdapter([{ username: "solo", role: "admin", password: "password123" }]);
    const solo = findUserByUsername(a, "solo");
    expect((await deleteUser(a, solo.id)).error).toBe("Cannot delete the last admin.");
    expect((await updateUser(a, solo.id, { role: "viewer" })).error).toBe("Cannot demote the last admin.");

    await createUser(a, { username: "second", password: "password123", role: "admin" });
    expect((await deleteUser(a, solo.id)).ok).toBe(true);

    const second = findUserByUsername(a, "second");
    expect((await updateUser(a, second.id, { role: "viewer" })).error).toBe("Cannot demote the last admin.");
  });

  it("updates password and role when valid", async () => {
    const a = makeFakeAdapter([
      { username: "admin1", role: "admin", password: "password123" },
      { username: "admin2", role: "admin", password: "password123" },
      { username: "view1", role: "viewer", password: "password123" },
    ]);
    const view1 = findUserByUsername(a, "view1");
    const res = await updateUser(a, view1.id, { password: "newpassword9", role: "admin" });
    expect(res.user.role).toBe("admin");
    expect(await authenticateUser(a, "view1", "newpassword9")).toBeTruthy();
    expect(await updateUser(a, view1.id, {})).toEqual({ error: "Nothing to update." });
  });

  it("lists users sorted by creation, without hashes", () => {
    const a = makeFakeAdapter([{ username: "b" }, { username: "a" }]);
    const names = listUsers(a).map((u) => u.username);
    expect(names).toEqual(["b", "a"]);
    expect(JSON.stringify(listUsers(a))).not.toContain("passwordHash");
  });
});

describe("authentication", () => {
  it("accepts correct credentials and rejects wrong user / wrong password", async () => {
    const a = makeFakeAdapter([{ username: "alice", password: "password123", role: "viewer" }]);
    const user = await authenticateUser(a, "alice", "password123");
    expect(user).toMatchObject({ username: "alice", role: "viewer" });
    expect(await authenticateUser(a, "alice", "wrong-pass-1")).toBeNull();
    expect(await authenticateUser(a, "bob", "password123")).toBeNull();
    expect(await authenticateUser(a, null, "password123")).toBeNull();
  });
});

describe("bootstrap", () => {
  it("creates the first admin from env once", async () => {
    const a = makeFakeAdapter();
    const env = { INITIAL_ADMIN_USER: "root", INITIAL_ADMIN_PASSWORD: "password123" };
    expect((await bootstrapUsers(a, env)).created).toBe(true);
    expect((await bootstrapUsers(a, env)).created).toBe(false); // idempotent
    expect(countAdmins(a)).toBe(1);
  });

  it("does nothing without env vars", async () => {
    const a = makeFakeAdapter();
    expect((await bootstrapUsers(a, {})).created).toBe(false);
    expect(countUsers(a)).toBe(0);
  });
});

describe("authCookieHeader", () => {
  it("serializes cookie attributes", () => {
    const req = new Request("http://x/");
    const h = authCookieHeader("tok", req);
    expect(h).toContain("auth_token=tok");
    expect(h).toContain("HttpOnly");
    expect(h).toContain("SameSite=Lax");
    expect(h).toContain("Path=/");
    expect(h).not.toContain("Secure");
  });

  it("adds Secure behind https / AUTH_COOKIE_SECURE", () => {
    expect(authCookieHeader("t", new Request("http://x/", { headers: { "x-forwarded-proto": "https" } }))).toContain("Secure");
  });
});
