import React, { useEffect, useMemo, useRef, useState } from "react";
import { MapContainer, TileLayer, Marker, Popup, useMap } from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import { useVehicleTrail, TrailLayer, TrailPanel } from "./VehicleTrailSlider";

const VS_LABELS = {
  AVAILABLE: "Available",
  SENT_FOR_LOADING: "Sent For Loading",
  AT_LOADING: "At Loading",
  IN_TRANSIT: "On Trip",
  AT_UNLOADING: "At Unloading",
  DELIVERED: "Delivered",
  MAINTENANCE: "Maintenance",
};

const STATUS_COLORS = {
  AVAILABLE:        "#047857",
  IN_TRANSIT:       "#1d4ed8",
  AT_LOADING:       "#b45309",
  SENT_FOR_LOADING: "#4338ca",
  AT_UNLOADING:     "#9d174d",
  MAINTENANCE:      "#52525b",
  DELIVERED:        "#0f766e",
  DELAYED:          "#b91c1c",
};

const STATUS_FILTERS = [
  ["ALL", "All", "#0f172a"],
  ["IN_TRANSIT", "On Trip", STATUS_COLORS.IN_TRANSIT],
  ["AT_LOADING", "At Loading", STATUS_COLORS.AT_LOADING],
  ["AT_UNLOADING", "At Unloading", STATUS_COLORS.AT_UNLOADING],
  ["AVAILABLE", "Available", STATUS_COLORS.AVAILABLE],
  ["DELAYED", "Delayed", STATUS_COLORS.DELAYED],
];

function gpsVehicleKey(vnum) {
  return String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(AIS|GPS|VTS)$/, "");
}
function gpsVehicleKeyAlt(vnum) {
  const s = String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length > 10 ? s.slice(-10) : s;
}

function relTime(ts) {
  if (!ts) return "—";
  const s = Math.max(0, Math.floor((Date.now() - new Date(ts).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h ago`;
}

// Truck SVG marker as Leaflet divIcon — tinted per status.
function truckIcon(color, label, ring) {
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 0 32 32">
      <circle cx="16" cy="16" r="15" fill="${color}" stroke="${ring || "#fff"}" stroke-width="2"/>
      <path d="M6 19V11h11l3 3h6v5h-2a2 2 0 1 1-4 0h-6a2 2 0 1 1-4 0H6z" fill="#fff"/>
      <circle cx="11" cy="21" r="1.6" fill="${color}"/>
      <circle cx="22" cy="21" r="1.6" fill="${color}"/>
    </svg>`;
  return L.divIcon({
    className: "fleet-truck-icon",
    html: `<div style="position:relative;display:flex;align-items:center;justify-content:center;filter:drop-shadow(0 2px 3px rgba(0,0,0,.35))">${svg}${
      label
        ? `<div style="position:absolute;bottom:-14px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;font:700 9px/1 system-ui;padding:1px 5px;border-radius:8px;white-space:nowrap;letter-spacing:.3px">${label}</div>`
        : ""
    }</div>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
    popupAnchor: [0, -14],
  });
}

function FitToMarkers({ points, signal }) {
  const map = useMap();
  const did = useRef(false);
  useEffect(() => {
    if (!points.length) return;
    if (did.current && signal === "auto") return;
    const bounds = L.latLngBounds(points.map((p) => [p.lat, p.lng]));
    map.fitBounds(bounds.pad(0.15), { animate: true, maxZoom: 11 });
    did.current = true;
  }, [points, signal, map]);
  return null;
}

export default function FleetMap({
  vehicles = [],
  loads = [],
  gpsMap = {},
  delayedLoadIds = new Set(),
  onSeeMore,
}) {
  const [statusFilter, setStatusFilter] = useState("ALL");
  const [branchFilter, setBranchFilter] = useState("");
  const [customerFilter, setCustomerFilter] = useState("");
  const [delayedOnly, setDelayedOnly] = useState(false);
  const [search, setSearch] = useState("");
  const [fitSignal, setFitSignal] = useState(0);
  const [trailVehicle, setTrailVehicle] = useState(null);
  const trail = useVehicleTrail(trailVehicle);

  const loadByVehicleId = useMemo(() => {
    const m = new Map();
    for (const l of loads) if (l.vehicleId) m.set(l.vehicleId, l);
    return m;
  }, [loads]);

  // Build marker points (vehicles with valid GPS).
  const points = useMemo(() => {
    const out = [];
    for (const v of vehicles) {
      const vk = gpsVehicleKey(v.vnum);
      const vkAlt = gpsVehicleKeyAlt(v.vnum);
      const gps = gpsMap[vk] || gpsMap[vkAlt] || gpsMap[String(v.vnum || "").toUpperCase()];
      if (!gps || gps.lat == null || gps.lng == null) continue;
      const load = loadByVehicleId.get(v.id) || null;
      const isDelayed = load ? delayedLoadIds.has(load.id) : false;
      out.push({
        id: v.id,
        vnum: v.vnum,
        vstatus: v.vstatus,
        lat: gps.lat,
        lng: gps.lng,
        updatedAt: gps.updatedAt,
        address: gps.address,
        load,
        isDelayed,
        branch: load?.branch || "",
        customer: load?.customer || "",
      });
    }
    return out;
  }, [vehicles, gpsMap, loadByVehicleId, delayedLoadIds]);

  const branchOpts = useMemo(
    () => [...new Set(points.map((p) => p.branch).filter(Boolean))].sort(),
    [points]
  );
  const customerOpts = useMemo(
    () => [...new Set(points.map((p) => p.customer).filter(Boolean))].sort(),
    [points]
  );

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return points.filter((p) => {
      if (statusFilter !== "ALL") {
        if (statusFilter === "DELAYED") { if (!p.isDelayed) return false; }
        else if (p.vstatus !== statusFilter) return false;
      }
      if (delayedOnly && !p.isDelayed) return false;
      if (branchFilter && p.branch !== branchFilter) return false;
      if (customerFilter && p.customer !== customerFilter) return false;
      if (q && !String(p.vnum || "").toLowerCase().includes(q)) return false;
      return true;
    });
  }, [points, statusFilter, branchFilter, customerFilter, delayedOnly, search]);

  // Default center (rough India centroid). Auto-fit overrides on first render.
  const center = points[0] ? [points[0].lat, points[0].lng] : [22.5, 79];

  const chipBtn = (active, color) => ({
    padding: "5px 11px",
    borderRadius: 999,
    border: `1px solid ${active ? color : "var(--border)"}`,
    background: active ? color : "var(--bg)",
    color: active ? "#fff" : "var(--text)",
    fontFamily: "var(--font-head)",
    fontSize: ".72rem",
    fontWeight: 700,
    letterSpacing: .5,
    textTransform: "uppercase",
    cursor: "pointer",
    whiteSpace: "nowrap",
  });

  const inputStyle = {
    padding: "6px 10px",
    borderRadius: 6,
    border: "1px solid var(--border)",
    background: "var(--bg)",
    color: "var(--text)",
    fontSize: ".82rem",
    outline: "none",
    minWidth: 130,
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", flex: 1, height: "100%", background: "var(--bg)" }}>
      {/* Filter bar */}
      <div style={{ display: "flex", gap: 8, padding: "10px 14px", borderBottom: "1px solid var(--border)", background: "var(--surface)", flexWrap: "wrap", alignItems: "center" }}>
        {STATUS_FILTERS.map(([k, lbl, col]) => (
          <button key={k} onClick={() => setStatusFilter(k)} style={chipBtn(statusFilter === k, col)}>{lbl}</button>
        ))}
        <div style={{ width: 1, alignSelf: "stretch", background: "var(--border)", margin: "0 4px" }} />
        <select value={branchFilter} onChange={(e) => setBranchFilter(e.target.value)} style={inputStyle}>
          <option value="">All branches</option>
          {branchOpts.map((b) => <option key={b} value={b}>{b}</option>)}
        </select>
        <select value={customerFilter} onChange={(e) => setCustomerFilter(e.target.value)} style={inputStyle}>
          <option value="">All customers</option>
          {customerOpts.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: ".78rem", fontWeight: 600, color: "var(--text)", cursor: "pointer" }}>
          <input type="checkbox" checked={delayedOnly} onChange={(e) => setDelayedOnly(e.target.checked)} />
          🔴 Delayed only
        </label>
        <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="🔎 Vehicle no…" style={{ ...inputStyle, minWidth: 160 }} />
        <button onClick={() => setFitSignal((n) => n + 1)} style={{ ...chipBtn(false, "#0f172a"), background: "var(--bg)" }} title="Recenter map to fit all visible vehicles">⤢ Fit</button>
        <div style={{ marginLeft: "auto", fontFamily: "var(--font-head)", fontSize: ".78rem", fontWeight: 700, color: "var(--text2)", letterSpacing: .5 }}>
          Showing <span style={{ color: "var(--accent)" }}>{filtered.length}</span> of {points.length}
          {points.length < vehicles.length && <span style={{ color: "var(--text3)", marginLeft: 6 }}>· {vehicles.length - points.length} no GPS</span>}
        </div>
      </div>

      {/* Map */}
      <div style={{ flex: 1, position: "relative", minHeight: 400 }}>
        <MapContainer center={center} zoom={5} style={{ width: "100%", height: "100%" }} scrollWheelZoom>
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <FitToMarkers points={filtered} signal={fitSignal === 0 ? "auto" : `m${fitSignal}`} />
          {filtered.map((p) => {
            const color = p.isDelayed ? STATUS_COLORS.DELAYED : (STATUS_COLORS[p.vstatus] || "#6b7280");
            return (
              <Marker key={p.id} position={[p.lat, p.lng]} icon={truckIcon(color, p.vnum, p.isDelayed ? "#fee2e2" : "#fff")}>
                <Popup>
                  <div style={{ minWidth: 220, fontFamily: "system-ui, sans-serif" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
                      <div style={{ fontWeight: 800, fontSize: ".95rem" }}>🚛 {p.vnum}</div>
                      <span style={{ marginLeft: "auto", background: color, color: "#fff", padding: "2px 8px", borderRadius: 12, fontSize: ".62rem", fontWeight: 800, textTransform: "uppercase", letterSpacing: .4 }}>
                        {p.isDelayed ? "Delayed" : (VS_LABELS[p.vstatus] || p.vstatus || "—")}
                      </span>
                    </div>
                    {p.load ? (
                      <>
                        <div style={{ fontSize: ".78rem", marginTop: 4 }}>
                          <b>LR:</b> {p.load.lid || "—"}
                        </div>
                        <div style={{ fontSize: ".78rem", marginTop: 2 }}>
                          {p.load.origin || "—"} <span style={{ color: "#6b7280" }}>→</span> {p.load.dest || "—"}
                        </div>
                        {p.load.customer && (
                          <div style={{ fontSize: ".75rem", marginTop: 2, color: "#475569" }}>
                            <b>Customer:</b> {p.load.customer}
                          </div>
                        )}
                      </>
                    ) : (
                      <div style={{ fontSize: ".78rem", color: "#6b7280", marginTop: 4 }}>No active load assigned</div>
                    )}
                    {p.address && (
                      <div style={{ fontSize: ".7rem", color: "#6b7280", marginTop: 4, lineHeight: 1.3 }}>📍 {p.address}</div>
                    )}
                    <div style={{ fontSize: ".68rem", color: "#94a3b8", marginTop: 4 }}>
                      Last update: {relTime(p.updatedAt)}
                    </div>
                    {p.load && onSeeMore && (
                      <button
                        onClick={() => onSeeMore(p.load.id)}
                        style={{ marginTop: 8, width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid #2563eb", background: "#2563eb", color: "#fff", fontWeight: 700, fontSize: ".74rem", cursor: "pointer", letterSpacing: .3 }}
                      >
                        See more details →
                      </button>
                    )}
                    <button
                      onClick={() => setTrailVehicle(p.vnum)}
                      style={{ marginTop: 6, width: "100%", padding: "5px 8px", borderRadius: 5, border: "1px solid #0f172a", background: "#fff", color: "#0f172a", fontWeight: 700, fontSize: ".74rem", cursor: "pointer", letterSpacing: .3 }}
                      title="Show 7-day hourly trail"
                    >
                      🛤 Show 7-day trail
                    </button>
                  </div>
                </Popup>
              </Marker>
            );
          })}
          {trail && <TrailLayer trail={trail} />}
        </MapContainer>


        {/* Legend overlay */}
        <div style={{ position: "absolute", left: 12, bottom: 12, background: "rgba(255,255,255,0.95)", border: "1px solid var(--border)", borderRadius: 8, padding: "8px 10px", boxShadow: "0 4px 12px rgba(0,0,0,.15)", zIndex: 500, fontSize: ".7rem" }}>
          <div style={{ fontWeight: 800, fontSize: ".68rem", textTransform: "uppercase", letterSpacing: 1, color: "#475569", marginBottom: 4 }}>Legend</div>
          {[
            ["On Trip", STATUS_COLORS.IN_TRANSIT],
            ["At Loading", STATUS_COLORS.AT_LOADING],
            ["At Unloading", STATUS_COLORS.AT_UNLOADING],
            ["Available", STATUS_COLORS.AVAILABLE],
            ["Sent For Loading", STATUS_COLORS.SENT_FOR_LOADING],
            ["Delayed", STATUS_COLORS.DELAYED],
            ["Maintenance", STATUS_COLORS.MAINTENANCE],
          ].map(([lbl, col]) => (
            <div key={lbl} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
              <span style={{ width: 10, height: 10, borderRadius: "50%", background: col, border: "1px solid #fff", boxShadow: "0 0 0 1px rgba(0,0,0,.15)" }} />
              <span style={{ color: "#1f2937" }}>{lbl}</span>
            </div>
          ))}
        </div>
        <TrailPanel trail={trail} onClose={() => setTrailVehicle(null)} />
      </div>
    </div>
  );
}

