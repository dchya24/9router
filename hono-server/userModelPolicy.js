// Fork feature: per-USER allowed-model ceilings driving API-key access.
//
// Each dashboard user can carry an optional allowedModels list (dashboardUsers
// table, parse/validate in hono-server/users.js). API keys created from a
// username session are bound to that user (kv scope 'keyOwner', following the
// keyModelRestrictionsRepo kv pattern — no upstream schema changes; binding
// happens in the /api/keys route overrides registered by hono-server/users.js).
//
// Effective model policy for a bound key at request time:
//
//   allowed(model) = modelAllowed(keyRestrictions, model)
//                 && modelAllowed(ownerAllowedModels, model)
//
// So the user's list is a CEILING on every key they own and the per-key
// restriction can narrow it further (user a ∈ {a,b,c}, key a1 only c).
// Changing a user's list takes effect immediately for all their keys.
// Unbound keys (created before this feature or by legacy shared-password
// sessions) are not subject to any ceiling. Tests: tests/unit/userModelPolicy.test.js.

import { getAdapter } from "@/lib/db/driver.js";
import {
  modelAllowed,
  getKeyModelRestrictions,
} from "@/lib/db/repos/keyModelRestrictionsRepo.js";
import { parseAllowedModels } from "./users.js";

const OWNER_SCOPE = "keyOwner";

// ── Pure decision (unit-tested) ─────────────────────────────────────────────
// keyPatterns/ownerPatterns: null | [] = unrestricted. The owner list acts as
// a ceiling; the per-key list narrows further. A model must satisfy both.
export function modelAllowedForUser(keyPatterns, ownerPatterns, model) {
  if (!modelAllowed(keyPatterns, model)) return false;
  if (ownerPatterns && !modelAllowed(ownerPatterns, model)) return false;
  return true;
}

// ── kv-backed owner binding (driver surface identical to the adapters;
//    adapter injectable for tests, defaults to the real bun:sqlite driver) ──

export async function setApiKeyOwner(keyId, username, db = null) {
  if (!keyId || !username) throw new Error("keyId and username required");
  db ??= await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [OWNER_SCOPE, keyId, username]
  );
}

export async function getApiKeyOwner(keyId, db = null) {
  if (!keyId) return null;
  db ??= await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [OWNER_SCOPE, keyId]);
  return row?.value || null;
}

export async function deleteApiKeyOwner(keyId, db = null) {
  if (!keyId) return;
  db ??= await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [OWNER_SCOPE, keyId]);
}

export async function getUserAllowedModels(username, db = null) {
  if (!username) return null;
  db ??= await getAdapter();
  const row = db.get(`SELECT allowedModels FROM dashboardUsers WHERE username = ?`, [username]);
  const list = parseAllowedModels(row?.allowedModels);
  return list.length ? list : null;
}

// Resolves the in-force policy for a raw LLM API key: per-key restriction
// patterns intersected with the owner user's allowed-models ceiling.
//   → { keyId, keyPatterns, ownerPatterns } or null for unknown keys
export async function getEffectiveKeyPolicy(rawKey) {
  if (!rawKey) return null;
  const db = await getAdapter();
  let row;
  try {
    row = db.get(`SELECT id FROM apiKeys WHERE key = ?`, [rawKey]);
  } catch {
    return null;
  }
  if (!row?.id) return null;

  const [keyPatterns, owner] = await Promise.all([
    getKeyModelRestrictions(row.id),
    getApiKeyOwner(row.id, db),
  ]);
  let ownerPatterns = null;
  if (owner) {
    try {
      ownerPatterns = await getUserAllowedModels(owner, db);
    } catch {
      ownerPatterns = null; // missing users table etc. — no ceiling
    }
  }
  return { keyId: row.id, keyPatterns, ownerPatterns };
}
