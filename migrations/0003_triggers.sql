-- ════════════════════════════════════════════════════════════════════════════
-- 0003_triggers.sql — trigger functions + trigger definitions, verbatim from prod
-- Exported: 2026-07-04 · loads/vehicles/pod_records/app_settings
-- NOTE: CREATE TRIGGER statements are not idempotent — when re-running to restore,
-- either drop the named trigger first or ignore the 'already exists' error.
-- Function bodies (CREATE OR REPLACE) are always safe to re-run.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.touch_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin new.updated_at = now(); return new; end $function$
;
CREATE TRIGGER vehicles_touch BEFORE UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION touch_updated_at();

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE TRIGGER set_updated_at BEFORE INSERT OR UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE TRIGGER set_updated_at BEFORE INSERT OR UPDATE ON public.loads FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION public.set_updated_at()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.updated_at = now();
  return new;
end;
$function$
;
CREATE TRIGGER set_updated_at BEFORE INSERT OR UPDATE ON public.pod_records FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE OR REPLACE FUNCTION public.log_load_delete_v2()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
$function$
;
CREATE TRIGGER trg_log_load_delete_v2 BEFORE DELETE ON public.loads FOR EACH ROW EXECUTE FUNCTION log_load_delete_v2();

CREATE OR REPLACE FUNCTION public.sync_vehicle_mirror_cols()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.assigned_load_id := nullif(new.data->>'loadId','');
  if new.assigned_load_id is not null
     and not exists (select 1 from public.loads l where l.id = new.assigned_load_id) then
    new.assigned_load_id := null;   -- drop dangling ref so the FK can't reject the write
  end if;
  return new;
end $function$
;
CREATE TRIGGER sync_mirror_cols BEFORE INSERT OR UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION sync_vehicle_mirror_cols();

CREATE OR REPLACE FUNCTION public.sync_load_mirror_cols()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
begin
  new.vehicle_id := nullif(new.data->>'vehicleId','');
  if new.vehicle_id is not null
     and not exists (select 1 from public.vehicles v where v.id = new.vehicle_id) then
    new.vehicle_id := null;         -- drop dangling ref so the FK can't reject the write
  end if;
  new.delivered_at := nullif(new.data->>'deliveredAt','')::timestamptz;
  return new;
end $function$
;
CREATE TRIGGER sync_mirror_cols BEFORE INSERT OR UPDATE ON public.loads FOR EACH ROW EXECUTE FUNCTION sync_load_mirror_cols();

CREATE OR REPLACE FUNCTION public.log_load_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid; v_email text;
begin
  -- Engine already wrote a richer audit row in this transaction → stay silent.
  if coalesce(current_setting('app.engine_audited', true), '') = '1' then
    return new;
  end if;
  if (old.data->>'lstatus') is distinct from (new.data->>'lstatus') then
    begin v_uid := auth.uid(); exception when others then v_uid := null; end;
    begin
      v_email := coalesce(
        nullif(current_setting('app.user_email', true), ''),
        nullif(auth.jwt() ->> 'email', ''));
    exception when others then v_email := null; end;

    insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
    values (case when new.data->>'lstatus' = 'DELIVERED'
                 then 'load.delivered' else 'load.status_change' end,
            'load', new.id, new.data->>'lid',
            v_uid, v_email,
            coalesce(v_email, 'auto'),
            jsonb_build_object(
              'from', old.data->>'lstatus',
              'to',   new.data->>'lstatus',
              'vnum', new.data->>'vnum'));
  end if;
  return new;
end $function$
;
CREATE TRIGGER trg_log_load_status AFTER UPDATE ON public.loads FOR EACH ROW EXECUTE FUNCTION log_load_status_change();

CREATE OR REPLACE FUNCTION public.log_vehicle_status_change()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid; v_email text;
begin
  -- Engine already wrote a richer audit row in this transaction → stay silent.
  if coalesce(current_setting('app.engine_audited', true), '') = '1' then
    return new;
  end if;
  if (old.data->>'vstatus') is distinct from (new.data->>'vstatus') then
    begin v_uid := auth.uid(); exception when others then v_uid := null; end;
    begin
      v_email := coalesce(
        nullif(current_setting('app.user_email', true), ''),
        nullif(auth.jwt() ->> 'email', ''));
    exception when others then v_email := null; end;

    insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
    values ('vehicle.status_change', 'vehicle', new.id, new.vnum,
            v_uid, v_email,
            coalesce(v_email, 'auto'),
            jsonb_build_object(
              'from', old.data->>'vstatus',
              'to',   new.data->>'vstatus',
              'vnum', new.vnum));
  end if;
  return new;
end $function$
;
CREATE TRIGGER trg_log_vehicle_status AFTER UPDATE ON public.vehicles FOR EACH ROW EXECUTE FUNCTION log_vehicle_status_change();
