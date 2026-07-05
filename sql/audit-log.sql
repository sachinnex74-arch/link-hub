-- =============================================================================
-- Generic activity audit log.
-- Replaces the previous load-only `load_audit_log` (kept around for history,
-- but no longer written or read by the app).
--
-- Captures DELIBERATE state changes only:
--   load.create | load.delete | load.assign | load.unassign
--   load.status_change | load.delivered
-- =============================================================================

create table if not exists public.audit_log (
  id uuid primary key default gen_random_uuid(),
  at timestamptz not null default now(),
  action text not null,
  entity_type text not null default 'load',
  entity_id text,
  lid text,
  user_id uuid,
  email text,
  source text not null default 'app',  -- 'app' | 'database' | 'driver'
  details jsonb not null default '{}'::jsonb
);

create index if not exists idx_audit_log_at_desc on public.audit_log (at desc);
create index if not exists idx_audit_log_entity on public.audit_log (entity_id, at desc);

grant select on public.audit_log to authenticated;
grant all on public.audit_log to service_role;

alter table public.audit_log enable row level security;

drop policy if exists "admins_select_audit_log" on public.audit_log;
create policy "admins_select_audit_log"
  on public.audit_log
  for select
  to authenticated
  using (public.has_role(auth.uid(), 'admin'));

-- ----------------------------------------------------------------------------
-- DELETE trigger on loads — fires for EVERY delete (app, dashboard, psql, ...).
-- Reads per-transaction settings the app may have set via `app_delete_load`.
-- ----------------------------------------------------------------------------
create or replace function public.log_load_delete_v2()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user_id uuid;
  v_email text;
  v_source text;
  v_lid text;
begin
  begin
    v_user_id := nullif(current_setting('app.user_id', true), '')::uuid;
  exception when others then
    v_user_id := null;
  end;
  v_email  := nullif(current_setting('app.user_email', true), '');
  v_source := coalesce(nullif(current_setting('app.delete_source', true), ''), 'database');

  begin
    v_lid := (old.data ->> 'lid');
  exception when others then
    v_lid := null;
  end;

  insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
  values ('load.delete', 'load', old.id::text, v_lid, v_user_id, v_email, v_source,
          jsonb_build_object(
            'vnum',     (old.data ->> 'vnum'),
            'customer', (old.data ->> 'customer'),
            'origin',   (old.data ->> 'origin'),
            'dest',     (old.data ->> 'dest'),
            'lstatus',  (old.data ->> 'lstatus')
          ));

  return old;
end;
$$;

-- Replace the old trigger so we get exactly ONE audit row per delete.
drop trigger if exists trg_log_load_delete on public.loads;
drop trigger if exists trg_log_load_delete_v2 on public.loads;
create trigger trg_log_load_delete_v2
  before delete on public.loads
  for each row execute function public.log_load_delete_v2();

-- ----------------------------------------------------------------------------
-- App-driven delete: sets per-transaction settings the trigger reads, then
-- removes child rows + the load row. The trigger inserts the audit row with
-- source='app' and the attributed user. No second "stamp" pass needed.
-- ----------------------------------------------------------------------------
-- Drop old signature so we can change defaults / behaviour cleanly.
drop function if exists public.app_delete_load(text, uuid, text);

create or replace function public.app_delete_load(
  p_id text,
  p_user_id uuid default null,
  p_email text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_email text := coalesce(p_email, nullif(auth.jwt() ->> 'email', ''));
begin
  perform set_config('app.delete_source', 'app', true);
  perform set_config('app.user_id', coalesce(v_uid::text, ''), true);
  perform set_config('app.user_email', coalesce(v_email, ''), true);

  delete from public.load_attachments where load_id = p_id;
  delete from public.pod_records      where load_id = p_id;
  delete from public.loads            where id = p_id;
end;
$$;

revoke all on function public.app_delete_load(text, uuid, text) from public;
grant execute on function public.app_delete_load(text, uuid, text) to authenticated, service_role;

-- ----------------------------------------------------------------------------
-- Browser-callable audit logger: inserts one row attributed to the caller.
-- The audit_log table has no INSERT grant for `authenticated`; this SECURITY
-- DEFINER function is the only way the browser client can write to it.
-- ----------------------------------------------------------------------------
create or replace function public.app_log_audit(
  p_action text,
  p_entity_id text,
  p_lid text,
  p_source text,
  p_details jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_email text := nullif(auth.jwt() ->> 'email', '');
begin
  if v_uid is null then
    -- No signed-in caller — refuse silently rather than writing an unattributed row.
    return;
  end if;
  insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
  values (p_action, 'load', p_entity_id, p_lid, v_uid, v_email,
          coalesce(nullif(p_source, ''), 'app'),
          coalesce(p_details, '{}'::jsonb));
end;
$$;

revoke all on function public.app_log_audit(text, text, text, text, jsonb) from public;
grant execute on function public.app_log_audit(text, text, text, text, jsonb) to authenticated, service_role;
