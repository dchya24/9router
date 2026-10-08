"use client";

// Fork: multi-user auth panel (hono-server/users.js backend).
// Admin-only CRUD for dashboard users; the "My password" card works for any
// username-session user (admins and viewers alike).

import { useState, useEffect, useCallback } from "react";
import { Card, Button, Input } from "@/shared/components";
import Modal, { ConfirmModal } from "@/shared/components/Modal";

const ROLES = ["admin", "viewer"];

export default function UsersPage() {
  const [me, setMe] = useState({ username: null, role: null, multiUser: false });
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [forbidden, setForbidden] = useState(false);
  const [notice, setNotice] = useState({ type: "", message: "" });

  const [form, setForm] = useState({ username: "", password: "", role: "viewer" });
  const [creating, setCreating] = useState(false);
  const [edit, setEdit] = useState(null); // {id, username, role, password}
  const [savingEdit, setSavingEdit] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" });
  const [pwSaving, setPwSaving] = useState(false);

  const flash = (type, message) => {
    setNotice({ type, message });
    setTimeout(() => setNotice({ type: "", message: "" }), 4000);
  };

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const s = await fetch("/api/auth/status").then((r) => r.json());
      setMe({ username: s.displayName || null, role: null, multiUser: s.multiUser === true });
      const res = await fetch("/api/users");
      if (res.status === 403) {
        setForbidden(true);
      } else if (res.ok) {
        const data = await res.json();
        setUsers(data.users || []);
        const meRow = (data.users || []).find((u) => u.username === s.displayName);
        if (meRow) setMe((m) => ({ ...m, role: meRow.role }));
        setForbidden(false);
      }
    } catch {
      flash("error", "Failed to load users.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async (e) => {
    e.preventDefault();
    setCreating(true);
    try {
      const res = await fetch("/api/users", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const data = await res.json();
      if (res.ok) {
        setForm({ username: "", password: "", role: "viewer" });
        flash("success", `User "${data.user.username}" created.`);
        load();
      } else {
        flash("error", data.error || "Failed to create user.");
      }
    } catch {
      flash("error", "Failed to create user.");
    } finally {
      setCreating(false);
    }
  };

  const handleSaveEdit = async () => {
    if (!edit) return;
    setSavingEdit(true);
    try {
      const body = { role: edit.role };
      if (edit.password) body.password = edit.password;
      const res = await fetch(`/api/users/${edit.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (res.ok) {
        setEdit(null);
        flash("success", "User updated.");
        load();
      } else {
        flash("error", data.error || "Failed to update user.");
      }
    } catch {
      flash("error", "Failed to update user.");
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      const res = await fetch(`/api/users/${confirmDelete.id}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        flash("success", `User "${confirmDelete.username}" deleted.`);
        load();
      } else {
        flash("error", data.error || "Failed to delete user.");
      }
    } catch {
      flash("error", "Failed to delete user.");
    } finally {
      setConfirmDelete(null);
    }
  };

  const handleOwnPassword = async (e) => {
    e.preventDefault();
    if (pw.next !== pw.confirm) {
      flash("error", "New passwords do not match.");
      return;
    }
    setPwSaving(true);
    try {
      const res = await fetch("/api/users/me", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword: pw.current, newPassword: pw.next }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setPw({ current: "", next: "", confirm: "" });
        flash("success", "Password changed.");
      } else {
        flash("error", data.error || "Failed to change password.");
      }
    } catch {
      flash("error", "Failed to change password.");
    } finally {
      setPwSaving(false);
    }
  };

  const showNotice =
    notice.message &&
    (notice.type === "error" ? (
      <p className="text-xs text-red-500">{notice.message}</p>
    ) : (
      <p className="text-xs text-emerald-600 dark:text-emerald-400">{notice.message}</p>
    ));

  return (
    <div className="p-4 space-y-4 max-w-3xl mx-auto">
      <div>
        <h1 className="text-xl font-semibold">Users</h1>
        <p className="text-xs text-text-muted mt-1">
          Dashboard access accounts. {me.multiUser ? "" : "Multi-user mode is inactive — the shared password is still in effect until the first admin user exists."}
        </p>
      </div>

      {showNotice && <div className="text-xs">{showNotice}</div>}

      {loading ? (
        <Card><p className="text-xs text-text-muted">Loading…</p></Card>
      ) : forbidden ? (
        <Card>
          <p className="text-sm text-amber-600 dark:text-amber-400">
            Admin role required. Your account can still change its own password below.
          </p>
        </Card>
      ) : (
        <>
          <Card className="p-4">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-left text-text-muted border-b border-border/60">
                    <th className="py-2 pr-3 font-medium">Username</th>
                    <th className="py-2 pr-3 font-medium">Role</th>
                    <th className="py-2 pr-3 font-medium">Created</th>
                    <th className="py-2 font-medium text-right">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((u) => (
                    <tr key={u.id} className="border-b border-border/40 last:border-0">
                      <td className="py-2 pr-3 font-medium">
                        {u.username}
                        {u.username === me.username && (
                          <span className="ml-2 text-[10px] px-1.5 py-0.5 rounded bg-primary/10 text-primary">you</span>
                        )}
                      </td>
                      <td className="py-2 pr-3">
                        <span
                          className={
                            "text-[10px] px-1.5 py-0.5 rounded " +
                            (u.role === "admin"
                              ? "bg-primary/10 text-primary"
                              : "bg-surface-2 text-text-muted")
                          }
                        >
                          {u.role}
                        </span>
                      </td>
                      <td className="py-2 pr-3 text-text-muted">{(u.createdAt || "").slice(0, 10)}</td>
                      <td className="py-2 text-right space-x-2 whitespace-nowrap">
                        <Button variant="ghost" className="text-xs" onClick={() => setEdit({ ...u, password: "" })}>
                          Edit
                        </Button>
                        <Button variant="ghost" className="text-xs text-red-500" onClick={() => setConfirmDelete(u)}>
                          Delete
                        </Button>
                      </td>
                    </tr>
                  ))}
                  {users.length === 0 && (
                    <tr>
                      <td colSpan={4} className="py-3 text-text-muted">
                        No users yet. Create the first admin below.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </Card>

          <Card className="p-4">
            <h2 className="text-sm font-semibold mb-3">Create user</h2>
            <form onSubmit={handleCreate} className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-2 items-end">
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Username</label>
                <Input value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} placeholder="3–32 chars" required />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Password</label>
                <Input type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} placeholder="min 8 chars" required />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-xs font-medium">Role</label>
                <select
                  className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                >
                  {ROLES.map((r) => (
                    <option key={r} value={r}>{r}</option>
                  ))}
                </select>
              </div>
              <Button type="submit" variant="primary" loading={creating} className="text-xs">
                Add
              </Button>
            </form>
          </Card>
        </>
      )}

      <Card className="p-4">
        <h2 className="text-sm font-semibold mb-1">My password</h2>
        <p className="text-xs text-text-muted mb-3">
          {me.username ? `Signed in as ${me.username}.` : "Signed in with the shared password — nothing to change here."}
        </p>
        {me.username && (
          <form onSubmit={handleOwnPassword} className="grid grid-cols-1 sm:grid-cols-3 gap-2 items-end">
            <Input type="password" placeholder="Current password" value={pw.current} onChange={(e) => setPw({ ...pw, current: e.target.value })} required />
            <Input type="password" placeholder="New password (min 8)" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} required />
            <div className="flex gap-2">
              <Input type="password" placeholder="Confirm" value={pw.confirm} onChange={(e) => setPw({ ...pw, confirm: e.target.value })} required />
              <Button type="submit" variant="primary" loading={pwSaving} className="text-xs whitespace-nowrap">
                Change
              </Button>
            </div>
          </form>
        )}
      </Card>

      <Modal isOpen={!!edit} onClose={() => setEdit(null)} title={`Edit ${edit?.username || ""}`}>
        {edit && (
          <div className="flex flex-col gap-3">
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium">Role</label>
              <select
                className="h-9 rounded-lg border border-border bg-surface px-2 text-xs"
                value={edit.role}
                onChange={(e) => setEdit({ ...edit, role: e.target.value })}
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>{r}</option>
                ))}
              </select>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs font-medium">New password</label>
              <Input
                type="password"
                placeholder="Leave blank to keep current"
                value={edit.password}
                onChange={(e) => setEdit({ ...edit, password: e.target.value })}
              />
            </div>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setEdit(null)}>Cancel</Button>
              <Button variant="primary" loading={savingEdit} onClick={handleSaveEdit}>Save</Button>
            </div>
          </div>
        )}
      </Modal>

      <ConfirmModal
        isOpen={!!confirmDelete}
        onClose={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
        title="Delete user"
        message={confirmDelete ? `Delete user "${confirmDelete.username}"? This cannot be undone.` : ""}
      />
    </div>
  );
}
