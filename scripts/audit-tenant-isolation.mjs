#!/usr/bin/env node
/* Tenant-isolation audit.
 *
 * Scans every route handler under artifacts/api-server/src/routes/ for Drizzle
 * queries against tables that have a tenant_id column. Flags any query whose
 * surrounding statement does NOT mention `tenantId`, which is the signal that
 * the handler may be returning / writing cross-tenant data.
 *
 * Expected false positives:
 *   - Intentional cross-tenant queries (platform-admin endpoints, schedulers,
 *     webhooks, public endpoints). These need manual whitelisting per case.
 *   - Queries that filter via a JOIN on an already-tenant-scoped table.
 *   - Queries that pull a single row by a globally-unique token (e.g. invite
 *     tokens) where tenant scoping is implicit.
 *
 * The script's job is to surface candidates for human review, not to make
 * final decisions. Treat every finding as "look at this line", not "this is
 * a bug".
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const ROUTES_DIR = join(ROOT, "artifacts/api-server/src/routes");
const SCHEMA_DIR = join(ROOT, "lib/db/src/schema");

/* ------------------------------------------------------------------ */
/* 1) Discover tenant-scoped Drizzle table identifiers                */
/* ------------------------------------------------------------------ */

// SQL table names (snake_case) that have a tenant_id column, per the audit
// run on the live dev DB. Embedded so the script is self-contained.
const TENANT_SCOPED_TABLES = new Set([
  "applications", "audit_logs", "billing_invoices", "billing_subscriptions",
  "candidate_import_batches", "candidate_import_records",
  "candidate_job_intelligence", "candidate_notifications",
  "candidate_rejections", "candidates", "communication_events",
  "credit_usage_events", "ghosting_alerts", "ghosting_risk_flags",
  "ideal_candidate_profiles", "interview_plans", "interview_schedules",
  "interview_sessions", "invite_tokens", "job_pipelines", "jobs",
  "nurture_pool", "outreach_campaigns", "outreach_conversation_drafts",
  "outreach_enrollments", "outreach_messages", "partner_attribution_events",
  "pipeline_runs", "prep_plans", "prep_sessions", "recruiter_digest_queue",
  "recruiter_inbox_items", "resume_screens", "sourced_candidates",
  "staff_invite_tokens", "talent_matches", "tenant_decision_policies",
  "trust_events", "user_notifications", "users", "verification_records",
]);

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...walk(p));
    else if (name.endsWith(".ts")) out.push(p);
  }
  return out;
}

// Map JS identifier (e.g. "candidatesTable") -> SQL table name (e.g.
// "candidates") by parsing every pgTable() declaration in the schema.
const tenantScopedIdents = new Map();
const allTableIdents = new Map();
const PG_TABLE_RE = /export\s+const\s+(\w+Table)\s*=\s*pgTable\s*\(\s*["']([^"']+)["']/g;
for (const f of walk(SCHEMA_DIR)) {
  const src = readFileSync(f, "utf8");
  let m;
  while ((m = PG_TABLE_RE.exec(src)) !== null) {
    allTableIdents.set(m[1], m[2]);
    if (TENANT_SCOPED_TABLES.has(m[2])) tenantScopedIdents.set(m[1], m[2]);
  }
}

/* ------------------------------------------------------------------ */
/* 2) Scan each route file                                            */
/* ------------------------------------------------------------------ */

/* Match any of these query starters (db, tx, trx) followed by anything up to
 * a terminating `;`. The `s` flag lets `.` cross newlines so we capture the
 * full multi-line statement (which is how Drizzle queries normally read). */
const STMT_RE = /\b(?:db|tx|trx)\.(?:select|insert|update|delete|with|execute)\b[\s\S]*?;/g;

/* Within a captured statement, the table identifier appears as the arg to
 * one of these Drizzle entry points. `from()` for select, `insert()/update()
 * /delete()` for writes. */
const TABLE_ENTRY_RE = /\.(?:from|insert|update|delete)\s*\(\s*(\w+Table)\b/g;

const findings = []; // { file, line, table, snippet }
const stats = { filesScanned: 0, stmtsScanned: 0, tenantStmts: 0 };

for (const file of walk(ROUTES_DIR)) {
  const src = readFileSync(file, "utf8");
  stats.filesScanned++;

  STMT_RE.lastIndex = 0;
  let stmtMatch;
  while ((stmtMatch = STMT_RE.exec(src)) !== null) {
    stats.stmtsScanned++;
    const stmt = stmtMatch[0];
    const stmtStart = stmtMatch.index;

    // Collect every tenant-scoped table referenced in this statement.
    const tables = new Set();
    TABLE_ENTRY_RE.lastIndex = 0;
    let tm;
    while ((tm = TABLE_ENTRY_RE.exec(stmt)) !== null) {
      if (tenantScopedIdents.has(tm[1])) tables.add(tm[1]);
    }
    if (tables.size === 0) continue;
    stats.tenantStmts++;

    /* The actual safety check: does the statement reference `tenantId`
     * anywhere? Drizzle queries that correctly scope by tenant ALWAYS
     * include the literal substring `tenantId` (either as a column ref
     * like `candidatesTable.tenantId` or as a value `tenantId: req...`).
     * If it's absent, the statement is a candidate for review. */
    if (/tenantId/.test(stmt)) continue;

    /* Severity classification:
     *   HIGH   — looks up / writes a tenant-scoped row by user-controlled
     *            input (req.params/body/query). These are the bugs that let
     *            tenant A read or modify tenant B's data by guessing IDs.
     *   MEDIUM — uses a variable lookup key (not literally req.*) but still
     *            scoped only by ID. Could be safe (key came from a previously
     *            tenant-filtered query) or unsafe (key came from input two
     *            hops back). Needs human review.
     *   LOW    — lookups by primary key on `users` from a JWT-derived userId
     *            (the userId is server-verified, so cross-tenant access via
     *            this path requires a JWT forgery, not an enumeration bug).
     */
    const usesReqInput = /\breq\.(?:params|body|query)\b/.test(stmt);
    const isUsersById = tables.size === 1
      && tables.has("usersTable")
      && /usersTable\.id\s*,\s*(?:userId|v\.payload\.sub|req\.resolvedUser)/.test(stmt);

    /* Detect the post-fetch tenant-check patterns. Look in a 60-line window
     * around the query (covers the typical handler body) for either:
     *   getAllowedTenantIds(user) followed by .includes(...tenantId)
     *      → applications/jobs/candidates pattern
     *   requireInterviewSessionCookie attached to the router chain
     *      → interview HMAC cookie-bound session pattern
     *   req.resolvedUser / requireRole / requireTenantAdmin upstream
     *      → role-gated handler where tenant scope is constrained by role
     */
    const winStart = src.lastIndexOf("\n", Math.max(0, stmtStart - 3000));
    const winEnd = src.indexOf("\n});", stmtStart);
    const window = src.slice(winStart, winEnd > 0 ? winEnd : stmtStart + 3000);
    const hasPostFetchCheck =
      /getAllowedTenantIds\s*\(/.test(window) ||
      /requireInterviewSessionCookie\b/.test(window) ||
      /allowed\.includes\s*\(\s*\w+\.tenantId/.test(window) ||
      /\.tenantId\s*!==\s*user\.tenantId/.test(window) ||
      /\.tenantId\s*!==\s*req\.resolvedUser\??\.?tenantId/.test(window) ||
      /user\.tenantId\s*!==\s*\w+\.tenantId/.test(window);

    let severity;
    if (hasPostFetchCheck) severity = "LOW";
    else if (usesReqInput) severity = "HIGH";
    else if (isUsersById) severity = "LOW";
    else severity = "MEDIUM";

    // Compute line number of the statement start for grep-able output.
    const line = src.slice(0, stmtStart).split("\n").length;

    // Trim snippet to a digestible size.
    const snippet = stmt
      .replace(/\s+/g, " ")
      .slice(0, 180)
      .trim();

    findings.push({
      file: file.replace(ROOT + "/", ""),
      line,
      tables: [...tables],
      severity,
      snippet,
    });
  }
}

/* ------------------------------------------------------------------ */
/* 3) Report                                                          */
/* ------------------------------------------------------------------ */

const counts = { HIGH: 0, MEDIUM: 0, LOW: 0 };
for (const f of findings) counts[f.severity]++;

console.log(`Scanned ${stats.filesScanned} route files`);
console.log(`Found ${stats.stmtsScanned} Drizzle statements, ${stats.tenantStmts} against tenant-scoped tables`);
console.log(`Flagged ${findings.length} statements with no \`tenantId\` reference`);
console.log(`  HIGH   = ${counts.HIGH}  (lookup keyed by req.params/body/query — likely real bug)`);
console.log(`  MEDIUM = ${counts.MEDIUM}  (lookup keyed by variable — needs human review)`);
console.log(`  LOW    = ${counts.LOW}  (users-table lookup by JWT-derived id — usually safe)\n`);

const severityFilter = process.argv[2]; // "HIGH" / "MEDIUM" / "LOW" / undefined
const filtered = severityFilter
  ? findings.filter((f) => f.severity === severityFilter)
  : findings;

// Group by file for readable output.
const byFile = new Map();
for (const f of filtered) {
  if (!byFile.has(f.file)) byFile.set(f.file, []);
  byFile.get(f.file).push(f);
}
const sortedFiles = [...byFile.keys()].sort();
for (const file of sortedFiles) {
  console.log(`\n=== ${file} (${byFile.get(file).length}) ===`);
  for (const f of byFile.get(file)) {
    console.log(`  ${f.severity}  L${f.line}  [${f.tables.join(", ")}]  ${f.snippet}`);
  }
}
