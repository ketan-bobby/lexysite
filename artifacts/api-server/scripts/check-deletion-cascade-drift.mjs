#!/usr/bin/env node
/**
 * check-deletion-cascade-drift.mjs
 *
 * CI guard for the GDPR / IL-AIVI right-to-erasure cascade.
 *
 * Compares the static `CANDIDATE_LINKED_TABLES` array in
 * routes/admin-deletion.ts against every table in the live database
 * that actually has a `candidate_id` column. Exits non-zero on drift
 * so a developer who adds a new candidate-linked table without
 * updating the cascade list is blocked at PR time.
 *
 * Usage (CI):
 *   DATABASE_URL=postgres://... node scripts/check-deletion-cascade-drift.mjs
 *
 * Exit codes:
 *   0  — no drift
 *   1  — drift detected (PII leak risk in the deletion cascade)
 *   2  — could not run (DB unreachable, file unreadable, etc.)
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { execFileSync } from "node:child_process";

const here = dirname(fileURLToPath(import.meta.url));
const adminDeletionPath = resolve(here, "../src/routes/admin-deletion.ts");

function parseStaticList() {
  const src = readFileSync(adminDeletionPath, "utf8");
  const m = src.match(/export const CANDIDATE_LINKED_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!m) {
    console.error("[drift-check] FAIL: could not locate CANDIDATE_LINKED_TABLES in admin-deletion.ts");
    process.exit(2);
  }
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((mm) => mm[1]).sort();
}

function queryLiveTables() {
  if (!process.env.DATABASE_URL) {
    console.error("[drift-check] FAIL: DATABASE_URL not set");
    process.exit(2);
  }
  const out = execFileSync("psql", [
    process.env.DATABASE_URL,
    "-Atc",
    `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='candidate_id'
      ORDER BY table_name`,
  ], { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
}

/* Tables that legitimately have a candidate_id column but must NOT be
 * deleted as part of a right-to-erasure cascade. Today the only entry
 * is deletion_requests itself — we retain the request row (flipped to
 * status=fulfilled) as part of the audit trail under the legal-claims
 * basis. Any future exemption must be added here AND documented in
 * docs/RUNBOOK_DATA_DELETION.md. */
const EXEMPT_FROM_CASCADE = new Set(["deletion_requests"]);

function main() {
  const declared = parseStaticList();
  const live = queryLiveTables().filter((t) => !EXEMPT_FROM_CASCADE.has(t));

  const declaredSet = new Set(declared);
  const liveSet = new Set(live);

  const missing = live.filter((t) => !declaredSet.has(t));   // in DB, not in cascade → PII leak risk
  const stale   = declared.filter((t) => !liveSet.has(t));   // in cascade, not in DB → harmless but stale

  if (missing.length === 0 && stale.length === 0) {
    console.log(`[drift-check] OK — ${declared.length} candidate-linked tables in cascade match the live schema.`);
    process.exit(0);
  }
  if (missing.length > 0) {
    console.error("\n[drift-check] FAIL — these candidate_id tables exist in the DB but are NOT in CANDIDATE_LINKED_TABLES:");
    for (const t of missing) console.error(`    + ${t}`);
    console.error("\nAdd them to artifacts/api-server/src/routes/admin-deletion.ts CANDIDATE_LINKED_TABLES");
    console.error("(or, if intentionally exempt, to EXEMPT_FROM_CASCADE in this script with a runbook note).");
  }
  if (stale.length > 0) {
    console.warn("\n[drift-check] WARN — these are in CANDIDATE_LINKED_TABLES but no longer exist in the DB:");
    for (const t of stale) console.warn(`    - ${t}`);
  }
  process.exit(missing.length > 0 ? 1 : 0);
}

try { main(); } catch (err) {
  console.error("[drift-check] FAIL (uncaught):", err?.message ?? err);
  process.exit(2);
}
