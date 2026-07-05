-- ════════════════════════════════════════════════════════════════════════════
-- 0007_patch_writes.sql — Phase F2: field-level object writes.
--
-- THE CLOBBER THIS KILLS: two dispatchers editing DIFFERENT fields of the same
-- load (one fixes the weight, the other the notes) — today the slower save
-- overwrites the faster one's field with its stale copy (whole-blob LWW).
--
-- Design: app_write_load / app_write_vehicle gain `p_patch jsonb` (only the
-- fields the client actually changed) + `p_removed text[]` (keys deleted).
-- When p_patch is present, the server builds the effective incoming blob as
--     current_server_data || p_patch  (minus p_removed)
-- UNDER THE ROW LOCK — then flows through the UNCHANGED existing pipeline:
-- canonical-blind preserve, transition guard, versioning, mirror columns.
-- Concurrent different-field edits now both land. Same-field edits remain
-- last-write-wins (correct: someone must win).
--
-- Compatibility: p_data full-blob calls behave byte-identically (creations,
-- legacy clients, the kill-switch path). Patch on a MISSING row is refused —
-- creations always send the full blob.
--
-- Signature changes ⇒ explicit DROPs first (old named-arg calls keep working
-- against the new signatures since the new params default NULL).
-- Deploy order: THIS FILE FIRST, then the supaSync.ts cutover.
-- ════════════════════════════════════════════════════════════════════════════

drop function if exists public.app_write_load(text, text, jsonb, bigint, boolean);
drop function if exists public.app_write_vehicle(text, text, jsonb, bigint, boolean);

CREATE OR REPLACE FUNCTION public.app_write_load(p_id text, p_lid text, p_data jsonb, p_base_version bigint DEFAULT NULL::bigint, p_enforce boolean DEFAULT false, p_patch jsonb DEFAULT NULL::jsonb, p_removed text[] DEFAULT NULL::text[])
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
    -- Patch requires a base row; creations must send the full blob.
    if p_patch is not null then
      return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true,
                                'reason', 'no_row_for_patch', 'version', null);
    end if;
    -- INSERT path: no current row to preserve from, so canonical-blind is a no-op.
    -- (A brand-new load legitimately carries its initial lstatus/vehicleId.)
    v_delivered := nullif(p_data->>'deliveredAt','')::timestamptz;
    insert into public.loads (id, lid, data, version, updated_at, vehicle_id, delivered_at)
    values (p_id, p_lid, p_data, 1, now(), p_data->>'vehicleId', v_delivered);
    return jsonb_build_object('ok', true, 'applied', true, 'would_reject', false, 'reason', null, 'version', 1);
  end if;

  -- F2: field-patch mode — merge ONLY the changed keys onto CURRENT server data,
  -- under this row lock. Everything downstream (blind preserve, guards, mirrors)
  -- then operates on this merged blob exactly as if the client had sent it whole —
  -- except concurrent edits to OTHER fields are no longer overwritten.
  if p_patch is not null then
    p_data := cur.data || p_patch;
    if p_removed is not null and array_length(p_removed, 1) > 0 then
      p_data := p_data - p_removed;
    end if;
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
  begin
    select (value = 'true'::jsonb) into blind
    from public.app_settings where key = 'writeLoad.canonicalBlind';
  exception when others then blind := false; end;
  blind := coalesce(blind, false);

  if blind then
    eff := p_data
      || jsonb_build_object('lstatus',              cur.data->'lstatus')
      || jsonb_build_object('vehicleId',            cur.data->'vehicleId')
      || jsonb_build_object('consigneeDeliveries',  cur.data->'consigneeDeliveries')
      || jsonb_build_object('deliveredAt',          cur.data->'deliveredAt')
      || jsonb_build_object('queuedVehicleId',      cur.data->'queuedVehicleId')
      || jsonb_build_object('queuedBehindLoadId',   cur.data->'queuedBehindLoadId')
      || jsonb_build_object('queuedAt',             cur.data->'queuedAt')
      || jsonb_build_object('manualUnloadOverride', cur.data->'manualUnloadOverride');

    eff := eff - (
      select coalesce(array_agg(k), '{}')
      from unnest(array['lstatus','vehicleId','consigneeDeliveries','deliveredAt',
                        'queuedVehicleId','queuedBehindLoadId','queuedAt','manualUnloadOverride']) k
      where (cur.data ? k) = false
    );

    if nullif(cur.data->>'vnumSnapshot','')   is not null then eff := eff || jsonb_build_object('vnumSnapshot',   cur.data->'vnumSnapshot');   end if;
    if nullif(cur.data->>'driverSnapshot','') is not null then eff := eff || jsonb_build_object('driverSnapshot', cur.data->'driverSnapshot'); end if;
    if nullif(cur.data->>'mobileSnapshot','') is not null then eff := eff || jsonb_build_object('mobileSnapshot', cur.data->'mobileSnapshot'); end if;
  else
    eff := p_data;   -- flag OFF → today's verbatim behavior
  end if;
  -- ──────────────────────────────────────────────────────────────────────────

  if p_base_version is not null and p_base_version is distinct from cur.version then
    -- F2 nuance: a PATCH built on a stale version is still safe to apply — it
    -- merges onto CURRENT data and touches only its own keys. Whole-blob writes
    -- keep strict staleness (a stale full blob would clobber everything).
    if p_patch is null then
      would_reject := true; reject_reason := 'stale';
    end if;
  end if;
  if not would_reject and not public.app_load_transition_ok(cur.data, eff) then
    would_reject := true; reject_reason := 'illegal';
  end if;

  if would_reject and p_enforce then
    return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true,
                              'reason', reject_reason, 'version', cur.version, 'current', cur.data);
  end if;

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
end $function$;

CREATE OR REPLACE FUNCTION public.app_write_vehicle(p_id text, p_vnum text, p_data jsonb, p_base_version bigint DEFAULT NULL::bigint, p_enforce boolean DEFAULT false, p_patch jsonb DEFAULT NULL::jsonb, p_removed text[] DEFAULT NULL::text[])
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

  if not found then
    if p_patch is not null then
      return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true,
                                'reason', 'no_row_for_patch', 'version', null);
    end if;
    insert into public.vehicles (id, vnum, data, version, updated_at, assigned_load_id)
    values (p_id, p_vnum, p_data, 1, now(), nullif(p_data->>'loadId',''));
    return jsonb_build_object('ok', true, 'applied', true, 'would_reject', false,
                              'reason', null, 'version', 1);
  end if;

  -- F2: field-patch mode — merge changed keys onto CURRENT server data under lock.
  if p_patch is not null then
    p_data := cur.data || p_patch;
    if p_removed is not null and array_length(p_removed, 1) > 0 then
      p_data := p_data - p_removed;
    end if;
  end if;

  -- Optional stale-write reject: whole-blob only (a stale PATCH is safe — it
  -- merges onto current and touches only its own keys).
  if p_enforce and p_base_version is not null and p_patch is null
     and cur.version is not null and cur.version is distinct from p_base_version then
    return jsonb_build_object('ok', false, 'applied', false, 'would_reject', true,
                              'reason', 'stale_version', 'version', cur.version, 'current', cur.data);
  end if;

  -- ── Canonical-blind preserve (flag-gated) ─────────────────────────────────
  begin
    select (value = 'true'::jsonb) into blind
    from public.app_settings where key = 'writeVehicle.canonicalBlind';
  exception when others then blind := false; end;
  blind := coalesce(blind, false);

  if blind then
    eff := p_data
      || jsonb_build_object('vstatus', cur.data->'vstatus')
      || jsonb_build_object('loadId',  cur.data->'loadId');

    eff := eff - (
      select coalesce(array_agg(k), '{}')
      from unnest(array['vstatus','loadId']) k
      where (cur.data ? k) = false
    );
  else
    eff := p_data;   -- flag OFF → verbatim (raw-upsert behaviour)
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
$function$;

-- ── Verify after running ─────────────────────────────────────────────────────
-- Patch semantics proof (uses a real load id; read-only-ish — changes one junk key
-- then removes it):
--   select app_write_load('SOME_LOAD_ID', null, '{}'::jsonb, null, true,
--                         '{"f2ProofKey":"hello"}'::jsonb, null);        -- adds one key
--   select data->>'f2ProofKey' from loads where id='SOME_LOAD_ID';       -- 'hello', rest untouched
--   select app_write_load('SOME_LOAD_ID', null, '{}'::jsonb, null, true,
--                         '{}'::jsonb, array['f2ProofKey']);             -- removes it
