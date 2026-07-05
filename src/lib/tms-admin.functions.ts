// tms-admin.functions.ts — RETIRED (Jul 4, 2026 · Phase M3 audit).
//
// The two bulk actions that lived here were deleted:
//   • resetAllVehiclesAvailableFn — flipped ALL vehicles to AVAILABLE regardless
//     of active loads (mass pair-breaker), via raw unversioned whole-blob upserts.
//   • clearAllLoadsAndPodsFn — hard-deleted the entire load history and every
//     proof-of-delivery record, bypassing soft-delete, vehicle freeing, and audit.
//
// Legitimate needs are served by the sanctioned lanes:
//   fleet recovery → app_vehicle_transition per truck (guards refuse mid-trip),
//   data retirement → soft-delete (app_delete_load) + purge cron with retention.
//
// This file is kept as the future home for PROPERLY-BUILT admin tools:
// engine-lane, guarded, dry-runnable, audited. See M3-admin-path-audit.md.
export {};
