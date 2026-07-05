// ─────────────────────────────────────────────────────────────────────────────
// transitions.ts — single source of truth for geofence-driven status decisions.
//
// PURE / RUNTIME-NEUTRAL. No React, no Supabase, no ambient clock. `now` is
// injected; GPS is passed in as a map. The browser (Tms.jsx geofence useEffect)
// AND both crons (arrival-tick, left-unloading-tick) are meant to import THIS,
// so the rules can no longer drift between runtimes.
//
// This module only DECIDES. It returns an action + the fields a committer must
// write. It never writes. Execution + legality + atomicity remain the job of
// app_vehicle_transition (the DB engine). Each decider's `fields` are exactly
// what the engine's "auto" mode will need to merge.
//
// Fixes baked in vs the three legacy copies (see DRIFT-REPORT.md):
//   FIX #4  — ONE canonical GPS normaliser (gpsVehicleKey + …Alt). left-unloading
//             -tick previously used a weaker `normaliseVnum` that stranded trucks.
//   FIX #5  — CANCELLED is terminal everywhere (was guarded only as DELIVERED in
//             the client geofence path, which could resurrect a cancelled load).
//   UNIFY #2 — the 500 km sanity cap (MAX_PLAUSIBLE_LEFT_KM) is applied to the
//             left-unloading flag in ALL runtimes (cron had it; client didn't).
//   UNIFY    — leftUnloadingFromKm stores RAW distance-from-dest consistently
//             (client code did; cron stored km-past-boundary).
// ─────────────────────────────────────────────────────────────────────────────

// ── Constants (identical across all three legacy copies — verified) ──────────
export const UNLOAD_RADIUS_KM = 80;
export const UNLOAD_EXIT_BUFFER_KM = 120; // demote threshold = 200 km from dest
export const MIN_UNLOAD_DWELL_MS = 4 * 60 * 60 * 1000; // 4 h
export const MAX_PLAUSIBLE_LEFT_KM = 500;
export const GPS_FRESH_MS = 30 * 60 * 1000; // 30 min
export const NEAR_DEST_KM = 70;

const TERMINAL = new Set(["DELIVERED", "CANCELLED"]); // FIX #5: CANCELLED is terminal
export function isTerminal(lstatus: unknown): boolean {
  return TERMINAL.has(String(lstatus));
}

// ── Geo (verbatim from the canonical copy) ───────────────────────────────────
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ── GPS normalisation — THE single canonical scheme (FIX #4) ─────────────────
export function gpsVehicleKey(vnum: string): string {
  return String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "").replace(/(AIS|GPS|VTS)$/, "");
}
export function gpsVehicleKeyAlt(vnum: string): string {
  const s = String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length > 10 ? s.slice(-10) : s;
}
export type GpsSample = { lat: number; lng: number; updatedAt: number };
export type GpsMap = Map<string, GpsSample>;

/** Resolve a vehicle's live GPS, trying raw / key / alt forms. ONE lookup used everywhere. */
export function lookupGps(gpsMap: GpsMap, vnum: string): GpsSample | null {
  const raw = String(vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
  for (const k of Array.from(new Set([raw, gpsVehicleKey(vnum), gpsVehicleKeyAlt(vnum)].filter(Boolean)))) {
    if (gpsMap.has(k)) return gpsMap.get(k)!;
  }
  return null;
}

/** Build a gpsMap from Fleetx rows using the SAME canonical keys the lookup uses. */
export function buildGpsMap(
  rows: Array<{ vnum: string; lat: number; lng: number; updatedAt: number }>,
): GpsMap {
  const m: GpsMap = new Map();
  for (const r of rows) {
    if (r.lat == null || r.lng == null || !r.vnum) continue;
    // Ignore a known duplicate/junk FleetX entry that collides on the alt-key
    // (its last-10 chars equal a real vnum), so it can't overwrite real GPS.
    if (String(r.vnum || "").toUpperCase().replace(/[^A-Z0-9]/g, "") === "NEWHR55AG3660") continue;
    const sample = { lat: r.lat, lng: r.lng, updatedAt: r.updatedAt };
    const k = gpsVehicleKey(r.vnum);
    const kAlt = gpsVehicleKeyAlt(r.vnum);
    if (k) m.set(k, sample);
    if (kAlt && kAlt !== k) m.set(kAlt, sample);
  }
  return m;
}

// ── City coords ──────────────────────────────────────────────────────────────
export type CityCoords = Record<string, { lat: number; lng: number } | undefined>;
function coordFor(cityCoords: CityCoords, city: string): { lat: number; lng: number } | null {
  const key = String(city || "").trim().toLowerCase();
  const c = key ? cityCoords[key] : undefined;
  return c && c.lat != null && c.lng != null ? { lat: c.lat, lng: c.lng } : null;
}

// ── Time stamps (kept identical to the geofence path; see note for Leg 2) ────
// NOTE: the client geofence path stamps atUnloadingAt as IST + 2 h travel buffer,
// minute precision. The DB engine's `ist_min` is plain IST-now. When Leg 2 wires
// the crons through the engine, reconcile these two (this module is authoritative).
function istEntryStamp(now: number): string {
  return new Date(now + 7.5 * 60 * 60 * 1000).toISOString().slice(0, 16);
}
function isoStamp(now: number): string {
  return new Date(now).toISOString();
}

// ── Shapes ───────────────────────────────────────────────────────────────────
export type Vehicle = {
  id: string; vnum: string; vstatus: string;
  destination?: string; atUnloadingAt?: string | null; loadId?: string | null;
};
export type Load = {
  id: string; lid?: string; vehicleId?: string;
  lstatus: string; dest?: string; origin?: string;
  manualUnloadOverride?: boolean;
  unloadEnterAt?: number | null; minDestDistKm?: number | null;
  leftUnloadingAt?: number | null; leftUnloadingAck?: boolean;
};

export type Decision =
  | { action: "SKIP"; reason: string; minUpdate?: number | null }
  | {
      action: "AT_UNLOADING" | "IN_TRANSIT" | "AVAILABLE";
      reason: string;
      distKm?: number;
      flag?: boolean;
      minUpdate?: number | null;
      vehicleFields: Record<string, unknown>;
      loadFields?: Record<string, unknown>;
    };

const skip = (reason: string, minUpdate?: number | null): Decision =>
  ({ action: "SKIP", reason, ...(minUpdate != null ? { minUpdate } : {}) });

// ── 1. ARRIVAL: IN_TRANSIT → AT_UNLOADING ────────────────────────────────────
export function decideArrival(ctx: {
  vehicle: Vehicle; load: Load | null | undefined;
  gpsMap: GpsMap; cityCoords: CityCoords; now: number;
}): Decision {
  const { vehicle: v, load: ld, gpsMap, cityCoords, now } = ctx;

  // Admission: normally IN_TRANSIT only. ALSO admit an AVAILABLE vehicle whose
  // attached load is positively running (ASSIGNED/IN_TRANSIT/AT_UNLOADING) — the
  // late-marking handover case: prior load delivered late, queued load promoted,
  // vehicle left AVAILABLE while its new load is already active. QUEUED/PENDING
  // loads do NOT qualify (AVAILABLE + queued is a legal waiting state).
  const activeLoad =
    !!ld && ["ASSIGNED", "IN_TRANSIT", "AT_UNLOADING"].includes(String(ld.lstatus));
  if (v.vstatus !== "IN_TRANSIT" && !(v.vstatus === "AVAILABLE" && activeLoad)) {
    return skip("vehicle_not_in_transit");
  }
  if (!ld) return skip("no_active_load");
  if (isTerminal(ld.lstatus)) return skip("load_terminal"); // FIX #5 (DELIVERED *or* CANCELLED)
  if (ld.manualUnloadOverride) return skip("manual_override");

  const dest = ld.dest || v.destination || "";
  if (!dest) return skip("no_dest");
  const destCoord = coordFor(cityCoords, dest);
  if (!destCoord) return skip("dest_not_geocoded");

  const gps = lookupGps(gpsMap, v.vnum); // FIX #4: single normaliser
  if (!gps) return skip("no_gps");

  const distKm = haversineKm(gps.lat, gps.lng, destCoord.lat, destCoord.lng);
  if (!isFinite(distKm) || distKm > UNLOAD_RADIUS_KM) return skip("outside_radius");

  // Never re-promote a flagged-but-unacknowledged load (the client guard the cron lacked).
  if (ld.leftUnloadingAt && !ld.leftUnloadingAck) return skip("left_unload_pending");

  // Short-haul: if origin→dest < radius, the geofence covers the whole route.
  const origCoord = coordFor(cityCoords, ld.origin || "");
  if (origCoord) {
    const odKm = haversineKm(origCoord.lat, origCoord.lng, destCoord.lat, destCoord.lng);
    if (isFinite(odKm) && odKm < UNLOAD_RADIUS_KM) return skip("short_haul");
  }

  const seedMin = isFinite(distKm) ? distKm : null;
  const curMin = ld.minDestDistKm != null && isFinite(Number(ld.minDestDistKm)) ? Number(ld.minDestDistKm) : Infinity;
  const nextMin = seedMin != null ? Math.min(seedMin, curMin) : ld.minDestDistKm ?? null;

  return {
    action: "AT_UNLOADING",
    reason: "within_radius",
    distKm,
    vehicleFields: {
      vstatus: "AT_UNLOADING",
      destination: dest,
      atUnloadingAt: v.atUnloadingAt || istEntryStamp(now),
    },
    loadFields: {
      lstatus: "AT_UNLOADING",
      manualUnloadOverride: false, // AUTO semantics — do NOT freeze auto rules (unlike engine's manual mode)
      // Late-marking convergence: if the load is ALREADY AT_UNLOADING (vehicle was
      // lagging behind it), keep the original dwell entry — never restart the clock.
      unloadEnterAt:
        String(ld.lstatus) === "AT_UNLOADING" && ld.unloadEnterAt != null
          ? ld.unloadEnterAt
          : now,
      minDestDistKm: nextMin != null && isFinite(Number(nextMin)) ? nextMin : ld.minDestDistKm ?? null,
    },
  };
}

// ── 2. LEFT-UNLOADING: AT_UNLOADING → IN_TRANSIT (flag or silent) ─────────────
export function decideLeftUnloading(ctx: {
  vehicle: Vehicle; load: Load; gpsMap: GpsMap; cityCoords: CityCoords; now: number;
}): Decision {
  const { vehicle: v, load: ld, gpsMap, cityCoords, now } = ctx;

  if (ld.manualUnloadOverride) return skip("manual_override");
  if (isTerminal(ld.lstatus)) return skip("load_terminal");

  const dest = ld.dest || "";
  const destCoord = coordFor(cityCoords, dest);
  if (!destCoord) return skip("dest_not_geocoded");

  const gps = lookupGps(gpsMap, v.vnum); // FIX #4
  if (!gps) return skip("no_gps");

  const distKm = haversineKm(gps.lat, gps.lng, destCoord.lat, destCoord.lng);

  // #3: continuous min-distance refinement, emitted regardless of demote.
  let minUpdate: number | null = null;
  if (isFinite(distKm)) {
    const curMin = ld.minDestDistKm != null && isFinite(Number(ld.minDestDistKm)) ? Number(ld.minDestDistKm) : Infinity;
    if (distKm < curMin - 0.5) minUpdate = distKm;
  }

  if (!(isFinite(distKm) && distKm > UNLOAD_RADIUS_KM + UNLOAD_EXIT_BUFFER_KM)) {
    return skip("inside_exit_buffer", minUpdate);
  }

  // Beyond 200 km → demote. Decide whether to record a "left unloading" flag.
  const gpsFresh = now - gps.updatedAt <= GPS_FRESH_MS;
  const sane = distKm <= MAX_PLAUSIBLE_LEFT_KM; // UNIFY #2: cap applied in all runtimes
  const dwellOk = ld.unloadEnterAt != null && now - Number(ld.unloadEnterAt) >= MIN_UNLOAD_DWELL_MS;
  const effectiveMin = minUpdate != null ? Math.min(minUpdate, ld.minDestDistKm ?? Infinity) : ld.minDestDistKm;
  const cameCloseOk = effectiveMin != null && isFinite(Number(effectiveMin)) && Number(effectiveMin) <= NEAR_DEST_KM;
  const flag = gpsFresh && sane && dwellOk && cameCloseOk;

  const vehicleFields = { vstatus: "IN_TRANSIT", atUnloadingAt: null };
  const baseLoad = { lstatus: "IN_TRANSIT", unloadEnterAt: null, minDestDistKm: null };
  const loadFields = flag
    ? {
        ...baseLoad,
        leftUnloadingAt: now,
        leftUnloadingFromKm: Math.round(distKm), // UNIFY: raw distance-from-dest
        leftUnloadingDest: dest,
        leftUnloadingAck: false,
      }
    : baseLoad;

  return {
    action: "IN_TRANSIT",
    reason: flag ? "left_unloading_flagged" : "left_unloading_silent",
    flag,
    distKm,
    minUpdate,
    vehicleFields,
    loadFields,
  };
}

// ── 3. ORPHAN-FREE: busy vehicle whose load is positively DELIVERED → AVAILABLE
// Conservative (the Jun-27 lesson): free ONLY when loadId resolves to a load we
// can SEE is DELIVERED. Never free on mere absence.
export function decideOrphanFree(ctx: {
  vehicle: Vehicle; vehicleLoads: Load[]; loadById: Map<string, Load>; now: number;
}): Decision {
  const { vehicle: v, vehicleLoads, loadById, now } = ctx;
  if (!["IN_TRANSIT", "AT_LOADING", "SENT_FOR_LOADING"].includes(v.vstatus)) return skip("not_busy");

  const active = vehicleLoads.find((l) => !isTerminal(l.lstatus));
  if (active) return skip("has_active_load");
  if (!v.loadId) return skip("no_load_ref");

  const ref = loadById.get(String(v.loadId));
  if (!ref || ref.lstatus !== "DELIVERED") return skip("ref_not_delivered"); // DELIVERED-only, by design

  return {
    action: "AVAILABLE",
    reason: "load_done",
    vehicleFields: {
      vstatus: "AVAILABLE",
      loadId: null,
      availableSince: isoStamp(now),
      availableAfterDelivery: true,
      sentForLoadingAt: null,
      atLoadingAt: null,
      atUnloadingAt: null,
      waitingClearEta: null,
      sentLoadingClearEta: null,
      atLoadingClearEta: null,
    },
  };
}
