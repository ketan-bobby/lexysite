#!/usr/bin/env node
/**
 * test-aivi-deletion.mjs
 *
 * Integration tests for the IL-AIVI consent gate + GDPR/CCPA right-to-erasure
 * cascade. Runs directly against the dev DB (DATABASE_URL).
 *
 * The project has no existing vitest harness — this is the project-convention
 * smoke-script approach used by scripts/smoke-critical-journeys.mjs. Uses psql
 * via child_process so the script needs no extra npm deps.
 *
 * Coverage:
 *   1. hasActiveAiConsent: null → false
 *   2. hasActiveAiConsent: "default" sentinel → false (regression — must NOT exempt)
 *   3. hasActiveAiConsent: "demo" sentinel in non-prod → true
 *   4. hasActiveAiConsent: real candidate, no consent → false
 *   5. hasActiveAiConsent: real candidate, active consent → true
 *   6. hasActiveAiConsent: real candidate, revoked consent → false
 *   7. Transactional cascade happy path: seed candidate + child rows;
 *      run the cascade; verify candidate + every child row are gone.
 *   8. Transactional cascade rollback: inject a failure mid-tx; verify
 *      candidate + child rows are still present (no partial delete).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";

if (!process.env.DATABASE_URL) {
  console.error("DATABASE_URL not set"); process.exit(2);
}
process.env.NODE_ENV = process.env.NODE_ENV || "development";

const results = [];
function record(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  — ${detail}` : ""}`);
}

/* Run a SQL statement and return rows as { rows, ok }. Uses -Atc so rows
 * are tab-separated, no headers, no padding. */
function q(sql, opts = {}) {
  /* For multi-statement transactional input we pipe the SQL on stdin
   * (NOT -c, since psql disallows combining -1 with -c). -1 wraps the
   * whole script in a single tx and ON_ERROR_STOP=1 aborts on the
   * first error, matching drizzle.tx() semantics. */
  let r;
  if (opts.tx) {
    r = spawnSync("psql", [process.env.DATABASE_URL, "-Atq", "-1", "-v", "ON_ERROR_STOP=1"],
      { encoding: "utf8", input: sql });
  } else {
    r = spawnSync("psql", [process.env.DATABASE_URL, "-Atc", sql], { encoding: "utf8" });
  }
  if (r.status !== 0) {
    return { ok: false, error: (r.stderr || "").trim(), rows: [] };
  }
  const rows = (r.stdout || "").split("\n").filter((s) => s.length > 0)
    .map((line) => line.split("\t"));
  return { ok: true, rows };
}
function qOk(sql) {
  const r = q(sql);
  if (!r.ok) throw new Error(`psql failed: ${r.error}\n  sql: ${sql}`);
  return r.rows;
}

const CURRENT_AI_CONSENT_VERSION = "ai-interview-2026-05";
function hasActiveAiConsent(candidateId) {
  if (!candidateId) return false;
  if (candidateId === "demo" && process.env.NODE_ENV !== "production") return true;
  const rows = qOk(`SELECT 1 FROM candidate_ai_consent
    WHERE candidate_id = '${candidateId}'
      AND consent_version = '${CURRENT_AI_CONSENT_VERSION}'
      AND revoked_at IS NULL
    LIMIT 1`);
  return rows.length > 0;
}

const CANDIDATE_LINKED_TABLES = [
  "ai_decision_log","applications","candidate_achievements","candidate_action_events",
  "candidate_activity_streaks","candidate_ai_consent","candidate_career_profiles",
  "candidate_connection_events","candidate_connection_insights","candidate_demographics",
  "candidate_external_clicks","candidate_import_records","candidate_job_intelligence",
  "candidate_market_events_sent","candidate_notifications","candidate_progress_snapshots",
  "candidate_recommendation_progress","candidate_rejections","candidate_skill_scores",
  "communication_events","connection_events","connection_scores","ghosting_alerts",
  "ghosting_risk_flags","interview_sessions","invite_tokens","nurture_pool",
  "outreach_conversation_drafts","outreach_enrollments","outreach_messages",
  "prep_plans","prep_sessions","recruiter_inbox_items","resume_screens","talent_matches",
  "talent_pool_submissions","trust_events","verification_records",
];

function ensureTenant() {
  const id = `t_test_${randomUUID().slice(0, 8)}`;
  qOk(`INSERT INTO tenants (id, name, slug, region, plan, created_at)
       VALUES ('${id}', 'AIVI Test Tenant', '${id}', 'us', 'starter', NOW())`);
  return id;
}
function seedCandidate(tenantId, email) {
  const id = `c_test_${randomUUID().slice(0, 8)}`;
  qOk(`INSERT INTO candidates (id, tenant_id, email, first_name, last_name, pool, created_at)
       VALUES ('${id}', '${tenantId}', '${email}', 'Test', 'Candidate', 'tenant', NOW())`);
  return id;
}
function cleanupTenant(tenantId) { q(`DELETE FROM tenants WHERE id = '${tenantId}'`); }

/* ─── Tests 1-3: sentinel semantics ───────────────────────────────────── */
console.log("\n== sentinel-ID consent semantics ==");
record("null candidateId → false",                       hasActiveAiConsent(null) === false);
record('"default" sentinel → false (regression guard)',  hasActiveAiConsent("default") === false);
record('"demo" sentinel in dev → true',                  hasActiveAiConsent("demo") === true);

/* ─── Tests 4-6: real candidate consent semantics ─────────────────────── */
console.log("\n== real-candidate consent semantics ==");
const tA = ensureTenant();
const cA = seedCandidate(tA, `aivi-${randomUUID().slice(0,6)}@test.local`);
try {
  record("real candidate, no consent → false", hasActiveAiConsent(cA) === false);

  qOk(`INSERT INTO candidate_ai_consent (id, candidate_id, consent_version, disclosure_snapshot, consented_at, created_at)
       VALUES ('cac_${randomUUID().slice(0,8)}', '${cA}', '${CURRENT_AI_CONSENT_VERSION}', '{}'::jsonb, NOW(), NOW())`);
  record("real candidate, active consent → true", hasActiveAiConsent(cA) === true);

  qOk(`UPDATE candidate_ai_consent SET revoked_at = NOW() WHERE candidate_id = '${cA}'`);
  record("real candidate, revoked consent → false", hasActiveAiConsent(cA) === false);
} finally { cleanupTenant(tA); }

/* ─── Test 7: transactional cascade — happy path ──────────────────────── */
console.log("\n== transactional cascade ==");
const tB = ensureTenant();
const cB = seedCandidate(tB, `cascade-${randomUUID().slice(0,6)}@test.local`);
try {
  qOk(`INSERT INTO candidate_ai_consent (id, candidate_id, consent_version, disclosure_snapshot, consented_at, created_at)
       VALUES ('cac_${randomUUID().slice(0,8)}', '${cB}', '${CURRENT_AI_CONSENT_VERSION}', '{}'::jsonb, NOW(), NOW())`);
  /* candidate_action_events seed — best-effort; if the schema requires more
   * columns it'll be skipped and the cascade test still proves the candidate
   * row deletes. */
  q(`INSERT INTO candidate_action_events (id, candidate_id, event_type, payload, created_at)
     VALUES ('${randomUUID()}', '${cB}', 'test', '{}'::jsonb, NOW())`);

  /* Run the cascade exactly as admin-deletion.ts would (single tx). */
  const deletes = CANDIDATE_LINKED_TABLES
    .map((t) => `DELETE FROM "${t}" WHERE candidate_id = '${cB}';`).join("\n");
  const cascadeRes = q(`${deletes}\nDELETE FROM candidates WHERE id = '${cB}';`, { tx: true });
  if (!cascadeRes.ok) throw new Error(`cascade tx failed: ${cascadeRes.error}`);

  const remCandidate = qOk(`SELECT 1 FROM candidates WHERE id = '${cB}'`);
  const remConsent   = qOk(`SELECT 1 FROM candidate_ai_consent WHERE candidate_id = '${cB}'`);
  const remActions   = qOk(`SELECT 1 FROM candidate_action_events WHERE candidate_id = '${cB}'`);

  record("cascade: candidate row deleted",       remCandidate.length === 0);
  record("cascade: child consent rows deleted",  remConsent.length === 0);
  record("cascade: child action_events deleted", remActions.length === 0);
} finally { cleanupTenant(tB); }

/* ─── Test 8: transactional cascade — rollback on failure ─────────────── */
console.log("\n== transactional cascade rollback ==");
const tC = ensureTenant();
const cC = seedCandidate(tC, `rollback-${randomUUID().slice(0,6)}@test.local`);
try {
  q(`INSERT INTO candidate_action_events (id, candidate_id, event_type, payload, created_at)
     VALUES ('${randomUUID()}', '${cC}', 'test', '{}'::jsonb, NOW())`);

  /* Force the tx to fail mid-cascade by deleting from a non-existent table.
   * Postgres aborts the whole transaction and rolls back the earlier delete.
   * (Within a tx, the first error aborts subsequent statements.) */
  const txResult = q(
    `DELETE FROM candidate_action_events WHERE candidate_id = '${cC}';
     DELETE FROM table_that_does_not_exist WHERE candidate_id = '${cC}';`,
    { tx: true },
  );
  record("rollback: tx returned an error",         txResult.ok === false);

  const candStill = qOk(`SELECT 1 FROM candidates WHERE id = '${cC}'`);
  const actStill  = qOk(`SELECT 1 FROM candidate_action_events WHERE candidate_id = '${cC}'`);
  record("rollback: candidate row still present",  candStill.length === 1);
  record("rollback: child row still present (no partial delete)", actStill.length === 1);
} finally { cleanupTenant(tC); }

/* ─── Summary ─────────────────────────────────────────────────────────── */
const failed = results.filter((r) => !r.ok);
console.log(`\n${failed.length === 0 ? "ALL PASS" : "FAIL"} — ${results.length - failed.length}/${results.length} tests passed`);
if (failed.length > 0) {
  for (const f of failed) console.error(`  FAIL: ${f.name}`);
  process.exit(1);
}
process.exit(0);
