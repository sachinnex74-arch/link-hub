import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// ── Stoppage detection tick ──────────────────────────────────────────────────
// Runs every 15 min (pg_cron). Pulls live fleet GPS, decides fresh-vs-stale per
// vehicle, resolves each vehicle's current load, and calls app_stoppage_observe
// (the proven detection RPC). Detection state + halt history live in Postgres.
// Mirrors arrival-tick's structure (auth, fleetx pull, service-role client).

const FLEETX_BASE          = "https://api.fleetx.io/api/v1";
const DEFAULT_FLEETX_TOKEN = "9f2d823b-5eda-4033-99e0-637ae43a5363";
const DEFAULT_SUPABASE_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";

// A GPS report older than this (ms) => treat the vehicle as "not reporting"
// (stale/dead-zone) so we don't open a false halt. 45 min > the 15-min tick so a
// single missed FleetX update doesn't flip a moving truck to "stale".
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

// Mirror of the app's vnum normaliser (uppercase, strip separators) so FleetX
// numbers match TMS vnums regardless of spacing/format.
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

export const Route = createFileRoute("/api/public/stoppage-tick")({
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

        // ── 1. Active vehicles (vnum + current load link) ─────────────────────
        // We only track vehicles that are in service (have a load / are moving),
        // to avoid churning halt rows for parked-idle trucks with no trip.
        const { data: vRows, error: vErr } = await supabase
          .from("vehicles")
          .select("id, vnum, data");
        if (vErr) return Response.json({ error: "vehicle fetch failed", detail: vErr.message }, { status: 500 });

        // Map: normalized vnum → { vehicleId, currentLoadId }
        const vByNorm = new Map<string, { id: string; loadId: string | null }>();
        for (const r of (vRows || [])) {
          const vnum = (r.data || {}).vnum || r.vnum || null;
          if (!vnum) continue;
          const loadId = (r.data || {}).loadId || null;
          vByNorm.set(normalizeVnum(vnum), { id: String(r.id), loadId: loadId ? String(loadId) : null });
        }

        // ── 2. Live GPS ───────────────────────────────────────────────────────
        let live: LiveVehicle[];
        try {
          live = await fetchFleetxLive(fleetxToken);
        } catch (e) {
          return Response.json({ error: "fleetx fetch failed", detail: (e as Error).message }, { status: 502 });
        }

        // ── 3. Build one batch of samples, observe in a SINGLE round-trip ─────
        const samples: any[] = [];
        for (const lv of live) {
          if (!lv.vehicleNumber) continue;
          const norm = normalizeVnum(lv.vehicleNumber);
          const match = vByNorm.get(norm);
          if (!match) continue; // not a TMS-tracked vehicle
          const seenAtMs = Number(lv.lastUpdatedAt || 0);
          const isStale = !seenAtMs || (now - seenAtMs) > STALE_MS;
          samples.push({
            vnum: norm,
            speed: isStale ? null : Number(lv.speed ?? 0),
            lat: isStale ? null : (lv.latitude ?? null),
            lng: isStale ? null : (lv.longitude ?? null),
            address: lv.address ?? null,
            load_id: match.loadId,
            seen_at: new Date(seenAtMs || now).toISOString(),
            stale: isStale,
          });
        }

        if (!samples.length) {
          return Response.json({ ok: true, ts: new Date(now).toISOString(), observed: 0, note: "no matched vehicles" });
        }

        const { data: batchRes, error: batchErr } = await supabase.rpc("app_stoppage_observe_batch", { p_samples: samples });
        if (batchErr) {
          return Response.json({ error: "observe batch failed", detail: batchErr.message }, { status: 500 });
        }

        return Response.json({ ok: true, ts: new Date(now).toISOString(), ...(batchRes as any) });
      },
    },
  },
});
