## Sync the uploaded TMS app into this project

The zip contains a full TanStack Start + Supabase Transport Management System (fleet map, geofences, loads, PODs, maintenance, drivers, users admin). I'll bring it in wholesale.

### Steps

1. **Copy source files** from `/mnt/user-uploads/launchpad-ui-REFIX123_7.zip` into `/dev-server`, excluding `.git`, `node_modules`, and current-project-managed files (`.lovable/`, `bun.lock`, `bunfig.toml`, `scripts-bootstrap.mjs`). Overwrite existing scaffold files (`src/routes/*`, `src/router.tsx`, `src/start.ts`, `src/server.ts`, `src/styles.css`, `src/components/`, `src/hooks/`, `src/lib/`, `src/integrations/`, `src/types/`, `package.json`, `vite.config.ts`, `tsconfig.json`, `components.json`, `eslint.config.js`).
2. **Bring in DB assets**: copy the `migrations/` and `sql/` folders as-is.
3. **Install dependencies** — `bun install` picks up the new `package.json` (adds `@supabase/supabase-js`, `@tanstack/react-virtual`, Google Maps deps, etc.).
4. **Enable Lovable Cloud** — the app requires Supabase (auth, DB, realtime, cron). I'll enable Cloud and run the migrations + sql helpers against the fresh Cloud project in the correct order:
   - `migrations/0001_tables.sql` → `0007_patch_writes.sql`
   - then the helper scripts in `sql/` (auth-users, geofence-alerts, realtime-sync, etc.)
5. **Wire env vars**: Cloud provides `VITE_SUPABASE_URL` / `VITE_SUPABASE_PUBLISHABLE_KEY`. The uploaded code reads `VITE_TMS_SUPABASE_URL` / `VITE_TMS_SUPABASE_ANON_KEY` — I'll either alias those in `.env` or adjust `src/integrations/supabase/client.ts` to use the Cloud var names.
6. **Google Maps**: the app needs `VITE_LOVABLE_CONNECTOR_GOOGLE_MAPS_BROWSER_KEY` + tracking ID. I'll leave placeholders in `.env` and flag that you'll need to paste your Google Maps browser key before the map renders.
7. **Verify the build**: run typecheck/build after the copy, and fix any Cloud-key naming or import mismatches surfaced by the build. Report anything that can't be auto-resolved (e.g. missing secrets for cron endpoints).

### What I need from you after approval
- Confirm it's OK to enable Lovable Cloud (fresh Supabase project — the uploaded app's original data won't come with it; only schema).
- Your Google Maps browser API key (can be added later; the map just won't load until then).

### Out of scope
- Data migration from the original Supabase project (only schema is recreated).
- Configuring external cron schedulers that hit `/api/public/*-tick` endpoints — I'll leave the endpoints working and you can wire pg_cron or an external scheduler after.

Approve and I'll start the sync.