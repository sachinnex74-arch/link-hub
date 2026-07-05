-- ════════════════════════════════════════════════════════════════════════════
-- 0005_state_machine.sql — Phase T1/T2: the formal load state machine.
--
--   • `state_transitions` — ONE table declaring every legal lstatus move.
--     Adding a future feature (e.g. a real Cancel action) = INSERT a row,
--     not a code hunt.
--   • `enforce_load_transition` — BEFORE UPDATE trigger validating every
--     lstatus change against the table. TWO MODES via app_settings key
--     'transitions.enforce':
--        absent/false → OBSERVE: illegal moves are ALLOWED but logged loudly
--                       (audit_log action='ILLEGAL_TRANSITION') — zero risk.
--        'true'       → ENFORCE: illegal moves are REJECTED with an exception.
--     House rollout: run in OBSERVE for a soak week; flip to enforce after
--     zero unexpected rows. Kill-switch = set the key back to false. Instant.
--
--   Scope: LOADS only. The vehicle machine is deliberately permissive
--   (dispatchers correct statuses freely; the engine's blocking-load guard is
--   its real protection) — documented in T1, not trigger-enforced.
--
-- Run this whole file once. Commit as migrations/0005_state_machine.sql.
-- ════════════════════════════════════════════════════════════════════════════

-- ── The transition table ─────────────────────────────────────────────────────
create table if not exists public.state_transitions (
  entity      text not null,            -- 'load' (vehicle rows documentational)
  from_status text not null,
  to_status   text not null,
  actors      text,                     -- documentation: which lanes make this move
  enabled     boolean not null default true,
  note        text,
  primary key (entity, from_status, to_status)
);

-- Idempotent seed (safe to re-run).
insert into public.state_transitions (entity, from_status, to_status, actors, note) values
  -- PENDING
  ('load','PENDING','QUEUED',      'app_queue_load',                                'queue behind a busy truck'),
  ('load','PENDING','ASSIGNED',    'app_assign_load',                               'direct assignment'),
  ('load','PENDING','DELETED',     'app_delete_load',                               'soft delete'),
  -- QUEUED
  ('load','QUEUED','ASSIGNED',     'app_promote_queued_load; app_unassign_load cascade; app_assign_load', 'promotion'),
  ('load','QUEUED','PENDING',      'app_unassign_load',                             'unqueue'),
  ('load','QUEUED','DELETED',      'app_delete_load',                               ''),
  -- ASSIGNED
  ('load','ASSIGNED','IN_TRANSIT', 'app_vehicle_transition cascade',                'trip start'),
  ('load','ASSIGNED','AT_UNLOADING','app_vehicle_transition cascade (arrival, incl. AVAILABLE-convergence)', 'late marking / fast trip'),
  ('load','ASSIGNED','PENDING',    'app_unassign_load',                             'unassign'),
  ('load','ASSIGNED','DELIVERED',  'app_deliver_load_v2; app_mark_consignee all-done', ''),
  ('load','ASSIGNED','DELETED',    'app_delete_load',                               ''),
  -- IN_TRANSIT
  ('load','IN_TRANSIT','AT_UNLOADING','arrival-tick / manual via engine',           '70km ring'),
  ('load','IN_TRANSIT','DELIVERED','app_deliver_load_v2; app_mark_consignee',       ''),
  ('load','IN_TRANSIT','PENDING',  'app_unassign_load',                             'mid-trip unassign (allowed today)'),
  ('load','IN_TRANSIT','DELETED',  'app_delete_load',                               ''),
  -- AT_UNLOADING
  ('load','AT_UNLOADING','IN_TRANSIT','left-unloading-tick / manual',               'left-unload demote'),
  ('load','AT_UNLOADING','DELIVERED','app_deliver_load_v2; app_mark_consignee',     ''),
  ('load','AT_UNLOADING','PENDING','app_unassign_load',                             ''),
  ('load','AT_UNLOADING','DELETED','app_delete_load',                               ''),
  -- terminal cleanups
  ('load','CANCELLED','DELETED',   'app_delete_load',                               'CANCELLED is currently UNREACHABLE (no writer) — row kept for cleanup if legacy rows exist'),
  -- LATE: legacy/display status — defensive exits so any stored legacy row can move on
  ('load','LATE','IN_TRANSIT',     'legacy defensive',                              'LATE has no current writer; exits allowed defensively'),
  ('load','LATE','AT_UNLOADING',   'legacy defensive',                              ''),
  ('load','LATE','DELIVERED',      'legacy defensive',                              ''),
  ('load','LATE','PENDING',        'legacy defensive',                              ''),
  ('load','LATE','DELETED',        'legacy defensive',                              '')
on conflict (entity, from_status, to_status) do nothing;

-- NOT seeded, therefore illegal by declaration:
--   * anything → CANCELLED (no writer exists; build a cancel lane first, then add the rows)
--   * DELIVERED → anything (resurrection — also blocked by app_write_load + transition_ok)
--   * DELETED → anything (undelete — also blocked by the absolute delete guard)

-- ── The legality trigger (observe-first) ─────────────────────────────────────
create or replace function public.enforce_load_transition()
 returns trigger
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  v_from text := coalesce(old.data->>'lstatus','');
  v_to   text := coalesce(new.data->>'lstatus','');
  v_ok boolean;
  v_enforce boolean := false;
begin
  -- Only judge actual lstatus changes.
  if v_from = v_to then return new; end if;

  select true into v_ok
  from public.state_transitions t
  where t.entity = 'load' and t.from_status = v_from and t.to_status = v_to
    and t.enabled;
  if v_ok then return new; end if;

  -- Illegal by the table. Mode?
  begin
    select (value = 'true'::jsonb) into v_enforce
    from public.app_settings where key = 'transitions.enforce';
  exception when others then v_enforce := false; end;
  v_enforce := coalesce(v_enforce, false);

  -- Always log the sighting (both modes) — this is the soak evidence.
  insert into public.audit_log (action, entity_type, entity_id, lid, source, details)
  values ('ILLEGAL_TRANSITION', 'load', new.id, new.data->>'lid',
          case when v_enforce then 'blocked' else 'observed' end,
          jsonb_build_object('from', v_from, 'to', v_to,
                             'engine_audited', coalesce(current_setting('app.engine_audited', true),''),
                             'enforced', v_enforce));

  if v_enforce then
    raise exception 'illegal load transition % -> % (see state_transitions)', v_from, v_to;
  end if;
  return new;  -- observe mode: allow, but it's on the record
end $function$;

drop trigger if exists trg_enforce_load_transition on public.loads;
create trigger trg_enforce_load_transition
  before update on public.loads
  for each row execute function public.enforce_load_transition();

-- ── Rollout ──────────────────────────────────────────────────────────────────
-- Now:      OBSERVE mode is live (key absent). Zero behavior change.
-- Soak:     for ~1 week, check:
--             select at, source, details from audit_log
--             where action='ILLEGAL_TRANSITION' order by at desc;
--           Expect ZERO rows. Any row = either a missing seed (add it) or a
--           genuinely illegal writer (investigate — that's the trigger working).
-- Enforce:  insert into app_settings (key,value) values ('transitions.enforce','true'::jsonb)
--             on conflict (key) do update set value='true'::jsonb;
-- Kill:     set it back to 'false' (instant, no deploy).
