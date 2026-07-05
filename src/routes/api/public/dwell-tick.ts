import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// ── Dwell-geofence tick ──────────────────────────────────────────────────────
// Runs every 15 min (pg_cron). Pulls live fleet GPS and observes ALL vehicles
// against the custom dwell zones (app_dwell_observe_batch). Server-side so the
// >12h dwell alerts fire even when no browser tab is open. SEPARATE from the
// existing geofence system. Mirrors stoppage-tick's structure.

const FLEETX_BASE          = "https://api.fleetx.io/api/v1";
const DEFAULT_FLEETX_TOKEN = "9f2d823b-5eda-4033-99e0-637ae43a5363";
const DEFAULT_SUPABASE_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";

// GPS older than this ⇒ treat as not-reporting (don't open/close on stale data).
const STALE_MS = 45 * 60 * 1000;

type LiveVehicle = {
  vehicleNumber?: string;
  vehicleId?: number;
  latitude?: number;
  longitude?: number;
  speed?: number;
  address?: string;
  lastUpdatedAt?: number;
};

function normalizeVnum(v: string): string {
  return String(v || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
}

async function fetchFleetxLive(token: string): Promise<LiveVehicle[]> {
  const statuses = "RUNNING,IDLE,PARKED,DISCONNECTED,UNREACHABLE,STOPPED,OFFLINE,NO_DATA";
  const size = 2000;
  const out: LiveVehicle[] = [];
  const seen = new Set<number>();
  for (let page = 0; page < 20; page++) {
    const url = `${FLEETX_BASE}/analytics/live?page=${page}&size=${size}&status=${encodeURIComponent(statuses)}`;
    const res = await fetch(url, { headers: { Authorization: `bearer ${token}` } });
    if (!res.ok) {
      if (page === 0) throw new Error(`Fleetx live ${res.status}`);
      break;
    }
    const data = (await res.json()) as { vehicles?: LiveVehicle[] };
    const batch = data.vehicles || [];
    for (const v of batch) {
      const id = v.vehicleId ?? -1;
      const key = id >= 0 ? id : -(out.length + 1);
      if (!seen.has(key)) { seen.add(key); out.push(v); }
    }
    if (batch.length < size) break;
  }
  return out;
}

export const Route = createFileRoute("/api/public/dwell-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ── Auth ──────────────────────────────────────────────────────────────
        const expected = process.env.CRON_SECRET || "";
        const provided = request.headers.get("x-cron-secret") || "";
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        // ── Supabase (service role) ───────────────────────────────────────────
        const supaUrl    = process.env.TMS_SUPABASE_URL || process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
        const serviceKey = process.env.TMS_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
        if (!serviceKey) return Response.json({ error: "missing service role key" }, { status: 500 });
        const supabase = createClient(supaUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const fleetxToken = process.env.FLEETX_TOKEN || DEFAULT_FLEETX_TOKEN;
        if (!fleetxToken) return Response.json({ error: "missing fleetx token" }, { status: 500 });

        const now = Date.now();

        // ── 0. Any active zones at all? If none, skip the FleetX pull entirely. ─
        const { data: zoneRows, error: zErr } = await supabase
          .from("dwell_zones").select("id").eq("active", true).limit(1);
        if (zErr) return Response.json({ error: "zone check failed", detail: zErr.message }, { status: 500 });
        if (!zoneRows || zoneRows.length === 0) {
          return Response.json({ ok: true, ts: new Date(now).toISOString(), observed: 0, note: "no active zones" });
        }

        // ── 1. All vehicles (id + vnum) — dwell applies to EVERY vehicle. ──────
        const { data: vRows, error: vErr } = await supabase
          .from("vehicles").select("id, vnum, data");
        if (vErr) return Response.json({ error: "vehicle fetch failed", detail: vErr.message }, { status: 500 });

        const vByNorm = new Map<string, { id: string; vnum: string }>();
        for (const r of (vRows || [])) {
          const vnum = (r.data || {}).vnum || r.vnum || null;
          if (!vnum) continue;
          vByNorm.set(normalizeVnum(vnum), { id: String(r.id), vnum: String(vnum) });
        }

        // ── 2. Live GPS ───────────────────────────────────────────────────────
        let live: LiveVehicle[];
        try {
          live = await fetchFleetxLive(fleetxToken);
        } catch (e) {
          return Response.json({ error: "fleetx fetch failed", detail: (e as Error).message }, { status: 502 });
        }

        // ── 3. Build samples (keyed by vehicle_id) and observe in one round-trip.
        const samples: any[] = [];
        for (const lv of live) {
          if (!lv.vehicleNumber) continue;
          const match = vByNorm.get(normalizeVnum(lv.vehicleNumber));
          if (!match) continue;
          const seenAtMs = Number(lv.lastUpdatedAt || 0);
          const isStale = !seenAtMs || (now - seenAtMs) > STALE_MS;
          samples.push({
            vehicle_id: match.id,
            vnum: match.vnum,
            lat: isStale ? null : (lv.latitude ?? null),
            lng: isStale ? null : (lv.longitude ?? null),
            stale: isStale,
          });
        }

        if (!samples.length) {
          return Response.json({ ok: true, ts: new Date(now).toISOString(), observed: 0, note: "no matched vehicles" });
        }

        const { data: batchRes, error: batchErr } = await supabase.rpc(
          "app_dwell_observe_batch", { p_samples: samples, p_threshold_hours: 12 });
        if (batchErr) {
          return Response.json({ error: "dwell observe failed", detail: batchErr.message }, { status: 500 });
        }

        return Response.json({ ok: true, ts: new Date(now).toISOString(), ...(batchRes as any) });
      },
    },
  },
});
