import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { signInWithUsername, useAuthSession } from "@/lib/authClient";
import { ensureAdminBootstrap } from "@/lib/auth.functions";

export const Route = createFileRoute("/login")({
  head: () => ({
    meta: [
      { title: "Sign in — FleetCommand TMS" },
      { name: "description", content: "Sign in to FleetCommand TMS — Pan-India road freight operations console." },
    ],
  }),
  component: LoginPage,
});

function LoginPage() {
  const nav = useNavigate();
  const { ready, userId } = useAuthSession();
  const [u, setU] = useState("");
  const [p, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [showPw, setShowPw] = useState(false);

  useEffect(() => {
    ensureAdminBootstrap().catch((e) => console.warn("[auth] bootstrap failed", e));
  }, []);

  useEffect(() => {
    if (ready && userId) nav({ to: "/app" });
  }, [ready, userId, nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      await signInWithUsername(u, p);
      nav({ to: "/app" });
    } catch (e: any) {
      setErr(e?.message || "Sign-in failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="lx-shell">
      {/* Left brand panel */}
      <aside className="lx-hero">
        <div className="lx-hero-brand">
          <div className="lx-hero-mark">🚛</div>
          <div>
            <div style={{ display: "flex", alignItems: "center" }}>
              FleetCommand
              <span className="lx-hero-badge">TMS</span>
            </div>
            <div className="lx-hero-tag">by NS Logistics</div>
          </div>
        </div>

        <div>
          <h1 className="lx-hero-headline">
            Pan-India road freight, orchestrated in real time.
          </h1>
          <p className="lx-hero-sub">
            Live GPS, ETA intelligence, branch-wise load orchestration and POD audit —
            built for operations teams that move millions of kilometres a year.
          </p>
        </div>

        <div className="lx-hero-stats">
          <div>
            <div className="lx-hero-stat-num">22</div>
            <div className="lx-hero-stat-lbl">Branches</div>
          </div>
          <div>
            <div className="lx-hero-stat-num">24/7</div>
            <div className="lx-hero-stat-lbl">Live Tracking</div>
          </div>
          <div>
            <div className="lx-hero-stat-num">100%</div>
            <div className="lx-hero-stat-lbl">Audit Trail</div>
          </div>
        </div>
      </aside>

      {/* Right form panel */}
      <main className="lx-form-side">
        <div className="lx-card">
          <div className="lx-title">Welcome back</div>
          <div className="lx-sub">Sign in to your FleetCommand console</div>

          <form onSubmit={submit} autoComplete="on">
            <div className="lx-field">
              <label className="lx-label" htmlFor="lx-u">User ID</label>
              <input
                id="lx-u"
                autoFocus
                value={u}
                onChange={(e) => setU(e.target.value)}
                placeholder="e.g. admin"
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                className="lx-input"
              />
            </div>
            <div className="lx-field">
              <label className="lx-label" htmlFor="lx-p">Password</label>
              <div className="lx-pw-wrap">
                <input
                  id="lx-p"
                  type={showPw ? "text" : "password"}
                  value={p}
                  onChange={(e) => setP(e.target.value)}
                  className="lx-input"
                  style={{ paddingRight: 64 }}
                />
                <button
                  type="button"
                  className="lx-pw-toggle"
                  onClick={() => setShowPw((s) => !s)}
                  tabIndex={-1}
                  aria-label={showPw ? "Hide password" : "Show password"}
                >
                  {showPw ? "Hide" : "Show"}
                </button>
              </div>
            </div>

            {err && <div className="lx-err" key={err}>⚠ {err}</div>}

            <button type="submit" disabled={busy || !u || !p} className="lx-btn">
              {busy ? <span className="lx-btn-spin" /> : "Sign in"}
            </button>
          </form>

          <div className="lx-divider">
            <Link to="/driver" className="lx-driver-link">Driver app login →</Link>
          </div>
        </div>
      </main>
    </div>
  );
}
