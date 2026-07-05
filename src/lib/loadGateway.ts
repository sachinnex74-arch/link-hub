// loadGateway.ts — Phase 0 (SCAFFOLDING ONLY, pass-through).
//
// FROZEN ROADMAP — Phase 0. This module is the future single write-path gateway
// for `loads` (and the vehicle side of the load↔vehicle link). In Phase 0 every
// function is a VERBATIM pass-through to the existing implementation and NOTHING
// in the runtime imports it yet, so it changes no behavior. Call sites are
// repointed here starting in Phase 1; canonical-blindness (P1) lands in Phase 4.
//
// Do NOT add raw `sb.from("loads"|"vehicles").upsert/insert/update` anywhere
// except inside this module (enforced warn-mode by scripts/lint-raw-writes.mjs in
// Phase 0; hard-fail in Phase 6).

import {
  transitionVehicle,
  pushDelivered,
  markConsigneeRpc,
  upsertLoadRemote,
  deleteLoadRemote,
  assignLoadRpc,
  queueLoadRpc,
  promoteQueuedLoadRpc,
  unassignLoadRpc,
  unassignForVehicleDeleteRpc,
} from "./supaSync";

// Canonical key sets live in a dependency-free module so tests/sanitizers can
// import them without the supabase client. Re-exported here for convenience.
export {
  CANONICAL_LOAD_KEYS,
  CANONICAL_VEHICLE_KEYS,
  type CanonicalLoadKey,
  type CanonicalVehicleKey,
} from "./loadCanonical";

// ──────────────────────────────────────────────────────────────────────────
// CANONICAL LANE — the only paths permitted to change canonical fields.
// Phase 0: verbatim pass-throughs to the existing engine/delivery functions.
// ──────────────────────────────────────────────────────────────────────────

/** Status / assignment transition via the engine (`app_vehicle_transition`). */
export async function gwTransition(
  vehicleId: string,
  action: string,
  opts: { eta?: string | null; loadId?: string | null; lrDate?: string | null } = {},
) {
  return transitionVehicle(vehicleId, action, opts);
}

/** Mark a load delivered (`app_deliver_load`). */
export function gwDeliver(loadId: string, opts?: { finalizeConsignees?: boolean }) {
  return pushDelivered(loadId, opts);
}

/** Mark one consignee delivered. Phase 2 routes this to a versioned RPC. */
export function gwConsignee(
  loadId: string,
  ci: number,
  source: "driver_pod" | "dispatcher_manual" | "dispatcher_pod_ok",
  podPath: string | null = null,
  delivered: boolean = true,
  podOk: boolean | null = null,
  cid: string | null = null,
  deliveredAt: string | null = null,
) {
  return markConsigneeRpc(loadId, ci, source, podPath, delivered, podOk, cid, deliveredAt);
}

/**
 * Assign a free vehicle to a load (load↔vehicle link + lstatus=ASSIGNED).
 * Sanctioned canonical-lane op → app_assign_load. `extra` may carry
 * {departure,destination} overrides. Returns { ok, reason?, blocking_lid? }.
 */
export async function gwAssign(
  loadId: string,
  vehicleId: string,
  extra: Record<string, any> = {},
) {
  return assignLoadRpc(loadId, vehicleId, extra);
}

/** Queue a load behind a busy vehicle (lstatus=QUEUED) → app_queue_load. */
export async function gwQueue(loadId: string, vehicleId: string, behindLoadId: string | null) {
  return queueLoadRpc(loadId, vehicleId, behindLoadId);
}

/** Promote a QUEUED load to ASSIGNED when its vehicle is free → app_promote_queued_load. */
export async function gwPromote(loadId: string, extra: Record<string, any> = {}) {
  return promoteQueuedLoadRpc(loadId, extra);
}

/** Unassign a load (→ PENDING) and free its vehicle → app_unassign_load (cascades promote). */
export async function gwUnassign(loadId: string) {
  return unassignLoadRpc(loadId);
}

export async function gwUnassignForVehicleDelete(vehicleId: string) {
  return unassignForVehicleDeleteRpc(vehicleId);
}

// ──────────────────────────────────────────────────────────────────────────
// OBJECT LANE — extension/non-canonical writes. Becomes canonical-blind in
// Phase 4 (P1). Phase 0: verbatim pass-through to the existing object write.
// ──────────────────────────────────────────────────────────────────────────

/** Object/extension write for a load (non-canonical fields). */
export async function gwWriteExtension(load: any) {
  return upsertLoadRemote(load);
}

/** Soft-delete a load (`app_delete_load`). */
export async function gwDelete(id: string) {
  return deleteLoadRemote(id);
}

/** D-2c: set a load's stop list through the guarded lane (app_set_load_stops). */
export { setLoadStopsRpc as gwSetStops } from "@/lib/supaSync";
