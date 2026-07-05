import { createFileRoute } from "@tanstack/react-router";
import { createClient } from "@supabase/supabase-js";

// ─── Constants ───────────────────────────────────────────────────────────────
const DEFAULT_SUPABASE_URL = "https://xkuxizypbrzzkugjnquw.supabase.co";
const PURGE_AFTER_DAYS = 90; // soft-deleted loads older than this are hard-removed

// ─── Route ───────────────────────────────────────────────────────────────────
// Hard-purges loads that were soft-deleted more than PURGE_AFTER_DAYS ago (plus
// their attachments/PODs). Soft-delete gives a 90-day reversible window; this is
// the controlled end-of-life. Schedule infrequently (e.g. daily).
export const Route = createFileRoute("/api/public/purge-deleted-tick")({
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
        const supaUrl = process.env.TMS_SUPABASE_URL || process.env.SUPABASE_URL || DEFAULT_SUPABASE_URL;
        const serviceKey = process.env.TMS_SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
        if (!serviceKey) {
          return Response.json({ error: "missing service role key" }, { status: 500 });
        }
        const supabase = createClient(supaUrl, serviceKey, {
          auth: { persistSession: false, autoRefreshToken: false },
        });

        const { data, error } = await supabase.rpc("app_purge_deleted_loads", {
          p_days: PURGE_AFTER_DAYS,
        });
        if (error) {
          return Response.json({ error: "purge failed", detail: error.message }, { status: 500 });
        }

        return Response.json({
          ok: true,
          purged: (data as any)?.purged ?? 0,
          olderThanDays: PURGE_AFTER_DAYS,
          ts: new Date().toISOString(),
        });
      },
    },
  },
});
