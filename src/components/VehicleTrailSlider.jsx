import React, { useEffect, useRef, useState } from "react";
import { Polyline, CircleMarker, Tooltip, useMap } from "react-leaflet";
import { useServerFn } from "@tanstack/react-start";
import { getVehicleTrail } from "@/lib/gps.functions";

/**
 * 7-day hourly trail playback.
 *   const trail = useVehicleTrail(vehicleNumber); // null when no vehicle
 *   <MapContainer>... {trail && <TrailLayer trail={trail} />} </MapContainer>
 *   {trail && <TrailPanel trail={trail} onClose={...} />}
 */

export function useVehicleTrail(vehicleNumber) {
  const fetchTrail = useServerFn(getVehicleTrail);
  const [points, setPoints] = useState([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState("");
  const [idx, setIdx] = useState(0);
  const [playing, setPlaying] = useState(false);
  const timer = useRef(null);

  useEffect(() => {
    if (!vehicleNumber) { setPoints([]); setErr(""); setIdx(0); return; }
    let cancelled = false;
    setLoading(true); setErr(""); setPoints([]);
    fetchTrail({ data: { vehicleNumber } })
      .then((res) => {
        if (cancelled) return;
        const pts = res?.points || [];
        setPoints(pts);
        setIdx(Math.max(0, pts.length - 1));
      })
      .catch((e) => !cancelled && setErr(e?.message || "Failed to load trail"))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, [vehicleNumber, fetchTrail]);

  useEffect(() => {
    if (!playing || points.length < 2) return;
    timer.current = setInterval(() => {
      setIdx((i) => {
        if (i >= points.length - 1) { setPlaying(false); return i; }
        return i + 1;
      });
    }, 500);
    return () => clearInterval(timer.current);
  }, [playing, points.length]);

  if (!vehicleNumber) return null;
  return {
    vehicleNumber, points, idx, setIdx, loading, err, playing, setPlaying,
    reset: () => { setIdx(0); setPlaying(false); },
  };
}

export function TrailLayer({ trail, color = "#2563eb" }) {
  const map = useMap();
  const fittedRef = useRef(null);

  useEffect(() => { fittedRef.current = null; }, [trail?.vehicleNumber]);
  useEffect(() => {
    if (!trail || trail.points.length < 2 || !map) return;
    if (fittedRef.current === trail.vehicleNumber) return;
    try {
      const bounds = trail.points.map((p) => [p.lat, p.lng]);
      map.fitBounds(bounds, { padding: [40, 40], maxZoom: 13 });
      fittedRef.current = trail.vehicleNumber;
    } catch { /* noop */ }
  }, [trail, map]);

  if (!trail || trail.points.length === 0) return null;
  const { points, idx } = trail;
  const current = points[idx] || points[points.length - 1];
  const trailUpTo = points.slice(0, idx + 1).map((p) => [p.lat, p.lng]);
  const tsLabel = new Date(current.ts).toLocaleString("en-IN", {
    weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
  });

  return (
    <>
      {trailUpTo.length >= 2 && (
        <Polyline positions={trailUpTo} pathOptions={{ color, weight: 3, opacity: 0.75 }} />
      )}
      <CircleMarker
        center={[current.lat, current.lng]}
        radius={7}
        pathOptions={{ color: "#fff", weight: 2, fillColor: color, fillOpacity: 1 }}
      >
        <Tooltip permanent direction="top" offset={[0, -8]}>
          <div style={{ fontSize: ".68rem", fontWeight: 700 }}>{tsLabel}</div>
        </Tooltip>
      </CircleMarker>
    </>
  );
}

export function TrailPanel({ trail, onClose }) {
  if (!trail) return null;
  const { vehicleNumber, points, idx, setIdx, loading, err, playing, setPlaying, reset } = trail;
  const current = points[idx];
  const tsLabel = current && new Date(current.ts).toLocaleString("en-IN", {
    weekday: "short", hour: "2-digit", minute: "2-digit", day: "2-digit", month: "short",
  });

  return (
    <div style={panel}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
        <div style={{ fontWeight: 800, fontSize: ".78rem", color: "#0f172a" }}>
          🛤 7-day trail · {vehicleNumber}
        </div>
        <button onClick={onClose} style={closeBtn} title="Close trail">✕</button>
      </div>
      {loading && <div style={msg}>Loading…</div>}
      {err && <div style={{ ...msg, color: "#b91c1c" }}>⚠ {err}</div>}
      {!loading && !err && points.length === 0 && (
        <div style={msg}>No trail data yet — snapshots are collected hourly.</div>
      )}
      {!loading && !err && points.length === 1 && (
        <div style={msg}>Only 1 snapshot so far — playback needs ≥2 hours.</div>
      )}
      {!loading && !err && points.length >= 2 && (
        <>
          <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 4 }}>
            <button onClick={() => setPlaying(!playing)} style={btn} title={playing ? "Pause" : "Play"}>
              {playing ? "⏸" : "▶"}
            </button>
            <button onClick={reset} style={btn} title="Reset to start">⟲</button>
            <div style={{ fontSize: ".68rem", color: "#475569", fontWeight: 700, marginLeft: "auto" }}>
              {idx + 1}/{points.length}
            </div>
          </div>
          <input
            type="range"
            min={0}
            max={points.length - 1}
            value={idx}
            onChange={(e) => { setIdx(Number(e.target.value)); setPlaying(false); }}
            style={{ width: "100%" }}
          />
          <div style={{ fontSize: ".66rem", color: "#64748b", textAlign: "center", marginTop: 2 }}>
            {tsLabel}
            {current?.speed != null && <> · {Math.round(current.speed)} km/h</>}
          </div>
        </>
      )}
    </div>
  );
}

const panel = {
  position: "absolute", top: 12, right: 12, zIndex: 600,
  background: "rgba(255,255,255,0.97)", border: "1px solid #e2e8f0",
  borderRadius: 8, padding: "10px 12px", width: 260,
  boxShadow: "0 6px 20px rgba(0,0,0,.18)", fontFamily: "system-ui, sans-serif",
};
const msg = { fontSize: ".72rem", color: "#64748b", padding: "4px 0", textAlign: "center" };
const btn = {
  padding: "2px 10px", borderRadius: 4, border: "1px solid #cbd5e1",
  background: "#fff", cursor: "pointer", fontSize: ".85rem", lineHeight: 1,
};
const closeBtn = {
  marginLeft: "auto", padding: "2px 7px", borderRadius: 4, border: "1px solid #cbd5e1",
  background: "#fff", cursor: "pointer", fontSize: ".75rem",
};
