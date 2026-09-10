// Fork addition (not in upstream): per-API-key model restrictions.
// Stored in the existing kv table (scope 'keyModelRestrictions', key = apiKey id,
// value = JSON array of allowed model patterns) — no schema change needed.
// Patterns: exact model id ("sm/gpt-4.1-nano"), prefixless ("gpt-4.1-nano"
// matches any alias), or trailing-star glob ("sm/gpt-4.1-*").
import { getAdapter } from "../driver.js";
import { parseJson, stringifyJson } from "../helpers/jsonCol.js";

const SCOPE = "keyModelRestrictions";

// Pure matcher (exported for tests). Exact model ids only — no implicit
// provider-prefix magic, so a pattern can never grant access through a
// provider it was not written for. Trailing "*" is an explicit opt-in glob.
export function modelMatchesPattern(pattern, model) {
  if (!pattern || !model) return false;
  if (pattern === model) return true;
  if (pattern.endsWith("*")) return model.startsWith(pattern.slice(0, -1));
  return false;
}

export function modelAllowed(patterns, model) {
  if (!Array.isArray(patterns) || patterns.length === 0) return true; // unrestricted
  return patterns.some((p) => modelMatchesPattern(p, model));
}

export async function getKeyModelRestrictions(keyId) {
  if (!keyId) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT value FROM kv WHERE scope = ? AND key = ?`, [SCOPE, keyId]);
  const patterns = row ? parseJson(row.value, []) : null;
  return Array.isArray(patterns) && patterns.length > 0 ? patterns : null;
}

export async function getAllKeyModelRestrictions() {
  const db = await getAdapter();
  const rows = db.all(`SELECT key, value FROM kv WHERE scope = ?`, [SCOPE]);
  const out = {};
  for (const r of rows) {
    const patterns = parseJson(r.value, []);
    if (Array.isArray(patterns) && patterns.length > 0) out[r.key] = patterns;
  }
  return out;
}

export async function setKeyModelRestrictions(keyId, patterns) {
  if (!keyId) throw new Error("keyId required");
  const db = await getAdapter();
  db.run(
    `INSERT INTO kv(scope, key, value) VALUES(?, ?, ?)
     ON CONFLICT(scope, key) DO UPDATE SET value = excluded.value`,
    [SCOPE, keyId, stringifyJson(patterns)]
  );
}

export async function deleteKeyModelRestrictions(keyId) {
  if (!keyId) return;
  const db = await getAdapter();
  db.run(`DELETE FROM kv WHERE scope = ? AND key = ?`, [SCOPE, keyId]);
}

export async function findApiKeyIdByRawKey(rawKey) {
  if (!rawKey) return null;
  const db = await getAdapter();
  const row = db.get(`SELECT id FROM apiKeys WHERE key = ?`, [rawKey]);
  return row?.id || null;
}
