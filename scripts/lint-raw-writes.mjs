#!/usr/bin/env node
// scripts/lint-raw-writes.mjs — H1 lint, WARN MODE (Phase 0).
//
// Flags raw `from("loads"|"vehicles"|<var>).upsert|insert|update|delete(...)`
// outside the gateway allowlist. WARN ONLY: always exits 0 in Phase 0 so it is
// non-blocking. Phase 6 flips ENFORCE=true to exit 1 and removes the allowlist.
//
// Also doubles as the raw-write INVENTORY generator (roadmap Phase 0, item 5).

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const ENFORCE = true; // Phase 6: ENFORCE — build fails on any new unsanctioned raw write.

// Files permitted to contain raw loads/vehicles writes (the gateway + its
// current implementation, which is migrated phase-by-phase). Phase 6 narrows
// this to ONLY loadGateway.ts.
const ALLOWLIST = new Set([
  "src/lib/loadGateway.ts",
]);

// SANCTIONED raw-write sites: reviewed and intentionally allowed to bypass the
// guarded lane. These do NOT fail the build in enforce mode. Each is here for a
// documented reason (admin op / deliberate kill-switch), not an un-migrated gap.
// Matched by file + a stable substring of the line (line numbers drift).
const SANCTIONED = [
  { re: /supaSync\.ts$/, match: "Legacy path (kill-switch off)", why: "deliberate USE_VERSIONED_WRITES=false rollback escape hatch — not a live path" },
  { re: /supaSync\.ts$/, match: "Flag OFF → legacy raw fallback", why: "fail-closed fallback — only runs when FAIL_CLOSED_WRITES off; unreachable when on" },
  { re: /supaSync\.ts$/, match: "SANCTIONED-RAW-WRITE: delete fallback", why: "delete fallback — bypassed for vehicles (guarded RPC); loads use app_delete_load" },
  { re: /tms-admin\.functions\.ts$/, match: 'from("vehicles")', why: "admin bulk vehicle import — sanctioned fleet import of fresh vehicles" },
  { re: /tms-admin\.functions\.ts$/, match: "SANCTIONED-RAW-WRITE: admin destructive wipe", why: "admin destructive wipe — sanctioned admin-only op" },
];

// Sites still pending migration (informational — mapped to their phase). These
// are NOT silenced; they are reported with their target phase.
const PHASE_OF = [
  // The one remaining real gap: vehicle delete goes raw while loads use app_delete_load.
  { re: /supaSync\.ts$/, line: 1291, phase: 6, note: "directDelete raw vehicle delete — needs guarded app_delete_vehicle lane" },
];

// from("loads"|'loads'|"vehicles"|'vehicles'|<identifier>)  …  .upsert|insert|update|delete(
const WRITE_RE =
  /\.from\(\s*(?:["'](loads|vehicles)["']|([A-Za-z_$][\w$]*))\s*\)[\s\S]{0,40}?\.(upsert|insert|update|delete)\s*\(/g;

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (/\.(ts|tsx|js|jsx)$/.test(name)) out.push(p);
  }
  return out;
}

function lineOf(text, index) {
  return text.slice(0, index).split("\n").length;
}

function phaseFor(rel, line) {
  const m = PHASE_OF.find((x) => x.re.test(rel) && x.line === line);
  return m ? m : null;
}

function sanctionedFor(rel, lineText) {
  return SANCTIONED.find((x) => x.re.test(rel) && lineText.includes(x.match)) || null;
}

const findings = [];
for (const file of walk(SRC)) {
  const rel = relative(ROOT, file).replace(/\\/g, "/");
  if (ALLOWLIST.has(rel)) continue;
  const text = readFileSync(file, "utf8");
  const lines = text.split("\n");
  let m;
  WRITE_RE.lastIndex = 0;
  while ((m = WRITE_RE.exec(text)) !== null) {
    const line = lineOf(text, m.index);
    const target = m[1] || `<var:${m[2]}>`;
    // Check a small window of lines around the match for a SANCTIONED substring
    // (the sanctioning marker may be on a nearby line, e.g. a comment or the
    // enclosing statement), so line drift doesn't matter.
    const windowText = lines.slice(Math.max(0, line - 4), line + 2).join("\n");
    const sanctioned = sanctionedFor(rel, windowText);
    findings.push({ rel, line, target, op: m[3], sanctioned });
  }
}

const blocking = findings.filter((f) => !f.sanctioned);

console.log(`\n[H1 raw-write lint — ${ENFORCE ? "ENFORCE MODE (Phase 6, build-fail)" : "WARN MODE (non-blocking)"}]\n`);
if (findings.length === 0) {
  console.log("  ✓ No raw loads/vehicles writes found outside the gateway.\n");
} else {
  const sanctionedFindings = findings.filter((f) => f.sanctioned);
  if (blocking.length > 0) {
    console.log(`  ⚠ ${blocking.length} UNSANCTIONED raw write site(s) outside the gateway:\n`);
    for (const f of blocking.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
      const ph = phaseFor(f.rel, f.line);
      const tag = ph ? `→ Phase ${ph.phase}: ${ph.note}` : "→ UNMAPPED — review";
      console.log(`  ⚠ ${f.rel}:${f.line}  .${f.op}(${f.target})  ${tag}`);
    }
    console.log("");
  }
  if (sanctionedFindings.length > 0) {
    console.log(`  ✓ ${sanctionedFindings.length} sanctioned site(s) (reviewed, allowed):\n`);
    for (const f of sanctionedFindings.sort((a, b) => a.rel.localeCompare(b.rel) || a.line - b.line)) {
      console.log(`  ✓ ${f.rel}:${f.line}  .${f.op}(${f.target})  — ${f.sanctioned.why}`);
    }
    console.log("");
  }
  if (blocking.length > 0) {
    console.log("  Unsanctioned sites must be migrated to the gateway or explicitly");
    console.log("  sanctioned before Phase 6 enforce can pass.\n");
  }
}

process.exit(ENFORCE && blocking.length > 0 ? 1 : 0);
