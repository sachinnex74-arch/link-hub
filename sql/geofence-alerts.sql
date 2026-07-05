-- Geofence idle alerts + geofence definitions sync.
-- Run once in your Supabase SQL editor (idempotent).

create table if not exists public.geofence_alerts (
  id          text primary key,
  data        jsonb not null,
  updated_at  timestamptz not null default now(),
  created_at  timestamptz not null default now()
);

grant select, insert, update, delete on public.geofence_alerts to authenticated;
grant select, insert, update, delete on public.geofence_alerts to anon;
grant all on public.geofence_alerts to service_role;

alter table public.geofence_alerts enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='geofence_alerts' and policyname='geofence_alerts open read') then
    create policy "geofence_alerts open read"  on public.geofence_alerts for select using (true);
  end if;
  if not exists (select 1 from pg_policies where schemaname='public' and tablename='geofence_alerts' and policyname='geofence_alerts open write') then
    create policy "geofence_alerts open write" on public.geofence_alerts for all    using (true) with check (true);
  end if;
end $$;

alter table public.geofence_alerts replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='geofence_alerts'
  ) then
    alter publication supabase_realtime add table public.geofence_alerts;
  end if;
end $$;
