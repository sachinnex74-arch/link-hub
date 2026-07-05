import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";
import { decideArrival, buildGpsMap } from "@/lib/transitions";

// Rules (radius / normaliser / guards) now live in one place: src/lib/transitions.ts.
// This cron fetches inputs, calls the decider, and commits via app_vehicle_transition (engine).

const FLEETX_BASE          = "https://api.fleetx.io/api/v1";
const DEFAULT_FLEETX_TOKEN = "9f2d823b-5eda-4033-99e0-637ae43a5363";
const DEFAULT_SUPABASE_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";

// ─── Fleetx ──────────────────────────────────────────────────────────────────
type LiveVehicle = {
  vehicleNumber?: string;
  vehicleId?: number;
  latitude?: number;
  longitude?: number;
  lastUpdatedAt?: number;
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
export const Route = createFileRoute("/api/public/arrival-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ── Auth ──────────────────────────────────────────────────────────────
        const expected = process.env.CRON_SECRET || "";
        const provided  = request.headers.get("x-cron-secret") || "";
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        // ── Supabase (service role — needs to write vehicles + loads) ─────────
        const supaUrl    = process.env.TMS_SUPABASE_URL || process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
        const serviceKey = process.env.TMS_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
        if (!serviceKey) {
          return Response.json({ error: "missing service role key" }, { status: 500 });
        }
        const supabase = createClient(supaUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const now = Date.now();

        // ── 1. Fetch eligible vehicles ────────────────────────────────────────
        // IN_TRANSIT (normal arrival) PLUS AVAILABLE-with-attached-load (the
        // late-marking handover: vehicle left AVAILABLE while its promoted load
        // is already running). The decider is the single gate — an AVAILABLE
        // vehicle only promotes if its load is positively ASSIGNED/IN_TRANSIT/
        // AT_UNLOADING and GPS is within the unload radius.
        const { data: vRows, error: vErr } = await supabase
          .from("vehicles")
          .select("id, vnum, data")
          .or("data->>vstatus.eq.IN_TRANSIT,and(data->>vstatus.eq.AVAILABLE,data->>loadId.not.is.null)");

        if (vErr) {
          return Response.json({ error: "vehicle fetch failed", detail: vErr.message }, { status: 500 });
        }

        const vehicles = (vRows || []).map((r: any) => ({
          id: r.id,
          vnum: (r.data || {}).vnum || r.vnum || null,  // vnum lives in data blob
          ...(r.data || {}),
        }));

        if (!vehicles.length) {
          return Response.json({ ok: true, message: "no eligible vehicles", promoted: 0, ts: new Date(now).toISOString() });
        }

        // ── 2. Fetch their active loads ───────────────────────────────────────
        const vehicleIds = vehicles.map((v: any) => v.id);
        const { data: loadRows, error: loadErr } = await supabase
          .from("loads")
          .select("id, lid, data")
          .neq("data->>lstatus", "DELIVERED")
          .neq("data->>lstatus", "CANCELLED")
          .in("data->>vehicleId", vehicleIds);

        if (loadErr) {
          return Response.json({ error: "load fetch failed", detail: loadErr.message }, { status: 500 });
        }

        // vehicleId → load map (one active load per vehicle)
        const loadByVehicle = new Map<string, any>();
        for (const r of (loadRows || [])) {
          const l = { id: r.id, lid: r.lid, ...(r.data || {}) };
          if (l.vehicleId && !loadByVehicle.has(String(l.vehicleId))) {
            loadByVehicle.set(String(l.vehicleId), l);
          }
        }

        // ── 3. Fetch city coords from app_settings ────────────────────────────
        const { data: coordRow } = await supabase
          .from("app_settings")
          .select("value")
          .eq("key", "tms.cityCoords")
          .maybeSingle();

        const cityCoords: Record<string, { lat: number; lng: number }> = coordRow?.value || {};
        if (!cityCoords["lucknow"]) cityCoords["lucknow"] = { lat: 26.8467, lng: 80.9462 };

        // Phase 1: writes commit through app_vehicle_transition (engine) only.
        // The legacy direct-RPC path was removed; the cron.useEngine toggle is retired.

        // ── 4. Fetch live GPS from Fleetx ─────────────────────────────────────
        let gpsVehicles: LiveVehicle[] = [];
        try {
          gpsVehicles = await fetchFleetxLive(process.env.FLEETX_TOKEN || DEFAULT_FLEETX_TOKEN);
        } catch (e) {
          return Response.json({ error: "fleetx fetch failed", detail: (e as Error).message }, { status: 502 });
        }

        const gpsMap = buildGpsMap(
          gpsVehicles.map((v) => ({
            vnum: v.vehicleNumber || String(v.vehicleId || ""),
            lat:  v.latitude as number,
            lng:  v.longitude as number,
            updatedAt: typeof v.lastUpdatedAt === "number" && v.lastUpdatedAt > 1e9 ? v.lastUpdatedAt : now,
          })),
        );

        // ── 5. Evaluate each IN_TRANSIT vehicle ───────────────────────────────
        const vehicleUpserts: any[] = [];
        const loadUpserts:    any[] = [];
        const enginePromotions: any[] = []; // for the engine (app_vehicle_transition auto) path
        const promoted: string[]    = [];
        const skipped:  string[]    = [];
        const rejected: any[]       = [];   // enforced rejects (server refused the promote)

        for (const vehicle of vehicles as any[]) {
          const ld = loadByVehicle.get(String(vehicle.id));

          // Single source of truth: the module decides (normaliser, radius,
          // short-haul, leftUnloadingAck, CANCELLED/DELIVERED terminal guards).
          const decision = decideArrival({ vehicle, load: ld, gpsMap, cityCoords, now });
          if (decision.action !== "AT_UNLOADING") { skipped.push(vehicle.vnum); continue; }

          // Safety guard: never upsert a vehicle with null/empty vnum — would corrupt the record
          const safeVnum = vehicle.vnum || null;
          if (!safeVnum) { skipped.push(vehicle.id + "(no-vnum)"); continue; }

          // For the engine path: keep the raw decided fields (engine merges them as p_extra).
          enginePromotions.push({
            vehicleId: String(vehicle.id), loadId: String(ld.id), vnum: safeVnum,
            vehicleFields: decision.vehicleFields, loadFields: decision.loadFields,
          });

          // ── Promote vehicle (merge decided fields into existing blob) ─────
          const updatedVehicle = { ...vehicle, ...decision.vehicleFields, updatedAt: new Date(now).toISOString() };
          // Only strip `id` — keep vnum inside the data blob so pullAll (which reads only
          // the data column) can reconstruct the vehicle number after a hydrate/realtime event.
          const { id: _vid, ...vehicleDataBlob } = updatedVehicle;
          vehicleUpserts.push({
            id:         String(vehicle.id),
            vnum:       safeVnum,
            data:       vehicleDataBlob,
            updated_at: new Date(now).toISOString(),
          });

          // ── Promote load (merge decided fields into existing blob) ────────
          const updatedLoad = { ...ld, ...decision.loadFields, updatedAt: new Date(now).toISOString() };
          // Keep lid INSIDE the data blob (belt-and-suspenders: readers also
          // fall back to the top-level lid column). Only strip id.
          const { id: _lid, ...loadDataBlob } = updatedLoad;
          loadUpserts.push({
            id:         String(ld.id),
            lid:        ld.lid,
            data:       loadDataBlob,
            updated_at: new Date(now).toISOString(),
          });

          promoted.push(vehicle.vnum);
        }

        // ── 6. Write ───────────────────────────────────────────────────────────
        {  // engine-only (Phase 1: legacy app_arrival_promote path removed)
          // ENGINE PATH: commit each promote through app_vehicle_transition (auto mode).
          // The engine's legality guard may REJECT (e.g. vehicle has another active
          // load); rejects land in `rejected` so they're visible, never silent.
          for (const p of enginePromotions) {
            const { data: res, error } = await supabase.rpc("app_vehicle_transition", {
              p_vehicle_id:       p.vehicleId,
              p_action:           "AT_UNLOADING",
              p_eta:              null,
              p_explicit_load_id: p.loadId,
              p_lr_date:          null,
              p_dry_run:          false,
              p_source:           "auto",
              p_extra:            { vehicle: p.vehicleFields, load: p.loadFields },
            });
            if (error) {
              return Response.json({ error: "engine transition failed", detail: error.message, promoted }, { status: 500 });
            }
            if (res && (res as any).ok === false) {
              rejected.push({ vnum: p.vnum, load: p.loadId, reason: (res as any).reason, blocking_lid: (res as any).blocking_lid });
            }
          }
        }

        // Observability: write a row you can read with a plain SELECT,
        // so you can see rejections without triggering the cron.
        {
          await supabase.from("app_settings").upsert({
            key: "cron.arrivalLastRun",
            value: { ts: new Date(now).toISOString(), promoted: promoted.length - rejected.length, rejected: rejected.length, rejectedDetail: rejected },
            updated_at: new Date(now).toISOString(),
          }, { onConflict: "key" });
        }

        return Response.json({
          ok:        true,
          engine:    true,
          checked:   vehicles.length,
          promoted:  promoted.length - rejected.length,
          promotedVnums: promoted,
          skipped:   skipped.length,
          rejected:  rejected.length,
          rejectedDetail: rejected,
          ts:        new Date(now).toISOString(),
        });
      },
    },
  },
});
