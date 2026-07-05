import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

const FLEETX_BASE = "https://api.fleetx.io/api/v1";
const DEFAULT_FLEETX_TOKEN = "9f2d823b-5eda-4033-99e0-637ae43a5363";

type LiveVehicle = {
  vehicleNumber?: string;
  vehicleId?: number;
  latitude?: number;
  longitude?: number;
  speed?: number;
  heading?: number;
  currentStatus?: string;
  status?: string;
  address?: string;
};

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

export const Route = createFileRoute("/api/public/gps-snapshot")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CRON_SECRET || "";
        const provided = request.headers.get("x-cron-secret") || "";
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const supaUrl =
          process.env.TMS_SUPABASE_URL ||
          process.env.SUPABASE_URL ||
          "https://xkuxizypbrzzkugjnquw.supabase.co";
        const serviceKey =
          process.env.TMS_SUPABASE_SERVICE_ROLE_KEY ||
          process.env.SUPABASE_SERVICE_ROLE_KEY ||
          "";
        if (!serviceKey) {
          return Response.json({ error: "missing service role key" }, { status: 500 });
        }
        const supabase = createClient(supaUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const fleetxToken = process.env.FLEETX_TOKEN || DEFAULT_FLEETX_TOKEN;
        const now = new Date();
        const capturedAt = now.toISOString();

        let vehicles: LiveVehicle[] = [];
        try {
          vehicles = await fetchFleetxLive(fleetxToken);
        } catch (e) {
          return Response.json(
            { error: "fleetx fetch failed", detail: (e as Error).message },
            { status: 502 },
          );
        }

        const rows = vehicles
          .filter(
            (v) =>
              v.latitude != null &&
              v.longitude != null &&
              isFinite(v.latitude) &&
              isFinite(v.longitude) &&
              (v.vehicleNumber || v.vehicleId != null),
          )
          .map((v) => ({
            vehicle_number: (v.vehicleNumber || String(v.vehicleId)).toUpperCase(),
            lat: v.latitude!,
            lng: v.longitude!,
            speed: typeof v.speed === "number" ? v.speed : null,
            heading: typeof v.heading === "number" ? v.heading : null,
            status: v.currentStatus || v.status || null,
            address: v.address || null,
            captured_at: capturedAt,
          }));

        let inserted = 0;
        if (rows.length) {
          const CHUNK = 500;
          for (let i = 0; i < rows.length; i += CHUNK) {
            const slice = rows.slice(i, i + CHUNK);
            const { error } = await supabase.from("gps_hourly").insert(slice);
            if (error) {
              return Response.json(
                { error: "insert failed", detail: error.message, inserted },
                { status: 500 },
              );
            }
            inserted += slice.length;
          }
        }

        // Purge rows older than 22 days
        const cutoff = new Date(now.getTime() - 22 * 24 * 60 * 60 * 1000).toISOString();
        const { error: delErr, count: deleted } = await supabase
          .from("gps_hourly")
          .delete({ count: "exact" })
          .lt("captured_at", cutoff);
        if (delErr) {
          return Response.json(
            { ok: true, inserted, purgeError: delErr.message, ts: capturedAt },
            { status: 200 },
          );
        }

        return Response.json({
          ok: true,
          inserted,
          deleted: deleted ?? 0,
          vehicles: vehicles.length,
          ts: capturedAt,
        });
      },
    },
  },
});
