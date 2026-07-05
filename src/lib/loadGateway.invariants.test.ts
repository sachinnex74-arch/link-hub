// loadGateway.invariants.test.ts — Phase 0 (TODO/SKIP harness).
// run: tsc then `node dist/loadGateway.invariants.test.js`
//
// These encode the five canonical-mutation invariants from the frozen roadmap.
// In Phase 0 they are TODO (skipped, non-blocking) because the implementation
// that makes them pass does not land until later phases. Each todo lists the
// phase where it flips to a real assertion and is expected to go GREEN.

import { CANONICAL_LOAD_KEYS, CANONICAL_VEHICLE_KEYS } from "./loadCanonical";

let pass = 0,
  fail = 0,
  todo = 0;

function ok(name: string, cond: boolean, extra = "") {
  if (cond) {
    pass++;
    console.log("  ✓ " + name);
  } else {
    fail++;
    console.log("  ✗ " + name + (extra ? "  — " + extra : ""));
  }
}
// Non-blocking placeholder: prints intent, counts as TODO, never fails the suite.
function todoTest(name: string, greenBy: string) {
  todo++;
  console.log(`  ○ TODO (${greenBy}): ${name}`);
}

console.log("\nloadGateway invariants — Phase 0 (TODO/SKIP)\n");

// Sanity: the canonical key sets exist and are non-empty (this one is REAL now).
ok(
  "CANONICAL_LOAD_KEYS is defined and non-empty",
  Array.isArray(CANONICAL_LOAD_KEYS) && CANONICAL_LOAD_KEYS.length >= 4,
);
ok(
  "CANONICAL_VEHICLE_KEYS includes loadId (vehicle-side link)",
  (CANONICAL_VEHICLE_KEYS as readonly string[]).includes("loadId"),
);

// T1 — object write cannot change lstatus.
todoTest("T1: gwWriteExtension cannot change lstatus", "Phase 4 (P1)");
// T2 — object write cannot change vehicle_id.
todoTest("T2: gwWriteExtension cannot change vehicle_id", "Phase 4 (P1)");
// T3 — object write cannot change consigneeDeliveries.
todoTest("T3: gwWriteExtension cannot change consigneeDeliveries", "Phase 2 + 4");
// T4 — outbox replay cannot mutate canonical fields.
todoTest("T4: outbox replay cannot mutate canonical fields", "Phase 4 (+H3 Phase 5)");
// T5 — vehicle.loadId cannot change outside transition/delivery lane.
todoTest("T5: vehicle.loadId cannot change via object write", "Phase 5 (H4)");

console.log(`\n  ${pass} passed, ${fail} failed, ${todo} todo\n`);

// Phase 0 contract: no real assertion may fail. TODOs are expected and allowed.
if (fail > 0) {
  console.error("Phase 0 invariant harness: unexpected real-assertion failure.");
  process.exit(1);
}
process.exit(0);
