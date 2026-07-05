import React, { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import { getLiveFleet } from "@/lib/gps.functions";
import { searchIndianPlaces } from "@/lib/places.functions";
import { distanceMeters, loadJSON, saveJSON, KEYS, evaluateIdle, appendHistory, normalizeVnum } from "../lib/geo";
import { useSyncedSetting } from "@/hooks/useSyncedSetting";
import { upsertGeofenceAlertRemote } from "@/lib/supaSync";

const MapPicker = lazy(() => import("./MapPicker"));

// Must match supaSync.ts K.geofenceAlerts so cross-device realtime updates land here.
const ALERTS_LS_KEY = "tms.geofenceAlerts";

const fmtDur = (ms) => {
  if (ms < 0) ms = 0;
  const m = Math.floor(ms / 60000);
  const h = Math.floor(m / 60);
  if (h > 0) return `${h}h ${m % 60}m`;
  return `${m}m`;
};
const fmtTime = (t) => new Date(t).toLocaleString();


export default function Geofences() {
  const [geofences, setGeofences] = useSyncedSetting("tms.geofences", loadJSON(KEYS.geofences, []));
  const [positions, setPositions] = useState(() => loadJSON(KEYS.positions, {}));
  const [history, setHistory] = useState(() => loadJSON(KEYS.history, {}));
  const [alerts, setAlerts] = useState(() => {
    try { const v = localStorage.getItem(ALERTS_LS_KEY); return v ? JSON.parse(v) : []; } catch { return []; }
  });
  const [view, setView] = useState("active");
  const [lastSync, setLastSync] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState("");

  const fetchLive = useServerFn(getLiveFleet);


  // Geofences are persisted by useSyncedSetting; positions/history remain device-local.
  useEffect(() => saveJSON(KEYS.positions, positions), [positions]);
  useEffect(() => saveJSON(KEYS.history, history), [history]);
  useEffect(() => {
    try { localStorage.setItem(ALERTS_LS_KEY, JSON.stringify(alerts)); } catch {}
  }, [alerts]);

  // Prune alerts whose geofence no longer exists (resolve them locally + push remote).
  useEffect(() => {
    const ids = new Set(geofences.map((g) => g.id));
    setAlerts((prev) => {
      let changed = false;
      const next = prev.map((a) => {
        if (!ids.has(a.geofenceId) && !a.resolvedAt) {
          changed = true;
          const updated = { ...a, resolvedAt: Date.now(), resolveReason: "geofence deleted" };
          upsertGeofenceAlertRemote(updated);
          return updated;
        }
        return a;
      });
      return changed ? next : prev;
    });
  }, [geofences]);

  // Re-read alerts from localStorage on cross-device sync events (realtime).
  useEffect(() => {
    const reload = () => {
      try {
        const v = localStorage.getItem(ALERTS_LS_KEY);
        const next = v ? JSON.parse(v) : [];
        setAlerts((prev) => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next));
      } catch {}
    };
    window.addEventListener("tms:sync", reload);
    return () => window.removeEventListener("tms:sync", reload);
  }, []);


  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      setSyncing(true); setSyncError("");
      try {
        const d = await fetchLive();
        if (cancelled) return;
        const vlist = d?.vehicles || [];
        setPositions((prev) => {
          const next = { ...prev };
          let hist = history;
          for (const v of vlist) {
            if (v.latitude == null || v.longitude == null) continue;
            const id = v.vehicleNumber || String(v.vehicleId);
            const t = v.lastUpdatedAt || Date.now();
            next[id] = { lat: v.latitude, lng: v.longitude, t, speed: v.speed, status: v.currentStatus || v.status, address: v.address };
            hist = appendHistory(hist, id, { lat: v.latitude, lng: v.longitude, t });
          }
          setHistory(hist);
          return next;
        });
        setLastSync(Date.now());
      } catch (e) {
        setSyncError(e?.message || "Failed to fetch live feed");
      } finally {
        if (!cancelled) setSyncing(false);
      }
    };
    pull();
    const iv = setInterval(pull, 60000);
    return () => { cancelled = true; clearInterval(iv); };
  }, []); // eslint-disable-line

  useEffect(() => {
    const run = () => setAlerts((prev) => {
      const next = evaluateIdle({ positions, history, geofences, alerts: prev });
      // Push only changed/new alerts to cloud (cheap diff by JSON).
      const prevById = new Map(prev.map((a) => [a.id, a]));
      for (const a of next) {
        const before = prevById.get(a.id);
        if (!before || JSON.stringify(before) !== JSON.stringify(a)) {
          upsertGeofenceAlertRemote(a);
        }
      }
      return next;
    });
    run();
    const iv = setInterval(run, 60000);
    return () => clearInterval(iv);
  }, [positions, history, geofences]);


  // ---- form state ----
  const [vehicleNo, setVehicleNo] = useState("");
  const [scope, setScope] = useState("vehicle"); // vehicle | all
  const [label, setLabel] = useState("");
  const [radius, setRadius] = useState(50);
  const [lat, setLat] = useState(null);
  const [lng, setLng] = useState(null);
  const [locText, setLocText] = useState("");
  const [showMap, setShowMap] = useState(true);
  const [vehicleSearch, setVehicleSearch] = useState("");

  // Nominatim autosuggest (debounced)
  const [searchResults, setSearchResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [showSuggest, setShowSuggest] = useState(false);
  const [activeIdx, setActiveIdx] = useState(-1);
  const searchBoxRef = useRef(null);

  const fetchPlaces = useServerFn(searchIndianPlaces);
  useEffect(() => {
    const q = locText.trim();
    if (!q) { setSearchResults([]); setSearching(false); return; }
    setSearching(true);
    const id = setTimeout(async () => {
      try {
        const r = await fetchPlaces({ data: { query: q } });
        setSearchResults(r?.results ?? []);
        setActiveIdx(-1);
      } catch {} finally { setSearching(false); }
    }, 300);
    return () => clearTimeout(id);
  }, [locText, fetchPlaces]);

  // close suggest on outside click
  useEffect(() => {
    const onDoc = (e) => { if (searchBoxRef.current && !searchBoxRef.current.contains(e.target)) setShowSuggest(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);

  const pickSuggestion = (r) => {
    setLat(r.lat); setLng(r.lng);
    setLocText(r.label);
    setShowSuggest(false);
  };


  const onSearchKeyDown = (e) => {
    if (!showSuggest && (e.key === "ArrowDown" || e.key === "Enter")) setShowSuggest(true);
    if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, searchResults.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
    else if (e.key === "Enter") {
      const pick = searchResults[activeIdx] || searchResults[0];
      if (pick) { e.preventDefault(); pickSuggestion(pick); }
    } else if (e.key === "Escape") setShowSuggest(false);
  };

  const pickFromMap = (la, ln) => { setLat(la); setLng(ln); };


  const addGeofence = () => {
    if (lat == null || lng == null) { alert("Pick a location first."); return; }
    if (scope === "vehicle" && !vehicleNo.trim()) { alert("Enter a vehicle number or switch scope to All vehicles."); return; }
    const g = {
      id: `gf_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`,
      label: label.trim() || (locText.trim() || `${lat.toFixed(3)}, ${lng.toFixed(3)}`),
      vehicleNo: scope === "vehicle" ? vehicleNo.trim() : null,
      lat, lng,
      radiusKm: Math.max(1, Math.min(500, parseFloat(radius) || 50)),
      createdAt: Date.now(),
    };
    setGeofences((p) => [...p, g]);
    // reset
    setVehicleNo(""); setLabel(""); setRadius(10); setLat(null); setLng(null); setLocText(""); setSearchResults([]);
  };

  const deleteGeofence = (id) => {
    if (!confirm("Delete this geofence?")) return;
    setGeofences((p) => p.filter((g) => g.id !== id));
    setAlerts((p) => {
      const toRemove = p.filter((a) => a.geofenceId === id);
      for (const a of toRemove) {
        // Mark resolved + push so other devices see the cleanup.
        if (!a.resolvedAt) upsertGeofenceAlertRemote({ ...a, resolvedAt: Date.now(), resolveReason: "geofence deleted" });
      }
      return p.filter((a) => a.geofenceId !== id);
    });
  };
  const updateRadius = (id, r) => setGeofences((p) => p.map((g) => g.id === id ? { ...g, radiusKm: Math.max(1, Math.min(500, r)) } : g));
  const acknowledge = (alertId) => setAlerts((p) => p.map((a) => {
    if (a.id !== alertId) return a;
    const updated = { ...a, acknowledgedAt: Date.now() };
    upsertGeofenceAlertRemote(updated);
    return updated;
  }));


  const now = Date.now();
  const activeAlerts = alerts.filter((a) => !a.resolvedAt);
  const historyAlerts = alerts.filter((a) => a.resolvedAt || a.acknowledgedAt).sort((a, b) => (b.lastSeenAt || 0) - (a.lastSeenAt || 0));
  const vehicleIds = useMemo(() => Object.keys(positions).sort(), [positions]);

  const vehiclesInside = (g) => {
    const out = [];
    const targets = g.vehicleNo ? (positions[g.vehicleNo] ? [[g.vehicleNo, positions[g.vehicleNo]]] : []) : Object.entries(positions);
    for (const [vid, p] of targets) {
      if (!p) continue;
      const d = distanceMeters(p.lat, p.lng, g.lat, g.lng);
      if (d <= g.radiusKm * 1000) {
        const hist = history[vid] || [];
        const oldest = hist.find((x) => now - x.t <= 65 * 60 * 1000);
        out.push({ vehicleId: vid, pos: p, idleSince: oldest ? oldest.t : p.t, distance: d });
      }
    }
    return out;
  };

  return (
    <div style={{ padding: "1.3rem", overflowY: "auto", flex: 1, background: "var(--bg)" }}>
      <div style={{ fontFamily: "var(--font-head)", fontSize: "1.2rem", fontWeight: 700, letterSpacing: 3, textTransform: "uppercase", marginBottom: ".4rem", color: "var(--text)" }}>
        🛰️ Geofences <span style={{ color: "#6b7280", fontSize: ".78rem", fontWeight: 400, letterSpacing: 0 }}>{geofences.length} zones · {activeAlerts.length} active alerts · {vehicleIds.length} live vehicles</span>
      </div>
      <div style={{ fontSize: ".75rem", color: syncError ? "#dc2626" : "#6b7280", marginBottom: ".8rem" }}>
        {syncing ? "Syncing Fleetx live feed…" : syncError ? `⚠ ${syncError}` : lastSync ? `Last sync: ${fmtTime(lastSync)} · auto-refresh every 60s` : "Awaiting first sync…"}
      </div>

      {/* Create form */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 8, padding: "1rem", marginBottom: "1rem" }}>
        <div style={{ fontFamily: "var(--font-head)", fontSize: ".75rem", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#374151", marginBottom: ".6rem" }}>Create Geofence</div>

        {/* Scope + vehicle */}
        <div style={{ display: "flex", gap: ".6rem", alignItems: "end", flexWrap: "wrap", marginBottom: ".7rem" }}>
          <div>
            <label style={{ display: "block", fontSize: ".6rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#6b7280", marginBottom: 3 }}>Scope</label>
            <div style={{ display: "flex", gap: 4 }}>
              {[["vehicle","🚛 Per-vehicle"],["all","🌐 All vehicles"]].map(([k,l])=>(
                <button key={k} onClick={()=>setScope(k)} style={{padding:".4rem .7rem",borderRadius:5,border:`1px solid ${scope===k?"var(--accent)":"var(--border)"}`,background:scope===k?"var(--accent)":"var(--bg)",color:scope===k?"#fff":"#374151",fontSize:".75rem",fontWeight:600,cursor:"pointer"}}>{l}</button>
              ))}
            </div>
          </div>
          {scope === "vehicle" && (
            <div style={{ flex: 1, minWidth: 220 }}>
              <label style={{ display: "block", fontSize: ".6rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#6b7280", marginBottom: 3 }}>Vehicle number</label>
              <input list="gf-vehicle-list" value={vehicleNo} onChange={(e)=>setVehicleNo(e.target.value)} placeholder="e.g. HR55-AB-1234" style={{ width: "100%", padding: ".45rem .6rem", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", fontSize: ".85rem", outline: "none" }} />
              <datalist id="gf-vehicle-list">
                {vehicleIds.map(v=><option key={v} value={v} />)}
              </datalist>
            </div>
          )}
          <div style={{ minWidth: 200 }}>
            <label style={{ display: "block", fontSize: ".6rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#6b7280", marginBottom: 3 }}>Label (optional)</label>
            <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Customer Yard" style={{ width: "100%", padding: ".45rem .6rem", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", fontSize: ".85rem", outline: "none" }} />
          </div>
          <div>
            <label style={{ display: "block", fontSize: ".6rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#6b7280", marginBottom: 3 }}>Radius (km)</label>
            <input type="number" min={1} max={500} value={radius} onChange={(e) => setRadius(e.target.value)} style={{ width: 90, padding: ".45rem .6rem", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", fontSize: ".85rem", outline: "none" }} />
          </div>
        </div>

        {/* Location search */}
        <div ref={searchBoxRef} style={{ position: "relative", marginBottom: ".6rem" }}>
          <label style={{ display: "block", fontSize: ".6rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#6b7280", marginBottom: 3 }}>Location</label>
          <div style={{ position: "relative" }}>
            <span style={{ position: "absolute", left: 10, top: "50%", transform: "translateY(-50%)", fontSize: ".95rem", pointerEvents: "none" }}>🔎</span>
            <input
              value={locText}
              onChange={(e)=>{ setLocText(e.target.value); setShowSuggest(true); }}
              onFocus={()=>setShowSuggest(true)}
              onKeyDown={onSearchKeyDown}
              placeholder="Search any city, landmark or address…"
              autoComplete="off"
              style={{ width: "100%", padding: ".55rem .8rem .55rem 2rem", borderRadius: 6, border: "1px solid var(--border)", background: "var(--bg)", fontSize: ".9rem", outline: "none" }}
            />
            {locText && (
              <button onClick={()=>{ setLocText(""); setSearchResults([]); setLat(null); setLng(null); }} style={{ position: "absolute", right: 8, top: "50%", transform: "translateY(-50%)", border: "none", background: "transparent", color: "#9ca3af", cursor: "pointer", fontSize: ".95rem" }} aria-label="Clear">✕</button>
            )}
          </div>
          {showSuggest && locText.trim().length >= 1 && (
            <div style={{ position: "absolute", top: "100%", left: 0, right: 0, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 6, marginTop: 4, maxHeight: 300, overflowY: "auto", zIndex: 1000, boxShadow: "0 10px 24px rgba(0,0,0,.12)" }}>
              {searching && <div style={{ padding: ".55rem .75rem", fontSize: ".78rem", color: "#6b7280" }}>Searching…</div>}
              {!searching && searchResults.length === 0 && <div style={{ padding: ".55rem .75rem", fontSize: ".78rem", color: "#6b7280" }}>No matches. Try a different spelling or add the state/country.</div>}
              {!searching && searchResults.map((r, i) => (
                <button
                  key={i}
                  onMouseDown={(e)=>e.preventDefault()}
                  onMouseEnter={()=>setActiveIdx(i)}
                  onClick={()=>pickSuggestion(r)}
                  style={{ display: "block", width: "100%", textAlign: "left", padding: ".5rem .75rem", border: "none", background: i === activeIdx ? "var(--bg)" : "transparent", cursor: "pointer", borderBottom: "1px solid var(--border)" }}
                >
                  <div style={{ fontSize: ".85rem", fontWeight: 600, color: "var(--text)" }}>📍 {r.label.split(",")[0]}</div>
                  <div style={{ fontSize: ".7rem", color: "#6b7280", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{r.label}</div>
                </button>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: ".5rem" }}>
          <button onClick={()=>setShowMap((s)=>!s)} style={{ padding: ".35rem .7rem", borderRadius: 5, border: "1px solid var(--border)", background: showMap ? "var(--accent)" : "var(--bg)", color: showMap ? "#fff" : "#374151", fontSize: ".72rem", fontWeight: 600, cursor: "pointer" }}>
            🗺 {showMap ? "Hide map" : "Pick on map"}
          </button>
          {lat != null && lng != null && (
            <div style={{ fontSize: ".72rem", color: "#6b7280" }}>📍 <b>{lat.toFixed(5)}, {lng.toFixed(5)}</b></div>
          )}
        </div>

        {showMap && (
          <Suspense fallback={<div style={{height:320,background:"var(--bg)",borderRadius:6,display:"flex",alignItems:"center",justifyContent:"center",color:"#6b7280",fontSize:".85rem"}}>Loading map…</div>}>
            <MapPicker lat={lat} lng={lng} radiusKm={radius} onPick={pickFromMap} />
          </Suspense>
        )}

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: ".6rem" }}>
          <div style={{ fontSize: ".72rem", color: "#6b7280" }}>
            {lat != null ? "Tip: open the map to fine-tune the marker position." : "Start typing a place name above to see suggestions."}
          </div>
          <button onClick={addGeofence} disabled={lat == null} style={{ padding: ".5rem 1.2rem", borderRadius: 5, border: "none", background: lat != null ? "var(--accent)" : "#d1d5db", color: "#fff", fontWeight: 700, fontFamily: "var(--font-head)", letterSpacing: 1, textTransform: "uppercase", fontSize: ".75rem", cursor: lat != null ? "pointer" : "not-allowed" }}>Save Geofence</button>
        </div>
      </div>


      {/* Tabs */}
      <div style={{ display: "flex", gap: 4, marginBottom: ".8rem", borderBottom: "1px solid var(--border)" }}>
        {[["active", `🔔 Active Alerts (${activeAlerts.length})`], ["history", `📜 History (${historyAlerts.length})`]].map(([k, lbl]) => (
          <button key={k} onClick={() => setView(k)} style={{ padding: ".5rem 1rem", border: "none", background: "transparent", cursor: "pointer", fontFamily: "var(--font-head)", fontSize: ".78rem", fontWeight: 700, textTransform: "uppercase", letterSpacing: 1, color: view === k ? "var(--accent)" : "#6b7280", borderBottom: view === k ? "2px solid var(--accent)" : "2px solid transparent", marginBottom: -1 }}>{lbl}</button>
        ))}
      </div>

      {view === "active" && (
        <div style={{ marginBottom: "1rem" }}>
          {activeAlerts.length === 0 ? (
            <div style={{ padding: "1rem", color: "#6b7280", fontSize: ".85rem", textAlign: "center", background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 6 }}>No active idle alerts.</div>
          ) : activeAlerts.map((a) => (
            <div key={a.id} style={{ background: a.acknowledgedAt ? "var(--surface)" : "#fef2f2", border: `1px solid ${a.acknowledgedAt ? "var(--border)" : "#fca5a5"}`, borderRadius: 7, padding: ".7rem .9rem", marginBottom: ".5rem", display: "flex", alignItems: "center", gap: ".8rem" }}>
              <div style={{ fontSize: "1.4rem" }}>{a.acknowledgedAt ? "✅" : "🚨"}</div>
              <div style={{ flex: 1 }}>
                <div style={{ fontWeight: 700, fontSize: ".92rem", color: a.acknowledgedAt ? "#374151" : "#991b1b" }}>{a.vehicleId} idle in {a.geofenceLabel}</div>
                <div style={{ fontSize: ".75rem", color: "#6b7280", marginTop: 2 }}>Idle for <b>{fmtDur(now - a.startedAt)}</b> · started {fmtTime(a.startedAt)} · last seen {fmtTime(a.lastSeenAt)}{a.acknowledgedAt && <> · ack’d {fmtTime(a.acknowledgedAt)}</>}</div>
              </div>
              {!a.acknowledgedAt && <button onClick={() => acknowledge(a.id)} style={{ padding: ".4rem .8rem", borderRadius: 5, border: "1px solid #991b1b", background: "#fff", color: "#991b1b", fontWeight: 700, fontSize: ".72rem", letterSpacing: 1, textTransform: "uppercase", cursor: "pointer" }}>Acknowledge</button>}
            </div>
          ))}
        </div>
      )}

      {view === "history" && (
        <div style={{ marginBottom: "1rem" }}>
          {historyAlerts.length === 0 ? (
            <div style={{ padding: "1rem", color: "#6b7280", fontSize: ".85rem", textAlign: "center", background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 6 }}>No history yet.</div>
          ) : (
            <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 7, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: ".82rem" }}>
                <thead><tr style={{ background: "var(--bg)", textAlign: "left" }}>
                  {["Vehicle","Geofence","Started","Duration","Resolved","Ack"].map(h=><th key={h} style={{ padding: ".5rem .7rem", fontSize: ".68rem", fontWeight: 700, letterSpacing: 1, textTransform: "uppercase", color: "#374151" }}>{h}</th>)}
                </tr></thead>
                <tbody>{historyAlerts.map((a) => (
                  <tr key={a.id} style={{ borderTop: "1px solid var(--border)" }}>
                    <td style={{ padding: ".45rem .7rem", fontWeight: 600 }}>{a.vehicleId}</td>
                    <td style={{ padding: ".45rem .7rem" }}>{a.geofenceLabel}</td>
                    <td style={{ padding: ".45rem .7rem", color: "#6b7280" }}>{fmtTime(a.startedAt)}</td>
                    <td style={{ padding: ".45rem .7rem" }}>{fmtDur((a.resolvedAt || a.lastSeenAt) - a.startedAt)}</td>
                    <td style={{ padding: ".45rem .7rem", color: "#6b7280" }}>{a.resolvedAt ? `${fmtTime(a.resolvedAt)} (${a.resolveReason || "—"})` : "—"}</td>
                    <td style={{ padding: ".45rem .7rem", color: "#6b7280" }}>{a.acknowledgedAt ? fmtTime(a.acknowledgedAt) : "—"}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Vehicle search: see which vehicles have / don't have saved geofences */}
      <div style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 7, padding: ".7rem .9rem", margin: "1rem 0 .6rem" }}>
        <div style={{ fontFamily: "var(--font-head)", fontSize: ".72rem", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#374151", marginBottom: ".4rem" }}>🔍 Vehicle Geofence Lookup</div>
        <input
          value={vehicleSearch}
          onChange={(e) => setVehicleSearch(e.target.value)}
          placeholder="Search vehicle number to see if it has a saved geofence…"
          style={{ width: "100%", padding: ".5rem .7rem", borderRadius: 5, border: "1px solid var(--border)", background: "var(--bg)", fontSize: ".85rem", outline: "none" }}
        />
        {vehicleSearch.trim() && (() => {
          const q = normalizeVnum(vehicleSearch);
          const matches = vehicleIds.filter((v) => normalizeVnum(v).includes(q));
          const allScope = geofences.filter((g) => !g.vehicleNo);
          if (matches.length === 0) {
            return <div style={{ marginTop: ".5rem", fontSize: ".8rem", color: "#6b7280" }}>No live vehicle matches "{vehicleSearch}".</div>;
          }
          return (
            <div style={{ marginTop: ".6rem", display: "grid", gap: ".5rem" }}>
              {matches.map((vid) => {
                const own = geofences.filter((g) => g.vehicleNo && normalizeVnum(g.vehicleNo) === normalizeVnum(vid));
                const total = own.length + allScope.length;
                return (
                  <div key={vid} style={{ border: "1px solid var(--border)", borderRadius: 6, padding: ".5rem .7rem", background: "var(--bg)" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}>
                      <div style={{ fontWeight: 700, fontSize: ".88rem" }}>🚛 {vid}</div>
                      {total > 0 ? (
                        <span style={{ background: "#dcfce7", color: "#166534", padding: "2px 8px", borderRadius: 10, fontSize: ".7rem", fontWeight: 700 }}>✅ {total} saved geofence{total > 1 ? "s" : ""}</span>
                      ) : (
                        <span style={{ background: "#fef3c7", color: "#92400e", padding: "2px 8px", borderRadius: 10, fontSize: ".7rem", fontWeight: 700 }}>⚠ No saved geofence</span>
                      )}
                    </div>
                    {total > 0 ? (
                      <div style={{ marginTop: ".35rem", fontSize: ".75rem", color: "#374151", display: "grid", gap: 2 }}>
                        {own.map((g) => (
                          <div key={g.id}>🚛 {g.label} <span style={{ color: "#6b7280" }}>· {g.radiusKm}km</span></div>
                        ))}
                        {allScope.map((g) => (
                          <div key={g.id}>🌐 All-vehicles · {g.label} <span style={{ color: "#6b7280" }}>· {g.radiusKm}km</span></div>
                        ))}
                      </div>
                    ) : (
                      <button
                        onClick={() => { setScope("vehicle"); setVehicleNo(vid); window.scrollTo({ top: 0, behavior: "smooth" }); }}
                        style={{ marginTop: ".4rem", padding: ".35rem .7rem", borderRadius: 5, border: "1px solid var(--accent)", background: "var(--accent)", color: "#fff", fontSize: ".72rem", fontWeight: 700, cursor: "pointer" }}
                      >
                        + Create geofence for this vehicle
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          );
        })()}
      </div>

      <div style={{ fontFamily: "var(--font-head)", fontSize: ".78rem", fontWeight: 700, letterSpacing: 1.5, textTransform: "uppercase", color: "#374151", margin: "1rem 0 .5rem" }}>Saved Geofences</div>
      {geofences.length === 0 ? (
        <div style={{ padding: "1.2rem", color: "#6b7280", fontSize: ".85rem", textAlign: "center", background: "var(--surface)", border: "1px dashed var(--border)", borderRadius: 6 }}>No geofences yet. Create one above.</div>
      ) : (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: ".7rem" }}>
          {geofences.map((g) => {
            const inside = vehiclesInside(g);
            const gAlerts = activeAlerts.filter((a) => a.geofenceId === g.id);
            return (
              <div key={g.id} style={{ background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 7, padding: ".8rem .9rem" }}>
                <div style={{ display: "flex", alignItems: "start", gap: 8 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 700, fontSize: ".95rem" }}>
                      {g.vehicleNo ? <>🚛 {g.vehicleNo}</> : <>🌐 All vehicles</>} <span style={{ color: "#6b7280", fontWeight: 500 }}>· {g.label}</span>
                    </div>
                    <div style={{ fontSize: ".72rem", color: "#6b7280", marginTop: 2 }}>{g.lat.toFixed(4)}, {g.lng.toFixed(4)}</div>
                  </div>
                  <button onClick={() => deleteGeofence(g.id)} style={{ padding: ".25rem .5rem", borderRadius: 4, border: "1px solid #dc2626", background: "#fff", color: "#dc2626", fontSize: ".68rem", fontWeight: 700, cursor: "pointer" }}>Del</button>
                </div>
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: ".6rem" }}>
                  <label style={{ fontSize: ".7rem", color: "#6b7280", fontWeight: 600 }}>Radius:</label>
                  <input type="number" min={1} max={500} value={g.radiusKm} onChange={(e) => updateRadius(g.id, parseFloat(e.target.value) || 1)} style={{ width: 70, padding: ".25rem .4rem", borderRadius: 4, border: "1px solid var(--border)", background: "var(--bg)", fontSize: ".8rem" }} />
                  <span style={{ fontSize: ".75rem", color: "#6b7280" }}>km</span>
                  <a href={`https://www.openstreetmap.org/?mlat=${g.lat}&mlon=${g.lng}#map=12/${g.lat}/${g.lng}`} target="_blank" rel="noreferrer" style={{ marginLeft: "auto", fontSize: ".7rem", color: "var(--accent)" }}>View map ↗</a>
                </div>
                <div style={{ display: "flex", gap: 10, marginTop: ".6rem", fontSize: ".75rem" }}>
                  <span style={{ background: "#dbeafe", color: "#1e40af", padding: "2px 7px", borderRadius: 10, fontWeight: 700 }}>{inside.length} inside</span>
                  {gAlerts.length > 0 && <span style={{ background: "#fee2e2", color: "#991b1b", padding: "2px 7px", borderRadius: 10, fontWeight: 700 }}>{gAlerts.length} idle alerts</span>}
                </div>
                {inside.length > 0 && (
                  <details style={{ marginTop: ".5rem" }}>
                    <summary style={{ cursor: "pointer", fontSize: ".75rem", color: "#374151", fontWeight: 600 }}>Vehicles inside</summary>
                    <div style={{ marginTop: ".4rem", fontSize: ".75rem" }}>
                      {inside.map((v) => (
                        <div key={v.vehicleId} style={{ display: "flex", justifyContent: "space-between", padding: "3px 0", borderBottom: "1px dashed var(--border)" }}>
                          <span style={{ fontWeight: 600 }}>{v.vehicleId}</span>
                          <span style={{ color: "#6b7280" }}>{(v.distance / 1000).toFixed(1)}km · idle {fmtDur(now - v.idleSince)}{v.pos.speed != null && <> · {Math.round(v.pos.speed)} km/h</>}</span>
                        </div>
                      ))}
                    </div>
                  </details>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
