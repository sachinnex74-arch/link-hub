-- Run this once in your Supabase SQL editor.
-- Generic cross-device sync for app-wide settings/lookups
-- (branches, customers, dest→branch map, etc.)

create table if not exists public.app_settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete on public.app_settings to authenticated;
grant select, insert, update, delete on public.app_settings to anon;
grant all on public.app_settings to service_role;

alter table public.app_settings enable row level security;

drop policy if exists "app_settings open read"  on public.app_settings;
drop policy if exists "app_settings open write" on public.app_settings;
create policy "app_settings open read"  on public.app_settings for select using (true);
create policy "app_settings open write" on public.app_settings for all    using (true) with check (true);

alter table public.app_settings replica identity full;

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname='supabase_realtime' and schemaname='public' and tablename='app_settings'
  ) then
    execute 'alter publication supabase_realtime add table public.app_settings';
  end if;
end $$;
