/**
 * Per-user allowed-model ceilings for API keys (hono-server/userModelPolicy.js).
 *
 * Fake adapter over plain maps — same driver surface (run/get/all/exec) the
 * real adapters expose; covers the users table, apiKeys rows, and the kv store
 * (keyOwner + keyModelRestrictions scopes) without SQLite.
 */

import { describe, it, expect } from "vitest";
import {
  modelAllowedForUser,
  setApiKeyOwner,
  getApiKeyOwner,
  deleteApiKeyOwner,
  getAllApiKeyOwners,
  getUserAllowedModels,
} from "../../hono-server/userModelPolicy.js";

function makeFakeAdapter({ users = [], apiKeys = [] } = {}) {
  const kv = new Map(); // `${scope}\u0000${key}` → value
  const userRows = users.map((u) => ({ ...u }));
  return {
    kv,
    exec: () => {},
    get(sql, params) {
      if (sql.includes("FROM apiKeys WHERE key = ?")) {
        return apiKeys.find((k) => k.key === params[0]) || null;
      }
      if (sql.includes("FROM kv WHERE scope = ? AND key = ?")) {
        const v = kv.get(`${params[0]}\u0000${params[1]}`);
        return v !== undefined ? { value: v } : null;
      }
      if (sql.includes("allowedModels FROM dashboardUsers WHERE username = ?")) {
        return userRows.find((u) => u.username === params[0]) || null;
      }
      throw new Error(`fake adapter: unexpected get: ${sql}`);
    },
    all(sql, params) {
      if (sql.includes("FROM kv WHERE scope = ?")) {
        const prefix = `${params[0]}\u0000`;
        return [...kv.entries()]
          .filter(([k]) => k.startsWith(prefix))
          .map(([k, value]) => ({ key: k.slice(prefix.length), value }));
      }
      return [];
    },
    run(sql, params) {
      if (sql.startsWith("INSERT INTO kv")) {
        kv.set(`${params[0]}\u0000${params[1]}`, params[2]);
        return { changes: 1 };
      }
      if (sql.startsWith("DELETE FROM kv")) {
        kv.delete(`${params[0]}\u0000${params[1]}`);
        return { changes: 1 };
      }
      throw new Error(`fake adapter: unexpected run: ${sql}`);
    },
  };
}

describe("modelAllowedForUser (ceiling × per-key restriction)", () => {
  it("allows everything when both lists are unset", () => {
    expect(modelAllowedForUser(null, null, "any/model")).toBe(true);
    expect(modelAllowedForUser([], null, "any/model")).toBe(true);
    expect(modelAllowedForUser(null, [], "any/model")).toBe(true);
  });

  it("applies the per-key restriction alone", () => {
    expect(modelAllowedForUser(["sm/gpt-5.4"], null, "sm/gpt-5.4")).toBe(true);
    expect(modelAllowedForUser(["sm/gpt-5.4"], null, "sm/claude-4")).toBe(false);
  });

  it("applies the owner ceiling alone", () => {
    expect(modelAllowedForUser(null, ["sm/gpt-5.4"], "sm/gpt-5.4")).toBe(true);
    expect(modelAllowedForUser(null, ["sm/gpt-5.4"], "sm/claude-4")).toBe(false);
  });

  it("intersects the key restriction with the user ceiling", () => {
    // user a ∈ {a,b,c}, key narrowed to c
    const user = ["usera", "userb", "userc"];
    expect(modelAllowedForUser(["userc"], user, "userc")).toBe(true);
    expect(modelAllowedForUser(["usera"], user, "usera")).toBe(true);
    // key restriction grants a model outside the ceiling → ceiling wins
    expect(modelAllowedForUser(["userd"], user, "userd")).toBe(false);
    // glob key restriction still subject to the ceiling
    expect(modelAllowedForUser(["user*"], user, "userz")).toBe(false);
    expect(modelAllowedForUser(["user*"], user, "userb")).toBe(true);
  });

  it("supports glob patterns in the ceiling itself", () => {
    expect(modelAllowedForUser(null, ["sm/gpt-4.1-*"], "sm/gpt-4.1-nano")).toBe(true);
    expect(modelAllowedForUser(null, ["sm/gpt-4.1-*"], "sm/gpt-5.4")).toBe(false);
  });
});

describe("key-owner binding (kv scope)", () => {
  it("stores, reads, and deletes the owner", async () => {
    const a = makeFakeAdapter();
    await setApiKeyOwner("key-1", "alice", a);
    expect(await getApiKeyOwner("key-1", a)).toBe("alice");
    await setApiKeyOwner("key-1", "bob", a); // upsert
    expect(await getApiKeyOwner("key-1", a)).toBe("bob");
    await deleteApiKeyOwner("key-1", a);
    expect(await getApiKeyOwner("key-1", a)).toBeNull();
  });

  it("lists all bindings for dashboard key-list filtering", async () => {
    const a = makeFakeAdapter();
    await setApiKeyOwner("key-1", "alice", a);
    await setApiKeyOwner("key-2", "bob", a);
    expect(await getAllApiKeyOwners(a)).toEqual({ "key-1": "alice", "key-2": "bob" });
  });
});

describe("getUserAllowedModels", () => {
  it("returns null for missing users / empty lists, the list otherwise", async () => {
    const a = makeFakeAdapter({
      users: [
        { username: "alice", allowedModels: JSON.stringify(["sm/gpt-5.4"]) },
        { username: "empty", allowedModels: JSON.stringify([]) },
        { username: "broken", allowedModels: "not-json" },
      ],
    });
    expect(await getUserAllowedModels("alice", a)).toEqual(["sm/gpt-5.4"]);
    expect(await getUserAllowedModels("empty", a)).toBeNull();
    expect(await getUserAllowedModels("broken", a)).toBeNull();
    expect(await getUserAllowedModels("ghost", a)).toBeNull();
  });
});
