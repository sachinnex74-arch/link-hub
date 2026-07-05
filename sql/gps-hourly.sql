-- Hourly GPS snapshots for the 7-day trail slider in the load-board GPS popup.
-- Populated by /api/public/gps-snapshot (cron, once per hour).
-- Old rows are purged inside the same cron call (>7 days).
--
-- Run once in the Supabase SQL editor.

create table if not exists public.gps_hourly (
  id              uuid primary key default gen_random_uuid(),
  vehicle_number  text not null,
  lat             double precision not null,
  lng             double precision not null,
  speed           double precision,
  heading         double precision,
  status          text,
  address         text,
  captured_at     timestamptz not null default now()
);

create index if not exists gps_hourly_vehicle_time_idx
  on public.gps_hourly (vehicle_number, captured_at desc);

create index if not exists gps_hourly_captured_at_idx
  on public.gps_hourly (captured_at);

-- Grants (Supabase Data API needs these explicitly)
grant select on public.gps_hourly to authenticated;
grant all    on public.gps_hourly to service_role;

-- RLS
alter table public.gps_hourly enable row level security;

drop policy if exists "gps_hourly_select_auth" on public.gps_hourly;
create policy "gps_hourly_select_auth"
  on public.gps_hourly
  for select
  to authenticated
  using (true);

-- (No insert/update/delete policies — only service_role writes, via the cron route.)

-- Optional: schedule the cron snapshot via pg_cron (uncomment after creating
-- the route and storing CRON_SECRET in vault).
--
-- select cron.schedule(
--   'gps-hourly-snapshot',
--   '0 * * * *',  -- every hour at :00
--   $$
--   select net.http_post(
--     url := 'https://project--<your-project-id>.lovable.app/api/public/gps-snapshot',
--     headers := jsonb_build_object(
--       'content-type', 'application/json',
--       'x-cron-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'cron_secret')
--     ),
--     body := '{}'::jsonb
--   );
--   $$
-- );
