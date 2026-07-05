-- ════════════════════════════════════════════════════════════════════════════
-- 0006_op_ledger.sql — Phase O1: universal idempotency for every engine action.
--
-- Design: a WRAPPER, not surgery. The 9 proven engine RPCs stay byte-identical.
-- One new RPC `app_op(p_op_id, p_fn, p_args)` fronts them:
--   1. CLAIM the op_id (insert-or-conflict) — concurrent duplicates collapse.
--   2. Already completed?  → return the STORED result (replayed: true).
--   3. Otherwise dispatch to the target function, store its result in the same
--      transaction, return it. A retry after ANY failure is always safe:
--      either the op never committed (claim rolled back with it) or it
--      committed and the retry replays the stored result. Exactly-once, done.
--
-- The client generates op_id (crypto.randomUUID) at INTENT time — so an offline
-- queue can replay the same op_id forever without double-applying. (That client
-- half is the next slice; this file is complete and independently verifiable.)
--
-- Run whole file once. Commit as migrations/0006_op_ledger.sql.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.app_op_ledger (
  op_id      uuid primary key,
  fn         text not null,
  args       jsonb not null default '{}'::jsonb,
  result     jsonb,                        -- null while running / after crash-rollback never persists
  created_at timestamptz not null default now()
);

-- Retention: ops only need to outlive their retry window. Purge with the audit cron later;
-- for now a month of ops is trivially small.

create or replace function public.app_op(p_op_id uuid, p_fn text, p_args jsonb default '{}'::jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare
  claimed boolean := false;
  prior jsonb;
  res jsonb;
  a jsonb := coalesce(p_args, '{}'::jsonb);
begin
  if p_op_id is null then
    return jsonb_build_object('ok', false, 'reason', 'op_id_required');
  end if;

  -- Dry-runs have no effects — never ledger them, just pass through.
  if coalesce((a->>'p_dry_run')::boolean, false) then
    claimed := true;  -- skip ledger machinery entirely
  else
    insert into public.app_op_ledger (op_id, fn, args)
    values (p_op_id, p_fn, a)
    on conflict (op_id) do nothing;
    get diagnostics claimed = row_count;
    claimed := coalesce(claimed, false);
    if not claimed then
      select result into prior from public.app_op_ledger where op_id = p_op_id;
      if prior is not null then
        return prior || jsonb_build_object('replayed', true);
      end if;
      -- Claimed by a concurrent caller still running (or a crashed tx that will
      -- roll its claim back). Tell the client to retry shortly.
      return jsonb_build_object('ok', false, 'reason', 'op_in_flight', 'retryable', true);
    end if;
  end if;

  -- ── Dispatch (explicit, no dynamic SQL) ─────────────────────────────────────
  if p_fn = 'assign' then
    res := public.app_assign_load(
      a->>'p_load_id', a->>'p_vehicle_id',
      coalesce(a->'p_extra','{}'::jsonb),
      coalesce(a->>'p_source','manual'),
      coalesce((a->>'p_dry_run')::boolean,false),
      (a->>'p_load_base_version')::bigint,
      (a->>'p_vehicle_base_version')::bigint);
  elsif p_fn = 'queue' then
    res := public.app_queue_load(
      a->>'p_load_id', a->>'p_vehicle_id', a->>'p_behind_load_id',
      coalesce(a->>'p_source','manual'),
      coalesce((a->>'p_dry_run')::boolean,false),
      (a->>'p_load_base_version')::bigint);
  elsif p_fn = 'promote' then
    res := public.app_promote_queued_load(
      a->>'p_load_id',
      coalesce(a->'p_extra','{}'::jsonb),
      coalesce(a->>'p_source','manual'),
      coalesce((a->>'p_dry_run')::boolean,false),
      (a->>'p_load_base_version')::bigint);
  elsif p_fn = 'unassign' then
    res := public.app_unassign_load(
      a->>'p_load_id',
      coalesce(a->>'p_source','manual'),
      coalesce((a->>'p_dry_run')::boolean,false),
      (a->>'p_load_base_version')::bigint);
  elsif p_fn = 'deliver' then
    res := public.app_deliver_load_v2(
      a->>'p_load_id',
      coalesce((a->>'p_finalize')::boolean,true),
      coalesce(a->>'p_source','manual'),
      coalesce((a->>'p_dry_run')::boolean,false));
  elsif p_fn = 'transition' then
    res := public.app_vehicle_transition(
      a->>'p_vehicle_id', a->>'p_action',
      a->>'p_eta', a->>'p_explicit_load_id', a->>'p_lr_date',
      coalesce((a->>'p_dry_run')::boolean,false),
      coalesce(a->>'p_source','manual'),
      coalesce(a->'p_extra','{}'::jsonb));
  elsif p_fn = 'consignee' then
    res := public.app_mark_consignee(
      a->>'p_load_id', (a->>'p_ci')::integer,
      coalesce(a->>'p_source','manual'),
      a->>'p_pod_path',
      coalesce((a->>'p_delivered')::boolean,true),
      (a->>'p_pod_ok')::boolean,
      coalesce((a->>'p_dry_run')::boolean,false),
      (a->>'p_load_base_version')::bigint,
      a->>'p_cid',
      nullif(a->>'p_delivered_at','')::timestamptz);
  elsif p_fn = 'delete_load' then
    res := public.app_delete_load(
      a->>'p_id', (a->>'p_user_id')::uuid, a->>'p_email');
  elsif p_fn = 'unassign_for_vehicle_delete' then
    res := public.app_unassign_for_vehicle_delete(
      a->>'p_vehicle_id',
      coalesce(a->>'p_reason','vehicle_delete'),
      coalesce((a->>'p_dry_run')::boolean,false),
      (a->>'p_vehicle_base_version')::bigint);
  else
    res := jsonb_build_object('ok', false, 'reason', 'unknown_fn', 'fn', p_fn);
  end if;

  -- Store the result with the claim — same transaction as the effects.
  if not coalesce((a->>'p_dry_run')::boolean, false) then
    update public.app_op_ledger set result = res where op_id = p_op_id;
  end if;
  return res;
end $function$;

-- ── Verify (run after install) ───────────────────────────────────────────────
-- 1. Idempotency proof on a harmless call (unknown load → engine refuses, but the
--    refusal itself gets ledgered and replayed):
--      select app_op('00000000-0000-0000-0000-00000000aaaa'::uuid, 'unassign',
--                    '{"p_load_id":"nonexistent_test"}'::jsonb);
--      -- expect {"ok":false,"reason":"no_load"}
--      -- run the SAME statement again:
--      -- expect the same + "replayed": true   ← the contract, proven
-- 2. select op_id, fn, result from app_op_ledger;   -- one row
-- 3. Cleanup: delete from app_op_ledger where op_id = '00000000-0000-0000-0000-00000000aaaa';
