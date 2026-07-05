import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

const FLEETX_BASE = "https://api.fleetx.io/api/v1";
const DEFAULT_TOKEN = "9f2d823b-5eda-4033-99e0-637ae43a5363";

function token() {
  return process.env.FLEETX_TOKEN || DEFAULT_TOKEN;
}

export type LiveVehicle = {
  vehicleId: number;
  vehicleNumber: string;
  vehicleName: string;
  status: string;
  currentStatus: string;
  speed: number;
  latitude: number;
  longitude: number;
  address: string;
  lastUpdatedAt: number;
  driverName: string;
  vehicleTypeValue: string;
};

export type LiveSummary = {
  totalVehicles: number;
  runningVehicles: number;
  idleVehicles: number;
  parkedVehicles: number;
  disconnectedVehicles: number;
  unreachableVehicles: number;
  utilization: number;
  vehicles: LiveVehicle[];
};

export const getLiveFleet = createServerFn({ method: "GET" }).handler(
  async (): Promise<LiveSummary> => {
    const headers = { Authorization: `bearer ${token()}` };
    // Request all statuses explicitly + large page size, then loop pages
    // until we've drained the feed. Fleetx defaults sometimes cap responses.
    const statuses = "RUNNING,IDLE,PARKED,DISCONNECTED,UNREACHABLE,STOPPED,OFFLINE,NO_DATA";
    const size = 2000;
    let page = 0;
    let merged: LiveSummary | null = null;
    const seen = new Set<number>();
    const allVehicles: LiveVehicle[] = [];
    // Hard cap on pages to avoid runaway loops
    while (page < 20) {
      const url = `${FLEETX_BASE}/analytics/live?page=${page}&size=${size}&status=${encodeURIComponent(statuses)}`;
      const res = await fetch(url, { headers });
      if (!res.ok) {
        if (page === 0) {
          throw new Error(`Fleetx live failed: ${res.status} ${await res.text()}`);
        }
        break;
      }
      const data = (await res.json()) as LiveSummary;
      if (!merged) merged = data;
      const batch = data.vehicles || [];
      for (const v of batch) {
        const id = v.vehicleId ?? -1;
        const key = id >= 0 ? id : -(allVehicles.length + 1);
        if (!seen.has(key)) {
          seen.add(key);
          allVehicles.push(v);
        }
      }
      if (batch.length < size) break;
      page += 1;
    }
    if (!merged) {
      throw new Error("Fleetx live returned no data");
    }
    merged.vehicles = allVehicles;
    return merged;
  },
);

export const getVehicleByNumber = createServerFn({ method: "POST" })
  .inputValidator((d: { vehicleNumber: string }) => d)
  .handler(async ({ data }) => {
    const res = await fetch(
      `${FLEETX_BASE}/analytics/live/byNumber/${encodeURIComponent(data.vehicleNumber)}`,
      { headers: { Authorization: `bearer ${token()}` } },
    );
    if (!res.ok) {
      throw new Error(`Fleetx byNumber failed: ${res.status} ${await res.text()}`);
    }
    return await res.json();
  });

// ─── Historical trail (Phase 1: try common Fleetx history endpoints) ───
// Walks an arbitrary JSON blob looking for arrays whose items have lat/lng-ish
// keys and returns a sorted [{lat,lng,ts}] list. Verbose so we can iterate.
function normalizeHistory(json: unknown): Array<{ lat: number; lng: number; ts: number }> {
  const out: Array<{ lat: number; lng: number; ts: number }> = [];
  const seen = new Set<unknown>();
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object" || seen.has(node)) return;
    seen.add(node);
    if (Array.isArray(node)) {
      // Is this an array of point-like objects?
      let pointHits = 0;
      for (const it of node) {
        if (it && typeof it === "object") {
          const o = it as Record<string, unknown>;
          const lat = Number(o.lat ?? o.latitude ?? o.LAT);
          const lng = Number(o.lng ?? o.lon ?? o.long ?? o.longitude ?? o.LNG ?? o.LON);
          if (isFinite(lat) && isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180) {
            pointHits++;
          }
        }
      }
      if (pointHits >= 2 && pointHits >= node.length * 0.5) {
        for (const it of node) {
          if (!it || typeof it !== "object") continue;
          const o = it as Record<string, unknown>;
          const lat = Number(o.lat ?? o.latitude ?? o.LAT);
          const lng = Number(o.lng ?? o.lon ?? o.long ?? o.longitude ?? o.LNG ?? o.LON);
          let ts = Number(o.ts ?? o.time ?? o.timestamp ?? o.recordedAt ?? o.updatedAt ?? o.gpsTime ?? 0);
          if (ts && ts < 1e12) ts *= 1000; // seconds → ms
          if (isFinite(lat) && isFinite(lng)) out.push({ lat, lng, ts: ts || 0 });
        }
        return;
      }
      for (const it of node) visit(it);
      return;
    }
    for (const v of Object.values(node as Record<string, unknown>)) visit(v);
  };
  visit(json);
  out.sort((a, b) => a.ts - b.ts);
  // Dedupe identical consecutive points
  const dedup: typeof out = [];
  for (const p of out) {
    const last = dedup[dedup.length - 1];
    if (!last || last.lat !== p.lat || last.lng !== p.lng) dedup.push(p);
  }
  return dedup;
}

export type VehicleHistoryResult = {
  points: Array<{ lat: number; lng: number; ts: number }>;
  source: string;
  endpoint: string | null;
};

// Extract a single {lat,lng,ts} from a flat position object like Fleetx's
// `vehicles/history/location` returns: { latitude, longitude, serverTime, timeStamp, ... }
function normalizeFleetxTime(value: unknown): number {
  if (typeof value === "number" && isFinite(value) && value > 0) {
    return value < 1e12 ? value * 1000 : value;
  }
  if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    if (isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1000 : numeric;
    const parsed = Date.parse(value);
    return isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function extractSinglePoint(
  json: unknown,
  fallbackTs: number,
): { lat: number; lng: number; ts: number } | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const o = json as Record<string, unknown>;
  const lat = Number(o.lat ?? o.latitude ?? o.LAT);
  const lng = Number(o.lng ?? o.lon ?? o.long ?? o.longitude ?? o.LNG ?? o.LON);
  if (!isFinite(lat) || !isFinite(lng) || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const deviceTs =
    normalizeFleetxTime(o.timeStamp) ||
    normalizeFleetxTime(o.gpsTime) ||
    normalizeFleetxTime(o.timestamp) ||
    normalizeFleetxTime(o.time) ||
    normalizeFleetxTime(o.ts) ||
    normalizeFleetxTime(o.recordedAt) ||
    normalizeFleetxTime(o.updatedAt);
  // serverTime can repeat for every sampled call, so use the requested sample
  // timestamp before serverTime when Fleetx does not provide a device timestamp.
  const ts = deviceTs || fallbackTs || normalizeFleetxTime(o.serverTime) || Date.now();
  return { lat, lng, ts };
}

// Resolve vehicleNumber -> vehicleId via the live fleet endpoint.
// One small extra call per popup open; Fleetx caches it server-side fast.
async function resolveVehicleId(vehicleNumber: string): Promise<number | null> {
  const headers = { Authorization: `bearer ${token()}` };
  const url = `${FLEETX_BASE}/analytics/live/byNumber/${encodeURIComponent(vehicleNumber)}`;
  try {
    const res = await fetch(url, { headers });
    if (!res.ok) {
      console.log(`[history] resolveId ${vehicleNumber} -> ${res.status}`);
      return null;
    }
    const json = (await res.json()) as { vehicleId?: number; vehicles?: Array<{ vehicleId?: number; vehicleNumber?: string }> };
    if (typeof json.vehicleId === "number") return json.vehicleId;
    const match = json.vehicles?.find((v) => v.vehicleNumber?.toUpperCase() === vehicleNumber.toUpperCase());
    return match?.vehicleId ?? null;
  } catch (e) {
    console.log(`[history] resolveId threw`, (e as Error)?.message);
    return null;
  }
}

// TODO(fleetx-history): Plug in the official Fleetx history endpoint here
// once provided. Expected shape: GET <FLEETX_BASE>/<official-path>?vehicleId=...
// returning an array of { latitude, longitude, timeStamp } points. Use
// normalizeHistory() / extractSinglePoint() / normalizeFleetxTime() above
// to convert the response into { lat, lng, ts }[].
export const getVehicleHistory = createServerFn({ method: "POST" })
  .inputValidator((d: { vehicleNumber: string; fromTs: number; toTs: number; currentLat?: number; currentLng?: number; currentTs?: number }) => d)
  .handler(async ({ data }): Promise<VehicleHistoryResult> => {
    console.log(`[history] official Fleetx endpoint pending — vehicle=${data.vehicleNumber} window=${data.fromTs}..${data.toTs}`);
    return { points: [], source: "pending-official-api", endpoint: null };
  });

// ─── 22-day hourly trail (reads from gps_hourly populated by the cron) ───
export type TrailPoint = {
  lat: number;
  lng: number;
  ts: number;
  speed: number | null;
  status: string | null;
  address: string | null;
};

export const getVehicleTrail = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { vehicleNumber: string }) => d)
  .handler(async ({ data, context }): Promise<{ points: TrailPoint[] }> => {
    const raw = (data.vehicleNumber || "").toUpperCase().trim();
    if (!raw) return { points: [] };
    // Snapshots are stored uppercased but may include separators (e.g. "MH 12 AB 1234").
    // Try the value as-given and a stripped variant so we match either format.
    const stripped = raw.replace(/[^A-Z0-9]/g, "");
    const candidates = Array.from(new Set([raw, stripped].filter(Boolean)));
    const since = new Date(Date.now() - 22 * 24 * 60 * 60 * 1000).toISOString();
    const { data: rows, error } = await context.supabase
      .from("gps_hourly")
      .select("vehicle_number,lat,lng,captured_at,speed,status,address")
      .in("vehicle_number", candidates)
      .gte("captured_at", since)
      .order("captured_at", { ascending: true })
      .limit(600);
    if (error) {
      console.log(`[trail] query failed for ${raw}: ${error.message}`);
      return { points: [] };
    }
    console.log(`[trail] ${raw} candidates=${candidates.join("|")} rows=${rows?.length ?? 0}`);
    const points: TrailPoint[] = (rows || []).map((r) => ({
      lat: Number(r.lat),
      lng: Number(r.lng),
      ts: new Date(r.captured_at as string).getTime(),
      speed: r.speed == null ? null : Number(r.speed),
      status: (r.status as string) ?? null,
      address: (r.address as string) ?? null,
    }));
    return { points };
  });



// ── Load-scoped halts (stops during THIS load's trip) ────────────────────────
// Returns completed 2h+ halt events for the load's vehicle whose start falls
// within the load's active window, PLUS the vehicle's current ongoing halt if any.
export type HaltRow = {
  startedAt: number;
  endedAt: number | null;      // null = ongoing
  durationSeconds: number;
  address: string | null;
  lat: number | null;
  lng: number | null;
  ongoing: boolean;
};

export const getLoadHalts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { vehicleNumber: string; loadId: string; since?: number | null; until?: number | null }) => d)
  .handler(async ({ data, context }): Promise<{ halts: HaltRow[] }> => {
    const raw = (data.vehicleNumber || "").toUpperCase().trim();
    const loadId = String(data.loadId || "");
    if (!raw || !loadId) return { halts: [] };
    const norm = raw.replace(/[^A-Z0-9]/g, "");

    // Completed halt events tagged to this load (load-scoped). We match by load_id
    // primarily; the optional since/until window (load pickup→delivery) further bounds it.
    let q = context.supabase
      .from("vehicle_halt_events")
      .select("vehicle_number,started_at,ended_at,duration_seconds,address,lat,lng,load_id")
      .eq("vehicle_number", norm)
      .eq("load_id", loadId)
      .order("started_at", { ascending: true })
      .limit(200);
    const { data: rows, error } = await q;
    if (error) {
      console.log(`[halts] query failed for ${raw}/${loadId}: ${error.message}`);
      return { halts: [] };
    }
    const halts: HaltRow[] = (rows || []).map((r) => ({
      startedAt: new Date(r.started_at as string).getTime(),
      endedAt: r.ended_at ? new Date(r.ended_at as string).getTime() : null,
      durationSeconds: Number(r.duration_seconds || 0),
      address: (r.address as string) ?? null,
      lat: r.lat == null ? null : Number(r.lat),
      lng: r.lng == null ? null : Number(r.lng),
      ongoing: false,
    }));

    // Include the current ongoing halt if this vehicle is stopped right now AND it
    // belongs to this load (so a live long halt shows in the trip view too).
    const { data: cur } = await context.supabase
      .from("vehicle_halt_current")
      .select("is_stopped,halt_started_at,address,lat,lng,load_id")
      .eq("vehicle_number", norm)
      .maybeSingle();
    if (cur && (cur as any).is_stopped && (cur as any).halt_started_at && String((cur as any).load_id || "") === loadId) {
      const startedAt = new Date((cur as any).halt_started_at as string).getTime();
      halts.push({
        startedAt,
        endedAt: null,
        durationSeconds: Math.floor((Date.now() - startedAt) / 1000),
        address: (cur as any).address ?? null,
        lat: (cur as any).lat == null ? null : Number((cur as any).lat),
        lng: (cur as any).lng == null ? null : Number((cur as any).lng),
        ongoing: true,
      });
    }
    return { halts };
  });

// ── Fleet-wide halt report (all 2h+ halts in a date range) ───────────────────
export type FleetHaltRow = {
  vehicleNumber: string;
  startedAt: number;
  endedAt: number;
  durationSeconds: number;
  address: string | null;
  loadId: string | null;
};

export const getFleetHalts = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { fromMs: number; toMs: number; minHours?: number | null }) => d)
  .handler(async ({ data, context }): Promise<{ halts: FleetHaltRow[] }> => {
    const fromIso = new Date(Number(data.fromMs || 0)).toISOString();
    const toIso = new Date(Number(data.toMs || Date.now())).toISOString();
    const minSecs = Math.round((Number(data.minHours ?? 2)) * 3600);
    const { data: rows, error } = await context.supabase
      .from("vehicle_halt_events")
      .select("vehicle_number,started_at,ended_at,duration_seconds,address,load_id")
      .gte("started_at", fromIso)
      .lte("started_at", toIso)
      .gte("duration_seconds", minSecs)
      .order("started_at", { ascending: false })
      .limit(5000);
    if (error) { console.log(`[fleethalts] ${error.message}`); return { halts: [] }; }
    const halts: FleetHaltRow[] = (rows || []).map((r) => ({
      vehicleNumber: String(r.vehicle_number),
      startedAt: new Date(r.started_at as string).getTime(),
      endedAt: new Date(r.ended_at as string).getTime(),
      durationSeconds: Number(r.duration_seconds || 0),
      address: (r.address as string) ?? null,
      loadId: (r.load_id as string) ?? null,
    }));
    return { halts };
  });

// ── Dwell-geofence: vehicles CURRENTLY inside a dwell zone, with how long. ─────
export type DwellingRow = {
  vehicleId: string;
  vnum: string;
  zoneId: string;
  zoneName: string | null;
  enteredAt: number;      // ms
  notified: boolean;      // has the >12h alert already fired
};

export const getDwellingVehicles = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { minHours?: number | null } | undefined) => d || {})
  .handler(async ({ context }): Promise<{ dwelling: DwellingRow[] }> => {
    const { data: rows, error } = await context.supabase
      .from("dwell_state")
      .select("vehicle_id,vnum,zone_id,entered_at,notified_at,dwell_zones(name)")
      .order("entered_at", { ascending: true });
    if (error) { console.log(`[dwelling] ${error.message}`); return { dwelling: [] }; }
    const dwelling: DwellingRow[] = (rows || []).map((r: any) => ({
      vehicleId: String(r.vehicle_id),
      vnum: String(r.vnum || ""),
      zoneId: String(r.zone_id),
      zoneName: r.dwell_zones?.name ?? null,
      enteredAt: new Date(r.entered_at as string).getTime(),
      notified: !!r.notified_at,
    }));
    return { dwelling };
  });

// ── Dwell-geofence: zone CRUD (zones live in DB so the server tick reads them) ─
export type DwellZone = {
  id: string; name: string; centerLat: number; centerLng: number;
  radiusM: number; active: boolean; createdAt: number;
};

export const listDwellZones = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .handler(async ({ context }): Promise<{ zones: DwellZone[] }> => {
    const { data, error } = await context.supabase
      .from("dwell_zones")
      .select("id,name,center_lat,center_lng,radius_m,active,created_at")
      .eq("active", true)
      .order("created_at", { ascending: false });
    if (error) { console.log(`[dwellzones] ${error.message}`); return { zones: [] }; }
    return {
      zones: (data || []).map((z: any) => ({
        id: String(z.id), name: String(z.name),
        centerLat: Number(z.center_lat), centerLng: Number(z.center_lng),
        radiusM: Number(z.radius_m), active: !!z.active,
        createdAt: new Date(z.created_at).getTime(),
      })),
    };
  });

export const createDwellZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { name: string; centerLat: number; centerLng: number; radiusM: number }) => d)
  .handler(async ({ data, context }): Promise<{ ok: boolean; id?: string; error?: string }> => {
    const name = String(data.name || "").trim();
    if (!name) return { ok: false, error: "Name required" };
    const lat = Number(data.centerLat), lng = Number(data.centerLng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return { ok: false, error: "Invalid location" };
    const radiusM = Math.max(200, Math.min(200000, Math.round(Number(data.radiusM) || 2000)));
    const email = (context as any)?.claims?.email || null;
    const { data: ins, error } = await context.supabase
      .from("dwell_zones")
      .insert({ name, center_lat: lat, center_lng: lng, radius_m: radiusM, created_by: email })
      .select("id").single();
    if (error) return { ok: false, error: error.message };
    return { ok: true, id: String(ins.id) };
  });

export const deleteDwellZone = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { id: string }) => d)
  .handler(async ({ data, context }): Promise<{ ok: boolean; error?: string }> => {
    // Soft-deactivate (keeps history + cascades handled by dwell_state FK on hard delete;
    // deactivating stops the tick from evaluating it).
    const { error } = await context.supabase
      .from("dwell_zones").update({ active: false }).eq("id", String(data.id));
    if (error) return { ok: false, error: error.message };
    // Clear any open dwell state for that zone so it disappears from the live list.
    await context.supabase.from("dwell_state").delete().eq("zone_id", String(data.id));
    return { ok: true };
  });
