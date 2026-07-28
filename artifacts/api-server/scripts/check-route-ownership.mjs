#!/usr/bin/env node
/**
 * check-route-ownership.mjs — CI guard: every candidate/job/application-bearing
 * route must carry an access-control marker (ownership / tenant-scope gate) OR a
 * NAMED exemption. A route that references a candidate / job / application /
 * campaign identifier but contains neither fails the build, named explicitly.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Tier-2 ownership audit found real routes that touched candidate, job, or
 * application data with NO access control at all (unauthenticated staff reads in
 * agents.ts; a hard-coded tenant in sourcing.ts). Those are exactly the class of
 * regression this guard prevents: a new route that reads/writes an ownable entity
 * but forgets to scope it can never merge silently again.
 *
 * WHAT COUNTS AS "ID-BEARING"
 * ---------------------------
 * A route whose PATH declares one of the ownable params
 *   :candidateId  :jobId  :applicationId  :campaignId
 * OR whose HANDLER BODY references one of the identifiers
 *   candidateId   jobId   applicationId   campaignId
 * (this catches routes that read an ownable id from `:id`, the query string, or
 *  the request body rather than a canonical path param).
 *
 * WHAT COUNTS AS ENFORCEMENT  (any ONE of these tokens in the handler span)
 * ------------------------------------------------------------------------
 *   Tenant / data-scope ceiling : getAllowedTenantIds, getDataScopeTenantIds
 *   Recruiter ownership ceiling : recruiterOwnsResource, enforceOwnership,
 *                                 getRecruiterAssignedJobIds,
 *                                 recruiterCanAccessCandidate,
 *                                 recruiterIsAssignedToJob
 *   Agent viewer/writer gates   : resolveAgentViewer, requireAgentWriter
 *   Purpose-built access gates   : gateJobAccess, gateCandidateAccess,
 *                                 gateRowByTenant, requireRequisitionWriteAccess,
 *                                 requireIcpWriteAccess
 *   Webhook shared-secret gate  : requireInboundSecret
 *
 * WHAT COUNTS AS AN EXEMPTION  (opt-out — must be a NAMED justification)
 * ---------------------------------------------------------------------
 *   exemptFromOwnership(route, OWNERSHIP_EXEMPTION.X)   (middleware marker)
 *   readScopeExemption(NAMED_CONSTANT)                  (in-handler marker)
 * Anonymous exemptions are impossible: both helpers throw / require a named
 * constant from OWNERSHIP_EXEMPTION or the tenantUtils read-scope constants.
 *
 * ROUTE-LEVEL ALLOWLIST
 * ---------------------
 * A very small set of id-bearing routes are legitimately access-controlled by a
 * mechanism this text scanner cannot see inside the handler span (e.g. a public
 * candidate self-path gated by an interview capability-token cookie). Each such
 * route is listed in ALLOWLIST below WITH a justification. Adding an entry is a
 * deliberate human decision — that is the point.
 *
 * SCOPE / LIMITATION
 * ------------------
 * This guard scans Express ROUTE REGISTRATIONS in src/routes/*.ts (this reaches
 * every HTTP surface, INCLUDING webhook handlers, which are ordinary routes).
 * It does NOT and CANNOT reach background schedulers (src/lib/*-scheduler.ts) or
 * the AI-queue worker — those are cron/loop functions, not routed HTTP handlers,
 * so they have no route registration to inspect. Their tenant scoping is covered
 * by code review + the fairness / adverse-write guards, not by this check.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, dirname } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const ROUTES_DIR = join(ROOT, "src", "routes");

/* Ownable identifiers. Path params (declared with a leading colon) and the
 * bare identifier tokens a handler uses when it reads the id from :id / query /
 * body. Case-sensitive so `normalizedCandidateId` etc. don't false-match. */
const OWNABLE_PARAMS = ["candidateId", "jobId", "applicationId", "campaignId"];
const PARAM_RE = new RegExp(`:(?:${OWNABLE_PARAMS.join("|")})\\b`);
const BODY_RE = new RegExp(`\\b(?:${OWNABLE_PARAMS.join("|")})\\b`);

/* Tokens are split into two tiers.
 *
 * STRONG_TOKENS actually SCOPE or GATE the data — tenant/data-scope ceilings,
 * recruiter-ownership, purpose-built gates, agent gates, role/staff gates,
 * shared-secret gates, the interview capability cookie, and the candidate
 * SELF-PATH resolvers (which inherently scope to the caller's own row). Any one
 * of these in the handler span satisfies the guard.
 *
 * WEAK_TOKENS only RESOLVE the caller (getAuthUserId, resolveUser, …). Resolving
 * who is calling is necessary but NOT sufficient: a route can resolve the caller
 * and still read/write another tenant's rows if it never scopes the query. So a
 * weak token alone does NOT satisfy the guard — it must be paired with a strong
 * token (which then makes the strong token the thing we match on). This closes
 * the "authenticated but forgot to scope" false-negative class at the token
 * level; the residual (a strong token present but applied to the wrong id) still
 * belongs to code review, since that is statically intractable here.
 *
 * The guard's precise claim: an ownable-id route must carry AT LEAST ONE STRONG
 * marker, a named exemption, or a reviewed ALLOWLIST entry. */
const STRONG_TOKENS = [
  // Tenant / data-scope ceiling
  "getAllowedTenantIds",
  "getDataScopeTenantIds",
  "getAllowedTenantScope",
  // Single-tenant resolver: returns the CALLER's own tenant id, which the
  // handler then uses to scope its reads/writes (single-tenant getAllowedTenantIds).
  "getTenantId",
  // Recruiter ownership ceiling
  "recruiterOwnsResource",
  "enforceOwnership",
  "getRecruiterAssignedJobIds",
  "recruiterCanAccessCandidate",
  "recruiterIsAssignedToJob",
  // Agent viewer / writer gates
  "resolveAgentViewer",
  "requireAgentWriter",
  // Purpose-built access gates
  "gateJobAccess",
  "gateCandidate",
  "gateCandidateAccess",
  "gateRowByTenant",
  "requireRequisitionWriteAccess",
  "requireIcpWriteAccess",
  // Shared-secret gates (server-to-server import + inbound webhooks)
  "requireImportKey",
  "requireInboundSecret",
  // Interview capability-token cookie (the public interview room's bearer)
  "requireInterviewSessionCookie",
  // Candidate SELF-PATH resolvers — resolve the caller to THEIR OWN candidate
  // row (by users.id → candidates.userId), i.e. resolution and scoping in one
  // step. A route using one of these can only touch the caller's own candidate.
  "resolveCandidateId",
  "resolveCandidateSession",
  "resolveCandidateForRequest",
  // Role / staff gates
  "requireRole",
  "STAFF_ROLES",
  "isStaff",
];
/* Caller resolution only — necessary but NOT sufficient (see above). Listed for
 * documentation; deliberately NOT part of the pass criterion. */
const WEAK_TOKENS = [
  "getAuthUserId",
  "getCallerUser",
  "resolveUser",
  "resolvedUser",
  "ensureCandidateUser",
];
void WEAK_TOKENS;
const EXEMPTION_TOKENS = ["exemptFromOwnership", "readScopeExemption"];
const ENFORCE_RE = new RegExp(`\\b(?:${STRONG_TOKENS.join("|")})\\b`);
const EXEMPT_RE = new RegExp(`\\b(?:${EXEMPTION_TOKENS.join("|")})\\b`);

/* Reviewed baseline. Key = "<file> <METHOD> <path>"; value = justification.
 *
 * TWO kinds of entry, distinguished by the `KNOWN GAP:` prefix:
 *
 *  1. VERIFIED-CONTROLLED — the route IS access-controlled, but by a mechanism
 *     the per-route span scanner cannot observe (file-level `router.use`, an
 *     opaque/signed capability token looked up in the DB, a public-by-design
 *     endpoint, or the interview-room session-capability model). Human-reviewed.
 *
 *  2. KNOWN GAP: — a genuine pre-existing gap surfaced by this guard (routes the
 *     Tier-2 audit did not cover). Listed so the guard can go green as a CI gate
 *     that fails on any NEW gap, while these are tracked as debt. Every build
 *     re-prints them (see the KNOWN GAP reminder below) so they stay loud. They
 *     must be fixed (add the standard caller-resolution + tenant/ownership gate)
 *     and then removed from this list — do NOT add new KNOWN GAP entries.
 */
const ALLOWLIST = new Map([
  // ── 1. VERIFIED-CONTROLLED (scanner blind spots) ──────────────────────────
  // connection-engine: file-level `router.use("/connection-*", featureGuard,
  // resolveUser, scopeCandidate)` scopes every route below; the gate is not in
  // the per-route span.
  ["src/routes/connection-engine.ts GET /connection-score/:candidateId", "router.use(scopeCandidate) file-level tenant gate"],
  ["src/routes/connection-engine.ts GET /connection-events/:candidateId", "router.use(scopeCandidate) file-level tenant gate"],
  ["src/routes/connection-engine.ts POST /connection-event", "router.use(scopeCandidate) file-level tenant gate"],
  ["src/routes/connection-engine.ts POST /connection-score/recalculate", "router.use(scopeCandidate) file-level tenant gate"],
  // Interview room: authorized by the unguessable interview-session id + the
  // documented public-link capability model (assertSessionJobApproved, IP +
  // same-origin limits). /begin is the entry that mints the session cookie.
  ["src/routes/interviews.ts POST /interviews/start", "public interview capability model + work-order approval gate"],
  ["src/routes/interviews.ts POST /interviews/:interviewId/begin", "mints session cookie; IP + same-origin + approval gate"],
  ["src/routes/interviews.ts GET /interviews/:interviewId/consent-status", "session-capability route + assertSessionJobApproved"],
  ["src/routes/interviews.ts POST /interviews/:interviewId/consent", "session-capability route + assertSessionJobApproved + same-origin"],
  ["src/routes/interviews.ts POST /interviews/:interviewId/step-up/start", "session-capability route + per-session/IP rate limits"],
  ["src/routes/interviews.ts GET /interviews/:interviewId/intro", "session-capability route (unguessable session id)"],
  // Opaque / signed capability tokens looked up in the DB (expiry / HMAC).
  ["src/routes/invites.ts GET /invites/:token", "opaque invite token + expiry/usedAt lookup"],
  ["src/routes/invites.ts POST /invites/:token/accept", "opaque invite token + expiry/usedAt + IP limit"],
  ["src/routes/outreach-reply.ts POST /outreach/reply/:token", "HMAC-signed reply token (verifyReplyToken)"],
  ["src/routes/outreach-reply.ts POST /outreach/reply-msg/:token", "HMAC-signed reply token (verifyMessageReplyToken)"],
  ["src/routes/public.ts GET /interview-invite/:token", "opaque invite token + expiry lookup"],
  // Public-by-design, unauthenticated, IP-rate-limited (pre-signup surfaces).
  ["src/routes/public.ts POST /career-register", "public candidate signup, IP-rate-limited"],
  ["src/routes/public.ts POST /jobs/:id/apply", "public job-application endpoint, IP-rate-limited; tenant derived from the target job"],
  ["src/routes/disclosures.ts GET /portal/disclosures/active", "public pre-signup disclosure lookup, IP-rate-limited"],
  // Platform-admin-only overview; caller resolved (getCallerUser) + inline
  // role !== 'platform_admin' gate; intentionally cross-tenant (platform view).
  ["src/routes/jobs.ts GET /platform/open-work-orders", "platform_admin-only role gate (inline); cross-tenant platform overview by design"],
  // Records that a recruiter viewed a candidate: caller resolved (getCallerUser),
  // viewer tenant SERVER-DERIVED from the caller, returns no candidate data, and
  // the market-event view is intentionally cross-tenant (connection strength).
  ["src/routes/candidates.ts POST /recruiter/view-candidate", "caller resolved; viewer tenant server-derived; cross-tenant market event by design; returns no candidate data"],
  // Fee ledger: platform_admin-ONLY routes (getCallerUser + isPlatformAdmin
  // inline gate); intentionally cross-tenant — fees are L3XY revenue records,
  // not tenant data. Corrections additionally write an origin_corrections
  // audit row in the same transaction.
  ["src/routes/fee-ledger.ts GET /fee-ledger/export.csv", "platform_admin-only role gate (inline); cross-tenant revenue export by design"],
  ["src/routes/fee-ledger.ts POST /fee-ledger/corrections", "platform_admin-only role gate (inline); cross-tenant staff correction workflow, fully audited"],

  // ── 2. KNOWN GAP: pre-existing, must fix (Tier-2 did not cover these) ──────
  // agents.ts: the file's OWN standard is resolveAgentViewer/requireAgentWriter
  // + recruiterOwnsResource(jobId); these six pipeline routes read/write
  // jobPipelinesTable/jobsTable by :jobId with NO caller resolution and NO
  // ownership gate — any tenant member could read/alter another req's pipeline.
  ["src/routes/agents.ts GET /jobs/:jobId/pipeline-config", "KNOWN GAP: no caller resolution / ownership gate; apply resolveAgentViewer + recruiterOwnsResource(jobId)"],
  ["src/routes/agents.ts POST /jobs/:jobId/pipeline-config", "KNOWN GAP: no caller resolution / ownership gate; apply requireAgentWriter + recruiterOwnsResource(jobId)"],
  ["src/routes/agents.ts GET /jobs/:jobId/interview-direction", "KNOWN GAP: no caller resolution / ownership gate; apply resolveAgentViewer + recruiterOwnsResource(jobId)"],
  ["src/routes/agents.ts POST /jobs/:jobId/interview-direction", "KNOWN GAP: no caller resolution / ownership gate; apply requireAgentWriter + recruiterOwnsResource(jobId)"],
  ["src/routes/agents.ts GET /jobs/:jobId/pipeline-status", "KNOWN GAP: no caller resolution / ownership gate; apply resolveAgentViewer + recruiterOwnsResource(jobId)"],
  ["src/routes/agents.ts POST /jobs/:jobId/pipeline-stop", "KNOWN GAP: no caller resolution / ownership gate; apply requireAgentWriter + recruiterOwnsResource(jobId)"],
  // learning.ts: cross-tenant source-quality aggregate with no staff gate; the
  // file has a getCallerUser+role helper the other routes use — this one omits it.
  ["src/routes/learning.ts GET /source-quality", "KNOWN GAP: no staff/role gate; apply the file's getCallerUser + STAFF_ROLES helper"],
]);

const KNOWN_GAP_PREFIX = "KNOWN GAP:";

const REG_RE = /(?:router|app)\.(get|post|put|patch|delete)\(\s*(["'`])([^"'`]+)\2/g;
const DEF_RE =
  /(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(|const\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z0-9_$]+)\s*=>/g;

function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}

function lineOf(src, index) {
  return src.slice(0, index).split("\n").length;
}

/* Approximate body of a definition starting at `defIndex`: the function body is
 * the first `{` whose preceding non-whitespace char is `)` (end of params) or
 * `>` (end of a `Promise<…>` / arrow return type) — this skips `{` that belong
 * to a return-type object literal such as `Promise<{ caller: … }>` (preceded by
 * `<` or `:`). From that brace to its matching `}` (brace-balanced, best-effort). */
function bodyOf(src, defIndex) {
  let open = -1;
  for (let i = src.indexOf("{", defIndex); i !== -1; i = src.indexOf("{", i + 1)) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (src[j] === ")" || src[j] === ">") {
      open = i;
      break;
    }
  }
  if (open === -1) return "";
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const ch = src[i];
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return src.slice(open, i + 1);
    }
  }
  return src.slice(open);
}

/* Names of local (same-file) helpers that are transitively access-controlled: a
 * helper is "safe" if its OWN body carries a base access-control token OR calls
 * another already-safe local helper. Computed to a fixpoint so multi-hop chains
 * resolve (e.g. getCandidateId → resolveCandidateId → getAuthUserId). A route
 * span that calls any safe helper is controlled without hard-coding names. */
function localSafeHelpers(strippedSrc) {
  const defs = [];
  let m;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(strippedSrc)) !== null) {
    const name = m[1] || m[2];
    if (!name) continue;
    defs.push({ name, body: bodyOf(strippedSrc, m.index) });
  }
  const safe = new Set();
  // Seed: helpers whose body directly carries a base token.
  for (const d of defs) {
    if (ENFORCE_RE.test(d.body) || EXEMPT_RE.test(d.body)) safe.add(d.name);
  }
  // Fixpoint: add helpers that call an already-safe helper.
  let changed = true;
  while (changed) {
    changed = false;
    for (const d of defs) {
      if (safe.has(d.name)) continue;
      for (const s of safe) {
        if (new RegExp(`\\b${s}\\b`).test(d.body)) {
          safe.add(d.name);
          changed = true;
          break;
        }
      }
    }
  }
  return safe;
}

const files = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"))
  .map((f) => join(ROUTES_DIR, f))
  .filter((f) => statSync(f).isFile());

const offenders = [];
let idBearing = 0;
let allowlisted = 0;

for (const file of files) {
  const rel = relative(ROOT, file);
  const raw = readFileSync(file, "utf8");
  const src = stripComments(raw);

  /* Per-file transitive helper set → an extra "enforcement" matcher. */
  const helpers = localSafeHelpers(src);
  const helperRe =
    helpers.size > 0 ? new RegExp(`\\b(?:${[...helpers].join("|")})\\b`) : null;

  /* Collect every route registration with its RAW source offset (correct line
   * numbers) and its stripped span (clean token detection). */
  const regs = [];
  let m;
  REG_RE.lastIndex = 0;
  while ((m = REG_RE.exec(raw)) !== null) {
    regs.push({ method: m[1].toUpperCase(), path: m[3], index: m.index });
  }

  for (let i = 0; i < regs.length; i++) {
    const reg = regs[i];
    const end = i + 1 < regs.length ? regs[i + 1].index : raw.length;
    const span = stripComments(raw.slice(reg.index, end));

    const isIdBearing = PARAM_RE.test(reg.path) || BODY_RE.test(span);
    if (!isIdBearing) continue;
    idBearing++;

    const key = `${rel} ${reg.method} ${reg.path}`;
    if (ALLOWLIST.has(key)) {
      allowlisted++;
      continue;
    }

    if (ENFORCE_RE.test(span) || EXEMPT_RE.test(span)) continue;
    if (helperRe && helperRe.test(span)) continue;

    offenders.push({ key, file: rel, line: lineOf(raw, reg.index) });
  }
}

const summary = `[check-route-ownership] scanned ${files.length} route files, ${idBearing} id-bearing routes (${allowlisted} allowlisted)`;

/* Re-print the KNOWN GAP baseline on every run (including green) so the debt
 * stays loud and is never silently forgotten. These do NOT fail the build — the
 * guard's job is to block NEW gaps; the baseline is tracked, not enforced-away. */
const knownGaps = [...ALLOWLIST].filter(([, why]) => why.startsWith(KNOWN_GAP_PREFIX));
if (knownGaps.length > 0) {
  console.warn(
    `[check-route-ownership] ⚠ ${knownGaps.length} KNOWN GAP route(s) tracked in the baseline allowlist (fix + remove; see docs/SECURITY_PATTERNS.md):`,
  );
  for (const [key, why] of knownGaps) {
    console.warn(`  ${key} — ${why.slice(KNOWN_GAP_PREFIX.length).trim()}`);
  }
}

if (offenders.length === 0) {
  console.log(`${summary} — ✓ all carry an access-control marker or named exemption`);
  process.exit(0);
}

console.error(`${summary}`);
console.error(
  `[check-route-ownership] ✗ ${offenders.length} candidate/job/application-bearing route(s) with NO ownership gate and NO named exemption:`,
);
for (const o of offenders) {
  console.error(`  ${o.file}:${o.line}  ${o.key.slice(o.file.length + 1)}`);
}
console.error("");
console.error("Every route that touches a candidate / job / application / campaign id must either:");
console.error("  1. scope the data (getAllowedTenantIds / getDataScopeTenantIds) and, where a");
console.error("     recruiter ceiling applies, gate ownership (recruiterOwnsResource / enforceOwnership); or");
console.error("  2. declare a NAMED exemption: exemptFromOwnership(route, OWNERSHIP_EXEMPTION.X)");
console.error("     or readScopeExemption(NAMED_CONSTANT).");
console.error("If access control lives in a mechanism this scanner cannot see, add the route to");
console.error("ALLOWLIST in scripts/check-route-ownership.mjs with a justification (human review required).");
process.exit(1);
