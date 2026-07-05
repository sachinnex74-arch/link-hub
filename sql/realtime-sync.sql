-- ⚠️ REQUIRED — RUN THIS IN THE SUPABASE SQL EDITOR ONCE.
-- Until this is applied, POD photos (and other writes) WILL NOT
-- sync across devices in real time. The app falls back to a 15s
-- cloud poll, but Realtime needs publication + replica identity
-- set up below to deliver cross-device updates instantly.
--
-- Re-run safely: every statement is idempotent.



create extension if not exists pgcrypto with schema extensions;

-- 1. Ensure updated_at exists everywhere we sync.
alter table public.vehicles         add column if not exists updated_at timestamptz not null default now();
alter table public.loads            add column if not exists updated_at timestamptz not null default now();
alter table public.pod_records      add column if not exists updated_at timestamptz not null default now();
alter table public.sos_records      add column if not exists updated_at timestamptz not null default now();
alter table public.vehicle_pins     add column if not exists updated_at timestamptz not null default now();
alter table public.vehicle_pins     add column if not exists pin_hash text;
alter table public.vehicle_pins     add column if not exists salt text default '';
update public.vehicle_pins set salt = '' where salt is null;
alter table public.vehicle_pins     alter column salt set default '';
alter table public.vehicle_pins     alter column salt drop not null;
update public.vehicle_pins
set pin_hash = encode(extensions.digest(regexp_replace(upper(coalesce(vnum, '')), '[^A-Z0-9]', '', 'g') || ':' || coalesce(pin, ''), 'sha256'), 'hex')
where coalesce(pin_hash, '') = '' and coalesce(pin, '') <> '';
alter table public.vehicle_pins     alter column pin_hash set default '';
alter table public.vehicle_pins     alter column pin_hash set not null;
alter table public.load_attachments add column if not exists updated_at timestamptz not null default now();

-- 2. REPLICA IDENTITY FULL so realtime payloads include the full row (needed for merge).
alter table public.vehicles         replica identity full;
alter table public.loads            replica identity full;
alter table public.pod_records      replica identity full;
alter table public.sos_records      replica identity full;
alter table public.vehicle_pins     replica identity full;
alter table public.load_attachments replica identity full;

-- 3. Add tables to the realtime publication (idempotent).
do $$
declare t text;
begin
  foreach t in array array['vehicles','loads','pod_records','sos_records','vehicle_pins','load_attachments']
  loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname='supabase_realtime' and schemaname='public' and tablename=t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- 4. Link PODs to a specific load record.
alter table public.pod_records drop constraint if exists pod_records_load_id_fkey;
alter table public.pod_records add column if not exists load_id text;
alter table public.pod_records alter column load_id drop not null;
alter table public.pod_records alter column load_id type text using load_id::text;
create index if not exists pod_records_load_id_idx on public.pod_records (load_id);
alter table public.pod_records add column if not exists data jsonb not null default '{}'::jsonb;
grant select, insert, update, delete on public.pod_records to authenticated;
grant all on public.pod_records to service_role;
-- Backfill load_id from JSON for older rows.
update public.pod_records
set load_id = data->>'loadId'
where load_id is null and data ? 'loadId' and (data->>'loadId') <> '';
