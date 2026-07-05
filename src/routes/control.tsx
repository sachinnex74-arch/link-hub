import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useServerFn } from "@tanstack/react-start";
import { ArrowLeft, ShieldAlert, Power } from "lucide-react";
import { forceGlobalLogout, getGlobalLogoutStatus } from "@/lib/tms.functions";
import { getMe } from "@/lib/auth.functions";

export const Route = createFileRoute("/control")({
  head: () => ({
    meta: [
      { title: "Control — FleetCommand TMS" },
      { name: "robots", content: "noindex, nofollow" },
    ],
  }),
  component: ControlPage,
});

function ControlPage() {
  const nav = useNavigate();
  const forceLogout = useServerFn(forceGlobalLogout);
  const fetchStatus = useServerFn(getGlobalLogoutStatus);
  const [isAdmin, setIsAdmin] = useState(false);
  const [checkingAdmin, setCheckingAdmin] = useState(true);
  const [lastForcedAt, setLastForcedAt] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    getMe()
      .then((me) => {
        setIsAdmin(!!me?.isAdmin);
        setCheckingAdmin(false);
      })
      .catch(() => setCheckingAdmin(false));
  }, []);

  useEffect(() => {
    if (!isAdmin) return;
    fetchStatus().then((r) => setLastForcedAt(r?.forceLogoutAt ?? null));
  }, [isAdmin]);

  useEffect(() => {
    if (!checkingAdmin && !isAdmin) {
      nav({ to: "/app" });
    }
  }, [checkingAdmin, isAdmin, nav]);

  const handleForceLogout = async () => {
    if (!window.confirm("This will sign out ALL users immediately. Continue?")) return;
    setBusy(true);
    setMsg("");
    try {
      await forceLogout();
      const r = await fetchStatus();
      setLastForcedAt(r?.forceLogoutAt ?? null);
      setMsg("All users have been forced to log out.");
    } catch (e: any) {
      setMsg(e?.message || "Failed to force logout.");
    } finally {
      setBusy(false);
    }
  };

  if (checkingAdmin) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: "var(--bg)" }}>
        <span style={{ fontFamily: "var(--font-head)", fontSize: ".9rem", color: "var(--text3)" }}>Checking access…</span>
      </div>
    );
  }

  if (!isAdmin) return null;

  return (
    <div style={{ minHeight: "100vh", background: "var(--bg)", display: "flex", flexDirection: "column" }}>
      <header style={{ display: "flex", alignItems: "center", gap: 12, padding: ".9rem 1.2rem", background: "var(--surface)", borderBottom: "1px solid var(--border)" }}>
        <Link to="/app" style={{ display: "flex", alignItems: "center", gap: 6, color: "var(--text2)", textDecoration: "none", fontFamily: "var(--font-head)", fontSize: ".8rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase" }}>
          <ArrowLeft size={16} /> Back
        </Link>
        <div style={{ flex: 1 }} />
        <div style={{ fontFamily: "var(--font-head)", fontSize: ".66rem", letterSpacing: 2, fontWeight: 800, color: "#6b7280", textTransform: "uppercase" }}>FleetCommand TMS</div>
      </header>

      <main style={{ flex: 1, padding: "2rem 1.2rem", maxWidth: 560, margin: "0 auto", width: "100%" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.4rem" }}>
          <ShieldAlert size={22} color="#b91c1c" />
          <div style={{ fontFamily: "var(--font-head)", fontSize: "1.15rem", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "var(--text)" }}>
            System Control
          </div>
        </div>

        <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, padding: "1.4rem" }}>
          <div style={{ fontFamily: "var(--font-head)", fontSize: ".9rem", fontWeight: 700, color: "var(--text)", marginBottom: 8 }}>Force Logout All Users</div>
          <p style={{ fontSize: ".82rem", color: "var(--text3)", lineHeight: 1.5, marginBottom: "1.2rem" }}>
            Clicking this immediately signs out every active user across all devices. They will be redirected to the login page within 30 seconds.
          </p>

          {lastForcedAt && (
            <div style={{ fontSize: ".75rem", color: "#6b7280", marginBottom: 12, fontFamily: "var(--font-mono)" }}>
              Last forced logout: {new Date(lastForcedAt).toLocaleString("en-IN")}
            </div>
          )}

          <button
            onClick={handleForceLogout}
            disabled={busy}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 8,
              background: busy ? "#94a3b8" : "#dc2626",
              color: "#fff",
              border: "none",
              borderRadius: 8,
              padding: ".7rem 1.2rem",
              fontFamily: "var(--font-head)",
              fontSize: ".85rem",
              fontWeight: 700,
              letterSpacing: 1,
              textTransform: "uppercase",
              cursor: busy ? "not-allowed" : "pointer",
            }}
          >
            <Power size={16} />
            {busy ? "Processing…" : "Force Logout Everyone"}
          </button>

          {msg && (
            <div style={{ marginTop: 12, fontSize: ".82rem", color: msg.includes("forced") ? "#15803d" : "#b91c1c" }}>
              {msg}
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
