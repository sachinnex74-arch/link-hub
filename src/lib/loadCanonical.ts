// loadCanonical.ts — canonical field sets (zero dependencies).
//
// Extracted so invariant tests, the gateway, and the future outbox sanitizer
// (Phase 5/H3) can share these WITHOUT importing the supabase client chain.
// Canonical fields may be mutated ONLY through the canonical lane
// (gwTransition / gwDeliver / gwConsignee / gwAssign), never the object lane.

/** Canonical load blob keys → enforced single-lane by P1 (Phase 4) + lint (Phase 6). */
export const CANONICAL_LOAD_KEYS = [
  "lstatus",
  "vehicleId",
  "consigneeDeliveries",
  "deliveredAt",
] as const;

/** Canonical vehicle keys — the vehicle side of the load↔vehicle link (H4, Phase 5). */
export const CANONICAL_VEHICLE_KEYS = ["vstatus", "loadId"] as const;

export type CanonicalLoadKey = (typeof CANONICAL_LOAD_KEYS)[number];
export type CanonicalVehicleKey = (typeof CANONICAL_VEHICLE_KEYS)[number];
