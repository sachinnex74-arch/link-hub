import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// ─── Geo helpers (mirrors src/lib/geo.js, kept inline so this route has no
// client-only imports) ───────────────────────────────────────────────────────
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number) {
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Mirror of src/lib/geo.js normalizeVnum so the cron matches the browser's
// per-vehicle scope check exactly (strip spaces/dashes/underscores, uppercase).
function normalizeVnum(v: any) {
  return String(v || "").replace(/[\s\-_]/g, "").toUpperCase();
}

const FLEETX_BASE = "https://api.fleetx.io/api/v1";
const DEFAULT_FLEETX_TOKEN = "9f2d823b-5eda-4033-99e0-637ae43a5363";

const DEFAULT_SUPABASE_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";
const DEFAULT_SUPABASE_ANON = "sb_publishable_hwCaNkApKRONVrR-UyEyOg_bfuvCb7k";

const IDLE_MS = 60 * 60 * 1000; // 1 hour
const MOVE_THRESHOLD_M = 100;

type LiveVehicle = {
  vehicleNumber?: string;
  vehicleId?: number;
  latitude?: number;
  longitude?: number;
  lastUpdatedAt?: number;
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

export const Route = createFileRoute("/api/public/geofence-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const expected = process.env.CRON_SECRET || "";
        const provided = request.headers.get("x-cron-secret") || "";
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const supaUrl = process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
        const supaKey =
          process.env.SUPABASE_PUBLISHABLE_KEY ||
          process.env.SUPABASE_ANON_KEY ||
          DEFAULT_SUPABASE_ANON;
        const supabase = createClient(supaUrl, supaKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const fleetxToken = process.env.FLEETX_TOKEN || DEFAULT_FLEETX_TOKEN;
        const now = Date.now();

        // 1) Load geofences from app_settings
        const { data: settingRow, error: settingErr } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "tms.geofences")
          .maybeSingle();
        if (settingErr) {
          return Response.json({ error: "geofence load failed", detail: settingErr.message }, { status: 500 });
        }
        const geofences: Array<{ id: string; label: string; lat: number; lng: number; radiusKm: number }> =
          Array.isArray(settingRow?.value) ? settingRow!.value : [];
        if (geofences.length === 0) {
          return Response.json({ ok: true, message: "no geofences configured", vehicles: 0 });
        }

        // 2) Pull live fleet
        const vehicles = await fetchFleetxLive(fleetxToken);

        // 3) Load existing idle-state rows
        const { data: stateRows } = await supabase
          .from("vehicle_idle_state")
          .select("*");
        const stateById = new Map<string, any>((stateRows || []).map((r) => [r.vehicle_id, r]));

        // 4) Update idle state per vehicle (one row per vehicle: first_seen_at
        //    is the moment it parked within MOVE_THRESHOLD_M of its current
        //    position; reset whenever the vehicle moves further than that).
        const upserts: any[] = [];
        const vehicleSnapshot = new Map<string, { lat: number; lng: number; firstSeenAt: number }>();
        for (const v of vehicles) {
          if (v.latitude == null || v.longitude == null) continue;
          const id = v.vehicleNumber || String(v.vehicleId || "");
          if (!id) continue;
          const prev = stateById.get(id);
          let firstSeenAt = now;
          if (prev) {
            const d = distanceMeters(prev.lat, prev.lng, v.latitude, v.longitude);
            if (d <= MOVE_THRESHOLD_M) {
              firstSeenAt = new Date(prev.first_seen_at).getTime();
            }
          }
          vehicleSnapshot.set(id, { lat: v.latitude, lng: v.longitude, firstSeenAt });
          upserts.push({
            vehicle_id: id,
            lat: v.latitude,
            lng: v.longitude,
            first_seen_at: new Date(firstSeenAt).toISOString(),
            last_seen_at: new Date(now).toISOString(),
            status: v.currentStatus || v.status || null,
            address: v.address || null,
            updated_at: new Date(now).toISOString(),
          });
        }

        if (upserts.length) {
          // Chunk upserts to stay well under PostgREST payload limits
          const CHUNK = 500;
          for (let i = 0; i < upserts.length; i += CHUNK) {
            const slice = upserts.slice(i, i + CHUNK);
            const { error } = await supabase
              .from("vehicle_idle_state")
              .upsert(slice, { onConflict: "vehicle_id" });
            if (error) {
              return Response.json({ error: "state upsert failed", detail: error.message }, { status: 500 });
            }
          }
        }

        // 5) Load existing alerts so we can resolve / skip duplicates
        const { data: alertRows } = await supabase
          .from("geofence_alerts")
          .select("id,data");
        const alertById = new Map<string, any>(
          (alertRows || []).map((r) => [r.id, r.data || {}]),
        );

        // 6) Evaluate each (vehicle, geofence) pair
        const alertUpserts: any[] = [];
        let raised = 0;
        let resolved = 0;
        for (const [vehicleId, snap] of vehicleSnapshot) {
          for (const g of geofences) {
            if (g.lat == null || g.lng == null || !g.radiusKm) continue;
            // Per-vehicle scope: a geofence with a vehicleNo watches ONLY that
            // truck. Null vehicleNo = all vehicles. Mirrors geo.js so the cron
            // and the browser agree.
            if ((g as any).vehicleNo &&
                normalizeVnum((g as any).vehicleNo) !== normalizeVnum(vehicleId)) continue;
            const alertId = `${vehicleId}__${g.id}`;
            const dist = distanceMeters(snap.lat, snap.lng, g.lat, g.lng);
            const inside = dist <= g.radiusKm * 1000;
            const existing = alertById.get(alertId);

            if (!inside) {
              if (existing && !existing.resolvedAt) {
                const updated = { ...existing, resolvedAt: now, resolveReason: "left geofence" };
                alertUpserts.push({ id: alertId, data: updated, updated_at: new Date(now).toISOString() });
                resolved += 1;
              }
              continue;
            }

            const idleDuration = now - snap.firstSeenAt;
            if (idleDuration < IDLE_MS) continue;

            if (!existing) {
              const newAlert = {
                id: alertId,
                vehicleId,
                geofenceId: g.id,
                geofenceLabel: g.label,
                startedAt: snap.firstSeenAt,
                lastSeenAt: now,
                lat: snap.lat,
                lng: snap.lng,
              };
              alertUpserts.push({ id: alertId, data: newAlert, updated_at: new Date(now).toISOString() });
              raised += 1;
            } else if (!existing.resolvedAt) {
              const updated = { ...existing, lastSeenAt: now, lat: snap.lat, lng: snap.lng };
              alertUpserts.push({ id: alertId, data: updated, updated_at: new Date(now).toISOString() });
            } else {
              // Previously resolved; re-trigger with a fresh id
              const reId = `${alertId}__${now}`;
              const reAlert = {
                id: reId,
                vehicleId,
                geofenceId: g.id,
                geofenceLabel: g.label,
                startedAt: snap.firstSeenAt,
                lastSeenAt: now,
                lat: snap.lat,
                lng: snap.lng,
              };
              alertUpserts.push({ id: reId, data: reAlert, updated_at: new Date(now).toISOString() });
              raised += 1;
            }
          }
        }

        // Self-clean: resolve any OPEN alert that no longer has a valid basis —
        // its geofence was deleted, or the geofence is now scoped to a different
        // vehicle. Without this, deleting/re-scoping a geofence leaves its alerts
        // stuck open forever (the evaluate loop never revisits them).
        const gfById = new Map(geofences.map((g: any) => [g.id, g]));
        for (const [alertId, existing] of alertById) {
          if (!existing || existing.resolvedAt) continue;
          const g: any = gfById.get(existing.geofenceId);
          const stale =
            !g || (g.vehicleNo &&
              normalizeVnum(g.vehicleNo) !== normalizeVnum(existing.vehicleId));
          if (stale) {
            alertUpserts.push({
              id: alertId,
              data: { ...existing, resolvedAt: now,
                      resolveReason: !g ? "geofence deleted" : "vehicle re-scoped" },
              updated_at: new Date(now).toISOString(),
            });
            resolved += 1;
          }
        }

        if (alertUpserts.length) {
          const { error } = await supabase
            .from("geofence_alerts")
            .upsert(alertUpserts, { onConflict: "id" });
          if (error) {
            return Response.json({ error: "alert upsert failed", detail: error.message }, { status: 500 });
          }
        }

        return Response.json({
          ok: true,
          vehicles: vehicleSnapshot.size,
          geofences: geofences.length,
          raised,
          resolved,
          touched: alertUpserts.length,
          ts: new Date(now).toISOString(),
        });
      },
    },
  },
});
