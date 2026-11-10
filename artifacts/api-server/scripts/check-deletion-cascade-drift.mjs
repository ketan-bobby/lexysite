#!/usr/bin/env node
/**
 * check-deletion-cascade-drift.mjs
 *
 * CI guard for the GDPR / IL-AIVI right-to-erasure cascade.
 *
 * Compares the static `CANDIDATE_LINKED_TABLES` array in
 * lib/candidate-erasure.ts against every table in the live database
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
const adminDeletionPath = resolve(here, "../src/lib/candidate-erasure.ts");

function parseStaticList() {
  const src = readFileSync(adminDeletionPath, "utf8");
  const m = src.match(/export const CANDIDATE_LINKED_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
  if (!m) {
    console.error("[drift-check] FAIL: could not locate CANDIDATE_LINKED_TABLES in candidate-erasure.ts");
    process.exit(2);
  }
  return [...m[1].matchAll(/"([a-z0-9_]+)"/g)].map((mm) => mm[1]).sort();
}

function queryLiveTables(query) {
  if (!process.env.DATABASE_URL) {
    console.error("[drift-check] FAIL: DATABASE_URL not set");
    process.exit(2);
  }
  const out = execFileSync("psql", [
    process.env.DATABASE_URL,
    "-Atc",
    query ?? `SELECT DISTINCT table_name FROM information_schema.columns
      WHERE table_schema='public' AND column_name='candidate_id'
      ORDER BY table_name`,
  ], { encoding: "utf8" });
  return out.split("\n").map((s) => s.trim()).filter(Boolean).sort();
}

/* Read the explicitly documented retention inventory from the same module. */
const retentionSource = readFileSync(adminDeletionPath, "utf8");
const retentionMatch = retentionSource.match(/export const RETAINED_CANDIDATE_TABLES\s*=\s*\[([\s\S]*?)\]\s*as const/);
if (!retentionMatch) throw new Error("Missing explicit retention inventory");
const EXEMPT_FROM_CASCADE = new Set(
  [...retentionMatch[1].matchAll(/"([a-z0-9_]+)"/g)].map((m) => m[1]),
);

function main() {
  const declared = parseStaticList();
  const live = queryLiveTables().filter((t) => !EXEMPT_FROM_CASCADE.has(t));

  const declaredSet = new Set(declared);
  const liveSet = new Set(live);

  const missing = live.filter((t) => !declaredSet.has(t));   // in DB, not in cascade → PII leak risk
  const stale   = declared.filter((t) => !liveSet.has(t));   // in cascade, not in DB → harmless but stale

  if (missing.length === 0 && stale.length === 0) {
    const expected = [...declared, "candidates", "sourced_candidates", "ai_jobs",
      "interview_summaries", "interview_schedules", "recruiting_workflow_events"];
    const barriers = queryLiveTables(`SELECT c.relname AS name FROM pg_trigger t
      JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND t.tgname='lexy_erasure_write_barrier'
        AND t.tgenabled IN ('O','A')`);
    const protectedNames = new Set(barriers);
    const unprotected = expected.filter(name=>!protectedNames.has(name));
    if (unprotected.length) {
      console.error("[drift-check] FAIL — candidate erasure write barriers missing:",unprotected.join(", "));
      process.exit(1);
    }
    console.log(`[drift-check] OK — ${declared.length} candidate-linked tables in cascade match the live schema.`);
    process.exit(0);
  }
  if (missing.length > 0) {
    console.error("\n[drift-check] FAIL — these candidate_id tables exist in the DB but are NOT in CANDIDATE_LINKED_TABLES:");
    for (const t of missing) console.error(`    + ${t}`);
    console.error("\nAdd them to artifacts/api-server/src/lib/candidate-erasure.ts CANDIDATE_LINKED_TABLES");
    console.error("(or document a retention basis in RETAINED_CANDIDATE_TABLES and the runbook).");
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
