import { useEffect, useState } from "react";
import {
  listUsers,
  createUser,
  resetUserPassword,
  deleteUser,
  setUserRole,
} from "@/lib/auth.functions";

export default function UsersAdmin() {
  const [rows, setRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState("");
  const [showNew, setShowNew] = useState(false);
  const [nu, setNu] = useState({ username: "", password: "", role: "user" });
  const [busy, setBusy] = useState(false);

  const refresh = async () => {
    setErr("");
    setLoading(true);
    try {
      const list = await listUsers();
      setRows(list || []);
    } catch (e) {
      setErr(e?.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { refresh(); }, []);

  const onCreate = async (e) => {
    e.preventDefault();
    setBusy(true); setErr("");
    try {
      await createUser({ data: nu });
      setShowNew(false);
      setNu({ username: "", password: "", role: "user" });
      await refresh();
    } catch (e) { setErr(e?.message || String(e)); }
    finally { setBusy(false); }
  };

  const onResetPwd = async (row) => {
    const pwd = prompt(`New password for ${row.username}:`, "");
    if (!pwd) return;
    try { await resetUserPassword({ data: { userId: row.id, password: pwd } });
      alert("Password updated."); }
    catch (e) { alert("Failed: " + (e?.message || e)); }
  };

  const onChangeRole = async (row) => {
    const role = row.role === "admin" ? "user" : "admin";
    if (!confirm(`Change ${row.username} to ${role.toUpperCase()}?`)) return;
    try { await setUserRole({ data: { userId: row.id, role } }); await refresh(); }
    catch (e) { alert("Failed: " + (e?.message || e)); }
  };

  const onDelete = async (row) => {
    if (!confirm(`Delete user "${row.username}"? This cannot be undone.`)) return;
    try { await deleteUser({ data: { userId: row.id } }); await refresh(); }
    catch (e) { alert("Failed: " + (e?.message || e)); }
  };

  return (
    <div style={{ padding: "1.3rem", background: "#fff", flex: 1, overflowY: "auto" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 14 }}>
        <div>
          <div style={{ fontFamily: "var(--font-head)", fontSize: "1.1rem", fontWeight: 800, color: "#0f172a", letterSpacing: 1 }}>
            👥 USER MANAGEMENT
          </div>
          <div style={{ fontSize: ".78rem", color: "#6b7280", marginTop: 2 }}>
            Create logins, reset passwords, assign roles.
          </div>
        </div>
        <button
          onClick={() => setShowNew((v) => !v)}
          style={btnPrimary}
        >
          {showNew ? "Cancel" : "+ New User"}
        </button>
      </div>

      {err && <div style={{ color: "#b91c1c", marginBottom: 10, fontSize: ".82rem" }}>{err}</div>}

      {showNew && (
        <form onSubmit={onCreate} style={{ border: "1px solid #e5e7eb", borderRadius: 10, padding: 14, marginBottom: 14, background: "#f9fafb", display: "grid", gridTemplateColumns: "1fr 1fr auto auto", gap: 10, alignItems: "end" }}>
          <div>
            <label style={lbl}>Username</label>
            <input value={nu.username} onChange={(e) => setNu({ ...nu, username: e.target.value })} placeholder="e.g. rahul01" autoCapitalize="off" style={inp} required />
          </div>
          <div>
            <label style={lbl}>Password</label>
            <input value={nu.password} onChange={(e) => setNu({ ...nu, password: e.target.value })} type="text" style={inp} required minLength={4} />
          </div>
          <div>
            <label style={lbl}>Role</label>
            <select value={nu.role} onChange={(e) => setNu({ ...nu, role: e.target.value })} style={inp}>
              <option value="user">User</option>
              <option value="admin">Admin</option>
            </select>
          </div>
          <button type="submit" disabled={busy} style={btnPrimary}>
            {busy ? "Creating…" : "Create"}
          </button>
        </form>
      )}

      {loading ? (
        <div style={{ color: "#6b7280", fontSize: ".85rem" }}>Loading users…</div>
      ) : rows.length === 0 ? (
        <div style={{ color: "#6b7280", fontSize: ".85rem" }}>No users yet.</div>
      ) : (
        <div style={{ border: "1px solid #e5e7eb", borderRadius: 10, overflow: "hidden" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".88rem" }}>
            <thead style={{ background: "#f3f4f6" }}>
              <tr>
                <th style={th}>Username</th>
                <th style={th}>Role</th>
                <th style={th}>Created</th>
                <th style={{ ...th, textAlign: "right" }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} style={{ borderTop: "1px solid #f3f4f6" }}>
                  <td style={td}><b>{r.username}</b></td>
                  <td style={td}>
                    <span style={{
                      padding: "2px 8px", borderRadius: 6, fontSize: ".7rem", fontWeight: 800, letterSpacing: 1, textTransform: "uppercase",
                      background: r.role === "admin" ? "#fef3c7" : "#e0e7ff",
                      color: r.role === "admin" ? "#92400e" : "#3730a3",
                    }}>{r.role}</span>
                  </td>
                  <td style={{ ...td, color: "#6b7280", fontSize: ".78rem" }}>
                    {r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}
                  </td>
                  <td style={{ ...td, textAlign: "right" }}>
                    <button onClick={() => onResetPwd(r)} style={btnSm}>Reset PW</button>
                    <button onClick={() => onChangeRole(r)} style={btnSm}>
                      Make {r.role === "admin" ? "User" : "Admin"}
                    </button>
                    <button onClick={() => onDelete(r)} style={{ ...btnSm, color: "#b91c1c", borderColor: "#fecaca" }}>
                      Delete
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

const lbl = { display: "block", fontSize: ".64rem", fontWeight: 800, letterSpacing: 1.2, color: "#6b7280", textTransform: "uppercase", marginBottom: 4 };
const inp = { width: "100%", padding: ".55rem .7rem", border: "1px solid #d1d5db", borderRadius: 7, fontSize: ".88rem", outline: "none", boxSizing: "border-box", background: "#fff" };
const btnPrimary = { background: "#1e3a8a", color: "#fff", border: "none", padding: ".55rem 1rem", borderRadius: 7, fontWeight: 800, fontSize: ".82rem", cursor: "pointer", letterSpacing: .5, textTransform: "uppercase" };
const btnSm = { background: "#fff", border: "1px solid #e5e7eb", padding: ".35rem .65rem", borderRadius: 6, fontSize: ".75rem", fontWeight: 700, cursor: "pointer", marginLeft: 6, color: "#1f2937" };
const th = { textAlign: "left", padding: ".6rem .8rem", fontSize: ".68rem", letterSpacing: 1, textTransform: "uppercase", color: "#6b7280", fontWeight: 800 };
const td = { padding: ".55rem .8rem", verticalAlign: "middle" };
