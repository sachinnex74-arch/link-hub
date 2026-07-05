import { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Circle, useMap, useMapEvents } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useServerFn } from "@tanstack/react-start";
import {
  getDwellingVehicles,
  listDwellZones, createDwellZone, deleteDwellZone,
} from "@/lib/gps.functions";
import { searchIndianPlaces } from "@/lib/places.functions";

// Movement — dwell-geofence monitoring. Top: create/manage zones (search a city,
// place a circle, save). Zones live server-side so the dwell-tick evaluates them
// 24/7. Bottom: vehicles currently inside a zone, how long (live), when entered.
// Amber past 6h, red past 10h. Filter by minimum hours.

const pin = L.divIcon({
  className: "dwell-pin",
  html: '<div style="width:16px;height:16px;border-radius:50%;background:#2563eb;border:2px solid #fff;box-shadow:0 0 0 2px rgba(37,99,235,.35)"></div>',
  iconSize: [16, 16], iconAnchor: [8, 8],
});

function fmtDur(ms) {
  const totalMin = Math.max(0, Math.floor(ms / 60000));
  const h = Math.floor(totalMin / 60), m = totalMin % 60;
  return h > 0 ? h + "h " + m + "m" : m + "m";
}
function fmtEntered(ms) {
  return new Date(ms).toLocaleString(undefined, {
    day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit", hour12: true,
  });
}
function severity(hours) {
  if (hours >= 10) return "red";
  if (hours >= 6) return "amber";
  return "none";
}
const ROW_BG = { red: "rgba(220,38,38,0.14)", amber: "rgba(217,119,6,0.14)", none: "transparent" };
const ROW_ACCENT = { red: "#dc2626", amber: "#d97706", none: "transparent" };

function Recenter({ lat, lng }) {
  const map = useMap();
  useEffect(() => { if (lat != null && lng != null) map.setView([lat, lng], 11); }, [lat, lng, map]);
  return null;
}
function ClickToPlace({ onPick }) {
  useMapEvents({ click(e) { onPick(e.latlng.lat, e.latlng.lng); } });
  return null;
}

export default function DwellVehiclesPanel({
  vehicles = [],
  loads = [],
  vehicleIncidents = {},
  dwellComments = {},
  setDwellComments = null,
  onReportIncident = null,
  onManageIncident = null,
  onMarkWithoutDriver = null,
  onClearWithoutDriver = null,
}) {
  const [zones, setZones] = useState([]);
  const [zonesLoading, setZonesLoading] = useState(true);
  const listZonesFn = useServerFn(listDwellZones);
  const createZoneFn = useServerFn(createDwellZone);
  const deleteZoneFn = useServerFn(deleteDwellZone);
  const searchFn = useServerFn(searchIndianPlaces);

  const [name, setName] = useState("");
  const [lat, setLat] = useState(null);
  const [lng, setLng] = useState(null);
  const [radiusKm, setRadiusKm] = useState(3);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [saving, setSaving] = useState(false);
  const searchTimer = useRef(null);

  const [rows, setRows] = useState([]);
  const [dwellLoading, setDwellLoading] = useState(true);
  const [minHours, setMinHours] = useState(0);
  const [nowTs, setNowTs] = useState(Date.now());

  const loadZones = async () => {
    try { const r = await listZonesFn({ data: {} }); setZones(r.zones || []); }
    catch { /* keep */ } finally { setZonesLoading(false); }
  };
  const loadDwelling = async () => {
    try { const r = await getDwellingVehicles({ data: {} }); setRows(r.dwelling || []); }
    catch { /* keep */ } finally { setDwellLoading(false); }
  };

  useEffect(() => {
    loadZones(); loadDwelling();
    const t = setInterval(loadDwelling, 60000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => { const t = setInterval(() => setNowTs(Date.now()), 30000); return () => clearInterval(t); }, []);

  useEffect(() => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (query.trim().length < 3) { setResults([]); return; }
    searchTimer.current = setTimeout(async () => {
      setSearching(true);
      try {
        const r = await searchFn({ data: { query: query.trim() } });
        setResults(r.results || r.suggestions || []);
      } catch { setResults([]); } finally { setSearching(false); }
    }, 350);
    return () => { if (searchTimer.current) clearTimeout(searchTimer.current); };
  }, [query]);

  const pickResult = (r) => {
    setLat(r.lat); setLng(r.lng);
    if (!name.trim()) setName(r.label || r.name || "");
    setQuery(r.label || r.name || ""); setResults([]);
  };

  const saveZone = async () => {
    if (lat == null || lng == null) { alert("Search a place or tap the map to set the zone center."); return; }
    if (!name.trim()) { alert("Give the zone a name."); return; }
    setSaving(true);
    try {
      const res = await createZoneFn({ data: { name: name.trim(), centerLat: lat, centerLng: lng, radiusM: Math.round(radiusKm * 1000) } });
      if (!res.ok) { alert(res.error || "Could not save zone."); return; }
      setName(""); setLat(null); setLng(null); setRadiusKm(3); setQuery(""); setResults([]);
      await loadZones();
    } finally { setSaving(false); }
  };

  const removeZone = async (id) => {
    if (!confirm("Remove this zone? It will stop monitoring immediately.")) return;
    const res = await deleteZoneFn({ data: { id } });
    if (!res.ok) { alert(res.error || "Could not remove zone."); return; }
    await loadZones(); await loadDwelling();
  };

  // Join dwell rows to the TMS vehicle. Dwell rows originate from the GPS side
  // (FleetX plate strings), which can carry device suffixes (…GPS/AIS/VTS) or
  // extra characters — so we match with the SAME rules as buildGpsMap:
  // exact normalized → device-suffix-stripped → last-10-chars fallback.
  const normVnum = (s) => String(s || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  const stripDevice = (s) => s.replace(/(GPS|AIS|VTS)$/,'');
  const { vByExact, vByAlt } = useMemo(() => {
    const exact = new Map(); const alt = new Map();
    for (const v of vehicles) {
      const k = normVnum(v.vnum); if (!k) continue;
      exact.set(k, v);
      const a = k.length > 10 ? k.slice(-10) : k;
      if (!alt.has(a)) alt.set(a, v);          // first-wins; avoids dup-plate clobber
    }
    return { vByExact: exact, vByAlt: alt };
  }, [vehicles]);
  const findVehicle = (vnum) => {
    const k = normVnum(vnum); if (!k) return null;
    return vByExact.get(k)
        || vByExact.get(stripDevice(k))
        || vByAlt.get(k.length > 10 ? k.slice(-10) : k)
        || vByAlt.get((() => { const s = stripDevice(k); return s.length > 10 ? s.slice(-10) : s; })())
        || null;
  };
  const loadById = useMemo(() => {
    const m = new Map();
    for (const l of loads) m.set(String(l.id), l);
    return m;
  }, [loads]);

  const enriched = useMemo(() => rows
    .map((r) => {
      const ms = Math.max(0, nowTs - r.enteredAt); const hours = ms / 3600000;
      const tv = findVehicle(r.vnum);                                          // TMS vehicle
      const ld = tv?.loadId ? (loadById.get(String(tv.loadId)) || null) : null; // attached load
      return { ...r, ms, hours, sev: severity(hours), tv, ld };
    })
    .filter((r) => r.hours >= minHours)
    .sort((a, b) => b.ms - a.ms), [rows, nowTs, minHours, vByExact, vByAlt, loadById]);

  const counts = useMemo(() => {
    let amber = 0, red = 0;
    for (const r of rows) { const h = (nowTs - r.enteredAt) / 3600000; if (h >= 10) red++; else if (h >= 6) amber++; }
    return { total: rows.length, amber, red };
  }, [rows, nowTs]);

  const mapCenter = [lat != null ? lat : 22.9734, lng != null ? lng : 78.6569];

  return (
    <div className="dwell-panel">
      <style>{`
        .dwell-panel { display:flex; flex-direction:column; gap:18px; }
        .dwell-card { background:#fff; border:1px solid #eceef1; border-radius:14px; padding:16px; }
        .dwell-card h3 { font-size:14px; font-weight:600; color:#111827; margin:0 0 12px; }
        .dwell-create { display:grid; grid-template-columns: 1fr 340px; gap:16px; }
        @media (max-width: 860px){ .dwell-create { grid-template-columns:1fr; } }
        .dwell-field { margin-bottom:12px; }
        .dwell-field label { display:block; font-size:12px; color:#6b7280; margin-bottom:5px; }
        .dwell-input { width:100%; font-size:13px; padding:9px 11px; border:1px solid #d1d5db; border-radius:9px; box-sizing:border-box; }
        .dwell-search-wrap { position:relative; }
        .dwell-suggest { position:absolute; z-index:1200; top:100%; left:0; right:0; background:#fff;
          border:1px solid #e5e7eb; border-radius:9px; margin-top:4px; box-shadow:0 8px 24px rgba(0,0,0,.1); max-height:220px; overflow:auto; }
        .dwell-suggest button { display:block; width:100%; text-align:left; padding:9px 11px; font-size:13px; border:0; background:#fff; cursor:pointer; }
        .dwell-suggest button:hover { background:#f3f4f6; }
        .dwell-map { height:300px; border-radius:11px; overflow:hidden; border:1px solid #e5e7eb; }
        .dwell-save { background:#2563eb; color:#fff; border:0; border-radius:9px; padding:10px 16px; font-size:13px; font-weight:600; cursor:pointer; }
        .dwell-save:disabled { opacity:.6; cursor:default; }
        .dwell-radius-row { display:flex; align-items:center; gap:10px; }
        .dwell-radius-row input[type=range]{ flex:1; }
        .dwell-radius-val { font-size:13px; font-weight:600; font-variant-numeric:tabular-nums; min-width:56px; text-align:right; }
        .dwell-zone-item { display:flex; align-items:center; justify-content:space-between; gap:10px; padding:9px 0; border-bottom:1px solid #f3f4f6; font-size:13px; }
        .dwell-zone-item:last-child{ border-bottom:0; }
        .dwell-zone-meta { color:#6b7280; font-size:12px; }
        .dwell-zone-del { color:#dc2626; background:none; border:0; font-size:12px; cursor:pointer; font-weight:600; }
        .dwell-head { display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap; margin-bottom:12px; }
        .dwell-title { font-size:15px; font-weight:600; color:#111827; }
        .dwell-sub { font-size:12px; color:#6b7280; margin-top:2px; }
        .dwell-pills { display:flex; gap:8px; }
        .dwell-pill { font-size:12px; font-weight:600; padding:3px 9px; border-radius:999px; border:1px solid #e5e7eb; color:#374151; background:#fff; }
        .dwell-pill.amber { color:#b45309; border-color:#fcd34d; background:#fffbeb; }
        .dwell-pill.red { color:#b91c1c; border-color:#fca5a5; background:#fef2f2; }
        .dwell-filter { display:flex; align-items:center; gap:8px; margin-bottom:10px; }
        .dwell-filter label { font-size:12px; color:#6b7280; }
        .dwell-filter select { font-size:13px; padding:5px 8px; border:1px solid #d1d5db; border-radius:8px; }
        .dwell-table { width:100%; border-collapse:collapse; }
        .dwell-table th { text-align:left; font-size:11px; font-weight:600; letter-spacing:.03em; text-transform:uppercase; color:#9ca3af; padding:8px 12px; border-bottom:1px solid #f0f0f0; }
        .dwell-table td { font-size:13px; color:#1f2937; padding:10px 12px; border-bottom:1px solid #f5f5f5; }
        .dwell-vnum { font-weight:600; font-variant-numeric:tabular-nums; }
        .dwell-dur { font-weight:600; font-variant-numeric:tabular-nums; }
        .dwell-zone { color:#6b7280; }
        .dwell-empty { text-align:center; color:#9ca3af; font-size:13px; padding:28px 12px; }
        .dwell-dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:8px; vertical-align:middle; }
        .dwell-lid { font-weight:600; color:#111827; font-variant-numeric:tabular-nums; }
        .dwell-noload { font-size:11px; font-weight:600; color:#9ca3af; text-transform:uppercase; letter-spacing:.03em; }
        .dwell-reasons { display:flex; flex-wrap:wrap; gap:5px; align-items:center; }
        .dwell-badge { font-size:11px; font-weight:600; padding:2px 8px; border-radius:999px; cursor:pointer; border:1px solid #e5e7eb; background:#fff; color:#374151; }
        .dwell-badge.amber { color:#b45309; border-color:#fcd34d; background:#fffbeb; }
        .dwell-badge.red { color:#b91c1c; border-color:#fca5a5; background:#fef2f2; }
        .dwell-rbtn { font-size:11px; font-weight:600; padding:2px 8px; border-radius:7px; cursor:pointer; border:1px dashed #d1d5db; background:#fff; color:#6b7280; }
        .dwell-rbtn:hover { border-color:#2563eb; color:#2563eb; }
        .dwell-hint { font-size:11px; color:#c4c8cf; }
        .dwell-comment { width:150px; font-size:12px; padding:4px 8px; border:1px solid #e5e7eb; border-radius:7px; background:#fafafa; }
        .dwell-comment:focus { outline:none; border-color:#2563eb; background:#fff; }
      `}</style>

      <div className="dwell-card">
        <h3>Monitored zones</h3>
        <div className="dwell-create">
          <div>
            <div className="dwell-field dwell-search-wrap">
              <label>Search city or area</label>
              <input className="dwell-input" value={query} placeholder="e.g. Becharaji, Gujarat"
                onChange={(e) => setQuery(e.target.value)} />
              {(searching || results.length > 0) && (
                <div className="dwell-suggest">
                  {searching && <div style={{ padding: "9px 11px", fontSize: 13, color: "#9ca3af" }}>Searching…</div>}
                  {results.map((r, i) => (
                    <button key={i} onClick={() => pickResult(r)}>{r.label || r.name}</button>
                  ))}
                </div>
              )}
            </div>
            <div className="dwell-field">
              <label>Zone name</label>
              <input className="dwell-input" value={name} placeholder="Name this zone"
                onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="dwell-field">
              <label>Radius</label>
              <div className="dwell-radius-row">
                <input type="range" min={0.5} max={50} step={0.5} value={radiusKm}
                  onChange={(e) => setRadiusKm(Number(e.target.value))} />
                <span className="dwell-radius-val">{radiusKm} km</span>
              </div>
            </div>
            <button className="dwell-save" onClick={saveZone} disabled={saving || lat == null}>
              {saving ? "Saving…" : "Save zone"}
            </button>
            {lat != null && <div style={{ fontSize: 12, color: "#6b7280", marginTop: 8 }}>Center: {lat.toFixed(4)}, {lng.toFixed(4)} — tap the map to adjust.</div>}
          </div>
          <div className="dwell-map">
            <MapContainer center={mapCenter} zoom={lat != null ? 11 : 5} style={{ width: "100%", height: "100%" }} scrollWheelZoom>
              <TileLayer url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png" attribution="&copy; OpenStreetMap" />
              <Recenter lat={lat} lng={lng} />
              <ClickToPlace onPick={(la, ln) => { setLat(la); setLng(ln); }} />
              {lat != null && lng != null && (
                <>
                  <Marker position={[lat, lng]} icon={pin} />
                  <Circle center={[lat, lng]} radius={radiusKm * 1000}
                    pathOptions={{ color: "#2563eb", fillColor: "#2563eb", fillOpacity: 0.12 }} />
                </>
              )}
            </MapContainer>
          </div>
        </div>

        <div style={{ marginTop: 14 }}>
          {zonesLoading ? (
            <div className="dwell-empty">Loading zones…</div>
          ) : zones.length === 0 ? (
            <div className="dwell-empty">No zones yet. Search a place, set a radius, and save one.</div>
          ) : zones.map((z) => (
            <div className="dwell-zone-item" key={z.id}>
              <div>
                <div style={{ fontWeight: 600 }}>{z.name}</div>
                <div className="dwell-zone-meta">{(z.radiusM / 1000).toFixed(1)} km · {z.centerLat.toFixed(3)}, {z.centerLng.toFixed(3)}</div>
              </div>
              <button className="dwell-zone-del" onClick={() => removeZone(z.id)}>Remove</button>
            </div>
          ))}
        </div>
      </div>

      <div className="dwell-card">
        <div className="dwell-head">
          <div>
            <div className="dwell-title">Vehicles in a zone</div>
            <div className="dwell-sub">Currently sitting inside a monitored zone. Amber past 6h, red past 10h.</div>
          </div>
          <div className="dwell-pills">
            <span className="dwell-pill">{counts.total} in zone</span>
            {counts.amber > 0 && <span className="dwell-pill amber">{counts.amber} over 6h</span>}
            {counts.red > 0 && <span className="dwell-pill red">{counts.red} over 10h</span>}
          </div>
        </div>

        <div className="dwell-filter">
          <label htmlFor="dwell-min">Show vehicles here more than</label>
          <select id="dwell-min" value={minHours} onChange={(e) => setMinHours(Number(e.target.value))}>
            <option value={0}>Any time</option>
            <option value={2}>2 hours</option>
            <option value={4}>4 hours</option>
            <option value={6}>6 hours</option>
            <option value={8}>8 hours</option>
            <option value={10}>10 hours</option>
            <option value={12}>12 hours</option>
          </select>
        </div>

        {dwellLoading ? (
          <div className="dwell-empty">Loading…</div>
        ) : enriched.length === 0 ? (
          <div className="dwell-empty">
            {rows.length === 0 ? "No vehicles are currently inside any monitored zone." : "No vehicles have been in a zone more than " + minHours + " hours."}
          </div>
        ) : (
          <table className="dwell-table">
            <thead>
              <tr>
                <th>Vehicle</th><th>Time in zone</th><th>Entered</th><th>Zone</th>
                <th>Load</th><th>Customer</th><th>Route</th><th>LR Date</th>
                <th>Reasons</th><th>Comment</th>
              </tr>
            </thead>
            <tbody>
              {enriched.map((r) => {
                const tv = r.tv, ld = r.ld;
                const inc = tv ? vehicleIncidents[tv.id] : null;
                const commentKey = tv ? tv.id : normVnum(r.vnum);
                const comment = dwellComments[commentKey]?.note || "";
                const saveComment = (note) => {
                  if (!setDwellComments) return;
                  const clean = String(note || "").trim();
                  setDwellComments((p) => {
                    const n = { ...(p || {}) };
                    if (clean) n[commentKey] = { note: clean, at: new Date().toISOString(), vnum: r.vnum };
                    else delete n[commentKey];
                    return n;
                  });
                };
                return (
                <tr key={r.vehicleId + ":" + r.zoneId}
                  style={{ background: ROW_BG[r.sev], boxShadow: r.sev !== "none" ? "inset 3px 0 0 " + ROW_ACCENT[r.sev] : undefined }}>
                  <td className="dwell-vnum">
                    <span className="dwell-dot" style={{ background: r.sev === "none" ? "#d1d5db" : ROW_ACCENT[r.sev] }} />
                    {r.vnum}
                  </td>
                  <td className="dwell-dur" style={{ color: r.sev === "red" ? "#b91c1c" : r.sev === "amber" ? "#b45309" : "#1f2937" }}>
                    {fmtDur(r.ms)}
                  </td>
                  <td>{fmtEntered(r.enteredAt)}</td>
                  <td className="dwell-zone">{r.zoneName || "—"}</td>

                  {/* Load context — "—" = plate didn't match the fleet; "NO LOAD" = matched, nothing attached */}
                  <td>{ld ? <span className="dwell-lid">{ld.lid}</span> : tv ? <span className="dwell-noload">no load</span> : <span className="dwell-hint">—</span>}</td>
                  <td className="dwell-zone">{ld?.customer || "—"}</td>
                  <td className="dwell-zone">{ld ? `${(ld.origin||"—").split(",")[0]} → ${(ld.dest||"—").split(",")[0]}` : "—"}</td>
                  <td className="dwell-zone">{ld?.lrDate || "—"}</td>

                  {/* Reasons — badges for what's marked + buttons into the SAME mechanisms */}
                  <td>
                    <div className="dwell-reasons">
                      {inc && (
                        <button className={"dwell-badge " + (inc.type === "ACCIDENT" ? "red" : "amber")}
                          title={`${inc.type} — ${inc.note || ""} (${inc.reportedAt || ""}). Click to manage.`}
                          onClick={() => onManageIncident && tv && onManageIncident(tv.id)}>
                          {inc.type === "ACCIDENT" ? "🚑 Accident" : "🔧 Breakdown"}
                        </button>
                      )}
                      {tv?.withoutDriver && (
                        <button className="dwell-badge amber"
                          title={`Without driver${tv.withoutDriverEta ? " — ETA " + new Date(tv.withoutDriverEta).toLocaleString("en-IN") : ""}. Click to clear / update.`}
                          onClick={() => onMarkWithoutDriver && tv && onMarkWithoutDriver(tv)}>
                          No Driver
                        </button>
                      )}
                      {!inc && tv && onReportIncident && (
                        <button className="dwell-rbtn" title={ld ? "Report a breakdown / accident on this vehicle (same as Load Board)" : "Report a breakdown / accident on this vehicle (no load attached)"}
                          onClick={() => onReportIncident(ld ? ld.id : { vehicleId: tv.id })}>+ Incident</button>
                      )}
                      {tv && !tv.withoutDriver && onMarkWithoutDriver && (
                        <button className="dwell-rbtn" title="Mark this vehicle as without driver (same as fleet page)"
                          onClick={() => onMarkWithoutDriver(tv)}>+ No Driver</button>
                      )}
                      {!tv && <span className="dwell-hint" title="This plate isn't in the TMS fleet list">not in fleet</span>}
                    </div>
                  </td>

                  {/* Comment — free text, saved on Enter / blur, synced for all dispatchers */}
                  <td>
                    <input
                      className="dwell-comment"
                      defaultValue={comment}
                      placeholder="add comment…"
                      title={dwellComments[commentKey]?.at ? "Last updated " + new Date(dwellComments[commentKey].at).toLocaleString("en-IN") : "Comment visible to all dispatchers"}
                      onBlur={(e) => { if (e.target.value !== comment) saveComment(e.target.value); }}
                      onKeyDown={(e) => { if (e.key === "Enter") e.currentTarget.blur(); }}
                    />
                  </td>
                </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  );
}
