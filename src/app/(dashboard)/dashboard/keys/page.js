"use client";

// Fork feature: per-API-key model restrictions (/dashboard/keys).
// Zero upstream files touched — own page, own route (/api/key-models), and
// enforcement lives in hono-server/guard.js.
//
// Pattern syntax (comma separated), exact ids only:
//   sm/gpt-4.1-nano     exact model id
//   sm/gpt-4.1-*        trailing-star glob (explicit opt-in)
// The same model on another alias (trx/gpt-4.1-nano) is a different id and
// stays blocked. Empty = unrestricted (all models).

import { useEffect, useMemo, useState } from "react";

const inputStyle = {
  padding: "8px 10px",
  borderRadius: 6,
  border: "1px solid #444",
  background: "transparent",
  color: "inherit",
};

const btnStyle = {
  padding: "8px 14px",
  borderRadius: 6,
  border: "1px solid #556",
  background: "#2a2d3a",
  color: "inherit",
  cursor: "pointer",
};

const cardStyle = { border: "1px solid #333", borderRadius: 8, padding: 14 };
const mono = { fontFamily: "monospace", fontSize: 12 };

export default function KeysPage() {
  const [keys, setKeys] = useState(null);
  const [restrictions, setRestrictions] = useState({});
  const [drafts, setDrafts] = useState({});
  const [modelOptions, setModelOptions] = useState([]);
  const [saving, setSaving] = useState({});
  const [notice, setNotice] = useState(null);
  const [newName, setNewName] = useState("");
  const [newPatterns, setNewPatterns] = useState("");
  const [creating, setCreating] = useState(false);

  const toPatterns = (value) =>
    String(value).split(",").map((p) => p.trim()).filter(Boolean);

  async function refresh() {
    const [keysRes, restrictionsRes] = await Promise.all([
      fetch("/api/keys").then((r) => r.json()),
      fetch("/api/key-models").then((r) => r.json()),
    ]);
    const list = keysRes.keys || [];
    setKeys(list);
    const byId = {};
    for (const r of restrictionsRes.restrictions || []) byId[r.keyId] = r.patterns || [];
    setRestrictions(byId);
    setDrafts(Object.fromEntries(list.map((k) => [k.id, (byId[k.id] || []).join(", ")])));
  }

  useEffect(() => {
    refresh().catch(() => setNotice("Failed to load keys"));
    fetch("/v1/models")
      .then((r) => (r.ok ? r.json() : { data: [] }))
      .then((d) => setModelOptions((d.data || []).map((m) => m.id)))
      .catch(() => {});
  }, []);

  const sortedKeys = useMemo(
    () => [...(keys || [])].sort((a, b) => String(a.name).localeCompare(String(b.name))),
    [keys]
  );

  // Create key and (optionally) apply its model restrictions in one step.
  async function createKey() {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    setNotice(null);
    try {
      const res = await fetch("/api/keys", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        setNotice("Create failed");
        return;
      }
      const created = await res.json();
      const patterns = toPatterns(newPatterns);
      if (created?.id && patterns.length > 0) {
        const put = await fetch("/api/key-models", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ keyId: created.id, patterns }),
        });
        setNotice(put.ok ? "Key created with model restrictions" : "Key created, but restrictions failed");
      } else {
        setNotice("Key created");
      }
      setNewName("");
      setNewPatterns("");
      await refresh();
    } finally {
      setCreating(false);
    }
  }

  async function savePatterns(keyId) {
    setSaving((s) => ({ ...s, [keyId]: true }));
    setNotice(null);
    const res = await fetch("/api/key-models", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ keyId, patterns: toPatterns(drafts[keyId] || "") }),
    });
    setSaving((s) => ({ ...s, [keyId]: false }));
    setNotice(res.ok ? "Saved" : "Save failed");
    if (res.ok) await refresh();
  }

  async function deleteKey(keyId, name) {
    if (!confirm(`Delete API key "${name}"?`)) return;
    await fetch(`/api/keys/${keyId}`, { method: "DELETE" });
    await fetch(`/api/key-models?keyId=${encodeURIComponent(keyId)}`, { method: "DELETE" });
    await refresh();
  }

  if (keys === null) return <p style={{ padding: 24, color: "#888" }}>Loading keys…</p>;

  return (
    <div style={{ maxWidth: 940, margin: "0 auto", padding: 24 }}>
      <h1 style={{ fontSize: 22, marginBottom: 4 }}>API Keys &amp; Model Restrictions</h1>
      <p style={{ color: "#888", marginBottom: 20 }}>
        Restrict which models each key may call. Use exact ids — e.g.{" "}
        <code style={mono}>sm/gpt-4.1-nano</code> — or an explicit glob like{" "}
        <code style={mono}>sm/gpt-4.1-*</code>. Ids are matched exactly, so the same
        model under another alias stays blocked. Empty = all models allowed.
        Rejected calls return <code style={mono}>403 model_not_allowed</code>.
      </p>

      <div style={{ ...cardStyle, marginBottom: 20 }}>
        <strong>Create key</strong>
        <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap" }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Key name"
            style={{ ...inputStyle, minWidth: 180 }}
          />
          <input
            list="model-options"
            value={newPatterns}
            onChange={(e) => setNewPatterns(e.target.value)}
            placeholder="Model restrictions (optional), e.g. sm/gpt-4.1-nano"
            style={{ ...inputStyle, flex: 1, minWidth: 280, ...mono }}
          />
          <button onClick={createKey} disabled={creating} style={btnStyle}>
            {creating ? "…" : "Create"}
          </button>
        </div>
      </div>

      <datalist id="model-options">
        {modelOptions.slice(0, 1000).map((m) => (
          <option key={m} value={m} />
        ))}
      </datalist>

      {notice && <p style={{ color: "#4a9", marginBottom: 12 }}>{notice}</p>}

      <div style={{ display: "grid", gap: 12 }}>
        {sortedKeys.map((k) => {
          const restricted = (restrictions[k.id] || []).length > 0;
          return (
            <div key={k.id} style={cardStyle}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 12 }}>
                <div style={{ minWidth: 0 }}>
                  <strong>{k.name}</strong>
                  <span style={{ color: "#888", marginLeft: 10, ...mono }}>
                    {String(k.key).slice(0, 12)}…
                  </span>
                  <span style={{ marginLeft: 10, ...mono, color: restricted ? "#e9a" : "#8a8" }}>
                    {restricted ? `restricted (${restrictions[k.id].length})` : "all models"}
                  </span>
                </div>
                <button
                  onClick={() => deleteKey(k.id, k.name)}
                  style={{ ...btnStyle, background: "#722", borderColor: "#944" }}
                >
                  Delete
                </button>
              </div>
              <div style={{ display: "flex", gap: 8, marginTop: 10 }}>
                <input
                  list="model-options"
                  value={drafts[k.id] ?? ""}
                  onChange={(e) => setDrafts((d) => ({ ...d, [k.id]: e.target.value }))}
                  placeholder="all models (no restriction)"
                  style={{ ...inputStyle, flex: 1, ...mono }}
                />
                <button onClick={() => savePatterns(k.id)} disabled={!!saving[k.id]} style={btnStyle}>
                  {saving[k.id] ? "…" : "Save"}
                </button>
              </div>
            </div>
          );
        })}
        {sortedKeys.length === 0 && (
          <p style={{ color: "#888" }}>No API keys yet — create one above.</p>
        )}
      </div>
    </div>
  );
}
