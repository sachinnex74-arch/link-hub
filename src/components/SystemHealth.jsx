// SystemHealth.jsx — Phase V: the alarm that rings where people are.
//
// Reads the observability keys the crons already write to app_settings and
// surfaces TWO conditions as a banner (rendered by Tms.jsx near the header):
//
//   1. INVARIANT VIOLATIONS — cron.invariantLastRun reports violations > 0.
//      The referee found a vehicle/load pair mismatch. Red banner, persistent.
//   2. DEAD CRON — a watched cron's last run is older than 3× its cadence.
//      The machinery that watches the fleet has itself stopped. Amber banner.
//
// Renders NOTHING when healthy (the overwhelmingly normal state) — zero visual
// cost. Read-only; no writes, no actions. Data arrives via the existing
// settings realtime subscription, so the banner appears/clears live.
import { useEffect, useState } from "react";
import { subscribeSetting } from "@/lib/supaSync";

const WATCHED = [
  { key: "cron.invariantLastRun",  label: "Invariant check", cadenceMin: 30 },
  { key: "cron.arrivalLastRun",    label: "Arrival tick",    cadenceMin: 5  },
  { key: "cron.leftUnloadLastRun", label: "Left-unload tick", cadenceMin: 15 },
];

export default function SystemHealth() {
  const [vals, setVals] = useState({});
  const [, tick] = useState(0);

  useEffect(() => {
    const unsubs = WATCHED.map(w =>
      subscribeSetting(w.key, (v) => setVals(p => ({ ...p, [w.key]: v })))
    );
    // Re-evaluate staleness every minute even without new data.
    const t = setInterval(() => tick(x => x + 1), 60_000);
    return () => { unsubs.forEach(u => u && u()); clearInterval(t); };
  }, []);

  const problems = [];
  const inv = vals["cron.invariantLastRun"];
  const invViolations = Number(inv?.violations ?? inv?.violationCount ?? 0);
  if (invViolations > 0) {
    problems.push({
      sev: "red",
      text: `⚠ Invariant alarm: ${invViolations} vehicle/load mismatch${invViolations > 1 ? "es" : ""} detected — check audit log (INVARIANT rows).`,
    });
  }
  const now = Date.now();
  for (const w of WATCHED) {
    const v = vals[w.key];
    const at = v?.at || v?.checkedAt || v?.ranAt || (typeof v === "string" ? v : null);
    if (!at) continue; // never ran / key absent → don't alarm on missing history
    const ageMin = (now - new Date(at).getTime()) / 60000;
    if (isFinite(ageMin) && ageMin > w.cadenceMin * 3) {
      problems.push({
        sev: "amber",
        text: `⏱ ${w.label} hasn't run for ${Math.round(ageMin)} min (expected every ${w.cadenceMin}) — cron may be down.`,
      });
    }
  }

  if (!problems.length) return null;
  const worst = problems.some(p => p.sev === "red") ? "red" : "amber";
  return (
    <div style={{
      background: worst === "red" ? "#fef2f2" : "#fffbeb",
      border: `1px solid ${worst === "red" ? "#fecaca" : "#fde68a"}`,
      color: worst === "red" ? "#991b1b" : "#92400e",
      padding: "8px 14px", borderRadius: 8, margin: "8px 12px",
      fontSize: ".8rem", fontFamily: "'Inter',system-ui,sans-serif", fontWeight: 600,
      display: "flex", flexDirection: "column", gap: 4,
    }}>
      {problems.map((p, i) => <div key={i}>{p.text}</div>)}
    </div>
  );
}
