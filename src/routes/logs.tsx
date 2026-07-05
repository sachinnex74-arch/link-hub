import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { getAuditLogsFn } from "@/lib/tms.functions";
import { ArrowLeft } from "lucide-react";

export const Route = createFileRoute("/logs")({
  component: LogsPage,
  head: () => ({
    meta: [
      { name: "robots", content: "noindex, nofollow" },
      { title: "Activity Logs" },
    ],
  }),
});

type Entry = {
  id: string;
  at: string;
  action: string;
  entityType?: string;
  entityId?: string | null;
  lid?: string | null;
  userId?: string | null;
  email?: string | null;
  source: string;
  details: any;
};

const PAGE_SIZE = 50;

const ACTION_FILTERS: { key: string; label: string; actions: string[]; entityType?: string }[] = [
  { key: "all",       label: "All",           actions: [] },
  { key: "loads",     label: "Loads",         actions: [], entityType: "load" },
  { key: "vehicles",  label: "Vehicles",      actions: [], entityType: "vehicle" },
  { key: "create",    label: "Created",       actions: ["load.create", "vehicle.create"] },
  { key: "assign",    label: "Assigned",      actions: ["load.assign"] },
  { key: "unassign",  label: "Unassigned",    actions: ["load.unassign"] },
  { key: "status",    label: "Status",        actions: ["load.status_change", "vehicle.status_change"] },
  { key: "delivered", label: "Delivered",     actions: ["load.delivered"] },
  { key: "delete",    label: "Deleted",       actions: ["load.delete"] },
];

function actionChip(action: string) {
  const map: Record<string, { bg: string; fg: string; label: string }> = {
    "load.create":            { bg: "#dbeafe", fg: "#1e3a8a", label: "Created" },
    "load.assign":            { bg: "#fef3c7", fg: "#92400e", label: "Assigned" },
    "load.unassign":          { bg: "#fde68a", fg: "#78350f", label: "Unassigned" },
    "load.status_change":     { bg: "#e0e7ff", fg: "#3730a3", label: "Status" },
    "load.delivered":         { bg: "#dcfce7", fg: "#166534", label: "Delivered" },
    "load.delete":            { bg: "#fee2e2", fg: "#991b1b", label: "Deleted" },
    "vehicle.create":         { bg: "#dbeafe", fg: "#1e3a8a", label: "Vehicle created" },
    "vehicle.status_change":  { bg: "#e0e7ff", fg: "#3730a3", label: "Vehicle status" },
    "vehicle.driver_change":  { bg: "#fef3c7", fg: "#92400e", label: "Driver changed" },
    "vehicle.mobile_change":  { bg: "#f3e8ff", fg: "#6b21a8", label: "Mobile changed" },
  };
  return map[action] || { bg: "#e2e8f0", fg: "#334155", label: action };
}

function detailsText(e: Entry): string {
  const d = e.details || {};
  switch (e.action) {
    case "load.assign":           return `Assigned to ${d.vnum || d.vehicleId || "—"}`;
    case "load.unassign":         return `Unassigned from ${d.vnum || d.vehicleId || "—"}`;
    case "load.status_change":    return `${d.from || "—"} → ${d.to || "—"}${d.vnum ? ` (${d.vnum})` : ""}`;
    case "load.delivered":        return `Delivered${d.from ? ` (was ${d.from})` : ""}${d.vnum ? ` · ${d.vnum}` : ""}`;
    case "load.create":           return [d.customer, d.origin && d.dest ? `${d.origin} → ${d.dest}` : null].filter(Boolean).join(" · ") || "—";
    case "load.delete":           return [d.customer, d.origin && d.dest ? `${d.origin} → ${d.dest}` : null, d.vnum && `vehicle ${d.vnum}`].filter(Boolean).join(" · ") || "—";
    case "vehicle.create":        return `${d.vnum || "—"}${d.vtype ? ` · ${d.vtype}` : ""}`;
    case "vehicle.status_change": return `${d.from || "—"} → ${d.to || "—"}`;
    case "vehicle.driver_change": return `Driver: ${d.from || "—"} → ${d.to || "—"}`;
    case "vehicle.mobile_change": return `Mobile: ${d.from || "—"} → ${d.to || "—"}`;
    default: return "—";
  }
}

function LogsPage() {
  const [entries, setEntries] = useState<Entry[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filterKey, setFilterKey] = useState("all");
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState("");
  const [searchInput, setSearchInput] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const filter = ACTION_FILTERS.find((f) => f.key === filterKey)!;
      const res = await getAuditLogsFn({
        data: {
          limit: PAGE_SIZE,
          offset: page * PAGE_SIZE,
          actions: filter.actions.length ? filter.actions : undefined,
          entityType: filter.entityType,
          search: search || undefined,
        },
      });
      setEntries((res.entries as Entry[]) || []);
      setTotal(res.total || 0);
    } catch (e: any) {
      setError(e?.message || "Failed to load logs");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [filterKey, page, search]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));

  return (
    <div style={{ minHeight: "100vh", background: "#f0f2f5", fontFamily: "system-ui, sans-serif", color: "#0f172a" }}>
      <div style={{ background: "#ffffff", borderBottom: "1px solid #e4e7ed", padding: "0 1.4rem", display: "flex", alignItems: "center", justifyContent: "space-between", height: 54, boxShadow: "0 1px 3px rgba(0,0,0,0.06)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 16 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div style={{ width: 30, height: 30, borderRadius: 8, background: "#111827", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
              <ArrowLeft size={15} color="#ffffff"/>
            </div>
            <span style={{ fontFamily: "'Inter',system-ui,sans-serif", fontSize: ".9rem", fontWeight: 600, color: "#111827", letterSpacing: "-0.2px" }}>FleetCommand</span>
          </div>
          <div style={{ width: 1, height: 18, background: "#e4e7ed" }} />
          <Link to="/app" style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#6b7280", textDecoration: "none", fontSize: ".78rem", fontWeight: 500 }}>
            Back to app
          </Link>
        </div>
      </div>

      <div style={{ padding: 24, maxWidth: 1300, margin: "0 auto" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 6, flexWrap: "wrap", gap: 12 }}>
          <h1 style={{ fontSize: 22, fontWeight: 600, margin: 0 }}>Activity Logs</h1>
          <button onClick={() => { setPage(0); load(); }} style={{ background: "#1e3a8a", color: "white", border: "none", padding: "6px 12px", borderRadius: 6, cursor: "pointer", fontSize: 13 }}>Refresh</button>
        </div>
        <p style={{ margin: "0 0 14px", color: "#64748b", fontSize: 13 }}>Deliberate changes only · last 3 days · auto GPS/cron events excluded.</p>

        {/* Search */}
        <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") { setSearch(searchInput.trim()); setPage(0); } }}
            placeholder="Search by Load ID (LD-443) or vehicle number (HR55BB0812)…"
            style={{ flex: 1, padding: "6px 12px", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: 13, outline: "none" }}
          />
          <button
            onClick={() => { setSearch(searchInput.trim()); setPage(0); }}
            style={{ padding: "6px 14px", borderRadius: 6, border: "none", background: "#1e3a8a", color: "#fff", fontSize: 13, fontWeight: 600, cursor: "pointer" }}
          >Search</button>
          {search && (
            <button
              onClick={() => { setSearch(""); setSearchInput(""); setPage(0); }}
              style={{ padding: "6px 14px", borderRadius: 6, border: "1px solid #cbd5e1", background: "#fff", color: "#64748b", fontSize: 13, cursor: "pointer" }}
            >Clear</button>
          )}
        </div>

        {/* Filters */}
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 14 }}>
          {ACTION_FILTERS.map((f) => {
            const active = f.key === filterKey;
            return (
              <button
                key={f.key}
                onClick={() => { setFilterKey(f.key); setPage(0); }}
                style={{
                  padding: "5px 12px", borderRadius: 999, fontSize: 12, fontWeight: 600, cursor: "pointer",
                  border: active ? "1px solid #1e3a8a" : "1px solid #cbd5e1",
                  background: active ? "#1e3a8a" : "#fff",
                  color: active ? "#fff" : "#334155",
                }}
              >{f.label}</button>
            );
          })}
        </div>

        {loading && <p>Loading…</p>}
        {error && <p style={{ color: "#b91c1c" }}>{error}</p>}
        {!loading && !error && entries.length === 0 && (
          <p style={{ color: "#64748b" }}>{search ? `No results for "${search}".` : "No activity in the last 3 days."}</p>
        )}

        {entries.length > 0 && (
          <>
            <div style={{ overflowX: "auto", background: "#fff", borderRadius: 8, border: "1px solid #e2e8f0" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f8fafc", textAlign: "left" }}>
                    <th style={th}>When</th>
                    <th style={th}>Action</th>
                    <th style={th}>Load / Vehicle</th>
                    <th style={th}>Details</th>
                    <th style={th}>User</th>
                    <th style={th}>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((e) => {
                    const chip = actionChip(e.action);
                    const src = (e.source || "").toLowerCase();
                    const srcStyle =
                      src === "app"    ? { bg: "#dcfce7", fg: "#166534" } :
                      src === "driver" ? { bg: "#e0f2fe", fg: "#075985" } :
                                         { bg: "#fee2e2", fg: "#991b1b" };
                    const isVehicle = (e.entityType || "load") === "vehicle";
                    const ref = isVehicle
                      ? (e.details?.vnum || "—")
                      : (e.lid || e.details?.lid || "—");
                    return (
                      <tr key={e.id} style={{ borderTop: "1px solid #e2e8f0" }}>
                        <td style={td}>{new Date(e.at).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</td>
                        <td style={td}>
                          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: chip.bg, color: chip.fg }}>{chip.label}</span>
                        </td>
                        <td style={td}>
                          <span style={{ fontWeight: 700, fontFamily: "monospace", fontSize: 12 }}>{ref}</span>
                          {isVehicle && <span style={{ marginLeft: 4, fontSize: 10, color: "#64748b", background: "#f1f5f9", padding: "1px 5px", borderRadius: 4 }}>vehicle</span>}
                        </td>
                        <td style={td}>{detailsText(e)}</td>
                        <td style={td}>
                          <div>{e.email || (src === "driver" ? "Driver app" : "—")}</div>
                        </td>
                        <td style={td}>
                          <span style={{ display: "inline-block", padding: "2px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, background: srcStyle.bg, color: srcStyle.fg }}>
                            {src === "app" ? "App" : src === "driver" ? "Driver" : "Database"}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginTop: 14 }}>
              <div style={{ color: "#64748b", fontSize: 13 }}>
                Page {page + 1} of {totalPages} · {total} {total === 1 ? "entry" : "entries"}
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button onClick={() => setPage((p) => Math.max(0, p - 1))} disabled={page === 0 || loading} style={pgBtn(page === 0 || loading)}>Prev</button>
                <button onClick={() => setPage((p) => (p + 1 < totalPages ? p + 1 : p))} disabled={page + 1 >= totalPages || loading} style={pgBtn(page + 1 >= totalPages || loading)}>Next</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const th: React.CSSProperties = { padding: "10px 12px", fontWeight: 600, fontSize: 12, color: "#475569" };
const td: React.CSSProperties = { padding: "10px 12px", verticalAlign: "top" };
const pgBtn = (disabled: boolean): React.CSSProperties => ({
  padding: "6px 14px", borderRadius: 6, border: "1px solid #cbd5e1",
  background: disabled ? "#f1f5f9" : "#fff", color: disabled ? "#94a3b8" : "#0f172a",
  cursor: disabled ? "not-allowed" : "pointer", fontSize: 13, fontWeight: 600,
});
