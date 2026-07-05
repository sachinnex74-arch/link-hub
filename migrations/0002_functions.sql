-- ════════════════════════════════════════════════════════════════════════════
-- 0002_functions.sql — every app_* function, captured verbatim from production
-- Exported: 2026-07-04 · 25 functions · source of truth going forward.
-- Re-running this file is SAFE (all CREATE OR REPLACE) and restores any function
-- a stray session may have overwritten — the anti-cross-chat vaccine.
-- ════════════════════════════════════════════════════════════════════════════

CREATE OR REPLACE FUNCTION public.app_arrival_promote(p_vehicle_id text, p_vehicle_data jsonb, p_load_id text, p_load_lid text, p_load_data jsonb, p_enforce boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_now         timestamptz := now();
  cur_load      record;
  would_reject  boolean := false;
  reject_reason text := null;
begin
  select * into cur_load from public.loads where id = p_load_id for update;

  if found then
    if not public.app_load_transition_ok(cur_load.data, p_load_data) then
      would_reject  := true;
      reject_reason := 'illegal';
    end if;
  end if;

  if would_reject and p_enforce then
    return jsonb_build_object('ok', false, 'applied', false,
                              'would_reject', true, 'reason', reject_reason);
  end if;

  update public.vehicles
  set data             = p_vehicle_data,
      vnum             = coalesce(nullif(p_vehicle_data->>'vnum',''), vnum),
      assigned_load_id = nullif(p_vehicle_data->>'loadId',''),
      version          = version + 1,
      updated_at       = v_now
  where id = p_vehicle_id;

  update public.loads
  set data         = p_load_data,
      lid          = coalesce(nullif(p_load_lid,''), lid),
      vehicle_id   = nullif(p_load_data->>'vehicleId',''),
      delivered_at = nullif(p_load_data->>'deliveredAt','')::timestamptz,
      version      = version + 1,
      updated_at   = v_now
  where id = p_load_id;

  return jsonb_build_object('ok', true, 'applied', true,
                            'would_reject', would_reject, 'reason', reject_reason);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_assign_load(p_load_id text, p_vehicle_id text, p_extra jsonb DEFAULT '{}'::jsonb, p_source text DEFAULT 'manual'::text, p_dry_run boolean DEFAULT false, p_load_base_version bigint DEFAULT NULL::bigint, p_vehicle_base_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lrec record; vrec record; ld jsonb; vd jsonb; nld jsonb; nvd jsonb;
  blocking_lid text;
  old_vid text; ovrec record; ovd jsonb; nold jsonb;
  displaced_freed boolean := false;
  v_now timestamptz := now();
  iso_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select * into lrec from public.loads    where id = p_load_id    for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_load'); end if;
  select * into vrec from public.vehicles where id = p_vehicle_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_vehicle'); end if;

  ld := coalesce(lrec.data, '{}'::jsonb);
  vd := coalesce(vrec.data, '{}'::jsonb);

  -- terminal guard
  if (ld->>'lstatus') in ('DELIVERED','CANCELLED') then
    return jsonb_build_object('ok', false, 'reason', 'load_terminal', 'lstatus', ld->>'lstatus');
  end if;
  -- optimistic concurrency (optional)
  if p_load_base_version is not null and lrec.version is distinct from p_load_base_version then
    return jsonb_build_object('ok', false, 'reason', 'stale_load', 'have', lrec.version);
  end if;
  if p_vehicle_base_version is not null and vrec.version is distinct from p_vehicle_base_version then
    return jsonb_build_object('ok', false, 'reason', 'stale_vehicle', 'have', vrec.version);
  end if;
  -- legality: vehicle must be free (no OTHER active load). Mirrors the engine guard.
  select l.lid into blocking_lid
  from public.loads l
  where l.vehicle_id = p_vehicle_id
    and l.id <> p_load_id
    and l.lstatus in ('ASSIGNED','IN_TRANSIT','AT_UNLOADING')
    and l.deleted_at is null
  limit 1;
  if blocking_lid is not null then
    return jsonb_build_object('ok', false, 'reason', 'vehicle_busy', 'blocking_lid', blocking_lid);
  end if;

  -- ── DISPLACED-VEHICLE FREEING ────────────────────────────────────────────
  -- If this load ALREADY points at a DIFFERENT vehicle, reassigning to p_vehicle_id
  -- displaces the old one. Free it in THIS SAME TRANSACTION so it can't be orphaned
  -- with a stale one-way loadId (root cause of the "shows busy / queues wrongly" bug).
  -- No-op when the load has no prior vehicle, or is being reassigned to the same vehicle.
  old_vid := nullif(ld->>'vehicleId','');
  if old_vid is not null and old_vid <> p_vehicle_id then
    select * into ovrec from public.vehicles where id = old_vid for update;
    if found then
      ovd := coalesce(ovrec.data, '{}'::jsonb);
      -- Only free it if it still thinks it's on THIS load (guard against a vehicle
      -- that was already moved elsewhere in the meantime — don't clobber that).
      if nullif(ovd->>'loadId','') is null or (ovd->>'loadId') = p_load_id then
        nold := ovd || jsonb_build_object(
          'vstatus', 'AVAILABLE',
          'loadId', null,
          'availableSince', iso_now,
          'availableAfterDelivery', false,
          'atLoadingAt', null,
          'sentForLoadingAt', null, 'waitingClearEta', null,
          'sentLoadingClearEta', null, 'atLoadingClearEta', null,
          'queuedVehicleId', null, 'queuedBehindLoadId', null);
        if not p_dry_run then
          update public.vehicles
             set data = nold, assigned_load_id = nullif(nold->>'loadId',''),
                 version = version + 1, updated_at = v_now
           where id = old_vid;
          insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
          values ('DISPLACE_FREE', 'vehicle', old_vid, lrec.lid, p_source,
                  jsonb_build_object('freed_from_load', p_load_id, 'replaced_by_vehicle', p_vehicle_id));
        end if;
        displaced_freed := true;
      end if;
    end if;
  end if;

  -- compute next blobs (field-for-field with Tms.jsx assignVehicle free-vehicle path)
  nld := ld || jsonb_build_object(
    'lstatus', 'ASSIGNED',
    'vehicleId', p_vehicle_id,
    'vnum', coalesce(nullif(vd->>'vnum',''), ld->>'vnum'),
    'queuedVehicleId', null, 'queuedBehindLoadId', null, 'queuedAt', null);

  nvd := vd || jsonb_build_object(
    'vstatus', 'AT_LOADING',
    'loadId', p_load_id,
    'departure',   coalesce(nullif(p_extra->>'departure',''),   nullif(ld->>'origin',''), vd->>'departure'),
    'destination', coalesce(nullif(p_extra->>'destination',''), nullif(ld->>'dest',''),   vd->>'destination'),
    'atLoadingAt', iso_now,
    'availableSince', null, 'availableAfterDelivery', false,
    'sentForLoadingAt', null, 'waitingClearEta', null, 'sentLoadingClearEta', null);

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'op', 'assign',
                              'load_next', nld, 'vehicle_next', nvd,
                              'displaced_freed', displaced_freed, 'displaced_vehicle', old_vid);
  end if;

  update public.loads
     set data = nld, vehicle_id = nullif(nld->>'vehicleId',''),
         version = version + 1, updated_at = v_now
   where id = p_load_id;
  update public.vehicles
     set data = nvd, assigned_load_id = nullif(nvd->>'loadId',''),
         version = version + 1, updated_at = v_now
   where id = p_vehicle_id;

  insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
  values ('ASSIGN', 'load',    p_load_id,    lrec.lid, p_source, jsonb_build_object('vehicle_id', p_vehicle_id)),
         ('ASSIGN', 'vehicle', p_vehicle_id, lrec.lid, p_source, jsonb_build_object('load_id', p_load_id));

  return jsonb_build_object('ok', true, 'applied', true, 'op', 'assign',
                            'load_id', p_load_id, 'vehicle_id', p_vehicle_id,
                            'displaced_freed', displaced_freed, 'displaced_vehicle', old_vid);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_attach_pod(p_id text, p_pod jsonb, p_source text DEFAULT 'driver'::text, p_dry_run boolean DEFAULT false, p_base_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  cur record; new_version bigint; eff jsonb;
begin
  select * into cur from public.loads where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', false, 'applied', false, 'reason', 'not_found');
  end if;

  if cur.deleted_at is not null then
    return jsonb_build_object('ok', false, 'applied', false, 'reason', 'deleted', 'version', cur.version);
  end if;

  if p_base_version is not null and p_base_version is distinct from cur.version then
    return jsonb_build_object('ok', false, 'applied', false, 'reason', 'stale',
                              'version', cur.version, 'current', cur.data);
  end if;

  eff := coalesce(cur.data, '{}'::jsonb) || jsonb_build_object('pod', p_pod);
  new_version := cur.version + 1;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'applied', false, 'dry_run', true,
                              'version', cur.version, 'next_version', new_version);
  end if;

  update public.loads
     set data = eff, version = new_version, updated_at = now()
   where id = p_id;

  insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
  values ('POD_ATTACH', 'load', p_id, cur.lid, p_source,
          jsonb_build_object('from_version', cur.version, 'to_version', new_version,
                             'has_pod', (p_pod is not null)));

  return jsonb_build_object('ok', true, 'applied', true, 'version', new_version);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_delete_load(p_id text, p_user_id uuid DEFAULT NULL::uuid, p_email text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_email text := coalesce(p_email, nullif(auth.jwt() ->> 'email', ''));
  cur record; new_blob jsonb;
  -- vehicle-release additions
  vrec record; vd jsonb; nvd jsonb;
  other_id text; freed boolean := false; repointed boolean := false;
  iso_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select * into cur from public.loads where id = p_id for update;
  if not found then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'missing');
  end if;
  if cur.deleted_at is not null then
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'already_deleted');
  end if;

  new_blob := jsonb_set(coalesce(cur.data, '{}'::jsonb), '{lstatus}', '"DELETED"');

  update public.loads
     set data = new_blob,
         deleted_at = now(),
         version = version + 1,
         updated_at = now()
   where id = p_id;

  -- ── NEW: release the attached vehicle (same transaction) ───────────────────
  -- Find a vehicle referencing this load from EITHER direction: the load's own
  -- vehicleId, the vehicle's blob loadId, or the mirror column assigned_load_id.
  select * into vrec
  from public.vehicles v
  where v.id = nullif(cur.data->>'vehicleId','')
     or v.data->>'loadId' = p_id
     or v.assigned_load_id = p_id
  limit 1
  for update;

  if found then
    vd := coalesce(vrec.data, '{}'::jsonb);
    -- Only act if the vehicle actually references the deleted load (belt+suspenders).
    if (vd->>'loadId') = p_id
       or vrec.assigned_load_id = p_id
       or vrec.id = nullif(cur.data->>'vehicleId','') then

      -- Another in-progress load on this truck? Repoint instead of freeing
      -- (mirrors app_mark_consignee's delivered-cascade).
      select l.id into other_id
      from public.loads l
      where (l.vehicle_id = vrec.id or l.data->>'vehicleId' = vrec.id)
        and l.id <> p_id
        and l.lstatus in ('ASSIGNED','IN_TRANSIT','AT_UNLOADING')
        and l.deleted_at is null
      limit 1;

      if other_id is not null then
        nvd := vd || jsonb_build_object(
          'loadId', other_id,
          'departure',   coalesce(nullif((select l.data->>'origin' from public.loads l where l.id = other_id),''), vd->>'departure'),
          'destination', coalesce(nullif((select l.data->>'dest'   from public.loads l where l.id = other_id),''), vd->>'destination'));
        repointed := true;
      else
        nvd := vd || jsonb_build_object(
          'vstatus','AVAILABLE','loadId', null,
          'availableSince', iso_now, 'availableAfterDelivery', false,
          'sentForLoadingAt', null, 'atLoadingAt', null, 'atUnloadingAt', null,
          'waitingClearEta', null, 'sentLoadingClearEta', null, 'atLoadingClearEta', null);
        freed := true;
      end if;

      update public.vehicles
         set data = nvd,
             assigned_load_id = nullif(nvd->>'loadId',''),
             version = version + 1,
             updated_at = now()
       where id = vrec.id;

      insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
      values ('load.delete', 'vehicle', vrec.id, cur.lid, v_uid, v_email, 'app',
              jsonb_build_object(
                'vnum', vd->>'vnum',
                'freed_from', p_id,
                'repointed_to', other_id,
                'released', freed,
                'prior_vstatus', vd->>'vstatus'));
    end if;
  end if;
  -- ────────────────────────────────────────────────────────────────────────────

  insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
  values ('load.delete', 'load', p_id, cur.lid, v_uid, v_email, 'app',
          jsonb_build_object(
            'vnum',     cur.data->>'vnum',
            'customer', cur.data->>'customer',
            'origin',   cur.data->>'origin',
            'dest',     cur.data->>'dest',
            'lstatus',  cur.data->>'lstatus',   -- status at time of delete
            'soft',     true,
            'vehicle_released', freed,
            'vehicle_repointed', repointed));

  return jsonb_build_object('ok', true, 'applied', true,
                            'vehicle_released', freed, 'vehicle_repointed', repointed);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_delete_vehicle(p_id text, p_user_id uuid DEFAULT NULL::uuid, p_email text DEFAULT NULL::text)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := coalesce(p_user_id, auth.uid());
  v_email text := coalesce(p_email, nullif(auth.jwt() ->> 'email', ''));
begin
  perform set_config('app.delete_source', 'app', true);
  perform set_config('app.user_id', coalesce(v_uid::text, ''), true);
  perform set_config('app.user_email', coalesce(v_email, ''), true);

  delete from public.vehicles where id = p_id;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_deliver_load_v2(p_load_id text, p_finalize boolean DEFAULT true, p_source text DEFAULT 'manual'::text, p_dry_run boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lrec record; vrec record; ld jsonb; vd jsonb; nld jsonb; nvd jsonb := null;
  cur_vehicle text; other_inprogress text;
  cities jsonb := '[]'::jsonb; base jsonb := '[]'::jsonb;
  elem text; idx int; ex jsonb; existing jsonb;
  v_now timestamptz := now();
  iso_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  -- ── lock + guards ─────────────────────────────────────────────────────────
  select * into lrec from public.loads where id = p_load_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_load'); end if;
  ld := coalesce(lrec.data, '{}'::jsonb);

  if lrec.deleted_at is not null or (ld->>'lstatus') = 'DELETED' then
    return jsonb_build_object('ok', false, 'reason', 'load_deleted');
  end if;
  if (ld->>'lstatus') = 'CANCELLED' then
    return jsonb_build_object('ok', false, 'reason', 'load_terminal', 'lstatus', 'CANCELLED');
  end if;
  if (ld->>'lstatus') = 'DELIVERED' then
    -- idempotent: re-delivering is a no-op, never a rewrite
    return jsonb_build_object('ok', true, 'applied', false, 'reason', 'already_delivered');
  end if;

  cur_vehicle := nullif(ld->>'vehicleId','');
  if cur_vehicle is not null then
    select * into vrec from public.vehicles where id = cur_vehicle for update;
    if not found then cur_vehicle := null; end if;
  end if;
  if cur_vehicle is not null then vd := coalesce(vrec.data, '{}'::jsonb); end if;

  -- ── consignee finalization (server port of buildFullyDeliveredCD) ──────────
  -- Marks every stop delivered; preserves each stop's existing podPath/deliveredAt.
  if p_finalize then
    for elem in select value from jsonb_array_elements_text(coalesce(ld->'consignees','[]'::jsonb)) loop
      if elem is not null and elem <> '' then cities := cities || to_jsonb(elem); end if;
    end loop;
    if coalesce(ld->>'dest','') <> '' then cities := cities || to_jsonb(ld->>'dest'); end if;
    existing := coalesce(ld->'consigneeDeliveries','[]'::jsonb);
    for idx in 0 .. jsonb_array_length(cities) - 1 loop
      ex := coalesce(existing->idx, '{}'::jsonb);
      base := base || (ex || jsonb_build_object(
        'city', cities->>idx,
        'delivered', true,
        'podPath', coalesce(ex->>'podPath', null),
        'deliveredAt', coalesce(nullif(ex->>'deliveredAt',''), iso_now)));
    end loop;
  end if;

  -- ── next load blob (snapshots from the LOCKED vehicle, delivered stamp) ────
  nld := ld || jsonb_build_object(
    'lstatus', 'DELIVERED',
    'vehicleId', null,
    'deliveredAt', coalesce(nullif(ld->>'deliveredAt',''), iso_now),
    'vnumSnapshot',   coalesce(nullif(ld->>'vnumSnapshot',''),   vd->>'vnum'),
    'driverSnapshot', coalesce(nullif(ld->>'driverSnapshot',''), vd->>'driver'),
    'mobileSnapshot', coalesce(nullif(ld->>'mobileSnapshot',''), vd->>'mobile'));
  if p_finalize then
    nld := nld || jsonb_build_object('consigneeDeliveries', base);
  end if;

  -- ── vehicle repoint-or-free (mirrors the consignee cascade) ────────────────
  if cur_vehicle is not null then
    select l.id into other_inprogress
    from public.loads l
    where l.vehicle_id = cur_vehicle and l.id <> p_load_id
      and l.lstatus in ('IN_TRANSIT','AT_UNLOADING','ASSIGNED')
      and l.deleted_at is null
    limit 1;

    if other_inprogress is not null then
      nvd := vd || jsonb_build_object(
        'loadId', other_inprogress,
        'departure',   coalesce(nullif((select l.data->>'origin' from public.loads l where l.id = other_inprogress),''), vd->>'departure'),
        'destination', coalesce(nullif((select l.data->>'dest'   from public.loads l where l.id = other_inprogress),''), vd->>'destination'));
    else
      nvd := vd || jsonb_build_object(
        'vstatus','AVAILABLE','loadId', null,
        'availableSince', iso_now, 'availableAfterDelivery', true,
        'sentForLoadingAt', null, 'atLoadingAt', null, 'atUnloadingAt', null,
        'waitingClearEta', null, 'sentLoadingClearEta', null, 'atLoadingClearEta', null);
    end if;
  end if;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'op', 'deliver',
      'load_next', nld, 'vehicle_id', cur_vehicle, 'vehicle_next', nvd);
  end if;

  -- engine-audited: our rich rows below; triggers stay silent this transaction
  perform set_config('app.engine_audited', '1', true);

  -- ── atomic writes ──────────────────────────────────────────────────────────
  update public.loads
     set data = nld,
         vehicle_id = null,
         delivered_at = nullif(nld->>'deliveredAt','')::timestamptz,
         version = version + 1, updated_at = v_now
   where id = p_load_id;

  if cur_vehicle is not null and nvd is not null then
    update public.vehicles
       set data = nvd, assigned_load_id = nullif(nvd->>'loadId',''),
           version = version + 1, updated_at = v_now
     where id = cur_vehicle;
  end if;

  -- ── in-tx audit (rich rows, deduped via the flag above) ────────────────────
  insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
  values ('DELIVER', 'load', p_load_id, lrec.lid,
          auth.uid(), nullif(auth.jwt() ->> 'email', ''), p_source,
          jsonb_build_object('via','deliver_v2','finalized', p_finalize,
                             'from', ld->>'lstatus', 'vnum', vd->>'vnum'));
  if cur_vehicle is not null then
    insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
    values ('DELIVER', 'vehicle', cur_vehicle, lrec.lid,
            auth.uid(), nullif(auth.jwt() ->> 'email', ''), p_source,
            jsonb_build_object('freed_from', p_load_id, 'repointed_to', other_inprogress,
                               'from', vd->>'vstatus', 'to', coalesce(nvd->>'vstatus', vd->>'vstatus')));
  end if;

  return jsonb_build_object('ok', true, 'applied', true, 'op', 'deliver',
    'load_id', p_load_id, 'vehicle_id', cur_vehicle,
    'repointed_to', other_inprogress, 'lstatus', 'DELIVERED');
end $function$
;

CREATE OR REPLACE FUNCTION public.app_dwell_observe_batch(p_samples jsonb, p_threshold_hours integer DEFAULT 12)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  s          jsonb;
  z          record;
  inside     boolean;
  dist_m     double precision;
  st         record;
  opened int := 0; closed int := 0; alerted int := 0; seen int := 0;
begin
  -- Iterate every sample (vehicle) × every active zone.
  for s in select * from jsonb_array_elements(coalesce(p_samples, '[]'::jsonb))
  loop
    seen := seen + 1;
    -- Skip stale / missing-position samples: don't open or close on bad data.
    if coalesce((s->>'stale')::boolean, true)
       or (s->>'lat') is null or (s->>'lng') is null then
      continue;
    end if;

    for z in select * from public.dwell_zones where active loop
      dist_m := public.haversine_m(
        (s->>'lat')::double precision, (s->>'lng')::double precision,
        z.center_lat, z.center_lng);
      inside := dist_m <= z.radius_m;

      select * into st from public.dwell_state
        where vehicle_id = (s->>'vehicle_id') and zone_id = z.id;

      if inside then
        if not found then
          insert into public.dwell_state(vehicle_id, zone_id, vnum, entered_at, last_seen_inside)
          values ((s->>'vehicle_id'), z.id, (s->>'vnum'), now(), now());
          opened := opened + 1;
        else
          update public.dwell_state set last_seen_inside = now()
            where vehicle_id = (s->>'vehicle_id') and zone_id = z.id;
          -- Cross the threshold once → fire an alert.
          if st.notified_at is null
             and now() - st.entered_at >= make_interval(hours => p_threshold_hours) then
            insert into public.dwell_alerts(vehicle_id, vnum, zone_id, zone_name, entered_at)
            values ((s->>'vehicle_id'), (s->>'vnum'), z.id, z.name, st.entered_at);
            update public.dwell_state set notified_at = now()
              where vehicle_id = (s->>'vehicle_id') and zone_id = z.id;
            alerted := alerted + 1;
          end if;
        end if;
      else
        -- Left the zone: close the dwell episode + mark any open alert cleared.
        if found then
          delete from public.dwell_state
            where vehicle_id = (s->>'vehicle_id') and zone_id = z.id;
          update public.dwell_alerts set cleared_at = now()
            where vehicle_id = (s->>'vehicle_id') and zone_id = z.id and cleared_at is null;
          closed := closed + 1;
        end if;
      end if;
    end loop;
  end loop;

  return jsonb_build_object('ok', true, 'seen', seen,
                            'opened', opened, 'closed', closed, 'alerted', alerted);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_load_transition_ok(old_d jsonb, new_d jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select not (
    -- block resurrecting a DELIVERED load
    ( coalesce(old_d->>'lstatus','') = 'DELIVERED'
      and coalesce(new_d->>'lstatus','') in
          ('ASSIGNED','IN_TRANSIT','AT_UNLOADING','QUEUED','PENDING') )
    or
    -- block un-deleting a DELETED load (any change away from DELETED)
    ( coalesce(old_d->>'lstatus','') = 'DELETED'
      and coalesce(new_d->>'lstatus','') <> 'DELETED' )
  );
$function$
;

CREATE OR REPLACE FUNCTION public.app_log_audit(p_action text, p_entity_id text, p_lid text, p_source text, p_details jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_email text := nullif(auth.jwt() ->> 'email', '');
begin
  if v_uid is null then
    return;
  end if;
  insert into public.audit_log (action, entity_type, entity_id, lid, user_id, email, source, details)
  values (p_action, 'load', p_entity_id, p_lid, v_uid, v_email,
          coalesce(nullif(p_source, ''), 'app'),
          coalesce(p_details, '{}'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_log_vehicle_audit(p_action text, p_entity_id text, p_vnum text, p_source text, p_details jsonb)
 RETURNS void
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid   uuid := auth.uid();
  v_email text := nullif(auth.jwt() ->> 'email', '');
begin
  if v_uid is null then
    return;
  end if;
  insert into public.audit_log
    (action, entity_type, entity_id, lid, user_id, email, source, details)
  values
    (p_action, 'vehicle', p_entity_id, p_vnum, v_uid, v_email,
     coalesce(nullif(p_source, ''), 'app'),
     coalesce(p_details, '{}'::jsonb));
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_mark_consignee(p_load_id text, p_ci integer, p_source text, p_pod_path text DEFAULT NULL::text, p_delivered boolean DEFAULT true, p_pod_ok boolean DEFAULT NULL::boolean, p_dry_run boolean DEFAULT false, p_load_base_version bigint DEFAULT NULL::bigint, p_cid text DEFAULT NULL::text, p_delivered_at timestamp with time zone DEFAULT NULL::timestamp with time zone)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lrec record; vrec record; olrec record;
  ld jsonb; nld jsonb; vd jsonb; nvd jsonb := null;
  existing jsonb; cities jsonb := '[]'::jsonb; base jsonb := '[]'::jsonb;
  elem text; idx int; total int; done_count int := 0; all_done boolean := false;
  ex jsonb; new_stop jsonb; stop_delivered boolean; city text;
  covered_idx int[] := '{}';
  cur_vehicle text; other_inprogress_id text;
  v_now timestamptz := now();
  iso_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  -- NEW: normalise the dispatcher-picked date to the SAME string shape as iso_now.
  p_at_iso text := case when p_delivered_at is not null
    then to_char(p_delivered_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    else null end;
  cids jsonb; n_cons int; resolved_ci int;   -- dual-key cid->index resolution scratch
begin
  -- lock load
  select * into lrec from public.loads where id = p_load_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_load'); end if;
  ld := coalesce(lrec.data, '{}'::jsonb);

  -- source validation (precedes the terminal guard, which is now source-specific)
  if p_source not in ('driver_pod','dispatcher_manual','dispatcher_pod_ok') then
    return jsonb_build_object('ok', false, 'reason', 'bad_source', 'source', p_source);
  end if;

  -- terminal guard (2c-3a, source-specific):
  --   driver_pod / dispatcher_manual → rejected on DELIVERED and CANCELLED (no un/re-deliver).
  --   dispatcher_pod_ok → allowed on DELIVERED (post-delivery POD review/correction);
  --                       CANCELLED stays rejected (reopen only via a future admin override).
  if p_source = 'dispatcher_pod_ok' then
    if (ld->>'lstatus') = 'CANCELLED' then
      return jsonb_build_object('ok', false, 'reason', 'load_terminal', 'lstatus', ld->>'lstatus');
    end if;
  else
    if (ld->>'lstatus') in ('DELIVERED','CANCELLED') then
      return jsonb_build_object('ok', false, 'reason', 'load_terminal', 'lstatus', ld->>'lstatus');
    end if;
  end if;

  -- optimistic concurrency (optional)
  if p_load_base_version is not null and lrec.version is distinct from p_load_base_version then
    return jsonb_build_object('ok', false, 'reason', 'stale_load', 'have', lrec.version);
  end if;

  if p_source = 'driver_pod' and p_delivered and (p_pod_path is null or p_pod_path = '') then
    return jsonb_build_object('ok', false, 'reason', 'pod_required', 'source', p_source);
  end if;

  -- build cities = [...consignees, dest] filtered for truthy
  for elem in select value from jsonb_array_elements_text(coalesce(ld->'consignees','[]'::jsonb)) loop
    if elem is not null and elem <> '' then cities := cities || to_jsonb(elem); end if;
  end loop;
  if coalesce(ld->>'dest','') <> '' then cities := cities || to_jsonb(ld->>'dest'); end if;
  total := jsonb_array_length(cities);

  -- ── DUAL-KEY RESOLUTION (cid preferred; index fallback for old loads) ──────
  cids := ld->'consigneeCids';
  if p_cid is not null and p_cid <> '' then
    if p_cid = '__dest__' then
      if coalesce(ld->>'dest','') = '' then
        return jsonb_build_object('ok', false, 'reason', 'bad_cid', 'cid', p_cid, 'detail', 'no_dest');
      end if;
      resolved_ci := total - 1;                 -- dest is always the last position
    elsif cids is not null and jsonb_typeof(cids) = 'array' then
      resolved_ci := null;
      n_cons := jsonb_array_length(cids);
      for idx in 0 .. n_cons - 1 loop
        if (cids->>idx) = p_cid then resolved_ci := idx; exit; end if;
      end loop;
      if resolved_ci is null then
        return jsonb_build_object('ok', false, 'reason', 'bad_cid', 'cid', p_cid);
      end if;
    else
      return jsonb_build_object('ok', false, 'reason', 'bad_cid', 'cid', p_cid, 'detail', 'not_cid_load');
    end if;
    p_ci := resolved_ci;                          -- hand to existing index logic, unchanged
  end if;
  -- ──────────────────────────────────────────────────────────────────────────

  -- ci bounds
  if p_ci is null or p_ci < 0 or p_ci >= total then
    return jsonb_build_object('ok', false, 'reason', 'bad_ci', 'ci', p_ci, 'total', total);
  end if;

  existing := coalesce(ld->'consigneeDeliveries','[]'::jsonb);

  if p_source = 'dispatcher_pod_ok' then
    -- 2c-0: toggle ONLY podOk on the target stop. Touch nothing else. No cascade.
    for idx in 0 .. total - 1 loop
      city := cities->>idx;
      ex := coalesce(existing->idx, '{}'::jsonb);
      new_stop := ex || jsonb_build_object('city', city);          -- ensure city present, preserve all fields
      if idx = p_ci then
        new_stop := new_stop || jsonb_build_object('podOk', p_pod_ok);  -- merge: only podOk changes
      end if;
      if coalesce((new_stop->>'delivered')::boolean, false) then done_count := done_count + 1; end if;
      base := base || new_stop;
    end loop;
    all_done := false;  -- a podOk toggle never delivers the load
  else
    -- driver_pod / dispatcher_manual: POD-authoritative delivered, MERGE-preserve fields.
    if to_regclass('public.pod_records') is not null then
      select coalesce(array_agg((data->>'consigneeIndex')::int), '{}')
        into covered_idx
      from public.pod_records
      where load_id = p_load_id and (data->>'consigneeIndex') is not null;
    end if;
    if p_source = 'driver_pod' then
      covered_idx := covered_idx || p_ci;
    end if;

    for idx in 0 .. total - 1 loop
      city := cities->>idx;
      ex := coalesce(existing->idx, '{}'::jsonb);
      if idx = p_ci then
        if p_source = 'dispatcher_manual' then
          stop_delivered := p_delivered;                          -- override, no POD gate
          -- sticky: a dispatcher's explicit set wins over later POD-authoritative recomputes.
          -- CHANGED: an explicit p_at_iso (dispatcher-picked date) now WINS over the stored
          -- value, so a chosen/corrected date persists instead of snapping to now/old.
          new_stop := ex || jsonb_build_object(
            'city', city, 'delivered', stop_delivered, 'manualOverride', true,
            'deliveredAt', case when stop_delivered then coalesce(p_at_iso, ex->>'deliveredAt', iso_now) else null end);
        else -- driver_pod
          stop_delivered := true;
          -- a fresh driver POD is a real delivery event → clears any prior manual override.
          new_stop := ex || jsonb_build_object(
            'city', city, 'delivered', true, 'manualOverride', false,
            'podPath', coalesce(p_pod_path, ex->>'podPath'),
            'deliveredAt', coalesce(ex->>'deliveredAt', iso_now));
        end if;
      else
        -- NON-target: a manually-overridden stop keeps its stored value; otherwise
        -- POD-authoritative as before (driver POD auto-delivers untouched stops).
        if coalesce((ex->>'manualOverride')::boolean, false) then
          stop_delivered := coalesce((ex->>'delivered')::boolean, false);
        else
          stop_delivered := (idx = any(covered_idx)) or coalesce((ex->>'delivered')::boolean, false);
        end if;
        new_stop := ex || jsonb_build_object(
          'city', city, 'delivered', stop_delivered,
          'deliveredAt', case when stop_delivered then coalesce(ex->>'deliveredAt', iso_now) else null end);
      end if;
      if stop_delivered then done_count := done_count + 1; end if;
      base := base || new_stop;
    end loop;
    all_done := total > 0 and done_count >= total;
  end if;

  -- compute next load blob
  nld := ld || jsonb_build_object('consigneeDeliveries', base);
  if all_done then
    nld := nld || jsonb_build_object(
      'lstatus', 'DELIVERED', 'vehicleId', null,
      'deliveredAt', coalesce(nullif(ld->>'deliveredAt',''), iso_now));
  end if;

  -- compute freed/repointed vehicle (only on cascade, only if linked)
  cur_vehicle := nullif(ld->>'vehicleId','');
  if all_done and cur_vehicle is not null then
    select * into vrec from public.vehicles where id = cur_vehicle for update;
    if found then
      vd := coalesce(vrec.data, '{}'::jsonb);
      -- Snapshot the freed vehicle's identity onto the load (vehicleId is about to be null).
      -- The Delivered page reads these *Snapshot fields once the vehicle link is gone.
      -- Preserve any existing snapshot; otherwise fill from the locked vehicle row.
      nld := nld || jsonb_build_object(
        'vnumSnapshot',   coalesce(nullif(nld->>'vnumSnapshot',''),   vd->>'vnum'),
        'driverSnapshot', coalesce(nullif(nld->>'driverSnapshot',''), vd->>'driver'),
        'mobileSnapshot', coalesce(nullif(nld->>'mobileSnapshot',''), vd->>'mobile'));
      select l.id into other_inprogress_id
      from public.loads l
      where l.vehicle_id = cur_vehicle and l.id <> p_load_id
        and l.lstatus in ('IN_TRANSIT','AT_UNLOADING','ASSIGNED')
        and l.deleted_at is null
      limit 1;
      if other_inprogress_id is not null then
        select * into olrec from public.loads where id = other_inprogress_id;
        nvd := vd || jsonb_build_object(
          'loadId', other_inprogress_id,
          'departure',   coalesce(nullif(olrec.data->>'origin',''), vd->>'departure'),
          'destination', coalesce(nullif(olrec.data->>'dest',''),   vd->>'destination'));
      else
        nvd := vd || jsonb_build_object(
          'vstatus','AVAILABLE','loadId', null,
          'availableSince', iso_now, 'availableAfterDelivery', true,
          'sentForLoadingAt', null, 'atLoadingAt', null, 'atUnloadingAt', null,
          'waitingClearEta', null, 'sentLoadingClearEta', null, 'atLoadingClearEta', null);
      end if;
    end if;
  end if;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'op', 'mark_consignee',
      'ci', p_ci, 'source', p_source, 'all_done', all_done,
      'done_count', done_count, 'total', total,
      'load_next', nld, 'vehicle_next', nvd);
  end if;

  -- writes
  update public.loads
     set data = nld, vehicle_id = nullif(nld->>'vehicleId',''),
         version = version + 1, updated_at = v_now
   where id = p_load_id;

  if all_done and cur_vehicle is not null and nvd is not null then
    update public.vehicles
       set data = nvd, assigned_load_id = nullif(nvd->>'loadId',''),
           version = version + 1, updated_at = v_now
     where id = cur_vehicle;
  end if;

  -- audit (in-transaction)
  insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
  values ('CONSIGNEE', 'load', p_load_id, lrec.lid, p_source,
          jsonb_build_object('ci', p_ci, 'cid', p_cid,
                             'delivered', (base->p_ci->>'delivered')::boolean,
                             'pod_ok', case when p_source='dispatcher_pod_ok' then to_jsonb(p_pod_ok) else 'null'::jsonb end,
                             'all_done', all_done, 'done_count', done_count, 'total', total));
  if all_done then
    insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
    values ('DELIVER', 'load', p_load_id, lrec.lid, p_source,
            jsonb_build_object('via','consignee_cascade'));
    if cur_vehicle is not null and nvd is not null then
      insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
      values ('DELIVER', 'vehicle', cur_vehicle, lrec.lid, p_source,
              jsonb_build_object('freed_from', p_load_id, 'repointed_to', other_inprogress_id));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'applied', true, 'op', 'mark_consignee',
    'ci', p_ci, 'source', p_source, 'all_done', all_done,
    'done_count', done_count, 'total', total, 'lstatus', nld->>'lstatus');
end $function$
;

CREATE OR REPLACE FUNCTION public.app_next_lids(p_count integer DEFAULT 1)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare result text[] := '{}'; i int; n bigint;
begin
  for i in 1..greatest(p_count, 1) loop
    n := nextval('public.ld_seq');
    result := array_append(
      result,
      'LD-' || case when n < 1000 then lpad(n::text, 3, '0') else n::text end
    );
  end loop;
  return to_jsonb(result);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_promote_queued_load(p_load_id text, p_extra jsonb DEFAULT '{}'::jsonb, p_source text DEFAULT 'manual'::text, p_dry_run boolean DEFAULT false, p_load_base_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lrec record; vrec record; ld jsonb; vd jsonb; nld jsonb; nvd jsonb;
  q_vehicle text; blocking_lid text;
  v_now timestamptz := now();
begin
  select * into lrec from public.loads where id = p_load_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_load'); end if;
  ld := coalesce(lrec.data, '{}'::jsonb);

  if (ld->>'lstatus') is distinct from 'QUEUED' then
    return jsonb_build_object('ok', false, 'reason', 'not_queued', 'lstatus', ld->>'lstatus');
  end if;
  q_vehicle := nullif(ld->>'queuedVehicleId','');
  if q_vehicle is null then
    return jsonb_build_object('ok', false, 'reason', 'no_queued_vehicle');
  end if;
  if p_load_base_version is not null and lrec.version is distinct from p_load_base_version then
    return jsonb_build_object('ok', false, 'reason', 'stale_load', 'have', lrec.version);
  end if;

  select * into vrec from public.vehicles where id = q_vehicle for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_vehicle'); end if;
  vd := coalesce(vrec.data, '{}'::jsonb);

  -- vehicle must be free of OTHER active loads before promoting into it
  select l.lid into blocking_lid
  from public.loads l
  where l.vehicle_id = q_vehicle
    and l.id <> p_load_id
    and l.lstatus in ('ASSIGNED','IN_TRANSIT','AT_UNLOADING')
    and l.deleted_at is null
  limit 1;
  if blocking_lid is not null then
    return jsonb_build_object('ok', false, 'reason', 'vehicle_busy', 'blocking_lid', blocking_lid);
  end if;

  nld := ld || jsonb_build_object(
    'lstatus', 'ASSIGNED', 'vehicleId', q_vehicle,
    'queuedVehicleId', null, 'queuedBehindLoadId', null, 'queuedAt', null);
  nvd := vd || jsonb_build_object(
    'loadId', p_load_id,
    'departure',   coalesce(nullif(p_extra->>'departure',''),   nullif(ld->>'origin',''), vd->>'departure'),
    'destination', coalesce(nullif(p_extra->>'destination',''), nullif(ld->>'dest',''),   vd->>'destination'));

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'op', 'promote',
                              'load_next', nld, 'vehicle_next', nvd, 'vehicle_id', q_vehicle);
  end if;

  update public.loads
     set data = nld, vehicle_id = nullif(nld->>'vehicleId',''),
         version = version + 1, updated_at = v_now
   where id = p_load_id;
  update public.vehicles
     set data = nvd, assigned_load_id = nullif(nvd->>'loadId',''),
         version = version + 1, updated_at = v_now
   where id = q_vehicle;

  insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
  values ('PROMOTE', 'load',    p_load_id, lrec.lid, p_source, jsonb_build_object('vehicle_id', q_vehicle)),
         ('PROMOTE', 'vehicle', q_vehicle, lrec.lid, p_source, jsonb_build_object('load_id', p_load_id));

  return jsonb_build_object('ok', true, 'applied', true, 'op', 'promote',
                            'load_id', p_load_id, 'vehicle_id', q_vehicle);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_purge_deleted_loads(p_days integer DEFAULT 90)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare v_ids text[]; v_count int;
begin
  select array_agg(id) into v_ids
  from public.loads
  where deleted_at is not null
    and deleted_at < now() - make_interval(days => greatest(p_days, 1));

  if v_ids is null then
    return jsonb_build_object('ok', true, 'purged', 0);
  end if;

  perform set_config('app.delete_source', 'purge', true);

  delete from public.load_attachments where load_id = any(v_ids);
  delete from public.pod_records      where load_id = any(v_ids);
  delete from public.loads            where id = any(v_ids);

  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'purged', v_count);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_purge_halt_events(p_days integer DEFAULT 90)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare n integer;
begin
  delete from public.vehicle_halt_events where started_at < now() - make_interval(days => p_days);
  get diagnostics n = row_count;
  return n;
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_queue_load(p_load_id text, p_vehicle_id text, p_behind_load_id text, p_source text DEFAULT 'manual'::text, p_dry_run boolean DEFAULT false, p_load_base_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lrec record; ld jsonb; nld jsonb;
  v_now timestamptz := now();
  iso_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select * into lrec from public.loads where id = p_load_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_load'); end if;
  ld := coalesce(lrec.data, '{}'::jsonb);

  if (ld->>'lstatus') in ('DELIVERED','CANCELLED') then
    return jsonb_build_object('ok', false, 'reason', 'load_terminal', 'lstatus', ld->>'lstatus');
  end if;
  if p_load_base_version is not null and lrec.version is distinct from p_load_base_version then
    return jsonb_build_object('ok', false, 'reason', 'stale_load', 'have', lrec.version);
  end if;

  nld := ld || jsonb_build_object(
    'lstatus', 'QUEUED',
    'vehicleId', null,
    'queuedVehicleId', p_vehicle_id,
    'queuedBehindLoadId', nullif(p_behind_load_id,''),
    'queuedAt', iso_now);

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'op', 'queue', 'load_next', nld);
  end if;

  update public.loads
     set data = nld, vehicle_id = nullif(nld->>'vehicleId',''),
         version = version + 1, updated_at = v_now
   where id = p_load_id;

  insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
  values ('QUEUE', 'load', p_load_id, lrec.lid, p_source,
          jsonb_build_object('queuedVehicleId', p_vehicle_id, 'behind', p_behind_load_id));

  return jsonb_build_object('ok', true, 'applied', true, 'op', 'queue', 'load_id', p_load_id);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_stoppage_observe(p_vehicle_number text, p_speed double precision, p_lat double precision, p_lng double precision, p_address text, p_load_id text, p_seen_at timestamp with time zone, p_stale boolean, p_speed_kmh_max double precision DEFAULT 5, p_radius_m double precision DEFAULT 500, p_min_halt_secs integer DEFAULT 7200)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  cur           public.vehicle_halt_current%rowtype;
  moved_m       double precision;
  is_moving     boolean;
  now_ts        timestamptz := coalesce(p_seen_at, now());
  ended_event   boolean := false;
  opened_event  boolean := false;
  dur_secs      integer;
begin
  select * into cur from public.vehicle_halt_current where vehicle_number = p_vehicle_number;

  -- STALE / no signal → do not change halt state; just record we couldn't see it.
  if p_stale then
    if cur.vehicle_number is null then
      insert into public.vehicle_halt_current(vehicle_number, is_stopped, updated_at)
      values (p_vehicle_number, false, now());
    else
      update public.vehicle_halt_current
        set updated_at = now()
      where vehicle_number = p_vehicle_number;
    end if;
    return jsonb_build_object('vehicle', p_vehicle_number, 'state', 'unknown_stale');
  end if;

  -- Decide moving vs stopped: needs BOTH low speed AND small position delta.
  -- First-ever sighting has no prior position → judge on speed alone this round.
  if cur.vehicle_number is null or cur.last_lat is null then
    moved_m := null;
    is_moving := coalesce(p_speed, 0) >= p_speed_kmh_max;
  else
    moved_m := public.haversine_m(cur.last_lat, cur.last_lng, p_lat, p_lng);
    is_moving := (coalesce(p_speed, 0) >= p_speed_kmh_max) or (coalesce(moved_m, 0) >= p_radius_m);
  end if;

  -- Upsert base row so we always have a current record.
  if cur.vehicle_number is null then
    insert into public.vehicle_halt_current(vehicle_number, is_stopped, last_lat, last_lng, last_seen_at, last_moved_at, updated_at)
    values (p_vehicle_number, false, p_lat, p_lng, now_ts, case when is_moving then now_ts else null end, now());
    select * into cur from public.vehicle_halt_current where vehicle_number = p_vehicle_number;
  end if;

  if is_moving then
    -- If it was stopped, CLOSE the halt. Record to history only if >= min duration.
    if cur.is_stopped and cur.halt_started_at is not null then
      dur_secs := extract(epoch from (now_ts - cur.halt_started_at))::int;
      if dur_secs >= p_min_halt_secs then
        insert into public.vehicle_halt_events(vehicle_number, started_at, ended_at, duration_seconds, lat, lng, address, load_id)
        values (p_vehicle_number, cur.halt_started_at, now_ts, dur_secs, cur.lat, cur.lng, cur.address, cur.load_id);
        ended_event := true;
      end if;
    end if;
    update public.vehicle_halt_current
      set is_stopped = false, halt_started_at = null,
          lat = null, lng = null, address = null, load_id = null,
          last_lat = p_lat, last_lng = p_lng, last_seen_at = now_ts, last_moved_at = now_ts,
          updated_at = now()
    where vehicle_number = p_vehicle_number;
  else
    -- STOPPED.
    if cur.is_stopped then
      -- still stopped → keep started_at; refresh last_seen + address.
      update public.vehicle_halt_current
        set address = coalesce(p_address, address),
            last_seen_at = now_ts, updated_at = now()
      where vehicle_number = p_vehicle_number;
    else
      -- moving → stopped: OPEN a halt. Back-date start to last_moved_at if known.
      opened_event := true;
      update public.vehicle_halt_current
        set is_stopped = true,
            halt_started_at = coalesce(cur.last_moved_at, now_ts),
            lat = p_lat, lng = p_lng, address = p_address, load_id = p_load_id,
            last_lat = p_lat, last_lng = p_lng, last_seen_at = now_ts,
            updated_at = now()
      where vehicle_number = p_vehicle_number;
    end if;
  end if;

  select * into cur from public.vehicle_halt_current where vehicle_number = p_vehicle_number;
  return jsonb_build_object(
    'vehicle', p_vehicle_number,
    'is_stopped', cur.is_stopped,
    'halt_started_at', cur.halt_started_at,
    'moved_m', moved_m,
    'opened', opened_event,
    'closed_recorded', ended_event
  );
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_stoppage_observe_batch(p_samples jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  s          jsonb;
  r          jsonb;
  observed   int := 0;
  opened     int := 0;
  closed     int := 0;
  stale_ct   int := 0;
  errors     int := 0;
begin
  if p_samples is null or jsonb_typeof(p_samples) <> 'array' then
    return jsonb_build_object('ok', false, 'error', 'expected json array');
  end if;

  for s in select * from jsonb_array_elements(p_samples)
  loop
    begin
      r := public.app_stoppage_observe(
        (s->>'vnum'),
        nullif(s->>'speed','')::double precision,
        nullif(s->>'lat','')::double precision,
        nullif(s->>'lng','')::double precision,
        (s->>'address'),
        (s->>'load_id'),
        (s->>'seen_at')::timestamptz,
        coalesce((s->>'stale')::boolean, false)
      );
      observed := observed + 1;
      if coalesce((r->>'stale')::boolean, false) then stale_ct := stale_ct + 1; end if;
      if coalesce((r->>'opened')::boolean, false) then opened := opened + 1; end if;
      if coalesce((r->>'closed_recorded')::boolean, false) then closed := closed + 1; end if;
    exception when others then
      errors := errors + 1;
    end;
  end loop;

  return jsonb_build_object('ok', true, 'observed', observed, 'stale', stale_ct,
                            'opened', opened, 'closed_recorded', closed, 'errors', errors);
end;
$function$
;

CREATE OR REPLACE FUNCTION public.app_unassign_for_vehicle_delete(p_vehicle_id text, p_reason text DEFAULT 'vehicle_delete'::text, p_dry_run boolean DEFAULT false, p_vehicle_base_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  vrec record; lrec record;
  vd jsonb;
  active_ids text[] := '{}';
  queued_ids text[] := '{}';
  affected   text[] := '{}';
  v_now timestamptz := now();
begin
  -- lock + validate the vehicle being deleted
  select * into vrec from public.vehicles where id = p_vehicle_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_vehicle'); end if;
  if p_vehicle_base_version is not null and vrec.version is distinct from p_vehicle_base_version then
    return jsonb_build_object('ok', false, 'reason', 'stale_vehicle', 'have', vrec.version);
  end if;
  vd := coalesce(vrec.data, '{}'::jsonb);

  -- active load(s) assigned to this vehicle (mirror column)
  for lrec in
    select id from public.loads
    where vehicle_id = p_vehicle_id and deleted_at is null
    for update
  loop
    active_ids := active_ids || lrec.id;
    affected   := affected || lrec.id;
  end loop;

  -- queued load(s) waiting behind this vehicle (blob pointer)
  for lrec in
    select id from public.loads
    where data->>'queuedVehicleId' = p_vehicle_id and deleted_at is null
    for update
  loop
    if not (lrec.id = any(affected)) then
      queued_ids := queued_ids || lrec.id;
      affected   := affected || lrec.id;
    end if;
  end loop;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'op', 'unassign_for_vehicle_delete',
      'vehicle_id', p_vehicle_id,
      'active_load_reset',  coalesce(array_length(active_ids,1), 0),
      'queued_loads_reset', coalesce(array_length(queued_ids,1), 0),
      'affected_load_ids',  to_jsonb(affected));
  end if;

  -- reset every affected load → PENDING, clear vehicle + queue pointers; version + audit
  for lrec in
    select * from public.loads where id = any(affected) for update
  loop
    update public.loads
       set data = coalesce(data, '{}'::jsonb) || jsonb_build_object(
             'vehicleId', null, 'queuedVehicleId', null, 'queuedBehindLoadId', null,
             'queuedAt', null, 'lstatus', 'PENDING', 'manualUnloadOverride', false),
           vehicle_id = null,
           version = version + 1,
           updated_at = v_now
     where id = lrec.id;

    insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
    values ('UNASSIGN', 'load', lrec.id, lrec.lid, 'vehicle_delete',
            jsonb_build_object('reason', p_reason, 'vehicle_id', p_vehicle_id,
                               'was', lrec.data->>'lstatus',
                               'queued', (lrec.id = any(queued_ids))));
  end loop;

  -- defensively clear the vehicle's own mirror so no drift lingers if the caller's
  -- subsequent delete is delayed/fails (the vehicle row itself is deleted by the caller).
  update public.vehicles
     set data = vd || jsonb_build_object('loadId', null),
         assigned_load_id = null,
         version = version + 1,
         updated_at = v_now
   where id = p_vehicle_id;

  return jsonb_build_object('ok', true, 'applied', true, 'op', 'unassign_for_vehicle_delete',
    'vehicle_id', p_vehicle_id,
    'active_load_reset',  coalesce(array_length(active_ids,1), 0),
    'queued_loads_reset', coalesce(array_length(queued_ids,1), 0),
    'affected_load_ids',  to_jsonb(affected),
    'dry_run', false);
end
$function$
;

CREATE OR REPLACE FUNCTION public.app_unassign_load(p_load_id text, p_source text DEFAULT 'manual'::text, p_dry_run boolean DEFAULT false, p_load_base_version bigint DEFAULT NULL::bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  lrec record; vrec record; ld jsonb; vd jsonb; nld jsonb; nvd jsonb;
  cur_vehicle text; other_inprogress text; other_queued_load record; promoted_load text;
  v_now timestamptz := now();
  iso_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  select * into lrec from public.loads where id = p_load_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_load'); end if;
  ld := coalesce(lrec.data, '{}'::jsonb);

  -- NEW (audit fix): terminal/deleted guard — the guard assign & queue already
  -- have. Unassigning a DELIVERED/CANCELLED/deleted load would resurrect it to
  -- PENDING through a sanctioned lane. Refuse.
  if lrec.deleted_at is not null
     or (ld->>'lstatus') in ('DELIVERED','CANCELLED','DELETED') then
    return jsonb_build_object('ok', false, 'reason', 'load_terminal', 'lstatus', ld->>'lstatus');
  end if;

  if p_load_base_version is not null and lrec.version is distinct from p_load_base_version then
    return jsonb_build_object('ok', false, 'reason', 'stale_load', 'have', lrec.version);
  end if;

  cur_vehicle := nullif(ld->>'vehicleId','');

  -- the unassigned load → PENDING (always)
  nld := ld || jsonb_build_object(
    'vehicleId', null, 'queuedVehicleId', null, 'queuedBehindLoadId', null,
    'queuedAt', null, 'lstatus', 'PENDING', 'manualUnloadOverride', false);

  -- vehicle-freeing (only if the load had an active vehicle)
  if cur_vehicle is not null then
    select * into vrec from public.vehicles where id = cur_vehicle for update;
    if found then
      vd := coalesce(vrec.data, '{}'::jsonb);

      -- (a) another in-progress load on this vehicle → keep vehicle on that load
      select l.id into other_inprogress
      from public.loads l
      where l.vehicle_id = cur_vehicle and l.id <> p_load_id
        and l.lstatus in ('IN_TRANSIT','AT_UNLOADING','ASSIGNED')
        and l.deleted_at is null
      limit 1;

      if other_inprogress is not null then
        nvd := vd || jsonb_build_object('loadId', other_inprogress);
      else
        -- (b) a queued load waiting on this vehicle → free + link + promote it
        select * into other_queued_load
        from public.loads l
        where l.data->>'queuedVehicleId' = cur_vehicle and l.id <> p_load_id
          and l.lstatus = 'QUEUED' and l.deleted_at is null
        order by l.data->>'queuedAt' asc nulls last
        limit 1;

        if found then
          nvd := vd || jsonb_build_object(
            'vstatus','AVAILABLE','loadId', other_queued_load.id,
            'availableSince', iso_now, 'availableAfterDelivery', true,
            'sentForLoadingAt', null, 'atLoadingAt', null, 'waitingClearEta', null,
            'sentLoadingClearEta', null, 'atLoadingClearEta', null);
          promoted_load := other_queued_load.id;
        else
          -- (c) nothing else → vehicle fully free
          nvd := vd || jsonb_build_object(
            'vstatus','AVAILABLE','loadId', null,
            'availableSince', iso_now, 'availableAfterDelivery', true,
            'sentForLoadingAt', null, 'atLoadingAt', null, 'waitingClearEta', null,
            'sentLoadingClearEta', null, 'atLoadingClearEta', null);
        end if;
      end if;
    end if;
  end if;

  if p_dry_run then
    return jsonb_build_object('ok', true, 'dry_run', true, 'op', 'unassign',
                              'load_next', nld, 'vehicle_id', cur_vehicle,
                              'vehicle_next', nvd, 'promoted_load', promoted_load);
  end if;

  update public.loads
     set data = nld, vehicle_id = nullif(nld->>'vehicleId',''),
         version = version + 1, updated_at = v_now
   where id = p_load_id;

  if cur_vehicle is not null and nvd is not null then
    update public.vehicles
       set data = nvd, assigned_load_id = nullif(nvd->>'loadId',''),
           version = version + 1, updated_at = v_now
     where id = cur_vehicle;
  end if;

  -- cascade: promote the queued load (its own ASSIGNED write + audit)
  if promoted_load is not null then
    update public.loads
       set data = data || jsonb_build_object(
             'lstatus','ASSIGNED','vehicleId', cur_vehicle,
             'queuedVehicleId', null, 'queuedBehindLoadId', null, 'queuedAt', null),
           vehicle_id = cur_vehicle,
           version = version + 1, updated_at = v_now
     where id = promoted_load;
    insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
    select 'PROMOTE','load', promoted_load, l.lid, p_source, jsonb_build_object('vehicle_id', cur_vehicle, 'via','unassign')
    from public.loads l where l.id = promoted_load;
  end if;

  insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
  values ('UNASSIGN','load', p_load_id, lrec.lid, p_source, jsonb_build_object('freed_vehicle', cur_vehicle));

  return jsonb_build_object('ok', true, 'applied', true, 'op', 'unassign',
                            'load_id', p_load_id, 'vehicle_id', cur_vehicle, 'promoted_load', promoted_load);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_vehicle_transition(p_vehicle_id text, p_action text, p_eta text DEFAULT NULL::text, p_explicit_load_id text DEFAULT NULL::text, p_lr_date text DEFAULT NULL::text, p_dry_run boolean DEFAULT false, p_source text DEFAULT 'manual'::text, p_extra jsonb DEFAULT '{}'::jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v record; vd jsonb; nd jsonb;
  cur_load_id text; resolved_current text; blocking_lid text;
  load_rec record; ld jsonb; nld jsonb := null; load_write boolean := false;
  v_now timestamptz := now();
  iso_now text := to_char(now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  ist_min text := to_char(now() at time zone 'Asia/Kolkata', 'YYYY-MM-DD"T"HH24:MI');
  is_auto boolean := (p_source = 'auto');
  v_reason text := case p_action
                     when 'AT_UNLOADING' then 'auto_promote'
                     when 'IN_TRANSIT'   then 'auto_demote'
                     else lower(p_action) end;
begin
  select * into v from public.vehicles where id = p_vehicle_id for update;
  if not found then return jsonb_build_object('ok', false, 'reason', 'no_vehicle'); end if;
  vd := coalesce(v.data, '{}'::jsonb);

  if p_action = 'DELIVERED' then
    return jsonb_build_object('ok', false, 'reason', 'use_deliver_load');
  end if;

  cur_load_id := coalesce(nullif(p_explicit_load_id, ''), nullif(vd->>'loadId', ''));
  resolved_current := cur_load_id;

  -- ── Legality guard ─────────────────────────────────────────────────────────
  if p_action <> 'MAINTENANCE' then
    select l.lid into blocking_lid
    from public.loads l
    where l.vehicle_id = p_vehicle_id
      and (resolved_current is null or l.id <> resolved_current)
      and l.lstatus in ('IN_TRANSIT', 'AT_UNLOADING', 'ASSIGNED')
      and l.deleted_at is null
    limit 1;
    if blocking_lid is not null then
      return jsonb_build_object('ok', false, 'reason', 'blocked', 'blocking_lid', blocking_lid);
    end if;
  end if;

  nd := vd;

  -- ── Vehicle mutation per action ────────────────────────────────────────────
  if p_action = 'SENT_FOR_LOADING' then
    nd := nd || jsonb_build_object(
      'vstatus', 'SENT_FOR_LOADING',
      'sentForLoadingAt', coalesce(nullif(vd->>'sentForLoadingAt',''), iso_now),
      'sentLoadingClearEta', coalesce(nullif(p_eta,''), nullif(vd->>'sentLoadingClearEta','')),
      'atLoadingAt', null, 'atLoadingClearEta', null, 'atUnloadingAt', null,
      'availableSince', null, 'waitingClearEta', null, 'availableAfterDelivery', false);

  elsif p_action = 'AT_LOADING' then
    nd := nd || jsonb_build_object(
      'vstatus', 'AT_LOADING',
      'atLoadingAt', coalesce(nullif(vd->>'atLoadingAt',''), iso_now),
      'atLoadingClearEta', coalesce(nullif(p_eta,''), nullif(vd->>'atLoadingClearEta','')),
      'sentForLoadingAt', null, 'sentLoadingClearEta', null, 'atUnloadingAt', null,
      'availableSince', null, 'waitingClearEta', null, 'availableAfterDelivery', false);

  elsif p_action = 'IN_TRANSIT' then
    nd := nd || jsonb_build_object(
      'vstatus', 'IN_TRANSIT',
      'sentForLoadingAt', null, 'sentLoadingClearEta', null, 'atLoadingAt', null,
      'atLoadingClearEta', null, 'atUnloadingAt', null, 'availableSince', null,
      'waitingClearEta', null, 'availableAfterDelivery', false);
    if nullif(p_eta,'')     is not null then nd := nd || jsonb_build_object('eta', p_eta); end if;
    if nullif(p_lr_date,'') is not null then nd := nd || jsonb_build_object('lrDate', p_lr_date); end if;

  elsif p_action = 'AT_UNLOADING' then
    nd := nd || jsonb_build_object(
      'vstatus', 'AT_UNLOADING',
      'sentForLoadingAt', null, 'sentLoadingClearEta', null, 'atLoadingAt', null,
      'atLoadingClearEta', null, 'availableSince', null, 'waitingClearEta', null,
      'availableAfterDelivery', false);
    if (vd->>'vstatus') is distinct from 'AT_UNLOADING' then
      nd := nd || jsonb_build_object('atUnloadingAt', ist_min);
    end if;

  elsif p_action = 'AVAILABLE' then
    nd := nd || jsonb_build_object(
      'vstatus', 'AVAILABLE',
      'availableSince', coalesce(nullif(vd->>'availableSince',''), iso_now),
      'waitingClearEta', nullif(vd->>'waitingClearEta',''),
      'availableAfterDelivery', false,
      'sentForLoadingAt', null, 'sentLoadingClearEta', null, 'atLoadingAt', null,
      'atLoadingClearEta', null, 'atUnloadingAt', null);

  elsif p_action = 'MAINTENANCE' then
    nd := nd || jsonb_build_object(
      'vstatus', 'MAINTENANCE',
      'sentForLoadingAt', null, 'sentLoadingClearEta', null, 'atLoadingAt', null,
      'atLoadingClearEta', null, 'atUnloadingAt', null);

  else
    return jsonb_build_object('ok', false, 'reason', 'unknown_action', 'action', p_action);
  end if;

  -- ── Load mutation per action ───────────────────────────────────────────────
  if cur_load_id is not null then
    select * into load_rec from public.loads where id = cur_load_id for update;
    if found then
      ld := coalesce(load_rec.data, '{}'::jsonb);

      if p_action = 'IN_TRANSIT' then
        nld := ld || jsonb_build_object('lstatus', 'IN_TRANSIT');
        if nullif(p_eta,'')     is not null then nld := nld || jsonb_build_object('delivery', p_eta); end if;
        if nullif(p_lr_date,'') is not null then nld := nld || jsonb_build_object('lrDate', p_lr_date); end if;
        load_write := true;

      elsif p_action = 'AT_UNLOADING' then
        if (ld->>'lstatus') is distinct from 'DELIVERED'
           and (ld->>'lstatus') is distinct from 'CANCELLED' then
          nld := ld || jsonb_build_object(
            'lstatus', 'AT_UNLOADING',
            'manualUnloadOverride', (p_source = 'manual'));
          load_write := true;
        end if;

      elsif p_action = 'SENT_FOR_LOADING' and nullif(p_eta,'') is not null then
        nld := ld || jsonb_build_object('delivery', p_eta);
        load_write := true;
      end if;
    end if;
  end if;

  -- ── AUTO mode: merge the decider's geofence fields ─────────────────────────
  if is_auto then
    if p_extra ? 'vehicle' then nd := nd || (p_extra->'vehicle'); end if;
    if load_write and p_extra ? 'load' then nld := nld || (p_extra->'load'); end if;
  end if;

  -- ── DRY RUN: return computed states, write nothing ─────────────────────────
  if p_dry_run then
    return jsonb_build_object(
      'ok', true, 'dry_run', true, 'action', p_action, 'source', p_source,
      'vehicle_id', p_vehicle_id, 'vehicle_next', nd,
      'load_id', cur_load_id, 'load_write', load_write, 'load_next', nld);
  end if;

  -- NEW (audit dedup): in AUTO mode the engine writes its own richer audit rows
  -- below, so mark this transaction — the status triggers see the flag (they fire
  -- on the UPDATEs that follow) and stay silent. Manual mode does NOT set it:
  -- there the trigger is the single logger.
  if is_auto then
    perform set_config('app.engine_audited', '1', true);
  end if;

  -- ── ATOMIC WRITE (both or neither) ─────────────────────────────────────────
  update public.vehicles
     set data = nd,
         assigned_load_id = nullif(nd->>'loadId',''),
         version = version + 1, updated_at = v_now
   where id = p_vehicle_id;

  if load_write then
    update public.loads
       set data = nld,
           vehicle_id = nullif(nld->>'vehicleId',''),
           version = version + 1, updated_at = v_now
     where id = cur_load_id;
  end if;

  -- ── AUDIT (auto/cron path only; in the SAME transaction as the writes) ──────
  -- Manual transitions are logged by the existing client emitter — not here,
  -- to avoid duplicates. Only log on a REAL status change (no idempotent noise).
  if is_auto then
    if (vd->>'vstatus') is distinct from (nd->>'vstatus') then
      insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
      values ('vehicle.status_change', 'vehicle', p_vehicle_id, nullif(nd->>'lid',''), 'cron',
              jsonb_build_object(
                'from', vd->>'vstatus', 'to', nd->>'vstatus',
                'reason', v_reason, 'vnum', nd->>'vnum', 'load_id', cur_load_id));
    end if;

    if load_write and (ld->>'lstatus') is distinct from (nld->>'lstatus') then
      insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
      values ('load.status_change', 'load', cur_load_id, nullif(nld->>'lid',''), 'cron',
              jsonb_build_object(
                'from', ld->>'lstatus', 'to', nld->>'lstatus',
                'reason', v_reason, 'vnum', nd->>'vnum'));
    end if;
  end if;

  return jsonb_build_object('ok', true, 'applied', true, 'action', p_action, 'source', p_source,
                            'vehicle_id', p_vehicle_id, 'load_id', case when load_write then cur_load_id else null end);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_vehicle_transition_ok(old_d jsonb, new_d jsonb)
 RETURNS boolean
 LANGUAGE sql
 IMMUTABLE
AS $function$
  select true;
$function$
;

CREATE OR REPLACE FUNCTION public.app_write_load(p_id text, p_lid text, p_data jsonb, p_base_version bigint DEFAULT NULL::bigint, p_enforce boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  cur record; would_reject boolean := false; reject_reason text := null; new_version bigint;
  blind boolean := false;
  eff jsonb;                         -- effective blob actually written
  v_delivered timestamptz;
begin
  select * into cur from public.loads where id = p_id for update;

  if not found then
    -- INSERT path: no current row to preserve from, so canonical-blind is a no-op.
    -- (A brand-new load legitimately carries its initial lstatus/vehicleId.)
    v_delivered := nullif(p_data->>'deliveredAt','')::timestamptz;
    insert into public.loads (id, lid, data, version, updated_at, vehicle_id, delivered_at)
    values (p_id, p_lid, p_data, 1, now(), p_data->>'vehicleId', v_delivered);
    return jsonb_build_object('ok', true, 'applied', true, 'would_reject', false, 'reason', null, 'version', 1);
  end if;

  -- ABSOLUTE DELETE GUARD (not gated by p_enforce): a soft-deleted load can only
  -- stay deleted. Any write that isn't itself keeping it DELETED is refused and
  -- changes nothing. This is the structural fix for stale-client resurrection.
  if cur.deleted_at is not null
     and coalesce(p_data->>'lstatus','') <> 'DELETED' then
    return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true,
                              'reason', 'deleted', 'version', cur.version, 'current', cur.data);
  end if;

  -- ── Phase 4 canonical-blind preserve (flag-gated) ─────────────────────────
  -- Build the effective blob: start from incoming p_data, then FORCE canonical
  -- lifecycle fields back to the current server row's values (incoming values for
  -- those keys are discarded). Snapshots are preserve-if-present / fill-if-missing.
  begin
    select (value = 'true'::jsonb) into blind
    from public.app_settings where key = 'writeLoad.canonicalBlind';
  exception when others then blind := false; end;
  blind := coalesce(blind, false);

  if blind then
    eff := p_data
      -- hard canonical fields: always from current server truth
      || jsonb_build_object('lstatus',              cur.data->'lstatus')
      || jsonb_build_object('vehicleId',            cur.data->'vehicleId')
      || jsonb_build_object('consigneeDeliveries',  cur.data->'consigneeDeliveries')
      || jsonb_build_object('deliveredAt',          cur.data->'deliveredAt')
      || jsonb_build_object('queuedVehicleId',      cur.data->'queuedVehicleId')
      || jsonb_build_object('queuedBehindLoadId',   cur.data->'queuedBehindLoadId')
      || jsonb_build_object('queuedAt',             cur.data->'queuedAt')
      || jsonb_build_object('manualUnloadOverride', cur.data->'manualUnloadOverride');

    -- jsonb_build_object with a NULL jsonb value writes a JSON null key; strip any
    -- canonical key that did not exist on the current row so we don't introduce nulls.
    eff := eff - (
      select coalesce(array_agg(k), '{}')
      from unnest(array['lstatus','vehicleId','consigneeDeliveries','deliveredAt',
                        'queuedVehicleId','queuedBehindLoadId','queuedAt','manualUnloadOverride']) k
      where (cur.data ? k) = false
    );

    -- Snapshots: never overwrite an existing non-null snapshot from an object write;
    -- allow fill when the current row has none.
    if nullif(cur.data->>'vnumSnapshot','')   is not null then eff := eff || jsonb_build_object('vnumSnapshot',   cur.data->'vnumSnapshot');   end if;
    if nullif(cur.data->>'driverSnapshot','') is not null then eff := eff || jsonb_build_object('driverSnapshot', cur.data->'driverSnapshot'); end if;
    if nullif(cur.data->>'mobileSnapshot','') is not null then eff := eff || jsonb_build_object('mobileSnapshot', cur.data->'mobileSnapshot'); end if;
  else
    eff := p_data;   -- flag OFF → today's verbatim behavior
  end if;
  -- ──────────────────────────────────────────────────────────────────────────

  if p_base_version is not null and p_base_version is distinct from cur.version then
    would_reject := true; reject_reason := 'stale';
  elsif not public.app_load_transition_ok(cur.data, eff) then
    would_reject := true; reject_reason := 'illegal';
  end if;

  if would_reject and p_enforce then
    return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true,
                              'reason', reject_reason, 'version', cur.version, 'current', cur.data);
  end if;

  -- mirror columns sourced from the EFFECTIVE (preserved) blob, never raw p_data.
  v_delivered := nullif(eff->>'deliveredAt','')::timestamptz;
  new_version := cur.version + 1;
  update public.loads
     set data = eff, lid = coalesce(p_lid, lid),
         version = new_version, updated_at = now(),
         vehicle_id = eff->>'vehicleId',
         delivered_at = v_delivered
   where id = p_id;

  return jsonb_build_object('ok', true, 'applied', true, 'would_reject', would_reject,
                            'reason', reject_reason, 'version', new_version,
                            'current', case when would_reject then cur.data else null end);
end $function$
;

CREATE OR REPLACE FUNCTION public.app_write_pair(p_vehicle_id text, p_vehicle_data jsonb, p_load_id text, p_load_lid text, p_load_data jsonb, p_enforce boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_now timestamptz := now(); cur_load record;
  would_reject boolean := false; reject_reason text := null;
begin
  select * into cur_load from public.loads where id = p_load_id for update;
  if found then
    -- Blocks resurrecting a DELIVERED load back to an active status.
    if not public.app_load_transition_ok(cur_load.data, p_load_data) then
      would_reject := true; reject_reason := 'illegal';
    end if;
  end if;

  if would_reject and p_enforce then
    return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true, 'reason', reject_reason);
  end if;

  update public.vehicles
  set data = p_vehicle_data,
      vnum = coalesce(nullif(p_vehicle_data->>'vnum',''), vnum),
      assigned_load_id = nullif(p_vehicle_data->>'loadId',''),
      version = version + 1, updated_at = v_now
  where id = p_vehicle_id;

  update public.loads
  set data = p_load_data,
      lid = coalesce(nullif(p_load_lid,''), lid),
      vehicle_id = nullif(p_load_data->>'vehicleId',''),
      delivered_at = nullif(p_load_data->>'deliveredAt','')::timestamptz,
      version = version + 1, updated_at = v_now
  where id = p_load_id;

  return jsonb_build_object('ok', true, 'applied', true, 'would_reject', would_reject, 'reason', reject_reason);
end; $function$
;

CREATE OR REPLACE FUNCTION public.app_write_vehicle(p_id text, p_vnum text, p_data jsonb, p_base_version bigint DEFAULT NULL::bigint, p_enforce boolean DEFAULT false)
 RETURNS jsonb
 LANGUAGE plpgsql
AS $function$
declare
  cur record;
  blind boolean := false;
  eff jsonb;
  new_version bigint;
begin
  select * into cur from public.vehicles where id = p_id for update;

  -- ── INSERT path ───────────────────────────────────────────────────────────
  -- No current row to preserve from; a brand-new vehicle legitimately carries its
  -- initial vstatus/loadId. Mirror the prior raw upsert shape (id, vnum, data).
  if not found then
    insert into public.vehicles (id, vnum, data, version, updated_at, assigned_load_id)
    values (p_id, p_vnum, p_data, 1, now(), nullif(p_data->>'loadId',''));
    return jsonb_build_object('ok', true, 'applied', true, 'would_reject', false,
                              'reason', null, 'version', 1);
  end if;

  -- ── Optional stale-write reject (only when enforcing + base version given) ──
  -- Mirrors app_write_load's versioning posture: reject a write built on an old
  -- version so a stale client blob can't clobber newer server state.
  if p_enforce and p_base_version is not null
     and cur.version is not null and cur.version is distinct from p_base_version then
    return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true,
                              'reason', 'stale_version', 'version', cur.version, 'current', cur.data);
  end if;

  -- ── Canonical-blind preserve (flag-gated) ─────────────────────────────────
  -- When ON: start from incoming p_data, then FORCE the canonical vehicle fields
  -- (vstatus, loadId) back to the CURRENT server row's values — incoming values
  -- for those keys are discarded. A generic object write can no longer change
  -- vstatus/loadId; only the guarded lanes can. Flag OFF ⇒ verbatim p_data
  -- (byte-identical to the prior raw upsert behaviour).
  begin
    select (value = 'true'::jsonb) into blind
    from public.app_settings where key = 'writeVehicle.canonicalBlind';
  exception when others then blind := false; end;
  blind := coalesce(blind, false);

  if blind then
    eff := p_data
      || jsonb_build_object('vstatus', cur.data->'vstatus')
      || jsonb_build_object('loadId',  cur.data->'loadId');

    -- Strip any canonical key that did NOT exist on the current row, so we don't
    -- introduce JSON null keys (jsonb_build_object writes null for a missing key).
    eff := eff - (
      select coalesce(array_agg(k), '{}')
      from unnest(array['vstatus','loadId']) k
      where (cur.data ? k) = false
    );
  else
    eff := p_data;   -- flag OFF → verbatim (today's raw-upsert behaviour)
  end if;

  new_version := coalesce(cur.version, 0) + 1;
  update public.vehicles
     set data = eff,
         vnum = coalesce(p_vnum, vnum),
         assigned_load_id = nullif(eff->>'loadId',''),
         version = new_version,
         updated_at = now()
   where id = p_id;

  return jsonb_build_object('ok', true, 'applied', true, 'would_reject', false,
                            'reason', null, 'version', new_version);
end;
$function$
;
