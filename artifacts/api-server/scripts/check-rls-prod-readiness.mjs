#!/usr/bin/env node
/**
 * check-rls-prod-readiness.mjs
 *
 * READ-ONLY pre-flight for enabling / relying on Postgres Row-Level
 * Security in an environment (run it against PROD before the migration
 * window). It issues SELECT-only catalog queries — it never writes,
 * never migrates, and never touches tenant data.
 *
 * Why this exists
 * ---------------
 * In this codebase RLS is NOT enforced by "setting app.current_tenant_id
 * on every connection". Enforcement lives in exactly one place: the
 * authenticated HTTP path (withTenantContext), which runs
 *   SET ROLE lexy_app  +  set_config('app.current_tenant_id', ...)
 * Every other connection — schedulers, the ai-queue worker, webhooks,
 * boot/reconcile, backfill scripts, and bypass-listed routes — runs on
 * the `db -> dbAdmin` fall-through, i.e. the raw pool logged in as the
 * DATABASE_URL role. That role is assumed to be a SUPERUSER / BYPASSRLS
 * role, so RLS simply does not apply to it. The affected tables are also
 * FORCE RLS, which means the *table owner* does NOT escape the policy —
 * only a true SUPERUSER or an explicit BYPASSRLS role does.
 *
 * The real outage risks (verified by this script):
 *   R1  DATABASE_URL's login role lacks SUPERUSER/BYPASSRLS.
 *       -> every scheduler, worker, webhook, boot task and /public route
 *          runs under FORCE RLS with no tenant context = deny-all = full
 *          background + public-route outage.
 *   R2  `lexy_app` role missing, or the four critical tables are not
 *       ENABLE + FORCE + policied (e.g. prod was set up with
 *       `drizzle-kit push`, which does NOT create roles/policies/grants).
 *       -> authenticated requests fail (SET ROLE throws) and/or reads
 *          deny-all.
 *   R3  The subtree function `app_tenant_in_scope` (migration 0021) is
 *       missing while the policies reference it, or migration state is
 *       partial across the RLS table set.
 *
 * It also scans the WHOLE public schema for two dangerous conditions on
 * any table (not just the four), so partial/inconsistent migration state
 * is surfaced:
 *   - RLS enabled but NO policy      -> deny-all for non-bypass roles.
 *   - RLS enabled but NOT forced     -> owner silently bypasses (a
 *                                        privacy gap, not an outage).
 *
 * Usage:
 *   DATABASE_URL=postgres://... node scripts/check-rls-prod-readiness.mjs
 *
 * Exit codes:
 *   0  — ready (no FAILs; WARNs may be present)
 *   1  — NOT ready (one or more FAILs)
 *   2  — could not run (DATABASE_URL unset, psql missing, DB unreachable)
 */
import { execFileSync } from "node:child_process";

/* The four tables this audit centres on. These MUST be
 * ENABLE + FORCE + have >=1 policy for RLS to behave. */
const CRITICAL_TABLES = [
  "candidates",
  "applications",
  "interview_sessions",
  "sourced_candidates",
];

/* The full set of tables the RLS migrations (0000 pilot + 0001 extension)
 * put under FORCE RLS. Used to detect partial migration state. Keep this
 * in sync with lib/db/drizzle/0000_rls_pilot.sql and
 * lib/db/drizzle/0001_rls_extension.sql. */
const EXPECTED_RLS_TABLES = [
  // pilot (0000)
  "candidates",
  "applications",
  "interview_sessions",
  // extension (0001)
  "jobs",
  "ideal_candidate_profiles",
  "outreach_campaigns",
  "recruiter_inbox_items",
  "outreach_enrollments",
  "outreach_messages",
  "talent_matches",
  "resume_screens",
  "talent_pool_submissions",
  "sourced_candidates",
  "candidate_notifications",
  "user_notifications",
  "communication_events",
  "ghosting_risk_flags",
  "ghosting_alerts",
  "nurture_pool",
  "interview_plans",
  "interview_schedules",
  "trust_events",
  "candidate_rejections",
  "pipeline_runs",
  "job_pipelines",
  "prep_plans",
  "prep_sessions",
  "candidate_action_events",
  "tenant_decision_policies",
  "credit_usage_events",
  "candidate_import_batches",
  "candidate_import_records",
  "verification_records",
  "billing_invoices",
  "billing_subscriptions",
];

let FAILS = 0;
let WARNS = 0;

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  dim: "\x1b[2m",
};
function pass(msg) { console.log(`  ${C.green}PASS${C.reset}  ${msg}`); }
function warn(msg) { WARNS++; console.log(`  ${C.yellow}WARN${C.reset}  ${msg}`); }
function fail(msg) { FAILS++; console.log(`  ${C.red}FAIL${C.reset}  ${msg}`); }
function section(t) { console.log(`\n${C.bold}${t}${C.reset}`); }

/* Run a single SELECT and return rows as arrays of column strings.
 * Read-only by construction: we only ever pass SELECT text, and we wrap
 * the session in a read-only transaction as a belt-and-braces guard so a
 * copy-paste mistake can never mutate prod. */
function q(sql) {
  const wrapped =
    "SET default_transaction_read_only = on;\n" +
    "BEGIN;\n" + sql + ";\nROLLBACK;";
  const out = execFileSync(
    "psql",
    [process.env.DATABASE_URL, "-Atq", "-F", "|", "-v", "ON_ERROR_STOP=1", "-c", wrapped],
    { encoding: "utf8" },
  );
  return out
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => l.split("|"));
}

function pgArrayLiteral(names) {
  return "ARRAY[" + names.map((n) => `'${n}'`).join(",") + "]";
}

function main() {
  if (!process.env.DATABASE_URL) {
    console.error(`${C.red}[rls-readiness] FAIL: DATABASE_URL not set${C.reset}`);
    process.exit(2);
  }

  console.log(`${C.bold}RLS production-readiness check${C.reset} ${C.dim}(read-only)${C.reset}`);

  /* -------------------------------------------------------------- R1 */
  section("R1 — App login role must bypass RLS (SUPERUSER or BYPASSRLS)");
  {
    const rows = q(
      `SELECT current_user,
              (CASE WHEN rolsuper THEN 't' ELSE 'f' END),
              (CASE WHEN rolbypassrls THEN 't' ELSE 'f' END)
         FROM pg_roles
        WHERE rolname = current_user`,
    );
    if (rows.length === 0) {
      fail("could not resolve the current login role from pg_roles");
    } else {
      const [role, isSuper, canBypass] = rows[0];
      const bypasses = isSuper === "t" || canBypass === "t";
      const detail = `role='${role}' rolsuper=${isSuper === "t"} rolbypassrls=${canBypass === "t"}`;
      if (bypasses) {
        pass(`login role escapes RLS (${detail})`);
      } else {
        fail(
          `login role does NOT escape RLS (${detail}).\n` +
          `        Tables are FORCE RLS, so the owner does not bypass — only SUPERUSER/BYPASSRLS does.\n` +
          `        Under this role every scheduler, worker, webhook and /public route would deny-all.\n` +
          `        Fix: point DATABASE_URL at a superuser/BYPASSRLS role, or grant BYPASSRLS to this role.`,
        );
      }
    }
  }

  /* -------------------------------------------------------------- R2a */
  section("R2 — `lexy_app` role exists (authenticated HTTP path uses SET ROLE lexy_app)");
  {
    const rows = q(
      `SELECT (CASE WHEN rolcanlogin THEN 't' ELSE 'f' END),
              (CASE WHEN rolbypassrls THEN 't' ELSE 'f' END)
         FROM pg_roles WHERE rolname = 'lexy_app'`,
    );
    if (rows.length === 0) {
      fail(
        "role `lexy_app` is MISSING.\n" +
        "        Every authenticated request runs SET ROLE lexy_app and will 5xx.\n" +
        "        Likely cause: prod was bootstrapped with `drizzle-kit push` (which does\n" +
        "        NOT create roles/policies/grants). Apply the .sql migrations 0000/0001/0021.",
      );
    } else {
      const [canLogin, canBypass] = rows[0];
      pass("role `lexy_app` exists");
      if (canLogin === "t") warn("`lexy_app` has LOGIN — expected NOLOGIN (SET ROLE target only)");
      if (canBypass === "t") warn("`lexy_app` has BYPASSRLS — expected false, or RLS is a no-op on the authed path");
    }
  }

  /* -------------------------------------------------------------- R2b */
  section("R2 — Critical tables must be ENABLE + FORCE + have a policy");
  {
    const rows = q(
      `SELECT c.relname,
              (CASE WHEN c.relrowsecurity THEN 't' ELSE 'f' END),
              (CASE WHEN c.relforcerowsecurity THEN 't' ELSE 'f' END),
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY(${pgArrayLiteral(CRITICAL_TABLES)})
        ORDER BY c.relname`,
    );
    const seen = new Map(rows.map((r) => [r[0], r]));
    for (const t of CRITICAL_TABLES) {
      const r = seen.get(t);
      if (!r) { fail(`${t}: table not found in public schema`); continue; }
      const [, enabled, forced, npol] = r;
      const nPolicies = Number(npol);
      const ok = enabled === "t" && forced === "t" && nPolicies >= 1;
      const detail = `enabled=${enabled === "t"} forced=${forced === "t"} policies=${nPolicies}`;
      if (ok) {
        pass(`${t}: ${detail}`);
      } else if (enabled === "t" && nPolicies === 0) {
        fail(`${t}: RLS enabled with ZERO policies -> deny-all for non-bypass roles (${detail})`);
      } else if (enabled === "t" && forced !== "t") {
        fail(`${t}: RLS enabled but NOT forced -> owner silently bypasses (${detail})`);
      } else {
        fail(`${t}: RLS not fully configured (${detail})`);
      }
    }
  }

  /* -------------------------------------------------------------- R3a */
  section("R3 — Subtree function `app_tenant_in_scope` (migration 0021)");
  {
    const rows = q(
      `SELECT count(*)::text FROM pg_proc p
         JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE p.proname = 'app_tenant_in_scope' AND n.nspname = 'public'`,
    );
    const n = rows.length ? Number(rows[0][0]) : 0;
    if (n >= 1) {
      pass("function `app_tenant_in_scope` exists (subtree policies can resolve)");
    } else {
      fail(
        "function `app_tenant_in_scope` is MISSING.\n" +
        "        Post-0021 policies call it in USING/WITH CHECK; authed reads will error.\n" +
        "        Apply migration 0021_rls_parent_child_subtree.sql.",
      );
    }
  }

  /* -------------------------------------------------------------- R3b */
  section("R3 — Migration-state consistency across the full RLS table set");
  {
    const rows = q(
      `SELECT c.relname,
              (CASE WHEN c.relrowsecurity THEN 't' ELSE 'f' END),
              (CASE WHEN c.relforcerowsecurity THEN 't' ELSE 'f' END),
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = ANY(${pgArrayLiteral(EXPECTED_RLS_TABLES)})
        ORDER BY c.relname`,
    );
    const seen = new Map(rows.map((r) => [r[0], r]));
    const problems = [];
    for (const t of EXPECTED_RLS_TABLES) {
      const r = seen.get(t);
      if (!r) { problems.push(`${t}: expected under RLS but table not found`); continue; }
      const [, enabled, forced, npol] = r;
      if (enabled !== "t") problems.push(`${t}: RLS NOT enabled`);
      else if (forced !== "t") problems.push(`${t}: enabled but NOT forced (owner bypass)`);
      else if (Number(npol) === 0) problems.push(`${t}: enabled but ZERO policies (deny-all)`);
    }
    if (problems.length === 0) {
      pass(`all ${EXPECTED_RLS_TABLES.length} expected tables are ENABLE + FORCE + policied`);
    } else {
      for (const p of problems) fail(p);
    }
  }

  /* -------------------------------------------------------------- R4 */
  section("R4 — Whole-schema scan for dangerous RLS states (any table)");
  {
    // RLS enabled but no policy -> deny-all for non-bypass roles.
    const noPolicy = q(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relrowsecurity = true
          AND (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) = 0
        ORDER BY c.relname`,
    ).map((r) => r[0]);
    if (noPolicy.length === 0) {
      pass("no table has RLS enabled with zero policies");
    } else {
      for (const t of noPolicy) fail(`${t}: RLS enabled with ZERO policies -> deny-all`);
    }

    // RLS enabled but not forced -> owner (incl. a non-super app role) bypasses.
    const notForced = q(
      `SELECT c.relname
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND c.relrowsecurity = true
          AND c.relforcerowsecurity = false
        ORDER BY c.relname`,
    ).map((r) => r[0]);
    if (notForced.length === 0) {
      pass("every RLS-enabled table is also FORCE (owner cannot silently bypass)");
    } else {
      for (const t of notForced) warn(`${t}: RLS enabled but NOT forced -> owner bypass (privacy gap, not outage)`);
    }
  }

  /* ------------------------------------------------------------ done */
  console.log(
    `\n${C.bold}Summary:${C.reset} ` +
    `${FAILS === 0 ? C.green : C.red}${FAILS} fail${C.reset}, ` +
    `${WARNS ? C.yellow : ""}${WARNS} warn${WARNS ? C.reset : ""}`,
  );
  if (FAILS === 0) {
    console.log(`${C.green}READY${C.reset} — no blocking issues found for this environment.`);
    process.exit(0);
  }
  console.log(`${C.red}NOT READY${C.reset} — resolve the FAILs above before relying on RLS here.`);
  process.exit(1);
}

try {
  main();
} catch (err) {
  const msg = err?.stderr?.toString?.() || err?.message || String(err);
  console.error(`${C.red}[rls-readiness] FAIL (could not run):${C.reset} ${msg.trim()}`);
  console.error("        Check DATABASE_URL is reachable and `psql` is on PATH.");
  process.exit(2);
}
