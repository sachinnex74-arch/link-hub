import { useState, useMemo, useEffect, useLayoutEffect, useRef, useDeferredValue, lazy, Suspense, Fragment } from "react";
import { createPortal } from "react-dom";
import * as XLSX from "xlsx";
import { useServerFn } from "@tanstack/react-start";
import { getLiveFleet, getVehicleByNumber, getVehicleTrail, getLoadHalts } from "@/lib/gps.functions";
import { searchIndianPlaces } from "@/lib/places.functions";
import { reverseGeocodeState, forwardGeocodeCity } from "@/lib/geo.functions";
import { Pencil, Trash2, MapPin, AlertTriangle, Eye, KeyRound, Flame, Truck as TruckIcon, Wrench, CheckCircle2, Package, PackageCheck, PackageOpen, CircleDot, Menu, XCircle, FileText as FileTextIcon } from "lucide-react";
const Geofences = lazy(() => import("./Geofences"));
const PODList = lazy(() => import("./PODList"));
const DwellVehiclesPanel = lazy(() => import("./DwellVehiclesPanel"));
const DeliveredLoads = lazy(() => import("./DeliveredLoads"));
const UsersAdmin = lazy(() => import("./UsersAdmin.jsx"));
const SystemHealth = lazy(() => import("./SystemHealth.jsx")); // Phase V: invariant + dead-cron banner

// ── D-3b: display reads of a load's stops come from the ROWS store when it has
// them (rows are the truth since the ownership flip), falling back to the blob
// arrays for delivered loads (deliberately not in the store) and any gap
// (pre-hydrate, legacy). Same-transaction projection means both sources always
// agree — this is the deprecation on-ramp, not a behavior change.
// Kill-switch: false → all reads back to arrays.
const D3_READ_ROWS = true;
function stopsFor(l) {
  if (D3_READ_ROWS && l && l.lstatus !== "DELIVERED") {
    const rows = getLoadStops(l.id);
    if (rows && rows.length) {
      return rows.map(r => ({
        cid: r.cid, city: r.city, delivered: !!r.delivered,
        podPath: r.pod_path, deliveredAt: r.delivered_at,
        manualOverride: r.manual_override, podOk: r.pod_ok,
      }));
    }
  }
  return Array.isArray(l?.consigneeDeliveries) ? l.consigneeDeliveries : [];
}
import { PrettyDate, PrettyDateTime } from "./PrettyDatePicker.jsx";
const LoadDetailsDialog = lazy(() => import("./LoadDetailsDialog"));
const FleetMap = lazy(() => import("./FleetMap"));
import { syncVehicles, syncLoads, getVehicles, getLoads, getPin, setPin as setVehiclePin } from "@/lib/driverStore";
import { getSyncStatus, subscribeSyncStatus, syncVehiclesDiff, syncLoadsDiff, isSyncHydrated, refreshFromCloud, nextLids, transitionVehicle, setLoadStopsRpc, STOPS_EDITOR_RPC, getLoadStops } from "@/lib/supaSync";
import { gwAssign, gwQueue, gwPromote, gwUnassign, gwUnassignForVehicleDelete, gwConsignee, gwDeliver } from "@/lib/loadGateway";
import { isTerminal } from "@/lib/transitions"; // shared terminal-state guard (DELIVERED or CANCELLED)

// ── Transition engine toggle (per-browser canary) ────────────────────────────
// OFF for everyone by default. To test in production on YOUR session only,
// either add ?engine=1 to the URL, or run in the browser console:
//     localStorage.setItem('tms_engine','on')   // then reload
// To turn your session off again: localStorage.removeItem('tms_engine')
// Once verified, flip the default below to `return true` to enable for everyone.
function transitionEngineEnabled() {
  try {
    if (typeof window !== "undefined") {
      const u = new URLSearchParams(window.location.search);
      if (u.get("engine") === "1") return true;
      if (u.get("engine") === "0") return false;
      if (localStorage.getItem("tms_engine") === "on") return true;
    }
  } catch {}
  return true; // engine enabled for all users
}
// Actions the engine owns (non-delivery). DELIVERED stays on app_deliver_load.
const ENGINE_ACTIONS = new Set(["SENT_FOR_LOADING", "AT_LOADING", "IN_TRANSIT", "AT_UNLOADING", "AVAILABLE", "MAINTENANCE"]);
import { createDriverAccountFn, getDriverCredentialsFn } from "@/lib/tms.functions";
// (tms-admin bulk-nuke imports removed Jul 4 — M3 audit: both functions retired.)
import { useSyncedSetting } from "@/hooks/useSyncedSetting";
import { useAuthSession, signOut } from "@/lib/authClient";
import { getMe } from "@/lib/auth.functions";
import { useNavigate } from "@tanstack/react-router";
const MaintManagePage = lazy(() => import("./MaintManage"));


// ─── GPS-based branch assignment ───
const GPS_BRANCHES = ["Gurgaon","Ahmedabad","Dahej","Pune","Nagpur","Hyderabad","Kerala","Chennai","Patna","Siliguri","Lucknow","Indore","Bhubaneshwar","Chhattisgarh","Ranchi","Kolkata","Rudrapur","Ambala/Ludhiana","Jammu","Himachal","Bangalore","Goa","Jaipur"];
const NE_STATES = new Set(["Assam","Arunachal Pradesh","Manipur","Meghalaya","Mizoram","Nagaland","Tripura","Sikkim"]);
const REF = {
  Delhi:     { lat: 28.6139, lng: 77.2090 },
  Nagpur:    { lat: 21.1458, lng: 79.0882 },
  Pune:      { lat: 18.5204, lng: 73.8567 },
  Hyderabad: { lat: 17.3850, lng: 78.4867 },
  Ahmedabad: { lat: 23.0225, lng: 72.5714 },
  Dahej:     { lat: 21.7049, lng: 72.5662 },
  Kolkata:   { lat: 22.5726, lng: 88.3639 },
  Siliguri:  { lat: 26.7271, lng: 88.3953 },
};
function _hav(a,b,c,d){const R=6371,r=x=>x*Math.PI/180,dL=r(c-a),dN=r(d-b);const x=Math.sin(dL/2)**2+Math.cos(r(a))*Math.cos(r(c))*Math.sin(dN/2)**2;return 2*R*Math.asin(Math.sqrt(x));}
function computeGpsBranch(state, lat, lng) {
  if (lat == null || lng == null) return null;
  const distDelhi = _hav(lat,lng,REF.Delhi.lat,REF.Delhi.lng);
  if (distDelhi <= 100) return "Gurgaon";
  if (!state) return null;
  if (state === "Haryana" || state === "Delhi" || state === "National Capital Territory of Delhi") return "Gurgaon";
  if (state === "Gujarat") {
    return _hav(lat,lng,REF.Dahej.lat,REF.Dahej.lng) < _hav(lat,lng,REF.Ahmedabad.lat,REF.Ahmedabad.lng) ? "Dahej" : "Ahmedabad";
  }
  if (state === "Maharashtra") {
    return _hav(lat,lng,REF.Nagpur.lat,REF.Nagpur.lng) < _hav(lat,lng,REF.Pune.lat,REF.Pune.lng) ? "Nagpur" : "Pune";
  }
  if (state === "Kerala") return "Kerala";
  if (state === "Telangana" || state === "Andhra Pradesh") return "Hyderabad";
  if (state === "Tamil Nadu") {
    const dH = _hav(lat,lng,REF.Hyderabad.lat,REF.Hyderabad.lng);
    return dH < 400 ? "Hyderabad" : "Chennai";
  }
  if (state === "Bihar") return "Patna";
  if (NE_STATES.has(state)) return "Siliguri";
  if (state === "West Bengal") {
    return _hav(lat,lng,REF.Kolkata.lat,REF.Kolkata.lng) < _hav(lat,lng,REF.Siliguri.lat,REF.Siliguri.lng)
      ? "Kolkata" : "Siliguri";
  }
  if (state === "Odisha") return "Bhubaneshwar";
  if (state === "Chhattisgarh") return "Chhattisgarh";
  if (state === "Jharkhand") return "Ranchi";
  if (state === "Uttarakhand") return "Rudrapur";
  if (state === "Punjab") return "Ambala/Ludhiana";
  if (state === "Jammu and Kashmir" || state === "Ladakh") return "Jammu";
  if (state === "Himachal Pradesh") return "Himachal";
  if (state === "Uttar Pradesh") return "Lucknow";
  if (state === "Madhya Pradesh") return "Indore";
  if (state === "Karnataka") return "Bangalore";
  if (state === "Goa") return "Goa";
  if (state === "Rajasthan") return "Jaipur";
  return null;
}

const ADDRESS_STATES = ["Andhra Pradesh","Arunachal Pradesh","Assam","Bihar","Chhattisgarh","Delhi","Goa","Gujarat","Haryana","Himachal Pradesh","Jammu and Kashmir","Jharkhand","Karnataka","Kerala","Ladakh","Madhya Pradesh","Maharashtra","Manipur","Meghalaya","Mizoram","Nagaland","Odisha","Punjab","Rajasthan","Sikkim","Tamil Nadu","Telangana","Tripura","Uttar Pradesh","Uttarakhand","West Bengal"];
function stateFromGpsAddress(address) {
  const text = String(address || "").toLowerCase();
  return ADDRESS_STATES.find(s => text.includes(s.toLowerCase())) || null;
}
// Format a GPS address into "District, State" for exports / display.
// Strips country, PIN codes, lat/lng coords, and obvious road/highway tokens.
function formatDistrictState(address) {
  const raw = String(address || "").trim();
  if (!raw) return "";
  const state = stateFromGpsAddress(raw);
  const parts = raw.split(",").map(s => s.trim()).filter(Boolean).filter(p => {
    if (/^india$/i.test(p)) return false;
    if (/^\d{5,6}$/.test(p)) return false;            // PIN code alone
    if (/^-?\d+\.\d+$/.test(p)) return false;          // coordinate
    return true;
  });
  // Drop PIN codes appended to a token: "Gurugram 122001" -> "Gurugram"
  const cleaned = parts.map(p => p.replace(/\s+\d{5,6}\b/g, "").trim()).filter(Boolean);
  let district = "";
  if (state) {
    const stateIdx = cleaned.findIndex(p => p.toLowerCase() === state.toLowerCase());
    const pool = stateIdx > 0 ? cleaned.slice(0, stateIdx) : cleaned.filter(p => p.toLowerCase() !== state.toLowerCase());
    // Prefer a token that looks like a place (not a road / NH / sector / plot)
    const isRoadish = (p) => /\b(road|rd\.?|highway|nh[- ]?\d+|sh[- ]?\d+|expressway|bypass|marg|chowk|sector|block|plot|near|opposite|opp\.?|phase|industrial|village)\b/i.test(p) || /^\d/.test(p);
    const place = [...pool].reverse().find(p => !isRoadish(p)) || pool[pool.length - 1] || "";
    district = place;
  } else {
    district = cleaned[cleaned.length - 1] || "";
  }
  return [district, state].filter(Boolean).join(", ");
}

const GEO_LOOKUP_TIMEOUT_MS = 12_000;
const GEO_MAX_ATTEMPTS = 3;
const GEO_RETRY_BASE_MS = 15_000;
function gpsCoordKey(g) {
  if (!g || g.lat == null || g.lng == null) return "";
  return `${Number(g.lat).toFixed(5)},${Number(g.lng).toFixed(5)}`;
}
function gpsVehicleKey(vnum) {
  return String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(AIS|GPS|VTS)$/, "");
}
// Secondary fallback key — last 10 alphanumerics, bridges format drift
function gpsVehicleKeyAlt(vnum) {
  const s = String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length > 10 ? s.slice(-10) : s;
}
// All candidate keys we may use to match a vehicle in the GPS map.
// Intentionally conservative: do NOT include short suffixes (last-6/last-8) —
// those collide across different vehicles and cause GPS to flicker between trucks.
function gpsVehicleAllKeys(vnum) {
  const raw = String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (!raw) return [];
  const keys = new Set();
  keys.add(raw);
  keys.add(gpsVehicleKey(vnum));
  keys.add(gpsVehicleKeyAlt(vnum));
  keys.delete("");
  return [...keys];
}
function lookupGps(gpsMap, vnum) {
  if (!gpsMap || !vnum) return null;
  for (const k of gpsVehicleAllKeys(vnum)) {
    if (gpsMap[k]) return gpsMap[k];
  }
  return null;
}
// Shared TAT-style target/ETA computation (canonical formula used everywhere).
// Formula: ETA = now + (haversine_km(GPS → dest) / 22 km/h) + N × 24h
// where N = count of non-empty consignees on the load (multi-drop bump).
function computeTat(load, vehicle, cityCoords, gpsMap) {
  if (!load) return { targetAt: null, arrivalAt: null, consigneeBumpHours: 0, consigneeCount: 0 };
  const o = cityCoords?.[(load.origin || "").trim().toLowerCase()];
  const d = cityCoords?.[(load.dest || "").trim().toLowerCase()];
  const baseDateStr = (load.lrDate || vehicle?.lrDate || load.pickup || "").slice(0, 10);
  const consigneeCount = Array.isArray(load.consignees) ? load.consignees.filter(Boolean).length : 0;
  const bumpHours = consigneeCount * 24;
  const bumpMs = bumpHours * 3600 * 1000;
  let targetAt = null, arrivalAt = null, tatDays = null, distOD = null, distToGo = null;
  if (o && d && o.lat != null && o.lng != null && d.lat != null && d.lng != null) {
    distOD = _hav(o.lat, o.lng, d.lat, d.lng) * 1.25;
    tatDays = Math.round((distOD / 22) / 24);
    const shortHaulKm = (load.branch === "Pune") ? 1400 : 1700;
    // Short-haul +1 day, EXCEPT for Gurgaon-origin loads delivering to Becharaji
    // (that lane's targeted date is computed without the +1 bump).
    const destStr = (load.dest || "").toLowerCase();
    const isGurgaonToBecharaji =
      load.branch === "Gurgaon" &&
      (destStr.includes("becharaji") || destStr.includes("bechraji"));
    if (distOD < shortHaulKm && !isGurgaonToBecharaji) tatDays += 1;
    if (baseDateStr) {
      const t = new Date(`${baseDateStr}T15:00:00+05:30`);
      t.setDate(t.getDate() + tatDays + consigneeCount);
      targetAt = t;
    }
    const g = lookupGps(gpsMap, vehicle?.vnum);
    if (g && g.lat != null && g.lng != null) {
      distToGo = _hav(g.lat, g.lng, d.lat, d.lng) * 1.25;
      arrivalAt = new Date(Date.now() + (distToGo / 22) * 3600 * 1000 + bumpMs);
    }
  }
  return { targetAt, arrivalAt, tatDays, distOD, distToGo, consigneeBumpHours: bumpHours, consigneeCount };
}
// Explain *why* a row has no live ETA. Returns a short user-facing string.
function gpsReasonFor(load, vehicle, cityCoords, gpsMap) {
  if (!load) return "no load";
  if (!vehicle) return "no vehicle";
  const oKey = (load.origin || "").trim().toLowerCase();
  const dKey = (load.dest || "").trim().toLowerCase();
  const o = oKey ? cityCoords?.[oKey] : null;
  const d = dKey ? cityCoords?.[dKey] : null;
  const oOk = o && o.lat != null && o.lng != null;
  const dOk = d && d.lat != null && d.lng != null;
  if (!oKey || !dKey) return "load missing origin/dest";
  if (!oOk && !dOk) return `geocoding "${load.origin}" & "${load.dest}"…`;
  if (!oOk) return `geocoding origin "${load.origin}"…`;
  if (!dOk) return `geocoding dest "${load.dest}"…`;
  const g = lookupGps(gpsMap, vehicle.vnum);
  if (!g) return `vehicle ${vehicle.vnum} not in GPS feed`;
  if (g.lat == null || g.lng == null) return `GPS feed has no coords for ${vehicle.vnum}`;
  if (g.updatedAt && Date.now() - g.updatedAt > 6 * 3600 * 1000) return "GPS feed stale (>6h)";
  return "awaiting GPS";
}

function withTimeout(promise, ms, message = "Request timed out") {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ─── Geo helpers (auto At-Unloading detection) ───
const UNLOAD_RADIUS_KM = 80;
// Hysteresis for "left unloading" demote — only flag if GPS is past this buffer
// beyond the unload radius (200 km total from destination). Stops false positives
// from roads that briefly clip and exit the 80 km ring (e.g. mountain detours).
const UNLOAD_EXIT_BUFFER_KM = 120;
// Minimum continuous dwell inside the unload radius before a demote can be
// flagged as "left unloading". Shorter = silent demote, no warning recorded.
const MIN_UNLOAD_DWELL_MS = 4 * 60 * 60 * 1000; // 4 hours
// Sanity cap: any computed distance-from-destination > this is treated as a
// bad GPS / wrong geocode reading and demoted silently.
const MAX_PLAUSIBLE_LEFT_KM = 500;
// Require GPS sample to be at most this old when recording a left-unloading event.
const GPS_FRESH_MS = 30 * 60 * 1000; // 30 min
// Vehicle must have come within this distance of destination at some point
// while AT_UNLOADING for a demote to count as "left unloading" (vs just
// clipping the radius edge).
const NEAR_DEST_KM = 70;
function haversineKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}
const DEFAULT_CITY_COORDS = {
  lucknow: { lat: 26.8467, lng: 80.9462 },
};
// city(lower) -> {lat,lng} on success, or { failedAt: ts } on failure, or Promise while in flight.
const _cityCache = new Map();
const _cityRetryBackoffMs = [5*60_000, 30*60_000, 6*3600_000];
function _cityFailureExpired(entry) {
  if (!entry || typeof entry !== "object" || entry.failedAt == null) return false;
  const attempts = entry.attempts || 1;
  const backoff = _cityRetryBackoffMs[Math.min(attempts - 1, _cityRetryBackoffMs.length - 1)];
  return Date.now() - entry.failedAt > backoff;
}
async function geocodeCity(city) {
  if (!city) return null;
  const key = city.trim().toLowerCase();
  if (!key) return null;
  if (_cityCache.has(key)) {
    const v = _cityCache.get(key);
    if (v && typeof v.then === "function") return await v;
    // Successful coords cached
    if (v && v.lat != null && v.lng != null) return v;
    // Failure: only retry once backoff elapsed
    if (v && v.failedAt != null && !_cityFailureExpired(v)) return null;
  }
  const prev = _cityCache.get(key);
  const prevAttempts = (prev && prev.attempts) || 0;
  const p = (async () => {
    try {
      const r = await withTimeout(
        forwardGeocodeCity({ data: { city } }),
        GEO_LOOKUP_TIMEOUT_MS,
        `City geocode timed out for ${city}`
      );
      if (r && r.lat != null && r.lng != null) return { lat: r.lat, lng: r.lng };
      return null;
    } catch {
      return null;
    }
  })();
  _cityCache.set(key, p);
  const result = await p;
  if (result && result.lat != null && result.lng != null) {
    _cityCache.set(key, result);
    return result;
  }
  _cityCache.set(key, { failedAt: Date.now(), attempts: prevAttempts + 1 });
  return null;
}
// Force-clear failure cache so a Re-geocode action can immediately retry.
function clearCityGeocodeFailures(keys) {
  if (!keys) {
    for (const [k, v] of _cityCache.entries()) {
      if (v && v.failedAt != null) _cityCache.delete(k);
    }
    return;
  }
  for (const k of keys) {
    const v = _cityCache.get(k);
    if (v && v.failedAt != null) _cityCache.delete(k);
  }
}



// Inject clean light theme (client-only) — inspired by cargo management UI
if (typeof document !== 'undefined') {
const _themeStyle = document.createElement('style');
_themeStyle.textContent = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  :root {
    /* ── Palette: Clean white + warm gray + vivid status pills ── */
    --bg:       #f2f4f7;
    --bg2:      #f2f4f7;
    --surface:  #ffffff;
    --surface2: #f2f4f7;
    --surface3: #f2f4f7;
    --border:   #e4e7ed;
    --border2:  #e4e7ed;
    --accent:   #111827;
    --accent2:  #374151;
    --accent3:  #6366f1;
    --red:      #dc2626;
    --red-bg:   rgba(220,38,38,0.08);
    --green:    #16a34a;
    --green-bg: rgba(22,163,74,0.08);
    --purple:   #6366f1;
    --amber:    #d97706;
    --sky:      #2563eb;
    --text:     #111827;
    --text2:    #374151;
    --text3:    #6b7280;
    --font-mono: 'Inter', system-ui, sans-serif;
    --font-body: 'Inter', system-ui, -apple-system, sans-serif;
    --font-head: 'Inter', system-ui, sans-serif;
    --font-num:  'Inter', system-ui, sans-serif;
  }
  body { background: var(--bg); color: var(--text); font-family: var(--font-body); }
  ::-webkit-scrollbar { width: 5px; height: 5px; }
  ::-webkit-scrollbar-track { background: #f2f4f7; }
  ::-webkit-scrollbar-thumb { background: #e4e7ed; border-radius: 6px; }
  ::-webkit-scrollbar-thumb:hover { background: #6b7280; }
  input, select, textarea {
    background: #ffffff !important;
    border: 1px solid #e4e7ed !important;
    color: #111827 !important;
    font-family: 'Inter', system-ui, sans-serif !important;
    border-radius: 8px !important;
    font-size: .875rem !important;
  }
  input:focus, select:focus, textarea:focus {
    border-color: #6366f1 !important;
    outline: none !important;
    box-shadow: 0 0 0 3px rgba(99,102,241,0.12) !important;
  }
  select option { background: #ffffff; color: #111827; }
  .tms-root ::selection { background: rgba(99,102,241,0.15); color: #111827; }
  .tms-root table { background: transparent; }
  .tms-root thead th {
    background: #f2f4f7 !important;
    color: #6b7280 !important;
    border-bottom: 1px solid #e4e7ed !important;
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-family: 'Inter', system-ui, sans-serif !important;
    font-size: .68rem !important;
    padding: 9px 12px !important;
    font-weight: 600 !important;
  }
  .tms-root tbody td {
    border-bottom: 1px solid #e4e7ed !important;
    padding: 9px 12px !important;
    color: #111827 !important;
    font-size: .875rem !important;
  }
  .tms-root tbody tr:hover td { background: #f2f4f7 !important; }
  .tms-root .chip-ok { color: #16a34a; }
  .tms-root .chip-warn { color: #d97706; }
  .tms-root .chip-bad { color: #dc2626; }
  .tbl-row-hover:hover td { background: #f2f4f7 !important; }

  /* ── Premium button styles ── */
  .tms-btn-primary {
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    background: #111827; color: #ffffff; border: none;
    padding: .46rem .95rem; border-radius: 12px;
    font-family: 'Inter', system-ui, sans-serif; font-size: .8rem; font-weight: 600;
    letter-spacing: .2px; cursor: pointer; white-space: nowrap;
    box-shadow: 0 1px 3px rgba(0,0,0,0.12), 0 1px 2px rgba(0,0,0,0.08);
    transition: background .15s, box-shadow .15s, transform .1s;
  }
  .tms-btn-primary:hover { background: #111827; box-shadow: 0 4px 12px rgba(0,0,0,0.15), 0 2px 4px rgba(0,0,0,0.1); transform: translateY(-1px); }
  .tms-btn-primary:active { transform: translateY(0); box-shadow: 0 1px 3px rgba(0,0,0,0.12); }
  .tms-btn-secondary {
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    background: #ffffff; color: #374151; border: 1px solid #e4e7ed;
    padding: .44rem .9rem; border-radius: 12px;
    font-family: 'Inter', system-ui, sans-serif; font-size: .8rem; font-weight: 600;
    cursor: pointer; white-space: nowrap;
    box-shadow: 0 1px 2px rgba(0,0,0,0.05);
    transition: background .12s, box-shadow .12s, transform .1s, border-color .12s;
  }
  .tms-btn-secondary:hover { background: #f2f4f7; border-color: #c8cdd8; box-shadow: 0 3px 8px rgba(0,0,0,0.08); transform: translateY(-1px); }
  .tms-btn-secondary:active { transform: translateY(0); }
  .tms-btn-danger {
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    background: #dc2626; color: #ffffff; border: none;
    padding: .44rem .9rem; border-radius: 12px;
    font-family: 'Inter', system-ui, sans-serif; font-size: .8rem; font-weight: 600;
    cursor: pointer; white-space: nowrap;
    box-shadow: 0 1px 3px rgba(220,38,38,0.2);
    transition: background .12s, box-shadow .12s, transform .1s;
  }
  .tms-btn-danger:hover { background: #dc2626; box-shadow: 0 4px 12px rgba(220,38,38,0.25); transform: translateY(-1px); }
  .tms-btn-danger:active { transform: translateY(0); }
  .tms-btn-success {
    display: inline-flex; align-items: center; justify-content: center; gap: 5px;
    background: #16a34a; color: #ffffff; border: none;
    padding: .44rem .9rem; border-radius: 12px;
    font-family: 'Inter', system-ui, sans-serif; font-size: .8rem; font-weight: 600;
    cursor: pointer; white-space: nowrap;
    box-shadow: 0 1px 3px rgba(22,163,74,0.2);
    transition: background .12s, box-shadow .12s, transform .1s;
  }
  .tms-btn-success:hover { background: #16a34a; box-shadow: 0 4px 12px rgba(22,163,74,0.25); transform: translateY(-1px); }
  .tms-btn-success:active { transform: translateY(0); }

  /* ── Load Board table (UI pass): rhythm, numerals, hover, ghost actions ── */
  .lb-tbl td { padding: 10px 12px; vertical-align: middle; }
  .lb-tbl { font-variant-numeric: tabular-nums; }
  .lb-tbl .lb-row { transition: background .1s; }
  .lb-tbl .lb-row:hover { background: #f9fafb; }
  /* Compact text-button family: identical height (24px), quiet neutral resting
     state, intent color revealed on hover only. The modern-SaaS button voice. */
  .lb-btn {
    display: inline-flex; align-items: center; justify-content: center; gap: 6px;
    height: 26px; padding: 0 10px; border-radius: 6px; border: 1px solid #e5e7eb;
    background: #ffffff; color: #6b7280; cursor: pointer;
    font-family: 'Inter', system-ui, sans-serif; font-size: .7rem; font-weight: 600;
    letter-spacing: 0; text-transform: none; white-space: nowrap; line-height: 1;
    box-shadow: 0 1px 0 rgba(15,23,42,0.02);
    transition: color .12s, border-color .12s, background .12s, box-shadow .12s;
  }
  .tms-root label.lb-btn {
    display: inline-flex; align-items: center; justify-content: center;
    height: 26px; margin: 0; padding: 0 10px;
    font-size: .7rem; font-weight: 600; color: #6b7280;
    letter-spacing: 0; line-height: 1; vertical-align: middle;
  }
  .tms-root label.lb-btn.lb-btn-ok { color: #16a34a; }
  .lb-btn > input[type="checkbox"] {
    appearance: none; -webkit-appearance: none;
    width: 13px; height: 13px; margin: 0; padding: 0;
    border: 1.5px solid #cbd5e1; border-radius: 3px;
    background: #ffffff; display: inline-block; flex: none;
    position: relative; cursor: pointer;
    transition: background .12s, border-color .12s;
  }
  .lb-btn > input[type="checkbox"]:hover { border-color: #94a3b8; }
  .lb-btn > input[type="checkbox"]:checked {
    background: #16a34a; border-color: #16a34a;
  }
  .lb-btn > input[type="checkbox"]:checked::after {
    content: ""; position: absolute; left: 3px; top: 0px;
    width: 4px; height: 8px; border: solid #ffffff;
    border-width: 0 1.5px 1.5px 0; transform: rotate(45deg);
  }
  .lb-check {
    width: 13px; height: 13px; border-radius: 3px;
    border: 1.5px solid #cbd5e1; background: #ffffff;
    display: inline-flex; align-items: center; justify-content: center;
    flex: none; position: relative;
  }
  .lb-check-on { background: #16a34a; border-color: #16a34a; }
  .lb-check-on::after {
    content: ""; width: 4px; height: 8px; border: solid #ffffff;
    border-width: 0 1.5px 1.5px 0; transform: rotate(45deg) translate(-.5px,-.5px);
  }
  .lb-btn:hover { color: #374151; border-color: #d1d5db; background: #f9fafb; box-shadow: 0 1px 2px rgba(15,23,42,0.06); }
  .lb-btn-ok { color: #16a34a; border-color: #d1fae5; background: #f0fdf4; }
  .lb-btn-ok:hover { color: #15803d; border-color: #a7f3d0; background: #ecfdf5; }
  .lb-btn-warn { color: #b45309; border-color: #fde68a; background: #fffbeb; }
  .lb-btn-warn:hover { color: #b45309; border-color: #fde68a; background: #fffbeb; }

  .lb-act {
    background: transparent; border: 1px solid transparent; color: #9ca3af;
    height: 26px; width: 26px; padding: 0; border-radius: 6px; cursor: pointer;
    display: inline-flex; align-items: center; justify-content: center;
    opacity: .75; transition: color .12s, background .12s, opacity .12s, border-color .12s;
  }
  .lb-row:hover .lb-act { opacity: 1; color: #6b7280; }
  .lb-act:hover { color: #374151; background: #f3f4f6; }
  .lb-act-danger:hover { color: #dc2626; background: #fef2f2; }
  /* Intent-tinted icon buttons that match .lb-act sizing exactly */
  .lb-act-flame { color: #dc2626; border-color: #fecaca; opacity: 1; }
  .lb-act-flame:hover { color: #b91c1c; background: #fef2f2; border-color: #fca5a5; }
  .lb-act-flame-on { color: #ffffff; background: #dc2626; border-color: #dc2626; opacity: 1; }
  .lb-act-flame-on:hover { color: #ffffff; background: #b91c1c; border-color: #b91c1c; }
  .lb-act-warn { color: #d97706; border-color: #fed7aa; opacity: 1; }
  .lb-act-warn:hover { color: #b45309; background: #fff7ed; border-color: #fdba74; }
  /* Delay pill matches lb-btn height for a clean row */
  .lb-btn-delay {
    display: inline-flex; align-items: center; gap: 4px; height: 26px;
    padding: 0 8px; border-radius: 6px; border: 1px solid #fed7aa;
    background: #fff7ed; color: #b45309; cursor: pointer;
    font-family: 'Inter', system-ui, sans-serif; font-size: .68rem; font-weight: 600;
    letter-spacing: 0; white-space: nowrap; line-height: 1;
    transition: color .12s, background .12s, border-color .12s;
  }
  .lb-btn-delay:hover { color: #9a3412; background: #ffedd5; border-color: #fdba74; }

  /* ── Load card view ── */
  .lb-card-grid { display: flex; flex-direction: column; gap: 12px; }
  .lb-card {
    background: #ffffff; border: 1px solid #e4e7ed; border-left: 4px solid #e4e7ed;
    border-radius: 10px; padding: 0; overflow: hidden;
    box-shadow: 0 1px 2px rgba(15,23,42,0.04);
    display: flex; flex-direction: column;
  }
  .lb-card-header { padding: .6rem 1rem; border-bottom: 1px solid #e4e7ed; display: flex; align-items: center; justify-content: space-between; gap: 10px; background: #f2f4f7; flex-wrap: wrap; }
  .lb-card-body { padding: .85rem 1.1rem; display: grid; grid-template-columns: 1fr auto 1fr; gap: 1.2rem; align-items: center; }
  @media (max-width: 900px) { .lb-card-body { grid-template-columns: 1fr; gap: .8rem; align-items: start; } }
  .lb-card-col { display: flex; flex-direction: column; gap: .55rem; min-width: 0; }
  .lb-card-col + .lb-card-col { padding-left: 1.2rem; border-left: 1px solid #e4e7ed; }
  @media (max-width: 900px) { .lb-card-col + .lb-card-col { padding-left: 0; border-left: none; padding-top: .7rem; border-top: 1px solid #e4e7ed; } }
  .lb-card-footer { padding: .55rem 1rem; border-top: 1px solid #e4e7ed; display: flex; flex-wrap: wrap; gap: 6px; background: #f2f4f7; align-items: center; }
  .lb-card-field { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
  .lb-card-label { font-size: .58rem; font-weight: 700; letter-spacing: .9px; text-transform: uppercase; color: #6b7280; }
  .lb-card-value { font-size: .82rem; font-weight: 500; color: #111827; line-height: 1.35; }
  .lb-card-row { display: grid; grid-template-columns: 1fr 1fr; gap: .55rem; }
  .lb-chip { display: inline-flex; align-items: center; gap: 4px; padding: 2px 7px; border-radius: 6px; font-size: .62rem; font-weight: 700; letter-spacing: .3px; }

  /* view toggle */
  .lb-view-toggle { display: inline-flex; background: #f2f4f7; border-radius: 10px; padding: 3px; gap: 2px; }
  .lb-view-btn { padding: 4px 10px; border-radius: 8px; border: none; cursor: pointer; font-size: .72rem; font-weight: 600; font-family: 'Inter',system-ui,sans-serif; transition: all .12s; background: transparent; color: #6b7280; }
  .lb-view-btn.active { background: #ffffff; color: #111827; box-shadow: 0 1px 3px rgba(0,0,0,0.1); }

  @keyframes bk { 0%,100%{opacity:1} 50%{opacity:.4} }
  @keyframes scanline {
    0% { transform: translateY(-100%); }
    100% { transform: translateY(100vh); }
  }
`;
document.head.appendChild(_themeStyle);

// Inject Inter font
const _style = document.createElement('style');
_style.textContent = `@import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700&display=swap');`;
document.head.appendChild(_style);
}

const VS_LABELS = { AVAILABLE:"Available", SENT_FOR_LOADING:"Sent For Loading", AT_LOADING:"At Loading", IN_TRANSIT:"On Trip", AT_UNLOADING:"At Unloading", DELIVERED:"Delivered", MAINTENANCE:"Maintenance" };
const VS_COLORS = {
  IN_TRANSIT:       { bg:"var(--status-info-bg)",    fg:"var(--status-info-fg)" },
  AVAILABLE:        { bg:"var(--status-neutral-bg)", fg:"var(--status-neutral-fg)" },
  AT_LOADING:       { bg:"var(--status-warn-bg)",    fg:"var(--status-warn-fg)" },
  SENT_FOR_LOADING: { bg:"var(--status-active-bg)",  fg:"var(--status-active-fg)" },
  AT_UNLOADING:     { bg:"var(--status-active-bg)",  fg:"var(--status-active-fg)" },
  MAINTENANCE:      { bg:"var(--status-danger-bg)",  fg:"var(--status-danger-fg)" },
  DELIVERED:        { bg:"var(--status-neutral-bg)", fg:"var(--status-neutral-fg)" },
  EMPTY:            { bg:"var(--status-ok-bg)",      fg:"var(--status-ok-fg)" },
  _default:         { bg:"var(--status-neutral-bg)", fg:"var(--status-neutral-fg)" },
};
const VS_ICONS = {
  AVAILABLE: CheckCircle2,
  SENT_FOR_LOADING: PackageOpen,
  AT_LOADING: Package,
  IN_TRANSIT: TruckIcon,
  AT_UNLOADING: PackageCheck,
  DELIVERED: CheckCircle2,
  MAINTENANCE: Wrench,
};
function VStatusPill({ status, withDropdown=false, onChange, title, size="sm" }) {
  const c = VS_COLORS[status] || VS_COLORS._default;
  const blink = status === "IN_TRANSIT" || status === "AT_LOADING";
  const isLg = size === "lg";
  const dot = isLg ? 9 : 5;
  const Icon = VS_ICONS[status];
  return (
    <span title={title || (withDropdown ? "Click to change status" : undefined)} style={{
      position:"relative", display:"inline-flex", alignItems:"center", gap: isLg?8:6,
      padding: isLg ? "6px 14px" : "3px 9px",
      borderRadius: isLg ? 9999 : 6,
      fontSize: isLg ? ".88rem" : ".68rem",
      fontFamily:"'Inter',system-ui,sans-serif", fontWeight:600, letterSpacing:0,
      textTransform:"none", cursor: withDropdown ? "pointer" : "default",
      // UI pass: table-size chips are QUIET dot+label — saturated dot carries the
      // status color, text stays neutral, no loud background. A fixed min-width
      // makes every status occupy identical space (column alignment). Large
      // pills (detail views) keep the bold identity.
      background: isLg ? c.bg : "#f9fafb",
      border: isLg ? "none" : "1px solid #e5e7eb",
      color: isLg ? c.fg : "#374151",
      minWidth: isLg ? undefined : 112,
      justifyContent: isLg ? undefined : "flex-start",
      lineHeight:1,
      transition: "background-color .15s ease, transform .15s ease",
    }}>
      {isLg && Icon ? (
        <Icon size={14} strokeWidth={2.4} style={{flexShrink:0, animation: blink ? "vpulse 1.8s ease-in-out infinite" : "none"}}/>
      ) : (
        <span style={{width:dot,height:dot,borderRadius:"50%",background:c.fg,opacity:.9,flexShrink:0,animation:blink?"vpulse 1.8s ease-in-out infinite":"none"}}/>
      )}
      {VS_LABELS[status] || status || "—"}
      {withDropdown && <span style={{marginLeft:2,opacity:.7,fontSize: isLg ? ".75rem" : ".6rem"}}>▾</span>}
      {withDropdown && (
        <select onChange={e=>{ if(e.target.value && onChange) onChange(e.target.value); }} value="" aria-label="Change status" style={{position:"absolute",inset:0,opacity:0,cursor:"pointer",border:"none",appearance:"none"}}>
          <option value="" disabled>Change…</option>
          {Object.entries(VS_LABELS).map(([k,lbl])=><option key={k} value={k}>{lbl}</option>)}
        </select>
      )}
    </span>
  );
}
const LS_LABELS = { PENDING:"Pending", QUEUED:"Queued", ASSIGNED:"Assigned", IN_TRANSIT:"In Transit", AT_UNLOADING:"At Unloading", DELIVERED:"Delivered", CANCELLED:"Cancelled", LATE:"Delayed" };
const V_TYPES = ["32 FT SINGLE AXLE","32 FT MULTI AXLE","20/22/24 FEET","EV","14 FT"];
const PRIORITIES = ["LOW","MEDIUM","HIGH","URGENT"];
const DEFAULT_BRANCHES = ["Gurgaon","Mumbai","Bangalore","Chennai","Hyderabad","Pune","Kolkata","Ahmedabad","Surat","Jaipur","Dahej","Lucknow"];
const BRANCHES = ["All Branches","Gurgaon","Mumbai","Bangalore","Chennai","Hyderabad","Pune","Kolkata","Ahmedabad","Surat","Jaipur","Dahej","Lucknow"];
const CUSTOMERS = ["Reliance Industries","Tata Steel","Infosys Logistics","FMCG Corp","Bharat Chemicals","ColdChain Ltd","Metro Retail","Steel Plus","PharmaCo","GreenFoods","MRF","Ceat"];

import INDIAN_CITIES_DATA from "../data/indiaCities.json";
const ALL_CITIES = INDIAN_CITIES_DATA;

function Combobox({ value, onChange, options, fetchOptions, placeholder, style }) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [remote, setRemote] = useState([]);
  const [loading, setLoading] = useState(false);
  // tracks the last query for which we received a confirmed empty result
  const [emptyForQuery, setEmptyForQuery] = useState("");
  const ref = useRef(null);
  const reqIdRef = useRef(0);
  useEffect(() => {
    const onDoc = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, []);
  const q = (open ? query : value || "").toLowerCase().trim();
  useEffect(() => {
    if (!fetchOptions || !open) return;
    const term = query.trim();
    if (term.length < 3) { setRemote([]); setLoading(false); setEmptyForQuery(""); return; }

    setLoading(true);
    const myId = ++reqIdRef.current;
    // safety: never sit on "Searching…" forever
    const guard = setTimeout(() => { if (myId === reqIdRef.current) setLoading(false); }, 12000);
    const t = setTimeout(async () => {
      try {
        const r = await fetchOptions(term);
        if (myId !== reqIdRef.current) return;
        const arr = Array.isArray(r) ? r : [];
        if (arr.length) {
          setRemote(arr);
          setEmptyForQuery("");
        } else {
          // confirmed empty for this exact term — keep previous remote visible
          setEmptyForQuery(term.toLowerCase());
        }
      } catch {
        // transient error: keep previous remote, do NOT show "No matches"
      } finally {
        if (myId === reqIdRef.current) setLoading(false);
      }
    }, 250);
    return () => { clearTimeout(t); clearTimeout(guard); };
  }, [query, open, fetchOptions]);

  // fetchOptions may return either strings or { label, coords } objects.
  // Normalize to { label, coords } so we can pass coords through onChange.
  const normRemote = remote.map(o => typeof o === "string" ? { label: o, coords: null } : o);
  const filtered = fetchOptions
    ? normRemote.slice(0, 50)
    : (q ? (options || []).filter(o => o.toLowerCase().includes(q)).map(o => ({ label: o, coords: null })).slice(0, 50)
         : (options || []).map(o => ({ label: o, coords: null })).slice(0, 50));
  return (
    <div ref={ref} style={{ position: "relative", ...style }}>
      <input
        value={open ? query : (value || "")}
        onFocus={() => { setQuery(value || ""); setOpen(true); }}
        onChange={(e) => { setQuery(e.target.value); setOpen(true); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && filtered.length > 0) { onChange(filtered[0].label, filtered[0].coords); setOpen(false); e.preventDefault(); }
          if (e.key === "Escape") setOpen(false);
        }}
        placeholder={placeholder || "Type to search…"}
        style={{ width: "100%", background: "#f2f4f7", border: "1px solid var(--border)", color: "#111827", padding: ".46rem .65rem", borderRadius:6, fontFamily: "'Inter',system-ui,sans-serif", fontSize:".84rem", outline: "none" }}
      />
      {open && (filtered.length > 0 || loading) && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background:"#ffffff", border: "1px solid var(--border)", borderRadius:6, marginTop: 2, maxHeight: 240, overflowY: "auto", boxShadow: "0 6px 18px rgba(0,0,0,.08)" }}>
          {loading && filtered.length === 0 && (
            <div style={{ padding: "8px 10px", fontSize:".78rem", color:"#6b7280" }}>Searching…</div>
          )}
          {filtered.map((o) => (
            <div key={o.label}
              onMouseDown={(e) => { e.preventDefault(); onChange(o.label, o.coords); setOpen(false); }}
              style={{ padding: "6px 10px", fontSize:".84rem", cursor: "pointer", borderBottom:"1px solid #e4e7ed" }}
              onMouseEnter={(e) => (e.currentTarget.style.background = "rgba(217,119,6,0.08)")}
              onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
            >{o.label}</div>
          ))}
        </div>
      )}

      {open && !loading && filtered.length === 0 && (
        (!fetchOptions && (query.trim() || true)) ||
        (fetchOptions && query.trim() && emptyForQuery === query.trim().toLowerCase())
      ) && (
        <div style={{ position: "absolute", top: "100%", left: 0, right: 0, zIndex: 50, background:"#ffffff", border: "1px solid var(--border)", borderRadius:6, marginTop: 2, padding: "8px 10px", fontSize:".78rem", color:"#6b7280" }}>No matches</div>
      )}

    </div>
  );
}

function todayLocal() {
  const d = new Date();
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 10);
}
function nextLoadId(loads) {
  const nums = (loads || []).map(l => { const m = /LD-(\d+)/i.exec(l.lid || ""); return m ? parseInt(m[1], 10) : 0; });
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `LD-${String(next).padStart(3, "0")}`;
}

const vsBadge = (s) => {
  const map = {
    IN_TRANSIT:"bg-blue-100 text-blue-800", AVAILABLE:"bg-green-100 text-green-800",
    AT_LOADING:"bg-amber-100 text-amber-800", MAINTENANCE:"bg-red-100 text-red-800",
    IDLE:"bg-gray-100 text-gray-600", DELIVERED:"bg-emerald-100 text-emerald-800"
  };
  return map[s] || "bg-gray-100 text-gray-600";
};
const lsBadge = (s) => {
  const map = {
    PENDING:"bg-gray-100 text-gray-600", ASSIGNED:"bg-blue-100 text-blue-800",
    IN_TRANSIT:"bg-violet-100 text-violet-800", DELIVERED:"bg-emerald-100 text-emerald-800",
    CANCELLED:"bg-red-100 text-red-800"
  };
  return map[s] || "bg-gray-100 text-gray-600";
};
const priColor = (p) => p==="HIGH" ? "text-red-600 font-bold" : p==="MEDIUM" ? "text-amber-600 font-semibold" : "text-gray-500";

function fmtDT(str) {
  if (!str) return "—";
  const s = String(str);
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(s);
  const d = new Date(s);
  if (isNaN(d.getTime())) return "—";
  const pad = (n) => String(n).padStart(2,"0");
  const datePart = `${pad(d.getDate())}-${pad(d.getMonth()+1)}-${String(d.getFullYear()).slice(2)}`;
  if (dateOnly) return datePart;
  return datePart + " " + d.toLocaleTimeString("en-IN",{hour:"numeric",minute:"2-digit",hour12:true});
}

function DateField({ value, onChange }) {
  return <PrettyDate value={value} onChange={onChange} placeholder="dd-mm-yy" style={{background:"#f2f4f7",padding:".46rem .65rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem"}} />;
}

function DateTimeField({ value, onChange, accentBorder, accentColor }) {
  return <PrettyDateTime value={value} onChange={onChange} style={{background:"#f2f4f7",border:`1px solid ${accentBorder||"#e4e7ed"}`,color:value?(accentColor||"#111827"):"#6b7280",padding:".46rem .65rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem"}} />;

}


function StarDisplay({ rating, size=14 }) {
  return (
    <span style={{display:"inline-flex",gap:1,alignItems:"center"}}>
      {[1,2,3,4,5].map(i=>(
        <span key={i} style={{fontSize:size,color:i<=(rating||0)?"#d97706":"#e4e7ed",lineHeight:1}}>★</span>
      ))}
    </span>
  );
}

function StarPicker({ value, onChange }) {
  const [hovered, setHovered] = useState(0);
  return (
    <span style={{display:"inline-flex",gap:2,alignItems:"center",cursor:"pointer"}}>
      {[1,2,3,4,5].map(i=>(
        <span key={i}
          onMouseEnter={()=>setHovered(i)}
          onMouseLeave={()=>setHovered(0)}
          onClick={()=>onChange(i===value?0:i)}
          style={{fontSize:22,color:i<=(hovered||value)?"#d97706":"#e4e7ed",lineHeight:1,transition:"color .1s",userSelect:"none"}}>★</span>
      ))}
      {value>0 && <span style={{fontSize:".72rem",color:"#111827",marginLeft:4}}>{value}/5</span>}
    </span>
  );
}

const DEMO_V = [
  { id:"v1", customer:"MRF", vnum:"HR55AP9699", vtype:"32 FT SINGLE AXLE", vstatus:"IN_TRANSIT", driver:"Ramesh Kumar",  mobile:"+91 98765 43210", loadId:"l3", branch:"Lucknow", destination:"Lucknow" },
  { id:"v2", customer:"Tata Steel", vnum:"MH12BZ3391", vtype:"32 FT MULTI AXLE",  vstatus:"AVAILABLE",  driver:"Suresh Singh",  mobile:"+91 87654 32109", loadId:null },
  { id:"v3", customer:"Bharat Chemicals", vnum:"TS09FG7823", vtype:"20/22/24 FEET", vstatus:"AT_LOADING", driver:"Anil Verma",    mobile:"+91 76543 21098", loadId:null },
  { id:"v4", customer:"ColdChain Ltd", vnum:"KA03MN5514", vtype:"EV", vstatus:"AVAILABLE",  driver:"Manoj Sharma",  mobile:"+91 65432 10987", loadId:null },
  { id:"v5", customer:"", vnum:"RJ14GH2267", vtype:"14 FT", vstatus:"MAINTENANCE",driver:"Vijay Yadav",   mobile:"+91 54321 09876", loadId:null },
  { id:"v6", customer:"Reliance Industries", vnum:"GJ05DT8849", vtype:"32 FT SINGLE AXLE", vstatus:"AVAILABLE",  driver:"Pradeep Nair",  mobile:"+91 43210 98765", loadId:null },
];
const DEMO_L = [
  { id:"l1", lid:"LD-001", commodity:"Electronics",  weight:"8",  volume:"22", origin:"Mumbai",    dest:"Gurgaon",     pickup:"2026-03-25T08:00", delivery:"2026-03-26T18:00", priority:"HIGH",   vtypeReq:"Container",   notes:"Handle with care", lstatus:"PENDING",   vehicleId:null, branch:"Hyderabad", customer:"Ceat" },
  { id:"l2", lid:"LD-002", commodity:"Steel Coils",  weight:"22", volume:"",   origin:"Pune",      dest:"Ahmedabad", pickup:"2026-03-24T14:00", delivery:"2026-03-25T10:00", priority:"MEDIUM", vtypeReq:"Flatbed",     notes:"",                 lstatus:"PENDING",   vehicleId:null, branch:"Hyderabad", customer:"MRF" },
  { id:"l3", lid:"LD-003", commodity:"FMCG Goods",   weight:"5",  volume:"30", origin:"Gurgaon",     dest:"Lucknow",   pickup:"2026-03-24T09:00", delivery:"2026-03-24T20:00", priority:"MEDIUM", vtypeReq:"Heavy Truck", notes:"Room temp",        lstatus:"IN_TRANSIT",vehicleId:"v1", branch:"Gurgaon", customer:"Ceat" },
  { id:"l4", lid:"LD-004", commodity:"Chemicals",    weight:"15", volume:"",   origin:"Chennai",   dest:"Bangalore", pickup:"2026-03-26T07:00", delivery:"2026-03-27T12:00", priority:"HIGH",   vtypeReq:"Tanker",      notes:"Hazmat class B",   lstatus:"PENDING",   vehicleId:null, branch:"Hyderabad", customer:"MRF" },
  { id:"l5", lid:"LD-005", commodity:"Frozen Goods", weight:"6",  volume:"18", origin:"Hyderabad", dest:"Mumbai",    pickup:"2026-03-25T10:00", delivery:"2026-03-26T08:00", priority:"HIGH",   vtypeReq:"Refrigerated",notes:"-18°C required",   lstatus:"PENDING",   vehicleId:null, branch:"Hyderabad", customer:"Ceat" },
];

let _vid = 10, _lid = 10;
const _rand = () => {
  try { if (typeof crypto !== "undefined" && crypto.randomUUID) return crypto.randomUUID().replace(/-/g, ""); } catch {}
  return Math.random().toString(36).slice(2) + Date.now().toString(36);
};
const uid = (p) => `${p}${Date.now().toString(36)}${_rand().slice(0,8)}_${++_vid}`;
const ulid = () => `l_${Date.now().toString(36)}${_rand().slice(0,10)}_${++_lid}`;
// Stable per-consignee id (sidecar identity, Stage 1). Prefix `c_` distinguishes it from the
// reserved destination sentinel `__dest__`, which is never generated here.
const newConsigneeCid = () => { try { return `c_${Date.now().toString(36)}${_rand().slice(0,8)}`; } catch { return `c_${Math.random().toString(36).slice(2,12)}`; } };

// ─── Blank forms ───
const blankV = () => ({ id:"", vnum:"", vtype:"32 FT SINGLE AXLE", driver:"", mobile:"", customer:"" });
const blankL = () => ({ id:"", lid:"", commodity:"", weight:"", volume:"", origin:"", dest:"", originCoords:null, destCoords:null, pickup:todayLocal(), delivery:"", priority:"MEDIUM", vtypeReq:"", notes:"", branch:"", customer:"" });

// ─── TAT Reason expandable panel ───
function TatReasonPanel({ loadId, state, types, etaPassed, onMoving, onEta, onAdd, showComments, comments, onAddComment, onRemoveComment, onEditComment }) {
  const [pick, setPick] = useState("");
  const [hours, setHours] = useState("");
  const [commentDraft, setCommentDraft] = useState("");
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState("");
  const picked = types.find(t => t.id === pick);
  return (
    <div style={{marginTop:".8rem",background:"#f2f4f7",border:"1px dashed var(--border2)",borderRadius:8,padding:".85rem 1rem"}}>
      {/* Step 1: Is the vehicle moving? */}
      <div style={{marginBottom:".7rem"}}>
        <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>Is the vehicle moving?</div>
        <div style={{display:"flex",gap:".5rem"}}>
          {[[true," Yes","rgba(22,163,74,0.08)","#16a34a","#16a34a"],[false,"⛔ No","rgba(220,38,38,0.08)","#dc2626","#dc2626"]].map(([val,label,bg,bd,col])=>(
            <button key={String(val)} onClick={()=>onMoving(val)} style={{padding:"5px 14px",borderRadius:6,border:"2px solid",borderColor:state.moving===val?bd:"#e4e7ed",background:state.moving===val?bg:"#ffffff",color:state.moving===val?col:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,cursor:"pointer"}}>{label}</button>
          ))}
        </div>
      </div>
      {/* Step 1b: Expected ETA on road */}
      {state.moving === false && (
        <div style={{marginBottom:".7rem",background:"rgba(217,119,6,0.08)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:8,padding:".625rem .75rem"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#d97706",marginBottom:5}}>
            Expected ETA to be on road *
          </div>
          <PrettyDateTime value={state.expectedEta} onChange={onEta}
            style={{background:"#ffffff",border:"1px solid #d97706",color:"#d97706",padding:".42rem .6rem",fontSize:".84rem"}}/>
        </div>
      )}
      {/* Step 2: Add a reason */}
      <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>Add Reason</div>
      <div style={{display:"flex",flexWrap:"wrap",gap:6,marginBottom:".55rem"}}>
        {types.map(t => (
          <button key={t.id} onClick={()=>{ setPick(t.id); setHours(""); }}
            style={{display:"inline-flex",alignItems:"center",gap:5,padding:"5px 10px",borderRadius:12,border:"2px solid",borderColor:pick===t.id?"#6366f1":"#e4e7ed",background:pick===t.id?"rgba(99,102,241,0.08)":"#ffffff",color:pick===t.id?"#6366f1":"#374151",fontSize:".72rem",fontWeight:600,cursor:"pointer"}}>
            <span>{t.icon}</span>{t.label}
          </button>
        ))}
      </div>
      {picked && (
        <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
          {picked.askHours && (
            <label style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:".78rem",color:"#6b7280",fontWeight:600}}>
              Hours?
              <input type="number" min="0" step="0.5" value={hours} onChange={e=>setHours(e.target.value)} placeholder="e.g. 2.5"
                style={{width:90,background:"#ffffff",border:"1px solid var(--border2)",color:"#111827",padding:".35rem .55rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none"}}/>
            </label>
          )}
          <button onClick={()=>{ onAdd(pick, hours); setPick(""); setHours(""); }}
            style={{background:"#111827",color:"#ffffff",border:"none",padding:"6px 14px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>+ Add</button>
          <button onClick={()=>{ setPick(""); setHours(""); }}
            style={{background:"transparent",color:"#6b7280",border:"1px solid var(--border2)",padding:"6px 12px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>Clear</button>
        </div>
      )}
      {/* Step 3: Comments (delayed loads only) */}
      {showComments && (
        <div style={{marginTop:".85rem",paddingTop:".75rem",borderTop:"1px dashed var(--border2)"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>💬 Comments</div>
          <div style={{display:"flex",gap:6,alignItems:"flex-start",marginBottom:".55rem"}}>
            <textarea value={commentDraft} onChange={e=>setCommentDraft(e.target.value)} placeholder="Add a comment about this delay…" rows={2}
              style={{flex:1,background:"#ffffff",border:"1px solid var(--border2)",color:"#111827",padding:".4rem .55rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",resize:"vertical",minHeight:42}}/>
            <button onClick={()=>{ const t=commentDraft.trim(); if(!t) return; onAddComment(t); setCommentDraft(""); }}
              style={{background:"#111827",color:"#ffffff",border:"none",padding:"6px 14px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer",whiteSpace:"nowrap"}}>+ Add</button>
          </div>
          {(comments && comments.length > 0) ? (
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              {[...comments].reverse().map(c => {
                const isEditing = editingId === c.id;
                return (
                <div key={c.id} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,background:"#ffffff",border:"1px solid var(--border)",borderRadius:6,padding:".4rem .6rem"}}>
                  <div style={{flex:1,minWidth:0}}>
                    {isEditing ? (
                      <div style={{display:"flex",flexDirection:"column",gap:5}}>
                        <textarea value={editDraft} onChange={e=>setEditDraft(e.target.value)} rows={2}
                          style={{width:"100%",background:"#ffffff",border:"1px solid var(--border2)",color:"#111827",padding:".35rem .5rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",resize:"vertical",minHeight:42,boxSizing:"border-box"}}/>
                        <div style={{display:"flex",gap:6}}>
                          <button onClick={()=>{ const t=editDraft.trim(); if(!t) return; onEditComment && onEditComment(c.id, t); setEditingId(null); setEditDraft(""); }}
                            style={{background:"#111827",color:"#ffffff",border:"none",padding:"4px 12px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>Save</button>
                          <button onClick={()=>{ setEditingId(null); setEditDraft(""); }}
                            style={{background:"transparent",color:"#6b7280",border:"1px solid var(--border2)",padding:"4px 12px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>Cancel</button>
                        </div>
                      </div>
                    ) : (
                      <>
                        <div style={{fontSize:".84rem",color:"#111827",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{c.text}</div>
                        <div style={{fontSize:".68rem",color:"#6b7280",marginTop:2,fontFamily:"'Inter',system-ui,sans-serif"}}>{c.addedAt}{c.editedAt?` · edited ${c.editedAt}`:""}</div>
                      </>
                    )}
                  </div>
                  {!isEditing && (
                    <div style={{display:"flex",gap:4,alignItems:"center"}}>
                      {onEditComment && (
                        <button onClick={()=>{ setEditingId(c.id); setEditDraft(c.text); }} aria-label="Edit" title="Edit comment" style={{background:"transparent",border:"none",color:"#374151",fontSize:".84rem",cursor:"pointer",padding:0,lineHeight:1}}>✎</button>
                      )}
                      <button onClick={()=>onRemoveComment(c.id)} aria-label="Remove" style={{background:"transparent",border:"none",color:"#dc2626",fontSize:".9rem",cursor:"pointer",padding:0,lineHeight:1}}>✕</button>
                    </div>
                  )}
                </div>
                );
              })}
            </div>
          ) : (
            <div style={{fontSize:".72rem",color:"#6b7280",fontStyle:"italic"}}>No comments yet.</div>
          )}
        </div>
      )}
    </div>
  );
}
function EditableCommentRow({ c, onEdit, onRemove, compact }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(c.text);
  const textSize = compact ? ".8rem" : ".82rem";
  const tsSize = compact ? ".64rem" : ".66rem";
  return (
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,background:"#ffffff",border:"1px solid var(--border)",borderRadius:6,padding:compact?".35rem .55rem":".4rem .6rem"}}>
      <div style={{flex:1,minWidth:0}}>
        {editing ? (
          <div style={{display:"flex",flexDirection:"column",gap:5}}>
            <textarea value={draft} onChange={e=>setDraft(e.target.value)} rows={2}
              style={{width:"100%",background:"#ffffff",border:"1px solid var(--border2)",color:"#111827",padding:".35rem .5rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",resize:"vertical",minHeight:42,boxSizing:"border-box"}}/>
            <div style={{display:"flex",gap:6}}>
              <button onClick={()=>{ const t=draft.trim(); if(!t) return; onEdit(c.id, t); setEditing(false); }}
                style={{background:"#111827",color:"#ffffff",border:"none",padding:"4px 12px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>Save</button>
              <button onClick={()=>{ setEditing(false); setDraft(c.text); }}
                style={{background:"transparent",color:"#6b7280",border:"1px solid var(--border2)",padding:"4px 12px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        ) : (
          <>
            <div style={{fontSize:textSize,color:"#111827",whiteSpace:"pre-wrap",wordBreak:"break-word"}}>{compact?"💬 ":""}{c.text}</div>
            <div style={{fontSize:tsSize,color:"#6b7280",marginTop:2,fontFamily:"'Inter',system-ui,sans-serif"}}>{c.addedAt}{c.editedAt?` · edited ${c.editedAt}`:""}</div>
          </>
        )}
      </div>
      {!editing && (
        <div style={{display:"flex",gap:4,alignItems:"center"}}>
          <button onClick={()=>{ setDraft(c.text); setEditing(true); }} aria-label="Edit" title="Edit comment" style={{background:"transparent",border:"none",color:"#374151",fontSize:".84rem",cursor:"pointer",padding:0,lineHeight:1}}>✎</button>
          <button onClick={()=>onRemove(c.id)} aria-label="Remove" style={{background:"transparent",border:"none",color:compact?"#dc2626":"#dc2626",fontSize:".9rem",cursor:"pointer",padding:0,lineHeight:1}}>✕</button>
        </div>
      )}
    </div>
  );
}


// Hover-expanding GPS mini-map for Load Board cards.
// Default: static OSM image thumbnail (cheap, lazy-loaded).
// Hover: swaps to a live interactive iframe at street-level zoom.
function LoadCardMiniMap({ lat, lng, vnum, addressLine, onClick }) {
  const wrapRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState(null);
  const closeTimer = useRef(null);

  const cancelClose = () => {
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 140);
  };
  const handleEnter = () => {
    cancelClose();
    if (wrapRef.current) setRect(wrapRef.current.getBoundingClientRect());
    setOpen(true);
  };
  useEffect(() => () => cancelClose(), []);

  if (lat == null || lng == null) return null;
  const la = Number(lat), ln = Number(lng);
  if (!isFinite(la) || !isFinite(ln)) return null;

  // City label for placeholder
  const cityLabel = (addressLine || "").split(",")[0].trim();

  // Position popover: prefer below-right, flip if off-viewport
  const POP_W = 360, POP_H = 240, GAP = 8;
  let popStyle = null;
  if (rect) {
    const vw = window.innerWidth, vh = window.innerHeight;
    let left = rect.left;
    let top = rect.bottom + GAP;
    if (left + POP_W > vw - 8) left = Math.max(8, vw - POP_W - 8);
    if (top + POP_H > vh - 8) top = Math.max(8, rect.top - POP_H - GAP);
    popStyle = { left, top, width: POP_W, height: POP_H };
  }

  // Street-level iframe — wider bbox ≈ zoom 10
  const d = 0.2;
  const bbox = `${ln-d}%2C${la-d}%2C${ln+d}%2C${la+d}`;
  const iframeUrl = `https://www.openstreetmap.org/export/embed.html?bbox=${bbox}&layer=mapnik&marker=${la}%2C${ln}`;

  return (
    <>
      <div
        ref={wrapRef}
        className="lb-card-minimap"
        onMouseEnter={handleEnter}
        onMouseLeave={scheduleClose}
        onClick={onClick}
        title={addressLine ? `${addressLine}` : "View on map"}
      >
        <div className="lb-card-minimap-grid" aria-hidden="true" />
        <div className="lb-card-minimap-inner">
          <div className="lb-card-minimap-pin"></div>
          <div className="lb-card-minimap-vnum">{vnum || "GPS"}</div>
          {cityLabel ? <div className="lb-card-minimap-city">{cityLabel}</div> : null}
        </div>
      </div>
      {open && popStyle && createPortal(
        <div
          className="lb-card-minimap-pop"
          style={popStyle}
          onMouseEnter={cancelClose}
          onMouseLeave={scheduleClose}
          onClick={onClick}
        >
          <iframe src={iframeUrl} title={`${vnum||""} GPS`} loading="lazy" />
          <span className="lb-card-minimap-label">{vnum || "GPS"}{cityLabel ? ` · ${cityLabel}` : ""}</span>
        </div>,
        document.body
      )}
    </>
  );
}


export default function App() {
  const [tab, setTab] = useState("loads");
  const [navGroup, setNavGroup] = useState("loads"); // active primary group
  // Once the Loads tab has mounted, keep its DOM alive across tab switches.
  // Tab switches then become a CSS toggle — no remount, no re-render of the
  // huge load table. Live state (vehicles, loads, gpsMap) still updates while
  // hidden because all sync effects live at App() scope, not inside the JSX.
  const loadsTabMountedRef = useRef(true); // default tab is "loads", so true at start
  const [overviewSel, setOverviewSel] = useState(null); // { branch, status }
  const [tatFilter, setTatFilter] = useState(() => new Set()); // empty = all
  const [tatPage, setTatPage] = useState(1);
  const [tatFilterVehicle, setTatFilterVehicle] = useState("");
  const [tatFilterOrigin, setTatFilterOrigin] = useState("");
  const [tatFilterCustomer, setTatFilterCustomer] = useState("");
  const [tatFilterLid, setTatFilterLid] = useState("");
  const [tatRpdc, setTatRpdc] = useState(false);
  const [tatReturnOnly, setTatReturnOnly] = useState(false);
  const [tatNoDriverOnly, setTatNoDriverOnly] = useState(false);
  const [tatConsigneeTab, setTatConsigneeTab] = useState("single"); // "single" | "multi"
  const [gpsIssuesSub, setGpsIssuesSub] = useState("nofetch"); // "nofetch" | "unresolved"
  const [gpsIssuesPage, setGpsIssuesPage] = useState(1);
  const [statusDelaySub, setStatusDelaySub] = useState("waiting"); // "waiting" | "sfl" | "atloading"
  const [nowTick, setNowTick] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const { userId, username } = useAuthSession();
  const [isAdmin, setIsAdmin] = useState(false);
  const navigate = useNavigate();
  useEffect(() => {
    if (!userId) { setIsAdmin(false); return; }
    let cancelled = false;
    getMe().then((me) => { if (!cancelled) setIsAdmin(!!me?.isAdmin); }).catch(() => {});
    return () => { cancelled = true; };
  }, [userId]);
  const handleSignOut = () => {
    // Clear the persisted session synchronously so the login page won't bounce
    // back to /app. Then navigate immediately — the actual signOut() call can
    // stall for several seconds inside Supabase's auth lock, so we let it run
    // in the background instead of blocking the UI on it.
    try { localStorage.removeItem("tms-auth"); } catch {}
    navigate({ to: "/login" });
    signOut().catch(() => {});
  };
  const [vehicles, setVehicles] = useState(() => getVehicles() || []);
  const [loads, setLoads] = useState(() => getLoads() || []);
  // Rows the user just changed locally — protected from being overwritten by a
  // concurrent cloud refresh until the change has uploaded and round-tripped.
  const pendingLoadIds = useRef(new Map());     // id -> expiry ms
  const pendingVehicleIds = useRef(new Map());
  const lastVehRaw = useRef(null);              // last applied localStorage string
  const lastLoadRaw = useRef(null);
  // Cheap reference compare — changed rows get a fresh object from setState(p => p.map(...)),
  // unchanged rows keep their reference, so no JSON.stringify needed.
  const markPending = (pendingRef, prevArr, nextArr) => {
    const prev = new Map((prevArr || []).map((r) => [String(r?.id), r]));
    for (const r of nextArr || []) {
      const id = String(r?.id);
      const p = prev.get(id);
      if (p !== r) pendingRef.current.set(id, Date.now() + 8000);
    }
  };
  const mergePending = (pendingRef, saved, prevState) => {
    const now = Date.now();
    for (const [id, exp] of pendingRef.current) if (exp < now) pendingRef.current.delete(id);
    if (!pendingRef.current.size) return saved || [];
    const prevById = new Map((prevState || []).map((r) => [String(r?.id), r]));
    const out = [];
    for (const r of saved || []) {
      const id = String(r?.id);
      if (pendingRef.current.has(id) && !prevById.has(id)) {
        // Local action was a delete (id is pending but no longer in prev state).
        // Skip the saved row so a stale cloud read can't undo the deletion.
        continue;
      }
      if (!pendingRef.current.has(id) || !prevById.has(id)) { out.push(r); continue; }
      const prev = prevById.get(id);
      // Both rows carry updatedAt: prefer the newer one; otherwise keep local prev.
      if (r?.updatedAt && prev?.updatedAt && r.updatedAt > prev.updatedAt) out.push(r);
      else out.push(prev);
    }
    for (const [id] of pendingRef.current) {
      if (!out.some((r) => String(r?.id) === id) && prevById.has(id)) out.push(prevById.get(id));
    }
    return out;
  };

  // Explicit push helpers — user actions ALWAYS call these; cloud-applied refreshes
  // use plain setVehicles/setLoads so they never push back to the cloud.
  // React may re-invoke the updater on queue rebase; we push the last invocation's pair,
  // which is the one that commits.
  let hydrationWarnFired = false;
  const makePusher = (setter, diffFn, pendingRef) => (updater, opts) => {
    let p, n, scheduled = false;
    setter((prev) => {
      const next = typeof updater === "function" ? updater(prev) : updater;
      p = prev; n = next;
      // Mark pending SYNCHRONOUSLY inside the setter so any cloud refresh
      // that lands before the microtask fires still treats these ids as
      // pending in mergePending — otherwise realtime can clobber the write.
      markPending(pendingRef, p, n);
      // localOnly: update React state + mark pending for clobber-protection, but
      // skip the remote diff — the caller owns the server write (transition
      // engine writes vehicle+load atomically in one RPC instead of two diffs).
      if (opts?.localOnly) { return next; }
      if (!scheduled) {
        scheduled = true;
        queueMicrotask(() => {
          if (!isSyncHydrated()) {
            if (!hydrationWarnFired) { hydrationWarnFired = true; console.warn("[tms] edit before cloud hydrate — not pushed"); }
            return;
          }
          diffFn(p, n, opts);
        });
      }
      return next;
    });
  };
  const pushVehicles = makePusher(setVehicles, syncVehiclesDiff, pendingVehicleIds);
  const pushLoads = makePusher(setLoads, syncLoadsDiff, pendingLoadIds);

  const [syncStatus, setSyncStatus] = useState(() => getSyncStatus());
  const cleanCloudStatus = (message) => {
    const raw = String(message || "").replace(/\\u003c/gi,"<").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&amp;/gi,"&");
    if (/<!doctype html|<html|cf-error|error code\s*522|522:\s*connection timed out|connection timed out|cloudflare/i.test(raw)) {
      return "Cloud connection timed out. Local changes are queued.";
    }
    return raw.length > 140 ? `${raw.slice(0, 140)}…` : raw;
  };

  // Sync to localStorage so the Drivers app (/driver) can read live data.
  // Always remote:false — pushing is now explicit via pushVehicles/pushLoads.
  // Phase 2: debounce mirror writes by 250ms so GPS-tick storms don't
  // re-serialize the entire vehicles/loads array on every state change.
  // In-memory React state is unaffected; only the localStorage mirror is
  // delayed. We flush on tab hide/unload so nothing is lost.
  const vehMirrorTimer = useRef(null);
  const loadMirrorTimer = useRef(null);
  const vehMirrorPending = useRef(null);
  const loadMirrorPending = useRef(null);
  const flushVehMirror = () => {
    if (vehMirrorTimer.current) { clearTimeout(vehMirrorTimer.current); vehMirrorTimer.current = null; }
    if (vehMirrorPending.current) {
      syncVehicles(vehMirrorPending.current, { remote: false });
      try { lastVehRaw.current = localStorage.getItem("lov_tms_vehicles") || ""; } catch {}
      vehMirrorPending.current = null;
    }
  };
  const flushLoadMirror = () => {
    if (loadMirrorTimer.current) { clearTimeout(loadMirrorTimer.current); loadMirrorTimer.current = null; }
    if (loadMirrorPending.current) {
      syncLoads(loadMirrorPending.current, { remote: false });
      try { lastLoadRaw.current = localStorage.getItem("lov_tms_loads") || ""; } catch {}
      loadMirrorPending.current = null;
    }
  };
  useEffect(() => {
    vehMirrorPending.current = vehicles;
    if (vehMirrorTimer.current) clearTimeout(vehMirrorTimer.current);
    vehMirrorTimer.current = setTimeout(flushVehMirror, 250);
    return () => { /* keep timer; flushed on next change or on hide/unload */ };
  }, [vehicles]);
  useEffect(() => {
    loadMirrorPending.current = loads;
    if (loadMirrorTimer.current) clearTimeout(loadMirrorTimer.current);
    loadMirrorTimer.current = setTimeout(flushLoadMirror, 250);
    return () => {};
  }, [loads]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") { flushVehMirror(); flushLoadMirror(); } };
    const onUnload = () => { flushVehMirror(); flushLoadMirror(); };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onUnload);
    window.addEventListener("pagehide", onUnload);
    return () => {
      document.removeEventListener("visibilitychange", onHide);
      window.removeEventListener("beforeunload", onUnload);
      window.removeEventListener("pagehide", onUnload);
      flushVehMirror(); flushLoadMirror();
    };
  }, []);
  useEffect(() => {
    const refreshFromStorage = () => {
      let vehRaw = "", loadRaw = "";
      try {
        vehRaw = localStorage.getItem("lov_tms_vehicles") || "";
        loadRaw = localStorage.getItem("lov_tms_loads") || "";
      } catch {}
      const vehWork = vehRaw !== lastVehRaw.current || pendingVehicleIds.current.size > 0;
      const loadWork = loadRaw !== lastLoadRaw.current || pendingLoadIds.current.size > 0;
      // Skip when localStorage is byte-identical to what's already shown and no
      // pending local edit needs merging. Idle sync ticks then do zero work
      // instead of re-rendering the whole fleet every time — and a refresh can
      // no longer clobber an in-flight local edit.
      if (!vehWork && !loadWork) return;
      if (vehWork) {
        lastVehRaw.current = vehRaw;
        const savedVehicles = getVehicles() || [];
        setVehicles((prev) => mergePending(pendingVehicleIds, savedVehicles, prev));
      }
      if (loadWork) {
        lastLoadRaw.current = loadRaw;
        const savedLoads = getLoads() || [];
        setLoads((prev) => mergePending(pendingLoadIds, savedLoads, prev));
      }
    };
    window.addEventListener("tms:sync", refreshFromStorage);
    refreshFromStorage();
    return () => window.removeEventListener("tms:sync", refreshFromStorage);
  }, []);
  useEffect(() => subscribeSyncStatus(setSyncStatus), []);

  // PHASE 4 CLEANUP: the one-shot 'delivered orphan reconciler' that lived here
  // was DELETED as provably dead code — it keyed entirely on vstatus === 'DELIVERED',
  // a value nothing in the system ever writes (DELIVERED is a load status / quickVS
  // action, never a stored vehicle status). Repair-after-the-fact is retired anyway:
  // sources are atomic (engine lanes) and the invariant-tick cron is the detector.


  const [logs, setLogs] = useState([{ msg:"System ready — fleet loaded", color:"var(--green)", t: new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}) }]);
  const [loadLogs, setLoadLogs] = useState([{ msg:"Load board ready — 5 pending loads", color:"#374151", t: new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"}) }]);

  // Live GPS from Fleetx — vnum -> { address, lat, lng, status, updatedAt }
  const [gpsMap, setGpsMap] = useState({});
  const [gpsMeta, setGpsMeta] = useState({ total: 0, fetchedAt: 0 });
  const fetchLive = useServerFn(getLiveFleet);
  const fetchPlaces = useServerFn(searchIndianPlaces);
  const fetchState = useServerFn(reverseGeocodeState);
  // vnum -> resolved state name (cached)
  const [stateMap, setStateMap] = useState({});
  // vnum -> reverse-geocoded address (fallback when Fleetx address missing)
  const [addrMap, setAddrMap] = useState({});
  const [geoStatusMap, setGeoStatusMap] = useState({});
  const [geoRetryTick, setGeoRetryTick] = useState(0);
  const stateMapRef = useRef({});
  const addrMapRef = useRef({});
  const stateReqRef = useRef(new Set());
  const geoRetryRef = useRef({});
  const geoRetryTimersRef = useRef({});
  const vehiclesRef = useRef([]);
  useEffect(() => { vehiclesRef.current = vehicles; }, [vehicles]);
  const cityCacheRef = useRef(new Map());
  const searchCities = useMemo(() => {
    const MANUAL_CITIES = [
      { label: "Jammu, Jammu and Kashmir, India", coords: { lat: 32.732998, lng: 74.864273 } },
      { label: "Gurgaon, Haryana, India", coords: { lat: 28.4595, lng: 77.0266 } },
      { label: "Tauru, Haryana, India", coords: { lat: 28.212, lng: 76.951 } },
      { label: "Srinagar, Jammu and Kashmir, India", coords: { lat: 34.08565, lng: 74.80555 } },
      { label: "Kurukshetra, Haryana, India", coords: { lat: 30.0, lng: 76.75 } },
      { label: "Chhatrapati Sambhajinagar, Maharashtra, India", coords: { lat: 19.8791, lng: 75.339 } },
    ];
    const LABEL_REWRITES = [
      { pattern: /\bGurugram\b/g, replacement: "Gurgaon" },
    ];
    const SEARCH_ALIASES = {
      "gurgaon": "Gurugram",
    };
    const rewriteLabel = (s) => {
      if (typeof s !== "string") return s;
      let out = s;
      for (const { pattern, replacement } of LABEL_REWRITES) out = out.replace(pattern, replacement);
      return out;
    };
    const manualMatches = (q) => {
      const k = q.trim().toLowerCase();
      if (!k) return [];
      return MANUAL_CITIES.filter(m => m.label.toLowerCase().includes(k));
    };
    const mergeManual = (q, list) => {
      const manual = manualMatches(q);
      if (!manual.length) return list;
      const seen = new Set(list.map(x => x.label.toLowerCase()));
      const prepend = manual.filter(m => !seen.has(m.label.toLowerCase()));
      return [...prepend, ...list];
    };
    return async (q) => {
      if (!q || !q.trim()) return [];
      const key = q.trim().toLowerCase();
      const cache = cityCacheRef.current;
      if (cache.has(key)) {
        const v = cache.get(key);
        cache.delete(key); cache.set(key, v);
        return v;
      }
      const prefixFallback = () => {
        let best = null; let bestLen = 0;
        for (const [k, v] of cache.entries()) {
          if (Array.isArray(v) && v.length && (key.startsWith(k) || k.startsWith(key)) && k.length > bestLen) {
            best = v; bestLen = k.length;
          }
        }
        return best;
      };
      try {
        const aliasKey = key;
        const apiQuery = Object.prototype.hasOwnProperty.call(SEARCH_ALIASES, aliasKey) ? SEARCH_ALIASES[aliasKey] : q;
        const r = await fetchPlaces({ data: { query: apiQuery } });
        const results = Array.isArray(r?.results) ? r.results : [];
        const suggestions = Array.isArray(r?.suggestions) ? r.suggestions : [];
        const coordsByLabel = new Map(results.map(x => [rewriteLabel(x.label), { lat: x.lat, lng: x.lng }]));
        const out = suggestions
          .map(label => rewriteLabel(label))
          .map(label => ({ label, coords: coordsByLabel.get(label) || null }));
        const merged = mergeManual(q, out);
        if (merged.length) {
          cache.set(key, merged);
          if (cache.size > 50) cache.delete(cache.keys().next().value);
          return merged;
        }
        const fb = prefixFallback();
        return fb || mergeManual(q, []);
      } catch {
        const fb = prefixFallback();
        if (fb) return fb;
        const manual = mergeManual(q, []);
        if (manual.length) return manual;
        throw new Error("search_failed");
      }
    };
  }, [fetchPlaces]);




  // Mobile: auto-label table cells with their column header so the
  // stacked-card layout (see styles.css) shows "Header: value" pairs.
  useEffect(() => {
    const labelTables = () => {
      const tables = document.querySelectorAll(".tms-root table");
      tables.forEach((table) => {
        const headers = Array.from(table.querySelectorAll("thead th")).map(
          (th) => (th.textContent || "").trim()
        );
        if (!headers.length) return;
        table.querySelectorAll("tbody tr").forEach((tr) => {
          Array.from(tr.children).forEach((td, i) => {
            const h = headers[i];
            if (h && !td.getAttribute("data-label")) {
              td.setAttribute("data-label", h);
            }
          });
        });
      });
    };
    labelTables();
    const obs = new MutationObserver(() => labelTables());
    const root = document.querySelector(".tms-root");
    if (root) obs.observe(root, { childList: true, subtree: true });
    return () => obs.disconnect();
  }, []);
  // Per-vehicle Fleetx fallback bookkeeping: { [vnum]: lastAttemptMs }
  const _byNumberAttemptRef = useRef({});
  const _prevGpsSigRef = useRef("");
  const fetchByNumber = useServerFn(getVehicleByNumber);
  const fetchTrail = useServerFn(getVehicleTrail);
  const fetchLoadHalts = useServerFn(getLoadHalts);
  useEffect(() => {
    let alive = true;
    const indexVehicle = (m, owner, v) => {
      const exactKey = String(v.vehicleNumber || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
      // Ignore a known junk/duplicate FleetX plate whose last-10 chars collide
      // with a real vehicle (NEWHR55AG3660 → HR55AG3660), so it can never claim
      // the real truck's key and show a wrong location. Scoped to this one plate.
      if (exactKey === "NEWHR55AG3660") return;
      const gps = {
        address: v.address, lat: v.latitude, lng: v.longitude,
        status: v.currentStatus, updatedAt: v.lastUpdatedAt,
      };
      const assign = (k) => {
        if (!k) return;
        const existing = owner.get(k);
        if (existing && existing !== exactKey) {
          // Same key wanted by a different plate. Allow overwrite only if it's
          // the same truck (same first 8 chars of normalized plate) AND the
          // incoming record is fresher — keeps the flicker fix while letting
          // the freshest device record for the same truck win.
          const sameTruck = existing.slice(0, 8) === exactKey.slice(0, 8);
          const fresher = (gps.updatedAt || 0) > (m[k]?.updatedAt || 0);
          if (sameTruck && fresher) {
            m[k] = gps;
            owner.set(k, exactKey);
          }
          return;
        }
        if (!(k in m)) {
          m[k] = gps;
          owner.set(k, exactKey);
        }
      };
      for (const k of gpsVehicleAllKeys(v.vehicleNumber)) assign(k);
      assign(exactKey);
    };
    const load = async () => {
      try {
        const data = await fetchLive();
        if (!alive) return;
        const m = {};
        const owner = new Map();
        const liveVehicles = data.vehicles || [];
        liveVehicles.forEach(v => indexVehicle(m, owner, v));
        // Per-vehicle fallback for IN_TRANSIT TMS trucks missing from bulk feed.
        try {
          const tmsVehicles = vehiclesRef.current || [];
          const inTransitMissing = tmsVehicles.filter(tv =>
            tv?.vnum && tv.vstatus === "IN_TRANSIT" && !lookupGps(m, tv.vnum)
          );
          const now = Date.now();
          const candidates = inTransitMissing.filter(tv => {
            const last = _byNumberAttemptRef.current[tv.vnum] || 0;
            return now - last > 10 * 60_000;
          }).slice(0, 5);
          if (candidates.length) {
            await Promise.all(candidates.map(async tv => {
              _byNumberAttemptRef.current[tv.vnum] = now;
              try {
                const r = await fetchByNumber({ data: { vehicleNumber: tv.vnum } });
                const v = r?.vehicle || r;
                if (v && v.vehicleNumber) indexVehicle(m, owner, v);
              } catch { /* silent — Fleetx 404 for unknown vnum */ }
            }));
          }
        } catch {}
        if (!alive) return;
        // Skip the state update if nothing meaningful changed — this avoids
        // re-rendering every TAT row / sort key / memo on each 60s refresh.
        const sig = Object.keys(m).sort().map(k => {
          const g = m[k];
          return `${k}|${g?.lat}|${g?.lng}|${g?.updatedAt}|${g?.status}`;
        }).join(";");
        if (sig !== _prevGpsSigRef.current) {
          _prevGpsSigRef.current = sig;
          setGpsMap(m);
        }
        setGpsMeta(prev => (prev?.total === liveVehicles.length ? prev : { total: liveVehicles.length, fetchedAt: Date.now() }));
        try {
          const tmsVnums = (vehiclesRef.current || []).map(x => x?.vnum).filter(Boolean);
          const unmatched = tmsVnums.filter(vn => !lookupGps(m, vn));
          // eslint-disable-next-line no-console
          console.info(`[GPS] Fleetx feed: ${liveVehicles.length} vehicles · TMS unmatched: ${unmatched.length}/${tmsVnums.length}`, unmatched.slice(0, 10));
        } catch {}
      } catch (e) { /* silent */ }
    };
    load();
    const id = setInterval(() => { if (!document.hidden) load(); }, 60_000);
    const onVisible = () => { if (!document.hidden) load(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", onVisible); };
  }, [fetchLive, fetchByNumber]);


  // Auto status → AT_UNLOADING (rule moved below destBranchMap declaration)
  const autoUnloadedRef = useRef(new Set());



  useEffect(() => { stateMapRef.current = stateMap; }, [stateMap]);
  useEffect(() => { addrMapRef.current = addrMap; }, [addrMap]);

  // Reverse-geocode each GPS-known vehicle to a state + address (cached per vnum)
  useEffect(() => {
    let cancelled = false;
    for (const [vnum, g] of Object.entries(gpsMap)) {
        if (!g || g.lat == null || g.lng == null) continue;
        const addressState = stateFromGpsAddress(g.address);
        const haveAddr = !!g.address || !!addrMapRef.current[vnum];
        const haveState = !!stateMapRef.current[vnum] || !!addressState;
        if (addressState && stateMapRef.current[vnum] !== addressState) {
          setStateMap(p => ({ ...p, [vnum]: addressState }));
        }
        if (haveState && haveAddr) continue;
        const coordKey = gpsCoordKey(g);
        const retry = geoRetryRef.current[vnum];
        if (retry?.coordKey && retry.coordKey !== coordKey) delete geoRetryRef.current[vnum];
        const nextRetryAt = geoRetryRef.current[vnum]?.nextRetryAt || 0;
        if (Date.now() < nextRetryAt) continue;
        if (stateReqRef.current.has(vnum)) continue;
        stateReqRef.current.add(vnum);
        (async () => { try {
          const r = await withTimeout(fetchState({ data: { lat: g.lat, lng: g.lng } }), GEO_LOOKUP_TIMEOUT_MS, `Location lookup timed out for ${vnum}`);
          if (cancelled) return;
          if (r?.state) setStateMap(p => ({ ...p, [vnum]: r.state }));
          if (r?.address && !g.address) setAddrMap(p => ({ ...p, [vnum]: r.address }));
          const resolvedEnough = (!!stateMapRef.current[vnum] || !!addressState || !!r?.state) && (!!g.address || !!addrMapRef.current[vnum] || !!r?.address);
          if (resolvedEnough) {
            delete geoRetryRef.current[vnum];
            clearTimeout(geoRetryTimersRef.current[vnum]);
            delete geoRetryTimersRef.current[vnum];
            setGeoStatusMap(p => p[vnum] ? ({ ...p, [vnum]: null }) : p);
          } else {
            const attempts = (geoRetryRef.current[vnum]?.attempts || 0) + 1;
            const delay = Math.min(GEO_RETRY_BASE_MS * attempts, 60_000);
            geoRetryRef.current[vnum] = { coordKey, attempts, nextRetryAt: Date.now() + delay };
            clearTimeout(geoRetryTimersRef.current[vnum]);
            geoRetryTimersRef.current[vnum] = setTimeout(() => setGeoRetryTick(t => t + 1), delay + 250);
            setGeoStatusMap(p => ({ ...p, [vnum]: { attempts, failed: attempts >= GEO_MAX_ATTEMPTS } }));
          }
        } catch {
          const attempts = (geoRetryRef.current[vnum]?.attempts || 0) + 1;
          const delay = Math.min(GEO_RETRY_BASE_MS * attempts, 60_000);
          geoRetryRef.current[vnum] = { coordKey, attempts, nextRetryAt: Date.now() + delay };
          clearTimeout(geoRetryTimersRef.current[vnum]);
          geoRetryTimersRef.current[vnum] = setTimeout(() => setGeoRetryTick(t => t + 1), delay + 250);
          setGeoStatusMap(p => ({ ...p, [vnum]: { attempts, failed: attempts >= GEO_MAX_ATTEMPTS } }));
        } finally {
          stateReqRef.current.delete(vnum);
        } })();
      }
    return () => { cancelled = true; };
  }, [gpsMap, fetchState, geoRetryTick]);

  useEffect(() => () => {
    Object.values(geoRetryTimersRef.current).forEach(clearTimeout);
  }, []);

  // vnum -> computed GPS branch
  const gpsBranchMap = useMemo(() => {
    const out = {};
    for (const [vnum, g] of Object.entries(gpsMap)) {
      if (!g) continue;
      const b = computeGpsBranch(stateMap[vnum] || stateFromGpsAddress(g.address), g.lat, g.lng);
      if (b) out[vnum] = b;
    }
    return out;
  }, [gpsMap, stateMap]);


  const [vForm, setVForm] = useState(blankV());
  const [vEdit, setVEdit] = useState(false);
  const [fFilter, setFFilter] = useState("ALL");
  const [fBranchFilter, setFBranchFilter] = useState("");
  const [fToBranchFilter, setFToBranchFilter] = useState("");
  const [fPinOnly, setFPinOnly] = useState(false);
  const [fNoDriverOnly, setFNoDriverOnly] = useState(false);
  const [fSearch, setFSearch] = useState("");
  const fSearchDef = useDeferredValue(fSearch);
  // Extra fleet filters
  const [fVehFilter, setFVehFilter] = useState("");
  const [fFromCityFilter, setFFromCityFilter] = useState("");
  const [fToCityFilter, setFToCityFilter] = useState("");
  const [fCustomerFilter, setFCustomerFilter] = useState("");
  const [fPending, setFPending] = useState(false);
  const [fPreTransit, setFPreTransit] = useState(false);
  const [fRpdc, setFRpdc] = useState(false);
  const [fDateFrom, setFDateFrom] = useState("");
  const [fDateTo, setFDateTo] = useState("");
  // Fleet pagination
  const [fPage, setFPage] = useState(1);
  const [fPerPage, setFPerPage] = useState(20);
  // Mobile: collapsible side panel (Add Vehicle / Add Load)
  const [mobileSideOpen, setMobileSideOpen] = useState(false);
  // Load Board branch chip filter
  const [lbBranchChip, setLbBranchChip] = useState("");
  const [lbOnlyMulti, setLbOnlyMulti] = useState(false);
  const [lbOnlyLeftUnload, setLbOnlyLeftUnload] = useState(false);
  const [lbOnlyNoDriver, setLbOnlyNoDriver] = useState(false);
  const [lbOnlyIncident, setLbOnlyIncident] = useState(false);
  const [lbPage, setLbPage] = useState(1);
  // "Left unloading" = vehicle auto-demoted out of AT_UNLOADING (drove away from
  // destination) before dispatcher tapped Mark Delivered. Persisted on the load
  // so the warning surfaces on every device until acknowledged or delivered.
  const isLeftUnload = (l) => !!l && !!l.leftUnloadingAt && !l.leftUnloadingAck && l.lstatus !== "DELIVERED";
  const ackLeftUnload = (id) => pushLoads(p => p.map(l => l.id === id ? { ...l, leftUnloadingAck: true } : l));
  const fmtLeftUnloadAgo = (ts) => {
    const m = Math.max(0, Math.floor((Date.now() - ts) / 60000));
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60); const mm = m % 60;
    if (h < 24) return `${h}h ${mm}m ago`;
    const d = Math.floor(h / 24); const hh = h % 24;
    return `${d}d ${hh}h ago`;
  };
  // LR Date modal (for On Trip transition)
  const [lrModal, setLrModal] = useState(null); // { vehicleId }
  const [lrDateInput, setLrDateInput] = useState("");
  // City coords cache (for TAT tracker)
  const [cityCoords, setCityCoords] = useSyncedSetting("tms.cityCoords", DEFAULT_CITY_COORDS);

  // Phase 1b: assignment canonical-lane flag (default OFF). When true, assign /
  // queue / promote / unassign route their AUTHORITATIVE server write through the
  // dedicated RPCs (gwAssign/gwQueue/gwPromote/gwUnassign); the existing
  // pushLoads/pushVehicles become optimistic-local-only. Flip via app_settings
  // 'assign.useEngine'; flip back to roll back instantly. Mirrors cron.useEngine.
  const [assignUseEngine] = useSyncedSetting("assign.useEngine", false);
  const [deliveryUseEngine] = useSyncedSetting("delivery.useEngine", false);
  // ROOT FIX (single-writer): client-side GPS auto status mutation (arrival promote +
  // left-unloading demote). Default OFF — the server crons (arrival-tick 5m,
  // left-unloading-tick 15m) are the ONLY status writers, via the engine, atomically.
  // The client loop half-updating pairs was the cause of the vehicle/load mismatch
  // flickers (LD-5852, HR55AG0676). Kill-switch: set app_settings key
  // "gps.clientAutoStatus" = true to restore legacy client writes instantly (no deploy).
  // NOTE: the loop's AVAILABLE-free legs (loadDone/orphan/noDest) and min-distance
  // bookkeeping stay ACTIVE regardless — no cron covers those yet.
  const [clientAutoStatus] = useSyncedSetting("gps.clientAutoStatus", false);
  // vehicleDelete.useEngine flag retired in cleanup — the canonical-lane delete path is always used.

  // Load form
  const [lForm, setLForm] = useState(blankL());
  const [lEdit, setLEdit] = useState(false);
  const [lExtra, setLExtra] = useState({ duplicate:false, dupCount:2, multi:false, multiCount:2, consignees:[""], multiLoads:false, multiLoadsCount:2, multiLoadsRows:[{qty:1,dest:""},{qty:1,dest:""}] });
  // Load Board view mode — persisted per device in localStorage
  const [lbViewMode, setLbViewMode] = useState(() => {
    try { return localStorage.getItem("tms.lbViewMode") || "table"; } catch { return "table"; }
  });
  const setLbViewModePersist = (mode) => {
    setLbViewMode(mode);
    try { localStorage.setItem("tms.lbViewMode", mode); } catch {}
  };
  const [lFilter, setLFilter] = useState("ALL");
  const [lSearch, setLSearch] = useState("");
  const lSearchDef = useDeferredValue(lSearch);
  const [lBranch, setLBranch] = useState("");
  // Load Board's own fleet-side Branch filter (independent of Fleet page's fBranchFilter)
  const [lbFleetBranchFilter, setLbFleetBranchFilter] = useState("");
  const [lCustomer, setLCustomer] = useState("");
  const [lVType, setLVType] = useState("");

  // Modals
  const [delV, setDelV] = useState(null);
  const [delL, setDelL] = useState(null);
  const [assignLid, setAssignLid] = useState(null);
  const [showAllAssignVehicles, setShowAllAssignVehicles] = useState(true);
  const [assignSearch, setAssignSearch] = useState("");
  const [assignAllBranches, setAssignAllBranches] = useState(true);
  // Sent For Loading ETA popup
  const [sflModal, setSflModal] = useState(null); // { vehicleId, pendingStatus }
  const [sflEta, setSflEta] = useState("");

  // Load details "See more" dialog
  const [seeMoreLoadId, setSeeMoreLoadId] = useState(null);
  // PIN modal
  const [pinModal, setPinModal] = useState(null); // vehicle object
  const [pinInput, setPinInput] = useState("");
  const [pinSaving, setPinSaving] = useState(false);
  // Consignee delivered date modal
  const [cdModal, setCdModal] = useState(null); // { loadId, index }
  const [cdDateTime, setCdDateTime] = useState(""); // "YYYY-MM-DDTHH:mm"


  // Sidebar nav
  const [sidebarOpen, setSidebarOpen] = useState(false);
  // Branch management
  const [branches, setBranches] = useSyncedSetting("tms.branches", DEFAULT_BRANCHES);
  const [newBranchInput, setNewBranchInput] = useState("");
  const [editBranchIdx, setEditBranchIdx] = useState(null);
  const [editBranchVal, setEditBranchVal] = useState("");
  const addBranch = () => {
    const val = newBranchInput.trim();
    if (!val) return;
    if (branches.find(b=>b.toLowerCase()===val.toLowerCase())) { alert("Branch already exists."); return; }
    setBranches(p=>[...p, val]);
    setNewBranchInput("");
  };
  const deleteBranch = (idx) => { setBranches(p=>p.filter((_,i)=>i!==idx)); };
  const saveBranchEdit = (idx) => {
    const val = editBranchVal.trim();
    if (!val) return;
    setBranches(p=>p.map((b,i)=>i===idx?val:b));
    setEditBranchIdx(null); setEditBranchVal("");
  };

  // Customer management
  const [customers, setCustomers] = useSyncedSetting("tms.customers", CUSTOMERS);
  const [newCustomerInput, setNewCustomerInput] = useState("");
  const [editCustomerIdx, setEditCustomerIdx] = useState(null);
  const [editCustomerVal, setEditCustomerVal] = useState("");
  const addCustomer = () => {
    const val = newCustomerInput.trim();
    if (!val) return;
    if (customers.find(c=>c.toLowerCase()===val.toLowerCase())) { alert("Customer already exists."); return; }
    setCustomers(p=>[...p, val]);
    setNewCustomerInput("");
  };
  const deleteCustomer = (idx) => {
    const name = customers[idx];
    const inUse = loads.some(l=>l.customer===name) || vehicles.some(v=>v.customer===name);
    if (inUse && !confirm(`"${name}" is used in loads/vehicles. Delete anyway?`)) return;
    setCustomers(p=>p.filter((_,i)=>i!==idx));
  };
  const saveCustomerEdit = (idx) => {
    const val = editCustomerVal.trim();
    if (!val) return;
    setCustomers(p=>p.map((c,i)=>i===idx?val:c));
    setEditCustomerIdx(null); setEditCustomerVal("");
  };

  // Settings sub-tab
  const [settingsSub, setSettingsSub] = useState("branches");

  // Driver App setup state
  const [driverAccountStatus, setDriverAccountStatus] = useState(null);
  const [driverAccountLoading, setDriverAccountLoading] = useState(false);
  const [driverAccountError, setDriverAccountError] = useState(null);

  useEffect(() => {
    if (tab !== "settings" || settingsSub !== "driverapp") return;
    getDriverCredentialsFn().then(r => {
      if (r.ok) setDriverAccountStatus("exists");
    }).catch(() => {});
  }, [tab, settingsSub]);

  const handleCreateDriverAccount = async () => {
    setDriverAccountLoading(true);
    setDriverAccountError(null);
    try {
      const r = await createDriverAccountFn();
      if (r.ok) setDriverAccountStatus("exists");
    } catch (e) {
      setDriverAccountError(e.message || "Failed to create driver account");
    } finally {
      setDriverAccountLoading(false);
    }
  };

  // Maintenance (admin one-shot wipes)
  // M3 AUDIT (Jul 4): the two Maintenance bulk actions were RETIRED —
  // "Reset all vehicles to Available" (mass pair-breaker: flipped mid-trip trucks
  // to AVAILABLE with raw unversioned writes) and "Clear all loads & PoDs"
  // (hard-deleted the entire load history + every proof-of-delivery record).
  // Legitimate retirement of old data is served by soft-delete + purge cron.

  // Destination → Branch resolver: GPS / State-based fallback only.
  // No hardcoded city→branch rules and no user-managed mapping. Branch is
  // derived from the destination's geocoded Indian state, refined by cached
  // coords for intra-state splits (Maharashtra→Pune/Nagpur, TN→Chennai/Hyderabad,
  // ≤100 km of Delhi → Gurgaon).
  const cityKey = (s) => String(s||"").trim().toLowerCase();
  const getDestBranch = (dest) => {
    if (!dest) return "";
    const key = cityKey(dest);
    const st = stateFromGpsAddress(dest);
    if (!st) return "";
    const coord = cityCoords[key];
    if (coord && coord.lat != null && coord.lng != null) {
      const b = computeGpsBranch(st, coord.lat, coord.lng);
      if (b) return b;
    }
    // No coord yet — use a state-only default that avoids distance checks.
    const stateDefault = {
      Maharashtra: "Pune", "Tamil Nadu": "Chennai", Haryana: "Gurgaon",
      Delhi: "Gurgaon", Gujarat: "Ahmedabad", Kerala: "Kerala",
      Telangana: "Hyderabad", "Andhra Pradesh": "Hyderabad", Bihar: "Patna",
      "West Bengal": "Kolkata", Odisha: "Bhubaneshwar", Chhattisgarh: "Chhattisgarh",
      Jharkhand: "Ranchi", Uttarakhand: "Rudrapur", Punjab: "Ambala/Ludhiana",
      "Jammu and Kashmir": "Jammu", Ladakh: "Jammu", "Himachal Pradesh": "Himachal",
      "Uttar Pradesh": "Lucknow", "Madhya Pradesh": "Indore",
      Karnataka: "Bangalore", Goa: "Goa", Rajasthan: "Jaipur",
      Assam: "Siliguri", "Arunachal Pradesh": "Siliguri", Manipur: "Siliguri",
      Meghalaya: "Siliguri", Mizoram: "Siliguri", Nagaland: "Siliguri",
      Sikkim: "Siliguri", Tripura: "Siliguri",
    }[st];
    return stateDefault || "";
  };

  const [unBranchFilter, setUnBranchFilter] = useState("");
  const [unCustomerFilter, setUnCustomerFilter] = useState("");
  const [unSearch, setUnSearch] = useState("");
  const unSearchDef = useDeferredValue(unSearch);
  const [incomingBranches, setIncomingBranches] = useState([]); // empty = all
  const [incomingDay, setIncomingDay] = useState("ALL");


  // Auto status → AT_UNLOADING when vehicle's live GPS is within
  // UNLOAD_RADIUS_KM (80 km) of the destination city.
  useEffect(() => {
    if (document.hidden) return;
    const updates = [];
    const demotes = []; // { id, vnum, dest, distKm, nextStatus, hadLoad }
    const minDistTracks = []; // { loadId, newMin } — min-dest-distance updates while AT_UNLOADING
    // Per-tick O(V+L) lookup maps — replace per-vehicle linear scans over loads.
    // Built in array order, so .find() over a per-vehicle list returns the same
    // first match the old loads.find() did. Pure lookup-method change.
    const _loadById = new Map();   // String(id) -> load
    const _loadsByVeh = new Map(); // vehicleId -> loads[] (original order)
    for (const _l of loads) {
      _loadById.set(String(_l.id), _l);
      const _vid = _l.vehicleId;
      if (_vid != null) {
        const _arr = _loadsByVeh.get(_vid);
        if (_arr) _arr.push(_l); else _loadsByVeh.set(_vid, [_l]);
      }
    }
    const _vehLoads = (vid) => _loadsByVeh.get(vid) || [];
    for (const v of vehicles) {
      // (PHASE 4: dead `vstatus === "DELIVERED"` guard removed — nothing writes that value.)
      // PHASE 3 (root-level): the "free a truck whose load is DELIVERED" janitor leg
      // that lived here was DELETED. Delivery is atomic through the engine
      // (delivery.useEngine=true) — a delivered load frees its vehicle in the same
      // transaction, so a stuck-busy truck is now an INVARIANT VIOLATION, not routine.
      // Detection moved to the read-only invariant-tick cron (reports, never writes).
      if (v.vstatus === "IN_TRANSIT" || v.vstatus === "AT_LOADING" || v.vstatus === "SENT_FOR_LOADING") {
        // Only IN_TRANSIT is eligible for the AT_UNLOADING promote; AT_LOADING
        // and SENT_FOR_LOADING are pre-trip states and must not jump straight to unload.
        if (v.vstatus !== "IN_TRANSIT") continue;
      }

      // Only consider ACTIVE loads (not delivered/cancelled/cleared). FIX #5: CANCELLED is terminal too.
      const ld = _vehLoads(v.id).find(l => l.dest && !isTerminal(l.lstatus));
      // Manual override: user set AT_UNLOADING explicitly on this load — freeze auto rule.
      if (ld?.manualUnloadOverride) continue;
      const dest = ld?.dest || v.destination || "";
      const vnumKey = gpsVehicleKey(v.vnum); const vnumKeyAlt = gpsVehicleKeyAlt(v.vnum);
      const gps = (gpsMap[vnumKey] || gpsMap[vnumKeyAlt]);
      const destKey = dest.trim().toLowerCase();
      const destCoord = destKey ? (cityCoords[destKey] || DEFAULT_CITY_COORDS[destKey]) : null;
      const distKm = (gps && destCoord) ? haversineKm(gps.lat, gps.lng, destCoord.lat, destCoord.lng) : null;
      const withinUnload = distKm != null && isFinite(distKm) && distKm <= UNLOAD_RADIUS_KM;

      if (v.vstatus === "AT_UNLOADING") {
        // Conservative demote: never strand a manually-set AT_UNLOADING vehicle on
        // Available because of a transient lookup miss (cloud-sync hydration race,
        // short-haul edits, etc). Only demote when GPS proves the vehicle is
        // genuinely outside the unload radius + buffer, and always fall back to
        // IN_TRANSIT (the vehicle still has an active load).
        if (!ld) {
          // PHASE 3 (root-level): the loadDone free that lived here was DELETED —
          // same rationale as above. No active load visible → do nothing (never
          // free on absence); a genuinely stuck truck is the invariant cron's find.
          continue;
        }
        if (ld.manualUnloadOverride) continue; // user set this manually
        if (isTerminal(ld.lstatus)) continue; // never re-flag a delivered/cancelled load (FIX #5)

        // Track minimum distance ever reached during this AT_UNLOADING visit.
        // Only queue a write if it's a meaningful improvement to avoid churn.
        if (distKm != null && isFinite(distKm)) {
          const curMin = (ld.minDestDistKm != null && isFinite(ld.minDestDistKm)) ? ld.minDestDistKm : Infinity;
          if (distKm < curMin - 0.5) {
            minDistTracks.push({ loadId: ld.id, newMin: distKm });
          }
        }

        // GATED (single-writer): the left-unloading demote is now owned by the
        // server cron (left-unloading-tick → engine, atomic vehicle+load). The
        // client only computes it when the legacy flag is explicitly re-enabled.
        // Min-distance tracking above stays on — it feeds the cron's cameClose guard.
        if (clientAutoStatus && distKm != null && isFinite(distKm) && distKm > UNLOAD_RADIUS_KM + UNLOAD_EXIT_BUFFER_KM) {
          // Validate the conditions for recording an actual "left unloading" flag.
          // Any failure → silent demote (no leftUnloading* fields set).
          const gpsFresh = !!(gps && gps.updatedAt && (Date.now() - gps.updatedAt) <= GPS_FRESH_MS);
          const destResolved = !!(destKey && cityCoords[destKey] && cityCoords[destKey].lat != null && cityCoords[destKey].lng != null);
          const enterAt = ld.unloadEnterAt || null;
          const dwellOk = !!(enterAt && (Date.now() - enterAt) >= MIN_UNLOAD_DWELL_MS);
          // Include any pending in-tick min update so a vehicle that just got
          // close on this same tick still satisfies the guard.
          const pendingMin = minDistTracks.find(m => m.loadId === ld.id)?.newMin;
          const effectiveMin = pendingMin != null ? Math.min(pendingMin, ld.minDestDistKm ?? Infinity) : ld.minDestDistKm;
          const cameCloseOk = effectiveMin != null && isFinite(effectiveMin) && effectiveMin <= NEAR_DEST_KM;
          const flag = gpsFresh && destResolved && dwellOk && cameCloseOk;
          demotes.push({
            id: v.id,
            vnum: v.vnum,
            dest: dest || "—",
            distKm,
            nextStatus: "IN_TRANSIT",
            loadId: ld.id,
            hadLoad: true,
            reason: "far",
            flagLeftUnload: flag,
            silentReason: !flag ? (
              !gpsFresh ? "stale GPS"
              : !destResolved ? "dest not geocoded"
              : !dwellOk ? `dwell ${enterAt?Math.round((Date.now()-enterAt)/60000):0}m < 4h`
              : !cameCloseOk ? `closest ${effectiveMin!=null && isFinite(effectiveMin)?Math.round(effectiveMin):"?"} km > ${NEAR_DEST_KM} km`
              : ""
            ) : "",
          });
        }
        continue;
      }

      // Forward promote — require an ACTIVE load (not just a stale v.destination),
      // otherwise demoted vehicles immediately re-promote and the page flickers.
      if (!ld || !dest || !gps || !destCoord) continue;
      if (isTerminal(ld.lstatus)) continue; // never promote a delivered/cancelled load to AT_UNLOADING (FIX #5)
      if (!withinUnload) continue;
      // Left-unloading guard: never re-promote a flagged load — dispatcher must dismiss or deliver first.
      if (ld.leftUnloadingAt && !ld.leftUnloadingAck) continue;
      // Short-haul exception: if origin → dest distance is < UNLOAD_RADIUS_KM,
      // the unload geofence covers the whole route, which would flip the
      // vehicle to AT_UNLOADING the moment it leaves origin. Skip auto-promote
      // for short hauls; user can still set status manually.
      const origKey = (ld.origin||"").trim().toLowerCase();
      const origCoord = origKey ? (cityCoords[origKey] || DEFAULT_CITY_COORDS[origKey]) : null;
      if (origCoord) {
        const odKm = haversineKm(origCoord.lat, origCoord.lng, destCoord.lat, destCoord.lng);
        if (isFinite(odKm) && odKm < UNLOAD_RADIUS_KM) continue;
      }
      // GATED (single-writer): the arrival promote is now owned by the server cron
      // (arrival-tick → engine, atomic vehicle+load, incl. the AVAILABLE-with-running-
      // load convergence). Client computes it only when the legacy flag is re-enabled.
      if (clientAutoStatus) updates.push({ id: v.id, loadId: ld.id, vnum: v.vnum, dest, distKm });

    }

    if (!updates.length && !demotes.length && !minDistTracks.length) return;

    if (updates.length || demotes.length) {
      pushVehicles(p => p.map(x => {
        const u = updates.find(u => u.id === x.id);
        if (u) {
          const t = new Date(Date.now() + 7.5*60*60*1000); // IST (UTC+5:30) + 2h travel buffer
          return { ...x, vstatus: "AT_UNLOADING", destination: u.dest, atUnloadingAt: x.atUnloadingAt || t.toISOString().slice(0,16) };
        }
        const d = demotes.find(d => d.id === x.id);

        if (d) {
          const { atUnloadingAt, ...rest } = x;
          // PHASE 4 CLEANUP: the AVAILABLE branch that lived here (freeing + clearing
          // loadId/stamps) was deleted — no demote produces nextStatus AVAILABLE anymore
          // (the janitor legs are gone; the only remaining demote is the flag-gated
          // left-unloading demote to IN_TRANSIT).
          return { ...rest, vstatus: d.nextStatus };
        }
        return x;
      }), { skipAudit: true }); // GPS auto-promote — not a deliberate human action
    }

    const promotedLoadIds = new Set(updates.map(u => u.loadId).filter(Boolean));
    const demotedLoadIds = new Set(demotes.map(d => d.loadId).filter(Boolean));
    const minDistByLoad = new Map(minDistTracks.map(m => [m.loadId, m.newMin]));
    if (promotedLoadIds.size || demotedLoadIds.size || minDistByLoad.size) {
      pushLoads(p => p.map(l => {
        if (promotedLoadIds.has(l.id) && l.lstatus !== "DELIVERED") {
          // Stamp first-enter timestamp for dwell tracking and seed minDestDistKm
          // with the current distance at promote time.
          const promo = updates.find(u => u.loadId === l.id);
          const seedMin = promo && promo.distKm != null && isFinite(promo.distKm) ? promo.distKm : null;
          const nextMin = seedMin != null
            ? Math.min(seedMin, l.minDestDistKm ?? Infinity)
            : l.minDestDistKm;
          return {
            ...l,
            lstatus: "AT_UNLOADING",
            unloadEnterAt: Date.now(), // always reset — never carry stale dwell from a prior visit
            minDestDistKm: (nextMin != null && isFinite(nextMin)) ? nextMin : (l.minDestDistKm ?? null),
          };
        }
        if (demotedLoadIds.has(l.id) && l.lstatus === "AT_UNLOADING" && l.lstatus !== "DELIVERED") {
          const dem = demotes.find(d => d.loadId === l.id);
          // Always clear dwell + min trackers on demote so a future re-promote restarts.
          const base = { ...l, lstatus: "IN_TRANSIT", unloadEnterAt: null, minDestDistKm: null };
          if (dem && dem.reason === "far" && dem.flagLeftUnload) {
            // Store raw distance from destination so dispatchers see
            // exactly how far the vehicle is, not distance past the boundary.
            const kmOut = Math.round(dem.distKm);
            return {
              ...base,
              leftUnloadingAt: Date.now(),
              leftUnloadingFromKm: kmOut,
              leftUnloadingDest: dem.dest || l.dest || "",
              leftUnloadingAck: false,
            };
          }
          return base;
        }
        // Min-distance-only tick update (load stays AT_UNLOADING).
        if (minDistByLoad.has(l.id)) {
          const newMin = minDistByLoad.get(l.id);
          const cur = (l.minDestDistKm != null && isFinite(l.minDestDistKm)) ? l.minDestDistKm : Infinity;
          if (newMin < cur) return { ...l, minDestDistKm: newMin };
        }
        return l;
      }), { skipAudit: true });
    }

    const t = new Date().toLocaleTimeString("en-IN", { hour: "2-digit", minute: "2-digit" });
    const promoteLogs = updates.map(u => ({ msg: `${u.vnum} auto → At Unloading (${u.distKm.toFixed(0)} km from ${u.dest})`, color: "#d97706", t }));
    const demoteLogs = demotes.map(d => {
      // PHASE 4 CLEANUP: labels for removed demote reasons (loadGone/loadDone/
      // noDest/orphan) deleted — only the left-unloading "far" demote remains.
      let why;
      if (d.reason === "far" && d.distKm >= 0) {
        const kmOut = Math.max(0, d.distKm - UNLOAD_RADIUS_KM);
        why = d.flagLeftUnload
          ? `left unloading — ${kmOut.toFixed(0)} km out from ${d.dest}`
          : `silent demote (${d.silentReason || "guard"}) — ${kmOut.toFixed(0)} km past ring`;
      }
      else why = !d.hadLoad ? "load unassigned" : "destination cleared";
      return { msg: `${d.vnum} → ${VS_LABELS[d.nextStatus] || d.nextStatus} (${why})`, color: d.flagLeftUnload ? "#2563eb" : "#6b7280", t };
    });
    if (promoteLogs.length || demoteLogs.length) {
      setLogs(p => [...promoteLogs, ...demoteLogs, ...p].slice(0, 50));
    }
  }, [vehicles, loads, gpsMap, cityCoords, clientAutoStatus]);

  // One-time cleanup of bogus historical "left unloading" records.
  // Clear leftUnloading* if the vehicle is now within (radius + buffer) of dest,
  // or if the stored "km out" is implausibly large (legacy raw-distance values).
  const _leftUnloadCleanedV2Ref = useRef(false);
  useEffect(() => {
    if (_leftUnloadCleanedV2Ref.current) return;
    if (!loads.length || !vehicles.length) return;
    _leftUnloadCleanedV2Ref.current = true;
    pushLoads(p => p.map(l => {
      if (!l.leftUnloadingAt || l.lstatus === "DELIVERED") return l;
      // No automatic cleanup based on distance — dispatchers may forget to
      // mark delivery even when vehicle is far away. Flag persists until
      // explicitly dismissed or load is marked delivered.
      // NOTE: leftUnloadingFromKm stores km PAST the exit boundary (not raw dist),
      // so valid values start at 0. The < UNLOAD_EXIT_BUFFER_KM check was
      // incorrectly wiping valid flags on every refresh — removed.

      const v = vehicles.find(x => x.id === l.vehicleId);
      if (!v) return l;
      const gps = lookupGps(gpsMap, v.vnum);
      const destKey = (l.dest||"").trim().toLowerCase();
      const destCoord = destKey ? cityCoords[destKey] : null;
      if (gps && destCoord && destCoord.lat != null) {
        const d = haversineKm(gps.lat, gps.lng, destCoord.lat, destCoord.lng);
        if (isFinite(d) && d <= UNLOAD_RADIUS_KM + UNLOAD_EXIT_BUFFER_KM) {
          return { ...l, leftUnloadingAt: null, leftUnloadingFromKm: null, leftUnloadingDest: null, leftUnloadingAck: null };
        }
      }
      return l;
    }), { skipAudit: true });
  }, [loads, vehicles, gpsMap, cityCoords]);



  // Geocode origin/dest cities for TAT tracker.
  // - Never persists null into the synced setting (would block retries across devices).
  // - On first mount, purge any legacy null entries so they get retried via _cityCache backoff.
  const _purgedNullsRef = useRef(false);
  useEffect(() => {
    if (_purgedNullsRef.current) return;
    _purgedNullsRef.current = true;
    setCityCoords(p => {
      const hasNulls = Object.entries(p || {}).some(([, v]) => v == null || v?.lat == null || v?.lng == null);
      if (!hasNulls) return p;
      const next = {};
      for (const [k, v] of Object.entries(p || {})) {
        if (v && v.lat != null && v.lng != null) next[k] = v;
      }
      return next;
    });
  }, [setCityCoords]);
  const _inFlightGeocodeRef = useRef(new Set());
  useEffect(() => {
    let alive = true;
    // Phase 1: seed cityCoords from coords already stored on loads (no network).
    const seeds = {};
    for (const l of loads) {
      if (l.origin && l.originCoords && l.originCoords.lat != null && l.originCoords.lng != null) {
        const k = l.origin.trim().toLowerCase();
        if (k && !(cityCoords[k] && cityCoords[k].lat != null)) seeds[k] = { lat: l.originCoords.lat, lng: l.originCoords.lng };
      }
      if (l.dest && l.destCoords && l.destCoords.lat != null && l.destCoords.lng != null) {
        const k = l.dest.trim().toLowerCase();
        if (k && !(cityCoords[k] && cityCoords[k].lat != null)) seeds[k] = { lat: l.destCoords.lat, lng: l.destCoords.lng };
      }
    }
    if (Object.keys(seeds).length) setCityCoords(p => ({ ...seeds, ...p }));

    // Phase 2: legacy backfill — for cities still missing coords, geocode them
    // and write back to the load row so subsequent loads are instant.
    //
    // Paced + batched: Nominatim (OpenStreetMap) enforces ~1 req/sec, so we
    // process cities through a small concurrency pool with a delay instead of
    // firing all ~230 at once (which got rate-limited → failures never cached
    // → re-fired every cold load). Results are accumulated and flushed in ONE
    // setCityCoords + ONE pushLoads, instead of one full-array rewrite per city.
    //
    // Priority: cities on ACTIVE loads (what a dispatcher is tracking right now,
    // and what the live board / TAT / map render) go first so their map dots and
    // TAT appear fast. Historical/delivered cities drain quietly afterward — no
    // one is waiting on them.
    const ACTIVE_LS = (ls) => ls && ls !== "DELIVERED" && ls !== "CANCELLED";
    const activeCityKeys = new Set();
    loads.forEach(l => {
      if (!ACTIVE_LS(l.lstatus)) return;
      if (l.origin) activeCityKeys.add(l.origin.trim().toLowerCase());
      if (l.dest)   activeCityKeys.add(l.dest.trim().toLowerCase());
    });

    const missing = [];
    {
      const cities = new Set();
      loads.forEach(l => { if (l.origin) cities.add(l.origin); if (l.dest) cities.add(l.dest); });
      for (const c of cities) {
        const k = c.trim().toLowerCase();
        if (!k) continue;
        const existing = cityCoords[k] || seeds[k];
        if (existing && existing.lat != null && existing.lng != null) continue;
        if (_inFlightGeocodeRef.current.has(k)) continue;
        missing.push({ c, k, priority: activeCityKeys.has(k) });
      }
      // Active-load cities first, historical after.
      missing.sort((a, b) => (b.priority ? 1 : 0) - (a.priority ? 1 : 0));
    }

    if (missing.length) {
      (async () => {
        const POOL = 2;               // concurrent lookups (stay under OSM's rate policy)
        const GAP_PRIORITY_MS = 350;  // active-load cities: snappier (still polite)
        const GAP_BACKFILL_MS = 1100; // historical cities: ~1/sec, no rush
        const resolved = {};          // k -> { lat, lng }, accumulated then flushed

        missing.forEach(({ k }) => _inFlightGeocodeRef.current.add(k));

        // Flush whatever's resolved so far into the synced cache + loads.
        const flush = () => {
          if (!alive || !Object.keys(resolved).length) return;
          setCityCoords(p => {
            const next = { ...p };
            for (const k in resolved) if (!(next[k] && next[k].lat != null)) next[k] = resolved[k];
            return next;
          });
          pushLoads(p => p.map(l => {
            const ok = (kk) => resolved[kk] && resolved[kk].lat != null;
            const oKey = (l.origin || "").trim().toLowerCase();
            const dKey = (l.dest || "").trim().toLowerCase();
            let next = l;
            if (ok(oKey) && !(l.originCoords && l.originCoords.lat != null)) {
              next = { ...next, originCoords: resolved[oKey] };
            }
            if (ok(dKey) && !(l.destCoords && l.destCoords.lat != null)) {
              next = { ...next, destCoords: resolved[dKey] };
            }
            return next;
          }));
        };

        // Process one contiguous slice of `missing` through a small pool.
        const runSlice = async (start, end, gapMs) => {
          let idx = start;
          const worker = async () => {
            while (idx < end) {
              if (!alive) return;
              const item = missing[idx++];
              try {
                const r = await geocodeCity(item.c);
                if (r && r.lat != null && r.lng != null) resolved[item.k] = { lat: r.lat, lng: r.lng };
              } catch { /* geocodeCity already caches failures w/ backoff */ }
              finally { _inFlightGeocodeRef.current.delete(item.k); }
              await new Promise(res => setTimeout(res, gapMs));
            }
          };
          await Promise.all(Array.from({ length: Math.min(POOL, end - start) }, worker));
        };

        // `missing` is sorted priority-first, so the priority items are [0, priorityCount).
        const priorityCount = missing.filter(m => m.priority).length;

        // Phase 1: active-load cities → fast, then flush so their map dots/TAT appear.
        if (priorityCount) {
          await runSlice(0, priorityCount, GAP_PRIORITY_MS);
          flush();
        }
        // Phase 2: historical/delivered cities → background pace, single final flush.
        if (priorityCount < missing.length) {
          await runSlice(priorityCount, missing.length, GAP_BACKFILL_MS);
          flush();
        }
      })();
    }
    return () => { alive = false; };
  }, [loads, cityCoords, setCityCoords]);

  // Self-heal city geocode cache when the tab becomes visible again.
  // Background throttling can leave fetch promises permanently unsettled;
  // sweep stuck in-flight entries and expired failures so retries resume.
  useEffect(() => {
    const onVisible = () => {
      if (document.hidden) return;
      let changed = false;
      for (const [k, v] of _cityCache.entries()) {
        if (v && typeof v.then === "function") { _cityCache.delete(k); changed = true; }
        else if (v && v.failedAt != null && _cityFailureExpired(v)) { _cityCache.delete(k); changed = true; }
      }
      _inFlightGeocodeRef.current.clear();
      if (changed) setCityCoords(p => ({ ...p }));
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [setCityCoords]);





  // Driver Preferences tab
  const [dpSearch, setDpSearch] = useState("");
  const dpSearchDef = useDeferredValue(dpSearch);
  const [dpEdit, setDpEdit] = useState(null); // vehicle id being edited
  const [dpForm, setDpForm] = useState({ prefRoutes:"", prefVtypes:"", driverExp:"", driverNote:"", driverRating:0 });

  // Lock & approval state
  const [lockedLoads, setLockedLoads] = useSyncedSetting("tms.lockedLoads", {}); // { loadId: true }
  const [urgentLoads, setUrgentLoads] = useSyncedSetting("tms.urgentLoads", {}); // { loadId: true }
  const toggleUrgent = (loadId) => {
    setUrgentLoads(p => {
      const n = {...p};
      if (n[loadId]) { delete n[loadId]; addLLog(`Urgent flag removed from load`,"#6b7280"); }
      else { n[loadId] = true; addLLog(` Load marked urgent for loading`,"#dc2626"); }
      return n;
    });
  };

  // Breakdown / Accident flags  { vehicleId: { type, note, reportedAt, vehicleNum, driver, loadId, lid } }
  // Incidents are an attribute of the VEHICLE. loadId/lid in the payload are
  // a record of which load the vehicle was on at the time of the incident.
  const [vehicleIncidents, setVehicleIncidents] = useSyncedSetting("tms.vehicleIncidents", {});
  // Movement-page per-vehicle dwell comments — keyed by vehicle id: { note, at }.
  const [dwellComments, setDwellComments] = useSyncedSetting("tms.dwellComments", {});
  const [maintLogs, setMaintLogs] = useSyncedSetting("tms.maintLogs", []); // archive of closed breakdowns
  const [manageVid, setManageVid] = useState(null); // vehicleId of incident being managed
  const [viewLogId, setViewLogId] = useState(null); // id of archived maint log being viewed
  const [incidentModal, setIncidentModal] = useState(null); // loadId (trigger comes from a load row)
  const [incidentForm, setIncidentForm] = useState({ type:"BREAKDOWN", note:"" });
  // Without Driver — per-vehicle flag with expected driver-arrival ETA.
  // Stored directly on the vehicle (`withoutDriver`, `withoutDriverEta`).
  const [wdModalVid, setWdModalVid] = useState(null); // vehicle id whose modal is open
  const [wdEtaInput, setWdEtaInput] = useState(""); // datetime-local string
  const openWithoutDriverModal = (v) => {
    setWdModalVid(v.id);
    if (v.withoutDriverEta) {
      // Convert ISO → datetime-local "YYYY-MM-DDTHH:mm"
      const d = new Date(v.withoutDriverEta);
      const pad = (n) => String(n).padStart(2, "0");
      setWdEtaInput(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    } else {
      const d = new Date(Date.now() + 2*3600*1000);
      const pad = (n) => String(n).padStart(2, "0");
      setWdEtaInput(`${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`);
    }
  };
  const saveWithoutDriver = () => {
    if (!wdEtaInput) { alert("Please pick a driver ETA."); return; }
    const iso = new Date(wdEtaInput).toISOString();
    const v = vehicleById.get(String(wdModalVid));
    pushVehicles(p => p.map(x => x.id===wdModalVid ? {...x, withoutDriver: true, withoutDriverEta: iso} : x));
    addLLog(` ${v?.vnum||""} marked without driver — ETA ${new Date(iso).toLocaleString("en-IN")}`, "#d97706");
    setWdModalVid(null); setWdEtaInput("");
  };
  const clearWithoutDriver = (vid) => {
    const v = vehicleById.get(String(vid));
    pushVehicles(p => p.map(x => x.id===vid ? {...x, withoutDriver: false, withoutDriverEta: null} : x));
    addLLog(`✓ ${v?.vnum||""} driver assigned — without-driver cleared`, "#16a34a");
    setWdModalVid(null); setWdEtaInput("");
  };
  const markIncident = () => {
    if (!incidentForm.note.trim()) { alert("Please describe the incident."); return; }
    // Trigger forms: a loadId string (Load Board rows) OR { vehicleId } (Movement page
    // — lets an incident be reported on a vehicle with NO load attached).
    let l = null, av = null;
    if (incidentModal && typeof incidentModal === "object" && incidentModal.vehicleId) {
      av = vehicleById.get(String(incidentModal.vehicleId)) ?? null;
      if (!av) { alert("Vehicle not found."); return; }
      l = av.loadId ? (loadById.get(String(av.loadId)) ?? null) : null;
    } else {
      l = loadById.get(String(incidentModal)) ?? null;
      if (!l?.vehicleId) { alert("Assign a vehicle to this load before reporting an incident."); return; }
      av = vehicleById.get(String(l.vehicleId)) ?? null;
    }
    const vid = av?.id || l?.vehicleId;
    setVehicleIncidents(p => ({ ...p, [vid]: { ...incidentForm, reportedAt: new Date().toLocaleString("en-IN"), vehicleNum: av?.vnum||"—", driver: av?.driver||"—", loadId: l?.id ?? null, lid: l?.lid ?? null } }));
    addLLog(`${incidentForm.type==="BREAKDOWN"?" Breakdown":"🚑 Accident"} reported on ${av?.vnum||"—"} ${l ? `(was on ${l.lid})` : "(no load attached)"}`, incidentForm.type==="BREAKDOWN"?"#d97706":"#dc2626");
    setIncidentModal(null);
    setIncidentForm({ type:"BREAKDOWN", note:"" });
  };
  const clearIncident = (vehicleId) => {
    setVehicleIncidents(p => { const n={...p}; delete n[vehicleId]; return n; });
    addLLog(`Incident cleared for vehicle`, "#16a34a");
  };
  const archiveMaintLog = (vehicleId, finalMaint) => {
    const inc = vehicleIncidents[vehicleId];
    if (!inc) return;
    const l = inc.loadId ? loads.find(x => x.id === inc.loadId) : null;
    const entry = {
      id: `ml_${Date.now()}_${Math.floor(Math.random()*1000)}`,
      loadId: inc.loadId || null,
      lid: inc.lid || l?.lid || "—",
      vehicleId,
      vehicleNum: inc.vehicleNum || "—",
      driver: inc.driver || "—",
      customer: l?.customer || "",
      origin: l?.origin || "",
      dest: l?.dest || "",
      incident: { type: inc.type, note: inc.note, reportedAt: inc.reportedAt },
      maint: finalMaint,
      archivedAt: new Date().toISOString(),
    };
    setMaintLogs(p => [entry, ...(p||[])]);
    addLLog(` Maint log archived for ${inc.vehicleNum||"vehicle"}`, "#2563eb");
  };
  const deleteMaintLog = (id) => {
    setMaintLogs(p => (p||[]).filter(x => x.id !== id));
  };
  const [changeRequests, setChangeRequests] = useSyncedSetting("tms.changeRequests", []); // approval requests
  const [lockModalLid, setLockModalLid] = useState(null); // show lock confirm
  const [changeReqModal, setChangeReqModal] = useState(null); // { loadId }
  const [changeReqForm, setChangeReqForm] = useState({ managerName:"", managerMobile:"", reason:"" });
  const blankCRForm = () => ({ managerName:"", managerMobile:"", reason:"" });
  let _crId = 10;

  // ─── Logs ───
  const addLog = (msg, color="#16a34a") => {
    const t = new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"});
    setLogs(p => [{ msg, color, t }, ...p].slice(0,14));
  };
  const addLLog = (msg, color="#2563eb") => {
    const t = new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"});
    setLoadLogs(p => [{ msg, color, t }, ...p].slice(0,14));
  };

  // ─── O(1) lookup Maps — rebuilt only when vehicles/loads change ───
  const vehicleById = useMemo(() => new Map(vehicles.map(v => [String(v.id), v])), [vehicles]);
  const loadById = useMemo(() => new Map(loads.map(l => [String(l.id), l])), [loads]);

  // ─── Stats ───
  const stats = useMemo(() => ({
    available: vehicles.filter(v=>v.vstatus==="AVAILABLE").length,
    inTransit: vehicles.filter(v=>v.vstatus==="IN_TRANSIT").length,
    maintenance: vehicles.filter(v=>v.vstatus==="MAINTENANCE").length,
    pendingLoads: loads.filter(l=>l.lstatus==="PENDING"||l.lstatus==="LATE").length,
  }), [vehicles, loads]);

  // Map of vehicleId -> "BREAKDOWN" | "ACCIDENT" for any vehicle with an
  // active incident. Drives the red badge under the vehicle status pill
  // (vehicles list + loads table). Incidents follow the vehicle, not the load.
  const vehicleIncident = useMemo(() => {
    const m = {};
    for (const [vid, inc] of Object.entries(vehicleIncidents || {})) {
      m[vid] = inc?.type || "BREAKDOWN";
    }
    return m;
  }, [vehicleIncidents]);

  // ─── VEHICLE CRUD ───
  const saveVehicle = () => {
    if (!vForm.vnum.trim() || !vForm.driver.trim()) { alert("Vehicle Number and Driver are required."); return; }
    if (vEdit) {
      pushVehicles(p => p.map(v => v.id===vForm.id ? {...vForm, vnum:vForm.vnum.toUpperCase(), loadId:v.loadId} : v));
      addLog(`Updated ${vForm.vnum.toUpperCase()}`,"#d97706");
    } else {
      const nv = { ...vForm, id:uid("v"), vnum:vForm.vnum.toUpperCase(), vstatus:"AVAILABLE", loadId:null, availableAfterDelivery:false };
      pushVehicles(p => [...p, nv]);
      addLog(`Added ${nv.vnum} (${nv.vtype}) — ${nv.driver}`,"#16a34a");
    }
    setVForm(blankV()); setVEdit(false);
  };
  const editV = (v) => { setVForm(v); setVEdit(true); setMobileSideOpen(true); };
  const deleteV = async () => {
    const v = vehicles.find(x=>x.id===delV);
    // Canonical lane: unlink active + queued loads via the sanctioned RPC FIRST.
    // Only delete the vehicle if that succeeds (fail-closed); otherwise surface + abort.
    // (The flag-off legacy branch was retired after soak — lane is always used.)
    const res = await gwUnassignForVehicleDelete(delV);
    if (!res || !res.ok) {
      addLog(`Could not remove ${v?.vnum||"vehicle"}: ${res?.reason || "unlink failed"} — vehicle kept`, "#dc2626");
      return; // do NOT delete; vehicle kept on unlink failure
    }
    // Optimistic local mirror of the server reset (RPC already wrote authoritatively).
    const affected = new Set(res.affected_load_ids || []);
    if (affected.size) {
      pushLoads(p => p.map(l => affected.has(l.id)
        ? { ...l, vehicleId:null, queuedVehicleId:null, queuedBehindLoadId:null, queuedAt:null, lstatus:"PENDING", manualUnloadOverride:false }
        : l), { localOnly: true });
    }
    // Vehicle deletion stays on the existing path (pushVehicles diff → directDelete).
    pushVehicles(p => p.filter(x=>x.id!==delV));
    addLog(`Removed ${v?.vnum||"vehicle"}`,"#dc2626");
    setDelV(null);
  };
  const applyVStatus = (id, vstatus, eta="", explicitLoadId=null) => {
    const v = vehicles.find(x=>x.id===id);
    const isDeliveredPath = vstatus === "DELIVERED" || vstatus === "EMPTY";
    // Resolve the target load up front so both writes use the same id and
    // we can collapse the delivered path into a single vehicle write.
    const targetLoadId = isDeliveredPath
      ? (explicitLoadId
          || v?.loadId
          || loads.find(l => l.vehicleId === id && l.lstatus !== "DELIVERED")?.id
          || null)
      : null;
    // When two loads share the same vehicle, delivering ONE must not free the
    // vehicle or strip the other load's link. Only flip vehicle → AVAILABLE
    // when no other active load remains on this vehicle.
    const remainingActive = isDeliveredPath
      ? loads.filter(l => l.vehicleId === id && l.id !== targetLoadId && l.lstatus !== "DELIVERED")
      : [];
    const hasOtherActive = remainingActive.length > 0;

    // Engine routing: when on, non-delivery transitions go through the server
    // state machine (atomic vehicle+load write). Local updates below become
    // optimistic-only (localOnly) and the engine does the authoritative write.
    const useEngine = transitionEngineEnabled() && !isDeliveredPath && ENGINE_ACTIONS.has(vstatus);

    pushVehicles(p => p.map(x => {
      if (x.id !== id) return x;
      const nowIso = new Date().toISOString();
      if (isDeliveredPath) {
        if (hasOtherActive) {
          // Keep vehicle on trip; only re-point loadId if it was the delivered one.
          const nextLoadId = (x.loadId && String(x.loadId) === String(targetLoadId))
            ? remainingActive[0].id
            : x.loadId;
          return { ...x, loadId: nextLoadId };
        }
        // Skip the transient DELIVERED state — auto-flip straight to AVAILABLE
        // and drop the load link in the same write. Mark this AVAILABLE as
        // delivery-origin so Status Delay → Waiting For Load picks it up.
        return { ...x, vstatus: "AVAILABLE", loadId: null, availableSince: nowIso, availableAfterDelivery: true, sentForLoadingAt: null, atLoadingAt: null, waitingClearEta: null, sentLoadingClearEta: null, atLoadingClearEta: null };
      }
      const extra = {};
      if (vstatus === "IN_TRANSIT" && eta) extra.eta = eta;
      if (vstatus === "AT_UNLOADING" && x.vstatus !== "AT_UNLOADING") {
        const t = new Date(Date.now() + 5.5*60*60*1000); // IST = UTC+5:30, no travel buffer (manual set)
        extra.atUnloadingAt = t.toISOString().slice(0,16);
      }
      // Status-delay timestamps + manual "expected to clear" ETAs:
      // stamp/preserve on entry, clear on exit.
      if (vstatus === "SENT_FOR_LOADING") { extra.sentForLoadingAt = x.sentForLoadingAt || nowIso; extra.sentLoadingClearEta = eta || x.sentLoadingClearEta || null; }
      else { extra.sentForLoadingAt = null; extra.sentLoadingClearEta = null; }
      if (vstatus === "AT_LOADING") { extra.atLoadingAt = x.atLoadingAt || nowIso; extra.atLoadingClearEta = eta || x.atLoadingClearEta || null; }
      else { extra.atLoadingAt = null; extra.atLoadingClearEta = null; }

      if (vstatus === "AVAILABLE") {
        extra.availableSince = x.availableSince || nowIso;
        extra.waitingClearEta = x.waitingClearEta || null;
        // Manual AVAILABLE — do NOT set availableAfterDelivery:true so the
        // QUEUED auto-promote effect does not fire. The vehicle was freed
        // manually, not via delivery — queued loads should stay queued.
        // Keep loadId / queued links intact: active load stays attached
        // (reconcile loop will demote IN_TRANSIT → ASSIGNED), and any
        // QUEUED load also stays attached to this vehicle.
        extra.availableAfterDelivery = false;
      }
      else { extra.waitingClearEta = null; extra.availableSince = null; extra.availableAfterDelivery = false; }

      return { ...x, vstatus, ...extra };
    }), { localOnly: useEngine || (isDeliveredPath && deliveryUseEngine) });
    // Sync linked load ETA and status
    if (vstatus === "IN_TRANSIT") {
      if (v?.loadId) {
        pushLoads(p => p.map(l => l.id===v.loadId ? {...l, lstatus:"IN_TRANSIT", ...(eta ? {delivery:eta} : {})} : l), { localOnly: useEngine });
        addLLog(`Load → In Transit${eta?" · ETA "+fmtDT(eta):""} (${v?.vnum})`,"#6366f1");
      }
    } else if (vstatus === "SENT_FOR_LOADING" && eta) {
      // SFL doesn't change load status, but still propagate ETA if provided
      if (v?.loadId) {
        pushLoads(p => p.map(l => l.id===v.loadId ? {...l, delivery:eta} : l), { localOnly: useEngine });
      }
    } else if (vstatus === "AT_UNLOADING") {
      if (v?.loadId) {
        pushLoads(p => p.map(l => l.id===v.loadId && l.lstatus!=="DELIVERED" ? {...l, lstatus:"AT_UNLOADING", manualUnloadOverride: true} : l), { localOnly: useEngine });
        addLLog(`${v?.vnum} at unloading (manual) — auto rule paused for this load`,"#d97706");
      }
    } else if (isDeliveredPath) { // Manual Available: only vehicle is updated — load lifecycle is separate
      if (targetLoadId) {
        pushLoads(p => p.map(l => l.id===targetLoadId ? {...l, lstatus:"DELIVERED", vehicleId:null, deliveredAt: l.deliveredAt || new Date().toISOString(), consigneeDeliveries: buildFullyDeliveredCD(l), vnumSnapshot: l.vnumSnapshot || v?.vnum, driverSnapshot: l.driverSnapshot || v?.driver, mobileSnapshot: l.mobileSnapshot || v?.mobile} : l), { localOnly: deliveryUseEngine });
        if (deliveryUseEngine) gwDeliver(targetLoadId, { finalizeConsignees: true });
        addLLog(hasOtherActive
          ? `Load → Delivered · ${v?.vnum} still on trip (${remainingActive.length} load${remainingActive.length>1?"s":""} remaining)`
          : `Load → Delivered · ${v?.vnum} now Available`, "#16a34a");
      }
    }
    addLog(`${v?.vnum} → ${isDeliveredPath ? (hasOtherActive ? "Load Delivered" : VS_LABELS.AVAILABLE) : VS_LABELS[vstatus]}${eta?" · ETA "+fmtDT(eta):""}`, "#2563eb");

    // Authoritative atomic server write via the transition engine. The local
    // updates above were optimistic-only (localOnly); the engine now writes
    // vehicle+load together. If it refuses (e.g. blocked), refresh from cloud so
    // the UI snaps back to server truth.
    if (useEngine) {
      transitionVehicle(id, vstatus, { eta: eta || null, loadId: explicitLoadId || v?.loadId || null })
        .then((res) => {
          if (res && res.ok === false) {
            if (res.reason === "blocked") {
              alert(`Status change refused — vehicle has an active load in progress${res.blocking_lid ? ` (${res.blocking_lid})` : ""}.`);
            }
            refreshFromCloud();
          }
        })
        .catch(() => refreshFromCloud());
    }
  };

  const quickVS = (id, vstatus, explicitLoadId=null) => {
    if (!vstatus) return;
    // Block manual vstatus changes if another load on this vehicle is actively
    // in progress (IN_TRANSIT, AT_UNLOADING, ASSIGNED). QUEUED is allowed since
    // the vehicle hasn't physically started that trip yet. MAINTENANCE always allowed.
    if (vstatus !== "MAINTENANCE") {
      const v = vehicles.find(x => x.id === id);
      const currentLoadId = explicitLoadId || v?.loadId || null;
      // A load blocks status change only if it is physically in progress on this
      // vehicle. QUEUED loads are excluded — the vehicle has not yet started that
      // trip. We identify the "current" load as any load that shares vehicleId with
      // this vehicle and is not QUEUED, so even if v.loadId is stale/null we find it.
      const currentLoad = loads.find(l =>
        l.vehicleId === id &&
        !["DELIVERED","CANCELLED","QUEUED"].includes(l.lstatus)
      );
      const resolvedCurrentId = explicitLoadId || currentLoad?.id || currentLoadId;
      const blockingLoad = loads.find(l =>
        l.vehicleId === id &&
        l.id !== resolvedCurrentId &&
        ["IN_TRANSIT","AT_UNLOADING","ASSIGNED"].includes(l.lstatus)
      );
      // DELIVERED is never a side-grade — applyVStatus handles the multi-active
      // case (delivers the selected load and keeps the vehicle on trip if any
      // other active load remains). The guard only applies to non-delivery
      // transitions like AVAILABLE / AT_LOADING / SENT_FOR_LOADING / MAINTENANCE.
      if (blockingLoad && vstatus !== "DELIVERED") {
        alert(`Cannot change status — vehicle has an active load in progress (${blockingLoad.lid || blockingLoad.id}, ${blockingLoad.lstatus}). Deliver that load first.`);
        return;
      }
    }
    if (vstatus === "IN_TRANSIT") {
      const today = new Date().toISOString().slice(0,10);
      setLrModal({ vehicleId: id });
      setLrDateInput(today);
      return;
    }
    if (vstatus === "SENT_FOR_LOADING" || vstatus === "AT_LOADING" || vstatus === "DELIVERED") {
      setSflModal({ vehicleId: id, pendingStatus: vstatus, loadId: explicitLoadId || null });
      setSflEta("");
      return;
    }
    applyVStatus(id, vstatus);
  };

  const confirmLR = () => {
    if (!lrDateInput) { alert("Please select an LR Date."); return; }
    const id = lrModal.vehicleId;
    const v = vehicles.find(x => x.id === id);
    const useEngine = transitionEngineEnabled();
    pushVehicles(p => p.map(x => x.id === id ? { ...x, vstatus: "IN_TRANSIT", lrDate: lrDateInput } : x), { localOnly: useEngine });
    if (v?.loadId) {
      pushLoads(p => p.map(l => l.id === v.loadId ? { ...l, lstatus: "IN_TRANSIT", lrDate: lrDateInput } : l), { localOnly: useEngine });
      addLLog(`Load → On Trip · LR ${lrDateInput} (${v.vnum})`, "#6366f1");
    }
    addLog(`${v?.vnum} → On Trip · LR ${lrDateInput}`, "#2563eb");
    if (useEngine) {
      transitionVehicle(id, "IN_TRANSIT", { loadId: v?.loadId || null, lrDate: lrDateInput })
        .then((res) => { if (res && res.ok === false) refreshFromCloud(); })
        .catch(() => refreshFromCloud());
    }
    setLrModal(null); setLrDateInput("");
  };

  // ─── LOAD CRUD ───
  const newLoadDraft = () => ({ ...blankL(), lid: nextLoadId(loads), pickup: todayLocal() });
  // Load branch resolver: special-case Gurgaon/Kharkhoda/Manesar by ORIGIN city,
  // otherwise use load.branch field (matches origin branch from Add Load).
  const ORIGIN_CITY_BRANCHES = ["Gurgaon","Kharkhoda","Manesar"];
  const resolveLoadBranch = (l) => {
    const o = (l?.origin||"").toLowerCase();
    for (const cb of ORIGIN_CITY_BRANCHES) {
      if (o.includes(cb.toLowerCase())) return cb;
    }
    return l?.branch || "Unassigned";
  };
  // Allocate `count` LD numbers from the DB sequence (collision-proof). Falls
  // back to client-side sequential generation if the server is unreachable, so
  // creating a load never blocks.
  const allocLids = async (count) => {
    try {
      const arr = await nextLids(count);
      if (Array.isArray(arr) && arr.length === count && arr.every(Boolean)) {
        return arr.map(x => String(x).toUpperCase());
      }
    } catch { /* fall through to client generation */ }
    const out = []; let acc = [...loads];
    for (let i = 0; i < count; i++) { const id = nextLoadId(acc); out.push(id); acc = [...acc, { lid: id }]; }
    return out;
  };
  const saveLoad = async () => {
    const multiLoadsOn = !lEdit && lExtra.multiLoads;
    const missing = [];
    if (!lForm.branch?.trim()) missing.push("Branch");
    if (!lForm.customer?.trim()) missing.push("Customer");
    if (!lForm.origin?.trim()) missing.push("From City");
    if (!multiLoadsOn && !lForm.dest?.trim()) missing.push("To City");
    if (!lForm.pickup?.trim()) missing.push("Pickup Date");
    if (!lForm.vtypeReq?.trim()) missing.push("Vehicle Type Required");
    if (missing.length) { alert("Required: " + missing.join(", ")); return; }
    const pickup = lForm.pickup || todayLocal();
    if (lEdit) {
      const lid = (lForm.lid || nextLoadId(loads)).toUpperCase();
      const prev = loadById.get(String(lForm.id)) ?? null;
      const editCons = lExtra.multi ? lExtra.consignees.map(c=>(c||"").trim()).filter(Boolean) : [];
      pushLoads(p => p.map(l => {
        if (l.id !== lForm.id) return l;
        const prevCD = Array.isArray(l.consigneeDeliveries) ? l.consigneeDeliveries : [];
        // Preserve cids ONLY if this load is already cid-based (a new load). Old loads have
        // no consigneeCids and must stay that way (owner decision: leave old loads untouched).
        // NOTE: cids are preserved positionally here; reorder-safe editing needs the consignee
        // editor to track cid per row (follow-up). Editing non-consignee fields is safe.
        const prevCids = Array.isArray(l.consigneeCids) ? l.consigneeCids : null;
        const editCids = prevCids ? editCons.map((c,i)=> prevCids[i] || newConsigneeCid()) : null;
        const editCD = editCons.map((city, i) => {
          const cid = editCids ? editCids[i] : null;
          // Match the prior delivery entry by stable cid (new loads) so a same-name consignee
          // never inherits another stop's delivered state (kills the brief delivered-flash and
          // preserves state across in-place city renames). Old loads (no cid) match by city as before.
          const m = cid ? prevCD.find(x => x.cid === cid) : prevCD.find(x => (x.city||"") === city);
          const base = m ? { ...m, city } : { city, delivered:false, podPath:null, deliveredAt:null };
          return cid ? { ...base, cid } : base;
        });
        const destChanged = (l.dest || "") !== (lForm.dest || "");
        const cidPatch = editCids ? { consigneeCids: editCids } : {};
        // F2 clobber fix: build from the LIVE row (l), then apply ONLY the fields
        // the dispatcher actually changed relative to the editor-open baseline.
        // A stale draft can no longer revert a colleague's concurrent edit to a
        // different field. No baseline (shouldn't happen) → legacy full-form save.
        const base = lFormBaseRef.current;
        let formChanges = lForm;
        if (base && String(base.id) === String(lForm.id)) {
          formChanges = {};
          for (const k of Object.keys(lForm)) {
            let same = base[k] === lForm[k];
            if (!same) { try { same = JSON.stringify(base[k]) === JSON.stringify(lForm[k]); } catch {} }
            if (!same) formChanges[k] = lForm[k];
          }
        }
        // Consignee set: only apply the editor's consignee machinery if the user
        // actually changed the stops relative to the baseline.
        const baseCons = Array.isArray(base?.consignees) ? base.consignees.filter(Boolean) : [];
        const consChanged = JSON.stringify(baseCons) !== JSON.stringify(editCons);
        const consigneeFields = consChanged
          ? { consignees: editCons, ...cidPatch, consigneeDeliveries: editCD }
          : {};
        // D-2c: stop-set changes ALSO go through the guarded lane (rows are the
        // truth; server preserves delivery state cid/city-matched, assigns cids
        // to new stops, audits SET_STOPS). The local fields above stay for
        // instant UI; the object-lane patch may redundantly carry consignees
        // (identical values, benign) while consigneeDeliveries is wall-stripped
        // there anyway — the RPC write below is the authoritative one.
        if (consChanged && STOPS_EDITOR_RPC) {
          const stopsPayload = editCons.map((cty, ii) => ({ city: cty, cid: editCids ? (editCids[ii] || null) : null }));
          setLoadStopsRpc(lForm.id, stopsPayload).then((res) => {
            if (res && res.ok === false && !res.queued) {
              console.warn("[stops] set_stops refused:", res.reason);
              addLLog(`Stop edit refused (${res.reason || "error"}) — board will re-sync`, "#dc2626");
            }
          }).catch(() => {});
        }
        const pickupChanged = !base || (base.pickup || "") !== (pickup || "");
        return {
          ...l,
          ...formChanges,
          ...(pickupChanged ? { pickup } : {}),
          lid,
          lstatus: l.lstatus, vehicleId: l.vehicleId,
          ...consigneeFields,
          manualUnloadOverride: destChanged ? false : l.manualUnloadOverride,
        };
      }));
      // If destination city changed and a vehicle is assigned, sync vehicle.destination
      // and revert AT_UNLOADING back to IN_TRANSIT so the auto-unload rule re-evaluates
      // against the new destination branch.
      if (prev && prev.vehicleId && (prev.dest || "") !== (lForm.dest || "")) {
        pushVehicles(p => p.map(x => {
          if (x.id !== prev.vehicleId) return x;
          const nextStatus = x.vstatus === "AT_UNLOADING" ? "IN_TRANSIT" : x.vstatus;
          return { ...x, destination: lForm.dest || x.destination, vstatus: nextStatus };
        }));
      }
      addLLog(`Updated load ${lid}`,"#d97706");
    } else if (multiLoadsOn) {
      // Multiple Loads: expand rows × qty into unique loads. Duplicate & Multi-Consignee ignored.
      const rows = (lExtra.multiLoadsRows||[]).map(r=>({ qty: Math.max(1, Math.min(50, Number(r.qty)||1)), dest:(r.dest||"").trim(), destCoords: r.destCoords || null })).filter(r=>r.dest);
      if (!rows.length) { alert("Add at least one destination city."); return; }
      const expanded = [];
      for (const r of rows) for (let k=0;k<r.qty;k++) expanded.push({ dest: r.dest, destCoords: r.destCoords });
      if (expanded.length > 50) { alert(`Total loads (${expanded.length}) exceeds cap of 50.`); return; }
      const lids = await allocLids(expanded.length);
      const newOnes = [];
      for (let i=0;i<expanded.length;i++) {
        newOnes.push({ ...lForm, id:ulid(), lid:lids[i], dest:expanded[i].dest, destCoords:expanded[i].destCoords, pickup, lstatus:"PENDING", vehicleId:null, consignees:[], consigneeDeliveries:[] });
      }

      pushLoads(p => [...p, ...newOnes]);
      const summary = rows.map(r=>`${r.dest}×${r.qty}`).join(", ");
      addLLog(`New loads ×${newOnes.length} — ${lForm.origin} → ${summary}`,"#2563eb");
    } else {
      const consignees = lExtra.multi
        ? lExtra.consignees.map(c=>(c||"").trim()).filter(Boolean)
        : [];
      // Stage 1 (consignee identity, sidecar cid — NEW loads only): give each consignee a
      // stable id, carried in a parallel consigneeCids array + on each delivery entry. Old
      // loads have neither and keep index-based behavior. cid generation never throws.
      const consigneeCids = consignees.map(()=> newConsigneeCid());
      const consigneeDeliveries = consignees.map((c,i)=>({ cid: consigneeCids[i], city:c, delivered:false, podPath:null, deliveredAt:null }));
      const dupN = lExtra.duplicate ? Math.max(1, Math.min(50, Number(lExtra.dupCount)||1)) : 1;
      const lids = await allocLids(dupN);
      const newOnes = [];
      for (let i=0;i<dupN;i++) {
        // Each duplicate is an independent load, so it gets its OWN fresh cids (never shared).
        const cids = consignees.map(()=> newConsigneeCid());
        const cds  = consignees.map((c,k)=>({ cid: cids[k], city:c, delivered:false, podPath:null, deliveredAt:null }));
        newOnes.push({ ...lForm, id:ulid(), lid:lids[i], pickup, lstatus:"PENDING", vehicleId:null, consignees, consigneeCids: cids, consigneeDeliveries: cds });
      }
      pushLoads(p => [...p, ...newOnes]);
      const cBadge = consignees.length ? ` · C-${consignees.length}` : "";
      const dBadge = dupN>1 ? ` ×${dupN}` : "";
      addLLog(`New load${dBadge} ${newOnes[0].lid}: ${lForm.origin} → ${lForm.dest}${cBadge}`,"#2563eb");
    }
    setLForm(blankL()); setLEdit(false);
    setLExtra({ duplicate:false, dupCount:2, multi:false, multiCount:2, consignees:[""], multiLoads:false, multiLoadsCount:2, multiLoadsRows:[{qty:1,dest:""},{qty:1,dest:""}] });
  };
  const lFormBaseRef = useRef(null);
  const editL = (l) => {
    // F2 clobber fix: remember the row EXACTLY as the dispatcher saw it when the
    // editor opened. On save, only fields the user actually changed (vs this
    // baseline) are applied over the LIVE row — so a colleague's concurrent edit
    // to a different field survives instead of being reverted by this stale draft.
    lFormBaseRef.current = l;
    setLForm(l);
    setLEdit(true);
    const cons = Array.isArray(l.consignees) ? l.consignees.filter(Boolean) : [];
    setLExtra({ duplicate:false, dupCount:2, multi: cons.length>0, multiCount: Math.max(1, cons.length||1), consignees: cons.length ? [...cons] : [""], multiLoads:false, multiLoadsCount:2, multiLoadsRows:[{qty:1,dest:""},{qty:1,dest:""}] });
    setMobileSideOpen(true);
  };
  const deleteL = () => {
    const l = loadById.get(String(delL)) ?? null;
    if (l?.vehicleId) {
      const otherActive     = loads.filter(x => x.id !== delL && x.vehicleId === l.vehicleId && !["DELIVERED","CANCELLED"].includes(x.lstatus));
      const otherInProgress = otherActive.filter(x => ["IN_TRANSIT","AT_UNLOADING","ASSIGNED"].includes(x.lstatus));
      const otherQueued     = !otherInProgress.length ? otherActive.filter(x => x.lstatus === "QUEUED") : [];
      pushVehicles(p => p.map(v => {
        if (v.id !== l.vehicleId) return v;
        if (otherInProgress.length > 0) return { ...v, loadId: otherInProgress[0].id };
        if (otherQueued.length > 0) return { ...v, vstatus:"AVAILABLE", loadId: otherQueued[0].id, availableSince: new Date().toISOString(), availableAfterDelivery:true, sentForLoadingAt:null, atLoadingAt:null, waitingClearEta:null, sentLoadingClearEta:null, atLoadingClearEta:null };
        return { ...v, vstatus:"AVAILABLE", loadId:null, availableSince: new Date().toISOString(), availableAfterDelivery:true, sentForLoadingAt:null, atLoadingAt:null, waitingClearEta:null, sentLoadingClearEta:null, atLoadingClearEta:null };
      }));
      if (otherQueued.length > 0) {
        pushLoads(p => p.map(x => x.id === otherQueued[0].id ? { ...x, lstatus: "ASSIGNED" } : x), { localOnly: assignUseEngine });
        if (assignUseEngine) gwPromote(otherQueued[0].id, { departure: otherQueued[0].origin || null, destination: otherQueued[0].dest || null });
        addLLog(`Load ${otherQueued[0].lid || otherQueued[0].id} auto-promoted Queued → Assigned`, "#d97706");
      }
    }
    pushLoads(p => p.filter(x=>x.id!==delL));
    addLLog(`Deleted load ${l?.lid||""}`,"#dc2626");
    setDelL(null);
  };
  // Build a consigneeDeliveries array that marks every intermediate consignee AND
  // the final dest city as delivered. Preserves any existing podPath / earlier
  // deliveredAt. Case-insensitive de-dup so dest isn't doubled if also typed as consignee.
  const buildFullyDeliveredCD = (l) => {
    const nowIso = new Date().toISOString();
    const prev = Array.isArray(l?.consigneeDeliveries) ? l.consigneeDeliveries : [];
    const cons = Array.isArray(l?.consignees) ? l.consignees.map(c => (c||"").trim()).filter(Boolean) : [];
    const finalDest = (l?.dest || "").trim();
    // Index-based: duplicate city names are treated as distinct drops.
    const out = cons.map((city, i) => {
      const existing = prev[i] || {};
      return {
        podPath: null,
        ...existing,
        city,
        delivered: true,
        deliveredAt: existing.deliveredAt || nowIso,
      };
    });
    // Append final dest only if not already listed as a consignee (case-insensitive).
    if (finalDest && !cons.some(c => c.toLowerCase() === finalDest.toLowerCase())) {
      const existing = prev[cons.length] || {};
      out.push({
        podPath: null,
        ...existing,
        city: finalDest,
        delivered: true,
        deliveredAt: existing.deliveredAt || nowIso,
      });
    }
    return out;
  };

  const quickLS = (id, lstatus) => {
    const l = loadById.get(String(id)) ?? null;
    const stamp = lstatus === "DELIVERED" ? { deliveredAt: l?.deliveredAt || new Date().toISOString() } : {};
    const cdPatch = lstatus === "DELIVERED" && l ? { consigneeDeliveries: buildFullyDeliveredCD(l) } : {};
    if (lstatus==="DELIVERED" && l?.vehicleId) {
      const lv = vehicles.find(v => v.id === l.vehicleId);
      // Only free the vehicle if no other active load remains on it.
      // If another load is still active, re-point vehicle.loadId to that load
      // and leave vstatus unchanged — vehicle is still on trip.
      // Split other active loads into truly-in-progress vs queued-only.
      // QUEUED = confirmed next load but vehicle not yet physically on that trip.
      // IN_TRANSIT / AT_UNLOADING / ASSIGNED = vehicle physically committed.
      const otherActive = loads.filter(x => x.vehicleId === l.vehicleId && x.id !== id && !["DELIVERED","CANCELLED"].includes(x.lstatus));
      const otherInProgress = otherActive.filter(x => ["IN_TRANSIT","AT_UNLOADING","ASSIGNED"].includes(x.lstatus));
      const otherQueued    = otherActive.filter(x => x.lstatus === "QUEUED");
      const hasInProgress  = otherInProgress.length > 0;
      const hasQueued      = !hasInProgress && otherQueued.length > 0;

      pushVehicles(p => p.map(v => {
        if (v.id !== l.vehicleId) return v;
        if (hasInProgress) {
          // Vehicle still physically on another load — re-point loadId, leave vstatus unchanged.
          return { ...v, loadId: otherInProgress[0].id };
        }
        if (hasQueued) {
          // Other load is only QUEUED (confirmed but not yet dispatched) —
          // vehicle is free, flip to AVAILABLE. QUEUED load auto-promotes to ASSIGNED below.
          return { ...v, vstatus:"AVAILABLE", loadId: otherQueued[0].id, availableSince: new Date().toISOString(), availableAfterDelivery: true, sentForLoadingAt:null, atLoadingAt:null, waitingClearEta:null, sentLoadingClearEta:null, atLoadingClearEta:null };
        }
        // No other active loads — fully free the vehicle.
        return { ...v, vstatus:"AVAILABLE", loadId:null, availableSince: new Date().toISOString(), availableAfterDelivery: true, sentForLoadingAt:null, atLoadingAt:null, waitingClearEta:null, sentLoadingClearEta:null, atLoadingClearEta:null };
      }), { localOnly: deliveryUseEngine });
      // Auto-promote QUEUED load → ASSIGNED now that the blocking load is delivered.
      if (hasQueued) {
        pushLoads(p => p.map(x => x.id === otherQueued[0].id ? { ...x, lstatus: "ASSIGNED" } : x), { localOnly: assignUseEngine });
        if (assignUseEngine) gwPromote(otherQueued[0].id, { departure: otherQueued[0].origin || null, destination: otherQueued[0].dest || null });
        addLLog(`Load ${otherQueued[0].lid || otherQueued[0].id} auto-promoted Queued → Assigned`, "#6366f1");
      }
      pushLoads(p => p.map(x => x.id===id ? {...x, lstatus, vehicleId:null, ...stamp, ...cdPatch, vnumSnapshot: x.vnumSnapshot || lv?.vnum, driverSnapshot: x.driverSnapshot || lv?.driver, mobileSnapshot: x.mobileSnapshot || lv?.mobile} : x), { localOnly: deliveryUseEngine });
      if (deliveryUseEngine) gwDeliver(id, { finalizeConsignees: true });
    } else {
      pushLoads(p => p.map(x => x.id===id ? {...x, lstatus, ...stamp, ...cdPatch} : x), { localOnly: deliveryUseEngine && lstatus === "DELIVERED" });
      if (deliveryUseEngine && lstatus === "DELIVERED") gwDeliver(id, { finalizeConsignees: true });
    }
    addLLog(`Load ${l?.lid} → ${LS_LABELS[lstatus]}`,"#6366f1");
  };

  // Open calendar+time modal to capture delivered date for a consignee.
  const openDeliveredDateModal = (loadId, index) => {
    const now = new Date();
    const pad = (n)=>String(n).padStart(2,"0");
    const def = `${now.getFullYear()}-${pad(now.getMonth()+1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`;
    setCdDateTime(def);
    setCdModal({ loadId, index });
  };

  // Convert local "YYYY-MM-DDTHH:mm" to ISO string for storage.
  const dateTimeStrToIso = (s) => {
    if (!s) return null;
    const dt = new Date(s);
    if (isNaN(dt.getTime())) return null;
    return dt.toISOString();
  };

  // Shared by Load Board and TAT Tracker: mark a single consignee delivered/pending.
  // When all consignees on a load become delivered, auto-roll the load to DELIVERED.
  const setConsigneeDelivered = (loadId, index, delivered, deliveredAtIso) => {
    const l = loads.find(x => x.id === loadId);
    if (!l) return;
    const cons = Array.isArray(l.consignees) ? l.consignees.filter(Boolean) : [];
    if (!cons.length || index < 0 || index >= cons.length) return;
    // Compute the next array from the FRESH state inside the updater (not the outer `loads`
    // closure) so rapid consecutive toggles don't clobber each other; stamp manualOverride
    // on the toggled stop so a dispatcher's explicit set survives POD-authoritative recompute.
    pushLoads(p => p.map(x => {
      if (x.id !== loadId) return x;
      const prevDels = Array.isArray(x.consigneeDeliveries) ? x.consigneeDeliveries : [];
      const nextDels = cons.map((city, i) => {
        const existing = prevDels[i] || { city, delivered:false, podPath:null, deliveredAt:null };
        if (i === index) {
          const stamp = delivered ? (deliveredAtIso || existing.deliveredAt || new Date().toISOString()) : null;
          return { ...existing, city, delivered: !!delivered, manualOverride: true, deliveredAt: stamp };
        }
        return { ...existing, city };
      });
      return { ...x, consigneeDeliveries: nextDels };
    }),
    // A dispatcher-picked date (deliveredAtIso) is a CANONICAL mutation and must go through
    // the canonical lane (app_mark_consignee) — the object lane is canonical-blind on
    // consigneeDeliveries/deliveredAt, so it would silently drop the date and snap to now.
    // When a date is supplied we route to gwConsignee even with the engine off, and keep the
    // local push optimistic (localOnly) so the object lane can't clobber the canonical write.
    { localOnly: deliveryUseEngine || !!deliveredAtIso });
    // cid (new loads) resolves the stop by stable id; old loads have no consigneeCids → null → index path.
    const cid = Array.isArray(l.consigneeCids) && l.consigneeCids[index] != null ? l.consigneeCids[index] : null;
    if (deliveryUseEngine || !!deliveredAtIso) gwConsignee(loadId, index, 'dispatcher_manual', null, !!delivered, null, cid, deliveredAtIso ?? null);
    addLLog(`Load ${l.lid} · consignee #${index+1} "${cons[index]}" ${delivered ? "delivered" : "marked pending"}`, delivered ? "#16a34a" : "#6b7280");
  };

  // Toggle POD OK for a single consignee (index-based, independent of duplicates).
  const setConsigneePodOk = (loadId, index, ok) => {
    const l = loads.find(x => x.id === loadId);
    if (!l) return;
    const cons = Array.isArray(l.consignees) ? l.consignees.filter(Boolean) : [];
    if (!cons.length || index < 0 || index >= cons.length) return;
    pushLoads(p => p.map(x => {
      if (x.id !== loadId) return x;
      const prevDels = Array.isArray(x.consigneeDeliveries) ? x.consigneeDeliveries : [];
      const nextDels = cons.map((city, i) => {
        const existing = prevDels[i] || { city, delivered:false, podPath:null, deliveredAt:null };
        if (i === index) return { ...existing, city, podOk: !!ok };
        return { ...existing, city };
      });
      return { ...x, consigneeDeliveries: nextDels };
    }), { localOnly: deliveryUseEngine });
    const cid = Array.isArray(l.consigneeCids) && l.consigneeCids[index] != null ? l.consigneeCids[index] : null;
    if (deliveryUseEngine) gwConsignee(loadId, index, 'dispatcher_pod_ok', null, undefined, !!ok, cid);
    addLLog(`Load ${l.lid} · consignee #${index+1} "${cons[index]}" POD ${ok ? "OK" : "cleared"}`, ok ? "#16a34a" : "#6b7280");
  };

  // Wrapper used by UI buttons: opens calendar modal to pick delivered date.
  const markConsigneeDeliveredWithPrompt = (loadId, index) => {
    openDeliveredDateModal(loadId, index);
  };

  const confirmConsigneeDelivered = () => {
    if (!cdModal) return;
    const iso = dateTimeStrToIso(cdDateTime);
    if (!iso) { alert("Please pick a valid date and time."); return; }
    setConsigneeDelivered(cdModal.loadId, cdModal.index, true, iso);
    setCdModal(null);
    setCdDateTime("");
  };


  const [expandedConsignees, setExpandedConsignees] = useState({}); // { loadId: true } — load board expansion

  // Shared GPS map popup — used by Load Board and Unloading rows.
  const openGpsMap = (vehicle, fallbackLabel, explicitLoadId) => {
    if (!vehicle) return;
    const vk = gpsVehicleKey(vehicle.vnum); const vkAlt = gpsVehicleKeyAlt(vehicle.vnum);
    const gps = gpsMap[vk] || gpsMap[vkAlt];
    if (!gps || gps.lat == null || gps.lng == null) return;
    const lat = Number(gps.lat), lng = Number(gps.lng);
    const title = `${vehicle?.vnum || fallbackLabel || ""} — GPS`;
    const gAddr = gps.address || addrMap[vk];
    const addr = (gAddr || "").replace(/</g,"&lt;");

    // Open window synchronously so popup blockers don't kick in
    const w = window.open("", "gpsMap_"+(vehicle.vnum||fallbackLabel||""), "popup=yes,width=820,height=680");
    if (!w) { alert("Please allow popups to view the map."); return; }

    const writeShell = (loadingTrail) => {
      const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
<style>html,body{margin:0;height:100%;font-family:system-ui,sans-serif;background:#111827;color:#ffffff;overflow:hidden}
.hdr{padding:10px 14px;background:#111827;border-bottom:1px solid #334155;position:relative;height:78px;box-sizing:border-box}
.hdr h1{margin:0 0 2px;font-size:14px;letter-spacing:1px;text-transform:uppercase;color:#2563eb}
.hdr .a{font-size:12px;color:#e4e7ed}
.hdr .c{font-size:11px;color:#6b7280;font-family:ui-monospace,monospace;margin-top:2px}
.hdr .pill{position:absolute;top:10px;right:14px;background:#2563eb;color:#ffffff;font-size:11px;padding:3px 9px;border-radius:999px;font-weight:600}
.hdr .pill.empty{background:#475569}
#map{width:100%;height:calc(100% - 78px);background:#111827}
body.has-ctrl #map{height:calc(100% - 78px - 86px)}
a.btn{display:inline-block;margin-top:0;color:#2563eb;font-size:11px;text-decoration:none}
a.btn:hover{text-decoration:underline}
.legend{position:absolute;bottom:96px;left:10px;background:rgba(15,23,42,.85);color:#ffffff;font-size:11px;padding:6px 10px;border-radius:6px;line-height:1.6;font-family:system-ui,sans-serif;z-index:1000}
.legend .sw{display:inline-block;width:10px;height:10px;border-radius:50%;margin-right:6px;vertical-align:middle}
.ctrl{position:fixed;left:0;right:0;bottom:0;height:86px;background:#111827;border-top:1px solid #334155;padding:10px 16px;box-sizing:border-box;display:none;flex-direction:column;gap:6px;z-index:1100}
body.has-ctrl .ctrl{display:flex}
.ctrl .row{display:flex;align-items:center;gap:10px}
.ctrl button{background:#334155;color:#ffffff;border:1px solid #475569;border-radius:6px;padding:4px 10px;cursor:pointer;font-size:14px;line-height:1;font-weight:700}
.ctrl button:hover{background:#475569}
.ctrl .ts{flex:1;text-align:center;font-size:13px;font-weight:700;color:#f2f4f7;font-variant-numeric:tabular-nums}
.ctrl .ts .spd{color:#6b7280;font-weight:500;margin-left:8px}
.ctrl .cnt{font-size:11px;color:#6b7280;font-variant-numeric:tabular-nums;min-width:60px;text-align:right}
.ctrl input[type=range]{width:100%;accent-color:#2563eb}
</style></head><body>
<div class="hdr"><h1>${title}</h1>
${addr?`<div class="a">${addr}</div>`:""}
<div class="c">${lat.toFixed(5)}, ${lng.toFixed(5)} · <a class="btn" href="https://www.google.com/maps?q=${lat},${lng}" target="_blank" rel="noreferrer">Open in Google Maps</a></div>
<div id="trailPill" class="pill">${loadingTrail ? "Loading trail…" : "No trail yet"}</div>
</div>
<div id="haltsBox" style="position:absolute;top:82px;right:10px;max-width:260px;max-height:40%;overflow-y:auto;background:rgba(15,23,42,.9);color:#e4e7ed;font-size:11px;padding:8px 10px;border-radius:8px;z-index:1200;font-family:system-ui,sans-serif;display:none">
  <div style="font-weight:700;letter-spacing:.5px;text-transform:uppercase;font-size:10px;color:#93c5fd;margin-bottom:6px">Trip stops (2h+)</div>
  <div id="haltsList">Loading stops…</div>
</div>
<div id="map"></div>
<div class="ctrl">
  <div class="row">
    <button id="btnPlay" title="Play / pause">▶</button>
    <button id="btnReset" title="Reset to start">⟲</button>
    <div class="ts"><span id="tsLabel">—</span><span class="spd" id="spdLabel"></span></div>
    <div class="cnt" id="cntLabel">0/0</div>
  </div>
  <input id="slider" type="range" min="0" max="0" value="0" />
</div>
<script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"><\/script>
<script>
window.__INIT__ = function(points) {
  var map = L.map('map').setView([${lat}, ${lng}], 13);
  window.__MAP__ = map;
  L.tileLayer('https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png', {
    maxZoom: 19, subdomains: 'abcd',
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> © <a href="https://carto.com/attributions">CARTO</a>'
  }).addTo(map);
  var current = L.marker([${lat}, ${lng}]).addTo(map).bindPopup('Current position');
  var pill = document.getElementById('trailPill');

  if (!points || points.length === 0) {
    pill.textContent = 'No trail captured yet — snapshots collect hourly';
    pill.className = 'pill empty';
    current.openPopup();
    return;
  }

  // Always draw the full trail faded for context
  var latlngs = points.map(function(p){ return [p.lat, p.lng]; });
  L.polyline(latlngs, { color: '#6b7280', weight: 3, opacity: 0.35 }).addTo(map);

  var start = points[0];
  L.circleMarker([start.lat, start.lng], { radius: 7, color: '#16a34a', fillColor: '#16a34a', fillOpacity: 1, weight: 2 })
    .addTo(map).bindPopup('Trip start (' + new Date(start.ts).toLocaleString() + ')');

  var bounds = L.latLngBounds(latlngs).extend([${lat}, ${lng}]);
  map.fitBounds(bounds, { padding: [40, 40] });

  var legend = L.DomUtil.create('div', 'legend');
  legend.innerHTML = '<div><span class="sw" style="background:#16a34a"></span>Trip start</div>' +
                     '<div><span class="sw" style="background:#2563eb"></span>Trail / playback</div>' +
                     '<div><span class="sw" style="background:#2563eb"></span>Current</div>';
  document.body.appendChild(legend);

  if (points.length === 1) {
    pill.textContent = 'Only 1 snapshot so far — playback needs ≥2 hours';
    pill.className = 'pill empty';
    return;
  }

  // ≥2 points → enable slider + playback
  pill.textContent = points.length + ' points · 22-day trail';
  pill.className = 'pill';
  document.body.classList.add('has-ctrl');
  map.invalidateSize();

  var activeLine = L.polyline([], { color: '#2563eb', weight: 4, opacity: 0.9 }).addTo(map);
  // Current-position marker: a triangle pointing in the direction of travel when moving,
  // or a plain dot when stopped / direction unknown. Uses a rotatable divIcon.
  var makeIcon = function(bearing, moving) {
    var html = moving
      ? '<div style="transform:rotate(' + bearing + 'deg);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-bottom:18px solid #2563eb;filter:drop-shadow(0 0 2px #fff)"></div>'
      : '<div style="width:14px;height:14px;border-radius:50%;background:#2563eb;border:2px solid #fff;box-shadow:0 0 3px rgba(0,0,0,.4)"></div>';
    return L.divIcon({ className: 'dir-cursor', html: html, iconSize: [18,18], iconAnchor: [9,9] });
  };
  // bearing in degrees (0=N,90=E) from point a→b; triangle SVG points up (north) at 0.
  var bearingDeg = function(a, b) {
    var toRad = Math.PI / 180, toDeg = 180 / Math.PI;
    var y = Math.sin((b.lng - a.lng) * toRad) * Math.cos(b.lat * toRad);
    var x = Math.cos(a.lat * toRad) * Math.sin(b.lat * toRad) -
            Math.sin(a.lat * toRad) * Math.cos(b.lat * toRad) * Math.cos((b.lng - a.lng) * toRad);
    return (Math.atan2(y, x) * toDeg + 360) % 360;
  };
  var cursor = L.marker([start.lat, start.lng], { icon: makeIcon(0, false) }).addTo(map);

  var slider = document.getElementById('slider');
  var tsLabel = document.getElementById('tsLabel');
  var spdLabel = document.getElementById('spdLabel');
  var cntLabel = document.getElementById('cntLabel');
  var btnPlay = document.getElementById('btnPlay');
  var btnReset = document.getElementById('btnReset');

  slider.max = String(points.length - 1);
  slider.value = String(points.length - 1);

  var fmtTs = function(ms) {
    try {
      return new Date(ms).toLocaleString('en-IN', {
        weekday: 'short', day: '2-digit', month: 'short',
        hour: '2-digit', minute: '2-digit', hour12: false
      });
    } catch (e) { return new Date(ms).toISOString(); }
  };

  var render = function(idx) {
    var p = points[idx];
    if (!p) return;
    var upTo = points.slice(0, idx + 1).map(function(q){ return [q.lat, q.lng]; });
    activeLine.setLatLngs(upTo);
    cursor.setLatLng([p.lat, p.lng]);
    // Direction: bearing from previous point → this point, shown only when moving.
    var prev = idx > 0 ? points[idx - 1] : null;
    var moving = (p.speed != null && !isNaN(p.speed) && p.speed >= 3) && prev != null;
    if (moving) {
      var brg = bearingDeg(prev, p);
      cursor.setIcon(makeIcon(brg, true));
    } else {
      cursor.setIcon(makeIcon(0, false));
    }
    tsLabel.textContent = fmtTs(p.ts);
    spdLabel.textContent = (p.speed != null && !isNaN(p.speed)) ? ('· ' + Math.round(p.speed) + ' km/h') : '';
    cntLabel.textContent = (idx + 1) + '/' + points.length;
  };

  slider.addEventListener('input', function() {
    stopPlay();
    render(Number(slider.value));
  });

  var timer = null;
  var stopPlay = function() {
    if (timer) { clearInterval(timer); timer = null; }
    btnPlay.textContent = '▶';
  };
  var startPlay = function() {
    if (timer) return;
    btnPlay.textContent = '⏸';
    timer = setInterval(function() {
      var i = Number(slider.value);
      if (i >= points.length - 1) { stopPlay(); return; }
      i += 1;
      slider.value = String(i);
      render(i);
    }, 500);
  };
  btnPlay.addEventListener('click', function() {
    if (timer) stopPlay(); else {
      if (Number(slider.value) >= points.length - 1) { slider.value = '0'; render(0); }
      startPlay();
    }
  });
  btnReset.addEventListener('click', function() {
    stopPlay();
    slider.value = '0';
    render(0);
  });

  render(points.length - 1);
};
window.__HALTS__ = function(halts) {
  var box = document.getElementById('haltsBox');
  var list = document.getElementById('haltsList');
  if (!box || !list) return;
  if (!halts || !halts.length) { box.style.display='none'; return; }
  function fmtDur(s){ var h=Math.floor(s/3600), m=Math.floor((s%3600)/60); return h>0?(h+'h '+m+'m'):(m+'m'); }
  function fmtT(ms){ try { return new Date(ms).toLocaleString([], {day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}); } catch(e){ return '—'; } }
  var html = '';
  for (var i=0;i<halts.length;i++){
    var h = halts[i];
    var tierColor = h.durationSeconds>=43200 ? '#fca5a5' : (h.durationSeconds>=18000 ? '#fdba74' : '#cbd5e1');
    html += '<div style="padding:6px 0;border-top:'+(i?'1px solid #334155':'none')+'">'
      + '<div style="color:'+tierColor+';font-weight:700">'+fmtDur(h.durationSeconds)+(h.ongoing?' (ongoing)':'')+'</div>'
      + '<div style="color:#cbd5e1">'+((h.address||'—').replace(/</g,'&lt;'))+'</div>'
      + '<div style="color:#ffffff;font-size:12px;margin-top:2px">'+fmtT(h.startedAt)+(h.endedAt?(' → '+fmtT(h.endedAt)):' → now')+'</div>'
      + '</div>';
  }
  list.innerHTML = html;
  box.style.display = 'block';
  // Mark each stop location on the map with an amber circle. The map may not exist yet if
  // __HALTS__ runs before __INIT__ (the two fetches race), so retry until the map is ready.
  var drawCircles = function(tries) {
    var hmap = window.__MAP__;
    if (!hmap) { if (tries > 0) setTimeout(function(){ drawCircles(tries - 1); }, 200); return; }
    try {
      for (var j = 0; j < halts.length; j++) {
        var hh = halts[j];
        if (hh.lat == null || hh.lng == null) continue;
        var mins = Math.round(hh.durationSeconds / 60);
        var label = (mins >= 60 ? (Math.floor(mins/60) + 'h ' + (mins%60) + 'm') : (mins + 'm'))
                    + (hh.ongoing ? ' (ongoing)' : '') + (hh.address ? (' · ' + hh.address) : '');
        L.circleMarker([hh.lat, hh.lng], {
          radius: 9, color: '#d97706', weight: 2, fillColor: '#f59e0b', fillOpacity: 0.45
        }).addTo(hmap).bindPopup('Stopped ' + label);
      }
    } catch (e) { /* ignore — list still shows */ }
  };
  drawCircles(40);
};
<\/script>
</body></html>`;
      w.document.open(); w.document.write(html); w.document.close();
    };

    writeShell(true);

    // Pull 22-day hourly trail from gps_hourly
    fetchTrail({ data: { vehicleNumber: vk || vehicle.vnum } })
      .then((res) => {
        const points = res?.points || [];
        const tryInit = (tries) => {
          if (w.closed) return;
          if (typeof w.__INIT__ === "function") { try { w.__INIT__(points); } catch (e) { console.error(e); } return; }
          if (tries <= 0) return;
          setTimeout(() => tryInit(tries - 1), 150);
        };
        tryInit(40); // up to ~6s for Leaflet CDN to load
      })
      .catch((err) => {
        console.error("[getVehicleTrail] failed", err);
        const tryInit = (tries) => {
          if (w.closed) return;
          if (typeof w.__INIT__ === "function") { try { w.__INIT__([]); } catch (e) { console.error(e); } return; }
          if (tries <= 0) return;
          setTimeout(() => tryInit(tries - 1), 150);
        };
        tryInit(40);
      });

    // Load-scoped trip stops (2h+) — inject alongside the trail when the vehicle has a load.
    const haltLoadId = explicitLoadId ? String(explicitLoadId) : (vehicle?.loadId ? String(vehicle.loadId) : null);
    if (haltLoadId) {
      fetchLoadHalts({ data: { vehicleNumber: vk || vehicle.vnum, loadId: haltLoadId } })
        .then((res) => {
          const halts = res?.halts || [];
          const tryH = (tries) => {
            if (w.closed) return;
            if (typeof w.__HALTS__ === "function") { try { w.__HALTS__(halts); } catch (e) { console.error(e); } return; }
            if (tries <= 0) return;
            setTimeout(() => tryH(tries - 1), 150);
          };
          tryH(40);
        })
        .catch((err) => console.error("[getLoadHalts] failed", err));
    }
  };

  // Toggle Load "Validated" flag — default off (missing/false = unvalidated).
  const toggleValidated = (loadId) => {
    pushLoads(p => p.map(x => x.id===loadId ? {...x, validated: !x.validated} : x));
  };


  // Load Board export — reused by header button and advanced-filters button.
  const exportLoadBoard = () => {
    const loadsToExport = (lbBranchChip || lbOnlyMulti || lbOnlyLeftUnload)
      ? filteredL.filter(l => (!lbBranchChip || resolveLoadBranch(l) === lbBranchChip) && (!lbOnlyMulti || (l.consignees||[]).filter(Boolean).length > 1) && (!lbOnlyLeftUnload || isLeftUnload(l)))
      : filteredL;
    const data = loadsToExport.map(l => {
      const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
      const qv = (!av && l.lstatus==="QUEUED" && l.queuedVehicleId) ? vehicleById.get(String(l.queuedVehicleId)) ?? null : null;
      const bl = (qv && l.queuedBehindLoadId) ? loadById.get(String(l.queuedBehindLoadId)) ?? null : null;
      const qText = qv ? `Queued - ${qv.vnum} - ${VS_LABELS[qv.vstatus]||qv.vstatus} - ${bl?.dest||"—"} - ${bl?.lid||"—"}` : "";
      // Current Location — identical derivation to the Load Board table cell:
      // live GPS reverse-geocoded address (or the cached addrMap fallback), formatted to District, State.
      const gps = av ? lookupGps(gpsMap, av.vnum) : null;
      const vk = av ? gpsVehicleKey(av.vnum) : "";
      const gAddr = gps && (gps.address || addrMap[vk]);
      const currentLocation = gAddr ? formatDistrictState(gAddr) : "";
      return {
        "Load ID": l.lid,
        "Customer": l.customer || "",
        "Commodity": l.commodity || "",
        "Origin": l.origin || "",
        "Destination": l.dest || "",
        "Branch": l.branch || "",
        "Pickup": l.pickup || "",
        "Delivery": l.delivery || "",
        "LR Date": l.lrDate || av?.lrDate || "",
        "Load Status": LS_LABELS[l.lstatus]||l.lstatus,
        "Vehicle #": av?.vnum || qv?.vnum || "",
        "Vehicle Status": av ? (VS_LABELS[av.vstatus]||av.vstatus) : (qv ? qText : ""),
        "Current Location": currentLocation,
        "Driver": av?.driver || qv?.driver || "",
        "Mobile": av?.mobile || qv?.mobile || "",
        "Vehicle Type Required": l.vtypeReq || "",
        "Weight": l.weight || "",
        "Volume": l.volume || "",
        "Priority": l.priority || "",
        "Validated": l.validated ? "Yes" : "No",
      };
    });
    data.sort((a, b) =>
      (a.Branch || "zzz").localeCompare(b.Branch || "zzz") ||
      (a["Load ID"] || "").localeCompare(b["Load ID"] || "")
    );
    // Build branch-wise sheet with heading rows between branches
    const headers = ["Load ID","Customer","Commodity","Origin","Destination","Branch","Pickup","Delivery","LR Date","Load Status","Vehicle #","Vehicle Status","Current Location","Driver","Mobile","Vehicle Type Required","Weight","Volume","Priority","Validated"];
    const aoa = [headers];
    let lastBranch = null;
    for (const row of data) {
      const br = row["Branch"] || "Unassigned";
      if (br !== lastBranch) {
        if (lastBranch !== null) aoa.push([]); // blank spacer row
        aoa.push([`── ${br.toUpperCase()} ──`]); // branch heading row
        lastBranch = br;
      }
      aoa.push(headers.map(h => row[h] ?? ""));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    // Style heading rows bold (basic xlsx styling)
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, "Loads");
    XLSX.writeFile(wb, `loads-export-${new Date().toISOString().slice(0,10)}.xlsx`);
  };

  // ─── ASSIGNMENT ───
  const assignVehicle = (vehicleId) => {
    const l = loadById.get(String(assignLid)) ?? null;
    const v = vehicles.find(x=>x.id===vehicleId);
    if (!l || !v) return;
    // Hard cap: max 1 active + 1 queued load per vehicle.
    const activeOnV = loads.filter(x =>
      x.id !== assignLid &&
      x.vehicleId === vehicleId &&
      ["ASSIGNED","IN_TRANSIT","AT_UNLOADING"].includes(x.lstatus)
    );
    const queuedOnV = loads.filter(x =>
      x.id !== assignLid &&
      x.queuedVehicleId === vehicleId &&
      x.lstatus === "QUEUED"
    );
    if (activeOnV.length >= 1 && queuedOnV.length >= 1) {
      alert("⚠️ This vehicle already has 1 active load and 1 queued load. A vehicle can hold at most 1 active + 1 queued at any time. Deliver or unassign one before assigning another.");
      setAssignLid(null);
      return;
    }
    const nowIso = new Date().toISOString();
    // If vehicle is currently linked to a different active load, queue this load
    // behind it instead of stealing the vehicle.
    const aLoad = (v.loadId && v.loadId !== assignLid) ? loads.find(x => x.id === v.loadId) : null;
    const blockerActive = !!aLoad && !["DELIVERED","CANCELLED"].includes(aLoad.lstatus);
    const vehicleBusy = blockerActive;
    if (vehicleBusy) {
      pushLoads(p => p.map(x => x.id===assignLid ? {
        ...x,
        lstatus: "QUEUED",
        vehicleId: null,
        queuedVehicleId: vehicleId,
        queuedBehindLoadId: v.loadId,
        queuedAt: nowIso,
      } : x), { localOnly: assignUseEngine });
      if (assignUseEngine) gwQueue(assignLid, vehicleId, v.loadId || null);
      addLLog(`Queued ${v.vnum} behind ${aLoad?.lid || "active load"} for ${l.lid}`, "#6b7280");
      addLog(`${v.vnum} queued for ${l.lid} (busy on ${aLoad?.lid || "another load"})`, "#6b7280");
      setAssignLid(null);
      return;
    }
    // Vehicle is free (or already on this same load) — normal assign
    pushLoads(p => p.map(x => x.id===assignLid ? {...x, vehicleId, vnum:v.vnum||x.vnum||null, lstatus:"ASSIGNED", queuedVehicleId:null, queuedBehindLoadId:null, queuedAt:null} : x), { localOnly: assignUseEngine });
    pushVehicles(p => p.map(x => x.id===vehicleId ? {...x, vstatus:"AT_LOADING", loadId:assignLid, departure:l.origin||x.departure, destination:l.dest||x.destination, atLoadingAt: nowIso, availableSince:null, availableAfterDelivery:false, sentForLoadingAt:null, waitingClearEta:null, sentLoadingClearEta:null} : x), { localOnly: assignUseEngine });
    if (assignUseEngine) gwAssign(assignLid, vehicleId, { departure: l.origin || null, destination: l.dest || null });
    addLLog(`Assigned ${v.vnum} to load ${l.lid}`,"#2563eb");
    addLog(`${v.vnum} assigned to ${l.lid} → ${l.dest}`,"#2563eb");
    setAssignLid(null);
  };

  // Auto-promote queued loads: when the blocking vehicle is freed (no loadId or
  // moved to a different load) and currently AVAILABLE, link it to the oldest
  // queued load waiting for it.
  useEffect(() => {
    if (!vehicles || vehicles.length === 0) return;
    const queued = loads
      .filter(l => l.lstatus === "QUEUED" && l.queuedVehicleId)
      .sort((a,b) => String(a.queuedAt||"").localeCompare(String(b.queuedAt||"")));
    if (queued.length === 0) return;
    const promotions = [];
    const usedVehicles = new Set();
    for (const l of queued) {
      const v = vehicles.find(x => x.id === l.queuedVehicleId);
      if (!v) continue; // vehicle missing (likely transient sync) — leave queued
      if (usedVehicles.has(v.id)) continue;
      const stillOnBlocker = v.loadId && v.loadId === l.queuedBehindLoadId;
      if (!stillOnBlocker && v.vstatus === "AVAILABLE" && v.availableAfterDelivery === true) {
        promotions.push({ loadId: l.id, vehicleId: v.id, origin: l.origin, dest: l.dest, lid: l.lid, vnum: v.vnum });
        usedVehicles.add(v.id);
      }
    }
    if (promotions.length === 0) return;
    const pm = new Map(promotions.map(p => [p.loadId, p]));
    const vm = new Map(promotions.map(p => [p.vehicleId, p]));
    pushLoads(p => p.map(x => pm.has(x.id) ? { ...x, lstatus:"ASSIGNED", vehicleId: pm.get(x.id).vehicleId, queuedVehicleId:null, queuedBehindLoadId:null, queuedAt:null } : x), { localOnly: assignUseEngine });
    pushVehicles(p => p.map(x => vm.has(x.id) ? { ...x, loadId: vm.get(x.id).loadId, departure: vm.get(x.id).origin || x.departure, destination: vm.get(x.id).dest || x.destination } : x), { localOnly: assignUseEngine });
    if (assignUseEngine) promotions.forEach(p => gwPromote(p.loadId, { departure: p.origin || null, destination: p.dest || null }));
    promotions.forEach(p => addLLog(`Promoted queued load ${p.lid} → ${p.vnum} now Available`, "#16a34a"));
  }, [vehicles, loads]);

  // Reconcile load lstatus ← vehicle vstatus when the two drift.
  // Only forward transitions; never overwrites DELIVERED/CANCELLED/LATE.
  useEffect(() => {
    if (!loads.length || !vehicles.length) return;
    const vById = new Map(vehicles.map(v => [String(v.id), v]));
    const patches = new Map();
    for (const l of loads) {
      if (!l.vehicleId) continue;
      if (["DELIVERED","CANCELLED"].includes(l.lstatus)) continue;
      const v = vById.get(String(l.vehicleId));
      if (!v) continue;
      if (v.vstatus === "AVAILABLE" && !["ASSIGNED","DELIVERED","CANCELLED"].includes(l.lstatus)) {
        // Vehicle freed/empty but still linked to load — drop load back to ASSIGNED.
        patches.set(l.id, { lstatus: "ASSIGNED" });
      } else if (v.vstatus === "IN_TRANSIT" && ["ASSIGNED","QUEUED","PENDING"].includes(l.lstatus)) {
        patches.set(l.id, { lstatus: "IN_TRANSIT" });
      } else if (v.vstatus === "AT_UNLOADING"
                 && ["ASSIGNED","IN_TRANSIT"].includes(l.lstatus)
                 && !l.manualUnloadOverride
                 && !(l.leftUnloadingAt && !l.leftUnloadingAck)) { // Guard 2: never overwrite a left-unloading flag
        patches.set(l.id, { lstatus: "AT_UNLOADING" });
      }
    }
    if (!patches.size) return;
    // Phase 1b: under the lane the engine sets lstatus+vstatus together, so this
    // lstatus←vstatus reconciler must not server-write status; localOnly keeps it
    // as a local-display safety net only.
    pushLoads(p => p.map(l => patches.has(l.id) ? { ...l, ...patches.get(l.id) } : l), { localOnly: assignUseEngine });
  }, [loads, vehicles]);




  const unassign = (loadId) => {
    const l = loadById.get(String(loadId)) ?? null;
    if (l?.vehicleId) {
      const otherActive     = loads.filter(x => x.id !== loadId && x.vehicleId === l.vehicleId && !["DELIVERED","CANCELLED"].includes(x.lstatus));
      const otherInProgress = otherActive.filter(x => ["IN_TRANSIT","AT_UNLOADING","ASSIGNED"].includes(x.lstatus));
      const otherQueued     = !otherInProgress.length ? otherActive.filter(x => x.lstatus === "QUEUED") : [];
      pushVehicles(p => p.map(v => {
        if (v.id !== l.vehicleId) return v;
        if (otherInProgress.length > 0) return { ...v, loadId: otherInProgress[0].id };
        if (otherQueued.length > 0) return { ...v, vstatus:"AVAILABLE", loadId: otherQueued[0].id, availableSince: new Date().toISOString(), availableAfterDelivery:true, sentForLoadingAt:null, atLoadingAt:null, waitingClearEta:null, sentLoadingClearEta:null, atLoadingClearEta:null };
        return { ...v, vstatus:"AVAILABLE", loadId:null, availableSince: new Date().toISOString(), availableAfterDelivery:true, sentForLoadingAt:null, atLoadingAt:null, waitingClearEta:null, sentLoadingClearEta:null, atLoadingClearEta:null };
      }), { localOnly: assignUseEngine });
      if (otherQueued.length > 0) {
        // optimistic local promote; the RPC cascade does the authoritative promote when flag on
        pushLoads(p => p.map(x => x.id === otherQueued[0].id ? { ...x, lstatus: "ASSIGNED" } : x), { localOnly: assignUseEngine });
        addLLog(`Load ${otherQueued[0].lid || otherQueued[0].id} auto-promoted Queued → Assigned`, "#d97706");
      }
      addLLog(`Unassigned vehicle from ${l.lid}`,"#d97706");
      addLog(`Vehicle freed from ${l.lid}`,"#d97706");
    } else if (l?.queuedVehicleId) {
      const qv = vehicleById.get(String(l.queuedVehicleId)) ?? null;
      addLLog(`Removed queued vehicle ${qv?.vnum||""} from ${l.lid}`,"#d97706");
    }
    pushLoads(p => p.map(x => x.id===loadId ? {...x, vehicleId:null, queuedVehicleId:null, queuedBehindLoadId:null, queuedAt:null, lstatus:"PENDING", manualUnloadOverride: false} : x), { localOnly: assignUseEngine });
    // Authoritative server write (load→PENDING + free vehicle + cascade-promote any queued load).
    if (assignUseEngine) gwUnassign(loadId);
  };

  // ─── DELAY REASONS ───
  // delayInfo: { loadId: { reason, revisedEta, revisedEtaHistory:[{eta,reason,setAt}], stoppageConfirmDue, managerConfirmed, confirmHistory:[{confirmedAt,status,newEta,newReason}] } }
  const [delayInfo, setDelayInfo] = useSyncedSetting("tms.delayInfo", {});
  const [delayModal, setDelayModal] = useState(null); // loadId
  const [delayForm, setDelayForm] = useState({ reason:"", revisedEta:"" });
  const DELAY_REASONS = [
    { id:"STOPPAGE",   label:"Due To Stoppage",             icon:"stop", askEta:true  },
    { id:"LATE_DISP",  label:"Late Dispatch",               icon:"⏰", askEta:false },
    { id:"MAINTENANCE",label:"Maintenance",                  icon:"", askEta:false },
    { id:"BREAKDOWN",  label:"Due To Breakdown / Incident",  icon:"🚑", askEta:false },
  ];
  const saveDelayReason = () => {
    const reason = delayForm.reason;
    if (!reason) { alert("Please select a delay reason."); return; }
    const needsEta = DELAY_REASONS.find(r=>r.id===reason)?.askEta;
    if (needsEta && !delayForm.revisedEta) { alert("Please set a revised ETA for when the vehicle will be back on road."); return; }
    const existing = delayInfo[delayModal] || {};
    const history = existing.revisedEtaHistory || [];
    const entry = {
      reason, revisedEta: delayForm.revisedEta || null,
      setAt: new Date().toLocaleString("en-IN"),
      stoppageConfirmDue: needsEta ? delayForm.revisedEta : null,
      managerConfirmed: false,
      confirmHistory: existing.confirmHistory || [],
    };
    if (delayForm.revisedEta && existing.revisedEta) {
      history.push({ eta: existing.revisedEta, reason: existing.reason, setAt: existing.setAt });
    }
    setDelayInfo(p => ({ ...p, [delayModal]: { ...entry, revisedEtaHistory: history } }));
    const l = loadById.get(String(delayModal)) ?? null;
    const rLabel = DELAY_REASONS.find(r=>r.id===reason)?.label || reason;
    addLLog(`Delay reason set for ${l?.lid}: ${rLabel}`, "#d97706");
    setDelayModal(null);
    setDelayForm({ reason:"", revisedEta:"" });
  };

  // Stoppage confirmation state
  const [confirmModal, setConfirmModal] = useState(null); // loadId
  const [confirmForm, setConfirmForm] = useState({ running:null, newEta:"", newReason:"" });
  const submitConfirmation = () => {
    const { running, newEta, newReason } = confirmForm;
    if (running === null) { alert("Please confirm whether the vehicle is running."); return; }
    if (!running && !newEta) { alert("Please provide a revised ETA."); return; }
    if (!running && !newReason) { alert("Please provide a reason for continued stoppage."); return; }
    const l = loadById.get(String(confirmModal)) ?? null;
    setDelayInfo(p => {
      const existing = p[confirmModal] || {};
      const hist = existing.confirmHistory || [];
      hist.push({ confirmedAt: new Date().toLocaleString("en-IN"), status: running?"RUNNING":"STILL_STOPPED", newEta: running?null:newEta, newReason: running?null:newReason });
      return { ...p, [confirmModal]: { ...existing, managerConfirmed: true, stoppageConfirmDue: running?null:newEta, confirmHistory: hist, revisedEta: running?existing.revisedEta:newEta } };
    });
    if (running) {
      addLLog(` Manager confirmed: vehicle running for ${l?.lid}`, "#16a34a");
    } else {
      addLLog(` Vehicle still stopped for ${l?.lid} — new ETA set`, "#d97706");
    }
    setConfirmModal(null);
    setConfirmForm({ running:null, newEta:"", newReason:"" });
  };

  // ── TAT Tracker per-load Reasons ──
  // tatReasons: { [loadId]: { moving: bool|null, expectedEta: string, reasons: [{id, type, hours, addedAt}] } }
  const [tatReasons, setTatReasons] = useSyncedSetting("tms.tatReasons", {});
  const [tatReasonOpen, setTatReasonOpen] = useState(null); // loadId currently expanded
  const [tatModalLoadId, setTatModalLoadId] = useState(null); // loadId for Load Board "Edit Delay" modal
  const TAT_REASON_TYPES = [
    { id:"DELAY_DISPATCH",  label:"Delay at Dispatch",   icon:"⏰", askHours:true  },
    { id:"REPAIR_DISPATCH", label:"Repair at Dispatch",  icon:"", askHours:true  },
    { id:"INTRANSIT_REPAIR",label:"In-Transit Repair",   icon:"🛠",  askHours:true  },
    { id:"WD",              label:"W/D",                 icon:"🚿", askHours:true  },
    { id:"HOME_STOPPAGE",   label:"Home-Stoppage",       icon:"🏠", askHours:true  },
    { id:"SLOW_DRIVING",    label:"Slow-Driving",        icon:"🐢", askHours:true  },
    { id:"CROSS_MATERIAL",  label:"Cross Material",      icon:"🔀", askHours:false },
    { id:"OTHER",           label:"Other",               icon:"📝", askHours:true  },
  ];
  const updateTatReason = (loadId, fn) => {
    setTatReasons(p => {
      const cur = p[loadId] || { moving:null, expectedEta:"", reasons:[] };
      const next = fn(cur);
      return { ...p, [loadId]: next };
    });
  };
  const addTatReason = (loadId, type, hours) => {
    const t = TAT_REASON_TYPES.find(r=>r.id===type);
    if (!t) return;
    updateTatReason(loadId, (cur) => ({
      ...cur,
      reasons: [...cur.reasons, { id: `tr_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, type, hours: (t.askHours && hours && !isNaN(parseFloat(hours))) ? parseFloat(hours) : null, addedAt: new Date().toLocaleString("en-IN") }],
    }));
  };
  const removeTatReason = (loadId, reasonId) => {
    updateTatReason(loadId, (cur) => ({ ...cur, reasons: cur.reasons.filter(r=>r.id!==reasonId) }));
  };
  const addTatComment = (loadId, text) => {
    const t = (text||"").trim();
    if (!t) return;
    updateTatReason(loadId, (cur) => ({
      ...cur,
      comments: [...(cur.comments||[]), { id: `tc_${Date.now()}_${Math.random().toString(36).slice(2,6)}`, text: t, addedAt: new Date().toLocaleString("en-IN") }],
    }));
  };
  const editTatComment = (loadId, commentId, newText) => {
    const t = (newText||"").trim();
    if (!t) return;
    updateTatReason(loadId, (cur) => ({
      ...cur,
      comments: (cur.comments||[]).map(c => c.id===commentId ? { ...c, text: t, editedAt: new Date().toLocaleString("en-IN") } : c),
    }));
  };





  const [importantDelayedLoads, setImportantDelayedLoads] = useSyncedSetting("tms.importantDelayedLoads", {});
  const [delayedSubTab, setDelayedSubTab] = useState("all");
  const toggleImportantDelayed = (loadId) => {
    setImportantDelayedLoads(p => {
      const n = {...p};
      if (n[loadId]) { delete n[loadId]; addLLog(`Load removed from Important Delayed`,"#6b7280"); }
      else { n[loadId] = true; addLLog(`⭐ Load marked as Important Delayed`,"#d97706"); }
      return n;
    });
  };

  // ─── LOCK & APPROVAL ───
  const lockLoad = (loadId) => {
    setLockedLoads(p => ({ ...p, [loadId]: true }));
    const l = loadById.get(String(loadId)) ?? null;
    const av = l?.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
    addLLog(` Load ${l?.lid} locked with ${av?.vnum||"vehicle"}`, "#6366f1");
    setLockModalLid(null);
  };
  const submitChangeRequest = () => {
    const { managerName, managerMobile, reason } = changeReqForm;
    if (!managerName.trim() || !managerMobile.trim() || !reason.trim()) {
      alert("All fields are required."); return;
    }
    const l = loadById.get(String(changeReqModal)) ?? null;
    const av = l?.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
    const req = {
      id: "CR-" + String(++_crId).padStart(3,"0"),
      loadId: l.id, lid: l.lid,
      currentVehicle: av?.vnum || "—",
      managerName, managerMobile, reason,
      status: "PENDING",
      requestedAt: new Date().toLocaleString("en-IN"),
    };
    setChangeRequests(p => [req, ...p]);
    addLLog(`Change request ${req.id} submitted for ${l?.lid}`, "#d97706");
    setChangeReqModal(null);
    setChangeReqForm(blankCRForm());
  };
  const approveChangeRequest = (crId) => {
    const cr = changeRequests.find(x=>x.id===crId);
    setChangeRequests(p => p.map(x => x.id===crId ? {...x, status:"APPROVED"} : x));
    // Unlock the load so vehicle can be changed
    setLockedLoads(p => { const n={...p}; delete n[cr.loadId]; return n; });
    addLLog(` Change request ${crId} approved — ${cr.lid} unlocked`, "#16a34a");
  };
  const rejectChangeRequest = (crId) => {
    setChangeRequests(p => p.map(x => x.id===crId ? {...x, status:"REJECTED"} : x));
    const cr = changeRequests.find(x=>x.id===crId);
    addLLog(`❌ Change request ${crId} rejected`, "#dc2626");
  };

  // ─── Filtered lists ───
  const PRE_TRANSIT_EXCL = ["IN_TRANSIT","DELIVERED","AT_UNLOADING"];
  const RPDC_DEST_TOKENS = ["becharaji","bechraji","bangalore","bengaluru","nagpur","siliguri","manesar","gurgaon","gujarat"];
  const isRpdcLoad = (l) => {
    const cust = (l?.customer||"").toLowerCase();
    const dest = (l?.dest||"").toLowerCase();
    return cust.includes("maruti suzuki") && RPDC_DEST_TOKENS.some(t => dest.includes(t));
  };
  const filteredV = useMemo(() => vehicles.filter(v => {
    const mf = fFilter==="ALL" || v.vstatus===fFilter;
    const q = fSearchDef.toLowerCase();
    const ms = !q || [v.vnum,v.driver,v.departure,v.destination,v.vtype,v.branch].some(f=>f&&f.toLowerCase().includes(q));
    const mb = !fBranchFilter || gpsBranchMap[gpsVehicleKey(v.vnum)] === fBranchFilter;
    const mtb = !fToBranchFilter || v.destination===fToBranchFilter || (v.destination&&v.destination.toLowerCase().includes(fToBranchFilter.toLowerCase()));
    const mp = !fPinOnly || !!getPin(v.vnum);
    const mnd = !fNoDriverOnly || !!v.withoutDriver;
    return mf && ms && mb && mtb && mp && mnd;
  }), [vehicles, fFilter, fSearchDef, fBranchFilter, fToBranchFilter, gpsBranchMap, fPinOnly, fNoDriverOnly]);

  const pagedFV = useMemo(() => {
    const start = (fPage - 1) * fPerPage;
    return filteredV.slice(start, start + fPerPage);
  }, [filteredV, fPage, fPerPage]);
  const fTotalPages = Math.max(1, Math.ceil(filteredV.length / fPerPage));

  // Reset fleet page when filters/search change
  useEffect(() => {
    setFPage(1);
  }, [fFilter, fSearch, fBranchFilter, fToBranchFilter]);

  const filteredL = useMemo(() => loads.filter(l => {
    const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
    if (l.lstatus === "DELIVERED") return false;
    const mf = lFilter==="ALL" || l.lstatus===lFilter;
    const q = lSearchDef.toLowerCase();
    const ms = !q || [l.lid,l.commodity,l.origin,l.dest,l.customer,l.branch].some(f=>f&&f.toLowerCase().includes(q));
    const mb = !lBranch || l.branch===lBranch;
    const mc = !lCustomer || l.customer===lCustomer;
    const mv = !lVType || l.vtypeReq===lVType;
    // moved filters
    const mvf = !fVehFilter || (av && ((av.vnum||"").toLowerCase().includes(fVehFilter.toLowerCase()) || (av.id||"").toLowerCase().includes(fVehFilter.toLowerCase())));
    const mfc = !fFromCityFilter || (l.origin||"").toLowerCase().includes(fFromCityFilter.toLowerCase());
    const mtc = !fToCityFilter || (l.dest||"").toLowerCase().includes(fToCityFilter.toLowerCase());
    const mcu = !fCustomerFilter || l.customer===fCustomerFilter;
    const mBr = !lbFleetBranchFilter || l.branch===lbFleetBranchFilter;
    const mvs = fFilter==="ALL" || (!!av && av.vstatus===fFilter);
    const mPending = !fPending || !l.vehicleId;
    const mPre = !fPreTransit || (!!av && !PRE_TRANSIT_EXCL.includes(av.vstatus));
    const mRpdc = !fRpdc || isRpdcLoad(l);
    const pdate = (l.pickup || l.lrDate || av?.lrDate || "").slice(0,10);
    const mdFrom = !fDateFrom || (pdate && pdate >= fDateFrom);
    const mdTo = !fDateTo || (pdate && pdate <= fDateTo);
    return mf && ms && mb && mc && mv && mvf && mfc && mtc && mcu && mBr && mvs && mPending && mPre && mRpdc && mdFrom && mdTo;
  }), [loads, vehicles, lFilter, lSearchDef, lBranch, lCustomer, lVType, fVehFilter, fFromCityFilter, fToCityFilter, fCustomerFilter, lbFleetBranchFilter, fFilter, fPending, fPreTransit, fRpdc, fDateFrom, fDateTo]);

  // Chip-aware list (branch chip + multi + left-unload) drives pagination so a
  // selected branch with <100 loads collapses to a single page instead of being
  // scattered across the full-set page count.
  const filteredLForPage = useMemo(() => {
    const loadNum = (l) => { const m = /LD-(\d+)/i.exec(l.lid || ""); return m ? parseInt(m[1],10) : 0; };
    const filtered = filteredL.filter(l => {
      const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) : null;
      return (
        (!lbBranchChip || resolveLoadBranch(l) === lbBranchChip) &&
        (!lbOnlyMulti || (l.consignees||[]).filter(Boolean).length > 1) &&
        (!lbOnlyLeftUnload || isLeftUnload(l)) &&
        (!lbOnlyNoDriver || !!av?.withoutDriver) &&
        (!lbOnlyIncident || (l.vehicleId && !!vehicleIncidents[l.vehicleId]))
      );
    });
    // Pre-sort: group by branch (alpha) so a branch never straddles a page
    // boundary unless it truly has more than LB_PAGE_SIZE loads. Inside each
    // branch, newest LD-### first (matches the in-group sort).
    return filtered.sort((a, b) => {
      const ba = resolveLoadBranch(a) || "";
      const bb = resolveLoadBranch(b) || "";
      if (ba !== bb) return ba.localeCompare(bb);
      return loadNum(b) - loadNum(a);
    });
  }, [filteredL, lbBranchChip, lbOnlyMulti, lbOnlyLeftUnload, lbOnlyNoDriver, lbOnlyIncident, vehicleById, vehicleIncidents]);


  // Pagination — branch-first: a page holds whole branch groups so a branch
  // never appears on two pages unless that single branch has more than
  // LB_PAGE_SIZE loads (only then it overflows into the next page).
  const LB_PAGE_SIZE = 100;
  const lbPages = useMemo(() => {
    // Build contiguous branch groups (filteredLForPage is already sorted by
    // branch then newest LD-### first).
    const groups = [];
    let cur = null;
    for (const l of filteredLForPage) {
      const b = resolveLoadBranch(l) || "";
      if (!cur || cur.branch !== b) { cur = { branch: b, loads: [] }; groups.push(cur); }
      cur.loads.push(l);
    }
    const pages = [];
    let page = [];
    for (const g of groups) {
      if (g.loads.length > LB_PAGE_SIZE) {
        if (page.length) { pages.push(page); page = []; }
        for (let i = 0; i < g.loads.length; i += LB_PAGE_SIZE) {
          pages.push(g.loads.slice(i, i + LB_PAGE_SIZE));
        }
        continue;
      }
      if (page.length > 0 && page.length + g.loads.length > LB_PAGE_SIZE) {
        pages.push(page);
        page = [];
      }
      page.push(...g.loads);
    }
    if (page.length) pages.push(page);
    if (!pages.length) pages.push([]);
    return pages;
  }, [filteredLForPage]);
  const lbTotalPages = lbPages.length;
  const lbCurPage = Math.min(Math.max(1, lbPage), lbTotalPages);
  const pagedL = lbPages[lbCurPage - 1] || [];
  const lbPageStart = pagedL.length === 0 ? 0 : lbPages.slice(0, lbCurPage - 1).reduce((s, p) => s + p.length, 0) + 1;
  const lbPageEnd = lbPageStart === 0 ? 0 : lbPageStart + pagedL.length - 1;
  // Reset to page 1 whenever filters/search/chips change.
  useEffect(() => { setLbPage(1); }, [lFilter, lSearchDef, lBranch, lCustomer, lVType, fVehFilter, fFromCityFilter, fToCityFilter, fCustomerFilter, lbFleetBranchFilter, fFilter, fDateFrom, fDateTo, fPending, fPreTransit, fRpdc, lbBranchChip, lbOnlyMulti, lbOnlyLeftUnload, lbOnlyNoDriver, lbOnlyIncident]);
  // Clamp if dataset shrinks below current page.
  useEffect(() => { if (lbPage > lbTotalPages) setLbPage(lbTotalPages); }, [lbTotalPages, lbPage]);



  // Derived lists for filter dropdowns (only values that exist in loads)
  const loadBranches = useMemo(()=>branches,[branches]); // use master branch list, not just what's in loads
  const loadCustomers = useMemo(()=>customers,[customers]); // use master customer list
  const loadVTypes = useMemo(()=>[...new Set(loads.map(l=>l.vtypeReq).filter(Boolean))].sort(),[loads]);

  // Loads that the TAT Tracker considers delayed (IN_TRANSIT, ETA overdue by >4h).
  // Used to surface the  Delay button on the Load Board for in-transit late loads.

  // Centralized per-load derived data. Computed ONCE per [loads,vehicles,gpsMap,cityCoords]
  // change. All consumers (delayedLoadIds, incomingCount, Load Board rows) read from this
  // map instead of calling computeTat 3-4× per render. No filter logic moves here — just
  // memoizes the heavy haversine/date math. vehicleById is already memoized above.
  const loadDerived = useMemo(() => {
    const m = new Map();
    for (const l of loads) {
      const v = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
      const tat = computeTat(l, v, cityCoords, gpsMap);
      const isDelayed = !!(v && v.vstatus === "IN_TRANSIT" && tat.targetAt && tat.arrivalAt && (tat.arrivalAt - tat.targetAt) / 3600000 > 4);
      m.set(String(l.id), { v, tat, isDelayed });
    }
    return m;
  }, [loads, vehicles, vehicleById, cityCoords, gpsMap]);

  const delayedLoadIds = useMemo(() => {
    const ids = new Set();
    for (const l of loads) {
      const d = loadDerived.get(String(l.id));
      if (d && d.isDelayed) ids.add(l.id);
    }
    return ids;
  }, [loads, loadDerived]);



  // Count of IN_TRANSIT vehicles that will actually appear on the Incoming tab
  // (have a resolvable destination branch and an arrival within next 3 days).
  const incomingCount = useMemo(() => {
    const NOW = Date.now();
    const HORIZON = NOW + 3 * 24 * 3600 * 1000;
    const myBranches = Array.from(new Set(
      (branches || []).map(b => typeof b === "string" ? b : b?.name).filter(Boolean)
    ));
    let n = 0;
    for (const v of vehicles) {
      if (v.vstatus !== "IN_TRANSIT") continue;
      const ld = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l => l.vehicleId === v.id);
      if (!ld || !ld.dest) continue;
      let destBranch = getDestBranch(ld.dest);
      if (!destBranch) {
        const dk = String(ld.dest||"").trim().toLowerCase();
        const hit = myBranches.find(b => String(b).trim().toLowerCase() === dk);
        if (hit) destBranch = hit;
      }
      if (!destBranch) continue;
      
      let arrivalAt = null;
      const d = loadDerived.get(String(ld.id));
      const ca = d?.tat?.arrivalAt || null;
      if (ca) {
        arrivalAt = ca;
      } else if (ld.delivery) {
        const t = new Date(ld.delivery);
        if (!isNaN(t.getTime())) arrivalAt = t;
      }
      if (!arrivalAt) continue;
      if (arrivalAt.getTime() > HORIZON) continue;
      n++;
    }
    return n;
  }, [vehicles, loads, loadById, loadDerived, branches]);

  // GPS issue classification: vehicles with no GPS fetch vs coords-not-resolving
  const gpsIssueRows = useMemo(() => {
    const noFetch = [];
    const unresolved = [];
    for (const v of vehicles) {
      const vk = gpsVehicleKey(v.vnum); const vkAlt = gpsVehicleKeyAlt(v.vnum);
      const g = (gpsMap[vk] || gpsMap[vkAlt]);
      const linkedLoad = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l => l.vehicleId === v.id);
      const row = { v, g, vk, linkedLoad, geoStatus: geoStatusMap[vk] || null };
      if (!g || g.lat == null || g.lng == null) {
        noFetch.push(row);
      } else if (!g.address && !addrMap[vk]) {
        unresolved.push(row);
      }
    }
    return { noFetch, unresolved };
  }, [vehicles, loads, gpsMap, addrMap, geoStatusMap]);

  const availableVehicles = vehicles.filter(v=>v.vstatus==="AVAILABLE");
  const assignLoad = loadById.get(String(assignLid)) ?? null;

  if (manageVid && vehicleIncidents[manageVid]) {
    const inc = vehicleIncidents[manageVid];
    const recLoad = inc.loadId ? loadById.get(String(inc.loadId)) ?? null : null;
    const fakeLoad = { id: manageVid, vehicleId: manageVid, lid: inc.lid || recLoad?.lid || "—", customer: recLoad?.customer || "", origin: recLoad?.origin || "", dest: recLoad?.dest || "", branch: recLoad?.branch || "", commodity: recLoad?.commodity || "", vtypeReq: recLoad?.vtypeReq || "" };
    return (
      <div className="tms-root" style={{display:"flex",flexDirection:"column",height:"100vh",overflow:"hidden",background:"#f2f4f7",fontFamily:"'Inter',system-ui,sans-serif",color:"#111827"}}>
        <div style={{background:"#ffffff",borderBottom:"1px solid #e4e7ed",padding:"0 1.4rem",display:"flex",alignItems:"center",height:54,flexShrink:0,gap:9}}>
          <div style={{width:30,height:30,borderRadius:8,background:"#111827",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><TruckIcon size={16} color="#ffffff"/></div>
          <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,color:"#111827",letterSpacing:"-0.2px"}}>FleetCommand</span>
        </div>
        <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading…</div>}>
        <MaintManagePage
          loadId={manageVid}
          incidentLoads={vehicleIncidents}
          setIncidentLoads={setVehicleIncidents}
          loads={[fakeLoad]}
          vehicles={vehicles.map(v => v.id===manageVid ? { ...v, id: manageVid } : v)}
          clearIncident={clearIncident}
          archiveMaintLog={archiveMaintLog}
          addLLog={addLLog}
          onBack={()=>setManageVid(null)}
        />
        </Suspense>
      </div>
    );
  }

  if (viewLogId) {
    const log = (maintLogs||[]).find(x => x.id === viewLogId);
    if (log) {
      // Synthetic key: use the log id so MaintManage's loadId-based lookups still resolve.
      const key = log.id;
      const synthIncidents = { [key]: { ...log.incident, vehicleNum: log.vehicleNum, driver: log.driver, maint: log.maint } };
      const synthLoads = [{ id: key, lid: log.lid, customer: log.customer, origin: log.origin, dest: log.dest }];
      return (
        <div className="tms-root" style={{display:"flex",flexDirection:"column",height:"100vh",overflow:"hidden",background:"#f2f4f7",fontFamily:"'Inter',system-ui,sans-serif",color:"#111827"}}>
          <div style={{background:"#ffffff",borderBottom:"1px solid #e4e7ed",padding:"0 1.4rem",display:"flex",alignItems:"center",height:54,flexShrink:0,gap:9}}>
            <div style={{width:30,height:30,borderRadius:8,background:"#111827",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><TruckIcon size={16} color="#ffffff"/></div>
            <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,color:"#111827",letterSpacing:"-0.2px"}}>FleetCommand</span>
          </div>
          <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading…</div>}>
          <MaintManagePage
            loadId={key}
            incidentLoads={synthIncidents}
            setIncidentLoads={()=>{}}
            loads={synthLoads}
            vehicles={vehicles}
            clearIncident={()=>{}}
            archiveMaintLog={()=>{}}
            addLLog={()=>{}}
            readOnly={true}
            onBack={()=>setViewLogId(null)}
          />
          </Suspense>
        </div>
      );
    }
  }


  // ─── 4-GROUP NAV DEFINITION ───
  const delayCount = vehicles.filter(v => {
    const ts = v.vstatus==="AVAILABLE"?(v.availableAfterDelivery?v.availableSince:null):v.vstatus==="SENT_FOR_LOADING"?v.sentForLoadingAt:v.vstatus==="AT_LOADING"?v.atLoadingAt:null;
    const thr = v.vstatus==="AT_LOADING"?15*3600*1000:2*3600*1000;
    return ts && (nowTick - new Date(ts).getTime()) >= thr;
  }).length;

  const NAV_GROUPS = [
    {
      id: "fleet",
      label: "Fleet",
      tabs: [
        { id:"fleet",     label:"Fleet",     cnt:null, alert:false },
        { id:"fleetmap",  label:"Map",       cnt:null, alert:false },
        { id:"geofences", label:"Geofences", cnt:null, alert:false },
      ]
    },
    {
      id: "loads",
      label: "Loads",
      tabs: [
        { id:"loads",       label:"Load Board", cnt:loads.filter(l=>l.lstatus==="PENDING").length, alert:loads.some(isLeftUnload) },
        { id:"unloading",   label:"Unloading",  cnt:vehicles.filter(v=>v.vstatus==="AT_UNLOADING").length, alert:true },
        { id:"incoming",    label:"Incoming",   cnt:incomingCount, alert:false },
        { id:"tat",         label:"TAT",        cnt:null, alert:false },
        { id:"statusdelay", label:"Delays",     cnt:delayCount, alert:true },
        { id:"delivered",   label:"Delivered",  cnt:loads.filter(l=>l.lstatus==="DELIVERED").length, alert:false },
      ]
    },
    {
      id: "compliance",
      label: "Compliance",
      tabs: [
        { id:"pod",       label:"POD",       cnt:null, alert:false },
        { id:"movement",  label:"Movement",  cnt:null, alert:false },
        { id:"incidents", label:"Incidents", cnt:Object.keys(vehicleIncidents).length, alert:true },
        { id:"approvals", label:"Approvals", cnt:changeRequests.filter(r=>r.status==="PENDING").length, alert:true },
        { id:"maintlogs", label:"Maint Logs",cnt:(maintLogs||[]).length, alert:false },
        ...(isAdmin ? [{ id:"logs", label:"Logs", cnt:null, alert:false, isRoute:true }] : []),
      ]
    },
    {
      id: "settings",
      label: "Settings",
      tabs: [
        { id:"overview", label:"Overview",   cnt:null, alert:false },
        { id:"settings", label:"Settings",   cnt:null, alert:false },
        ...(isAdmin ? [{ id:"users", label:"Users", cnt:null, alert:false }] : []),
      ]
    },
  ];

  // Helper: which group does the current tab belong to?
  function groupForTab(tabId) {
    for (const g of NAV_GROUPS) {
      if (g.tabs.some(t => t.id === tabId)) return g.id;
    }
    return "loads";
  }

  // Keep navGroup in sync when tab changes externally (e.g. sidebar)
  const activeGroup = groupForTab(tab);

  // Helper: does a group have any alerts?
  function groupHasAlert(groupId) {
    const g = NAV_GROUPS.find(x => x.id === groupId);
    if (!g) return false;
    return g.tabs.some(t => t.alert && t.cnt > 0);
  }
  function groupBadgeCount(groupId) {
    const g = NAV_GROUPS.find(x => x.id === groupId);
    if (!g) return 0;
    return g.tabs.reduce((sum, t) => sum + (t.cnt || 0), 0);
  }


  return (
    <div className="tms-root" style={{display:"flex",flexDirection:"column",height:"100vh",overflow:"hidden",background:"#f2f4f7",fontFamily:"'Inter',system-ui,sans-serif",color:"#111827"}}>

      {/* Phase V: system-health banner — renders NOTHING when healthy */}
      <Suspense fallback={null}><SystemHealth /></Suspense>

      {/* HEADER */}
      <div style={{background:"#ffffff",borderBottom:"1px solid #e4e7ed",padding:"0 1.4rem",display:"flex",alignItems:"center",justifyContent:"space-between",height:54,flexShrink:0,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
        <div style={{display:"flex",alignItems:"center",gap:16,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <div style={{width:30,height:30,borderRadius:8,background:"#111827",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".9rem",flexShrink:0}}><TruckIcon size={16} color="#ffffff"/></div>
            <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,color:"#111827",letterSpacing:"-0.2px",whiteSpace:"nowrap"}}>FleetCommand</span>
          </div>
          <div style={{width:1,height:18,background:"#e4e7ed",flexShrink:0}} />
          <div title={cleanCloudStatus(syncStatus.message)} style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:500,padding:".625rem .75rem",borderRadius:12,border:`1px solid ${syncStatus.state==="error"?"#dc2626":syncStatus.state==="saving"?"#2563eb":syncStatus.state==="synced"||syncStatus.state==="ready"?"#16a34a":"#e4e7ed"}`,background:syncStatus.state==="error"?"rgba(220,38,38,0.08)":syncStatus.state==="saving"?"rgba(37,99,235,0.08)":syncStatus.state==="synced"||syncStatus.state==="ready"?"rgba(22,163,74,0.08)":"#f2f4f7",color:syncStatus.state==="error"?"#dc2626":syncStatus.state==="saving"?"#2563eb":syncStatus.state==="synced"||syncStatus.state==="ready"?"#16a34a":"#6b7280",maxWidth:260,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            ● {cleanCloudStatus(syncStatus.message)}
          </div>
        </div>
        <div style={{display:"flex",gap:"1.4rem",alignItems:"center"}}>
          {[["Avail",stats.available,"#16a34a","rgba(22,163,74,0.08)"],["On Trip",stats.inTransit,"#2563eb","rgba(37,99,235,0.08)"],["Pending",stats.pendingLoads,"#d97706","rgba(217,119,6,0.08)"],["Maint",stats.maintenance,"#dc2626","rgba(220,38,38,0.08)"]].map(([l,v,c,bg])=>(
            <div key={l} style={{display:"flex",alignItems:"center",gap:6}}>
              <div style={{width:28,height:28,borderRadius:8,background:bg,display:"flex",alignItems:"center",justifyContent:"center",fontWeight:600,fontSize:".9rem",color:c,fontFamily:"'Inter',system-ui,sans-serif"}}>{v}</div>
              <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:500,lineHeight:1}}>{l}</div>
            </div>
          ))}
          {username && (
            <div style={{display:"flex",alignItems:"center",gap:8,paddingLeft:14,borderLeft:"1px solid #e4e7ed"}}>
              <div style={{textAlign:"right"}}>
                <div style={{fontSize:".78rem",fontWeight:600,color:"#6b7280"}}>{username}</div>
                <div style={{fontSize:".68rem",color:isAdmin?"#6366f1":"#6b7280",fontWeight:500}}>{isAdmin?"Admin":"User"}</div>
              </div>
              <button onClick={handleSignOut} title="Sign out" style={{background:"#f2f4f7",border:"1px solid #e4e7ed",borderRadius:8,padding:".3rem .7rem",cursor:"pointer",fontSize:".72rem",fontWeight:600,color:"#6b7280",transition:"all .15s"}}>
                Sign out
              </button>
            </div>
          )}
        </div>
      </div>

            {/* NAV BAR — top tabs + menu */}
      {/* ══ PRIMARY NAV ROW ══ */}
      <div className="tms-topnav" style={{background:"#ffffff",borderBottom:"1px solid #e4e7ed",flexShrink:0,display:"flex",alignItems:"stretch",minWidth:0}}>
        {/* Menu button */}
        <button onClick={()=>setSidebarOpen(p=>!p)} style={{background:sidebarOpen?"#f2f4f7":"transparent",border:"none",borderRight:"1px solid #e4e7ed",color:sidebarOpen?"#111827":"#6b7280",padding:"0 1rem",cursor:"pointer",display:"flex",alignItems:"center",gap:5,flexShrink:0,transition:"all .15s"}}>
          <Menu size={18}/>
        </button>
        {/* 4 primary group buttons */}
        {NAV_GROUPS.map(g => {
          const isActive = activeGroup === g.id;
          const hasAlert = groupHasAlert(g.id);
          const badge = groupBadgeCount(g.id);
          return (
            <button key={g.id}
              onClick={()=>{
                // Navigate to first tab of group
                const firstTab = g.tabs[0];
                if (firstTab.isRoute) { navigate({to:"/logs"}); return; }
                setTab(firstTab.id);
                setSidebarOpen(false);
              }}
              style={{
                fontFamily:"'Inter',system-ui,sans-serif",
                fontSize:".84rem",
                fontWeight:isActive?600:500,
                padding:"0 1.25rem",
                border:"none",
                background:"none",
                cursor:"pointer",
                color:isActive?"#111827":"#6b7280",
                borderBottom:isActive?"2px solid #111827":"2px solid transparent",
                marginBottom:-1,
                display:"flex",
                alignItems:"center",
                gap:6,
                whiteSpace:"nowrap",
                transition:"color .12s",
                height:44,
              }}>
              {g.label}
              {badge > 0 && (
                <span style={{
                  background:hasAlert?"rgba(220,38,38,0.08)":"rgba(99,102,241,0.08)",
                  color:hasAlert?"#dc2626":"#6366f1",
                  borderRadius:12,
                  fontSize:".68rem",
                  padding:"1px 6px",
                  fontWeight:600,
                  lineHeight:1.5,
                }}>{badge}</span>
              )}
              {badge === 0 && hasAlert && (
                <span style={{width:6,height:6,borderRadius:"50%",background:"#dc2626",display:"inline-block",flexShrink:0}}/>
              )}
            </button>
          );
        })}
      </div>

      {/* ══ SUB-TAB ROW ══ */}
      <div style={{background:"#fafbfc",borderBottom:"1px solid #e4e7ed",flexShrink:0,display:"flex",alignItems:"stretch",overflowX:"auto",overflowY:"hidden",WebkitOverflowScrolling:"touch",touchAction:"pan-x",overscrollBehaviorX:"contain",minWidth:0,paddingLeft:"0.5rem"}}>
        {(NAV_GROUPS.find(g=>g.id===activeGroup)?.tabs || []).map(t => {
          const isActive = tab === t.id;
          return (
            <button key={t.id}
              onClick={()=>{
                if (t.isRoute) { navigate({to:"/logs"}); return; }
                setTab(t.id);
                setSidebarOpen(false);
              }}
              style={{
                fontFamily:"'Inter',system-ui,sans-serif",
                fontSize:".78rem",
                fontWeight:isActive?600:400,
                padding:"0 0.9rem",
                border:"none",
                background:"none",
                cursor:"pointer",
                color:isActive?"#111827":"#6b7280",
                borderBottom:isActive?"2px solid #111827":"2px solid transparent",
                marginBottom:-1,
                display:"flex",
                alignItems:"center",
                gap:5,
                whiteSpace:"nowrap",
                transition:"color .12s",
                height:36,
              }}>
              {t.label}
              {(t.cnt||0) > 0 && (
                <span style={{
                  background:t.alert?"rgba(220,38,38,0.08)":"rgba(99,102,241,0.08)",
                  color:t.alert?"#dc2626":"#6366f1",
                  borderRadius:10,
                  fontSize:".62rem",
                  padding:"1px 5px",
                  fontWeight:600,
                  lineHeight:1.5,
                }}>{t.cnt}</span>
              )}
              {(t.cnt===0||t.cnt===null) && t.alert && (
                <span style={{width:5,height:5,borderRadius:"50%",background:"#dc2626",display:"inline-block"}}/>
              )}
            </button>
          );
        })}
      </div>
            {/* CONTENT + SIDEBAR */}
      <div style={{display:"flex",flexDirection:"row",flex:(tab==="fleet"||tab==="loads")?1:"0 0 auto",overflow:"hidden",position:"relative"}}>
        {/* SIDEBAR DRAWER */}
        {sidebarOpen && (
          <>
            <div onClick={()=>setSidebarOpen(false)} style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.25)",zIndex:50,backdropFilter:"blur(1px)"}}/>
            <div style={{position:"fixed",left:0,top:0,bottom:0,width:252,background:"#ffffff",borderRight:"1px solid #e4e7ed",zIndex:51,display:"flex",flexDirection:"column",boxShadow:"4px 0 24px rgba(0,0,0,0.08)"}}>
              <div style={{padding:"1rem 1.2rem .8rem",fontWeight:600,fontSize:".78rem",color:"#111827",borderBottom:"1px solid #e4e7ed",display:"flex",alignItems:"center",gap:8}}>
                <div style={{width:24,height:24,borderRadius:6,background:"#111827",display:"flex",alignItems:"center",justifyContent:"center",fontSize:".78rem"}}><TruckIcon size={16} color="#ffffff"/></div>
                FleetCommand
              </div>
              <div style={{flex:1,overflowY:"auto",padding:".5rem .6rem"}}>
                {[
                  ["overview","","Overview",0,false],
                  ["fleet","","Fleet",vehicles.length,false],
                  ["loads","","Load Board",loads.filter(l=>l.lstatus==="PENDING").length,true],
                  ["delivered","","Delivered",loads.filter(l=>l.lstatus==="DELIVERED").length,false],
                  ["urgent","","Urgent Loads",Object.keys(urgentLoads).length,true],
                  ["delayed","","Delayed",loads.filter(l=>l.lstatus==="LATE").length,true],
                  ["approvals","","Approvals",changeRequests.filter(r=>r.status==="PENDING").length,true],
                  ["unloading","","Unloading",vehicles.filter(v=>v.vstatus==="AT_UNLOADING").length,true],
                  ["incidents","","Incidents",Object.keys(vehicleIncidents).length,true],
                  ["maintlogs","","Maint Logs",(maintLogs||[]).length,false],
                  ["tat","","TAT Tracker",0,false],
                  ["statusdelay","","Status Delay", vehicles.filter(v => { const ts = v.vstatus==="AVAILABLE"?(v.availableAfterDelivery?v.availableSince:null):v.vstatus==="SENT_FOR_LOADING"?v.sentForLoadingAt:v.vstatus==="AT_LOADING"?v.atLoadingAt:null; const thr = v.vstatus==="AT_LOADING"?15*3600*1000:2*3600*1000; return ts && (nowTick - new Date(ts).getTime()) >= thr; }).length, true],
                  ["geofences","","Geofences",0,false],
                  ["fleetmap","","Fleet Map",0,false],
                  ["pod","","POD Records",0,false],
                  ["incoming","","Incoming",incomingCount,false],
                  ["gpsissues","","GPS Issues", gpsIssueRows.noFetch.length + gpsIssueRows.unresolved.length, true],
                  ["settings","","Settings",0,false],
                ].map(([id,icon,label,cnt,warn])=>(
                  <button key={id} onClick={()=>{setTab(id);setSidebarOpen(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:".5rem .7rem",borderRadius:8,border:"none",background:tab===id?"#f2f4f7":"transparent",cursor:"pointer",marginBottom:1,textAlign:"left",transition:"background .1s"}}>
                    <span style={{width:20,display:"flex",alignItems:"center",justifyContent:"center",color:"#6b7280",flexShrink:0}}>{id==="overview"?<Eye size={15}/>:id==="fleet"?<TruckIcon size={15}/>:id==="loads"?<Package size={15}/>:id==="delivered"?<CheckCircle2 size={15}/>:id==="urgent"?<AlertTriangle size={15}/>:id==="delayed"?<Flame size={15}/>:id==="approvals"?<KeyRound size={15}/>:id==="unloading"?<PackageCheck size={15}/>:id==="incidents"?<AlertTriangle size={15}/>:id==="maintlogs"?<Wrench size={15}/>:id==="tat"?<CircleDot size={15}/>:id==="statusdelay"?<AlertTriangle size={15}/>:id==="geofences"?<MapPin size={15}/>:id==="fleetmap"?<MapPin size={15}/>:id==="pod"?<FileTextIcon size={15}/>:id==="incoming"?<PackageOpen size={15}/>:id==="gpsissues"?<CircleDot size={15}/>:id==="settings"?<Pencil size={15}/>:null}</span>
                    <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:tab===id?600:400,color:tab===id?"#111827":"#374151",flex:1}}>{label}</span>
                    {cnt>0 && <span style={{background:warn?"rgba(220,38,38,0.08)":"rgba(99,102,241,0.08)",color:warn?"#dc2626":"#6366f1",borderRadius:8,fontSize:".68rem",padding:"1px 6px",fontWeight:600}}>{cnt}</span>}
                  </button>
                ))}
                {isAdmin && (
                  <>
                    <button onClick={()=>{navigate({to:"/logs"});setSidebarOpen(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:".5rem .7rem",borderRadius:8,border:"none",background:"transparent",cursor:"pointer",marginBottom:1,textAlign:"left",transition:"background .1s"}}>
                      <span style={{fontSize:14,width:20,textAlign:"center"}}><FileTextIcon size={15}/></span>
                      <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:400,color:"#374151",flex:1}}>Audit Logs</span>
                    </button>
                    <button onClick={()=>{navigate({to:"/control"});setSidebarOpen(false);}} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:".5rem .7rem",borderRadius:8,border:"none",background:"transparent",cursor:"pointer",marginBottom:1,textAlign:"left",transition:"background .1s"}}>
                      <span style={{fontSize:14,width:20,textAlign:"center"}}><XCircle size={15}/></span>
                      <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:400,color:"#374151",flex:1}}>Control Panel</span>
                    </button>
                  </>
                )}
              </div>
              <div style={{padding:".75rem 1rem",borderTop:"1px solid #e4e7ed",fontSize:".68rem",color:"#6b7280",display:"flex",justifyContent:"space-between"}}>
                <span>FleetCommand TMS</span><span>NS Logistics</span>
              </div>
            </div>
          </>
        )}

        {/* ══════════ FLEET TAB ══════════ */}
        {tab==="fleet" && <>
          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#ffffff"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:8}}>
              Fleet Overview <span style={{color:"#111827",fontSize:".78rem",fontWeight:400,letterSpacing:0}}>{filteredV.length} vehicles</span>
            </div>
            {/* toolbar row 1 — search + status + add */}
            <div style={{display:"flex",gap:".7rem",marginBottom:".65rem",flexWrap:"wrap",alignItems:"center"}}>
              <div style={{position:"relative",flex:1,minWidth:160}}>
                <input value={fSearch} onChange={e=>setFSearch(e.target.value)} placeholder="Search vehicle, driver, route..." style={{width:"100%",background:"#ffffff",border:"1px solid var(--border)",color:"#111827",padding:".48rem .9rem .48rem 2.1rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none"}}/>
                <span style={{position:"absolute",left:".55rem",top:"50%",transform:"translateY(-50%)",color:"#111827",fontSize:14}}>🔍</span>
              </div>
              <div style={{display:"flex",gap:".3rem",flexWrap:"wrap"}}>
                {["ALL","AVAILABLE","SENT_FOR_LOADING","AT_LOADING","IN_TRANSIT","AT_UNLOADING","MAINTENANCE"].map(f=>(
                  <button key={f} onClick={()=>setFFilter(f)} style={{padding:".38rem .75rem",borderRadius:6,border:"1px solid",borderColor:fFilter===f?"#374151":"#e4e7ed",background:fFilter===f?"#374151":"#ffffff",color:fFilter===f?"#ffffff":"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase"}}>
                    {f==="ALL"?"All":VS_LABELS[f]||f}
                  </button>
                ))}
                <button onClick={()=>setFPinOnly(p=>!p)} title="Show only vehicles with assigned PIN" style={{padding:".38rem .75rem",borderRadius:6,border:"1px solid",borderColor:fPinOnly?"#16a34a":"#e4e7ed",background:fPinOnly?"#16a34a":"#ffffff",color:fPinOnly?"#ffffff":"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase",display:"inline-flex",alignItems:"center",gap:4}}>
                  <KeyRound size={12}/> PIN
                </button>
                <button onClick={()=>setFNoDriverOnly(p=>!p)} title="Show only vehicles flagged Without Driver" style={{padding:".38rem .75rem",borderRadius:6,border:"1px solid",borderColor:fNoDriverOnly?"#d97706":"#e4e7ed",background:fNoDriverOnly?"#d97706":"#ffffff",color:fNoDriverOnly?"#ffffff":"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase",display:"inline-flex",alignItems:"center",gap:4}}>
                  No Driver
                </button>
              </div>
              <label style={{background:"#ffffff",color:"#111827",border:"1px solid var(--border)",padding:".48rem 1rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",letterSpacing:0,cursor:"pointer",textTransform:"uppercase",whiteSpace:"nowrap"}}>
                ⬆ Import Excel
                <input type="file" accept=".xlsx,.xls,.xlsm,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.ms-excel" style={{display:"none"}} onChange={async e=>{
                  const file=e.target.files?.[0]; e.target.value="";
                  if(!file) return;
                  const stamp=()=>new Date().toLocaleTimeString("en-IN",{hour:"2-digit",minute:"2-digit"});
                  try{
                    const buf=await file.arrayBuffer();
                    const wb=XLSX.read(buf,{type:"array"});
                    const ws=wb.Sheets[wb.SheetNames[0]];
                    if(!ws){ setLogs(p=>[{msg:"Import: no sheet found",color:"var(--red)",t:stamp()},...p]); return; }
                    const rows=XLSX.utils.sheet_to_json(ws,{defval:"",raw:false});
                    if(!rows.length){ setLogs(p=>[{msg:"Import: sheet is empty",color:"var(--red)",t:stamp()},...p]); return; }
                    const known={vnum:["vnum","vehiclenumber","vehicleno","vehicle","number","regno","plate"],vtype:["vtype","vehicletype","type"],vstatus:["vstatus","status"],driver:["driver","drivername"],mobile:["mobile","phone","contact"],departure:["departure","from","origin","source"],destination:["destination","to","dest"],deptime:["deptime","departuretime","starttime"],eta:["eta","arrival"],notes:["notes","remarks","comment"],branch:["branch"],customer:["customer","client"]};
                    const headerKeys=Object.keys(rows[0]);
                    const norm=s=>String(s).toLowerCase().replace(/[^a-z0-9]/g,"");
                    const map={};Object.entries(known).forEach(([k,al])=>{const hk=headerKeys.find(h=>al.includes(norm(h)));if(hk) map[k]=hk;});
                    if(!map.vnum && headerKeys[0]) map.vnum=headerKeys[0];
                    const existing=new Set(vehicles.map(v=>v.vnum.toUpperCase()));
                    const added=[];let skipped=0;
                    rows.forEach(r=>{
                      const vnum=String(r[map.vnum]||"").trim().toUpperCase();
                      if(!vnum){skipped++;return;}
                      if(existing.has(vnum)){skipped++;return;}
                      existing.add(vnum);
                      const get=(k,d="")=>map[k]?String(r[map[k]]??d).trim():d;
                      added.push({...blankV(),id:"V"+Date.now().toString(36)+Math.random().toString(36).slice(2,6),vnum,vtype:get("vtype","32 FT SINGLE AXLE"),driver:get("driver"),mobile:get("mobile"),customer:get("customer")});
                    });
                    if(added.length) pushVehicles(p=>[...p,...added]);
                    setLogs(p=>[{msg:`Import: added ${added.length}, skipped ${skipped}`,color:added.length?"var(--green)":"var(--red)",t:stamp()},...p]);
                  }catch(err){
                    setLogs(p=>[{msg:"Import failed: "+err.message,color:"var(--red)",t:stamp()},...p]);
                  }
                }}/>
              </label>
              <button onClick={()=>{
                const sample=[{vnum:"HR55AB1234",vtype:"32 FT SINGLE AXLE",driver:"Ramesh",mobile:"9999999999",customer:"ACME"}];
                const ws=XLSX.utils.json_to_sheet(sample);
                const wb=XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb,ws,"Vehicles");
                XLSX.writeFile(wb,"vehicles-sample.xlsx");
              }} style={{background:"transparent",border:"none",color:"#374151",fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",textDecoration:"underline",whiteSpace:"nowrap",cursor:"pointer",padding:0}}>Sample</button>
              <button onClick={()=>{setVForm(blankV());setVEdit(false);setMobileSideOpen(true);}} style={{background:"#111827",color:"#ffffff",border:"none",padding:".48rem 1rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s",whiteSpace:"nowrap"}}>+ Add Vehicle</button>
            </div>
            {/* toolbar row 2 — branch filters */}
            <div style={{display:"flex",gap:".75rem",marginBottom:"1.1rem",alignItems:"center",background:"#ffffff",border:"1px solid var(--border)",borderRadius:8,padding:".55rem 1rem",flexWrap:"wrap"}}>
              <span style={{fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",whiteSpace:"nowrap"}}>Filter by Branch</span>
              <div style={{width:1,height:20,background:"#e4e7ed",flexShrink:0}}/>
              <div style={{display:"flex",alignItems:"center",gap:6}}>
                <span style={{fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",whiteSpace:"nowrap"}}>From</span>
                <select onChange={e=>setFBranchFilter(e.target.value)} value={fBranchFilter}
                  style={{background:fBranchFilter?"rgba(217,119,6,0.08)":"#f2f4f7",border:"1px solid",borderColor:fBranchFilter?"rgba(245,158,11,0.4)":"#e4e7ed",color:fBranchFilter?"#d97706":"#6b7280",padding:".625rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:500,outline:"none",cursor:"pointer",minWidth:130}}>
                  <option value="">All Branches</option>
                  {branches.map(b=><option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              {fBranchFilter && (
                <button onClick={()=>setFBranchFilter("")}
                  style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"3px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginLeft:"auto"}}>
                  Clear ✕
                </button>
              )}
            </div>
            {/* advanced filters moved to Load Board */}
            {/* table */}
            {filteredV.length===0 ? (
              <div style={{textAlign:"center",padding:"3rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>No vehicles found.</div>
            ) : (
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{background:"#f2f4f7"}}>
                      {["Vehicle #","Type","Status","Driver","GPS Location","Route","ETA","Assigned Load","Actions"].map(h=>(
                        <th key={h} style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border2)",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pagedFV.map(v => {
                      const aLoad = v.loadId ? loadById.get(String(v.loadId)) ?? null : null;
                      return (
                        <tr key={v.id} style={{borderBottom:"1px solid var(--border)"}}>
                          <td style={{padding:".625rem .75rem"}}>
                            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#6366f1",letterSpacing:0}}>{v.vnum}</div>
                            {v.notes && <div style={{fontSize:".68rem",color:"#111827",maxWidth:90,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}} title={v.notes}>{v.notes}</div>}
                          </td>
                          <td style={{padding:".625rem .75rem"}}><span style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",padding:"2px 5px",borderRadius:6,border:"1px solid var(--border)",color:"#6b7280"}}>{v.vtype}</span></td>
                          <td style={{padding:".625rem .75rem"}}>
                            <span title="Click to change status" style={{position:"relative",display:"inline-flex",alignItems:"center",gap:4,padding:"3px 8px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer",
                              background:v.vstatus==="IN_TRANSIT"?"rgba(37,99,235,0.08)":v.vstatus==="AVAILABLE"?"rgba(22,163,74,0.08)":v.vstatus==="AT_LOADING"?"rgba(217,119,6,0.08)":v.vstatus==="SENT_FOR_LOADING"?"rgba(99,102,241,0.08)":v.vstatus==="AT_UNLOADING"?"#fff1f2":v.vstatus==="EMPTY"?"rgba(37,99,235,0.08)":v.vstatus==="MAINTENANCE"?"rgba(220,38,38,0.08)":v.vstatus==="DELIVERED"?"rgba(22,163,74,0.08)":"#f2f4f7",
                              color:v.vstatus==="IN_TRANSIT"?"#2563eb":v.vstatus==="AVAILABLE"?"#16a34a":v.vstatus==="AT_LOADING"?"#d97706":v.vstatus==="SENT_FOR_LOADING"?"#6366f1":v.vstatus==="AT_UNLOADING"?"#d97706":v.vstatus==="EMPTY"?"#16a34a":v.vstatus==="MAINTENANCE"?"#dc2626":v.vstatus==="DELIVERED"?"#059669":"#6b7280"
                            }}>
                              <span style={{width:5,height:5,borderRadius:"50%",background:"currentColor",opacity:.8,flexShrink:0}}/>
                              {VS_LABELS[v.vstatus]}
                              <span style={{marginLeft:2,opacity:.7,fontSize:".68rem"}}>▾</span>
                              <select onChange={e=>{ if(e.target.value) quickVS(v.id,e.target.value); }} value="" aria-label="Change status" style={{position:"absolute",inset:0,opacity:0,cursor:"pointer",border:"none",appearance:"none"}}>
                                <option value="" disabled>Change…</option>
                                {Object.entries(VS_LABELS).map(([k,lbl])=><option key={k} value={k}>{lbl}</option>)}
                              </select>
                            </span>
                            {vehicleIncident[v.id] && (
                              <div style={{marginTop:4,display:"inline-flex",alignItems:"center",background:"rgba(220,38,38,0.12)",border:"1px solid rgba(220,38,38,0.45)",color:"#dc2626",padding:"2px 7px",borderRadius:6,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                                {vehicleIncident[v.id]==="ACCIDENT"?"Accident":"Breakdown"}
                              </div>
                            )}
                          </td>
                          <td style={{padding:".625rem .75rem"}}>
                            <div style={{fontWeight:600,fontSize:".84rem"}}>{v.driver||"—"}</div>
                            {v.mobile && <div style={{fontSize:".68rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>{v.mobile}</div>}
                          </td>
                          <td style={{padding:".625rem .75rem",maxWidth:220,minWidth:170,verticalAlign:"top"}}>
                            {(() => {
                              const vk = gpsVehicleKey(v.vnum); const vkAlt = gpsVehicleKeyAlt(v.vnum);
                              const g = (gpsMap[vk] || gpsMap[vkAlt]);
                              if (!g) return <span style={{color:"#6b7280",fontSize:".72rem"}}>No GPS</span>;
                              const geoStatus = geoStatusMap[vk];
                              const coordText = g.lat!=null && g.lng!=null ? `${g.lat.toFixed(4)}, ${g.lng.toFixed(4)}` : "—";
                              const addr = g.address || addrMap[vk] || (geoStatus?.failed ? `${coordText} (address retrying)` : `${coordText} (resolving…)`);
                                return (
                                  <div style={{display:"flex",flexDirection:"column",gap:2,maxWidth:"100%"}}>
                                    <div style={{fontSize:".72rem",color:"#111827",lineHeight:1.35,wordBreak:"break-word",overflowWrap:"break-word",maxWidth:"100%"}} title={addr}>{addr}</div>
                                    <div style={{display:"flex",gap:6,alignItems:"center",fontSize:".68rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>
                                      <span>{g.status}</span>
                                      {geoStatus?.attempts && !g.address && !addrMap[vk] ? <span>{geoStatus.failed ? "Retrying" : `Retry ${geoStatus.attempts}`}</span> : null}
                                      {g.lat && g.lng && (
                                        <a href={`https://www.google.com/maps?q=${g.lat},${g.lng}`} target="_blank" rel="noreferrer" style={{color:"#374151",textDecoration:"underline"}}>Map</a>
                                      )}
                                    </div>
                                    {g.updatedAt && <div style={{fontSize:".68rem",color:"#6b7280"}}>{fmtDT(g.updatedAt)}</div>}
                                  </div>
                                );
                            })()}
                          </td>
                          <td style={{padding:".625rem .75rem"}}>

                            {aLoad ? (
                              <>
                                <div style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:".84rem",fontWeight:600,color:"#111827"}}>
                                  <span title={aLoad.origin}>{(aLoad.origin||"").split(",")[0].trim()}</span>
                                  <span style={{color:"#374151",fontWeight:600}}>→</span>
                                  <span title={aLoad.dest}>{(aLoad.dest||"").split(",")[0].trim()}</span>
                                </div>
                                <div style={{fontSize:".68rem",color:"#374151",fontFamily:"'Inter',system-ui,sans-serif",marginTop:2}}>{aLoad.lid}</div>
                              </>
                            ) : (
                              <span style={{color:"#6b7280"}}>—</span>
                            )}
                          </td>
                          <td style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",color:"#111827"}}>{fmtDT(v.eta)}</td>
                          <td style={{padding:".625rem .75rem"}}>
                            {aLoad ? <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:6,padding:"2px 6px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,color:"#6b7280"}}>{aLoad.lid}</span>
                              : <span style={{color:"#6b7280",fontSize:".78rem"}}>—</span>}
                          </td>
                          <td style={{padding:".625rem .75rem"}}>
                            <div style={{display:"flex",flexDirection:"column",gap:".25rem",alignItems:"flex-start"}}>
                              <div style={{display:"flex",gap:".3rem"}}>
                                <button onClick={()=>editV(v)} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"3px 7px",borderRadius:6,cursor:"pointer",fontSize:".68rem"}}>Edit</button>
                                <button onClick={()=>setDelV(v.id)} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"3px 7px",borderRadius:6,cursor:"pointer",fontSize:".68rem"}}>Del</button>
                              </div>
                              <button onClick={()=>{ setPinModal(v); setPinInput(getPin(v.vnum) || ""); }} title={getPin(v.vnum)?"PIN assigned — click to edit":"Set driver PIN"} style={{display:"inline-flex",alignItems:"center",gap:4,background:getPin(v.vnum)?"#16a34a":"transparent",border:`1px solid ${getPin(v.vnum)?"#16a34a":"#e4e7ed"}`,color:getPin(v.vnum)?"#ffffff":"#111827",padding:"3px 8px",borderRadius:6,cursor:"pointer",fontSize:".68rem",fontWeight:600,letterSpacing:0,boxShadow:getPin(v.vnum)?"0 0 0 2px rgba(22,163,74,.18)":"none"}}>{getPin(v.vnum)&&<span style={{width:6,height:6,borderRadius:"50%",background:"#16a34a",display:"inline-block"}}/>}<KeyRound size={11}/>PIN{getPin(v.vnum)?" ✓":""}</button>
                              {(() => {
                                const on = !!v.withoutDriver;
                                const passed = on && v.withoutDriverEta && Date.now() > new Date(v.withoutDriverEta).getTime();
                                const bg = on ? (passed ? "#dc2626" : "#d97706") : "transparent";
                                const bc = on ? (passed ? "#dc2626" : "#d97706") : "#e4e7ed";
                                const col = on ? "#ffffff" : "#111827";
                                return (
                                  <button onClick={()=>openWithoutDriverModal(v)} title={on ? `Without driver · ETA ${new Date(v.withoutDriverEta).toLocaleString("en-IN")}` : "Mark without driver + ETA"} style={{display:"inline-flex",alignItems:"center",gap:4,background:bg,border:`1px solid ${bc}`,color:col,padding:"3px 8px",borderRadius:6,cursor:"pointer",fontSize:".68rem",fontWeight:600,letterSpacing:0}}>{on ? (passed ? "ETA Passed" : "No Driver") : "No Driver"}</button>
                                );
                              })()}
                            </div>
                          </td>

                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                {/* Pagination */}
                <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:".7rem .5rem",borderTop:"1px solid var(--border)",flexWrap:"wrap",gap:".5rem"}}>
                  <div style={{display:"flex",alignItems:"center",gap:".5rem",fontSize:".78rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>
                    <span style={{fontWeight:600,letterSpacing:0,textTransform:"uppercase",fontSize:".68rem"}}>Per page</span>
                    <select value={fPerPage} onChange={e=>{setFPerPage(Number(e.target.value));setFPage(1);}} style={{background:"#f2f4f7",border:"1px solid var(--border)",padding:".3rem .5rem",borderRadius:6,fontSize:".78rem",cursor:"pointer",outline:"none",fontFamily:"'Inter',system-ui,sans-serif"}}>
                      {[10,20,50,100].map(n=><option key={n} value={n}>{n}</option>)}
                    </select>
                    <span style={{color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif"}}>Showing {(fPage-1)*fPerPage + 1}–{Math.min(fPage*fPerPage, filteredV.length)} of {filteredV.length}</span>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:".35rem"}}>
                    <button onClick={()=>setFPage(1)} disabled={fPage<=1} style={{padding:".35rem .6rem",border:"1px solid var(--border)",background:"#f2f4f7",borderRadius:6,cursor:fPage<=1?"not-allowed":"pointer",opacity:fPage<=1?.5:1,fontSize:".72rem",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>«</button>
                    <button onClick={()=>setFPage(p=>Math.max(1,p-1))} disabled={fPage<=1} style={{padding:".35rem .6rem",border:"1px solid var(--border)",background:"#f2f4f7",borderRadius:6,cursor:fPage<=1?"not-allowed":"pointer",opacity:fPage<=1?.5:1,fontSize:".72rem",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>‹</button>
                    <span style={{fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",padding:"0 .3rem",color:"#111827"}}>Page {fPage} / {fTotalPages}</span>
                    <button onClick={()=>setFPage(p=>Math.min(fTotalPages,p+1))} disabled={fPage>=fTotalPages} style={{padding:".35rem .6rem",border:"1px solid var(--border)",background:"#f2f4f7",borderRadius:6,cursor:fPage>=fTotalPages?"not-allowed":"pointer",opacity:fPage>=fTotalPages?.5:1,fontSize:".72rem",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>›</button>
                    <button onClick={()=>setFPage(fTotalPages)} disabled={fPage>=fTotalPages} style={{padding:".35rem .6rem",border:"1px solid var(--border)",background:"#f2f4f7",borderRadius:6,cursor:fPage>=fTotalPages?"not-allowed":"pointer",opacity:fPage>=fTotalPages?.5:1,fontSize:".72rem",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>»</button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* Fleet Side Panel */}
          <div className={`tms-side-panel ${mobileSideOpen?"tms-side-open":""}`} style={{width:355,flexShrink:0,background:"#ffffff",borderLeft:"1px solid var(--border)",overflowY:"auto",display:"flex",flexDirection:"column"}}>
            <button onClick={()=>setMobileSideOpen(false)} className="tms-side-close" style={{display:"none",position:"sticky",top:0,alignSelf:"flex-end",margin:".4rem",background:"#111827",color:"#ffffff",border:"none",borderRadius:6,padding:".35rem .7rem",fontSize:".78rem",fontWeight:600,cursor:"pointer"}}>✕ Close</button>
            <div style={{padding:".9rem 1.2rem",borderBottom:"1px solid var(--border)",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",background:"#f2f4f7"}}>{vEdit?"EDIT VEHICLE":"ADD NEW VEHICLE"}</div>
            <div style={{padding:"1rem 1.2rem",flex:1}}>
              {[
                [["Vehicle Number","vnum","text","e.g. TRK-001"],["Vehicle Type","vtype","select",V_TYPES]],
                [["Customer","customer","select",[""].concat(customers)],["Driver Name","driver","text","Full Name"]],
                [["Mobile","mobile","text","+91 98765…"]],
              ].map((row,ri)=>(
                <div key={ri} style={{display:"grid",gridTemplateColumns:row.length>1?"1fr 1fr":"1fr",gap:".6rem",marginBottom:".75rem"}}>
                  {row.map(([label,field,type,opts])=>(
                    <div key={field}>
                      <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:3}}>{label}</label>
                      {type==="select" ? (
                        <select value={vForm[field]} onChange={e=>setVForm(p=>({...p,[field]:e.target.value}))} style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".46rem .65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",transition:"border-color .15s"}}>
                          {Array.isArray(opts) && opts.map(o=>typeof o==="string"
                            ? <option key={o} value={o}>{o}</option>
                            : <option key={o[0]} value={o[0]}>{o[1]}</option>)}
                        </select>
                      ) : (
                        <input type={type} value={vForm[field]} onChange={e=>setVForm(p=>({...p,[field]:e.target.value}))} placeholder={opts} style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".46rem .65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",transition:"border-color .15s"}}/>
                      )}
                    </div>
                  ))}
                </div>
              ))}
              <button onClick={saveVehicle} style={{width:"100%",background:"#111827",color:"#080b0f",border:"none",padding:".6rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",marginTop:".2rem",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s"}}>SAVE VEHICLE</button>
              {vEdit && <button onClick={()=>{setVForm(blankV());setVEdit(false);}} style={{width:"100%",background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".46rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",cursor:"pointer",marginTop:".3rem",textTransform:"uppercase"}}>CANCEL</button>}
            </div>
            <div style={{borderTop:"1px solid var(--border)"}}>
              <div style={{padding:".7rem 1.2rem .35rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>Activity Log</div>
              <div style={{padding:"0 1.2rem .7rem",display:"flex",flexDirection:"column",gap:".45rem"}}>
                {logs.map((l,i)=>(
                  <div key={i} style={{display:"flex",gap:".55rem",alignItems:"flex-start"}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:l.color,marginTop:4,flexShrink:0}}/>
                    <div><div style={{fontSize:".72rem",color:"#6b7280",lineHeight:1.4}}>{l.msg}</div><div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",color:"#111827"}}>{l.t}</div></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </>}

        {/* ══════════ LOADS TAB ══════════ */}
        {/* Mount-persistence: once mounted, stay mounted across tab switches so
            coming back is instant. We toggle visibility via display:contents/none
            so layout (flex children) is unaffected. */}
        {(loadsTabMountedRef.current = loadsTabMountedRef.current || tab==="loads") && <div style={{display: tab==="loads" ? "contents" : "none"}}>

          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
              Load Board <span style={{color:"#111827",fontSize:".78rem",fontWeight:400,letterSpacing:0}}>{filteredLForPage.length} loads{lbTotalPages>1?` · Page ${lbCurPage} of ${lbTotalPages}`:""}</span>
              <div style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:8}}>
                <div className="lb-view-toggle">
                  <button className={"lb-view-btn"+(lbViewMode==="table"?" active":"")} onClick={()=>setLbViewModePersist("table")} title="Table view">⊞ Table</button>
                  <button className={"lb-view-btn"+(lbViewMode==="cards"?" active":"")} onClick={()=>setLbViewModePersist("cards")} title="Card view">▦ Cards</button>
                </div>
                <button onClick={exportLoadBoard} style={{background:"#374151",color:"#ffffff",border:"none",padding:".42rem .9rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s"}}>⬇ Export</button>
              </div>
            </div>
            {/* Row 1: Search + Status filters + Add */}
            <div style={{display:"flex",gap:".7rem",marginBottom:".6rem",flexWrap:"wrap",alignItems:"center"}}>
              <div style={{position:"relative",flex:1,minWidth:160}}>
                <input value={lSearch} onChange={e=>setLSearch(e.target.value)} placeholder="Search load ID, commodity, customer..." style={{width:"100%",background:"#ffffff",border:"1px solid var(--border)",color:"#111827",padding:".48rem .9rem .48rem 2.1rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none"}}/>
                <span style={{position:"absolute",left:".55rem",top:"50%",transform:"translateY(-50%)",color:"#111827",fontSize:14}}>🔍</span>
              </div>
              <button onClick={()=>{setLForm(newLoadDraft());setLEdit(false);setMobileSideOpen(true);}} style={{background:"#374151",color:"#ffffff",border:"none",padding:".48rem 1rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s",whiteSpace:"nowrap"}}>+ Add Load</button>
            </div>
            {/* Row 2: Branch / Customer / Vehicle Type dropdowns + active filter tags */}
            <div style={{display:"flex",gap:".6rem",marginBottom:"1rem",flexWrap:"wrap",alignItems:"center"}}>
              {/* Branch */}
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",whiteSpace:"nowrap"}}>Branch</span>
                <select value={lBranch} onChange={e=>setLBranch(e.target.value)} style={{background:"#ffffff",border:"1px solid",borderColor:lBranch?"#2563eb":"#e4e7ed",color:lBranch?"#2563eb":"#6b7280",padding:".625rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",cursor:"pointer",minWidth:110}}>
                  <option value="">All</option>
                  {loadBranches.map(b=><option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              {/* Customer */}
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",whiteSpace:"nowrap"}}>Customer</span>
                <select value={lCustomer} onChange={e=>setLCustomer(e.target.value)} style={{background:"#ffffff",border:"1px solid",borderColor:lCustomer?"#2563eb":"#e4e7ed",color:lCustomer?"#2563eb":"#6b7280",padding:".625rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",cursor:"pointer",minWidth:140}}>
                  <option value="">All</option>
                  {loadCustomers.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              {/* Vehicle Type */}
              <div style={{display:"flex",alignItems:"center",gap:5}}>
                <span style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",whiteSpace:"nowrap"}}>Vehicle Type</span>
                <select value={lVType} onChange={e=>setLVType(e.target.value)} style={{background:"#ffffff",border:"1px solid",borderColor:lVType?"#2563eb":"#e4e7ed",color:lVType?"#2563eb":"#6b7280",padding:".625rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",cursor:"pointer",minWidth:120}}>
                  <option value="">All</option>
                  {loadVTypes.map(v=><option key={v} value={v}>{v}</option>)}
                </select>
              </div>
              {/* Active filter tags + clear */}
              {(lBranch||lCustomer||lVType) && (
                <div style={{display:"flex",gap:".3rem",flexWrap:"wrap",alignItems:"center"}}>
                  {lBranch && <span style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:12,padding:"2px 8px",fontSize:".72rem",color:"#374151",fontFamily:"'Inter',system-ui,sans-serif",display:"inline-flex",alignItems:"center",gap:4}}>{lBranch} <span style={{cursor:"pointer",fontWeight:600}} onClick={()=>setLBranch("")}>×</span></span>}
                  {lCustomer && <span style={{background:"rgba(34,197,94,0.06)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:12,padding:"2px 8px",fontSize:".72rem",color:"var(--green)",fontFamily:"'Inter',system-ui,sans-serif",display:"inline-flex",alignItems:"center",gap:4}}>👤 {lCustomer} <span style={{cursor:"pointer",fontWeight:600}} onClick={()=>setLCustomer("")}>×</span></span>}
                  {lVType && <span style={{background:"rgba(217,119,6,0.08)",border:"1px solid rgba(245,158,11,0.3)",borderRadius:12,padding:"2px 8px",fontSize:".72rem",color:"#6366f1",fontFamily:"'Inter',system-ui,sans-serif",display:"inline-flex",alignItems:"center",gap:4}}>{lVType} <span style={{cursor:"pointer",fontWeight:600}} onClick={()=>setLVType("")}>×</span></span>}
                  <button onClick={()=>{setLBranch("");setLCustomer("");setLVType("");}} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"2px 7px",borderRadius:12,fontSize:".68rem",cursor:"pointer"}}>Clear all</button>
                </div>
              )}
            </div>
            {/* Row 3: Advanced filters + Export (moved from Fleet) */}
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(140px,1fr))",gap:".5rem",marginBottom:".9rem",alignItems:"end",background:"#ffffff",border:"1px solid var(--border)",borderRadius:8,padding:".625rem .75rem"}}>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>Vehicle Number/ID</label>
                <input value={fVehFilter} onChange={e=>setFVehFilter(e.target.value)} placeholder="e.g. HR55…" style={{width:"100%",padding:".4rem .55rem",borderRadius:6,border:"1px solid var(--border)",background:"#f2f4f7",fontSize:".78rem",outline:"none"}}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>From City</label>
                <input value={fFromCityFilter} onChange={e=>setFFromCityFilter(e.target.value)} placeholder="Origin city" style={{width:"100%",padding:".4rem .55rem",borderRadius:6,border:"1px solid var(--border)",background:"#f2f4f7",fontSize:".78rem",outline:"none"}}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>To City</label>
                <input value={fToCityFilter} onChange={e=>setFToCityFilter(e.target.value)} placeholder="Destination city" style={{width:"100%",padding:".4rem .55rem",borderRadius:6,border:"1px solid var(--border)",background:"#f2f4f7",fontSize:".78rem",outline:"none"}}/>
              </div>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>Customer</label>
                <select value={fCustomerFilter} onChange={e=>setFCustomerFilter(e.target.value)} style={{width:"100%",padding:".4rem .55rem",borderRadius:6,border:"1px solid var(--border)",background:"#f2f4f7",fontSize:".78rem",outline:"none"}}>
                  <option value="">All</option>
                  {customers.map(c=><option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>Branch</label>
                <select value={lbFleetBranchFilter} onChange={e=>setLbFleetBranchFilter(e.target.value)} style={{width:"100%",padding:".4rem .55rem",borderRadius:6,border:"1px solid var(--border)",background:"#f2f4f7",fontSize:".78rem",outline:"none"}}>
                  <option value="">All Branches</option>
                  {branches.map(b=><option key={b} value={b}>{b}</option>)}
                </select>
              </div>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>Vehicle Status</label>
                <select value={fFilter} onChange={e=>setFFilter(e.target.value)} style={{width:"100%",padding:".4rem .55rem",borderRadius:6,border:"1px solid var(--border)",background:"#f2f4f7",fontSize:".78rem",outline:"none"}}>
                  <option value="ALL">All Statuses</option>
                  {Object.entries(VS_LABELS).filter(([k])=>k!=="DELIVERED").map(([k,lbl])=><option key={k} value={k}>{lbl}</option>)}
                </select>
              </div>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>Date From</label>
                <DateField value={fDateFrom} onChange={(val)=>setFDateFrom(val)} />
              </div>
              <div>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:3}}>Date To</label>
                <DateField value={fDateTo} onChange={(val)=>setFDateTo(val)} />
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <label style={{display:"flex",alignItems:"center",gap:5,fontSize:".72rem",cursor:"pointer",color:"#111827"}}>
                  <input type="checkbox" checked={fPending} onChange={e=>setFPending(e.target.checked)}/> Pending (unassigned)
                </label>
                <label style={{display:"flex",alignItems:"center",gap:5,fontSize:".72rem",cursor:"pointer",color:"#111827"}}>
                  <input type="checkbox" checked={fPreTransit} onChange={e=>setFPreTransit(e.target.checked)}/> Pre-Transit
                </label>
                <label style={{display:"flex",alignItems:"center",gap:5,fontSize:".72rem",cursor:"pointer",color:"#111827"}}>
                  <input type="checkbox" checked={fRpdc} onChange={e=>setFRpdc(e.target.checked)}/> RPDC
                </label>
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:4}}>
                <button onClick={exportLoadBoard} style={{background:"#374151",color:"#ffffff",border:"none",padding:".48rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s"}}>⬇ Export</button>
                <button onClick={()=>{
                  setFVehFilter(""); setFFromCityFilter(""); setFToCityFilter(""); setFCustomerFilter("");
                  setLbFleetBranchFilter(""); setFFilter("ALL"); setFDateFrom(""); setFDateTo("");
                  setFPending(false); setFPreTransit(false);
                }} style={{background:"transparent",border:"1px solid var(--border)",color:"#6b7280",padding:".4rem",borderRadius:6,fontSize:".72rem",cursor:"pointer",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,textTransform:"uppercase"}}>Clear All</button>
              </div>
            </div>
            {(() => {
              // Group filtered loads by resolved branch, sorted by count desc
              const BAR_BRANCHES_BASE = ["Gurgaon","Kharkhoda","Manesar","Bangalore","Ahmedabad","Hyderabad","Siliguri","Nagpur","Chennai","Dahej","Ludhiana/Ambala"];
              const groupMap = {};
              const isMultiCons = (l) => (l.consignees||[]).filter(Boolean).length > 1;
              const multiCount = filteredL.filter(isMultiCons).length;
              const leftUnloadCount = filteredL.filter(isLeftUnload).length;
              pagedL.forEach(l => {
                if (lbOnlyMulti && !isMultiCons(l)) return;
                if (lbOnlyLeftUnload && !isLeftUnload(l)) return;
                const b = resolveLoadBranch(l);
                (groupMap[b] = groupMap[b] || []).push(l);
              });
              // Chip counts: derived from the full filtered set (ignores the
              // branch chip itself and pagination), so every chip shows its
              // true total regardless of which branch is currently selected.
              const chipCountMap = {};
              let chipTotal = 0;
              filteredL.forEach(l => {
                if (lbOnlyMulti && !isMultiCons(l)) return;
                if (lbOnlyLeftUnload && !isLeftUnload(l)) return;
                const b = resolveLoadBranch(l);
                chipCountMap[b] = (chipCountMap[b] || 0) + 1;
                chipTotal++;
              });
              const branchesInData = Object.keys(chipCountMap);
              const barBranches = Array.from(new Set([...BAR_BRANCHES_BASE, ...branchesInData]));
              const visibleGroups = Object.entries(groupMap)
                .filter(([b]) => !lbBranchChip || b === lbBranchChip)
                .sort((a,b) => b[1].length - a[1].length);

              const renderRow = (l) => {
                const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
                const queuedVeh = (!av && l.lstatus==="QUEUED" && l.queuedVehicleId) ? vehicleById.get(String(l.queuedVehicleId)) ?? null : null;
                const blockingLoad = (queuedVeh && l.queuedBehindLoadId) ? loadById.get(String(l.queuedBehindLoadId)) ?? null : null;
                const queuedText = queuedVeh ? `Queued - ${queuedVeh.vnum} - ${VS_LABELS[queuedVeh.vstatus]||queuedVeh.vstatus} - ${blockingLoad?.dest||"—"} - ${blockingLoad?.lid||"—"}` : "";
                const shortCity = (c) => (c||"").split(",")[0].trim() || "—";
                const gps = av ? (gpsMap[gpsVehicleKey(av.vnum)] || gpsMap[gpsVehicleKeyAlt(av.vnum)]) : null;
                const openMap = () => openGpsMap(av, l.lid, l.id);
                const isValidated = !!l.validated;
                const hasIncidentBg = l.vehicleId && vehicleIncidents[l.vehicleId];
                const isUrgent = urgentLoads[l.id];
                const leftUn = isLeftUnload(l);
                return (
                  <Fragment key={l.id}>
                  {leftUn && (
                    <tr style={{background:"rgba(217,119,6,0.08)",borderTop:"1px solid #e4e7ed"}}>
                      <td colSpan={8} style={{padding:".5rem .75rem"}}>
                        <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                          <span style={{color:"#d97706",fontWeight:600,fontSize:".72rem",letterSpacing:0,textTransform:"uppercase"}}>Left Unloading</span>
                          <span style={{color:"#d97706",fontSize:".72rem"}}>
                            {l.vehicleId && vehicleById.get(String(l.vehicleId))?.vnum ? `${vehicleById.get(String(l.vehicleId)).vnum} ` : ""}
                            drove away from <b>{l.leftUnloadingDest||l.dest||"destination"}</b>
                            {l.leftUnloadingFromKm!=null?` (${l.leftUnloadingFromKm} km from destination)`:""} · {fmtLeftUnloadAgo(l.leftUnloadingAt)} — not marked delivered.
                          </span>
                          <span style={{marginLeft:"auto",display:"flex",gap:6}}>
                            {l.vehicleId && vehicleById.get(String(l.vehicleId)) && (
                              <button onClick={()=>quickVS(vehicleById.get(String(l.vehicleId)).id,"DELIVERED", l.id)} style={{background:"transparent",border:"1px solid #16a34a",color:"#16a34a",padding:"3px 10px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase"}}>Mark Delivered</button>
                            )}
                            <button onClick={()=>ackLeftUnload(l.id)} title="Acknowledge — not delivered, hide warning" style={{background:"transparent",border:"1px solid #e4e7ed",color:"#6b7280",padding:"3px 10px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase"}}>Dismiss</button>
                          </span>
                        </div>
                      </td>
                    </tr>
                  )}
                  <tr className="lb-row" style={{borderBottom:"1px solid var(--border)",background:hasIncidentBg?"rgba(234,88,12,0.16)":isUrgent?"rgba(220,38,38,0.18)":"transparent",borderLeft:hasIncidentBg?"3px solid #d97706":isUrgent?"3px solid #dc2626":"3px solid transparent"}}>

                    <td style={{padding:".625rem .75rem"}}>
                      {l.customer ? <div style={{fontSize:".84rem",fontWeight:600,color:"#111827"}}>{l.customer}</div> : <span style={{color:"#6b7280"}}>—</span>}
                      <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",color:"#6b7280",marginTop:2}}>{l.lid}</div>
                      {l.pickup && <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",color:"#6b7280",marginTop:2}} title="Pickup date">📅 {fmtDT(l.pickup)}</div>}
                    </td>

                    <td style={{maxWidth:130}}>
                      <div title={l.origin} style={{fontSize:".84rem",fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shortCity(l.origin)}</div>
                    </td>
                    <td style={{maxWidth:150}}>
                      <div title={l.dest} style={{fontSize:".84rem",fontWeight:600,color:"#111827",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{shortCity(l.dest)}</div>
                      {l.consignees?.length > 0 && (() => {
                        const cons = l.consignees.filter(Boolean);
                        const dels = stopsFor(l);
                        const delCount = cons.filter((c,i)=> !!dels[i]?.delivered).length;
                        const isOpen = !!expandedConsignees[l.id];
                        return (
                          <div style={{marginTop:3}}>
                            <button
                              type="button"
                              onClick={()=>setExpandedConsignees(p=>({...p,[l.id]:!p[l.id]}))}
                              title={cons.join(", ")}
                              style={{display:"inline-flex",alignItems:"center",gap:4,background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:6,padding:"1px 7px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,color:"#6b7280",cursor:"pointer"}}>
                              C - {cons.length}{delCount>0?` · ✓${delCount}`:""} {isOpen?"▴":"▾"}
                            </button>
                            {isOpen && (
                              <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:3,background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:6,padding:"5px 7px",maxWidth:260}}>
                                {cons.map((city,i) => {
                                  const d = dels[i] || {};
                                  const delivered = !!d.delivered;
                                  return (
                                    <div key={`lbcons-${l.id}-${i}`} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6,fontSize:".68rem"}}>
                                      <span style={{color:"#111827",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{i+1}. {city}</span>
                                      {delivered ? (
                                        <button onClick={()=>setConsigneeDelivered(l.id,i,false)} title={d.deliveredAt?`Delivered ${fmtDT(d.deliveredAt)} · click to undo`:"Undo delivered"} style={{background:"rgba(34,197,94,0.18)",border:"1px solid rgba(34,197,94,0.5)",color:"#16a34a",padding:"1px 6px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",whiteSpace:"nowrap"}}>✓ {d.deliveredAt?fmtDT(d.deliveredAt):"Delivered"}</button>
                                      ) : (
                                        <button onClick={()=>markConsigneeDeliveredWithPrompt(l.id,i)} title="Mark this consignee as delivered" style={{background:"transparent",border:"1px solid #16a34a",color:"#16a34a",padding:"1px 6px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",whiteSpace:"nowrap"}}>Mark Delivered</button>
                                      )}
                                    </div>
                                  );
                                })}

                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>
                    <td style={{padding:".625rem .75rem"}}>
                      {av ? (
                        <div style={{display:"flex",flexDirection:"column",gap:3,alignItems:"flex-start"}}>
                          <span style={{display:"inline-flex",alignItems:"center",background:"#f9fafb",border:"1px solid #e5e7eb",borderRadius:6,padding:"2px 8px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,color:"#374151"}}>{av.vnum}</span>
                          <button onClick={openMap} title={gps?.lat!=null?"View on map":"No live GPS yet"} disabled={!(gps?.lat!=null&&gps?.lng!=null)} style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(14,165,233,0.06)",border:"1px solid rgba(14,165,233,0.25)",color:"#374151",padding:"1px 5px",borderRadius:6,cursor:gps?.lat!=null?"pointer":"not-allowed",fontSize:".68rem",fontWeight:600,opacity:gps?.lat!=null?1:.45}}>
                            <MapPin size={10}/> GPS
                          </button>
                        </div>
                      ) : queuedVeh ? (
                        <span style={{display:"inline-flex",alignItems:"center",background:"#f2f4f7",border:"1px solid var(--border2)",borderRadius:6,padding:"2px 8px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,color:"#6b7280"}}>{queuedVeh.vnum}</span>
                      ) : (<span style={{color:"#6b7280",fontSize:".78rem"}}>—</span>)}
                    </td>
                    <td style={{padding:".625rem .75rem"}}>
                      {av ? (
                        <div style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:4}}>
                        <VStatusPill status={av.vstatus} withDropdown onChange={(v)=>quickVS(av.id, v, l.id)} />

                        {vehicleIncident[av.id] && (
                          <div style={{display:"inline-flex",alignItems:"center",background:"rgba(220,38,38,0.12)",border:"1px solid rgba(220,38,38,0.45)",color:"#dc2626",padding:"2px 7px",borderRadius:6,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                            {vehicleIncident[av.id]==="ACCIDENT"?"Accident":"Breakdown"}
                          </div>
                        )}
                        {av.withoutDriver && (() => {
                          const passed = av.withoutDriverEta && Date.now() > new Date(av.withoutDriverEta).getTime();
                          const etaTxt = av.withoutDriverEta ? new Date(av.withoutDriverEta).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
                          return (
                            <div title={`Without driver · Driver ETA ${etaTxt}`} style={{display:"inline-flex",alignItems:"center",gap:4,background:passed?"rgba(220,38,38,0.08)":"rgba(217,119,6,0.08)",border:`1px solid ${passed?"#dc2626":"#fb923c"}`,color:passed?"#dc2626":"#d97706",padding:"2px 7px",borderRadius:6,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                              {passed ? `No Driver · ETA Passed` : `No Driver · ETA ${etaTxt}`}
                            </div>
                          );
                        })()}
                        {av.vstatus==="IN_TRANSIT" && (() => {
                          const { targetAt, arrivalAt } = loadDerived.get(String(l.id))?.tat || computeTat(l, av, cityCoords, gpsMap);
                          if (!targetAt || !arrivalAt) return null;
                          const lateHours = (arrivalAt - targetAt) / 3600000;
                          if (!(lateHours > 4)) return null;
                          return (
                            <div title="Same value as TAT Tracker" style={{display:"inline-flex",alignItems:"center",gap:5,color:"#b91c1c",fontSize:".66rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:500,letterSpacing:0}}>
                              <span style={{width:5,height:5,borderRadius:"50%",background:"#dc2626",flexShrink:0}}/>
                              Delayed {lateHours.toFixed(1)}h
                            </div>
                          );
                        })()}
                        </div>
                      ) : queuedVeh ? (
                        <span title={`Waiting for ${queuedVeh.vnum} to free up from ${blockingLoad?.lid||""}`} style={{display:"inline-flex",alignItems:"center",gap:5,background:"#f2f4f7",border:"1px solid var(--border2)",color:"#6b7280",padding:"3px 8px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                          <span style={{width:5,height:5,borderRadius:"50%",background:"currentColor",opacity:.8}}/>
                          {queuedText}
                        </span>
                      ) : (
                        <button onClick={()=>setAssignLid(l.id)} className="lb-btn">Assign Vehicle</button>
                      )}
                    </td>
                    <td style={{padding:".625rem .75rem",fontSize:".78rem",color:"#111827",maxWidth:220,minWidth:160,verticalAlign:"top"}}>
                      {(() => {
                        const vk = gpsVehicleKey(av?.vnum); const vkAlt = gpsVehicleKeyAlt(av?.vnum);
                        const gAddr = gps && (gps.address || addrMap[vk]);
                        const hasCoord = gps?.lat != null && gps?.lng != null;
                        const mob = av?.mobile;
                        if (!gAddr && !hasCoord && !mob) return <span style={{color:"#6b7280"}}>—</span>;
                        return (
                          <div style={{overflow:"hidden",maxWidth:"100%"}}>
                            {gAddr ? (
                              <span title={gAddr} style={{display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical",overflow:"hidden",wordBreak:"break-word",overflowWrap:"anywhere",lineHeight:1.3}}>{formatDistrictState(gAddr) || gAddr}</span>
                            ) : hasCoord ? (
                              <span style={{color:"#6b7280"}}>{gps.lat.toFixed(4)}, {gps.lng.toFixed(4)}</span>
                            ) : null}
                            {mob && (
                              <div style={{marginTop:3,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",color:"#111827"}}>
                                📞 <a href={`tel:${mob}`} style={{color:"#374151",textDecoration:"none"}}>{mob}</a>
                              </div>
                            )}
                          </div>
                        );
                      })()}
                    </td>

                    <td style={{padding:".625rem .75rem"}}>
                      {(() => {
                        // Canonical ETA via computeTat: now + dist/22 + N×24h
                        let liveEta = null;
                        let awaitingGps = false;
                        let distKm = null;
                        let bumpHrs = 0;
                        if (av && av.vstatus === "IN_TRANSIT") {
                          const { arrivalAt, distToGo, consigneeBumpHours } = loadDerived.get(String(l.id))?.tat || computeTat(l, av, cityCoords, gpsMap);
                          bumpHrs = consigneeBumpHours || 0;
                          if (arrivalAt) {
                            liveEta = arrivalAt.toISOString();
                            distKm = distToGo;
                          } else {
                            awaitingGps = true;
                          }
                        }
                        const etaStr = liveEta || (av && av.eta) || null;
                        const distBox = distKm != null && isFinite(distKm) ? (
                          <div style={{display:"inline-block",marginTop:4,background:"rgba(37,99,235,0.12)",border:"1px solid rgba(37,99,235,0.4)",borderRadius:6,padding:"1px 6px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,color:"#2563eb"}} title="Distance to destination">{Math.round(distKm)} km to go</div>
                        ) : null;
                        if (!etaStr) {
                          if (awaitingGps) { const why = gpsReasonFor(l, av, cityCoords, gpsMap); return <span title={why} style={{color:"#6b7280",fontSize:".72rem"}}>{why}</span>; }
                          return <span style={{color:"#6b7280",fontSize:".78rem"}}>—</span>;
                        }
                        const etaDate = new Date(etaStr);
                        const now = new Date();
                        const diff = etaDate - now;
                        const isOverdue = diff < 0;
                        const isSoon = diff > 0 && diff < 3 * 3600000;
                        const absMs = Math.abs(diff);
                        const totalHrs = Math.floor(absMs / 3600000);
                        const minsLeft = Math.floor((absMs % 3600000) / 60000);
                        const days = Math.floor(totalHrs / 24);
                        const hrsRem = totalHrs % 24;
                        const sign = isOverdue ? "-" : "";
                        const countdown = isSoon
                          ? " Arriving soon"
                          : (days > 0
                              ? `${sign}${days}d ${hrsRem}h`
                              : `${sign}${totalHrs}h ${minsLeft}m`);
                        const bumpLabel = bumpHrs > 0 ? ` · +${bumpHrs/24}d stops` : "";
                        return (
                          <div>
                            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:isOverdue?"#dc2626":isSoon?"#c2410c":"#111827"}}>{countdown}</div>
                            <div style={{fontSize:".68rem",color:"#374151",marginTop:1}}>{fmtDT(etaStr)}{liveEta?` · live @22km/h${bumpLabel}`:""}</div>
                            {distBox}
                          </div>
                        );
                      })()}

                    </td>

                    <td style={{padding:".625rem .75rem"}}>
                      <div style={{display:"flex",gap:".35rem",alignItems:"center",flexWrap:"wrap"}}>
                        <button type="button" onClick={()=>toggleValidated(l.id)} title={isValidated?"Uncheck to mark as not validated":"Mark as validated"} className={isValidated?"lb-btn lb-btn-ok":"lb-btn"} aria-pressed={isValidated}>
                          <span aria-hidden="true" className={isValidated?"lb-check lb-check-on":"lb-check"} />
                          {isValidated?"Validated":"Validate"}
                        </button>
                        {(av || queuedVeh) && (
                          <button onClick={()=>unassign(l.id)} title={queuedVeh && !av ? "Remove queued vehicle" : "Unassign vehicle"} className="lb-btn lb-btn-warn">Unassign</button>
                        )}
                        
                        <button onClick={()=>toggleUrgent(l.id)} title={urgentLoads[l.id]?"Unmark urgent":"Mark urgent"} className={urgentLoads[l.id]?"lb-act lb-act-flame-on":"lb-act lb-act-flame"}><Flame size={14} /></button>
                        <button onClick={()=>setIncidentModal(l.id)} title="Report Incident" className="lb-act lb-act-warn"><AlertTriangle size={14} /></button>
                        {(() => {
                          if (l.lstatus === "LATE") return true;
                          if (!av || av.vstatus !== "IN_TRANSIT") return false;
                          const { targetAt, arrivalAt } = loadDerived.get(String(l.id))?.tat || computeTat(l, av, cityCoords, gpsMap);
                          if (!targetAt || !arrivalAt) return false;
                          return (arrivalAt - targetAt) / 3600000 > 4;
                        })() && (
                          <button onClick={()=>setTatModalLoadId(l.id)} title="Edit Delay Reason / Comments (TAT)" className="lb-btn-delay">Delay</button>
                        )}

                        <button onClick={()=>setSeeMoreLoadId(l.id)} title="See more details" className="lb-act"><Eye size={14} /></button>
                        <button onClick={()=>editL(l)} title="Edit" className="lb-act"><Pencil size={14} /></button>
                        {isAdmin && (
                          <button onClick={()=>setDelL(l.id)} title="Delete" className="lb-act lb-act-danger"><Trash2 size={14} /></button>
                        )}
                      </div>
                      {(() => {
                        const cs = tatReasons[l.id]?.comments || [];
                        if (!cs.length) return null;
                        const recent = [...cs].reverse().slice(0, 2);
                        const more = cs.length - recent.length;
                        return (
                          <div title="From TAT Tracker" style={{marginTop:6,display:"flex",flexDirection:"column",gap:3,maxWidth:240}}>
                            {recent.map(c => (
                              <div key={c.id} style={{background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:6,padding:"3px 6px",fontSize:".68rem",color:"#111827",lineHeight:1.3,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>💬 {c.text}</div>
                            ))}
                            {more > 0 && <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:600}}>+{more} more in TAT Tracker</div>}
                          </div>
                        );
                      })()}
                    </td>

                  </tr>
                  </Fragment>
                );
              };

              return (
                <>
                  {/* Branch bar */}
                  <div className="branch-nav-bar" style={{borderRadius:6,padding:".625rem .75rem",marginBottom:".9rem",display:"flex",flexWrap:"wrap",gap:".4rem",alignItems:"center"}}>
                    <button className="branch-chip" data-active={!lbBranchChip} onClick={()=>setLbBranchChip("")}>All ({chipTotal})</button>
                    {barBranches.map(b => {
                      const c = chipCountMap[b] || 0;
                      const active = lbBranchChip===b;
                      return (
                        <button key={b} className="branch-chip" data-active={active} data-dim={c===0} onClick={()=>setLbBranchChip(active?"":b)}>▸ {b} ({c})</button>
                      );
                    })}
                    <button
                      className="branch-chip"
                      data-active={lbOnlyMulti}
                      onClick={()=>setLbOnlyMulti(v=>!v)}
                      title="Show only loads with more than one consignee"
                      style={{marginLeft:"auto",background:lbOnlyMulti?"rgba(124,58,237,0.15)":undefined,borderColor:lbOnlyMulti?"#6366f1":undefined,color:lbOnlyMulti?"#6366f1":undefined,fontWeight:600}}>
                      ⛬ Multi-consignee ({multiCount})
                    </button>
                    {leftUnloadCount > 0 && (
                      <button
                        className="branch-chip"
                        data-active={lbOnlyLeftUnload}
                        onClick={()=>setLbOnlyLeftUnload(v=>!v)}
                        title="Vehicles that drove away from destination without being marked Delivered"
                        style={{background:lbOnlyLeftUnload?"rgba(217,119,6,0.08)":"rgba(217,119,6,0.08)",borderColor:lbOnlyLeftUnload?"#d97706":"#d97706",color:"#d97706",fontWeight:600}}>
                        Left Unloading ({leftUnloadCount})
                      </button>
                    )}
                    {(() => {
                      const noDriverCount = filteredL.filter(l => {
                        const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) : null;
                        return !!av?.withoutDriver;
                      }).length;
                      if (noDriverCount === 0 && !lbOnlyNoDriver) return null;
                      return (
                        <button
                          className="branch-chip"
                          data-active={lbOnlyNoDriver}
                          onClick={()=>setLbOnlyNoDriver(v=>!v)}
                          title="Loads whose assigned vehicle is flagged without driver"
                          style={{background:lbOnlyNoDriver?"#fed7aa":"rgba(217,119,6,0.08)",borderColor:lbOnlyNoDriver?"#d97706":"#d97706",color:"#d97706",fontWeight:600}}>
                          Without Driver ({noDriverCount})
                        </button>
                      );
                    })()}
                    {(() => {
                      const incCount = filteredL.filter(l => l.vehicleId && !!vehicleIncidents[l.vehicleId]).length;
                      if (incCount === 0 && !lbOnlyIncident) return null;
                      return (
                        <button
                          className="branch-chip"
                          data-active={lbOnlyIncident}
                          onClick={()=>setLbOnlyIncident(v=>!v)}
                          title="Loads whose assigned vehicle has an active incident"
                          style={{background:lbOnlyIncident?"rgba(220,38,38,0.08)":"rgba(220,38,38,0.08)",borderColor:lbOnlyIncident?"#dc2626":"#dc2626",color:"#dc2626",fontWeight:600}}>
                          Incident ({incCount})
                        </button>
                      );
                    })()}
                  </div>

                  {lbTotalPages > 1 && (
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",margin:"0 0 .8rem"}}>
                      <div style={{fontSize:".72rem",color:"#6b7280",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>
                        Showing {lbPageStart}–{lbPageEnd} of {filteredLForPage.length} loads

                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <button onClick={()=>setLbPage(p=>Math.max(1,p-1))} disabled={lbCurPage<=1} style={{background:"#ffffff",border:"1px solid var(--border)",color:lbCurPage<=1?"#e4e7ed":"#111827",padding:"5px 12px",borderRadius:6,fontSize:".78rem",fontWeight:600,cursor:lbCurPage<=1?"default":"pointer"}}>‹ Prev</button>
                        <span style={{fontSize:".78rem",color:"#111827",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>Page {lbCurPage} of {lbTotalPages}</span>
                        <button onClick={()=>setLbPage(p=>Math.min(lbTotalPages,p+1))} disabled={lbCurPage>=lbTotalPages} style={{background:"#ffffff",border:"1px solid var(--border)",color:lbCurPage>=lbTotalPages?"#e4e7ed":"#111827",padding:"5px 12px",borderRadius:6,fontSize:".78rem",fontWeight:600,cursor:lbCurPage>=lbTotalPages?"default":"pointer"}}>Next ›</button>
                        <input type="number" min={1} max={lbTotalPages} value={lbCurPage} onChange={e=>{const n=Math.max(1,Math.min(lbTotalPages,Number(e.target.value)||1));setLbPage(n);}} style={{width:54,background:"#ffffff",border:"1px solid var(--border)",borderRadius:6,padding:"4px 6px",fontSize:".78rem",fontWeight:600,textAlign:"center",fontFamily:"'Inter',system-ui,sans-serif"}} title="Jump to page" />
                      </div>
                    </div>
                  )}




                  {filteredL.length===0 ? (
                    (() => {
                      const hiddenCount = loads.length - filteredL.length;
                      const hasActiveFilter =
                        (lFilter && lFilter !== "ALL") ||
                        !!lSearch || !!lBranch || !!lCustomer || !!lVType ||
                        !!fVehFilter || !!fFromCityFilter || !!fToCityFilter || !!fCustomerFilter ||
                        !!lbFleetBranchFilter || (fFilter && fFilter !== "ALL") ||
                        !!fDateFrom || !!fDateTo || !!fPending || !!fPreTransit || !!fRpdc || !!lbBranchChip || lbOnlyMulti || lbOnlyLeftUnload;
                      if (loads.length === 0) {
                        return (
                          <div style={{textAlign:"center",padding:"3rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>No loads found. Add your first load to get started.</div>
                        );
                      }
                      if (!hasActiveFilter) {
                        return (
                          <div style={{textAlign:"center",padding:"2.5rem 1rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>
                            No active loads to show. Delivered loads appear in the Delivered tab.
                          </div>
                        );
                      }
                      return (
                        <div style={{textAlign:"center",padding:"2.5rem 1rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>
                          <div style={{marginBottom:".7rem"}}>{hiddenCount} load{hiddenCount>1?"s":""} hidden by active filters.</div>
                          <button onClick={()=>{
                            setLFilter("ALL"); setLSearch(""); setLBranch(""); setLCustomer(""); setLVType("");
                            setFVehFilter(""); setFFromCityFilter(""); setFToCityFilter(""); setFCustomerFilter("");
                            setLbFleetBranchFilter(""); setFFilter("ALL"); setFDateFrom(""); setFDateTo("");
                            setFPending(false); setFPreTransit(false); setLbBranchChip(""); setLbOnlyMulti(false);
                          }} style={{background:"#374151",color:"#ffffff",border:"none",padding:".5rem 1rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",letterSpacing:0,cursor:"pointer",textTransform:"uppercase"}}>Clear all filters</button>
                        </div>
                      );
                    })()
                  ) : visibleGroups.length===0 ? (
                    <div style={{textAlign:"center",padding:"2rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem"}}>No loads in {lbBranchChip}.</div>
                  ) : (
                    visibleGroups.map(([branchName, list]) => {
                      const loadNum = (l)=>{ const m=/LD-(\d+)/i.exec(l.lid||""); return m?parseInt(m[1],10):0; };
                      const sortedList = [...list].sort((a,b)=>{
                        const ap=a.pickup||"", bp=b.pickup||"";
                        if (ap || bp) {
                          if (!ap) return 1;
                          if (!bp) return -1;
                          const d = bp.localeCompare(ap);
                          if (d) return d;
                        }
                        return loadNum(b) - loadNum(a);
                      });
                      return (
                      <div key={branchName} style={{marginBottom:"1.3rem"}}>
                        {/* Branch heading */}
                        <div style={{display:"flex",alignItems:"center",gap:".6rem",background:"rgba(217,119,6,0.08)",borderLeft:"4px solid rgba(245,158,11,0.5)",padding:".5rem .8rem",borderRadius:lbViewMode==="cards"?"10px 10px 0 0":"6px 6px 0 0",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",letterSpacing:0,textTransform:"uppercase",color:"#d97706"}}>
                          {branchName}
                          <span style={{background:"#2563eb",color:"#ffffff",borderRadius:12,padding:"1px 8px",fontSize:".68rem"}}>{list.length}</span>
                        </div>

                        {/* TABLE VIEW */}
                        {lbViewMode==="table" && (
                          <div style={{overflowX:"auto",border:"1px solid var(--border)",borderTop:"none",borderRadius:"0 0 10px 10px",background:"rgba(255,255,255,0.72)",backdropFilter:"blur(12px)",WebkitBackdropFilter:"blur(12px)",boxShadow:"0 4px 30px rgba(0,0,0,0.05)"}}>
                            <table className="lb-tbl" style={{width:"100%",borderCollapse:"collapse"}}>
                              <thead>
                                <tr style={{background:"#f2f4f7"}}>
                                  {["Customer","From","To","Vehicle Number","Vehicle Status","Current Location","ETA","Actions"].map(h=>(
                                    <th key={h} style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border2)",whiteSpace:"nowrap"}}>{h}</th>
                                  ))}
                                </tr>
                              </thead>
                              <tbody>{sortedList.map(renderRow)}</tbody>
                            </table>
                          </div>
                        )}

                        {/* CARD VIEW */}
                        {lbViewMode==="cards" && (
                          <div style={{border:"1px solid var(--border)",borderTop:"none",borderRadius:"0 0 10px 10px",padding:"12px",background:"#f2f4f7"}}>
                            <div className="lb-card-grid">
                              {sortedList.map(l => {
                                const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
                                const queuedVeh = (!av && l.lstatus==="QUEUED" && l.queuedVehicleId) ? vehicleById.get(String(l.queuedVehicleId)) ?? null : null;
                                const blockingLoad = (queuedVeh && l.queuedBehindLoadId) ? loadById.get(String(l.queuedBehindLoadId)) ?? null : null;
                                const gps = av ? lookupGps(gpsMap, av.vnum) : null;
                                const vk = av ? gpsVehicleKey(av.vnum) : "";
                                const gAddr = gps && (gps.address || addrMap[vk]);
                                const isValidated = !!(l.validated);
                                const isUrgent = !!urgentLoads[l.id];
                                const hasIncident = !!vehicleIncidents[l.vehicleId];
                                const lsColor = l.lstatus==="PENDING"?"var(--status-warn-fg)":l.lstatus==="ASSIGNED"?"var(--status-info-fg)":l.lstatus==="IN_TRANSIT"?"var(--status-active-fg)":l.lstatus==="AT_UNLOADING"?"var(--status-warn-fg)":l.lstatus==="QUEUED"?"var(--status-info-fg)":l.lstatus==="LATE"?"var(--status-danger-fg)":"var(--status-neutral-fg)";
                                const lsBg = l.lstatus==="PENDING"?"var(--status-warn-bg)":l.lstatus==="ASSIGNED"?"var(--status-info-bg)":l.lstatus==="IN_TRANSIT"?"var(--status-active-bg)":l.lstatus==="AT_UNLOADING"?"var(--status-warn-bg)":l.lstatus==="QUEUED"?"var(--status-info-bg)":l.lstatus==="LATE"?"var(--status-danger-bg)":"var(--status-neutral-bg)";
                                // ETA — match the table view: live computeTat for IN_TRANSIT, fallback to av.eta, GPS reason when no fix
                                let liveEta = null, awaitingGps = false, distKm = null, bumpHrs = 0;
                                let targetAt = null, arrivalAtVal = null;
                                if (av && av.vstatus === "IN_TRANSIT") {
                                  const t = computeTat(l, av, cityCoords, gpsMap);
                                  targetAt = t.targetAt; arrivalAtVal = t.arrivalAt;
                                  bumpHrs = t.consigneeBumpHours || 0;
                                  if (t.arrivalAt) { liveEta = t.arrivalAt.toISOString(); distKm = t.distToGo; }
                                  else { awaitingGps = true; }
                                }
                                const etaStr = liveEta || (av && av.eta) || null;
                                let etaNode = null;
                                if (!etaStr) {
                                  if (awaitingGps) {
                                    const why = gpsReasonFor(l, av, cityCoords, gpsMap);
                                    etaNode = <span title={why} style={{color:"#6b7280",fontSize:".72rem"}}>{why}</span>;
                                  } else {
                                    etaNode = <span style={{color:"#6b7280",fontSize:".78rem"}}>—</span>;
                                  }
                                } else {
                                  const etaDate = new Date(etaStr), now = new Date();
                                  const diff = etaDate - now;
                                  const isOverdue = diff < 0;
                                  const isSoon = diff > 0 && diff < 3*3600000;
                                  const absMs = Math.abs(diff);
                                  const totalHrs = Math.floor(absMs/3600000);
                                  const minsLeft = Math.floor((absMs%3600000)/60000);
                                  const days = Math.floor(totalHrs/24);
                                  const hrsRem = totalHrs % 24;
                                  const sign = isOverdue ? "-" : "";
                                  const countdown = isSoon ? " Arriving soon" : (days>0 ? `${sign}${days}d ${hrsRem}h` : `${sign}${totalHrs}h ${minsLeft}m`);
                                  const bumpLabel = bumpHrs > 0 ? ` · +${bumpHrs/24}d stops` : "";
                                  const etaColor = isOverdue ? "#dc2626" : isSoon ? "#c2410c" : "#111827";
                                  etaNode = (
                                    <div>
                                      <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:etaColor}}>{countdown}</div>
                                      <div style={{fontSize:".78rem",color:"#374151",marginTop:2}}>{fmtDT(etaStr)}{liveEta?` · live @22km/h${bumpLabel}`:""}</div>
                                      {distKm != null && isFinite(distKm) && (
                                        <div style={{display:"inline-block",marginTop:5,background:"rgba(37,99,235,0.12)",border:"1px solid rgba(37,99,235,0.4)",borderRadius:6,padding:"3px 9px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:"#6b7280"}} title="Distance to destination">{Math.round(distKm)} km to go</div>
                                      )}
                                    </div>
                                  );
                                }
                                // Delay flags — mirror the table row
                                const lateHours = (targetAt && arrivalAtVal) ? (arrivalAtVal - targetAt) / 3600000 : null;
                                const isDelayedBadge = av?.vstatus === "IN_TRANSIT" && lateHours != null && lateHours > 4;
                                const showDelayBtn = l.lstatus === "LATE" || isDelayedBadge;
                                const tatComments = (tatReasons[l.id]?.comments) || [];
                                const heroVnum = av?.vnum || queuedVeh?.vnum || null;
                                const hasGps = !!(gps?.lat != null && gps?.lng != null);
                                 return (
                                   <div key={l.id} className="lb-card" style={{borderLeftColor: lsColor}}>
                                     {/* Card Header — vehicle # is hero */}
                                     <div className="lb-card-header" style={{flexDirection:"column",alignItems:"stretch",gap:6}}>
                                       <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                                         {heroVnum ? (
                                           <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:"1.2rem",color:"#111827",letterSpacing:0,lineHeight:1.1}}>{heroVnum}</span>
                                         ) : (
                                           <span style={{background:"#f2f4f7",color:"#6b7280",borderRadius:8,padding:"4px 10px",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Unassigned</span>
                                         )}
                                         <span style={{marginLeft:"auto",background:"#f2f4f7",color:"#6b7280",borderRadius:6,padding:"2px 8px",fontSize:".68rem",fontWeight:600,letterSpacing:0}}>#{l.lid}</span>
                                       </div>
                                       <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                                         <span style={{background:lsBg,color:lsColor,borderRadius:9999,padding:"3px 10px",fontSize:".68rem",fontWeight:600,whiteSpace:"nowrap",letterSpacing:0,textTransform:"none"}}>{LS_LABELS[l.lstatus]||l.lstatus}</span>
                                         {isUrgent && <span className="lb-chip" style={{background:"rgba(220,38,38,0.08)",color:"#dc2626"}}>🔥 URGENT</span>}
                                         {l.lstatus==="LATE" && <span className="lb-chip" style={{background:"rgba(220,38,38,0.08)",color:"#dc2626"}}> LATE</span>}
                                         {isDelayedBadge && (
                                           <span title="Same value as TAT Tracker" style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(220,38,38,0.08)",border:"1px solid #dc2626",color:"#dc2626",padding:"2px 7px",borderRadius:6,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Delayed · by {lateHours.toFixed(1)}h</span>
                                         )}
                                         {hasIncident && <span className="lb-chip" style={{background:"rgba(217,119,6,0.08)",color:"#c2410c"}}>Incident</span>}
                                         {av?.withoutDriver && (() => {
                                           const passed = av.withoutDriverEta && Date.now() > new Date(av.withoutDriverEta).getTime();
                                           const etaTxt = av.withoutDriverEta ? new Date(av.withoutDriverEta).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
                                           return (
                                             <span title={`Without driver · Driver ETA ${etaTxt}`} className="lb-chip" style={{background:passed?"rgba(220,38,38,0.08)":"rgba(217,119,6,0.08)",color:passed?"#dc2626":"#d97706",border:`1px solid ${passed?"#dc2626":"#fb923c"}`}}>
                                               {passed ? "No Driver · ETA Passed" : `No Driver · ETA ${etaTxt}`}
                                             </span>
                                           );
                                         })()}
                                         {isValidated && <span className="lb-chip" style={{background:"rgba(22,163,74,0.08)",color:"#16a34a",border:"1px solid #16a34a"}}>✓ Validated</span>}
                                         <span style={{marginLeft:"auto",display:"flex",alignItems:"center",gap:6}}>
                                           {l.branch && <span style={{background:"#f2f4f7",color:"#374151",borderRadius:6,padding:"2px 8px",fontSize:".68rem",fontWeight:600,letterSpacing:0}}>{l.branch}</span>}
                                           {l.priority && <span className="lb-chip" style={{background:l.priority==="HIGH"||l.priority==="URGENT"?"rgba(220,38,38,0.08)":"#f2f4f7",color:l.priority==="HIGH"||l.priority==="URGENT"?"#dc2626":"#6b7280"}}>{l.priority}</span>}
                                         </span>
                                       </div>
                                     </div>

                                     {isLeftUnload(l) && (
                                       <div style={{background:"rgba(217,119,6,0.08)",borderTop:"1px solid #e4e7ed",borderBottom:"1px solid #e4e7ed",padding:".5rem .9rem",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                                         <span style={{color:"#d97706",fontWeight:600,fontSize:".72rem",letterSpacing:0,textTransform:"uppercase"}}>Left Unloading</span>
                                         <span style={{color:"#d97706",fontSize:".72rem",flex:"1 1 200px"}}>
                                           Drove away from <b>{l.leftUnloadingDest||l.dest||"destination"}</b>
                                           {l.leftUnloadingFromKm!=null?` (${l.leftUnloadingFromKm} km from destination)`:""} · {fmtLeftUnloadAgo(l.leftUnloadingAt)} — not marked delivered.
                                         </span>
                                         <span style={{display:"flex",gap:6,marginLeft:"auto"}}>
                                           {av && (
                                             <button onClick={()=>quickVS(av.id,"DELIVERED", l.id)} style={{background:"transparent",border:"1px solid #16a34a",color:"#16a34a",padding:"3px 10px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase"}}>Mark Delivered</button>
                                           )}
                                           <button onClick={()=>ackLeftUnload(l.id)} title="Acknowledge — not delivered, hide warning" style={{background:"transparent",border:"1px solid #e4e7ed",color:"#6b7280",padding:"3px 10px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase"}}>Dismiss</button>
                                         </span>
                                       </div>
                                     )}

                                     {/* Card Body — 3 columns, status centered */}
                                     <div className="lb-card-body">
                                        {/* Column 1: Customer + From/To + Cargo */}
                                        <div className="lb-card-col">
                                          <div className="lb-card-field">
                                            <div className="lb-card-label">Customer</div>
                                            <div className="lb-card-value" style={{fontWeight:600,fontSize:".9rem"}}>{l.customer||"—"}</div>
                                          </div>
                                          <div className="lb-card-field">
                                            <div className="lb-card-label">From</div>
                                            <div className="lb-card-value" style={{fontWeight:600,fontSize:".84rem"}}>{l.origin||"—"}</div>
                                          </div>
                                          <div className="lb-card-field">
                                            <div className="lb-card-label">To</div>
                                            <div className="lb-card-value" style={{fontWeight:600,fontSize:".84rem",color:"#111827"}}>{l.dest||"—"}</div>
                                          </div>
                                          {l.consignees?.length > 0 && (() => {
                                            const cons = l.consignees.filter(Boolean);
                                            const dels = stopsFor(l);
                                            const delCount = cons.filter((c,i)=> !!dels[i]?.delivered).length;
                                            const isOpen = !!expandedConsignees[l.id];
                                            return (
                                              <div className="lb-card-field">
                                                <button
                                                  type="button"
                                                  onClick={()=>setExpandedConsignees(p=>({...p,[l.id]:!p[l.id]}))}
                                                  title={cons.join(", ")}
                                                  style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(124,58,237,0.1)",border:"1px solid rgba(124,58,237,0.35)",borderRadius:12,padding:"2px 8px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,color:"#6366f1",cursor:"pointer"}}>
                                                  C - {cons.length}{delCount>0?` · ✓${delCount}`:""} {isOpen?"▴":"▾"}
                                                </button>
                                                {isOpen && (
                                                  <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:3,background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:6,padding:"5px 7px",maxWidth:280}}>
                                                    {cons.map((city,i) => {
                                                      const d = dels[i] || {};
                                                      const delivered = !!d.delivered;
                                                      return (
                                                        <div key={`lbcard-cons-${l.id}-${i}`} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6,fontSize:".68rem"}}>
                                                          <span style={{color:"#111827",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{i+1}. {city}</span>
                                                          {delivered ? (
                                                            <button onClick={()=>setConsigneeDelivered(l.id,i,false)} title={d.deliveredAt?`Delivered ${fmtDT(d.deliveredAt)} · click to undo`:"Undo delivered"} style={{background:"rgba(34,197,94,0.18)",border:"1px solid rgba(34,197,94,0.5)",color:"#16a34a",padding:"1px 6px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",whiteSpace:"nowrap"}}>✓ {d.deliveredAt?fmtDT(d.deliveredAt):"Delivered"}</button>
                                                          ) : (
                                                            <button onClick={()=>markConsigneeDeliveredWithPrompt(l.id,i)} title="Mark this consignee as delivered" style={{background:"transparent",border:"1px solid #16a34a",color:"#16a34a",padding:"1px 6px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",whiteSpace:"nowrap"}}>Mark Delivered</button>
                                                          )}
                                                        </div>
                                                      );
                                                    })}
                                                  </div>
                                                )}
                                              </div>
                                            );
                                          })()}
                                          <div className="lb-card-field">
                                            <div className="lb-card-label">Commodity</div>
                                            <div className="lb-card-value">{l.commodity||"—"}</div>
                                            {(l.weight||l.volume||l.vtypeReq) && (
                                              <div style={{display:"flex",flexWrap:"wrap",gap:4,marginTop:4}}>
                                                {l.weight && <span className="lb-chip" style={{background:"#f2f4f7",color:"#374151"}}>{l.weight}T</span>}
                                                {l.volume && <span className="lb-chip" style={{background:"#f2f4f7",color:"#374151"}}>{l.volume}m³</span>}
                                                {l.vtypeReq && <span className="lb-chip" style={{background:"rgba(99,102,241,0.08)",color:"#6366f1"}}>{l.vtypeReq}</span>}
                                              </div>
                                            )}
                                          </div>
                                        </div>

                                        {/* Column 2: Status hero (centered) */}
                                        <div className="lb-card-col" style={{alignItems:"center",textAlign:"center",gap:6,minWidth:200}}>
                                          <div className="lb-card-label">Vehicle Status</div>
                                          {av ? (
                                            <VStatusPill status={av.vstatus} size="lg" withDropdown onChange={(v)=>quickVS(av.id, v, l.id)} />
                                          ) : queuedVeh ? (
                                            <span title={`Waiting for ${queuedVeh.vnum} to free up from ${blockingLoad?.lid||""}`} style={{display:"inline-flex",alignItems:"center",gap:6,background:"#f2f4f7",border:"1px solid var(--border2)",color:"#6b7280",padding:"6px 12px",borderRadius:12,fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                                              <span style={{width:7,height:7,borderRadius:"50%",background:"currentColor",opacity:.8}}/>
                                              Queued
                                            </span>
                                          ) : (
                                            <span style={{background:"#f2f4f7",color:"#6b7280",borderRadius:12,padding:"6px 12px",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>No Vehicle</span>
                                          )}
                                          {(av?.driver || queuedVeh?.driver) && (
                                            <div style={{fontSize:".78rem",color:"#111827",fontWeight:600,marginTop:4}}>{av?.driver||queuedVeh?.driver}</div>
                                          )}
                                          {(av?.mobile || queuedVeh?.mobile) && (
                                            <div style={{fontSize:".68rem",color:"#6b7280"}}>📞 {av?.mobile||queuedVeh?.mobile}</div>
                                          )}
                                          {av?.vtype && <div style={{fontSize:".68rem",color:"#6b7280",letterSpacing:0}}>{av.vtype}</div>}
                                        </div>

                                        {/* Column 3: Schedule + ETA + Live */}
                                        <div className="lb-card-col">
                                          <div className="lb-card-row">
                                            <div className="lb-card-field">
                                              <div className="lb-card-label">Pickup</div>
                                              <div className="lb-card-value" style={{fontSize:".78rem"}}>{fmtDT ? fmtDT(l.pickup) : (l.pickup||"—")}</div>
                                            </div>
                                            <div className="lb-card-field">
                                              <div className="lb-card-label">LR Date</div>
                                              <div className="lb-card-value" style={{fontSize:".78rem"}}>{l.lrDate||av?.lrDate||"—"}</div>
                                            </div>
                                          </div>
                                          <div className="lb-card-field">
                                            <div className="lb-card-label">ETA</div>
                                            <div className="lb-card-value">{etaNode}</div>
                                          </div>
                                          {gAddr && (
                                            <div className="lb-card-field">
                                              <div className="lb-card-label">Live Location</div>
                                              <div className="lb-card-value" style={{fontSize:".72rem",color:"#374151"}}>{formatDistrictState(gAddr)||gAddr}</div>
                                            </div>
                                          )}
                                          {blockingLoad && <div style={{fontSize:".68rem",color:"#6b7280"}}>Queued behind <strong>{blockingLoad.lid}</strong> → {blockingLoad.dest||"—"}</div>}
                                        </div>
                                      </div>

                                      {/* Hover-expand GPS mini-map (card view only) */}
                                      {hasGps && (
                                        <div style={{padding:"0 1rem .6rem",position:"relative"}}>
                                          <LoadCardMiniMap
                                            lat={gps.lat}
                                            lng={gps.lng}
                                            vnum={av?.vnum}
                                            addressLine={gAddr}
                                            onClick={()=>openGpsMap(av, l.lid, l.id)}
                                          />
                                        </div>
                                      )}

                                     {/* Card Footer — Actions */}
                                     <div className="lb-card-footer">
                                       {!av && !queuedVeh && (
                                         <button onClick={()=>setAssignLid(l.id)} style={{background:"#2563eb",color:"#ffffff",border:"none",padding:"4px 10px",borderRadius:12,cursor:"pointer",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,boxShadow:"0 1px 3px rgba(37,99,235,0.2)",transition:"all .12s"}}>Assign</button>
                                       )}
                                       {(av||queuedVeh) && (
                                         <button onClick={()=>unassign(l.id)} className="lb-btn lb-btn-warn">Unassign</button>
                                       )}
                                        <label title={isValidated?"Uncheck to mark as not validated":"Mark as validated"} className={isValidated?"lb-btn lb-btn-ok":"lb-btn"} style={{cursor:"pointer"}}>
                                          <input type="checkbox" checked={isValidated} onChange={()=>toggleValidated(l.id)} />
                                          {isValidated?"Validated":"Validate"}
                                        </label>
                                       <button onClick={()=>toggleUrgent(l.id)} style={{background:isUrgent?"#dc2626":"transparent",border:"1px solid #dc2626",color:isUrgent?"#ffffff":"#dc2626",padding:"3px 6px",borderRadius:12,cursor:"pointer",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,display:"inline-flex",alignItems:"center",transition:"all .12s"}}><Flame size={12}/></button>
                                       <button onClick={()=>setIncidentModal(l.id)} style={{background:"transparent",border:"1px solid #fb923c",color:"#d97706",padding:"3px 6px",borderRadius:12,cursor:"pointer",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,display:"inline-flex",alignItems:"center",transition:"all .12s"}}><AlertTriangle size={12}/></button>
                                       {showDelayBtn && (
                                         <button onClick={()=>setTatModalLoadId(l.id)} title="Edit Delay Reason / Comments (TAT)" style={{background:"rgba(217,119,6,0.08)",border:"1px solid #d97706",color:"#d97706",padding:"3px 8px",borderRadius:12,cursor:"pointer",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,display:"inline-flex",alignItems:"center",gap:3,transition:"all .12s"}}> Delay</button>
                                       )}
                                       {av && (
                                         <button onClick={()=>openGpsMap(av, l.lid, l.id)} disabled={!hasGps} title={hasGps?"View on map":"No live GPS yet"} style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",color:"#374151",padding:"3px 8px",borderRadius:12,cursor:hasGps?"pointer":"not-allowed",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,display:"inline-flex",alignItems:"center",gap:4,opacity:hasGps?1:.5,transition:"all .12s"}}>
                                           <MapPin size={12}/> GPS
                                         </button>
                                       )}
                                       <button onClick={()=>setSeeMoreLoadId(l.id)} style={{background:"transparent",border:"1px solid #2563eb",color:"#2563eb",padding:"3px 6px",borderRadius:12,cursor:"pointer",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,display:"inline-flex",alignItems:"center",transition:"all .12s"}}><Eye size={12}/></button>
                                       <button onClick={()=>editL(l)} className="lb-act"><Pencil size={12}/></button>
                                       {isAdmin && <button onClick={()=>setDelL(l.id)} style={{background:"transparent",border:"1px solid var(--border)",color:"#dc2626",padding:"3px 6px",borderRadius:12,cursor:"pointer",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,display:"inline-flex",alignItems:"center",transition:"all .12s"}}><Trash2 size={12}/></button>}
                                     </div>

                                     {/* TAT comment preview */}
                                     {tatComments.length > 0 && (() => {
                                       const recent = [...tatComments].reverse().slice(0, 2);
                                       const more = tatComments.length - recent.length;
                                       return (
                                         <div title="From TAT Tracker" style={{padding:"0 1rem .6rem",display:"flex",flexDirection:"column",gap:3}}>
                                           {recent.map(c => (
                                             <div key={c.id} style={{background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:6,padding:"3px 6px",fontSize:".68rem",color:"#111827",lineHeight:1.3,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>💬 {c.text}</div>
                                           ))}
                                           {more > 0 && <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:600}}>+{more} more in TAT Tracker</div>}
                                         </div>
                                       );
                                     })()}
                                   </div>
                                 );
                               })}
                            </div>
                          </div>
                        )}
                      </div>
                    );})
                  )}

                  {lbTotalPages > 1 && filteredLForPage.length > 0 && (
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",marginTop:".4rem"}}>
                      <div style={{fontSize:".72rem",color:"#6b7280",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>
                        Showing {lbPageStart}–{lbPageEnd} of {filteredLForPage.length} loads
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:6}}>
                        <button onClick={()=>setLbPage(p=>Math.max(1,p-1))} disabled={lbCurPage<=1} style={{background:"#ffffff",border:"1px solid var(--border)",color:lbCurPage<=1?"#e4e7ed":"#111827",padding:"5px 12px",borderRadius:6,fontSize:".78rem",fontWeight:600,cursor:lbCurPage<=1?"default":"pointer"}}>‹ Prev</button>
                        <span style={{fontSize:".78rem",color:"#111827",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif"}}>Page {lbCurPage} of {lbTotalPages}</span>
                        <button onClick={()=>setLbPage(p=>Math.min(lbTotalPages,p+1))} disabled={lbCurPage>=lbTotalPages} style={{background:"#ffffff",border:"1px solid var(--border)",color:lbCurPage>=lbTotalPages?"#e4e7ed":"#111827",padding:"5px 12px",borderRadius:6,fontSize:".78rem",fontWeight:600,cursor:lbCurPage>=lbTotalPages?"default":"pointer"}}>Next ›</button>
                        <input type="number" min={1} max={lbTotalPages} value={lbCurPage} onChange={e=>{const n=Math.max(1,Math.min(lbTotalPages,Number(e.target.value)||1));setLbPage(n);}} style={{width:54,background:"#ffffff",border:"1px solid var(--border)",borderRadius:6,padding:"4px 6px",fontSize:".78rem",fontWeight:600,textAlign:"center",fontFamily:"'Inter',system-ui,sans-serif"}} title="Jump to page" />
                      </div>
                    </div>
                  )}
                </>
              );
            })()}
          </div>

          {/* Load Side Panel */}
          <div className={`tms-side-panel ${mobileSideOpen?"tms-side-open":""}`} style={{width:355,flexShrink:0,background:"#ffffff",borderLeft:"1px solid var(--border)",overflowY:"auto",display:"flex",flexDirection:"column"}}>
            <button onClick={()=>setMobileSideOpen(false)} className="tms-side-close" style={{display:"none",position:"sticky",top:0,alignSelf:"flex-end",margin:".4rem",background:"#111827",color:"#ffffff",border:"none",borderRadius:6,padding:".35rem .7rem",fontSize:".78rem",fontWeight:600,cursor:"pointer"}}>✕ Close</button>
            <div style={{padding:".9rem 1.2rem",borderBottom:"1px solid var(--border)",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",background:"#f2f4f7"}}>{lEdit?"EDIT LOAD":"ADD NEW LOAD"}</div>
            <div style={{padding:"1rem 1.2rem",flex:1}}>
              {[
                [["Branch *","branch","combobox-strict",branches]],
                [["Customer *","customer","combobox-strict",customers]],
                [["From City *","origin","places",null],["To City *","dest","places",null]],
                [["Pickup Date *","pickup","date",""]],
                [["Vehicle Type Required *","vtypeReq","select",[""].concat(V_TYPES)]],
                [["Weight (tonnes)","weight","number","12.5"],["Commodity / Cargo","commodity","text","Electronics, Steel…"]],
                [["Notes","notes","textarea","Fragile, temp control…"]],
              ].map((row,ri)=>{
                const isFromTo = row[0] && row[0][1] === "origin";
                const visibleRow = (isFromTo && !lEdit && lExtra.multiLoads) ? row.filter(c=>c[1]!=="dest") : row;
                return (
                <Fragment key={ri}>
                {isFromTo && !lEdit && (
                  <div style={{display:"flex",flexDirection:"column",gap:".5rem",marginBottom:".75rem",padding:".625rem .75rem",background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:6}}>
                    <div style={{display:"flex",alignItems:"center",gap:".55rem"}}>
                      <input type="checkbox" id="lf-multiloads" checked={lExtra.multiLoads} onChange={e=>{
                        const on = e.target.checked;
                        setLExtra(p=>{
                          const n = Math.max(1, Number(p.multiLoadsCount)||2);
                          const rows = on ? Array.from({length:n},(_,i)=>p.multiLoadsRows[i]||{qty:1,dest:""}) : p.multiLoadsRows;
                          return { ...p, multiLoads:on, multiLoadsRows:rows, ...(on?{duplicate:false, multi:false}:{}) };
                        });
                      }} />
                      <label htmlFor="lf-multiloads" style={{fontSize:".72rem",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif",letterSpacing:0,textTransform:"uppercase",color:"#111827",cursor:"pointer"}}>Multiple Loads</label>
                      {lExtra.multiLoads && (
                        <input type="number" min="1" max="30" value={lExtra.multiLoadsCount} onChange={e=>{
                          const v = e.target.value;
                          if (v === "") { setLExtra(p=>({...p, multiLoadsCount:""})); return; }
                          const n = Math.max(1, Math.min(30, Number(v)||1));
                          setLExtra(p=>({...p, multiLoadsCount:n, multiLoadsRows: Array.from({length:n},(_,i)=>p.multiLoadsRows[i]||{qty:1,dest:""})}));
                        }} onBlur={e=>{
                          const n = Math.max(1, Math.min(30, Number(e.target.value)||1));
                          setLExtra(p=>({...p, multiLoadsCount:n, multiLoadsRows: Array.from({length:n},(_,i)=>p.multiLoadsRows[i]||{qty:1,dest:""})}));
                        }} style={{width:70,background:"#ffffff",border:"1px solid var(--border)",padding:".3rem .45rem",borderRadius:6,fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",outline:"none"}} />
                      )}
                    </div>
                    {lExtra.multiLoads && (
                      <div style={{display:"flex",flexDirection:"column",gap:".35rem"}}>
                        <div style={{fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>To Cities ({lExtra.multiLoadsRows.length})</div>
                        {lExtra.multiLoadsRows.map((r,i)=>(
                          <div key={i} style={{display:"flex",alignItems:"center",gap:".4rem"}}>
                            <span style={{fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>Qty</span>
                            <input type="number" min="1" max="50" value={r.qty} onChange={e=>{
                              const v = e.target.value;
                              if (v === "") { setLExtra(p=>{const arr=[...p.multiLoadsRows]; arr[i]={...arr[i],qty:""}; return {...p,multiLoadsRows:arr};}); return; }
                              const q = Math.max(1, Math.min(50, Number(v)||1));
                              setLExtra(p=>{const arr=[...p.multiLoadsRows]; arr[i]={...arr[i],qty:q}; return {...p,multiLoadsRows:arr};});
                            }} onBlur={e=>{
                              const q = Math.max(1, Math.min(50, Number(e.target.value)||1));
                              setLExtra(p=>{const arr=[...p.multiLoadsRows]; arr[i]={...arr[i],qty:q}; return {...p,multiLoadsRows:arr};});
                            }} style={{width:54,background:"#ffffff",border:"1px solid var(--border)",padding:".3rem .35rem",borderRadius:6,fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",outline:"none"}} />
                            <div style={{flex:1,minWidth:0}}>
                              <Combobox value={r.dest} onChange={(val, coords)=>{
                                setLExtra(p=>{const arr=[...p.multiLoadsRows]; arr[i]={...arr[i],dest:val,destCoords:coords||null}; return {...p,multiLoadsRows:arr};});
                                if (coords && val) {
                                  const k = val.trim().toLowerCase();
                                  if (k) setCityCoords(p => (p[k] && p[k].lat != null ? p : { ...p, [k]: { lat: coords.lat, lng: coords.lng } }));
                                }
                              }} fetchOptions={searchCities} placeholder={`To city ${i+1}`} />

                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
                <div style={{display:"grid",gridTemplateColumns:visibleRow.length>1?"1fr 1fr":"1fr",gap:".6rem",marginBottom:".75rem"}}>
                  {visibleRow.map(([label,field,type,opts])=>(
                    <div key={field}>
                      <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:3}}>{label.endsWith(" *") ? <>{label.slice(0,-2)}<span style={{color:"#dc2626",marginLeft:3}}>*</span></> : label}</label>
                      {type==="places" ? (
                        <Combobox value={lForm[field]} onChange={(val, coords)=>{
                          setLForm(p=>{
                            const coordField = field === "origin" ? "originCoords" : field === "dest" ? "destCoords" : null;
                            const next = {...p, [field]:val};
                            if (coordField) next[coordField] = coords || null;
                            return next;
                          });
                          if (coords && val) {
                            const k = val.trim().toLowerCase();
                            if (k) setCityCoords(p => (p[k] && p[k].lat != null ? p : { ...p, [k]: { lat: coords.lat, lng: coords.lng } }));
                          }
                        }} fetchOptions={searchCities} placeholder="Search any city in India…" />


                      ) : type==="combobox" || type==="combobox-strict" ? (
                        <Combobox value={lForm[field]} onChange={(val)=>setLForm(p=>({...p,[field]:val}))} options={opts} placeholder="Type to search…" />
                      ) : type==="select" ? (
                        <select value={lForm[field]} onChange={e=>setLForm(p=>({...p,[field]:e.target.value}))} style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".46rem .65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",transition:"border-color .15s"}}>
                          {Array.isArray(opts) && opts.map(o=><option key={o} value={o}>{o||"Any"}</option>)}
                        </select>
                      ) : type==="date" ? (
                        <DateField value={lForm[field]} onChange={(val)=>setLForm(p=>({...p,[field]:val}))} />
                      ) : type==="textarea" ? (
                        <textarea value={lForm[field]} onChange={e=>setLForm(p=>({...p,[field]:e.target.value}))} placeholder={opts} style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".46rem .65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",transition:"border-color .15s",resize:"vertical",minHeight:50}}/>
                      ) : (
                        <input type={type} value={lForm[field]} onChange={e=>setLForm(p=>({...p,[field]:e.target.value}))} placeholder={opts} style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".46rem .65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",transition:"border-color .15s"}}/>
                      )}
                    </div>
                  ))}
                </div>
                </Fragment>
                );
              })}
                <div style={{display:"flex",flexDirection:"column",gap:".5rem",marginBottom:".75rem",padding:".625rem .75rem",background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:6}}>
                  {!lEdit && (
                  <div style={{display:"flex",alignItems:"center",gap:".55rem",opacity:lExtra.multiLoads?0.45:1}}>
                    <input type="checkbox" id="lf-dup" disabled={lExtra.multiLoads} checked={lExtra.duplicate && !lExtra.multiLoads} onChange={e=>setLExtra(p=>({...p,duplicate:e.target.checked}))} />
                    <label htmlFor="lf-dup" style={{fontSize:".72rem",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif",letterSpacing:0,textTransform:"uppercase",color:"#111827",cursor:lExtra.multiLoads?"not-allowed":"pointer"}}>Duplicate?</label>
                    {lExtra.duplicate && !lExtra.multiLoads && (
                      <input type="number" min="1" max="50" value={lExtra.dupCount} onChange={e=>{
                        const v = e.target.value;
                        if (v === "") { setLExtra(p=>({...p,dupCount:""})); return; }
                        const n = Math.max(1, Math.min(50, Number(v)||1));
                        setLExtra(p=>({...p,dupCount:n}));
                      }} onBlur={e=>{
                        const n = Math.max(1, Math.min(50, Number(e.target.value)||1));
                        setLExtra(p=>({...p,dupCount:n}));
                      }} style={{width:70,background:"#ffffff",border:"1px solid var(--border)",padding:".3rem .45rem",borderRadius:6,fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",outline:"none"}} />
                    )}
                  </div>
                  )}
                  <div style={{display:"flex",alignItems:"center",gap:".55rem",opacity:lExtra.multiLoads?0.45:1}}>
                    <input type="checkbox" id="lf-multi" disabled={lExtra.multiLoads} checked={lExtra.multi && !lExtra.multiLoads} onChange={e=>{
                      const on = e.target.checked;
                      setLExtra(p=>{
                        const n = Math.max(1, Number(p.multiCount)||1);
                        return { ...p, multi:on, consignees: on ? Array.from({length:n},(_,i)=>p.consignees[i]||"") : [""] };
                      });
                    }} />
                    <label htmlFor="lf-multi" style={{fontSize:".72rem",fontWeight:600,fontFamily:"'Inter',system-ui,sans-serif",letterSpacing:0,textTransform:"uppercase",color:"#111827",cursor:lExtra.multiLoads?"not-allowed":"pointer"}}>Multiple Consignee</label>
                    {lExtra.multi && !lExtra.multiLoads && (
                      <input type="number" min="1" max="30" value={lExtra.multiCount} onChange={e=>{
                        const v = e.target.value;
                        if (v === "") { setLExtra(p=>({...p, multiCount:""})); return; }
                        const n = Math.max(1, Math.min(30, Number(v)||1));
                        setLExtra(p=>({...p, multiCount:n, consignees: Array.from({length:n},(_,i)=>p.consignees[i]||"")}));
                      }} onBlur={e=>{
                        const n = Math.max(1, Math.min(30, Number(e.target.value)||1));
                        setLExtra(p=>({...p, multiCount:n, consignees: Array.from({length:n},(_,i)=>p.consignees[i]||"")}));
                      }} style={{width:70,background:"#ffffff",border:"1px solid var(--border)",padding:".3rem .45rem",borderRadius:6,fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",outline:"none"}} />
                    )}
                  </div>
                  {lExtra.multi && (
                    <div style={{display:"flex",flexDirection:"column",gap:".35rem"}}>
                      <div style={{fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>Consignee Cities ({lExtra.consignees.length})</div>
                      {lExtra.consignees.map((c,i)=>(
                        <Combobox key={i} value={c} onChange={(val)=>setLExtra(p=>{const arr=[...p.consignees];arr[i]=val;return {...p,consignees:arr};})} fetchOptions={searchCities} placeholder={`Consignee ${i+1} city`} />
                      ))}
                    </div>
                  )}
                </div>
              <button onClick={saveLoad} style={{width:"100%",background:"#374151",color:"#ffffff",border:"none",padding:".6rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",marginTop:".2rem",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s"}}>SAVE LOAD</button>
              {lEdit && <button onClick={()=>{setLForm(blankL());setLEdit(false);}} style={{width:"100%",background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".46rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",cursor:"pointer",marginTop:".3rem",textTransform:"uppercase"}}>CANCEL</button>}
            </div>
            <div style={{borderTop:"1px solid var(--border)"}}>
              <div style={{padding:".7rem 1.2rem .35rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>Load Activity</div>
              <div style={{padding:"0 1.2rem .7rem",display:"flex",flexDirection:"column",gap:".45rem"}}>
                {loadLogs.map((l,i)=>(
                  <div key={i} style={{display:"flex",gap:".55rem",alignItems:"flex-start"}}>
                    <div style={{width:6,height:6,borderRadius:"50%",background:l.color,marginTop:4,flexShrink:0}}/>
                    <div><div style={{fontSize:".72rem",color:"#6b7280",lineHeight:1.4}}>{l.msg}</div><div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",color:"#111827"}}>{l.t}</div></div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>}

        {/* Mobile FAB to open Add Vehicle / Add Load panel */}
        {(tab==="fleet"||tab==="loads") && !mobileSideOpen && (
          <button onClick={()=>setMobileSideOpen(true)} className="tms-side-fab" style={{display:"none",position:"fixed",right:16,bottom:16,zIndex:60,background:tab==="loads"?"#374151":"#111827",color:"#ffffff",border:"none",borderRadius:"50%",width:56,height:56,boxShadow:"0 6px 18px rgba(0,0,0,.25)",fontSize:28,fontWeight:600,cursor:"pointer"}} aria-label={tab==="loads"?"Add Load":"Add Vehicle"}>+</button>
        )}
      </div>

      {/* ══ URGENT LOADS TAB ══ */}
      {tab==="urgent" && (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7",width:"100%"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:10}}>
            Urgent Loads
            <span style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.35)",borderRadius:6,padding:"2px 10px",fontSize:".78rem",fontWeight:600,color:"var(--red)",letterSpacing:0}}>{Object.keys(urgentLoads).length} flagged</span>
          </div>
          {Object.keys(urgentLoads).length===0 ? (
            <div style={{textAlign:"center",padding:"4rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>
              <div style={{fontSize:40,marginBottom:12}}></div>
              No urgent loads. All clear!
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:".8rem"}}>
              {loads.filter(l=>urgentLoads[l.id]).map(l => {
                const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
                const sBg = av ? (av.vstatus==="IN_TRANSIT"?"rgba(37,99,235,0.08)":av.vstatus==="AVAILABLE"?"rgba(22,163,74,0.08)":av.vstatus==="AT_LOADING"?"rgba(217,119,6,0.08)":av.vstatus==="SENT_FOR_LOADING"?"rgba(99,102,241,0.08)":av.vstatus==="AT_UNLOADING"?"#fff1f2":av.vstatus==="EMPTY"?"rgba(37,99,235,0.08)":"#f2f4f7") : null;
                const sCol = av ? (av.vstatus==="IN_TRANSIT"?"#2563eb":av.vstatus==="AVAILABLE"?"#16a34a":av.vstatus==="AT_LOADING"?"#d97706":av.vstatus==="SENT_FOR_LOADING"?"#6366f1":av.vstatus==="AT_UNLOADING"?"#d97706":av.vstatus==="EMPTY"?"#16a34a":"#6b7280") : null;
                return (
                  <div key={l.id} style={{background:"rgba(239,68,68,0.06)",border:"2px solid #dc2626",borderLeft:"5px solid #dc2626",borderRadius:12,padding:"1rem 1.2rem",boxShadow:"0 2px 8px rgba(220,38,38,.1)"}}>
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",marginBottom:".75rem"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                        <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,color:"#374151"}}>{l.lid}</span>
                        <span style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.35)",borderRadius:12,padding:"2px 9px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"var(--red)",letterSpacing:0}}> URGENT</span>
                        <span style={{fontSize:".68rem",fontWeight:l.priority==="HIGH"?700:600,color:l.priority==="HIGH"?"#dc2626":l.priority==="MEDIUM"?"#d97706":"#6b7280"}}>
                          {l.priority==="HIGH"?"🔴 HIGH":l.priority==="MEDIUM"?"🟡 MED":"🟢 LOW"}
                        </span>
                        {l.lstatus==="LATE" && <span style={{background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.4)",borderRadius:12,padding:"2px 7px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#6366f1"}}> DELAYED</span>}
                      </div>
                      <button onClick={()=>toggleUrgent(l.id)} style={{background:"#ffffff",border:"1px solid var(--border)",color:"#111827",padding:"4px 12px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Remove Flag</button>
                    </div>
                    <div style={{display:"flex",gap:"1.5rem",flexWrap:"wrap"}}>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Customer</div>
                        <div style={{fontWeight:600,fontSize:".84rem"}}>{l.customer||"—"}</div>
                        {l.branch && <div style={{fontSize:".72rem",color:"#111827"}}>{l.branch}</div>}
                      </div>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Route</div>
                        <div style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:".84rem",fontWeight:600,color:"#111827"}}>
                          <span>{l.origin||"—"}</span>
                          <span style={{color:"#374151",fontWeight:600}}>→</span>
                          <span>{l.dest||"—"}</span>
                        </div>
                        {l.consignees?.length > 0 && (
                          <div style={{marginTop:3}}>
                            <span title={l.consignees.join(", ")} style={{display:"inline-flex",alignItems:"center",background:"rgba(124,58,237,0.1)",border:"1px solid rgba(124,58,237,0.35)",borderRadius:12,padding:"1px 7px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,color:"#6366f1"}}>C - {l.consignees.length}</span>
                          </div>
                        )}
                      </div>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Commodity</div>
                        <div style={{fontWeight:500,fontSize:".84rem"}}>{l.commodity||"—"}</div>
                        {l.vtypeReq && <div style={{fontSize:".72rem",color:"#6366f1",fontWeight:600}}>{l.vtypeReq}</div>}
                      </div>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Pickup</div>
                        <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",color:"#111827"}}>{fmtDT(l.pickup)}</div>
                      </div>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Assigned Vehicle</div>
                        {av ? (
                          <div>
                            <div style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:6,padding:"2px 7px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:"#6b7280"}}>{av.vnum}</div>
                            <div style={{fontSize:".72rem",color:"#111827",marginTop:2}}>{av.driver}</div>
                            <div style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",color:"#111827"}}>{av.mobile}</div>
                            <div style={{marginTop:3}}>
                              <VStatusPill status={av.vstatus} />
                            </div>

                          </div>
                        ) : (
                          <div>
                            <div style={{fontSize:".84rem",color:"var(--red)",fontWeight:600}}>No vehicle assigned!</div>
                            <button onClick={()=>setAssignLid(l.id)} style={{marginTop:4,background:"#374151",color:"#ffffff",border:"none",padding:"3px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Assign Now</button>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══ DELAYED LOADS TAB ══ */}
      {tab==="delayed" && (() => {
        const allDelayed = loads.filter(l=>l.lstatus==="LATE");
        const importantDelayed = allDelayed.filter(l=>importantDelayedLoads[l.id]);
        const shownLoads = delayedSubTab==="important" ? importantDelayed : allDelayed;
        return (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
          {/* Header */}
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".75rem",display:"flex",alignItems:"center",gap:10}}>
            Delayed Loads
            <span style={{background:"rgba(217,119,6,0.08)",border:"1px solid rgba(245,158,11,0.4)",borderRadius:6,padding:"2px 10px",fontSize:".78rem",fontWeight:600,color:"#6b7280",letterSpacing:0}}>{allDelayed.length} flagged</span>
            {importantDelayed.length>0 && <span style={{background:"rgba(249,115,22,0.08)",border:"1px solid rgba(249,115,22,0.4)",borderRadius:6,padding:"2px 10px",fontSize:".78rem",fontWeight:600,color:"#6b7280",letterSpacing:0}}>⭐ {importantDelayed.length} important</span>}
          </div>
          {/* Sub-tabs */}
          <div style={{display:"flex",gap:".35rem",marginBottom:"1.1rem",borderBottom:"1px solid var(--border)",paddingBottom:".6rem"}}>
            {[["all","All Delayed",allDelayed.length,"#854d0e","#fef9c3","#fde047"],["important","⭐ Important",importantDelayed.length,"#d97706","rgba(217,119,6,0.08)","#d97706"]].map(([id,label,cnt,col,bg,border])=>(
              <button key={id} onClick={()=>setDelayedSubTab(id)}
                style={{padding:".42rem 1rem",borderRadius:6,border:"1px solid",borderColor:delayedSubTab===id?border:"#e4e7ed",background:delayedSubTab===id?bg:"#ffffff",color:delayedSubTab===id?col:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,cursor:"pointer",textTransform:"uppercase",display:"flex",alignItems:"center",gap:5}}>
                {label} <span style={{background:delayedSubTab===id?col:"#e4e7ed",color:delayedSubTab===id?"#ffffff":"#6b7280",borderRadius:8,fontSize:".68rem",padding:"0 5px",fontWeight:600}}>{cnt}</span>
              </button>
            ))}
          </div>
          {shownLoads.length===0 ? (
            <div style={{textAlign:"center",padding:"4rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>
              <div style={{fontSize:40,marginBottom:12}}>{delayedSubTab==="important"?"⭐":""}</div>
              {delayedSubTab==="important" ? "No loads marked as important yet. Mark loads with ⭐ to see them here." : "No delayed loads right now. Good job!"}
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:"1rem"}}>
              {shownLoads.map(l => {
                const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
                const di = delayInfo[l.id];
                const drObj = di ? DELAY_REASONS.find(r=>r.id===di.reason) : null;
                const isStoppage = di?.reason==="STOPPAGE";
                const confirmDue = di?.stoppageConfirmDue;
                const confirmOverdue = confirmDue && new Date(confirmDue) <= new Date() && !di?.managerConfirmed;
                return (
                  <div key={l.id} style={{background:importantDelayedLoads[l.id]?"rgba(220,38,38,0.08)":"#fefce8",border:"2px solid",borderColor:importantDelayedLoads[l.id]?"rgba(220,38,38,0.35)":confirmOverdue?"rgba(249,115,22,0.35)":"rgba(234,179,8,0.3)",borderLeft:`5px solid ${importantDelayedLoads[l.id]?"#dc2626":confirmOverdue?"#d97706":"#d97706"}`,borderRadius:12,padding:"1rem 1.2rem",boxShadow:importantDelayedLoads[l.id]?"0 2px 12px rgba(234,88,12,.15)":"0 2px 8px rgba(234,179,8,.1)"}}>
                    {/* Header */}
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",marginBottom:".8rem"}}>
                      <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                        <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,color:"#374151"}}>{l.lid}</span>
                        <span style={{background:"rgba(245,158,11,0.15)",border:"1px solid rgba(245,158,11,0.4)",borderRadius:12,padding:"2px 9px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#6366f1",letterSpacing:0}}> DELAYED</span>
                        {importantDelayedLoads[l.id] && <span style={{background:"rgba(249,115,22,0.08)",border:"1px solid rgba(249,115,22,0.4)",borderRadius:12,padding:"2px 9px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#d97706",letterSpacing:0}}>⭐ IMPORTANT</span>}
                        {drObj && <span style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"2px 9px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#111827"}}>{drObj.icon} {drObj.label}</span>}
                        {confirmOverdue && <span style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.35)",borderRadius:12,padding:"2px 9px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"var(--red)",animation:"bk 1.5s infinite"}}>CONFIRMATION OVERDUE</span>}
                        <span style={{fontSize:".68rem",fontWeight:l.priority==="HIGH"?700:600,color:l.priority==="HIGH"?"#dc2626":l.priority==="MEDIUM"?"#d97706":"#6b7280"}}>{l.priority==="HIGH"?"🔴 HIGH":l.priority==="MEDIUM"?"🟡 MED":"🟢 LOW"}</span>
                      </div>
                      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                        <button onClick={()=>{setDelayModal(l.id);setDelayForm({reason:di?.reason||"",revisedEta:di?.revisedEta||"",});}} style={{background:"#ffffff",border:"1px solid #00d4aa",color:"#6366f1",padding:"4px 11px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>{di?"Edit Reason":"+ Set Reason"}</button>
                        {isStoppage && confirmDue && (
                          <button onClick={()=>{setConfirmModal(l.id);setConfirmForm({running:null,newEta:"",newReason:"",});}} style={{background:confirmOverdue?"#dc2626":"#2563eb",color:"#ffffff",border:"none",padding:"4px 11px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>{confirmOverdue?"Confirm Now":"Manager Confirm"}</button>
                        )}
                        <button onClick={()=>toggleImportantDelayed(l.id)} style={{background:importantDelayedLoads[l.id]?"rgba(217,119,6,0.08)":"#f2f4f7",border:"1px solid",borderColor:importantDelayedLoads[l.id]?"rgba(245,158,11,0.4)":"#e4e7ed",color:importantDelayedLoads[l.id]?"#d97706":"#6b7280",padding:"4px 11px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                          {importantDelayedLoads[l.id]?"⭐ Important ✕":"⭐ Important"}
                        </button>
                        <button onClick={()=>quickLS(l.id, l.vehicleId?"ASSIGNED":"PENDING")} style={{background:"#ffffff",border:"1px solid var(--border2)",color:"#111827",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Remove Flag</button>
                      </div>
                    </div>

                    {/* Delay reason detail block */}
                    {di && (
                      <div style={{background:"#ffffff",border:"1px solid rgba(245,158,11,0.3)",borderRadius:8,padding:".625rem .75rem",marginBottom:".8rem"}}>
                        <div style={{display:"flex",gap:"1.5rem",flexWrap:"wrap",alignItems:"flex-start"}}>
                          <div>
                            <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Delay Reason</div>
                            <div style={{fontWeight:600,fontSize:".84rem",color:"#6366f1"}}>{drObj?.icon} {drObj?.label||di.reason}</div>
                            <div style={{fontSize:".68rem",color:"#111827"}}>Set {di.setAt}</div>
                          </div>
                          {di.revisedEta && (
                            <div>
                              <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Revised ETA (Back on Road)</div>
                              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,color:confirmOverdue?"#dc2626":"#d97706"}}>{fmtDT(di.revisedEta)}</div>
                              {confirmOverdue && <div style={{fontSize:".68rem",color:"var(--red)",fontWeight:600}}>Confirmation due — manager action required</div>}
                            </div>
                          )}
                          {di.managerConfirmed && !confirmOverdue && (
                            <div>
                              <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Last Manager Confirm</div>
                              <div style={{fontSize:".84rem",fontWeight:600,color:"var(--green)"}}> Confirmed running</div>
                            </div>
                          )}
                          {/* Revised ETA history */}
                          {di.revisedEtaHistory && di.revisedEtaHistory.length>0 && (
                            <div>
                              <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,marginBottom:3}}>Previous ETAs</div>
                              {di.revisedEtaHistory.map((h,i)=>(
                                <div key={i} style={{fontSize:".68rem",color:"#111827",textDecoration:"line-through"}}>{fmtDT(h.eta)} ({DELAY_REASONS.find(r=>r.id===h.reason)?.label||h.reason})</div>
                              ))}
                            </div>
                          )}
                          {/* Confirmation history */}
                          {di.confirmHistory && di.confirmHistory.length>0 && (
                            <div>
                              <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,marginBottom:3}}>Confirmation Log</div>
                              {di.confirmHistory.map((h,i)=>(
                                <div key={i} style={{fontSize:".68rem",color:h.status==="RUNNING"?"#16a34a":"#d97706"}}>
                                  {h.status==="RUNNING"?" Running":" Stopped"} · {h.confirmedAt}
                                  {h.newEta && <span style={{color:"#111827"}}> → new ETA {fmtDT(h.newEta)}</span>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}

                    {/* Load info row */}
                    <div style={{display:"flex",gap:"1.5rem",flexWrap:"wrap"}}>
                      <div><div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Customer</div><div style={{fontWeight:600,fontSize:".84rem"}}>{l.customer||"—"}</div>{l.branch&&<div style={{fontSize:".72rem",color:"#111827"}}>{l.branch}</div>}</div>
                      <div><div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Route</div><div style={{display:"inline-flex",alignItems:"center",gap:5,fontSize:".84rem",fontWeight:600,color:"#111827"}}><span>{l.origin||"—"}</span><span style={{color:"#374151",fontWeight:600}}>→</span><span>{l.dest||"—"}</span></div></div>
                      <div><div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Commodity</div><div style={{fontWeight:500,fontSize:".84rem"}}>{l.commodity||"—"}</div></div>
                      <div><div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Expected Delivery</div><div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:"var(--red)"}}>{fmtDT(l.delivery)}</div></div>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Vehicle</div>
                        {av?(<div><div style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:6,padding:"2px 7px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:"#6b7280"}}>{av.vnum}</div><div style={{fontSize:".72rem",color:"#111827",marginTop:1}}>{av.driver} · {av.mobile}</div></div>):<div style={{fontSize:".84rem",color:"var(--red)",fontWeight:600}}>No vehicle</div>}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        );
      })()}

      {/* ══ BRANCH MANAGEMENT TAB ══ */}
      {tab==="unloading" && (() => {
        const unloadingVehicles = vehicles.filter(v => {
          if (v.vstatus !== "AT_UNLOADING") return false;
          const ld = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l=>l.vehicleId===v.id);
          return !!ld && ld.lstatus !== "DELIVERED";
        });
        const filtered = unloadingVehicles.filter(v => {
          const br = getDestBranch(v.destination);
          const ld = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l=>l.vehicleId===v.id);
          const mb = !unBranchFilter || br === unBranchFilter;
          const mc = !unCustomerFilter || (ld?.customer === unCustomerFilter);
          const q = unSearchDef.trim().toLowerCase();
          const ms = !q || [v.vnum,v.driver,v.destination,v.departure,br].some(f=>f&&String(f).toLowerCase().includes(q));
          return mb && mc && ms;
        });
        const branchCounts = {};
        unloadingVehicles.forEach(v => {
          const b = getDestBranch(v.destination) || "Unmapped";
          branchCounts[b] = (branchCounts[b]||0)+1;
        });
        return (
          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
               Unloading
              <span style={{background:"rgba(236,72,153,0.1)",border:"1px solid rgba(236,72,153,0.35)",borderRadius:6,padding:"2px 10px",fontSize:".78rem",fontWeight:600,color:"#6b7280",letterSpacing:0}}>{unloadingVehicles.length} vehicle{unloadingVehicles.length!==1?"s":""}</span>
              <button onClick={()=>{
                const validated = filtered.filter(v => {
                  const ld = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l=>l.vehicleId===v.id);
                  return !!ld?.validated;
                });
                if (!validated.length) { alert("No validated loads to export."); return; }
                const rows = validated.map(v => {
                  const ld = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l=>l.vehicleId===v.id);
                  const br = getDestBranch(v.destination) || "";
                  const atUn = v.atUnloadingAt || "";
                  let daysCell = "-", hoursSince = 0;
                  if (atUn) {
                    const at = new Date(atUn), now = new Date();
                    hoursSince = (now - at) / 36e5;
                    const ds=(d)=>{const x=new Date(d);x.setHours(0,0,0,0);return x;};
                    const dd = Math.floor((ds(now)-ds(at))/86400000);
                    daysCell = dd <= 0 ? "-" : String(dd);
                  }
                  return {
                    "Vehicle": v.vnum||"", "Driver": v.driver||"", "Mobile": v.mobile||"",
                    "Load ID": ld?.lid||"", "Customer": ld?.customer||"", "Commodity": ld?.commodity||"",
                    "Weight": ld?.weight||"", "Origin": ld?.origin||v.departure||"", "Destination": ld?.dest||v.destination||"",
                    "Branch": br, "LR Date": ld?.lrDate||v.lrDate||"",
                    "At Unloading Since": atUn, "Hours Since": hoursSince.toFixed(1), "Days": daysCell,
                    "Status": VS_LABELS[v.vstatus]||v.vstatus,
                  };
                 });
                 rows.sort((a, b) =>
                   (a.Branch || "zzz").localeCompare(b.Branch || "zzz") ||
                   (a.Vehicle || "").localeCompare(b.Vehicle || "")
                 );
                 // Build branch-wise sheet with heading rows between branches
                 const unHeaders = ["Vehicle","Driver","Mobile","Load ID","Customer","Commodity","Weight","Origin","Destination","Branch","LR Date","At Unloading Since","Hours Since","Days","Status"];
                 const unAoa = [unHeaders];
                 let unLastBranch = null;
                 for (const row of rows) {
                   const br = row["Branch"] || "Unassigned";
                   if (br !== unLastBranch) {
                     if (unLastBranch !== null) unAoa.push([]);
                     unAoa.push([`── ${br.toUpperCase()} ──`]);
                     unLastBranch = br;
                   }
                   unAoa.push(unHeaders.map(h => row[h] ?? ""));
                 }
                 const ws = XLSX.utils.aoa_to_sheet(unAoa);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "Unloading");
                XLSX.writeFile(wb, `unloading-export-${new Date().toISOString().slice(0,10)}.xlsx`);
              }} style={{marginLeft:"auto",background:"#374151",color:"#ffffff",border:"none",padding:".42rem .9rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s"}}>⬇ Export Validated</button>

            </div>

            {/* Branch chips summary */}
            <div style={{display:"flex",flexWrap:"wrap",gap:".5rem",marginBottom:"1rem"}}>
              <button className="branch-chip" data-active={!unBranchFilter} onClick={()=>setUnBranchFilter("")}>All ({unloadingVehicles.length})</button>
              {branches.map(b => {
                const c = branchCounts[b] || 0;
                return (
                  <button key={b} className="branch-chip" data-active={unBranchFilter===b} data-dim={c===0} onClick={()=>setUnBranchFilter(b===unBranchFilter?"":b)}>{b} ({c})</button>
                );
              })}
              {branchCounts["Unmapped"] > 0 && (
                <button onClick={()=>setUnBranchFilter("__UNMAPPED__")} style={{background:unBranchFilter==="__UNMAPPED__"?"#dc2626":"#ffffff",color:unBranchFilter==="__UNMAPPED__"?"#ffffff":"#dc2626",border:"1px solid rgba(220,38,38,0.08)",padding:".35rem .8rem",borderRadius:8,fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,cursor:"pointer",textTransform:"uppercase",letterSpacing:0}}>Unmapped ({branchCounts["Unmapped"]})</button>
              )}

            </div>

            {/* Search + Customer filter */}
            <div style={{display:"flex",gap:".7rem",marginBottom:"1rem",alignItems:"center",flexWrap:"wrap"}}>
              <input value={unSearch} onChange={e=>setUnSearch(e.target.value)} placeholder="Search vehicle, driver, destination..." style={{flex:1,maxWidth:340,background:"#ffffff",border:"1px solid var(--border)",color:"#111827",padding:".625rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none"}}/>
              <select value={unCustomerFilter} onChange={e=>setUnCustomerFilter(e.target.value)} style={{background:"#ffffff",border:"1px solid var(--border)",color:"#111827",padding:".625rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",minWidth:180}}>
                <option value="">All Customers</option>
                {customers.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
              {unCustomerFilter && (
                <button onClick={()=>setUnCustomerFilter("")} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:".42rem .7rem",borderRadius:6,fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,cursor:"pointer"}}>Clear Customer</button>
              )}
            </div>

            {/* Vehicles table */}
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,.3)",marginBottom:"1.5rem"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead style={{background:"#f2f4f7"}}>
                  <tr>
                    {["Vehicle","Driver","Load","Origin → Destination","Current GPS","Dist. to Dest","At Unloading Since","Days","Branch","Status","Action"].map(h=>(
                      <th key={h} style={{padding:".625rem .75rem",textAlign:"left",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",borderBottom:"1px solid var(--border)"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(() => {
                    const visible = filtered.filter(v => unBranchFilter === "__UNMAPPED__" ? !getDestBranch(v.destination) : true);
                    if (visible.length === 0) {
                      return <tr><td colSpan={11} style={{padding:"2rem",textAlign:"center",color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif"}}>No vehicles at unloading{unBranchFilter?` in ${unBranchFilter==="__UNMAPPED__"?"unmapped destinations":unBranchFilter}`:""}.</td></tr>;
                    }
                    const groups = {};
                    visible.forEach(v => {
                      const key = getDestBranch(v.destination) || "Unmapped";
                      (groups[key] ||= []).push(v);
                    });
                    const branchKeys = Object.keys(groups).sort((a,b) => {
                      if (a === "Unmapped") return 1;
                      if (b === "Unmapped") return -1;
                      return a.localeCompare(b);
                    });
                    return branchKeys.map(bk => (
                      <Fragment key={`grp-${bk}`}>
                        <tr>
                          <td colSpan={11} style={{padding:".5rem .8rem",background:"#f2f4f7",color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",borderTop:"1px solid var(--border)",borderBottom:"1px solid var(--border)"}}>
                            {bk} <span style={{marginLeft:8,background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1px 8px",fontSize:".68rem",color:"#111827"}}>{groups[bk].length}</span>
                          </td>
                        </tr>
                        {groups[bk].map(v => {
                    const br = getDestBranch(v.destination);
                    // Find load assigned to this vehicle (prefer v.loadId, else by vehicleId on loads)
                    const ld = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l=>l.vehicleId===v.id);
                    const vnumKey = gpsVehicleKey(v.vnum); const vnumKeyAlt = gpsVehicleKeyAlt(v.vnum);
                    const gps = (gpsMap[vnumKey] || gpsMap[vnumKeyAlt]);
                    const destCityRaw = ld?.dest || v.destination || "";
                    const destKey = destCityRaw.trim().toLowerCase();
                    const destCoord = destKey ? cityCoords[destKey] : null;
                    let distKm = null;
                    if (gps && gps.lat!=null && gps.lng!=null && destCoord && destCoord.lat!=null) {
                      distKm = haversineKm(gps.lat, gps.lng, destCoord.lat, destCoord.lng);
                    }
                    const atUn = v.atUnloadingAt || "";
                    let daysCell = "-", hoursSince = 0, isRed = false;
                    if (atUn) {
                      const at = new Date(atUn);
                      const now = new Date();
                      hoursSince = (now - at) / 36e5;
                      isRed = hoursSince > 15;
                      const dayStart = (d)=>{ const x=new Date(d); x.setHours(0,0,0,0); return x; };
                      const diffDays = Math.floor((dayStart(now) - dayStart(at)) / 86400000);
                      daysCell = diffDays <= 0 ? "-" : String(diffDays);
                    }
                    return (
                      <tr key={v.id} style={{borderBottom:"1px solid var(--border)",background:isRed?"rgba(220,38,38,0.18)":undefined}}>
                        <td style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#6366f1"}}>
                          <div style={{display:"flex",flexDirection:"column",alignItems:"flex-start",gap:3}}>
                            <span>{v.vnum}</span>
                            <button onClick={()=>openGpsMap(v, ld?.lid, ld?.id)} title={gps?.lat!=null?"View on map":"No live GPS yet"} disabled={!(gps?.lat!=null&&gps?.lng!=null)} style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",color:"#374151",padding:"1px 6px",borderRadius:6,cursor:gps?.lat!=null?"pointer":"not-allowed",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,opacity:gps?.lat!=null?1:.45}}>
                              <MapPin size={10}/> GPS
                            </button>
                            {v.mobile && (
                              <a href={`tel:${v.mobile}`} style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",color:"#374151",textDecoration:"none",fontWeight:600}}>📞 {v.mobile}</a>
                            )}
                          </div>
                        </td>
                        <td style={{padding:".625rem .75rem",fontSize:".84rem"}}>{v.driver || "—"}</td>
                        <td style={{padding:".625rem .75rem",fontSize:".84rem"}}>
                          {ld ? (
                            <div style={{display:"flex",flexDirection:"column",gap:2}}>
                              <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#374151",fontSize:".78rem"}}>{ld.lid}</span>
                              <span style={{fontSize:".78rem",color:"#111827",fontWeight:600}}>{ld.customer || "—"}</span>
                              <span style={{fontSize:".68rem",color:"#6b7280"}}>{ld.commodity || ""}{ld.weight?` · ${ld.weight}t`:""}</span>
                              {(ld.lrDate || v.lrDate) && <span style={{fontSize:".68rem",color:"#2563eb",fontFamily:"'Inter',system-ui,sans-serif"}}>LR: {ld.lrDate || v.lrDate}</span>}
                              {ld.consignees?.length > 0 && (() => {
                                const cons = ld.consignees.filter(Boolean);
                                const dels = stopsFor(ld);
                                 const delCount = cons.filter((c,i)=> !!dels[i]?.delivered).length;
                                 return (
                                   <div style={{marginTop:2}}>
                                     <div style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(124,58,237,0.1)",border:"1px solid rgba(124,58,237,0.35)",borderRadius:12,padding:"1px 7px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,color:"#6366f1"}}>
                                       C - {cons.length}{delCount>0?` · ✓${delCount}`:""}
                                     </div>
                                     <div style={{marginTop:5,display:"flex",flexDirection:"column",gap:3,background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:6,padding:"5px 7px",maxWidth:320}}>
                                       {cons.map((city,i) => {
                                         const d = dels[i] || {};
                                         const delivered = !!d.delivered;
                                         const podOk = !!d.podOk;
                                         return (
                                           <div key={`uncons-${ld.id}-${i}`} style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:6,fontSize:".68rem"}}>
                                             <span style={{color:"#111827",fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",flex:1,minWidth:0}}>{i+1}. {city}</span>
                                             <div style={{display:"flex",alignItems:"center",gap:4,flexShrink:0}}>
                                               {delivered ? (
                                                 <button onClick={()=>setConsigneeDelivered(ld.id,i,false)} title={d.deliveredAt?`Delivered ${fmtDT(d.deliveredAt)} · click to undo`:"Undo delivered"} style={{background:"rgba(34,197,94,0.18)",border:"1px solid rgba(34,197,94,0.5)",color:"#16a34a",padding:"1px 6px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",whiteSpace:"nowrap"}}>✓ {d.deliveredAt?fmtDT(d.deliveredAt):"Delivered"}</button>
                                               ) : (
                                                 <button onClick={()=>markConsigneeDeliveredWithPrompt(ld.id,i)} title="Mark this consignee as delivered" style={{background:"transparent",border:"1px solid #16a34a",color:"#16a34a",padding:"1px 6px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",whiteSpace:"nowrap"}}>Mark Delivered</button>
                                               )}
                                               <button onClick={()=>setConsigneePodOk(ld.id,i,!podOk)} title={podOk?"POD OK — click to clear":"Mark POD OK"} style={{background: podOk ? "#16a34a" : "transparent", border:`1px solid ${podOk ? "#16a34a" : "#6b7280"}`, color: podOk ? "#ffffff" : "#6b7280", padding:"1px 6px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,cursor:"pointer",whiteSpace:"nowrap"}}>{podOk ? "✓ POD OK" : "POD OK?"}</button>
                                             </div>
                                           </div>
                                         );
                                       })}

                                    </div>
                                  </div>
                                );
                              })()}

                            </div>
                          ) : <span style={{color:"#6b7280",fontSize:".78rem"}}>No load linked</span>}
                        </td>
                        <td style={{padding:".625rem .75rem",fontSize:".84rem"}}>
                          <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                            <span>{ld?.origin || v.departure || "—"}</span>
                            <span style={{color:"#374151",fontWeight:600}}>→</span>
                            <span>{destCityRaw || "—"}</span>
                          </div>
                        </td>
                        <td style={{padding:".625rem .75rem",fontSize:".78rem",maxWidth:200}}>
                          {gps ? (
                            <div style={{maxWidth:"100%"}}>
                              <div style={{fontWeight:600,color:"#111827",lineHeight:1.3,wordBreak:"break-word",overflowWrap:"break-word",maxWidth:"100%"}}>{gps.address || addrMap[vnumKey] || "—"}</div>
                              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",color:"#6b7280",marginTop:2}}>{gps.lat?.toFixed(3)}, {gps.lng?.toFixed(3)}</div>
                            </div>
                          ) : <span style={{color:"#6b7280"}}>No GPS</span>}
                        </td>
                        <td style={{padding:".625rem .75rem",fontSize:".84rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:distKm!=null?(distKm<50?"#16a34a":distKm<200?"#d97706":"#111827"):"#6b7280"}}>
                          {distKm!=null ? `${distKm.toFixed(0)} km` : "—"}
                        </td>
                        <td style={{padding:".625rem .75rem"}}>
                          <div style={{width:200}}>
                            <DateTimeField value={atUn} onChange={(val)=>{
                              pushVehicles(p=>p.map(x=>x.id===v.id?{...x, atUnloadingAt: val}:x));
                            }} accentBorder={isRed?"#ff6b6b":"#e4e7ed"} accentColor={isRed?"#dc2626":"#111827"} />
                          </div>
                          {atUn && <div style={{fontSize:".68rem",color:isRed?"#dc2626":"#6b7280",marginTop:2,fontWeight:isRed?700:400}}>{hoursSince.toFixed(1)} h ago{isRed?" · >15h":""}</div>}
                        </td>
                        <td style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:"1rem",color:isRed?"#dc2626":daysCell==="-"?"#6b7280":"#111827",textAlign:"center"}}>
                          {daysCell}
                        </td>
                        <td style={{padding:".625rem .75rem"}}>
                          {br ? (
                            <span style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:12,padding:"2px 8px",fontSize:".72rem",color:"#374151",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>{br}</span>
                          ) : (
                            <span style={{background:"rgba(220,38,38,0.08)",border:"1px solid rgba(248,113,113,0.3)",borderRadius:12,padding:"2px 8px",fontSize:".72rem",color:"#dc2626",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Unmapped</span>
                          )}
                        </td>
                        <td style={{padding:".625rem .75rem"}}>
                          <span style={{position:"relative",display:"inline-flex",alignItems:"center",gap:4,padding:"3px 10px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",background:"#fff1f2",color:"#d97706",cursor:"pointer"}} title="Click to change status">
                            {VS_LABELS[v.vstatus]} ▾
                            <select value="" onChange={e=>{if(e.target.value)quickVS(v.id,e.target.value);}} style={{position:"absolute",inset:0,opacity:0,cursor:"pointer"}}>
                              <option value="">Change…</option>
                              {Object.entries(VS_LABELS).map(([k,lbl])=><option key={k} value={k}>{lbl}</option>)}
                            </select>
                          </span>
                        </td>
                        <td style={{padding:".625rem .75rem"}}>
                          <div style={{display:"flex",flexDirection:"column",gap:5,alignItems:"flex-start"}}>
                            {(() => {
                              const activeLoadsForV = loads.filter(x => x.vehicleId === v.id && x.lstatus !== "DELIVERED");
                              if (activeLoadsForV.length <= 1) {
                                return (
                                  <button onClick={()=>quickVS(v.id,"DELIVERED", activeLoadsForV[0]?.id || ld?.id || null)} style={{background:"#16a34a",color:"#ffffff",border:"none",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Mark Delivered</button>
                                );
                              }
                              return activeLoadsForV.map(al => (
                                <button key={al.id} onClick={()=>quickVS(v.id,"DELIVERED", al.id)} title={`Deliver load ${al.lid} → ${al.dest||"—"}`} style={{background:"#16a34a",color:"#ffffff",border:"none",padding:"5px 12px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Mark Delivered · {al.lid}</button>
                              ));
                            })()}
                            {ld && (() => { const isV = !!ld.validated; return (
                              <label title={isV?"Uncheck to mark as not validated":"Mark as validated"} style={{display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6,height:26,padding:"0 10px",border:"1px solid "+(isV?"#86efac":"#e5e7eb"),borderRadius:6,background:isV?"#f0fdf4":"#ffffff",cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:isV?"#16a34a":"#6b7280",boxShadow:"0 1px 2px rgba(15,23,42,0.04)",transition:"all .12s",lineHeight:1}}>
                                <input type="checkbox" checked={isV} onChange={()=>toggleValidated(ld.id)} style={{margin:0,width:13,height:13,accentColor:"#16a34a",cursor:"pointer",flexShrink:0}}/>
                                <span style={{display:"inline-block",lineHeight:1}}>{isV?"Validated":"Validate"}</span>
                              </label>
                            );})()}
                          </div>
                        </td>

                      </tr>
                    );
                        })}
                      </Fragment>
                    ));
                  })()}
                </tbody>

              </table>
            </div>
          </div>
        );
      })()}

      {tab==="overview" && (() => {
        const STATUSES = [
          { key:"PENDING",          label:"Pending",          color:"#d97706" },
          { key:"SENT_FOR_LOADING", label:"Sent For Loading", color:"#2563eb" },
          { key:"AT_LOADING",       label:"At Loading",       color:"#0284c7" },
          { key:"IN_TRANSIT",       label:"On Trip",          color:"#6366f1" },
          { key:"AT_UNLOADING",     label:"At Unloading",     color:"#d97706" },
          { key:"DELAYED",          label:"Delayed",          color:"#dc2626" },
        ];
        const vById = Object.fromEntries(vehicles.map(v=>[v.id,v]));
        // Delayed set computed with the SAME logic as the TAT Tracker tab.
        const delayedIds = new Set();
        for (const l of loads) {
          const v = l.vehicleId ? vById[l.vehicleId] : null;
          if (!v || v.vstatus !== "IN_TRANSIT") continue;
          const { targetAt, arrivalAt } = computeTat(l, v, cityCoords, gpsMap);
          if (!targetAt || !arrivalAt) continue;
          const lateHours = (arrivalAt - targetAt) / 3600000;
          if (lateHours > 4) delayedIds.add(l.id);
        }
        const loadsForBox = (branch, status) => {
          return loads.filter(l => {
            if ((l.branch||"") !== branch) return false;
            const v = l.vehicleId ? vById[l.vehicleId] : null;
            if (status === "PENDING")          return l.lstatus === "PENDING";
            if (status === "DELAYED")          return delayedIds.has(l.id);
            if (status === "AT_UNLOADING")     return l.lstatus === "AT_UNLOADING" || v?.vstatus === "AT_UNLOADING";
            if (status === "IN_TRANSIT")       return v?.vstatus === "IN_TRANSIT";
            if (status === "SENT_FOR_LOADING") return v?.vstatus === "SENT_FOR_LOADING";
            if (status === "AT_LOADING")       return v?.vstatus === "AT_LOADING";
            return false;
          });
        };
        const sel = overviewSel;
        const selLoads = sel ? loadsForBox(sel.branch, sel.status) : [];
        const selStatus = sel ? STATUSES.find(s=>s.key===sel.status) : null;
        return (
          <div style={{flex:1,overflowY:"auto",background:"#f2f4f7",padding:"1.2rem"}}>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:"1rem"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>
                Branch Overview <span style={{color:"#6b7280",fontSize:".72rem",fontWeight:500,letterSpacing:0,textTransform:"none",marginLeft:8}}>Origin-wise load status.</span>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(340px, 1fr))",gap:"1rem"}}>
              {branches.map(branch => {
                const totalForBranch = loads.filter(l => (l.branch||"")===branch).length;
                return (
                  <div key={branch} className="premium-card" style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:".9rem 1rem",boxShadow:"0 1px 4px rgba(0,0,0,.25)"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:".7rem",paddingBottom:".5rem",borderBottom:"1px solid var(--border)"}}>
                      <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>🏢 {branch}</div>
                      <div style={{fontSize:".68rem",color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0}}>{totalForBranch} LOADS</div>
                    </div>
                    <div style={{display:"grid",gridTemplateColumns:"repeat(3, 1fr)",gap:".5rem"}}>
                      {STATUSES.map(s => {
                        const cnt = loadsForBox(branch, s.key).length;
                        const active = cnt > 0;
                        return (
                          <button key={s.key} onClick={()=> active && setOverviewSel({branch, status:s.key})}
                            disabled={!active}
                            title={`Origin branch: ${branch}`}
                            style={{
                              background: active ? `${s.color}14` : "#f2f4f7",
                              border:`1px solid ${active?s.color:"#e4e7ed"}`,
                              borderRadius:8,padding:".55rem .4rem",cursor:active?"pointer":"default",
                              opacity:active?1:.5,textAlign:"center",transition:"transform .12s",
                            }}
                            onMouseEnter={e=>{ if(active) e.currentTarget.style.transform="translateY(-1px)"; }}
                            onMouseLeave={e=>{ e.currentTarget.style.transform=""; }}
                          >
                            <div style={{fontSize:"1.2rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:active?s.color:"#6b7280",lineHeight:1}}>{cnt}</div>
                            <div style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:active?s.color:"#6b7280",marginTop:3}}>{s.label}</div>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>

            {sel && (
              <>
                <div onClick={()=>setOverviewSel(null)} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:80}}/>
                <div style={{position:"fixed",left:"50%",top:"50%",transform:"translate(-50%,-50%)",width:"min(900px, 94vw)",maxHeight:"86vh",background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,zIndex:81,display:"flex",flexDirection:"column",boxShadow:"0 20px 60px rgba(0,0,0,.4)"}}>
                  <div style={{padding:"1rem 1.2rem",borderBottom:"1px solid var(--border)",display:"flex",justifyContent:"space-between",alignItems:"center",gap:"1rem"}}>
                    <div>
                      <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>
                        🏢 {sel.branch} · <span style={{color:selStatus.color}}>{selStatus.label}</span>
                      </div>
                      <div style={{fontSize:".72rem",color:"#6b7280",marginTop:2}}>
                        Loads with origin branch = {sel.branch} · {selLoads.length} found
                      </div>
                    </div>
                    <button onClick={()=>setOverviewSel(null)} style={{background:"transparent",border:"1px solid var(--border)",borderRadius:6,padding:".35rem .75rem",cursor:"pointer",color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".72rem"}}>✕ CLOSE</button>
                  </div>
                  <div style={{flex:1,overflowY:"auto"}}>
                    {selLoads.length===0 ? (
                      <div style={{padding:"2rem",textAlign:"center",color:"#6b7280",fontSize:".9rem"}}>No loads in this bucket.</div>
                    ) : (
                      <table style={{width:"100%",borderCollapse:"collapse",fontSize:".84rem"}}>
                        <thead style={{background:"#f2f4f7",position:"sticky",top:0}}>
                          <tr style={{textAlign:"left"}}>
                            {["Load ID","Customer","Origin","Destination","Vehicle","Status","Delivery"].map(h=>(
                              <th key={h} style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",borderBottom:"1px solid var(--border)"}}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {selLoads.map(l => {
                            const v = l.vehicleId ? vById[l.vehicleId] : null;
                            const displayStatus = LS_LABELS[l.lstatus]||l.lstatus;
                            return (
                              <tr key={l.id} style={{borderBottom:"1px solid var(--border)"}}>
                                <td style={{padding:".625rem .75rem",fontWeight:600,color:"#374151"}}>{l.lid}</td>
                                <td style={{padding:".625rem .75rem"}}>{l.customer||"—"}</td>
                                <td style={{padding:".625rem .75rem"}}>{l.origin||"—"}</td>
                                <td style={{padding:".625rem .75rem"}}>{l.dest||"—"}</td>
                                <td style={{padding:".625rem .75rem"}}>{v?.vnum||"—"}</td>
                                <td style={{padding:".625rem .75rem"}}>
                                  <span style={{background:`${selStatus.color}1f`,color:selStatus.color,border:`1px solid ${selStatus.color}55`,padding:"2px 8px",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>{displayStatus}</span>
                                </td>
                                <td style={{padding:".625rem .75rem",color:"#6b7280"}}>{l.delivery ? fmtDT(l.delivery) : "—"}</td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    )}
                  </div>
                </div>
              </>
            )}
          </div>
        );
      })()}

      {tab==="settings" && (
        <div style={{flex:"0 0 auto",background:"#ffffff",borderBottom:"1px solid var(--border)",padding:".625rem .75rem"}}>
          <div style={{display:"flex",alignItems:"center",gap:".7rem",flexWrap:"wrap"}}>
            <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}> Settings</span>
            {[
              ["branches","🏢 Branches",branches.length],
              ["drivers","🧭 Drivers",vehicles.length],
              ["customers","👥 Customers",customers.length],
              ["driverapp","Driver App",null],
            ].map(([id,lbl,cnt])=>(
              <button key={id} onClick={()=>setSettingsSub(id)} style={{
                padding:".32rem .75rem",borderRadius:12,border:"1px solid",
                borderColor:settingsSub===id?"#374151":"#e4e7ed",
                background:settingsSub===id?"#374151":"#f2f4f7",
                color:settingsSub===id?"#ffffff":"#6b7280",
                fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".68rem",letterSpacing:0,textTransform:"uppercase",cursor:"pointer",whiteSpace:"nowrap"
              }}>{lbl}{cnt !== null && <span style={{opacity:.75,fontWeight:600}}> ({cnt})</span>}</button>
            ))}
          </div>
        </div>
      )}
      {tab==="settings" && settingsSub==="customers" && (
        <div style={{flex:1,overflowY:"auto",background:"#f2f4f7",display:"flex",flexDirection:"column",width:"100%"}}>
          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",width:"100%"}}>
              <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1rem 1.2rem",marginBottom:"1.2rem",boxShadow:"0 1px 4px rgba(0,0,0,.3)"}}>
                <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:".6rem"}}>Add New Customer</div>
                <div style={{display:"flex",gap:".6rem"}}>
                  <input value={newCustomerInput} onChange={e=>setNewCustomerInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addCustomer()} placeholder="Enter customer name e.g. Asian Paints…"
                    style={{flex:1,background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".52rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",outline:"none"}}/>
                  <button onClick={addCustomer} style={{background:"#374151",color:"#ffffff",border:"none",padding:".52rem 1.2rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",letterSpacing:0,cursor:"pointer",textTransform:"uppercase",whiteSpace:"nowrap"}}>+ Add</button>
                </div>
              </div>

              <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,.3)"}}>
                <div style={{padding:".65rem 1.2rem",background:"#f2f4f7",borderBottom:"1px solid var(--border)",display:"grid",gridTemplateColumns:"1fr auto auto",gap:"1rem",alignItems:"center"}}>
                  <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>Customer Name</div>
                  <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>Loads</div>
                  <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>Actions</div>
                </div>
                {customers.length===0 ? (
                  <div style={{textAlign:"center",padding:"2.5rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem"}}>No customers yet. Add your first customer above.</div>
                ) : customers.map((cust, idx) => {
                  const custLoads = loads.filter(l=>l.customer===cust);
                  const isEditing = editCustomerIdx===idx;
                  return (
                    <div key={idx} style={{padding:".75rem 1.2rem",borderBottom:"1px solid var(--border)",display:"grid",gridTemplateColumns:"1fr auto auto",gap:"1rem",alignItems:"center",background:isEditing?"#fefce8":"transparent"}}>
                      {isEditing ? (
                        <input value={editCustomerVal} onChange={e=>setEditCustomerVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveCustomerEdit(idx)} autoFocus
                          style={{background:"#ffffff",border:"1px solid #00d4aa",color:"#111827",padding:".38rem .6rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",outline:"none"}}/>
                      ) : (
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <span style={{fontSize:14}}>👥</span>
                          <span style={{fontWeight:600,fontSize:".9rem",color:"#111827"}}>{cust}</span>
                        </div>
                      )}
                      <span style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:12,padding:"2px 8px",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#374151"}}>{custLoads.length} load{custLoads.length!==1?"s":""}</span>
                      <div style={{display:"flex",gap:5}}>
                        {isEditing ? (
                          <>
                            <button onClick={()=>saveCustomerEdit(idx)} style={{background:"rgba(34,197,94,0.15)",color:"var(--green)",border:"1px solid rgba(34,197,94,0.4)",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Save</button>
                            <button onClick={()=>{setEditCustomerIdx(null);setEditCustomerVal("");}} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"4px 8px",borderRadius:6,cursor:"pointer",fontSize:".72rem"}}>✕</button>
                          </>
                        ) : (
                          <>
                            <button onClick={()=>{setEditCustomerIdx(idx);setEditCustomerVal(cust);}} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"4px 9px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Edit</button>
                            <button onClick={()=>deleteCustomer(idx)} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"4px 9px",borderRadius:6,cursor:"pointer",fontSize:".72rem"}}>Del</button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
        </div>
      )}

      {tab==="settings" && settingsSub==="driverapp" && isAdmin && (
        <div style={{flex:1,overflowY:"auto",background:"#f2f4f7",padding:"1.3rem",width:"100%"}}>
          <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:".625rem .75rem",maxWidth:520,boxShadow:"0 1px 4px rgba(0,0,0,.3)"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:".4rem"}}>
              Driver App Setup
            </div>
            <div style={{fontSize:".84rem",color:"#6b7280",marginBottom:"1.2rem",lineHeight:1.5}}>
              Creates a shared service account that all driver devices use to authenticate automatically. Drivers only need to enter their vehicle PIN — no login screen ever.
            </div>
            {driverAccountStatus === "exists" ? (
              <div style={{display:"flex",alignItems:"center",gap:10,padding:".75rem 1rem",background:"rgba(34,197,94,0.08)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:8}}>
                <span style={{fontSize:18}}></span>
                <div>
                  <div style={{fontWeight:600,fontSize:".84rem",color:"var(--green)"}}>Driver account active</div>
                  <div style={{fontSize:".78rem",color:"#6b7280"}}>All driver devices will auto-authenticate on next open.</div>
                </div>
              </div>
            ) : (
              <button
                onClick={handleCreateDriverAccount}
                disabled={driverAccountLoading}
                style={{
                  background:"#374151",color:"#ffffff",border:"none",
                  padding:".6rem 1.4rem",borderRadius:8,
                  fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",
                  letterSpacing:0,textTransform:"uppercase",
                  cursor:driverAccountLoading?"not-allowed":"pointer",
                  opacity:driverAccountLoading?0.6:1
                }}
              >
                {driverAccountLoading ? "Creating…" : "Create Driver Account"}
              </button>
            )}
            {driverAccountError && (
              <div style={{marginTop:".8rem",fontSize:".78rem",color:"var(--red)",padding:".5rem .8rem",background:"rgba(239,68,68,0.08)",borderRadius:6,border:"1px solid rgba(239,68,68,0.25)"}}>
                {driverAccountError}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Maintenance bulk-action section removed Jul 4 (M3 audit). */}


      {(tab==="branchmgmt" || (tab==="settings" && settingsSub==="branches")) && (

        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7",width:"100%"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:10}}>
            Branch Management
            <span style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:6,padding:"2px 10px",fontSize:".78rem",fontWeight:600,color:"#6b7280",letterSpacing:0}}>{branches.length} branches</span>
          </div>

          {/* Add new branch */}
          <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1rem 1.2rem",marginBottom:"1.2rem",boxShadow:"0 1px 4px rgba(0,0,0,.3)"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:".6rem"}}>Add New Branch</div>
            <div style={{display:"flex",gap:".6rem"}}>
              <input value={newBranchInput} onChange={e=>setNewBranchInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&addBranch()} placeholder="Enter branch name e.g. Surat, Dahej, JNPT…"
                style={{flex:1,background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".52rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",outline:"none"}}/>
              <button onClick={addBranch} style={{background:"#374151",color:"#ffffff",border:"none",padding:".52rem 1.2rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",letterSpacing:0,cursor:"pointer",textTransform:"uppercase",whiteSpace:"nowrap"}}>+ Add</button>
            </div>
          </div>

          {/* Branch list */}
          <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden",boxShadow:"0 1px 4px rgba(0,0,0,.3)"}}>
            <div style={{padding:".65rem 1.2rem",background:"#f2f4f7",borderBottom:"1px solid var(--border)",display:"grid",gridTemplateColumns:"1fr auto auto",gap:"1rem",alignItems:"center"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>Branch Name</div>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>Vehicles</div>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>Actions</div>
            </div>
            {branches.length===0 ? (
              <div style={{textAlign:"center",padding:"2.5rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem"}}>No branches yet. Add your first branch above.</div>
            ) : branches.map((branch, idx) => {
              const branchVehicles = vehicles.filter(v=>v.branch===branch);
              const isEditing = editBranchIdx===idx;
              return (
                <div key={idx} style={{padding:".75rem 1.2rem",borderBottom:"1px solid var(--border)",display:"grid",gridTemplateColumns:"1fr auto auto",gap:"1rem",alignItems:"center",background:isEditing?"#fefce8":"transparent"}}>
                  {isEditing ? (
                    <input value={editBranchVal} onChange={e=>setEditBranchVal(e.target.value)} onKeyDown={e=>e.key==="Enter"&&saveBranchEdit(idx)} autoFocus
                      style={{background:"#ffffff",border:"1px solid #00d4aa",color:"#111827",padding:".38rem .6rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",outline:"none"}}/>
                  ) : (
                    <div style={{display:"flex",alignItems:"center",gap:8}}>
                      <span style={{fontSize:14}}></span>
                      <span style={{fontWeight:600,fontSize:".9rem",color:"#111827"}}>{branch}</span>
                    </div>
                  )}
                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                    <span style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:12,padding:"2px 8px",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#374151"}}>{branchVehicles.length} vehicle{branchVehicles.length!==1?"s":""}</span>
                    {branchVehicles.filter(v=>v.vstatus==="AVAILABLE").length>0 && <span style={{background:"rgba(34,197,94,0.1)",border:"1px solid rgba(34,197,94,0.3)",borderRadius:12,padding:"2px 7px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"var(--green)"}}>{branchVehicles.filter(v=>v.vstatus==="AVAILABLE").length} avail</span>}
                    {branchVehicles.filter(v=>v.vstatus==="MAINTENANCE").length>0 && <span style={{background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.35)",borderRadius:12,padding:"2px 7px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"var(--red)"}}>{branchVehicles.filter(v=>v.vstatus==="MAINTENANCE").length} maint</span>}
                  </div>
                  <div style={{display:"flex",gap:5}}>
                    {isEditing ? (
                      <>
                        <button onClick={()=>saveBranchEdit(idx)} style={{background:"rgba(34,197,94,0.15)",color:"var(--green)",border:"1px solid rgba(34,197,94,0.4)",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Save</button>
                        <button onClick={()=>{setEditBranchIdx(null);setEditBranchVal("");}} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"4px 8px",borderRadius:6,cursor:"pointer",fontSize:".72rem"}}>✕</button>
                      </>
                    ) : (
                      <>
                        <button onClick={()=>{setEditBranchIdx(idx);setEditBranchVal(branch);}} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"4px 9px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Edit</button>
                        <button onClick={()=>{if(branchVehicles.length>0){alert(`Cannot delete: ${branchVehicles.length} vehicle(s) are assigned to this branch. Reassign them first.`);return;}deleteBranch(idx);}} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"4px 9px",borderRadius:6,cursor:"pointer",fontSize:".72rem"}} title={branchVehicles.length>0?"Cannot delete branch with vehicles":""}>Del</button>
                      </>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {/* Summary stats */}
          <div style={{marginTop:"1.2rem",display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:".75rem"}}>
            {[
              ["Total Branches",branches.length,"#2563eb","rgba(37,99,235,0.08)","rgba(56,189,248,0.2)"],
              ["Unassigned Vehicles",vehicles.filter(v=>!v.branch).length,"#6b7280","#f2f4f7","#e4e7ed"],
              ["Largest Branch",branches.reduce((a,b)=>vehicles.filter(v=>v.branch===b).length>vehicles.filter(v=>v.branch===a).length?b:a,branches[0])||"—","#d97706","rgba(217,119,6,0.08)","rgba(245,158,11,0.25)"],
            ].map(([label,val,col,bg,border])=>(
              <div key={label} style={{background:bg,border:`1px solid ${border}`,borderRadius:8,padding:".75rem 1rem"}}>
                <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,color:col}}>{val}</div>
                <div style={{fontSize:".68rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginTop:2}}>{label}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ══ DRIVER PREFERENCES TAB ══ */}
      {(tab==="driverprefs" || (tab==="settings" && settingsSub==="drivers")) && (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:10}}>
            Driver & Route Preferences
            <span style={{color:"#111827",fontSize:".78rem",fontWeight:400,letterSpacing:0}}>{vehicles.length} drivers</span>
          </div>
          {/* Search */}
          <div style={{display:"flex",gap:".7rem",marginBottom:"1.1rem",alignItems:"center"}}>
            <div style={{position:"relative",flex:1,maxWidth:340}}>
              <input value={dpSearch} onChange={e=>setDpSearch(e.target.value)} placeholder="Search driver, vehicle, route..." style={{width:"100%",background:"#ffffff",border:"1px solid var(--border)",color:"#111827",padding:".48rem .9rem .48rem 2.1rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none"}}/>
              <span style={{position:"absolute",left:".55rem",top:"50%",transform:"translateY(-50%)",color:"#111827",fontSize:14}}>🔍</span>
            </div>
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:".8rem"}}>
            {vehicles
              .filter(v => !dpSearchDef || [v.vnum,v.driver,v.vtype,v.prefRoutes,v.prefVtypes].some(f=>f&&f.toLowerCase().includes(dpSearchDef.toLowerCase())))
              .map(v => {
                const isEditing = dpEdit === v.id;
                const sBg = v.vstatus==="IN_TRANSIT"?"rgba(37,99,235,0.08)":v.vstatus==="AVAILABLE"?"rgba(22,163,74,0.08)":v.vstatus==="AT_LOADING"?"rgba(217,119,6,0.08)":v.vstatus==="SENT_FOR_LOADING"?"rgba(99,102,241,0.08)":v.vstatus==="AT_UNLOADING"?"#fff1f2":v.vstatus==="EMPTY"?"rgba(37,99,235,0.08)":v.vstatus==="DELIVERED"?"rgba(22,163,74,0.08)":"#f2f4f7";
                const sCol = v.vstatus==="IN_TRANSIT"?"#2563eb":v.vstatus==="AVAILABLE"?"#16a34a":v.vstatus==="AT_LOADING"?"#d97706":v.vstatus==="SENT_FOR_LOADING"?"#6366f1":v.vstatus==="AT_UNLOADING"?"#d97706":v.vstatus==="EMPTY"?"#16a34a":v.vstatus==="DELIVERED"?"#059669":"#6b7280";
                return (
                  <div key={v.id} style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1rem 1.2rem",boxShadow:"0 1px 4px rgba(0,0,0,.3)"}}>
                    {/* Header row */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:isEditing?".9rem":".6rem",flexWrap:"wrap",gap:".5rem"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10}}>
                        <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#6366f1"}}>{v.vnum}</span>
                        <span style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",padding:"2px 6px",border:"1px solid var(--border)",borderRadius:6,color:"#6b7280"}}>{v.vtype}</span>
                        <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"2px 8px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",background:sBg,color:sCol}}>
                          <span style={{width:5,height:5,borderRadius:"50%",background:"currentColor",opacity:.8}}/>{VS_LABELS[v.vstatus]}
                        </span>
                      </div>
                      <div style={{display:"flex",gap:".4rem"}}>
                        {!isEditing ? (
                          <button onClick={()=>{setDpEdit(v.id);setDpForm({prefRoutes:v.prefRoutes||"",prefVtypes:v.prefVtypes||"",driverExp:v.driverExp||"",driverNote:v.driverNote||"",driverRating:v.driverRating||0});}}
                            style={{background:"#374151",color:"#ffffff",border:"none",padding:"4px 12px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Edit Preferences</button>
                        ) : (
                          <>
                            <button onClick={()=>{
                              pushVehicles(p=>p.map(x=>x.id===v.id?{...x,...dpForm}:x));
                              addLog(`Updated preferences for ${v.vnum}`,"#2563eb");
                              setDpEdit(null);
                            }} style={{background:"rgba(34,197,94,0.15)",color:"var(--green)",border:"1px solid rgba(34,197,94,0.4)",padding:"4px 12px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Save</button>
                            <button onClick={()=>setDpEdit(null)} style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Cancel</button>
                          </>
                        )}
                      </div>
                    </div>
                    {/* Driver info row */}
                    <div style={{display:"flex",gap:"1.5rem",flexWrap:"wrap",marginBottom:isEditing?".9rem":0}}>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Driver</div>
                        <div style={{fontWeight:600,fontSize:".9rem"}}>{v.driver||"—"}</div>
                        <div style={{fontSize:".72rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>{v.mobile||""}</div>
                      </div>
                      {!isEditing && <>
                        <div>
                          <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Experience</div>
                          <div style={{fontSize:".9rem",fontWeight:500}}>{v.driverExp||<span style={{color:"#6b7280"}}>Not set</span>}</div>
                        </div>
                        <div>
                          <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Driver Rating</div>
                          <div style={{marginTop:2}}><StarDisplay rating={v.driverRating||0} size={16}/></div>
                          <div style={{fontSize:".68rem",color:"#111827",marginTop:1}}>{v.driverRating?`${v.driverRating}/5 stars`:"Not rated"}</div>
                        </div>
                        <div style={{flex:1,minWidth:160}}>
                          <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Preferred Routes</div>
                          <div style={{fontSize:".84rem",color:"#111827"}}>{v.prefRoutes||<span style={{color:"#6b7280"}}>No preferences set</span>}</div>
                        </div>
                        <div style={{flex:1,minWidth:130}}>
                          <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Preferred Vehicle Types</div>
                          <div style={{fontSize:".84rem",color:"#111827"}}>{v.prefVtypes||<span style={{color:"#6b7280"}}>No preferences set</span>}</div>
                        </div>
                        <div style={{flex:1,minWidth:130}}>
                          <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Notes</div>
                          <div style={{fontSize:".84rem",color:"#111827",fontStyle:"italic"}}>{v.driverNote||<span style={{color:"#6b7280",fontStyle:"normal"}}>—</span>}</div>
                        </div>
                      </>}
                    </div>
                    {/* Inline edit form */}
                    {isEditing && (
                      <div style={{borderTop:"1px solid var(--border)",paddingTop:".9rem"}}>
                        <div style={{marginBottom:".85rem"}}>
                          <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:6}}>Driver Rating (tap to set)</label>
                          <StarPicker value={dpForm.driverRating||0} onChange={val=>setDpForm(p=>({...p,driverRating:val}))}/>
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:".7rem"}}>
                          {[["Preferred Routes (comma separated)","prefRoutes","text","Gurgaon-Mumbai, Jaipur-Gurgaon"],["Preferred Vehicle Types","prefVtypes","text","Heavy Truck, Flatbed"],["Experience","driverExp","text","e.g. 5 yrs"],["Driver Notes","driverNote","text","Night shift preferred, no hills…"]].map(([lbl,field,type,ph])=>(
                            <div key={field}>
                              <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:3}}>{lbl}</label>
                              <input type={type} value={dpForm[field]} onChange={e=>setDpForm(p=>({...p,[field]:e.target.value}))} placeholder={ph}
                                style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".46rem .65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",transition:"border-color .15s"}}/>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        </div>
      )}

      {/* ══ INCIDENTS TAB ══ */}
      {tab==="incidents" && (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:10}}>
            Vehicle Breakdowns / Accidents
            <span style={{background:"rgba(249,115,22,0.08)",border:"1px solid rgba(249,115,22,0.4)",borderRadius:6,padding:"2px 10px",fontSize:".78rem",fontWeight:600,color:"#6b7280",letterSpacing:0}}>{Object.keys(vehicleIncidents).length} active</span>
          </div>
          {Object.keys(vehicleIncidents).length===0 ? (
            <div style={{textAlign:"center",padding:"4rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>
              <div style={{fontSize:40,marginBottom:12}}></div>
              No active breakdowns or accidents. Fleet running smooth!
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:".8rem"}}>
              {Object.entries(vehicleIncidents).map(([vid, inc]) => {
                const av = vehicleById.get(String(vid)) ?? null;
                const recLoad = inc.loadId ? loadById.get(String(inc.loadId)) ?? null : null;
                const curLoad = av?.loadId ? loadById.get(String(av.loadId)) ?? null : null;
                const isAccident = inc.type==="ACCIDENT";
                return (
                  <div key={vid} style={{background:isAccident?"rgba(220,38,38,0.08)":"#fefce8",border:"2px solid",borderColor:isAccident?"rgba(220,38,38,0.35)":"rgba(245,158,11,0.3)",borderLeft:`5px solid ${isAccident?"#dc2626":"#d97706"}`,borderRadius:12,padding:"1rem 1.2rem",boxShadow:`0 2px 8px ${isAccident?"rgba(220,38,38,.1)":"rgba(234,88,12,.1)"}`}}>
                    {/* Header */}
                    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",marginBottom:".8rem"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                        <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(239,68,68,0.1)",border:"1px solid rgba(239,68,68,0.35)",borderRadius:6,padding:"2px 8px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,color:"var(--red)"}}>{inc.vehicleNum}</span>
                        <span style={{background:isAccident?"rgba(220,38,38,0.08)":"#ffedd5",border:`1px solid ${isAccident?"#dc2626":"#d97706"}`,borderRadius:12,padding:"2px 10px",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:isAccident?"#dc2626":"#d97706",letterSpacing:0}}>
                          {isAccident?"🚑 ACCIDENT":" BREAKDOWN"}
                        </span>
                        <span style={{fontSize:".68rem",color:"#111827"}}>Reported: {inc.reportedAt}</span>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        {!isAccident && (
                          <button onClick={()=>setManageVid(vid)} style={{background:"#2563eb",border:"none",color:"#ffffff",padding:"4px 14px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>🛠 Manage</button>
                        )}
                        <button onClick={()=>clearIncident(vid)} style={{background:"#ffffff",border:"1px solid var(--border2)",color:"#111827",padding:"4px 12px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Clear Incident</button>
                      </div>
                    </div>
                    {/* Incident note */}
                    <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:6,padding:".625rem .75rem",marginBottom:".8rem",fontSize:".84rem",color:"#111827",lineHeight:1.5}}>
                      <span style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",display:"block",marginBottom:3}}>Incident Details</span>
                      {inc.note}
                    </div>
                    {/* Vehicle + Load info */}
                    <div style={{display:"flex",gap:"1.5rem",flexWrap:"wrap"}}>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Affected Vehicle</div>
                        <div style={{fontWeight:600,fontSize:".9rem",color:"#111827"}}>{inc.vehicleNum}</div>
                        {av ? <>
                          <div style={{fontSize:".72rem",color:"#111827"}}>{av.driver}</div>
                          <div style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",color:"#111827"}}>{av.mobile}</div>
                          <div style={{marginTop:3,display:"inline-flex",alignItems:"center",gap:4,padding:"2px 7px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,background:"rgba(239,68,68,0.1)",color:"#dc2626"}}>
                            <span style={{width:5,height:5,borderRadius:"50%",background:"currentColor",opacity:.8}}/>MAINTENANCE
                          </div>
                        </> : <div style={{fontSize:".68rem",color:"#6b7280",marginTop:2,fontStyle:"italic"}}>vehicle removed</div>}
                      </div>
                      <div>
                        <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Reported On Load</div>
                        <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",color:"#374151"}}>{inc.lid || "—"}</div>
                        {recLoad ? (
                          <div style={{fontSize:".72rem",color:"#111827"}}>{recLoad.customer||""} · {recLoad.origin||"—"} → {recLoad.dest||"—"}</div>
                        ) : (
                          <div style={{fontSize:".68rem",color:"#6b7280",fontStyle:"italic"}}>record of original load at time of incident</div>
                        )}
                      </div>
                      {curLoad && curLoad.id !== inc.loadId && (
                        <div>
                          <div style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Currently On Load</div>
                          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",color:"#374151"}}>{curLoad.lid}</div>
                          <div style={{fontSize:".72rem",color:"#111827"}}>{curLoad.customer||""} · {curLoad.origin||"—"} → {curLoad.dest||"—"}</div>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ══ MAINTENANCE LOGS TAB ══ */}
      {tab==="maintlogs" && (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:10}}>
            Maintenance Logs
            <span style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.4)",borderRadius:6,padding:"2px 10px",fontSize:".78rem",fontWeight:600,color:"#6b7280",letterSpacing:0}}>{(maintLogs||[]).length} archived</span>
          </div>
          {(!maintLogs || maintLogs.length===0) ? (
            <div style={{textAlign:"center",padding:"4rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>
              <div style={{fontSize:40,marginBottom:12}}></div>
              No maintenance logs yet. Closed breakdowns will be archived here.
            </div>
          ) : (
            <div style={{display:"flex",flexDirection:"column",gap:".7rem"}}>
              {maintLogs.map(log => {
                const occAt = log.maint?.occurrence?.at ? new Date(log.maint.occurrence.at).getTime() : null;
                const clAt = log.maint?.closed?.at ? new Date(log.maint.closed.at).getTime() : null;
                const ackAt = log.maint?.acknowledged?.at ? new Date(log.maint.acknowledged.at).getTime() : null;
                const rsAt = log.maint?.repairStart?.at ? new Date(log.maint.repairStart.at).getTime() : null;
                const rdAt = log.maint?.repairDone?.at ? new Date(log.maint.repairDone.at).getTime() : null;
                const fmtDur = (ms) => {
                  if (ms==null || isNaN(ms) || ms<0) return "—";
                  const s=Math.floor(ms/1000), d=Math.floor(s/86400), h=Math.floor((s%86400)/3600), m=Math.floor((s%3600)/60);
                  if (d) return `${d}d ${h}h`; if (h) return `${h}h ${m}m`; if (m) return `${m}m`; return `${s}s`;
                };
                const down = (occAt && clAt) ? clAt-occAt : null;
                const rep = (rsAt && rdAt) ? rdAt-rsAt : null;
                const ack = (occAt && ackAt) ? ackAt-occAt : null;
                return (
                  <div key={log.id} style={{background:"#ffffff",border:"1px solid var(--border)",borderLeft:"5px solid #2563eb",borderRadius:12,padding:"1rem 1.2rem"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".5rem",marginBottom:".6rem"}}>
                      <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap"}}>
                        <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,color:"#374151"}}>{log.lid}</span>
                        <span style={{background:"rgba(22,163,74,0.08)",border:"1px solid #16a34a",borderRadius:12,padding:"2px 10px",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#16a34a",letterSpacing:0}}>🏁 CLOSED</span>
                        <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(239,68,68,0.08)",border:"1px solid rgba(239,68,68,0.3)",borderRadius:6,padding:"2px 7px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,color:"#6b7280"}}>{log.vehicleNum}</span>
                        {log.driver && log.driver!=="—" && <span style={{fontSize:".78rem",color:"#111827"}}>· {log.driver}</span>}
                        <span style={{fontSize:".72rem",color:"#6b7280"}}>archived {fmtDT(log.archivedAt)}</span>
                      </div>
                      <div style={{display:"flex",gap:6}}>
                        <button onClick={()=>setViewLogId(log.id)} style={{background:"#2563eb",border:"none",color:"#ffffff",padding:"4px 14px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>View Details</button>
                        {isAdmin && <button onClick={()=>{ if(confirm("Delete this maintenance log permanently?")) deleteMaintLog(log.id); }} style={{background:"#ffffff",border:"1px solid var(--border2)",color:"#111827",padding:"4px 12px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Delete</button>}
                      </div>
                    </div>
                    <div style={{display:"flex",gap:".5rem",flexWrap:"wrap"}}>
                      {[
                        ["Total Downtime", fmtDur(down)],
                        ["Repair Duration", fmtDur(rep)],
                        ["Time to Ack", fmtDur(ack)],
                        ["Vendor", log.maint?.vendor?.name||"—"],
                      ].map(([k,v])=>(
                        <div key={k} style={{background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:8,padding:".625rem .75rem",minWidth:120}}>
                          <div style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>{k}</div>
                          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",color:"#111827"}}>{v}</div>
                        </div>
                      ))}
                    </div>
                    {log.incident?.note && <div style={{marginTop:".6rem",fontSize:".78rem",color:"#6b7280",lineHeight:1.4}}><span style={{fontWeight:600,color:"#6b7280"}}>Reported:</span> {log.incident.note}</div>}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}



      {/* ══ APPROVALS TAB ══ */}
      {tab==="approvals" && (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:"1rem",display:"flex",alignItems:"center",gap:10}}>
            Vehicle Change Approvals
            <span style={{color:"#111827",fontSize:".78rem",fontWeight:400,letterSpacing:0}}>{changeRequests.length} requests</span>
          </div>
          {changeRequests.length === 0 ? (
            <div style={{textAlign:"center",padding:"4rem",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",letterSpacing:0}}>
              <div style={{fontSize:40,marginBottom:12}}>🔓</div>
              No change requests yet. Requests appear here when a locked vehicle assignment needs to be changed.
            </div>
          ) : (
            <div style={{overflowX:"auto"}}>
              <table style={{width:"100%",borderCollapse:"collapse"}}>
                <thead>
                  <tr style={{background:"#f2f4f7"}}>
                    {["Request ID","Load","Current Vehicle","Reason for Change","Manager","Contact","Requested At","Status","Actions"].map(h=>(
                      <th key={h} style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border2)",whiteSpace:"nowrap"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {changeRequests.map(cr => (
                    <tr key={cr.id} style={{borderBottom:"1px solid var(--border)",background:cr.status==="APPROVED"?"rgba(37,99,235,0.08)":cr.status==="REJECTED"?"#fff5f5":"#ffffff"}}>
                      <td style={{padding:".75rem .85rem"}}>
                        <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:"var(--purple)"}}>{cr.id}</div>
                      </td>
                      <td style={{padding:".75rem .85rem"}}>
                        <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:"#6b7280"}}>{cr.lid}</div>
                      </td>
                      <td style={{padding:".75rem .85rem"}}>
                        <div style={{display:"inline-flex",alignItems:"center",gap:5,background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:6,padding:"2px 7px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,color:"#6b7280"}}>
                           {cr.currentVehicle}
                        </div>
                      </td>
                      <td style={{padding:".625rem .75rem",maxWidth:200}}>
                        <div style={{fontSize:".84rem",color:"#111827",lineHeight:1.4}}>{cr.reason}</div>
                      </td>
                      <td style={{padding:".75rem .85rem"}}>
                        <div style={{fontWeight:600,fontSize:".84rem"}}>{cr.managerName}</div>
                      </td>
                      <td style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",color:"#111827"}}>{cr.managerMobile}</td>
                      <td style={{padding:".625rem .75rem",fontSize:".78rem",color:"#111827",whiteSpace:"nowrap"}}>{cr.requestedAt}</td>
                      <td style={{padding:".75rem .85rem"}}>
                        <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 9px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",
                          background:cr.status==="PENDING"?"rgba(217,119,6,0.08)":cr.status==="APPROVED"?"rgba(22,163,74,0.08)":"rgba(220,38,38,0.08)",
                          color:cr.status==="PENDING"?"#d97706":cr.status==="APPROVED"?"#059669":"#dc2626"}}>
                          {cr.status==="PENDING"?"":cr.status==="APPROVED"?"":"❌"} {cr.status}
                        </span>
                      </td>
                      <td style={{padding:".75rem .85rem"}}>
                        {cr.status==="PENDING" ? (
                          <div style={{display:"flex",gap:".35rem"}}>
                            <button onClick={()=>approveChangeRequest(cr.id)} style={{background:"rgba(34,197,94,0.15)",color:"var(--green)",border:"1px solid rgba(34,197,94,0.4)",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontWeight:600}}>Approve</button>
                            <button onClick={()=>rejectChangeRequest(cr.id)} style={{background:"transparent",border:"1px solid #dc2626",color:"var(--red)",padding:"4px 10px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontWeight:600}}>Reject</button>
                          </div>
                        ) : (
                          <span style={{fontSize:".72rem",color:"#111827"}}>Resolved</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ══ MODALS ══ */}

      {/*  Lock Confirm Modal */}
      {lockModalLid && (() => {
        const l = loadById.get(String(lockModalLid)) ?? null;
        const av = l?.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.7rem",width:"92%",maxWidth:440,boxShadow:"0 8px 32px rgba(0,0,0,.15)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"var(--green)",letterSpacing:0,textTransform:"uppercase",marginBottom:".6rem"}}> Confirm Vehicle Assignment</div>
              <p style={{color:"#111827",fontSize:".9rem",lineHeight:1.6,marginBottom:".3rem"}}>
                You are about to <strong>lock</strong> vehicle <strong style={{color:"#6366f1"}}>{av?.vnum}</strong> to load <strong style={{color:"#374151"}}>{l?.lid}</strong>.
              </p>
              <p style={{color:"#111827",fontSize:".78rem",lineHeight:1.5}}>Once locked, the vehicle cannot be changed without a manager approval request from the Change Approvals tab.</p>
              <div style={{display:"flex",gap:".7rem",marginTop:"1.1rem"}}>
                <button onClick={()=>lockLoad(lockModalLid)} style={{flex:1,background:"rgba(34,197,94,0.15)",color:"var(--green)",border:"1px solid rgba(34,197,94,0.4)",padding:".6rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase"}}> LOCK & CONFIRM</button>
                <button onClick={()=>setLockModalLid(null)} style={{flex:1,background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".6rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Change Request Modal */}
      {changeReqModal && (() => {
        const l = loadById.get(String(changeReqModal)) ?? null;
        const av = l?.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.7rem",width:"92%",maxWidth:500,boxShadow:"0 8px 32px rgba(0,0,0,.15)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#d97706",letterSpacing:0,textTransform:"uppercase",marginBottom:".5rem"}}>🔄 Request Vehicle Change</div>
              <div style={{background:"rgba(249,115,22,0.08)",border:"1px solid #fed7aa",borderRadius:6,padding:".625rem .75rem",marginBottom:"1rem",fontSize:".84rem",color:"#6366f1"}}>
                Load <strong>{l?.lid}</strong> · Current vehicle: <strong>{av?.vnum||"—"}</strong> is  locked. A manager must approve this change.
              </div>
              {[["Manager Name","managerName","text","Full name of approving manager"],["Manager Mobile","managerMobile","text","+91 98765 43210"],["Reason for Change","reason","textarea","Explain why the vehicle needs to change…"]].map(([label,field,type,ph])=>(
                <div key={field} style={{marginBottom:".8rem"}}>
                  <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:3}}>{label}</label>
                  {type==="textarea" ? (
                    <textarea value={changeReqForm[field]} onChange={e=>setChangeReqForm(p=>({...p,[field]:e.target.value}))} placeholder={ph} rows={3} style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".5rem .7rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",resize:"vertical"}}/>
                  ) : (
                    <input type={type} value={changeReqForm[field]} onChange={e=>setChangeReqForm(p=>({...p,[field]:e.target.value}))} placeholder={ph} style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".5rem .7rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none"}}/>
                  )}
                </div>
              ))}
              <div style={{display:"flex",gap:".7rem",marginTop:".5rem"}}>
                <button onClick={submitChangeRequest} style={{flex:1,background:"#d97706",color:"#ffffff",border:"none",padding:".62rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase"}}>SUBMIT REQUEST</button>
                <button onClick={()=>{setChangeReqModal(null);setChangeReqForm(blankCRForm());}} style={{flex:1,background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".62rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══════════ TAT TRACKER TAB ══════════ */}
      {tab==="tat" && (() => {
        const SEV_STYLE = {
          "on-time":    { label:"On Time",    bg:"rgba(22,163,74,0.08)", color:"#16a34a" },
          "minor":      { label:"Minor",      bg:"rgba(217,119,6,0.08)", color:"#d97706" },
          "major":      { label:"Major",      bg:"#fed7aa", color:"#d97706" },
          "high-alert": { label:"High Alert", bg:"rgba(220,38,38,0.08)", color:"#dc2626" },
          "unknown":    { label:"—",          bg:"#f2f4f7", color:"#6b7280" },
        };
        const tatFilterInput = { background:"#f2f4f7", border:"1px solid var(--border)", color:"#111827", padding:"5px 9px", borderRadius:6, fontFamily:"'Inter',system-ui,sans-serif", fontSize:".78rem", outline:"none", minWidth:130 };
        const rows = loads.filter(l => {
          const v = l.vehicleId ? vehicles.find(x=>x.id===l.vehicleId) : null;
          return v && v.vstatus === "IN_TRANSIT";
        }).map(l => {
          const v = l.vehicleId ? vehicles.find(x=>x.id===l.vehicleId) : null;
          const baseDateStr = (l.lrDate || v?.lrDate || l.pickup || "").slice(0,10);
          const { distOD, distToGo, tatDays, targetAt, arrivalAt } = computeTat(l, v, cityCoords, gpsMap);
          let lateHours = null, severity = "unknown";
          if (targetAt && arrivalAt) {
            lateHours = (arrivalAt - targetAt) / 3600000;
            if (lateHours > 24) severity = "high-alert";
            else if (lateHours > 8) severity = "major";
            else if (lateHours > 4) severity = "minor";
            else severity = "on-time";
          }
          return { l, v, distOD, distToGo, tatDays, targetAt, arrivalAt, lateHours, severity, baseDateStr };
        });
        const SEV_RANK = { "high-alert":0, "major":1, "minor":2, "on-time":3, "unknown":4 };
        const sortedRowsAll = [...rows].sort((a,b)=> (SEV_RANK[a.severity]??9) - (SEV_RANK[b.severity]??9));
        const isMultiRow = (r) => (r.l.consignees || []).filter(Boolean).length > 1;
        const singleRowsAll = sortedRowsAll.filter(r => !isMultiRow(r));
        const multiRowsAll = sortedRowsAll.filter(r => isMultiRow(r));
        const sortedRows = tatConsigneeTab === "multi" ? multiRowsAll : singleRowsAll;
        const uniq = (arr) => [...new Set(arr.filter(Boolean))].sort();
        const vehicleOpts = uniq(sortedRows.map(r => r.v?.vnum));
        const originOpts = uniq(sortedRows.map(r => r.l.origin));
        const customerOpts = uniq(sortedRows.map(r => r.l.customer));
        const lidQ = tatFilterLid.trim().toLowerCase();
        const scopedRows = sortedRows.filter(r =>
          (!tatFilterVehicle || r.v?.vnum === tatFilterVehicle) &&
          (!tatFilterOrigin || r.l.branch === tatFilterOrigin) &&
          (!tatFilterCustomer || r.l.customer === tatFilterCustomer) &&
          (!lidQ || (r.l.lid || "").toLowerCase().includes(lidQ)) &&
          (!tatRpdc || isRpdcLoad(r.l)) &&
          (!tatReturnOnly || (r.l.branch || "").trim().toLowerCase() !== "gurgaon") &&
          (!tatNoDriverOnly || !!r.v?.withoutDriver)
        );
        const filteredRows = tatFilter.size === 0 ? scopedRows : scopedRows.filter(r => tatFilter.has(r.severity));
        const anyTextFilter = tatFilterVehicle || tatFilterOrigin || tatFilterCustomer || tatFilterLid || tatRpdc || tatReturnOnly || tatNoDriverOnly;
        const clearTextFilters = () => { setTatFilterVehicle(""); setTatFilterOrigin(""); setTatFilterCustomer(""); setTatFilterLid(""); setTatRpdc(false); setTatReturnOnly(false); setTatNoDriverOnly(false); setTatPage(1); };
        const onFilterChange = (setter) => (v) => { setter(v); setTatPage(1); };
        const PAGE_SIZE = 50;
        const totalPages = Math.max(1, Math.ceil(filteredRows.length / PAGE_SIZE));
        const curPage = Math.min(Math.max(1, tatPage), totalPages);
        const startIdx = (curPage - 1) * PAGE_SIZE;
        const pageRows = filteredRows.slice(startIdx, startIdx + PAGE_SIZE);
        const toggleSev = (k) => {
          setTatPage(1);
          setTatFilter(prev => {
            const n = new Set(prev);
            if (n.has(k)) n.delete(k); else n.add(k);
            return n;
          });
        };
        const pageNumbers = (() => {
          if (totalPages <= 7) return Array.from({length: totalPages}, (_,i)=>i+1);
          const out = new Set([1, totalPages, curPage, curPage-1, curPage+1]);
          const arr = [...out].filter(n=>n>=1&&n<=totalPages).sort((a,b)=>a-b);
          const withGaps = [];
          arr.forEach((n,i)=>{ if (i>0 && n - arr[i-1] > 1) withGaps.push("…"); withGaps.push(n); });
          return withGaps;
        })();
        const fmt = (d) => d ? fmtDT(d.toISOString()) : "—";
        const Pager = () => (
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",padding:".7rem 0"}}>
            <div style={{fontSize:".78rem",color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0}}>
              {filteredRows.length === 0 ? "0 of 0" : `Showing ${startIdx+1}–${Math.min(startIdx+PAGE_SIZE, filteredRows.length)} of ${filteredRows.length}`}
            </div>
            <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
              <button onClick={()=>setTatPage(p=>Math.max(1,p-1))} disabled={curPage<=1} style={{background:"#ffffff",border:"1px solid var(--border)",color:curPage<=1?"#e4e7ed":"#111827",padding:"5px 10px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,cursor:curPage<=1?"default":"pointer"}}>‹</button>
              {pageNumbers.map((n,i)=> n === "…" ? (
                <span key={`g${i}`} style={{padding:"0 6px",color:"#6b7280"}}>…</span>
              ) : (
                <button key={n} onClick={()=>setTatPage(n)} style={{background:n===curPage?"#111827":"#ffffff",color:n===curPage?"#ffffff":"#111827",border:"1px solid var(--border)",padding:"5px 11px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,cursor:"pointer",minWidth:32}}>{n}</button>
              ))}
              <button onClick={()=>setTatPage(p=>Math.min(totalPages,p+1))} disabled={curPage>=totalPages} style={{background:"#ffffff",border:"1px solid var(--border)",color:curPage>=totalPages?"#e4e7ed":"#111827",padding:"5px 10px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,cursor:curPage>=totalPages?"default":"pointer"}}>›</button>
            </div>
          </div>
        );
        return (
          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
               TAT Tracker <span style={{color:"#111827",fontSize:".78rem",fontWeight:400,letterSpacing:0}}>{rows.length} loads · target speed 22 km/h · road distance ≈ air × 1.25 · +1 buffer day (&lt;1700 km)</span>
              <button onClick={()=>{
                const exportRows = filteredRows.map(r => {
                  const tr = tatReasons[r.l.id] || { moving:null, reasons:[], comments:[] };
                  const lastReason = (tr.reasons && tr.reasons.length) ? tr.reasons[tr.reasons.length-1] : null;
                  const movingLabel = tr.moving === true ? "Yes" : tr.moving === false ? "No" : "";
                  const delayDays = r.lateHours != null ? (r.lateHours / 24).toFixed(2) : "";
                  const delayHours = r.lateHours != null && r.lateHours > 0 ? r.lateHours.toFixed(1) : "";
                  const remainingHours = r.lateHours != null && r.lateHours < 0 ? Math.abs(r.lateHours).toFixed(1) : "";
                  const baseDateStr = r.l.lrDate || r.v?.lrDate || null;
                  const elapsedMs = baseDateStr ? (Date.now() - new Date(baseDateStr).getTime()) : null;
                  const elapsedDays = elapsedMs != null ? (elapsedMs / 86400000).toFixed(2) : "";
                   const elapsedHrs = elapsedMs != null ? (elapsedMs / 3600000) : null;
                   const elapsedHrsFull = elapsedHrs != null ? elapsedHrs.toFixed(2) : "";
                   const distTravelled = (r.distOD != null && r.distToGo != null) ? Math.max(0, r.distOD - r.distToGo) : (r.distOD != null ? r.distOD : null);
                   const distTravelledFull = distTravelled != null ? distTravelled.toFixed(2) : "";
                   const avgSpeed = (distTravelled != null && elapsedHrs && elapsedHrs > 0) ? (distTravelled / elapsedHrs).toFixed(1) : "";
                   const consigneeList = (r.l.consignees || []).filter(Boolean);
                   const allReasons = (tr.reasons || []).map(rr => {
                     const t = TAT_REASON_TYPES.find(x=>x.id===rr.type);
                     return `${t?.label||rr.type}${rr.hours!=null?` (${rr.hours}h)`:""}`;
                   }).join(" || ");
                   const commentsText = (tr.comments || []).map(c => c.text).join(" || ");
                   const vkExp = gpsVehicleKey(r.v?.vnum);
                   const gpsRec = lookupGps(gpsMap, r.v?.vnum);
                   const gpsAddr = (gpsRec?.address) || addrMap[vkExp] || addrMap[r.v?.vnum] || "";
                    const stripState = (s) => {
                      if (!s) return "";
                      let out = String(s).trim();
                      for (const st of ADDRESS_STATES) {
                        const re = new RegExp(`[,\\s]+${st.replace(/[.*+?^${}()|[\\]\\\\]/g,"\\$&")}\\s*$`, "i");
                        out = out.replace(re, "").trim();
                      }
                      return out.replace(/,\s*$/,"").trim();
                    };
                     const firstSeg = (s) => String(s || "").split(",")[0].trim();
                     const currentLocation = firstSeg(formatDistrictState(gpsAddr));
                     const targetDeliveryDate = r.targetAt
                       ? `${String(r.targetAt.getDate()).padStart(2,"0")}-${String(r.targetAt.getMonth()+1).padStart(2,"0")}-${r.targetAt.getFullYear()}`
                       : "";
                     return {
                        "Load ID": r.l.lid || "",
                        "Customer": r.l.customer || "",
                        "Vehicle": r.v?.vnum || "",
                        "Branch": r.l.branch || "",
                        "Origin": firstSeg(r.l.origin),
                        "Destination": firstSeg(r.l.dest),
                       "Current Location": currentLocation,
                      "LR Date": r.l.lrDate || r.v?.lrDate || "",
                      "Target Delivery Date": targetDeliveryDate,
                      "Delay (hours)": delayHours,
                     "All Reasons": allReasons,
                     "Comments": commentsText,
                     "Vehicle Moving": movingLabel,
                     "Distance (km)": r.distOD != null ? Math.round(r.distOD) : "",
                     "Elapsed Days": elapsedDays,
                     "Allowed Days (TAT)": r.tatDays != null ? r.tatDays : "",
                     "Delay Days": delayDays,
                     "Remaining (hours)": remainingHours,
                     "Distance Travelled (km)": distTravelledFull,
                     "Time Elapsed (hours)": elapsedHrsFull,
                     "Avg Speed (km/h)": avgSpeed,
                     "Consignee Count": consigneeList.length || 1,
                     "Consignees": consigneeList.join(" | "),
                     "Reason (latest)": lastReason ? (TAT_REASON_TYPES.find(x=>x.id===lastReason.type)?.label || lastReason.type || "") : "",
                     "Severity": (SEV_STYLE[r.severity] || {}).label || r.severity,
                   };
                });
                const ws = XLSX.utils.json_to_sheet(exportRows);
                const wb = XLSX.utils.book_new();
                XLSX.utils.book_append_sheet(wb, ws, "TAT Tracker");
                XLSX.writeFile(wb, `tat-tracker-export-${new Date().toISOString().slice(0,10)}.xlsx`);
              }} style={{marginLeft:"auto",background:"#374151",color:"#ffffff",border:"none",padding:".42rem .9rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(0,0,0,0.12)",transition:"all .15s"}}>⬇ Export</button>
            </div>
            {/* GPS coverage diagnostic chip */}
            {(() => {
              const inTransit = rows.length;
              const matched = rows.filter(r => lookupGps(gpsMap, r.v?.vnum)).length;
              const ungeoCities = new Set();
              rows.forEach(r => {
                const ok = (city) => {
                  const k = (city || "").trim().toLowerCase();
                  if (!k) return true;
                  const c = cityCoords[k];
                  return !!(c && c.lat != null && c.lng != null);
                };
                if (!ok(r.l.origin)) ungeoCities.add(r.l.origin);
                if (!ok(r.l.dest)) ungeoCities.add(r.l.dest);
              });
              const ungeoList = [...ungeoCities].filter(Boolean);
              const reGeocode = () => {
                clearCityGeocodeFailures(ungeoList.map(c => c.trim().toLowerCase()));
                // Trigger re-geocode by force-clearing those keys in the synced setting too (only failure markers, but we never persist those — so this is safe).
                ungeoList.forEach(async c => {
                  const k = c.trim().toLowerCase();
                  const r = await geocodeCity(c);
                  if (r && r.lat != null && r.lng != null) {
                    setCityCoords(p => (p[k] && p[k].lat != null ? p : { ...p, [k]: r }));
                  }
                });
              };
              return (
                <div style={{display:"flex",gap:8,marginBottom:".7rem",flexWrap:"wrap",alignItems:"center",fontSize:".72rem"}}>
                  <span title="Trucks with a fresh Fleetx GPS hit / total IN_TRANSIT trucks in TAT" style={{background:matched===inTransit?"rgba(22,163,74,0.08)":"rgba(217,119,6,0.08)",color:matched===inTransit?"#16a34a":"#d97706",border:`1px solid ${matched===inTransit?"#16a34a":"#d97706"}`,padding:"3px 9px",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                     GPS {matched}/{inTransit}
                  </span>
                  {ungeoList.length > 0 && (
                    <span title={`Un-geocoded cities (first 10):\n${ungeoList.slice(0,10).join("\n")}`} style={{background:"rgba(220,38,38,0.08)",color:"#dc2626",border:"1px solid #dc2626",padding:"3px 9px",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                      {ungeoList.length} cities un-geocoded
                    </span>
                  )}
                  {ungeoList.length > 0 && (
                    <button onClick={reGeocode} style={{background:"#ffffff",border:"1px solid var(--border)",color:"#111827",padding:"3px 10px",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>
                      ↻ Re-geocode
                    </button>
                  )}
                </div>
              );
            })()}
            {/* Single / Multi-Consignee sub-tabs */}

            <div style={{display:"flex",gap:6,marginBottom:".7rem",flexWrap:"wrap",alignItems:"center"}}>
              {[
                {key:"single", label:"Single Consignee", count: singleRowsAll.length},
                {key:"multi",  label:"Multi-Consignee",  count: multiRowsAll.length},
              ].map(t => {
                const active = tatConsigneeTab === t.key;
                return (
                  <button key={t.key} onClick={()=>{ setTatConsigneeTab(t.key); setTatPage(1); }}
                    style={{background:active?"#374151":"#ffffff",color:active?"#ffffff":"#111827",border:`1px solid ${active?"#374151":"#e4e7ed"}`,padding:"6px 13px",borderRadius:8,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".78rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>
                    {t.label} <span style={{opacity:.8,fontFamily:"'Inter',system-ui,sans-serif",marginLeft:6}}>{t.count}</span>
                  </button>
                );
              })}
            </div>
            {/* Filter bar */}
            <div style={{display:"flex",gap:".55rem",marginBottom:".7rem",flexWrap:"wrap",alignItems:"center",background:"#ffffff",border:"1px solid var(--border)",borderRadius:8,padding:".625rem .75rem"}}>
              <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>Filter</span>
              <input list="tat-vehicles" value={tatFilterVehicle} onChange={e=>onFilterChange(setTatFilterVehicle)(e.target.value)} placeholder="Vehicle" style={tatFilterInput}/>
              <datalist id="tat-vehicles">{vehicleOpts.map(v => <option key={v} value={v}/>)}</datalist>
              <select value={tatFilterOrigin} onChange={e=>onFilterChange(setTatFilterOrigin)(e.target.value)} style={tatFilterInput}>
                <option value="">Origin branch</option>
                {branches.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              <select value={tatFilterCustomer} onChange={e=>onFilterChange(setTatFilterCustomer)(e.target.value)} style={tatFilterInput}>
                <option value="">Customer</option>
                {customerOpts.map(o => <option key={o} value={o}>{o}</option>)}
              </select>
              <input value={tatFilterLid} onChange={e=>onFilterChange(setTatFilterLid)(e.target.value)} placeholder="Load ID" style={tatFilterInput}/>
              <label style={{display:"flex",alignItems:"center",gap:5,fontSize:".78rem",cursor:"pointer",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>
                <input type="checkbox" checked={tatRpdc} onChange={e=>{setTatRpdc(e.target.checked); setTatPage(1);}}/> RPDC
              </label>
              <label style={{display:"flex",alignItems:"center",gap:5,fontSize:".78rem",cursor:"pointer",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>
                <input type="checkbox" checked={tatReturnOnly} onChange={e=>{setTatReturnOnly(e.target.checked); setTatPage(1);}}/> Return Tracking
              </label>
              <label style={{display:"flex",alignItems:"center",gap:5,fontSize:".78rem",cursor:"pointer",color:"#d97706",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:tatNoDriverOnly?700:500}}>
                <input type="checkbox" checked={tatNoDriverOnly} onChange={e=>{setTatNoDriverOnly(e.target.checked); setTatPage(1);}}/> Without Driver
              </label>
              {anyTextFilter && <button onClick={clearTextFilters} style={{background:"transparent",border:"none",color:"#2563eb",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,cursor:"pointer",textDecoration:"underline"}}>Clear filters</button>}
              <span style={{marginLeft:"auto",fontSize:".72rem",color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif"}}>{scopedRows.length} match{scopedRows.length===1?"":"es"}</span>
            </div>
            <div style={{display:"flex",gap:".5rem",marginBottom:".9rem",flexWrap:"wrap",alignItems:"center"}}>
              {["high-alert","major","minor","on-time"].map(k => {
                const s = SEV_STYLE[k];
                const cnt = scopedRows.filter(r=>r.severity===k).length;
                const active = tatFilter.has(k);
                return (
                  <button key={k} onClick={()=>toggleSev(k)} style={{background:s.bg,color:s.color,padding:"6px 12px",borderRadius:12,fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer",border:active?`2px solid ${s.color}`:"2px solid transparent",boxShadow:active?`0 0 0 2px ${s.bg}, 0 0 0 3px ${s.color}`:"none"}}>{s.label}: {cnt}</button>
                );
              })}
              {tatFilter.size > 0 && (
                <button onClick={()=>{setTatFilter(new Set()); setTatPage(1);}} style={{background:"transparent",border:"none",color:"#2563eb",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,cursor:"pointer",textDecoration:"underline"}}>Clear</button>
              )}
            </div>
            {totalPages > 1 && <Pager />}
            <div style={{display:"flex",flexDirection:"column",gap:"1rem"}}>
              {pageRows.length === 0 && (
                <div style={{padding:"2rem",textAlign:"center",color:"#6b7280",background:"#ffffff",border:"1px solid var(--border)",borderRadius:12}}>No loads to track.</div>
              )}
              {(() => {
                const groupsByBranch = pageRows.reduce((acc, r) => {
                  const key = r.l.branch || "— No branch —";
                  (acc[key] ||= []).push(r);
                  return acc;
                }, {});
                const branchOrder = Object.keys(groupsByBranch).sort((a,b)=>a.localeCompare(b));
                return branchOrder.map(branch => (
                  <Fragment key={`grp-${branch}`}>
                    <div style={{display:"flex",alignItems:"center",gap:10,padding:".4rem 0 .35rem",borderBottom:"1px solid var(--border)",marginTop:".2rem"}}>
                      <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>{branch}</span>
                      <span style={{background:"#f2f4f7",color:"#6b7280",border:"1px solid var(--border)",padding:"1px 8px",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600}}>{groupsByBranch[branch].length} load{groupsByBranch[branch].length===1?"":"s"}</span>
                    </div>
                    {groupsByBranch[branch].map(r => {
                const s = SEV_STYLE[r.severity] || SEV_STYLE.unknown;
                const lrOrPickup = r.l.lrDate || r.v?.lrDate || r.l.pickup || null;
                const lrOrPickupLabel = (r.l.lrDate || r.v?.lrDate) ? "LR DATE" : (r.l.pickup ? "PICKUP DATE" : "LR / PICKUP DATE");
                const lrOrPickupDisplay = (r.l.lrDate || r.v?.lrDate) ? (r.l.lrDate || r.v?.lrDate) : (r.l.pickup ? fmtDT(r.l.pickup) : "—");
                // ETA box color: severity-based
                const etaBox = (() => {
                  if (r.severity === "high-alert") return { bg:"rgba(220,38,38,0.08)", color:"#dc2626", border:"#dc2626" };
                  if (r.severity === "major") return { bg:"#fed7aa", color:"#d97706", border:"#d97706" };
                  if (r.severity === "minor") return { bg:"rgba(217,119,6,0.08)", color:"#d97706", border:"#d97706" };
                  if (r.severity === "on-time") return { bg:"rgba(22,163,74,0.08)", color:"#16a34a", border:"#16a34a" };
                  return { bg:"#f2f4f7", color:"#6b7280", border:"#e4e7ed" };
                })();
                const Box = ({label, value, sub, palette}) => (
                  <div style={{flex:1,minWidth:0,background:palette.bg,border:`1.5px solid ${palette.border}`,borderRadius:12,padding:"1rem 1.1rem",display:"flex",flexDirection:"column",gap:".4rem"}}>
                    <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:palette.color,opacity:.85}}>{label}</div>
                    <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,color:palette.color,lineHeight:1.15,wordBreak:"break-word"}}>{value}</div>
                    {sub && <div style={{fontSize:".72rem",color:palette.color,opacity:.8,fontWeight:600}}>{sub}</div>}
                  </div>
                );
                const neutral = { bg:"#f2f4f7", color:"#111827", border:"#e4e7ed" };
                const tr = tatReasons[r.l.id] || { moving:null, expectedEta:"", reasons:[], comments:[] };
                const isOpen = tatReasonOpen === r.l.id;
                const etaPassed = tr.moving === false && tr.expectedEta && new Date(tr.expectedEta).getTime() < Date.now();
                const reasonCount = tr.reasons.length;
                return (
                  <div key={r.l.id} style={{background:"#ffffff",border:"1px solid var(--border)",borderLeft:`6px solid ${s.color}`,borderRadius:12,padding:"1rem 1.1rem"}}>
                    {/* Header */}
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",marginBottom:".85rem"}}>
                      <div style={{display:"flex",alignItems:"center",gap:".9rem",flexWrap:"wrap"}}>
                        <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#374151",fontSize:".9rem"}}>{r.l.lid}</span>
                        {r.v ? (() => {
                          const tgps = (gpsMap[gpsVehicleKey(r.v.vnum)] || gpsMap[gpsVehicleKeyAlt(r.v.vnum)]);
                          const hasGps = !!(tgps && tgps.lat != null && tgps.lng != null);
                          const openTatMap = () => {
                            if (!hasGps) return;
                            // Use the full-featured map popup (trail playback + halts + amber
                            // circles + direction triangle), same as Load Board. r.l is this
                            // row's load, so halts are correctly load-scoped.
                            openGpsMap(r.v, r.l?.lid, r.l?.id);
                          };
                          return (
                            <span style={{display:"inline-flex",alignItems:"center",gap:6}}>
                              <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#6366f1",fontSize:"1rem",letterSpacing:0}}>{r.v.vnum}</span>
                              <button onClick={openTatMap} title={hasGps?"View on map":"No live GPS yet"} disabled={!hasGps} style={{display:"inline-flex",alignItems:"center",gap:3,background:"rgba(14,165,233,0.06)",border:"1px solid rgba(14,165,233,0.25)",color:"#374151",padding:"1px 6px",borderRadius:6,cursor:hasGps?"pointer":"not-allowed",fontSize:".68rem",fontWeight:600,opacity:hasGps?1:.45}}>
                                <MapPin size={10}/> GPS
                              </button>
                            </span>
                          );
                        })() : <span style={{color:"#6b7280",fontSize:".84rem"}}>No vehicle</span>}
                        <span style={{fontSize:".9rem",color:"#111827",fontWeight:600}}>{r.l.origin} → {r.l.dest}</span>
                        <span title={r.distOD!=null?`Total route ${Math.round(r.distOD)} km`:""} style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",color:r.distToGo!=null?(r.distToGo<50?"#16a34a":r.distToGo<200?"#d97706":"#2563eb"):"#6b7280",fontWeight:600,background:"#f2f4f7",padding:"2px 10px",borderRadius:6}}>{r.distToGo != null ? `${Math.round(r.distToGo)} km to go` : (r.distOD != null ? `${Math.round(r.distOD)} km route` : "geo…")}</span>
                        {etaPassed && (
                          <span style={{display:"inline-flex",alignItems:"center",gap:6,background:"#dc2626",color:"#facc15",padding:"6px 14px",borderRadius:8,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:900,letterSpacing:0,textTransform:"uppercase",border:"2px solid #facc15",boxShadow:"0 0 0 3px rgba(220,38,38,0.25)",animation:"pulse 1.6s ease-in-out infinite"}}>Still Stopped — Take Action</span>
                        )}
                        {r.v?.withoutDriver && (() => {
                          const passed = r.v.withoutDriverEta && Date.now() > new Date(r.v.withoutDriverEta).getTime();
                          const etaTxt = r.v.withoutDriverEta ? new Date(r.v.withoutDriverEta).toLocaleString("en-IN",{day:"2-digit",month:"short",hour:"2-digit",minute:"2-digit"}) : "—";
                          return (
                            <span title={`Without driver · Driver ETA ${etaTxt}`} style={{display:"inline-flex",alignItems:"center",gap:5,background:passed?"rgba(220,38,38,0.08)":"rgba(217,119,6,0.08)",border:`1px solid ${passed?"#dc2626":"#fb923c"}`,color:passed?"#dc2626":"#d97706",padding:"5px 11px",borderRadius:12,fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>
                              {passed ? `No Driver · ETA Passed` : `No Driver · ETA ${etaTxt}`}
                            </span>
                          );
                        })()}
                      </div>
                      <div style={{display:"flex",alignItems:"center",gap:".5rem",flexWrap:"wrap"}}>
                        {tr.moving === true && (
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(34,197,94,0.15)",color:"#16a34a",border:"1px solid rgba(34,197,94,0.4)",padding:"5px 11px",borderRadius:12,fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>🟢 Moving</span>
                        )}
                        {tr.moving === false && (
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(220,38,38,0.15)",color:"#dc2626",border:"1px solid rgba(220,38,38,0.4)",padding:"5px 11px",borderRadius:12,fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>🔴 Not Moving{tr.expectedEta?` · ETA ${fmt(tr.expectedEta)}`:""}</span>
                        )}
                        <button onClick={()=>setTatReasonOpen(isOpen?null:r.l.id)} style={{background:isOpen?"#111827":"#ffffff",color:isOpen?"#ffffff":"#111827",border:`1px solid ${isOpen?"#111827":"#e4e7ed"}`,padding:"5px 11px",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>{isOpen?"▴":"▾"} Reason{reasonCount>0?` (${reasonCount})`:""}{(tr.comments?.length)?` · 💬 ${tr.comments.length}`:""}</button>
                        <span style={{background:s.bg,color:s.color,padding:"5px 14px",borderRadius:12,fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>{s.label}{r.lateHours!=null?` · ${r.lateHours>=0?"+":""}${r.lateHours.toFixed(1)}h`:""}</span>
                      </div>
                    </div>
                    {/* Three large boxes */}
                    <div style={{display:"flex",gap:".8rem",flexWrap:"wrap"}}>
                      <Box label={lrOrPickupLabel} value={lrOrPickupDisplay} sub={r.l.lrDate||r.v?.lrDate ? null : "(no LR date — using pickup)"} palette={neutral} />
                      <Box label="Target Delivery" value={fmt(r.targetAt)} sub={r.tatDays!=null?`TAT ${r.tatDays} day${r.tatDays===1?"":"s"} @ 15:00 IST`:null} palette={neutral} />
                      <Box label="ETA (Live)" value={fmt(r.arrivalAt)} sub={r.arrivalAt?"@ 22 km/h from current GPS":gpsReasonFor(r.l, r.v, cityCoords, gpsMap)} palette={etaBox} />
                    </div>
                    {/* Consignees (multi-consignee sub-tab only) */}
                    {tatConsigneeTab === "multi" && (() => {
                      const cons = (r.l.consignees || []).filter(Boolean);
                      const dels = stopsFor(r.l);
                      if (cons.length === 0) return null;
                      return (
                        <div style={{marginTop:".8rem",background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:8,padding:".625rem .75rem"}}>
                          <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:".4rem"}}>Consignees ({cons.length})</div>
                          <div style={{display:"grid",gridTemplateColumns:"32px 1fr 110px 1fr 130px",gap:"4px 10px",alignItems:"center",fontSize:".78rem"}}>
                            <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>#</div>
                            <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>City</div>
                            <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Status</div>
                            <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Delivered At</div>
                            <div style={{fontSize:".68rem",color:"#6b7280",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Action</div>
                            {cons.map((city, i) => {
                              const d = dels[i] || {};
                              const delivered = !!d.delivered;
                              return (
                                <Fragment key={`cons-${r.l.id}-${i}`}>
                                  <div style={{fontFamily:"'Inter',system-ui,sans-serif",color:"#6b7280"}}>{i+1}</div>
                                  <div style={{color:"#111827",fontWeight:600}}>{city}</div>
                                  <div>
                                    <span style={{display:"inline-block",padding:"2px 8px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",background:delivered?"rgba(34,197,94,0.18)":"rgba(234,179,8,0.18)",color:delivered?"#16a34a":"rgba(217,119,6,0.08)",border:`1px solid ${delivered?"rgba(34,197,94,0.45)":"rgba(234,179,8,0.45)"}`}}>{delivered?"Delivered":"Pending"}</span>
                                  </div>
                                  <div style={{color:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem"}}>{d.deliveredAt ? fmtDT(d.deliveredAt) : "—"}</div>
                                  <div>
                                    {delivered ? (
                                      <button onClick={()=>setConsigneeDelivered(r.l.id, i, false)} title="Undo delivered" style={{background:"transparent",border:"1px solid #d97706",color:"#d97706",padding:"2px 8px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>Undo</button>
                                    ) : (
                                      <button onClick={()=>markConsigneeDeliveredWithPrompt(r.l.id, i)} title="Mark this consignee as delivered" style={{background:"#16a34a",border:"1px solid #16a34a",color:"#ffffff",padding:"2px 8px",borderRadius:6,fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>Mark Delivered</button>
                                    )}
                                  </div>

                                </Fragment>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })()}
                    {/* Always-visible TAT Status summary: moving, expected ETA, selected reason chips, comments */}
                    <div style={{marginTop:".75rem",background:"#f2f4f7",border:"1px solid var(--border)",borderRadius:8,padding:".625rem .75rem"}}>
                      <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>TAT Status</div>
                      <div style={{display:"flex",flexWrap:"wrap",alignItems:"center",gap:6,marginBottom:6}}>
                        {tr.moving === true && (
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(34,197,94,0.15)",color:"#16a34a",border:"1px solid rgba(34,197,94,0.45)",padding:"3px 9px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>🟢 Moving</span>
                        )}
                        {tr.moving === false && (
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(220,38,38,0.12)",color:"#dc2626",border:"1px solid rgba(220,38,38,0.45)",padding:"3px 9px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>🔴 Not Moving</span>
                        )}
                        {tr.moving === null && (
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"#ffffff",color:"#6b7280",border:"1px dashed var(--border2)",padding:"3px 9px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Moving status not set</span>
                        )}
                        {tr.moving === false && tr.expectedEta && (
                          <span style={{display:"inline-flex",alignItems:"center",gap:4,background:"rgba(217,119,6,0.08)",color:"#d97706",border:"1px solid #d97706",padding:"3px 9px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>Expected on road: {fmt(tr.expectedEta)}</span>
                        )}
                        {reasonCount === 0 && (
                          <span style={{fontSize:".72rem",color:"#6b7280",fontStyle:"italic"}}>No reasons added yet</span>
                        )}
                        {tr.reasons.map(rr => {
                          const t = TAT_REASON_TYPES.find(x=>x.id===rr.type);
                          return (
                            <span key={rr.id} style={{display:"inline-flex",alignItems:"center",gap:6,background:"rgba(99,102,241,0.08)",border:"1px solid #6366f1",color:"#6366f1",padding:"3px 9px",borderRadius:12,fontSize:".72rem",fontWeight:600}}>
                              <span>{t?.icon}</span>
                              <span>{t?.label||rr.type}</span>
                              {rr.hours!=null && <span style={{background:"#ffffff",border:"1px solid #6366f1",borderRadius:8,padding:"0 6px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem"}}>{rr.hours}h</span>}
                              <button onClick={()=>removeTatReason(r.l.id, rr.id)} aria-label="Remove" style={{background:"transparent",border:"none",color:"#6366f1",fontSize:".9rem",cursor:"pointer",padding:0,lineHeight:1}}>✕</button>
                            </span>
                          );
                        })}
                      </div>
                      {(tr.comments && tr.comments.length > 0) ? (
                        <div style={{display:"flex",flexDirection:"column",gap:5}}>
                          {[...tr.comments].reverse().map(c => (
                            <EditableCommentRow key={c.id} c={c} compact
                              onEdit={(cid,text)=>editTatComment(r.l.id, cid, text)}
                              onRemove={(cid)=>removeTatComment(r.l.id, cid)} />
                          ))}
                        </div>
                      ) : (
                        <div style={{fontSize:".68rem",color:"#6b7280",fontStyle:"italic"}}>No comments yet</div>
                      )}
                    </div>
                    {/* Expandable reason panel */}
                    {isOpen && (
                      <TatReasonPanel
                        loadId={r.l.id}
                        state={tr}
                        types={TAT_REASON_TYPES}
                        etaPassed={etaPassed}
                        onMoving={(val)=>updateTatReason(r.l.id, c=>({...c, moving:val, expectedEta: val===true ? "" : c.expectedEta }))}
                        onEta={(val)=>updateTatReason(r.l.id, c=>({...c, expectedEta:val}))}
                        onAdd={(type, hours)=>{
                          if (tr.moving === false && !tr.expectedEta) {
                            alert("Please set the Expected ETA before adding a reason.");
                            return;
                          }
                          addTatReason(r.l.id, type, hours);
                        }}
                        showComments={r.severity==="minor" || r.severity==="major" || r.severity==="high-alert"}
                        comments={tr.comments||[]}
                        onAddComment={(text)=>addTatComment(r.l.id, text)}
                        onRemoveComment={(cid)=>removeTatComment(r.l.id, cid)}
                        onEditComment={(cid,text)=>editTatComment(r.l.id, cid, text)}
                      />
                    )}
                  </div>
                );
                    })}
                  </Fragment>
                ));
              })()}
            </div>
            {totalPages > 1 && <Pager />}
          </div>
        );
      })()}

      {/* ══════════ GEOFENCES TAB ══════════ */}
      {tab==="geofences" && <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading…</div>}><Geofences /></Suspense>}

      {tab==="fleetmap" && (
        <div style={{height:"calc(100vh - 110px)",display:"flex",flexDirection:"column",minHeight:0,background:"#f2f4f7"}}>
          <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading map…</div>}>
            <FleetMap
              vehicles={vehicles}
              loads={loads}
              gpsMap={gpsMap}
              delayedLoadIds={delayedLoadIds}
              onSeeMore={(id)=>setSeeMoreLoadId(id)}
            />
          </Suspense>
        </div>
      )}

      {/* ══════════ POD TAB ══════════ */}
      {tab==="pod" && (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7",width:"100%"}}>
          <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading…</div>}>
            <PODList />
          </Suspense>
        </div>
      )}

      {/* ══════════ MOVEMENT TAB ══════════ */}
      {tab==="movement" && (
        <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7",width:"100%"}}>
          <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading…</div>}>
            <DwellVehiclesPanel
              vehicles={vehicles}
              loads={loads}
              vehicleIncidents={vehicleIncidents}
              dwellComments={dwellComments}
              setDwellComments={setDwellComments}
              onReportIncident={(loadId)=>{ setIncidentForm({ type:"BREAKDOWN", note:"" }); setIncidentModal(loadId); }}
              onManageIncident={(vid)=>setManageVid(vid)}
              onMarkWithoutDriver={(v)=>openWithoutDriverModal(v)}
              onClearWithoutDriver={(vid)=>clearWithoutDriver(vid)}
            />
          </Suspense>
        </div>
      )}

      {/* ══════════ STATUS DELAY TAB ══════════ */}
      {tab==="statusdelay" && (() => {
        const SUBS = [
          { key:"waiting",   label:"Waiting For Load", status:"AVAILABLE",        tsField:"availableSince",   etaField:"waitingClearEta",     etaTitle:"Expected next-load assignment time",   extraMatch:(v)=>!!v.availableAfterDelivery },
          { key:"sfl",       label:"Sent For Loading", status:"SENT_FOR_LOADING", tsField:"sentForLoadingAt", etaField:"sentLoadingClearEta", etaTitle:"Expected time to reach loading point", extraMatch:()=>true },
          { key:"atloading", label:"At Loading",       status:"AT_LOADING",       tsField:"atLoadingAt",      etaField:"atLoadingClearEta",   etaTitle:"Expected loading-complete / dispatch time", extraMatch:()=>true },
        ];
        const active = SUBS.find(s => s.key === statusDelaySub) || SUBS[0];
        const thresholdFor = (status) => status === "AT_LOADING" ? 15 * 3600 * 1000 : 2 * 3600 * 1000;
        const matches = (v, s) => v.vstatus === s.status && v[s.tsField] && s.extraMatch(v);
        const rows = vehicles
          .filter(v => matches(v, active))
          .map(v => {
            const ts = new Date(v[active.tsField]).getTime();
            const ms = nowTick - ts;
            return { v, ts, ms, overdue: ms >= thresholdFor(active.status) };
          })
          .sort((a,b) => a.ts - b.ts);
        const fmtHM = (ms) => {
          if (!isFinite(ms) || ms < 0) return "—";
          const h = Math.floor(ms / 3600000);
          const m = Math.floor((ms % 3600000) / 60000);
          return h > 0 ? `${h}h ${m}m` : `${m}m`;
        };
        const parseEtaMs = (eta) => {
          if (!eta) return NaN;
          const s = String(eta);
          // datetime-local: YYYY-MM-DDTHH:mm or YYYY-MM-DDTHH:mm:ss (no TZ) → local
          const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(s);
          if (m) {
            const d = new Date(+m[1], +m[2]-1, +m[3], +m[4], +m[5], +(m[6]||0));
            return d.getTime();
          }
          return new Date(s).getTime();
        };
        const etaIsOverdue = (eta) => {
          const t = parseEtaMs(eta);
          return isFinite(t) && Date.now() > t;
        };

        const counts = Object.fromEntries(SUBS.map(s => {
          const c = vehicles.filter(v => matches(v, s) && (nowTick - new Date(v[s.tsField]).getTime()) >= thresholdFor(s.status)).length;
          return [s.key, c];
        }));
        return (
          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7",width:"100%"}}>
            <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:".9rem"}}>
              <h2 style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",margin:0}}> Status Delay</h2>
              <span style={{color:"#111827",fontSize:".78rem"}}>Vehicles stuck past their state threshold (2h, or 15h for At Loading) are flagged red. Set the ETA when this state is expected to clear — it turns red once the time passes.</span>
            </div>
            <div style={{display:"flex",gap:6,marginBottom:"1rem",flexWrap:"wrap"}}>
              {SUBS.map(s => {
                const isActive = s.key === statusDelaySub;
                return (
                  <button key={s.key} onClick={()=>setStatusDelaySub(s.key)}
                    style={{
                      fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",
                      padding:".5rem .85rem",borderRadius:8,cursor:"pointer",
                      border:isActive?"1px solid var(--accent)":"1px solid var(--border)",
                      background:isActive?"rgba(0,212,170,0.10)":"#ffffff",
                      color:isActive?"#111827":"#6b7280",
                      display:"inline-flex",alignItems:"center",gap:7,
                    }}>
                    {s.label}
                    {counts[s.key] > 0 && (
                      <span style={{background:"#dc2626",color:"#ffffff",borderRadius:8,fontSize:".68rem",padding:"1px 6px",fontWeight:600}}>{counts[s.key]}</span>
                    )}
                  </button>
                );
              })}
            </div>
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden"}}>
              <table style={{width:"100%",borderCollapse:"collapse",fontSize:".78rem"}}>
                <thead>
                  <tr style={{background:"#f2f4f7",textAlign:"left"}}>
                    {["Vehicle #","Driver","Mobile","Last Customer","Last Destination","Waiting Since","ETA","Branch"].map(h => (
                      <th key={h} style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",borderBottom:"1px solid var(--border)"}}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.length === 0 && (
                    <tr><td colSpan={8} style={{padding:"1.4rem",textAlign:"center",color:"#6b7280"}}>No vehicles in this state.</td></tr>
                  )}
                  {rows.map(({v,ms,overdue}) => {
                    const etaVal = v[active.etaField] || "";
                    const etaOver = etaIsOverdue(etaVal);
                    const rowBg = overdue ? "rgba(220,38,38,0.06)" : "transparent";
                    const onEtaChange = (val) => {
                      const next = val || null;
                      pushVehicles(p => p.map(x => x.id===v.id ? {...x, [active.etaField]: next} : x));
                      setNowTick(Date.now());
                    };
                    return (
                      <tr key={v.id} style={{background:rowBg,borderBottom:"1px solid var(--border)"}}>
                        <td style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#111827"}}>{v.vnum}</td>
                        <td style={{padding:".625rem .75rem",color:"#111827"}}>{v.driver || "—"}</td>
                        <td style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",color:"#6b7280"}}>{v.mobile || "—"}</td>
                        <td style={{padding:".625rem .75rem",color:"#6b7280"}}>{v.customer || "—"}</td>
                        <td style={{padding:".625rem .75rem",color:"#6b7280"}}>{v.destination || "—"}</td>
                        <td style={{padding:".625rem .75rem",fontWeight:600,color:overdue?"#dc2626":"#111827"}}>{fmtHM(ms)}</td>
                        <td style={{padding:".625rem .75rem",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem"}}>
                          <span style={{
                            display:"inline-block",
                            padding: etaOver ? "2px 4px" : "0",
                            borderRadius:6,
                            background: etaOver ? "#dc2626" : "transparent",
                            border: etaOver ? "1px solid #dc2626" : "1px solid transparent",
                          }}>
                            <PrettyDateTime
                              value={etaVal ? etaVal.slice(0,16) : ""}
                              onChange={onEtaChange}
                              style={{
                                fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",
                                padding:"3px 6px",
                                border: etaOver ? "1px solid #dc2626" : "1px solid var(--border)",
                                background: etaOver ? "#dc2626" : "rgba(37,99,235,0.08)",
                                color: etaOver ? "#ffffff" : "#2563eb",
                                fontWeight: etaOver ? 700 : 600,
                              }}
                            />
                          </span>
                        </td>

                        <td style={{padding:".625rem .75rem",color:"#6b7280"}}>{v.branch || "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        );
      })()}

      {/* ══════════ USERS TAB (admin only) ══════════ */}
      {tab==="users" && isAdmin && <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading…</div>}><UsersAdmin /></Suspense>}

      {/* ══════════ DELIVERED TAB ══════════ */}
      {tab==="delivered" && (
        <div style={{flex:1,overflowY:"auto",background:"#f2f4f7",width:"100%"}}>
          <Suspense fallback={<div style={{padding:"2rem",textAlign:"center",color:"#6b7280"}}>Loading…</div>}>
            <DeliveredLoads loads={loads} vehicles={vehicles} gpsMap={gpsMap} />
          </Suspense>
        </div>
      )}

      {/* ══════════ GPS UNAVAIL / UNRESOLVED TAB ══════════ */}
      {tab==="gpsissues" && (() => {
        const subRows = gpsIssuesSub === "nofetch" ? gpsIssueRows.noFetch : gpsIssueRows.unresolved;
        const PAGE_SIZE = 50;
        const totalPages = Math.max(1, Math.ceil(subRows.length / PAGE_SIZE));
        const curPage = Math.min(Math.max(1, gpsIssuesPage), totalPages);
        const startIdx = (curPage - 1) * PAGE_SIZE;
        const pageRows = subRows.slice(startIdx, startIdx + PAGE_SIZE);
        const pageNumbers = (() => {
          if (totalPages <= 7) return Array.from({length: totalPages}, (_,i)=>i+1);
          const out = new Set([1, totalPages, curPage, curPage-1, curPage+1]);
          const arr = [...out].filter(n=>n>=1&&n<=totalPages).sort((a,b)=>a-b);
          const withGaps = [];
          arr.forEach((n,i)=>{ if (i>0 && n - arr[i-1] > 1) withGaps.push("…"); withGaps.push(n); });
          return withGaps;
        })();
        const fmtT = (d) => { if (!d) return "—"; try { const x = new Date(d); return isNaN(x.getTime()) ? "—" : fmtDT(x.toISOString()); } catch { return "—"; } };
        const SubChip = ({id,label,count}) => {
          const active = gpsIssuesSub === id;
          return (
            <button onClick={()=>{setGpsIssuesSub(id); setGpsIssuesPage(1);}} style={{background:active?"#2563eb":"#f2f4f7",color:active?"#ffffff":"#111827",border:"1px solid",borderColor:active?"#0284c7":"#111827",padding:"7px 14px",borderRadius:12,fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",cursor:"pointer"}}>{label} <span style={{background:active?"rgba(255,255,255,0.25)":"#111827",color:active?"#ffffff":"#6b7280",padding:"1px 8px",borderRadius:12,marginLeft:6,fontSize:".68rem"}}>{count}</span></button>
          );
        };
        return (
          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:10}}>
               GPS Unavail / Unresolved
              <span style={{color:"#111827",fontSize:".78rem",fontWeight:400,letterSpacing:0}}>{gpsIssueRows.noFetch.length} no fetch · {gpsIssueRows.unresolved.length} unresolved coords</span>
            </div>
            <div style={{display:"flex",gap:".55rem",marginBottom:"1rem",flexWrap:"wrap"}}>
              <SubChip id="nofetch" label="No GPS Fetch" count={gpsIssueRows.noFetch.length} />
              <SubChip id="unresolved" label="Coords Not Resolving" count={gpsIssueRows.unresolved.length} />
            </div>
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,overflow:"hidden"}}>
              <div style={{overflowX:"auto"}}>
                <table style={{width:"100%",borderCollapse:"collapse",fontSize:".84rem"}}>
                  <thead style={{background:"#f2f4f7"}}>
                    <tr>
                      {["Vehicle #","Driver","Mobile","Status","Linked Load","Last GPS","Coords","Geocode Attempts", gpsIssuesSub==="unresolved" ? "Action" : ""].filter(Boolean).map(h=>(
                        <th key={h} style={{padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border)",fontSize:".68rem",letterSpacing:0,textTransform:"uppercase",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",whiteSpace:"nowrap"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.length === 0 && (
                      <tr><td colSpan={9} style={{padding:"2rem",textAlign:"center",color:"#6b7280",fontSize:".84rem"}}>{gpsIssuesSub==="nofetch" ? "All vehicles are sending GPS." : "All coordinates resolved."}</td></tr>
                    )}
                    {pageRows.map(({v,g,vk,linkedLoad,geoStatus}) => (
                      <tr key={v.id} style={{borderBottom:"1px solid #e4e7ed"}}>
                        <td style={{padding:".625rem .75rem",fontFamily:"var(--font-mono,monospace)",fontWeight:600,color:"#2563eb"}}>{v.vnum}</td>
                        <td style={{padding:".625rem .75rem"}}>{v.driver || "—"}</td>
                        <td style={{padding:".625rem .75rem",fontFamily:"var(--font-mono,monospace)",fontSize:".72rem"}}>{v.mobile || "—"}</td>
                        <td style={{padding:".625rem .75rem"}}><span style={{background:"#f2f4f7",color:"#111827",padding:"2px 7px",borderRadius:12,fontSize:".68rem",fontWeight:600,letterSpacing:0}}>{v.vstatus || "—"}</span></td>
                        <td style={{padding:".5rem .7rem"}}>
                          {linkedLoad ? (
                            <button onClick={()=>setSeeMoreLoadId(linkedLoad.id)} style={{background:"rgba(37,99,235,0.08)",border:"1px solid #2563eb",color:"#2563eb",padding:"3px 8px",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontWeight:600,fontFamily:"var(--font-mono,monospace)"}}>{linkedLoad.lid}</button>
                          ) : <span style={{color:"#6b7280",fontSize:".72rem"}}>—</span>}
                        </td>
                        <td style={{padding:".625rem .75rem",fontSize:".72rem",color:"#6b7280"}}>{fmtT(g?.updatedAt)}</td>
                        <td style={{padding:".625rem .75rem",fontFamily:"var(--font-mono,monospace)",fontSize:".72rem",color:"#6b7280"}}>{g && g.lat != null ? `${Number(g.lat).toFixed(4)}, ${Number(g.lng).toFixed(4)}` : "—"}</td>
                        <td style={{padding:".5rem .7rem"}}>
                          <span style={{color:geoStatus?.failed?"#dc2626":"#6b7280",fontSize:".72rem",fontWeight:geoStatus?.failed?700:500}}>
                            {geoStatus?.attempts ?? 0}{geoStatus?.failed ? " · failed" : ""}
                          </span>
                        </td>
                        {gpsIssuesSub === "unresolved" && (
                          <td style={{padding:".5rem .7rem"}}>
                            <button onClick={()=>{ delete geoRetryRef.current[vk]; setGeoStatusMap(p => { const n={...p}; delete n[vk]; return n; }); setGeoRetryTick(t=>t+1); }} style={{background:"rgba(37,99,235,0.08)",border:"1px solid #16a34a",color:"#16a34a",padding:"3px 9px",borderRadius:6,cursor:"pointer",fontSize:".68rem",fontWeight:600}}>Retry</button>
                          </td>
                        )}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {totalPages > 1 && (
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",flexWrap:"wrap",gap:".6rem",marginTop:".8rem"}}>
                <div style={{fontSize:".78rem",color:"#6b7280",fontWeight:600}}>Showing {startIdx+1}–{Math.min(startIdx+PAGE_SIZE, subRows.length)} of {subRows.length}</div>
                <div style={{display:"flex",alignItems:"center",gap:4,flexWrap:"wrap"}}>
                  <button onClick={()=>setGpsIssuesPage(p=>Math.max(1,p-1))} disabled={curPage<=1} style={{background:"#ffffff",border:"1px solid var(--border)",color:curPage<=1?"#e4e7ed":"#111827",padding:"5px 10px",borderRadius:6,fontSize:".78rem",fontWeight:600,cursor:curPage<=1?"default":"pointer"}}>‹</button>
                  {pageNumbers.map((n,i)=> n === "…" ? (
                    <span key={`g${i}`} style={{padding:"0 6px",color:"#6b7280"}}>…</span>
                  ) : (
                    <button key={n} onClick={()=>setGpsIssuesPage(n)} style={{background:n===curPage?"#111827":"#ffffff",color:n===curPage?"#ffffff":"#111827",border:"1px solid var(--border)",padding:"5px 11px",borderRadius:6,fontSize:".78rem",fontWeight:600,cursor:"pointer",minWidth:32}}>{n}</button>
                  ))}
                  <button onClick={()=>setGpsIssuesPage(p=>Math.min(totalPages,p+1))} disabled={curPage>=totalPages} style={{background:"#ffffff",border:"1px solid var(--border)",color:curPage>=totalPages?"#e4e7ed":"#111827",padding:"5px 10px",borderRadius:6,fontSize:".78rem",fontWeight:600,cursor:curPage>=totalPages?"default":"pointer"}}>›</button>
                </div>
              </div>
            )}
          </div>
        );
      })()}


      {/* ══════════ INCOMING VEHICLES TAB ══════════ */}
      {tab==="incoming" && (() => {
        // Predict arrivals over next 3 days for IN_TRANSIT vehicles
        const NOW = Date.now();
        const HORIZON = NOW + 3 * 24 * 3600 * 1000;
        const fmtDT = (d) => d ? d.toLocaleString("en-IN",{day:"2-digit",month:"2-digit",year:"2-digit",hour:"2-digit",minute:"2-digit"}).replace(/\//g,"-") : "—";
        const relTime = (d) => {
          if (!d) return "";
          const ms = d.getTime() - NOW;
          if (ms < 0) return `${Math.round(-ms/3600000)}h overdue`;
          const h = ms / 3600000;
          if (h < 1) return `in ${Math.round(ms/60000)}m`;
          if (h < 24) return `in ${Math.floor(h)}h ${Math.round((h-Math.floor(h))*60)}m`;
          const d2 = h / 24;
          return `in ${d2.toFixed(1)}d`;
        };
        // Branch filter source = Settings → Branches list ONLY.
        // Any add/remove/edit in Settings is reflected here live.
        const myBranches = Array.from(new Set(
          (branches || [])
            .map(b => typeof b === "string" ? b : b?.name)
            .filter(Boolean)
        )).sort();

        const selected = incomingBranches || [];
        const isSelected = (b) => selected.length === 0 || selected.includes(b);
        const toggleBranch = (b) => {
          setIncomingBranches(prev => {
            const cur = prev || [];
            return cur.includes(b) ? cur.filter(x=>x!==b) : [...cur, b];
          });
        };
        const rows = [];
        for (const v of vehicles) {
          if (v.vstatus !== "IN_TRANSIT") continue;
          const ld = v.loadId ? loadById.get(String(v.loadId)) ?? null : loads.find(l => l.vehicleId === v.id);
          if (!ld || !ld.dest) continue;
          // Destination city → branch: saved city→branch rules first, then auto-match
          // by branch name (e.g. dest "Lucknow" → "Lucknow" branch if it exists).
          let destBranch = getDestBranch(ld.dest);
          if (!destBranch) {
            const dk = String(ld.dest||"").trim().toLowerCase();
            const hit = myBranches.find(b => String(b).trim().toLowerCase() === dk);
            if (hit) destBranch = hit;
          }
          if (!destBranch) continue;

          const gps = lookupGps(gpsMap, v.vnum);
          const vkInc = gpsVehicleKey(v.vnum);
          const gpsAddress = gps?.address || addrMap[vkInc] || null;
          let arrivalAt = null, distToGo = null, source = "scheduled";
          const { arrivalAt: ca, distToGo: dtg } = computeTat(ld, v, cityCoords, gpsMap);
          if (ca) {
            arrivalAt = ca;
            distToGo = dtg;
            source = "gps";
          } else if (ld.delivery) {
            const t = new Date(ld.delivery);
            if (!isNaN(t.getTime())) arrivalAt = t;
          }
          if (!arrivalAt) continue;
          if (arrivalAt.getTime() > HORIZON) continue;
          const startOfToday = new Date(); startOfToday.setHours(0,0,0,0);
          const dayIdx = Math.floor((arrivalAt.getTime() - startOfToday.getTime()) / (24*3600*1000));
          const dayBucket = dayIdx <= 0 ? 0 : Math.min(dayIdx, 3);
          const delayed = ld.delivery ? (arrivalAt.getTime() > new Date(ld.delivery).getTime() + 3600000) : false;
          rows.push({ v, ld, destBranch, gps, gpsAddress, distToGo, arrivalAt, source, dayBucket, delayed });
        }
        rows.sort((a,b)=>a.arrivalAt - b.arrivalAt);
        const branchesWithRows = Array.from(new Set(rows.map(r=>r.destBranch))).sort();
        const filtered = rows.filter(r => {
          if (!isSelected(r.destBranch)) return false;
          if (incomingDay !== "ALL" && r.dayBucket !== incomingDay) return false;
          return true;
        });
        const dayLabel = (i) => i===0?"Today":i===1?"Tomorrow":`Day +${i}`;
        const byBranch = {};
        for (const r of filtered) {
          (byBranch[r.destBranch] = byBranch[r.destBranch] || []).push(r);
        }
        return (
          <div style={{flex:1,overflowY:"auto",padding:"1.3rem",background:"#f2f4f7"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",marginBottom:".9rem",color:"#111827",display:"flex",alignItems:"center",gap:8}}>
               Incoming Vehicles <span style={{color:"#111827",fontSize:".78rem",fontWeight:400,letterSpacing:0}}>{filtered.length} arrivals predicted · next 3 days · destination city → branch via your saved rules</span>
            </div>

            {/* Branch dropdown (auto-reflects saved branches) */}
            <div style={{marginBottom:".8rem",display:"flex",alignItems:"center",gap:".6rem",flexWrap:"wrap"}}>
              <label style={{fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif"}}>Branch:</label>
              <select
                value={selected[0] || "ALL"}
                onChange={e => setIncomingBranches(e.target.value === "ALL" ? [] : [e.target.value])}
                style={{padding:".625rem .75rem",border:"1px solid var(--border)",borderRadius:6,background:"#ffffff",fontSize:".84rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,minWidth:220,cursor:"pointer"}}
              >
                <option value="ALL">All Branches ({myBranches.length})</option>
                {myBranches.map(b => <option key={b} value={b}>{b}</option>)}
              </select>
              {myBranches.length === 0 && <span style={{fontSize:".72rem",color:"#111827"}}>No branches saved yet — add city→branch rules in the Unloading tab.</span>}
            </div>


            {/* Day filter */}
            <div style={{display:"flex",gap:".6rem",flexWrap:"wrap",marginBottom:"1rem",alignItems:"center"}}>
              <div style={{display:"flex",gap:4}}>
                {[["ALL","All 3d"],[0,"Today"],[1,"Tomorrow"],[2,"Day +2"],[3,"Day +3"]].map(([val,lbl])=>(
                  <button key={String(val)} onClick={()=>setIncomingDay(val)} style={{padding:".42rem .8rem",border:"1px solid var(--border)",borderRadius:6,background:incomingDay===val?"#111827":"#ffffff",color:incomingDay===val?"#ffffff":"#6b7280",fontSize:".78rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,cursor:"pointer",textTransform:"uppercase",letterSpacing:0}}>{lbl}</button>
                ))}
              </div>
            </div>

            {/* Branch summary cards */}
            {branchesWithRows.length > 0 && (
              <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(200px,1fr))",gap:".7rem",marginBottom:"1.1rem"}}>
                {branchesWithRows.map(b => {
                  const list = rows.filter(r=>r.destBranch===b);
                  const next = list[0];
                  const active = selected.includes(b);
                  return (
                    <button key={b} onClick={()=>toggleBranch(b)} style={{textAlign:"left",background:active?"rgba(0,212,170,0.08)":"#ffffff",border:`1px solid ${active?"#111827":"#e4e7ed"}`,borderRadius:8,padding:".75rem .9rem",cursor:"pointer"}}>
                      <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280"}}>{b}</div>
                      <div style={{fontSize:"1.2rem",fontWeight:600,color:"#111827",marginTop:2,fontFamily:"'Inter',system-ui,sans-serif"}}>{list.length}</div>
                      <div style={{fontSize:".68rem",color:"#111827",marginTop:2}}>{next ? `Next: ${fmtDT(next.arrivalAt)}` : "—"}</div>
                    </button>
                  );
                })}
              </div>
            )}


            {/* Grouped tables */}
            {Object.keys(byBranch).length === 0 ? (
              <div style={{background:"#ffffff",border:"1px dashed var(--border)",borderRadius:12,padding:"2.5rem",textAlign:"center",color:"#111827",fontSize:".9rem"}}>
                No vehicles arriving in the next 3 days for selected filter.
              </div>
            ) : Object.entries(byBranch).map(([b, list]) => (
              <div key={b} style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,marginBottom:"1rem",overflow:"hidden"}}>
                <div style={{padding:".75rem 1rem",borderBottom:"1px solid var(--border)",background:"rgba(0,212,170,0.06)",display:"flex",alignItems:"center",gap:8}}>
                  <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827"}}>{b}</span>
                  <span style={{background:"#111827",color:"#ffffff",borderRadius:12,fontSize:".68rem",padding:"1px 7px",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600}}>{list.length}</span>
                </div>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%",borderCollapse:"collapse",fontSize:".78rem"}}>
                    <thead>
                      <tr style={{background:"#f2f4f7",color:"#111827",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem",letterSpacing:0,textTransform:"uppercase"}}>
                        <th style={{padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border)"}}>Vehicle</th>
                        <th style={{padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border)"}}>Driver</th>
                        <th style={{padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border)"}}>Route</th>
                        <th style={{padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border)"}}>Load</th>
                        <th style={{padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border)"}}>Current GPS</th>
                        <th style={{padding:".625rem .75rem",textAlign:"right",borderBottom:"1px solid var(--border)"}}>KM Left</th>
                        <th style={{padding:".625rem .75rem",textAlign:"left",borderBottom:"1px solid var(--border)"}}>Predicted ETA</th>
                        <th style={{padding:".625rem .75rem",textAlign:"center",borderBottom:"1px solid var(--border)"}}>Source</th>
                      </tr>
                    </thead>
                    <tbody>
                      {list.map((r,i)=>(
                        <tr key={r.v.id+"-"+i} style={{borderBottom:"1px solid var(--border)"}}>
                          <td style={{padding:".625rem .75rem"}}>
                            <div style={{fontWeight:600,color:"#111827"}}>{r.v.vnum}</div>
                            <div style={{fontSize:".68rem",color:"#111827"}}>{r.v.vtype}</div>
                          </td>
                          <td style={{padding:".625rem .75rem"}}>
                            <div>{r.v.driver || "—"}</div>
                            <div style={{fontSize:".68rem",color:"#111827"}}>{r.v.mobile || ""}</div>
                          </td>
                          <td style={{padding:".625rem .75rem"}}>
                            <div style={{fontSize:".78rem"}}>{r.ld.origin || "—"} → <b>{r.ld.dest}</b></div>
                          </td>
                          <td style={{padding:".625rem .75rem"}}>
                            <div style={{fontWeight:600,color:"#374151"}}>{r.ld.lid}</div>
                            <div style={{fontSize:".68rem",color:"#111827"}}>{r.ld.customer || ""} · {r.ld.commodity || ""}</div>
                            <div style={{fontSize:".68rem",color:"#111827"}}>{r.ld.weight?`${r.ld.weight}T`:""}{r.ld.volume?` · ${r.ld.volume}m³`:""}</div>
                          </td>
                          <td style={{padding:".625rem .75rem",maxWidth:240}}>
                            <div style={{fontSize:".72rem",color:"#111827",lineHeight:1.3,overflow:"hidden",textOverflow:"ellipsis",display:"-webkit-box",WebkitLineClamp:2,WebkitBoxOrient:"vertical"}}>{r.gpsAddress || "awaiting GPS"}</div>
                          </td>
                          <td style={{padding:".625rem .75rem",textAlign:"right",fontVariantNumeric:"tabular-nums"}}>{r.distToGo!=null?`${r.distToGo.toFixed(0)} km`:"—"}</td>
                          <td style={{padding:".625rem .75rem"}}>
                            <div style={{fontWeight:600,color:r.delayed?"#dc2626":"#111827"}}>{fmtDT(r.arrivalAt)}</div>
                            <div style={{fontSize:".68rem",color:r.delayed?"#dc2626":"#111827"}}>{relTime(r.arrivalAt)} · {dayLabel(r.dayBucket)}</div>
                          </td>
                          <td style={{padding:".625rem .75rem",textAlign:"center"}}>
                            <span style={{background:r.source==="gps"?"rgba(37,99,235,0.08)":"rgba(217,119,6,0.08)",color:r.source==="gps"?"#2563eb":"#d97706",padding:"3px 9px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>{r.source==="gps"?"GPS":"Scheduled"}</span>
                            {r.delayed && <div style={{marginTop:3,fontSize:".68rem",color:"#dc2626",fontWeight:600,letterSpacing:0,textTransform:"uppercase"}}>Delayed</div>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            ))}
          </div>
        );
      })()}

      {/* Delete Vehicle */}
      {delV && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.6rem",width:"92%",maxWidth:440,boxShadow:"0 8px 32px rgba(0,0,0,.15)"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"var(--red)",letterSpacing:0,textTransform:"uppercase",marginBottom:".6rem"}}>Remove Vehicle</div>
            <p style={{color:"#111827",fontSize:".84rem"}}>Are you sure you want to remove this vehicle? Any load assignment will be cleared.</p>
            <div style={{display:"flex",gap:".7rem",marginTop:"1rem"}}>
              <button onClick={deleteV} style={{flex:1,background:"var(--red)",color:"#ffffff",border:"none",padding:".58rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(220,38,38,0.2)",transition:"all .15s"}}>DELETE</button>
              <button onClick={()=>setDelV(null)} style={{flex:1,background:"transparent",color:"#374151",border:"1px solid #e4e7ed",padding:".58rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",transition:"all .15s"}}>CANCEL</button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Load */}
      {delL && (
        <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.5)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
          <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.6rem",width:"92%",maxWidth:440,boxShadow:"0 8px 32px rgba(0,0,0,.15)"}}>
            <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"var(--red)",letterSpacing:0,textTransform:"uppercase",marginBottom:".6rem"}}>Delete Load</div>
            <p style={{color:"#111827",fontSize:".84rem"}}>Delete this load? Any assigned vehicle will be freed back to Available.</p>
            <div style={{display:"flex",gap:".7rem",marginTop:"1rem"}}>
              <button onClick={deleteL} style={{flex:1,background:"var(--red)",color:"#ffffff",border:"none",padding:".58rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",boxShadow:"0 1px 3px rgba(220,38,38,0.2)",transition:"all .15s"}}>DELETE</button>
              <button onClick={()=>setDelL(null)} style={{flex:1,background:"transparent",color:"#374151",border:"1px solid #e4e7ed",padding:".58rem",borderRadius:12,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",transition:"all .15s"}}>CANCEL</button>
            </div>
          </div>
        </div>
      )}

      {/* Assign Vehicle Modal */}
      {assignLid && (() => {
        const FREE_STATUSES = ["AT_UNLOADING","EMPTY","AVAILABLE"];
        const aLoad = loadById.get(String(assignLid)) ?? null;
        const loadBranch = aLoad?.branch || "";
        const matchesBranch = (v) => {
          if (assignAllBranches || !loadBranch) return true;
          const vb = gpsBranchMap[gpsVehicleKey(v.vnum)];
          return vb === loadBranch;
        };
        const matchesSearch = (v) => {
          const q = assignSearch.trim().toLowerCase();
          if (!q) return true;
          return [v.vnum,v.driver,v.vtype,v.mobile,v.customer].some(f=>f&&String(f).toLowerCase().includes(q));
        };
        let shownVehicles = vehicles.filter(matchesBranch).filter(matchesSearch);
        if (!showAllAssignVehicles) shownVehicles = shownVehicles.filter(v=>FREE_STATUSES.includes(v.vstatus));
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{position:"relative",background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.6rem",width:"96%",maxWidth:680,boxShadow:"0 12px 48px rgba(0,0,0,.7),0 0 0 1px var(--border)",maxHeight:"90vh",overflowY:"auto"}}>
              <button onClick={()=>{setAssignLid(null);setShowAllAssignVehicles(true);setAssignSearch("");setAssignAllBranches(true);}} aria-label="Close" style={{position:"absolute",top:10,right:12,width:30,height:30,display:"grid",placeItems:"center",background:"transparent",border:"1px solid var(--border)",borderRadius:6,color:"#111827",fontSize:"1rem",fontWeight:600,cursor:"pointer",lineHeight:1}}>✕</button>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#374151",letterSpacing:0,textTransform:"uppercase",marginBottom:".35rem",paddingRight:36}}>Assign Vehicle to Load</div>
              {aLoad && (
                <div style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:8,padding:".625rem .75rem",marginBottom:".75rem",display:"flex",gap:"1.5rem",flexWrap:"wrap"}}>
                  <div><span style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0}}>Load</span><div style={{fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,color:"#374151",fontSize:".84rem"}}>{aLoad.lid}</div></div>
                  <div><span style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0}}>Route</span><div style={{fontWeight:600,fontSize:".84rem"}}>{aLoad.origin} → {aLoad.dest}</div></div>
                  <div><span style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0}}>Branch</span><div style={{fontWeight:600,fontSize:".84rem",color:"#6366f1"}}>{aLoad.branch||"—"}</div></div>
                  {aLoad.vtypeReq && <div><span style={{fontSize:".68rem",color:"#111827",textTransform:"uppercase",letterSpacing:0}}>Required Type</span><div style={{fontWeight:600,fontSize:".84rem",color:"#6366f1"}}>{aLoad.vtypeReq}</div></div>}
                </div>
              )}
              {/* Search + filters row */}
              <div style={{display:"flex",gap:".5rem",marginBottom:".55rem",flexWrap:"wrap",alignItems:"center"}}>
                <input value={assignSearch} onChange={e=>setAssignSearch(e.target.value)} placeholder="🔍 Search vehicle / driver / mobile..." style={{flex:1,minWidth:200,background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".625rem .75rem",borderRadius:6,fontSize:".84rem",outline:"none"}}/>
                <button onClick={()=>setAssignAllBranches(p=>!p)} style={{background:assignAllBranches?"#111827":"#ffffff",color:assignAllBranches?"#ffffff":"#111827",border:"1px solid var(--border)",padding:".46rem .85rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".72rem",fontWeight:600,cursor:"pointer",textTransform:"uppercase",letterSpacing:0,whiteSpace:"nowrap"}}>
                  {assignAllBranches?"✓ All Branches":"All Branches"}
                </button>
                <button onClick={()=>setShowAllAssignVehicles(p=>!p)}
                  style={{background:showAllAssignVehicles?"rgba(37,99,235,0.08)":"#f2f4f7",border:"1px solid",borderColor:showAllAssignVehicles?"#2563eb":"#e4e7ed",color:showAllAssignVehicles?"#2563eb":"#6b7280",padding:".46rem .85rem",borderRadius:6,cursor:"pointer",fontSize:".72rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",whiteSpace:"nowrap"}}>
                  {showAllAssignVehicles?"Show Free Only":"Show All Statuses"}
                </button>
              </div>
              <div style={{fontSize:".72rem",color:"#111827",fontStyle:"italic",marginBottom:".55rem"}}>
                {shownVehicles.length} vehicle{shownVehicles.length!==1?"s":""} · {assignAllBranches||!loadBranch?"all branches":`branch: ${loadBranch}`} · ⭐ = Type match ·  = Route match
              </div>
              <div style={{display:"flex",flexDirection:"column",gap:".45rem"}}>
                {shownVehicles.length===0 ? (
                  <div style={{textAlign:"center",padding:"1.5rem",color:"#111827",fontSize:".84rem"}}>No vehicles in this category.</div>
                ) : shownVehicles.map(v => {
                  const routeMatch = aLoad && v.prefRoutes && (
                    v.prefRoutes.toLowerCase().includes((aLoad.origin||"").toLowerCase()) ||
                    v.prefRoutes.toLowerCase().includes((aLoad.dest||"").toLowerCase())
                  );
                  const typeMatch = aLoad && aLoad.vtypeReq && v.vtype === aLoad.vtypeReq;
                  const isAvail = v.vstatus === "AVAILABLE" || v.vstatus === "EMPTY" || v.vstatus === "AT_UNLOADING";
                  const sBg = v.vstatus==="IN_TRANSIT"?"rgba(37,99,235,0.08)":v.vstatus==="AVAILABLE"?"rgba(22,163,74,0.08)":v.vstatus==="AT_LOADING"?"rgba(217,119,6,0.08)":v.vstatus==="SENT_FOR_LOADING"?"rgba(99,102,241,0.08)":v.vstatus==="AT_UNLOADING"?"#fff1f2":v.vstatus==="EMPTY"?"rgba(37,99,235,0.08)":v.vstatus==="DELIVERED"?"rgba(22,163,74,0.08)":"#f2f4f7";
                  const sCol = v.vstatus==="IN_TRANSIT"?"#2563eb":v.vstatus==="AVAILABLE"?"#16a34a":v.vstatus==="AT_LOADING"?"#d97706":v.vstatus==="SENT_FOR_LOADING"?"#6366f1":v.vstatus==="AT_UNLOADING"?"#d97706":v.vstatus==="EMPTY"?"#16a34a":v.vstatus==="DELIVERED"?"#059669":"#6b7280";
                  return (
                    <div key={v.id} onClick={()=>assignVehicle(v.id)}
                      style={{display:"grid",gridTemplateColumns:"auto 1fr auto",alignItems:"center",gap:".8rem",padding:".625rem .75rem",border:"1px solid",borderColor:typeMatch&&isAvail?"#16a34a":routeMatch?"#2563eb":"#e4e7ed",borderRadius:8,cursor:"pointer",background:typeMatch&&isAvail?"rgba(37,99,235,0.08)":routeMatch?"rgba(37,99,235,0.08)":"#f2f4f7",transition:"all .12s"}}
                      onMouseEnter={e=>{e.currentTarget.style.boxShadow="0 2px 8px rgba(0,0,0,.1)"; e.currentTarget.style.borderColor="#2563eb";}}
                      onMouseLeave={e=>{e.currentTarget.style.boxShadow="none"; e.currentTarget.style.borderColor=typeMatch&&isAvail?"#16a34a":routeMatch?"#2563eb":"#e4e7ed";}}>
                      {/* Match indicators */}
                      <div style={{display:"flex",flexDirection:"column",gap:2,alignItems:"center",minWidth:22}}>
                        <span title={typeMatch?"Vehicle type matches load requirement":""} style={{fontSize:14,opacity:typeMatch?1:.2}}>⭐</span>
                        <span title={routeMatch?"Driver prefers this route":""} style={{fontSize:13,opacity:routeMatch?1:.2}}></span>
                      </div>
                      {/* Vehicle info */}
                      <div>
                        <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:2}}>
                          <span style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#6366f1"}}>{v.vnum}</span>
                          <span style={{fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",padding:"1px 5px",border:"1px solid var(--border)",borderRadius:6,color:"#6b7280"}}>{v.vtype}</span>
                        </div>
                        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
                          <div style={{fontSize:".78rem",color:"#111827",fontWeight:500}}>{v.driver} {v.driverExp?<span style={{color:"#111827",fontWeight:400}}>· {v.driverExp}</span>:""}</div>
                          {v.driverRating>0 && <StarDisplay rating={v.driverRating} size={13}/>}
                        </div>
                        <div style={{fontSize:".72rem",color:"#111827",marginTop:1}}>
                          {v.prefRoutes ? <span>🧭 {v.prefRoutes}</span> : <span style={{color:"#6b7280"}}>No route preferences set</span>}
                        </div>
                        {v.driverNote && <div style={{fontSize:".68rem",color:"#111827",fontStyle:"italic",marginTop:1}}>💬 {v.driverNote}</div>}
                        {(() => {
                          const vk = gpsVehicleKey(v.vnum); const vkAlt = gpsVehicleKeyAlt(v.vnum);
                          const g = (gpsMap[vk] || gpsMap[vkAlt]);
                          const liveAddr = g?.address || addrMap[vk];
                          const coordTxt = g?.lat != null && g?.lng != null
                            ? `${Number(g.lat).toFixed(4)}, ${Number(g.lng).toFixed(4)}`
                            : null;
                          const shown = liveAddr || coordTxt || v.departure;
                          if (!shown) return null;
                          return (
                            <div style={{fontSize:".68rem",color:"#111827",marginTop:1}}>
                              Currently at: {shown}
                              {!liveAddr && coordTxt && <span style={{marginLeft:4,color:"#6b7280"}}>(resolving address…)</span>}
                            </div>
                          );
                        })()}
                      </div>
                      {/* Status badge */}
                      <div style={{textAlign:"right"}}>
                        <span style={{display:"inline-flex",alignItems:"center",gap:4,padding:"3px 9px",borderRadius:12,fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",background:sBg,color:sCol,whiteSpace:"nowrap"}}>
                          <span style={{width:5,height:5,borderRadius:"50%",background:"currentColor",opacity:.8,flexShrink:0}}/>
                          {VS_LABELS[v.vstatus]}
                        </span>
                        {!isAvail && <div style={{fontSize:".68rem",color:"#d97706",marginTop:3,fontWeight:600}}>Not free</div>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <button onClick={()=>{setAssignLid(null);setShowAllAssignVehicles(true);setAssignSearch("");setAssignAllBranches(true);}} style={{width:"100%",marginTop:"1rem",background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".52rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".78rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
            </div>
          </div>
        );
      })()}
      {/* ══ DELAY REASON MODAL ══ */}
      {delayModal && (() => {
        const l = loadById.get(String(delayModal)) ?? null;
        const needsEta = DELAY_REASONS.find(r=>r.id===delayForm.reason)?.askEta;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.8rem",width:"92%",maxWidth:500,boxShadow:"0 12px 48px rgba(0,0,0,.7),0 0 0 1px var(--border)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#6366f1",letterSpacing:0,textTransform:"uppercase",marginBottom:".4rem"}}> Set Delay Reason</div>
              {l && <div style={{background:"#fefce8",border:"1px solid rgba(245,158,11,0.3)",borderRadius:6,padding:".5rem .8rem",marginBottom:"1rem",fontSize:".84rem",color:"#6366f1"}}><strong>{l.lid}</strong> · {l.origin} → {l.dest} · {l.customer}</div>}
              <div style={{marginBottom:"1rem"}}>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:6}}>Reason for Delay *</label>
                <div style={{display:"flex",flexDirection:"column",gap:".4rem"}}>
                  {DELAY_REASONS.map(r=>(
                    <button key={r.id} onClick={()=>setDelayForm(p=>({...p,reason:r.id}))}
                      style={{display:"flex",alignItems:"center",gap:10,padding:".625rem .75rem",borderRadius:8,border:"2px solid",borderColor:delayForm.reason===r.id?"#d97706":"#e4e7ed",background:delayForm.reason===r.id?"rgba(217,119,6,0.08)":"#f2f4f7",cursor:"pointer",textAlign:"left",transition:"all .12s"}}>
                      <span style={{fontSize:18}}>{r.icon}</span>
                      <div>
                        <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,color:delayForm.reason===r.id?"#d97706":"#374151",letterSpacing:0}}>{r.label}</div>
                        {r.id==="STOPPAGE" && <div style={{fontSize:".68rem",color:"#111827"}}>Requires revised ETA + manager confirmation</div>}
                      </div>
                      {delayForm.reason===r.id && <span style={{marginLeft:"auto",color:"#6366f1",fontSize:16}}>✓</span>}
                    </button>
                  ))}
                </div>
              </div>
              {needsEta && (
                <div style={{marginBottom:"1rem",background:"rgba(249,115,22,0.08)",border:"1px solid rgba(249,115,22,0.4)",borderRadius:8,padding:".625rem .75rem"}}>
                  <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#d97706",marginBottom:4}}>Revised ETA — When will vehicle be back on road? *</label>
                  <DateTimeField value={delayForm.revisedEta} onChange={(val)=>setDelayForm(p=>({...p,revisedEta:val}))} accentBorder="rgba(249,115,22,0.4)" />
                  <div style={{fontSize:".68rem",color:"#111827",marginTop:4}}>Manager must confirm vehicle status at or before this time.</div>
                </div>
              )}
              <div style={{display:"flex",gap:".7rem"}}>
                <button onClick={saveDelayReason} style={{flex:1,background:"#111827",color:"#080b0f",border:"none",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase"}}>SAVE REASON</button>
                <button onClick={()=>{setDelayModal(null);setDelayForm({reason:"",revisedEta:"",});}} style={{flex:1,background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══ STOPPAGE CONFIRMATION MODAL ══ */}
      {confirmModal && (() => {
        const l = loadById.get(String(confirmModal)) ?? null;
        const di = delayInfo[confirmModal];
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.88)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.8rem",width:"92%",maxWidth:500,boxShadow:"0 12px 48px rgba(0,0,0,.2)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#374151",letterSpacing:0,textTransform:"uppercase",marginBottom:".4rem"}}>Manager Stoppage Confirmation</div>
              {l && <div style={{background:"rgba(14,165,233,0.08)",border:"1px solid rgba(14,165,233,0.3)",borderRadius:6,padding:".5rem .8rem",marginBottom:".5rem",fontSize:".84rem",color:"#374151"}}><strong>{l.lid}</strong> · {l.origin} → {l.dest}</div>}
              {di?.revisedEta && <div style={{background:"#fefce8",border:"1px solid rgba(245,158,11,0.3)",borderRadius:6,padding:".5rem .8rem",marginBottom:"1rem",fontSize:".84rem",color:"#6366f1"}}>Revised ETA was set to: <strong>{fmtDT(di.revisedEta)}</strong></div>}
              <div style={{marginBottom:"1rem"}}>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:6}}>Is the vehicle running now? *</label>
                <div style={{display:"flex",gap:".6rem"}}>
                  {[[true," Yes, Vehicle is Running","rgba(37,99,235,0.08)","#16a34a","#16a34a"],[false," No, Still Stopped","#fff1f2","#dc2626","#dc2626"]].map(([val,label,bg,border,col])=>(
                    <button key={String(val)} onClick={()=>setConfirmForm(p=>({...p,running:val}))}
                      style={{flex:1,padding:".65rem",borderRadius:8,border:"2px solid",borderColor:confirmForm.running===val?border:"#e4e7ed",background:confirmForm.running===val?bg:"#f2f4f7",color:confirmForm.running===val?col:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",fontWeight:600,cursor:"pointer",transition:"all .12s"}}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {confirmForm.running===false && (
                <div style={{background:"rgba(249,115,22,0.08)",border:"1px solid rgba(249,115,22,0.4)",borderRadius:8,padding:".9rem",marginBottom:".9rem"}}>
                  <div style={{marginBottom:".7rem"}}>
                    <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#d97706",marginBottom:4}}>New Revised ETA — When will it start? *</label>
                    <DateTimeField value={confirmForm.newEta} onChange={(val)=>setConfirmForm(p=>({...p,newEta:val}))} accentBorder="rgba(249,115,22,0.4)" />
                  </div>
                  <div>
                    <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#d97706",marginBottom:4}}>Reason for Continued Stoppage *</label>
                    <textarea value={confirmForm.newReason} onChange={e=>setConfirmForm(p=>({...p,newReason:e.target.value}))} placeholder="e.g. Driver rest stop extended, police checkpost, road blocked…" rows={2}
                      style={{width:"100%",background:"#ffffff",border:"1px solid rgba(249,115,22,0.4)",color:"#111827",padding:".625rem .75rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",resize:"vertical"}}/>
                  </div>
                </div>
              )}
              <div style={{display:"flex",gap:".7rem"}}>
                <button onClick={submitConfirmation} style={{flex:1,background:confirmForm.running?"#16a34a":"#d97706",color:"#ffffff",border:"none",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase"}}>SUBMIT CONFIRMATION</button>
                <button onClick={()=>{setConfirmModal(null);setConfirmForm({running:null,newEta:"",newReason:"",});}} style={{flex:1,background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══ WITHOUT-DRIVER MODAL ══ */}
      {wdModalVid && (() => {
        const v = vehicleById.get(String(wdModalVid));
        const isEdit = !!v?.withoutDriver;
        return (
          <div onClick={()=>{setWdModalVid(null);setWdEtaInput("");}} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.4rem",width:"min(440px,92vw)",boxShadow:"0 24px 60px rgba(0,0,0,.35)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#d97706",letterSpacing:0,textTransform:"uppercase",marginBottom:".4rem"}}>Without Driver</div>
              <div style={{fontSize:".84rem",color:"#374151",marginBottom:".9rem",fontFamily:"'Inter',system-ui,sans-serif"}}>
                Vehicle <b>{v?.vnum||"—"}</b>{v?.driver?` · current driver "${v.driver}"`:""}
              </div>
              <label style={{display:"block",fontSize:".68rem",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:".3rem",fontFamily:"'Inter',system-ui,sans-serif"}}>Driver Expected By</label>
              <input type="datetime-local" value={wdEtaInput} onChange={e=>setWdEtaInput(e.target.value)} style={{width:"100%",padding:".625rem .75rem",border:"1px solid var(--border)",borderRadius:6,fontSize:".9rem",fontFamily:"'Inter',system-ui,sans-serif",background:"#f2f4f7",color:"#111827",outline:"none"}}/>
              <div style={{marginTop:".8rem",fontSize:".72rem",color:"#d97706",background:"rgba(217,119,6,0.08)",border:"1px solid #d97706",padding:".625rem .75rem",borderRadius:6,lineHeight:1.45}}>
                A <b>Without Driver</b> badge will appear on this vehicle's loads in Load Board and TAT Tracker. After the ETA passes, the badge turns red.
              </div>
              <div style={{display:"flex",gap:".55rem",marginTop:"1.1rem"}}>
                {isEdit && (
                  <button onClick={()=>clearWithoutDriver(wdModalVid)} style={{flex:1,background:"transparent",color:"#16a34a",border:"1px solid #16a34a",padding:".6rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>✓ Clear</button>
                )}
                <button onClick={saveWithoutDriver} style={{flex:1,background:"#d97706",color:"#ffffff",border:"none",padding:".6rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase"}}>{isEdit?"Update ETA":"Save"}</button>
                <button onClick={()=>{setWdModalVid(null);setWdEtaInput("");}} style={{flex:1,background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".6rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      {incidentModal && (() => {
        // loadId string (Load Board) OR { vehicleId } (Movement page, no-load vehicles)
        const isVehTrigger = typeof incidentModal === "object" && incidentModal?.vehicleId;
        const av0 = isVehTrigger ? (vehicleById.get(String(incidentModal.vehicleId)) ?? null) : null;
        const l = isVehTrigger
          ? (av0?.loadId ? (loadById.get(String(av0.loadId)) ?? null) : null)
          : (loadById.get(String(incidentModal)) ?? null);
        const av = av0 || (l?.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null);
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}}>
            <div style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.8rem",width:"92%",maxWidth:480,boxShadow:"0 12px 48px rgba(0,0,0,.7),0 0 0 1px var(--border)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1.2rem",fontWeight:600,color:"#d97706",letterSpacing:0,textTransform:"uppercase",marginBottom:".5rem"}}> Report Incident</div>
              {l ? (
                <div style={{background:"rgba(249,115,22,0.08)",border:"1px solid rgba(249,115,22,0.4)",borderRadius:6,padding:".625rem .75rem",marginBottom:"1rem",fontSize:".84rem",color:"#6366f1"}}>
                  Load <strong>{l.lid}</strong> · {l.origin} → {l.dest}
                  {av && <span> · Vehicle <strong>{av.vnum}</strong> ({av.driver})</span>}
                </div>
              ) : av ? (
                <div style={{background:"rgba(249,115,22,0.08)",border:"1px solid rgba(249,115,22,0.4)",borderRadius:6,padding:".625rem .75rem",marginBottom:"1rem",fontSize:".84rem",color:"#6366f1"}}>
                  Vehicle <strong>{av.vnum}</strong>{av.driver ? ` (${av.driver})` : ""} · no load attached
                </div>
              ) : null}
              {/* Type selector */}
              <div style={{marginBottom:".9rem"}}>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:6}}>Incident Type</label>
                <div style={{display:"flex",gap:".6rem"}}>
                  {[["BREAKDOWN"," Breakdown","rgba(217,119,6,0.08)","#d97706","#d97706"],["ACCIDENT","🚑 Accident","#fff1f2","#dc2626","#dc2626"]].map(([val,label,bg,border,col])=>(
                    <button key={val} onClick={()=>setIncidentForm(p=>({...p,type:val}))}
                      style={{flex:1,padding:".6rem",borderRadius:8,border:"2px solid",borderColor:incidentForm.type===val?border:"#e4e7ed",background:incidentForm.type===val?bg:"#f2f4f7",color:incidentForm.type===val?col:"#6b7280",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".9rem",fontWeight:600,cursor:"pointer",transition:"all .12s"}}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
              {/* Notes */}
              <div style={{marginBottom:".9rem"}}>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#111827",marginBottom:4}}>Incident Details *</label>
                <textarea value={incidentForm.note} onChange={e=>setIncidentForm(p=>({...p,note:e.target.value}))} placeholder={incidentForm.type==="BREAKDOWN"?"Describe the breakdown — tyre burst, engine failure, etc.":"Describe the accident — location, severity, injuries if any…"} rows={3}
                  style={{width:"100%",background:"#f2f4f7",border:"1px solid var(--border)",color:"#111827",padding:".5rem .7rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontSize:".84rem",outline:"none",resize:"vertical"}}/>
              </div>
              <div style={{fontSize:".72rem",color:"#111827",marginBottom:".8rem"}}>
                The vehicle will be flagged with a red <strong>{incidentForm.type==="ACCIDENT"?"Accident":"Breakdown"}</strong> tag under its status until the incident is cleared.
              </div>
              <div style={{display:"flex",gap:".7rem"}}>
                <button onClick={markIncident} style={{flex:1,background:incidentForm.type==="ACCIDENT"?"#dc2626":"#d97706",color:"#ffffff",border:"none",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase"}}>
                  {incidentForm.type==="BREAKDOWN"?" Report Breakdown":"🚑 Report Accident"}
                </button>
                <button onClick={()=>{setIncidentModal(null);setIncidentForm({type:"BREAKDOWN",note:"",});}} style={{flex:1,background:"transparent",color:"#111827",border:"1px solid var(--border)",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
              </div>
            </div>
          </div>
        );
      })()}

      {tatModalLoadId && (() => {
        const l = loadById.get(String(tatModalLoadId)) ?? null;
        if (!l) return null;
        const av = l.vehicleId ? vehicleById.get(String(l.vehicleId)) ?? null : null;
        const tr = tatReasons[l.id] || { moving:null, expectedEta:"", reasons:[], comments:[] };
        const etaPassed = tr.moving === false && tr.expectedEta && new Date(tr.expectedEta).getTime() < Date.now();
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.65)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}} onClick={()=>setTatModalLoadId(null)}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.5rem",width:"100%",maxWidth:640,maxHeight:"90vh",overflowY:"auto",boxShadow:"0 12px 48px rgba(0,0,0,.7),0 0 0 1px var(--border)"}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:8,marginBottom:".7rem"}}>
                <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#d97706",letterSpacing:0,textTransform:"uppercase"}}> Delay Reason — {l.lid}</div>
                <button onClick={()=>setTatModalLoadId(null)} aria-label="Close" style={{background:"transparent",border:"1px solid var(--border)",color:"#111827",width:30,height:30,borderRadius:6,cursor:"pointer",fontSize:"1rem",lineHeight:1}}>✕</button>
              </div>
              <div style={{background:"rgba(217,119,6,0.08)",border:"1px solid rgba(245,158,11,0.4)",borderRadius:6,padding:".625rem .75rem",marginBottom:".8rem",fontSize:".78rem",color:"#6366f1"}}>
                <strong>{l.customer||"—"}</strong> · {l.origin||"—"} → {l.dest||"—"}
                {av && <span> · Vehicle <strong>{av.vnum}</strong> ({av.driver||"—"})</span>}
                <div style={{fontSize:".68rem",color:"#6b7280",marginTop:3}}>Edits sync live with the TAT Tracker.</div>
              </div>
              <TatReasonPanel
                loadId={l.id}
                state={tr}
                types={TAT_REASON_TYPES}
                etaPassed={etaPassed}
                onMoving={(val)=>updateTatReason(l.id, c=>({...c, moving:val, expectedEta: val===true ? "" : c.expectedEta }))}
                onEta={(val)=>updateTatReason(l.id, c=>({...c, expectedEta:val}))}
                onAdd={(type, hours)=>addTatReason(l.id, type, hours)}
                showComments={true}
                comments={tr.comments || []}
                onAddComment={(text)=>addTatComment(l.id, text)}
                onRemoveComment={(cid)=>removeTatComment(l.id, cid)}
                onEditComment={(cid,text)=>editTatComment(l.id, cid, text)}
              />
              {/* Selected reason chips quick view */}
              {(tr.reasons && tr.reasons.length > 0) && (
                <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:".8rem",paddingTop:".7rem",borderTop:"1px dashed var(--border)"}}>
                  {tr.reasons.map(rr => {
                    const t = TAT_REASON_TYPES.find(x=>x.id===rr.type);
                    return (
                      <span key={rr.id} style={{display:"inline-flex",alignItems:"center",gap:6,background:"rgba(99,102,241,0.08)",border:"1px solid #6366f1",color:"#6366f1",padding:"3px 9px",borderRadius:12,fontSize:".72rem",fontWeight:600}}>
                        <span>{t?.icon}</span>
                        <span>{t?.label||rr.type}</span>
                        {rr.hours!=null && <span style={{background:"#ffffff",border:"1px solid #6366f1",borderRadius:8,padding:"0 6px",fontFamily:"'Inter',system-ui,sans-serif",fontSize:".68rem"}}>{rr.hours}h</span>}
                        <button onClick={()=>removeTatReason(l.id, rr.id)} aria-label="Remove" style={{background:"transparent",border:"none",color:"#6366f1",fontSize:".9rem",cursor:"pointer",padding:0,lineHeight:1}}>✕</button>
                      </span>
                    );
                  })}
                </div>
              )}
              <div style={{marginTop:"1rem",display:"flex",justifyContent:"flex-end"}}>
                <button onClick={()=>setTatModalLoadId(null)} style={{background:"#374151",color:"#ffffff",border:"none",padding:".55rem 1.2rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase",letterSpacing:0}}>Done</button>
              </div>
            </div>
          </div>
        );
      })()}


      {sflModal && (() => {
        const v = vehicles.find(x=>x.id===sflModal.vehicleId);
        const explicitLoad = sflModal.loadId ? loadById.get(String(sflModal.loadId)) ?? null : null;
        const aLoad = explicitLoad || (v?.loadId ? loadById.get(String(v.loadId)) ?? null : null);
        const ps = sflModal.pendingStatus || "SENT_FOR_LOADING";
        const cfg = ps === "DELIVERED"
          ? { title:" Mark Delivered", emoji:"", color:"#059669", bg:"rgba(22,163,74,0.08)", border:"#6ee7b7", label:"Delivery Date & Time *", help:"This delivery timestamp will be saved on the vehicle and load.", btn:"#059669", btnLabel:"CONFIRM DELIVERY" }
          : ps === "AT_LOADING"
          ? { title:" At Loading", emoji:"", color:"#d97706", bg:"rgba(217,119,6,0.08)", border:"#d97706", label:"Expected Loading Completion *", help:"This ETA tracks when loading is expected to finish.", btn:"#d97706", btnLabel:"CONFIRM & SET ETA" }
          : { title:"Sent For Loading", emoji:"", color:"#6366f1", bg:"rgba(99,102,241,0.08)", border:"#c4b5fd", label:"Expected Arrival / Loading ETA *", help:"This ETA will be saved on the vehicle and synced to the Load Board delivery date.", btn:"#6366f1", btnLabel:"CONFIRM & SET ETA" };
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>{setSflModal(null);setSflEta("");}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.8rem",width:"92%",maxWidth:460,boxShadow:"0 12px 40px rgba(0,0,0,.18)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:cfg.color,letterSpacing:0,textTransform:"uppercase",marginBottom:".5rem"}}>{cfg.title}</div>
              <div style={{background:cfg.bg,border:`1px solid ${cfg.border}`,borderRadius:8,padding:".6rem .9rem",marginBottom:"1.1rem",fontSize:".84rem",color:cfg.color}}>
                <strong>{v?.vnum}</strong> ({v?.vtype}) · Driver: <strong>{v?.driver}</strong>
                {aLoad && <div style={{marginTop:3,fontSize:".78rem"}}>Load: <strong>{aLoad.lid}</strong> · {aLoad.origin} → {aLoad.dest}</div>}
              </div>
              <div style={{marginBottom:"1.1rem"}}>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>
                  📅 {cfg.label}
                </label>
                <DateTimeField value={sflEta} onChange={setSflEta} accentBorder={cfg.border} accentColor={sflEta?cfg.color:"#6b7280"} />
                <div style={{fontSize:".72rem",color:"#6b7280",marginTop:5}}>{cfg.help}</div>
              </div>
              <div style={{display:"flex",gap:".7rem"}}>
                <button onClick={()=>{
                  if (!sflEta) { alert("Please set a date and time before confirming."); return; }
                  applyVStatus(sflModal.vehicleId, ps, sflEta, sflModal.loadId || null);
                  setSflModal(null); setSflEta("");
                }} style={{flex:1,background:cfg.btn,color:"#ffffff",border:"none",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase",letterSpacing:0}}>
                  {cfg.btnLabel}
                </button>
                <button onClick={()=>{setSflModal(null);setSflEta("");}} style={{flex:1,background:"transparent",color:"#6b7280",border:"1px solid var(--border)",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ══ LR DATE MODAL (On Trip) ══ */}
      {lrModal && (() => {
        const v = vehicles.find(x=>x.id===lrModal.vehicleId);
        const aLoad = v?.loadId ? loadById.get(String(v.loadId)) ?? null : null;
        return (
          <div style={{position:"fixed",inset:0,background:"rgba(15,23,42,.6)",zIndex:300,display:"flex",alignItems:"center",justifyContent:"center"}} onClick={()=>{setLrModal(null);setLrDateInput("");}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#ffffff",border:"1px solid var(--border)",borderRadius:12,padding:"1.8rem",width:"92%",maxWidth:460,boxShadow:"0 12px 40px rgba(0,0,0,.18)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#2563eb",letterSpacing:0,textTransform:"uppercase",marginBottom:".5rem"}}>🚚 Mark On Trip — LR Date</div>
              <div style={{background:"rgba(37,99,235,0.08)",border:"1px solid #2563eb",borderRadius:8,padding:".625rem .75rem",marginBottom:"1.1rem",fontSize:".84rem",color:"#2563eb"}}>
                <strong>{v?.vnum}</strong> ({v?.vtype}) · Driver: <strong>{v?.driver}</strong>
                {aLoad && <div style={{marginTop:3,fontSize:".78rem"}}>Load: <strong>{aLoad.lid}</strong> · {aLoad.origin} → {aLoad.dest}</div>}
              </div>
              <div style={{marginBottom:"1.1rem"}}>
                <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>📅 LR Date *</label>
                <PrettyDate value={lrDateInput} onChange={setLrDateInput} style={{padding:".625rem .75rem",fontSize:".9rem"}}/>
                <div style={{fontSize:".72rem",color:"#6b7280",marginTop:5}}>Used to anchor TAT target delivery date (15:00 IST + TAT days).</div>
              </div>
              <div style={{display:"flex",gap:".7rem"}}>
                <button onClick={confirmLR} style={{flex:1,background:"#2563eb",color:"#ffffff",border:"none",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase",letterSpacing:0}}>CONFIRM & ON TRIP</button>
                <button onClick={()=>{setLrModal(null);setLrDateInput("");}} style={{flex:1,background:"transparent",color:"#6b7280",border:"1px solid var(--border)",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>CANCEL</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* See more — load details dialog */}
      {seeMoreLoadId && (() => {
        const l = loads.find(x => x.id === seeMoreLoadId);
        if (!l) return null;
        const av = vehicles.find(v => v.id === l.vehicleId);
        const g = av ? (gpsMap[gpsVehicleKey(av.vnum)] || gpsMap[gpsVehicleKeyAlt(av.vnum)]) : null;
        const tat = computeTat(l, av, cityCoords, gpsMap);
        return (
          <Suspense fallback={null}>
            <LoadDetailsDialog
              load={l}
              vehicle={av}
              gps={g}
              eta={av?.eta}
              targetDelivery={tat.targetAt}
              etaComputed={tat.arrivalAt}
              onClose={() => setSeeMoreLoadId(null)}
            />
          </Suspense>
        );

      })()}

      {/* Consignee delivered date picker modal */}
      {cdModal && (() => {
        const l = loads.find(x => x.id === cdModal.loadId);
        const cons = Array.isArray(l?.consignees) ? l.consignees.filter(Boolean) : [];
        const city = cons[cdModal.index] || "—";
        return (
          <div onClick={()=>{setCdModal(null);setCdDateTime("");}} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
            <div onClick={e=>e.stopPropagation()} style={{background:"#ffffff",borderRadius:12,maxWidth:420,width:"100%",padding:"1.4rem",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
              <div style={{fontFamily:"'Inter',system-ui,sans-serif",fontSize:"1rem",fontWeight:600,color:"#16a34a",letterSpacing:0,textTransform:"uppercase",marginBottom:".5rem"}}>📅 Delivered Date & Time</div>
              <div style={{background:"rgba(22,163,74,0.08)",border:"1px solid #16a34a",borderRadius:8,padding:".625rem .75rem",marginBottom:"1rem",fontSize:".84rem",color:"#16a34a"}}>
                Load <strong>{l?.lid}</strong> · Consignee #{cdModal.index+1} · <strong>{city}</strong>
              </div>
              <label style={{display:"block",fontSize:".68rem",fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,letterSpacing:0,textTransform:"uppercase",color:"#6b7280",marginBottom:6}}>Delivered At *</label>
              <PrettyDateTime value={cdDateTime} onChange={setCdDateTime} style={{padding:".625rem .75rem",fontSize:".9rem"}}/>
              <div style={{display:"flex",gap:".7rem",marginTop:"1.2rem"}}>
                <button onClick={confirmConsigneeDelivered} style={{flex:1,background:"#16a34a",color:"#ffffff",border:"none",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".9rem",cursor:"pointer",textTransform:"uppercase",letterSpacing:0}}>Confirm Delivered</button>
                <button onClick={()=>{setCdModal(null);setCdDateTime("");}} style={{flex:1,background:"transparent",color:"#6b7280",border:"1px solid var(--border)",padding:".65rem",borderRadius:6,fontFamily:"'Inter',system-ui,sans-serif",fontWeight:600,fontSize:".84rem",cursor:"pointer",textTransform:"uppercase"}}>Cancel</button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* PIN modal */}
      {pinModal && (
        <div onClick={()=>setPinModal(null)} style={{position:"fixed",inset:0,background:"rgba(15,23,42,0.55)",zIndex:200,display:"flex",alignItems:"center",justifyContent:"center",padding:"1rem"}}>
          <div onClick={e=>e.stopPropagation()} style={{background:"#ffffff",borderRadius:12,maxWidth:380,width:"100%",padding:"1.4rem",boxShadow:"0 20px 60px rgba(0,0,0,0.3)"}}>
            <div style={{display:"flex",alignItems:"center",gap:".5rem",marginBottom:".6rem"}}>
              <KeyRound size={18} color="#2563eb"/>
              <div style={{fontWeight:600,fontSize:"1rem",color:"#111827"}}>Set Driver PIN</div>
            </div>
            <div style={{fontSize:".78rem",color:"#6b7280",marginBottom:".9rem"}}>For vehicle <strong style={{color:"#111827"}}>{pinModal.vnum}</strong> · driver <strong style={{color:"#111827"}}>{pinModal.driver || "—"}</strong>. The driver will use this 4-digit PIN to log into the Drivers app.</div>
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              maxLength={4}
              value={pinInput}
              onChange={e => setPinInput(e.target.value.replace(/\D/g,"").slice(0,4))}
              placeholder="••••"
              autoFocus
              style={{width:"100%",fontSize:"1.2rem",letterSpacing:".5rem",textAlign:"center",padding:".7rem",border:"1px solid var(--border2)",borderRadius:8,fontFamily:"var(--font-mono,monospace)",outline:"none",marginBottom:"1rem"}}
            />
            <div style={{display:"flex",gap:".5rem"}}>
              <button
                onClick={async ()=>{
                  if (pinInput.length !== 4) { alert("PIN must be exactly 4 digits."); return; }
                  setPinSaving(true);
                  try {
                    await setVehiclePin(pinModal.vnum, pinInput);
                    setPinModal(null); setPinInput("");
                  } catch (e) {
                    alert("PIN was not saved to cloud. Please try again. " + (e?.message || e));
                  } finally {
                    setPinSaving(false);
                  }
                }}
                disabled={pinSaving}
                style={{flex:1,background:"#2563eb",color:"#ffffff",border:"none",padding:".6rem",borderRadius:6,fontWeight:600,fontSize:".84rem",cursor:"pointer",letterSpacing:0,textTransform:"uppercase"}}
              >{pinSaving ? "Saving..." : "Save PIN"}</button>
              {getPin(pinModal.vnum) && (
                <button disabled={pinSaving} onClick={async ()=>{ setPinSaving(true); try { await setVehiclePin(pinModal.vnum, null); setPinModal(null); setPinInput(""); } catch (e) { alert("PIN was not cleared from cloud. Please try again. " + (e?.message || e)); } finally { setPinSaving(false); } }} style={{background:"rgba(220,38,38,0.08)",color:"#dc2626",border:"1px solid rgba(220,38,38,0.08)",padding:".625rem .75rem",borderRadius:6,fontWeight:600,fontSize:".78rem",cursor:"pointer"}}>Clear</button>
              )}
              <button onClick={()=>{setPinModal(null);setPinInput("");}} style={{background:"transparent",color:"#6b7280",border:"1px solid var(--border2)",padding:".625rem .75rem",borderRadius:6,fontWeight:600,fontSize:".78rem",cursor:"pointer"}}>Cancel</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );

}
