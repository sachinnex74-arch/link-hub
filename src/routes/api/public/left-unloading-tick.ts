import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { loadRowFor, vehicleRowFor } from "@/lib/tms.functions";
import { decideLeftUnloading, buildGpsMap } from "@/lib/transitions";

// Rules (radius / buffers / dwell / normaliser / guards) now live in one place:
// src/lib/transitions.ts. This cron fetches inputs, calls the decider, and
// commits via app_vehicle_transition (engine).

const FLEETX_BASE        = "https://api.fleetx.io/api/v1";
const DEFAULT_FLEETX_TOKEN = "9f2d823b-5eda-4033-99e0-637ae43a5363";
const DEFAULT_SUPABASE_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";

// ─── Geo helpers now imported from src/lib/transitions.ts ────────────────────

// ─── Fleetx ──────────────────────────────────────────────────────────────────
type LiveVehicle = {
  vehicleNumber?: string;
  vehicleId?: number;
  latitude?: number;
  longitude?: number;
  lastUpdatedAt?: number; // epoch ms from Fleetx
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



// ─── Route ───────────────────────────────────────────────────────────────────
export const Route = createFileRoute("/api/public/left-unloading-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ── Auth ──────────────────────────────────────────────────────────────
        const expected = process.env.CRON_SECRET || "";
        const provided  = request.headers.get("x-cron-secret") || "";
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        // ── Supabase (service role — needs to write loads) ────────────────────
        const supaUrl    = process.env.TMS_SUPABASE_URL || process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
        const serviceKey = process.env.TMS_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
        if (!serviceKey) {
          return Response.json({ error: "missing service role key" }, { status: 500 });
        }
        const supabase = createClient(supaUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const now = Date.now();

        // ── 1. Pull AT_UNLOADING loads from Supabase ──────────────────────────
        // Loads are stored as { id, lid, data: { ...allFields } }
        // We only want loads where data->>'lstatus' = 'AT_UNLOADING' and
        // data->>'manualUnloadOverride' is not true.
        const { data: loadRows, error: loadErr } = await supabase
          .from("loads")
          .select("id, lid, data")
          .eq("data->>lstatus", "AT_UNLOADING");

        if (loadErr) {
          return Response.json({ error: "load fetch failed", detail: loadErr.message }, { status: 500 });
        }

        const loads = (loadRows || [])
          .map((r: any) => ({ id: r.id, lid: r.lid, ...(r.data || {}) }))
          .filter((l: any) =>
            // Skip manual overrides — user explicitly froze this status
            !l.manualUnloadOverride &&
            // Skip already flagged but unacknowledged (don't double-stamp)
            !l.leftUnloadingAt &&
            // Must have a destination to geocode against
            !!l.dest &&
            // Must have dwell tracking started
            !!l.unloadEnterAt
          );

        if (!loads.length) {
          return Response.json({ ok: true, message: "no eligible AT_UNLOADING loads", flagged: 0, ts: new Date(now).toISOString() });
        }

        // ── 2. Pull city coords from app_settings ─────────────────────────────
        const { data: coordRow } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "tms.cityCoords")
          .maybeSingle();

        const cityCoords: Record<string, { lat: number; lng: number }> = coordRow?.value || {};
        // Built-in fallback (matches DEFAULT_CITY_COORDS in Tms.jsx)
        if (!cityCoords["lucknow"]) cityCoords["lucknow"] = { lat: 26.8467, lng: 80.9462 };

        // Phase 1: writes commit through app_vehicle_transition (engine) only.
        // The legacy direct-RPC path was removed; the cron.useEngine toggle is retired.

        // ── 3. Fetch live GPS from Fleetx ─────────────────────────────────────
        let gpsVehicles: LiveVehicle[] = [];
        try {
          gpsVehicles = await fetchFleetxLive(process.env.FLEETX_TOKEN || DEFAULT_FLEETX_TOKEN);
        } catch (e) {
          return Response.json({ error: "fleetx fetch failed", detail: (e as Error).message }, { status: 502 });
        }

        // Build the GPS lookup map using the ONE canonical normaliser (FIX #4).
        const gpsMap = buildGpsMap(
          gpsVehicles
            .filter((v) => v.latitude != null && v.longitude != null)
            .map((v) => ({
              vnum: v.vehicleNumber || String(v.vehicleId || ""),
              lat:  v.latitude as number,
              lng:  v.longitude as number,
              updatedAt: typeof v.lastUpdatedAt === "number" && v.lastUpdatedAt > 1e9 ? v.lastUpdatedAt : now,
            })),
        );

        // ── 4. Pull vehicles table for vnum lookup ────────────────────────────
        // Loads store vehicleId; we need the vnum to look up GPS.
        const vehicleIds = [...new Set(loads.map((l: any) => l.vehicleId).filter(Boolean))];
        let vehicleMap = new Map<string, string>(); // vehicleId -> vnum
        let vehicleFull = new Map<string, any>();    // vehicleId -> { id, vnum, data }
        if (vehicleIds.length) {
          const { data: vRows } = await supabase
            .from("vehicles")
            .select("id, vnum, data")
            .in("id", vehicleIds);
          for (const r of (vRows || [])) {
            vehicleMap.set(String(r.id), r.vnum || "");
            vehicleFull.set(String(r.id), r);
          }
        }

        // ── 5. Evaluate each load ─────────────────────────────────────────────
        const flagged: string[] = [];
        const silent:  string[] = [];
        // Each entry is an atomic pair: the load row, and its vehicle row (or
        // null when the vehicle isn't AT_UNLOADING and shouldn't be touched).
        const writes: Array<{ loadRow: any; vehRow: any | null }> = [];
        const engineDemotes: any[] = []; // for the engine (app_vehicle_transition auto) path

        for (const load of loads as any[]) {
          // Defensive guard: never touch a terminal load (filter above should already exclude).
          if (load.lstatus === "DELIVERED" || load.lstatus === "CANCELLED") continue;

          const vnum = vehicleMap.get(String(load.vehicleId)) || "";
          if (!vnum) continue;
          const vFull = vehicleFull.get(String(load.vehicleId));

          // Single source of truth: the module decides demote + flag (normaliser,
          // exit buffer, dwell, sanity cap, came-close, terminal guards).
          const vehicleForDecide = {
            id: String(load.vehicleId), vnum,
            vstatus: (vFull?.data?.vstatus) || "AT_UNLOADING",
          } as any;
          const decision = decideLeftUnloading({ vehicle: vehicleForDecide, load, gpsMap, cityCoords, now });

          if (decision.action !== "IN_TRANSIT") continue; // SKIP (inside buffer / no gps / manual / terminal)

          // Demote. loadFields already carry lstatus + (if flagged) leftUnloading*
          // fields + cleared dwell trackers. Merge into the existing blob.
          const updatedData = { ...load, ...decision.loadFields };
          const { id: _id, ...dataBlob } = updatedData;
          const mergedData = { ...dataBlob, updatedAt: new Date(now).toISOString() };
          const loadRow = loadRowFor(String(load.id), load.lid, mergedData, new Date(now).toISOString());

          // Move the VEHICLE to IN_TRANSIT too (only if it's currently AT_UNLOADING),
          // so the client reconciler doesn't revert the load on alert dismissal.
          let vehRow: any | null = null;
          if (vFull && vFull.data && vFull.data.vstatus === "AT_UNLOADING") {
            const vData = { ...(vFull.data || {}), ...decision.vehicleFields, updatedAt: new Date(now).toISOString() };
            vehRow = vehicleRowFor(String(load.vehicleId), vFull.vnum || vData.vnum || null, vData, new Date(now).toISOString());
          }
          writes.push({ loadRow, vehRow });
          engineDemotes.push({
            vehicleId: String(load.vehicleId), loadId: String(load.id), lid: load.lid,
            vehicleFields: decision.vehicleFields, loadFields: decision.loadFields,
          });
          if (decision.flag) flagged.push(load.lid || load.id);
          else               silent.push(load.lid || load.id);
        }

        // ── 6. Write each flagged load + its vehicle ATOMICALLY ───────────────
        // Pairs (load + vehicle) go through app_write_pair so both move together
        // or neither does — no partial drift. Loads with no vehicle change go
        // through app_write_load. Both bump version and maintain mirror columns.
        // p_base_version:null keeps the cron's "always apply" intent.
        // p_enforce:true — the RPC REFUSES (changes nothing) if the load has
        // meanwhile become DELIVERED, preventing a demote from resurrecting a
        // just-delivered load. The only transition this cron makes is
        // AT_UNLOADING -> IN_TRANSIT, which always passes the guard, so enforce
        // can only ever reject the delivery-race case. Rejections land in
        // `rejected` so they're visible, not silent.
        let wrote = 0;
        const rejected: any[] = [];

        {  // engine-only (Phase 1: legacy app_write_pair / app_write_load path removed)
          // ENGINE PATH: commit each demote through app_vehicle_transition (auto mode).
          // The engine's legality guard may REJECT (e.g. another active load on the
          // vehicle); rejects land in `rejected` so they're visible, never silent.
          for (const d of engineDemotes) {
            const { data: res, error } = await supabase.rpc("app_vehicle_transition", {
              p_vehicle_id:       d.vehicleId,
              p_action:           "IN_TRANSIT",
              p_eta:              null,
              p_explicit_load_id: d.loadId,
              p_lr_date:          null,
              p_dry_run:          false,
              p_source:           "auto",
              p_extra:            { vehicle: d.vehicleFields, load: d.loadFields },
            });
            if (error) {
              return Response.json({ error: "engine demote failed", detail: error.message, flagged, wrote }, { status: 500 });
            }
            if (res && (res as any).ok === false) {
              rejected.push({ load: d.loadId, lid: d.lid, reason: (res as any).reason, blocking_lid: (res as any).blocking_lid });
              continue;
            }
            wrote++;
          }
        }

        // Observability: write a row you can read with a plain SELECT.
        {
          await supabase.from("app_settings").upsert({
            key: "cron.leftUnloadLastRun",
            value: { ts: new Date(now).toISOString(), demoted: wrote, rejected: rejected.length, rejectedDetail: rejected },
            updated_at: new Date(now).toISOString(),
          }, { onConflict: "key" });
        }

        return Response.json({
          ok:         true,
          engine:     true,
          checked:    loads.length,
          flagged:    flagged.length - rejected.length,
          flaggedIds: flagged,
          silent:     silent.length,
          rejected:   rejected.length,
          rejectedDetail: rejected,
          ts:         new Date(now).toISOString(),
        });
      },
    },
  },
});
