/**
 * Self-service API-key ownership rules (hono-server/accessControl.js).
 *
 * Pure functions — no Hono, no SQLite. These back the guard's viewer
 * write-allowlist and the ownership checks in hono-server/users.js.
 */

import { describe, it, expect } from "vitest";
import {
  viewerWriteBlocked,
  sessionIsPrivileged,
  canManageKey,
  filterKeysForSession,
  filterRestrictionsForSession,
} from "../../hono-server/accessControl.js";

const viewer = { sub: "alice", role: "viewer" };
const otherViewer = { sub: "bob", role: "viewer" };
const admin = { sub: "root", role: "admin" };

describe("viewerWriteBlocked", () => {
  it("never blocks reads", () => {
    expect(viewerWriteBlocked("GET", "/api/keys")).toBe(false);
    expect(viewerWriteBlocked("GET", "/api/settings")).toBe(false);
    expect(viewerWriteBlocked("HEAD", "/api/keys/1")).toBe(false);
  });

  it("allows session endpoints and self-service key routes", () => {
    expect(viewerWriteBlocked("POST", "/api/auth/login")).toBe(false);
    expect(viewerWriteBlocked("POST", "/api/auth/logout")).toBe(false);
    expect(viewerWriteBlocked("PATCH", "/api/users/me")).toBe(false);
    expect(viewerWriteBlocked("POST", "/api/keys")).toBe(false);
    expect(viewerWriteBlocked("POST", "/api/keys/")).toBe(false);
    expect(viewerWriteBlocked("PUT", "/api/keys/abc-123")).toBe(false);
    expect(viewerWriteBlocked("DELETE", "/api/keys/abc-123")).toBe(false);
    expect(viewerWriteBlocked("PUT", "/api/key-models")).toBe(false);
    expect(viewerWriteBlocked("DELETE", "/api/key-models")).toBe(false);
    expect(viewerWriteBlocked("PUT", "/api/key-models/")).toBe(false);
  });

  it("keeps everything else denied", () => {
    expect(viewerWriteBlocked("POST", "/api/settings")).toBe(true);
    expect(viewerWriteBlocked("POST", "/api/providers")).toBe(true);
    expect(viewerWriteBlocked("POST", "/api/users")).toBe(true);
    expect(viewerWriteBlocked("PUT", "/api/key-models/extra")).toBe(true);
    expect(viewerWriteBlocked("DELETE", "/api/keys")).toBe(true);
    expect(viewerWriteBlocked("PUT", "/api/keys/abc/extra")).toBe(true);
    expect(viewerWriteBlocked("PATCH", "/api/keys/abc")).toBe(true);
  });

  it("ignores non-API paths", () => {
    expect(viewerWriteBlocked("POST", "/v1/chat/completions")).toBe(false);
    expect(viewerWriteBlocked("POST", "/dashboard/whatever")).toBe(false);
  });
});

describe("sessionIsPrivileged", () => {
  it("treats legacy / CLI sessions and admins as privileged", () => {
    expect(sessionIsPrivileged(null)).toBe(true);
    expect(sessionIsPrivileged({})).toBe(true);
    expect(sessionIsPrivileged({ authenticated: true })).toBe(true); // shared password
    expect(sessionIsPrivileged({ sub: "root" })).toBe(true); // role claim absent
    expect(sessionIsPrivileged(admin)).toBe(true);
  });

  it("treats viewers as unprivileged", () => {
    expect(sessionIsPrivileged(viewer)).toBe(false);
    expect(sessionIsPrivileged(otherViewer)).toBe(false);
  });
});

describe("canManageKey", () => {
  it("lets a viewer manage only its own keys", () => {
    expect(canManageKey(viewer, "alice")).toBe(true);
    expect(canManageKey(viewer, "bob")).toBe(false);
    expect(canManageKey(viewer, null)).toBe(false); // unowned legacy key
    expect(canManageKey(viewer, undefined)).toBe(false);
  });

  it("lets privileged sessions manage anything", () => {
    expect(canManageKey(admin, "alice")).toBe(true);
    expect(canManageKey(admin, null)).toBe(true);
    expect(canManageKey(null, "alice")).toBe(true);
  });
});

describe("filterKeysForSession / filterRestrictionsForSession", () => {
  const keys = [
    { id: "k1", name: "alice-1" },
    { id: "k2", name: "bob-1" },
    { id: "k3", name: "legacy-unowned" },
  ];
  const owners = { k1: "alice", k2: "bob" };

  it("shows a viewer only its own keys", () => {
    expect(filterKeysForSession(keys, owners, viewer).map((k) => k.id)).toEqual(["k1"]);
    expect(filterKeysForSession(keys, owners, otherViewer).map((k) => k.id)).toEqual(["k2"]);
  });

  it("shows admins and legacy sessions everything", () => {
    expect(filterKeysForSession(keys, owners, admin)).toHaveLength(3);
    expect(filterKeysForSession(keys, owners, null)).toHaveLength(3);
    expect(filterKeysForSession(keys, owners, { authenticated: true })).toHaveLength(3);
  });

  it("filters key-model restriction rows the same way", () => {
    const restrictions = [
      { keyId: "k1", keyName: "alice-1", patterns: ["a/*"] },
      { keyId: "k2", keyName: "bob-1", patterns: [] },
      { keyId: "k3", keyName: "legacy-unowned", patterns: [] },
    ];
    expect(filterRestrictionsForSession(restrictions, owners, viewer).map((r) => r.keyId)).toEqual(["k1"]);
    expect(filterRestrictionsForSession(restrictions, owners, otherViewer).map((r) => r.keyId)).toEqual(["k2"]);
    expect(filterRestrictionsForSession(restrictions, owners, admin)).toHaveLength(3);
  });

  it("tolerates malformed input", () => {
    expect(filterKeysForSession(null, null, viewer)).toEqual([]);
    expect(filterRestrictionsForSession(undefined, undefined, viewer)).toEqual([]);
    expect(filterKeysForSession(keys, null, viewer)).toEqual([]); // unowned only → none visible
  });
});
