-- =====================================================================
-- TMS shared-data setup. Run this ONCE in the Supabase SQL Editor
-- (and re-run any time you create a new project — it is idempotent).
--
-- Purpose: every signed-in user sees the SAME vehicles, loads, PODs,
-- SOS, pins, attachments, geofences and app settings, and changes by
-- ANY user are pushed live to every other user via Realtime.
--
-- What this does for every shared table:
--   1. Grants Data API access to authenticated + service_role
--   2. Enables Row Level Security with a shared "any logged-in user"
--      read/write policy (no per-user filtering)
--   3. Sets REPLICA IDENTITY FULL so realtime payloads include the
--      full row (required for our merge logic)
--   4. Adds the table to the supabase_realtime publication so changes
--      are broadcast to every connected device
-- =====================================================================

create extension if not exists pgcrypto with schema extensions;

do $$
declare
  t text;
  shared_tables text[] := array[
    'vehicles',
    'loads',
    'pod_records',
    'sos_records',
    'vehicle_pins',
    'load_attachments',
    'geofence_alerts',
    'app_settings'
  ];
begin
  foreach t in array shared_tables loop
    -- Skip if the table doesn't exist yet (created by earlier setup SQL).
    if not exists (
      select 1 from information_schema.tables
      where table_schema = 'public' and table_name = t
    ) then
      raise notice 'skipping %, table not found', t;
      continue;
    end if;

    -- 1. Data API grants
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);
    execute format('grant all on public.%I to service_role', t);

    -- 2. RLS: shared across all signed-in users
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists "shared_read_authenticated" on public.%I', t);
    execute format(
      'create policy "shared_read_authenticated" on public.%I for select to authenticated using (true)',
      t
    );
    execute format('drop policy if exists "shared_write_authenticated" on public.%I', t);
    execute format(
      'create policy "shared_write_authenticated" on public.%I for all to authenticated using (true) with check (true)',
      t
    );

    -- 3. Replica identity FULL (needed so realtime payloads carry old + new)
    execute format('alter table public.%I replica identity full', t);

    -- 4. Add to realtime publication
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime'
        and schemaname = 'public'
        and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
