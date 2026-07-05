// Tiny standalone module holding the page-level "halted" flag, kept separate from
// authClient/supaSync so both can import it without a circular dependency.
//
// Once a forced logout or stale-code condition is detected, the tab is halted and
// MUST NOT write to the server anymore. Background writers (sync push, auto-status
// evaluator) check isHalted() and bail. This closes the gap where an ejected tab
// kept pushing stale state in the moments before the hard redirect tore it down.

let HALTED = false;

export function markHalted() {
  HALTED = true;
}

export function isHalted() {
  return HALTED;
}
