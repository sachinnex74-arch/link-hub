-- Server-side geofence idle detection: stores per-vehicle "first seen at this
-- position" so the public /api/public/geofence-tick endpoint can compute idle
-- duration even when no browser tab is open.
--
-- Run once in the Supabase SQL editor.

create table if not exists public.vehicle_idle_state (
  vehicle_id      text primary key,
  lat             double precision not null,
  lng             double precision not null,
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  status          text,
  address         text,
  updated_at      timestamptz not null default now()
);

grant select, insert, update, delete on public.vehicle_idle_state to anon;
grant select, insert, update, delete on public.vehicle_idle_state to authenticated;
grant all on public.vehicle_idle_state to service_role;

alter table public.vehicle_idle_state enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='vehicle_idle_state' and policyname='vehicle_idle_state open read') then
    create policy "vehicle_idle_state open read"  on public.vehicle_idle_state for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='vehicle_idle_state' and policyname='vehicle_idle_state open write') then
    create policy "vehicle_idle_state open write" on public.vehicle_idle_state for all    using (true) with check (true);
  end if;
end $$;

-- ─── pg_cron schedule ───────────────────────────────────────────────
-- Requires pg_cron + pg_net (enable from Supabase dashboard → Database → Extensions).
-- Replace <CRON_SECRET> with the value you also set as the CRON_SECRET project secret.

-- create extension if not exists pg_cron;
-- create extension if not exists pg_net;

-- select cron.unschedule('geofence-tick') where exists (select 1 from cron.job where jobname='geofence-tick');
-- select cron.schedule(
--   'geofence-tick',
--   '*/2 * * * *',
--   $$
--     select net.http_post(
--       url     := 'https://project--d3cf3e3e-2259-484a-bf82-6b1300165b93.lovable.app/api/public/geofence-tick',
--       headers := jsonb_build_object('content-type','application/json','x-cron-secret','<CRON_SECRET>'),
--       body    := '{}'::jsonb
--     ) as request_id;
--   $$
-- );
