import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// invariant-tick — READ-ONLY smoke alarm (Phase 3, root-level design).
//
// After the single-lane migration (atomic engine delivery/assign, canonical-blind
// walls, fail-closed writes, browser auto-status retired), a "zombie" — a vehicle
// marked busy whose load is DELIVERED/deleted/missing — should be IMPOSSIBLE.
// This cron does NOT fix anything. It verifies the claim and reports violations
// loudly, because each finding is a bug report about a source, not routine cleanup.
//
// Writes NOTHING to loads/vehicles. Only writes its observability row
// (app_settings key 'cron.invariantLastRun') and, when violations exist, one
// audit_log row per run so findings are visible in the normal audit trail.

const DEFAULT_SUPABASE_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";
const BUSY = ["IN_TRANSIT", "AT_LOADING", "AT_UNLOADING", "SENT_FOR_LOADING"];

export const Route = createFileRoute("/api/public/invariant-tick")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // ── Auth (same scheme as the other ticks) ─────────────────────────────
        const expected = process.env.CRON_SECRET || "";
        const provided = request.headers.get("x-cron-secret") || "";
        if (!expected || provided !== expected) {
          return new Response("Unauthorized", { status: 401 });
        }

        const supaUrl = process.env.TMS_SUPABASE_URL || process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
        const serviceKey = process.env.TMS_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
        if (!serviceKey) {
          return Response.json({ error: "missing service role key" }, { status: 500 });
        }
        const supabase = createClient(supaUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });
        const now = new Date().toISOString();

        // ── 1. Busy vehicles ──────────────────────────────────────────────────
        const { data: vRows, error: vErr } = await supabase
          .from("vehicles")
          .select("id, data")
          .in("data->>vstatus", BUSY);
        if (vErr) return Response.json({ error: "vehicle fetch failed", detail: vErr.message }, { status: 500 });

        const busy = (vRows || []).map((r: any) => ({
          id: String(r.id),
          vnum: (r.data || {}).vnum || null,
          vstatus: (r.data || {}).vstatus || null,
          loadId: (r.data || {}).loadId || null,
        }));

        // ── 2. Resolve their attached loads in one query ──────────────────────
        const loadIds = Array.from(new Set(busy.map((v) => v.loadId).filter(Boolean)));
        const loadById = new Map<string, any>();
        if (loadIds.length) {
          const { data: lRows, error: lErr } = await supabase
            .from("loads")
            .select("id, lid, data, deleted_at")
            .in("id", loadIds as string[]);
          if (lErr) return Response.json({ error: "load fetch failed", detail: lErr.message }, { status: 500 });
          for (const r of lRows || []) loadById.set(String(r.id), r);
        }

        // ── 3. Evaluate the invariant (report-only, no writes) ────────────────
        // Violation classes:
        //   zombie_delivered — busy vehicle, its load is DELIVERED
        //   zombie_deleted   — busy vehicle, its load is soft-deleted
        //   busy_no_loadid   — busy vehicle with NO loadId at all
        //   dangling_loadid  — busy vehicle, loadId doesn't resolve to any row
        // NOTE: load "not found in a partial list" was the June-27 trap; here we
        // query by exact ids, so a miss is a real dangling reference, not sync lag.
        const violations: any[] = [];
        for (const v of busy) {
          if (!v.loadId) {
            violations.push({ type: "busy_no_loadid", vnum: v.vnum, vehicle_id: v.id, vstatus: v.vstatus });
            continue;
          }
          const l = loadById.get(String(v.loadId));
          if (!l) {
            violations.push({ type: "dangling_loadid", vnum: v.vnum, vehicle_id: v.id, vstatus: v.vstatus, load_id: v.loadId });
            continue;
          }
          const lstatus = (l.data || {}).lstatus || null;
          if (l.deleted_at != null) {
            violations.push({ type: "zombie_deleted", vnum: v.vnum, vehicle_id: v.id, vstatus: v.vstatus, lid: l.lid });
          } else if (lstatus === "DELIVERED") {
            violations.push({ type: "zombie_delivered", vnum: v.vnum, vehicle_id: v.id, vstatus: v.vstatus, lid: l.lid });
          }
        }

        // ── 3b. D-2 gate: load_stops shadow faithfulness census (Phase D) ─────
        // The stops table must mirror the blob arrays exactly — row count equals
        // total consigneeDeliveries entries. A mismatch means the shadow trigger
        // missed a write: a 'stops_desync' violation rings the health banner and
        // BLOCKS the D-2 ownership flip until explained. Two cheap aggregates.
        try {
          const { count: stopRows } = await supabase
            .from("load_stops").select("*", { count: "exact", head: true });
          let arrayEntries: number | null = null;
          {
            const { data: rows, error } = await supabase
              .from("loads")
              .select("data->consigneeDeliveries")
              .not("data->consigneeDeliveries", "is", null);
            if (!error && Array.isArray(rows)) {
              arrayEntries = rows.reduce((s: number, r: any) => {
                const cd = (r as any).consigneeDeliveries;
                return s + (Array.isArray(cd) ? cd.length : 0);
              }, 0);
            }
          }
          if (arrayEntries != null && stopRows != null && arrayEntries !== stopRows) {
            violations.push({ type: "stops_desync", stop_rows: stopRows, array_entries: arrayEntries });
          }
        } catch { /* census unavailable → skip silently; weekly manual census still applies */ }

        // ── 4. Report (observability row + audit trail when non-clean) ────────
        await supabase.from("app_settings").upsert({
          key: "cron.invariantLastRun",
          value: { ts: now, checked: busy.length, violations: violations.length, detail: violations.slice(0, 50) },
          updated_at: now,
        }, { onConflict: "key" });

        if (violations.length) {
          await supabase.from("audit_log").insert({
            action: "INVARIANT_VIOLATION",
            entity_type: "system",
            entity_id: "invariant-tick",
            lid: null,
            source: "cron",
            details: { count: violations.length, violations: violations.slice(0, 50) },
          });
        }

        return Response.json({
          ok: true,
          readOnly: true,
          checked: busy.length,
          violations: violations.length,
          detail: violations,
          ts: now,
        });
      },
    },
  },
});
