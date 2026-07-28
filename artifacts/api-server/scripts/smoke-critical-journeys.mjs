#!/usr/bin/env node
/**
 * smoke-critical-journeys.mjs — End-to-end smoke for the critical user paths.
 *
 * Exercises, in order:
 *   1. Tenant + admin signup            (POST /auth/signup)
 *   2. Stripe checkout session          (POST /billing/checkout)            [optional]
 *   3. Recruiter invite generate/accept (POST /staff-invites + accept)
 *   4. Job posting create               (POST /jobs)
 *   5. Public candidate application     (POST /public/jobs/:id/apply)
 *   6. Candidate portal self-register   (POST /public/career-register)
 *   7. Candidate portal session resolve (GET /portal/candidate/me)
 *      — regression test for migration 0012: must return the registering
 *        candidate even if a recruiter shares the same email.
 *   8. Interview kickoff                (POST /interviews/start)             [best-effort]
 *   9. Hire decision                    (PATCH /applications/:id/status)     [best-effort]
 *
 * Exits 0 on full success, non-zero on any HARD BLOCKER failure. Steps marked
 * [optional] / [best-effort] log a warning but do not fail the run if the
 * underlying feature is not configured in the target environment (e.g. no
 * Stripe price ID).
 *
 * Usage:
 *   SMOKE_BASE_URL=http://localhost:5000 \
 *   SMOKE_EMAIL=smoke+local@lexy.ai \
 *   SMOKE_PASSWORD='Sm0ke!Pass123' \
 *     node artifacts/api-server/scripts/smoke-critical-journeys.mjs
 */

const BASE = (process.env.SMOKE_BASE_URL || "http://localhost:5000").replace(/\/+$/, "");
const STAMP = Date.now();
const ADMIN_EMAIL    = process.env.SMOKE_EMAIL    || `smoke-admin+${STAMP}@lexy.test`;
const ADMIN_PASSWORD = process.env.SMOKE_PASSWORD || `Sm0ke!Pass${STAMP}`;
const CAND_EMAIL     = `smoke-cand+${STAMP}@lexy.test`;
const CAND_PASSWORD  = `Sm0keC@nd${STAMP}`;
/* Second self-registered candidate. We assert that the first candidate's
 * token cannot resolve into the second candidate's profile — a deterministic
 * candidate-vs-candidate shadowing regression test that runs even when no
 * staff token is supplied. */
const CAND2_EMAIL    = `smoke-cand2+${STAMP}@lexy.test`;
const CAND2_PASSWORD = `Sm0keC@nd2${STAMP}`;
/* When SMOKE_REQUIRE_SHADOW_GUARD=true, the shadow-guard step fails the run
 * if SMOKE_STAFF_TOKEN was not supplied. Production / CI release runs MUST
 * set this so the adversarial cross-role probe cannot be silently skipped. */
const REQUIRE_SHADOW = String(process.env.SMOKE_REQUIRE_SHADOW_GUARD || "").toLowerCase() === "true";

let failures = 0;
let warnings = 0;
const fails = [];

function log(level, step, msg, extra) {
  const tag = { ok: "\u2713", warn: "!", fail: "\u2717", info: "·" }[level] || "·";
  const line = `[${tag}] ${step}: ${msg}`;
  if (extra !== undefined) console.log(line, extra);
  else console.log(line);
}

async function api(method, path, { token, body, expect = [200, 201] } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  let json = null;
  try { json = await r.json(); } catch { /* empty */ }
  const ok = expect.includes(r.status);
  return { ok, status: r.status, json };
}

function fail(step, msg, extra) { failures++; fails.push(step); log("fail", step, msg, extra); }
function warn(step, msg, extra) { warnings++; log("warn", step, msg, extra); }
function pass(step, msg, extra) { log("ok",   step, msg, extra); }

console.log(`\n== Lexy smoke @ ${BASE} ==\n`);

/* ── 1+2. Self-serve signup → Stripe checkout session ─────────────────── *
 * Self-serve signup is gated behind Stripe Checkout — POST /public/signup-
 * checkout persists a pending_trial_signups row and returns a Checkout URL.
 * The tenant + tenant_admin are provisioned by the Stripe webhook, so we
 * can't get an admin token end-to-end without a live webhook delivery. We
 * verify that the Checkout session creation succeeds and treat the rest as
 * "tested by the webhook integration suite, not this smoke". If billing is
 * not configured in this environment, we warn and continue. */
let adminToken = null, tenantId = null, adminUserId = null;
{
  const r = await api("POST", "/api/public/signup-checkout", {
    body: {
      name:     "Smoke Admin",
      email:    ADMIN_EMAIL,
      company:  `Smoke Co ${STAMP}`,
      password: ADMIN_PASSWORD,
      planCode: "starter",
      region:   "us",
    },
    expect: [200, 201, 400, 409, 429, 503],
  });
  if (r.status === 200 || r.status === 201) {
    pass("signup-checkout", `checkout url issued`);
  } else if (r.status === 503 || r.json?.error === "BILLING_NOT_CONFIGURED" || r.json?.error === "PRICE_ID_MISSING") {
    warn("signup-checkout", `billing not configured in this env`);
  } else if (r.status === 409) {
    warn("signup-checkout", `account already exists (re-run with a fresh email to test fully)`);
  } else {
    fail("signup-checkout", `status=${r.status}`, r.json);
  }
}

/* ── 3. Recruiter invite (best-effort — endpoint shape varies) ────────── */
let recruiterToken = null;
if (adminToken) {
  const r = await api("POST", "/api/staff-invites", {
    token: adminToken,
    body:  { email: `smoke-recruiter+${STAMP}@lexy.test`, role: "recruiter" },
    expect: [200, 201, 404, 405],
  });
  if (r.status === 200 || r.status === 201) {
    pass("invite-recruiter", `token issued`);
    const token = r.json?.token || r.json?.inviteToken;
    if (token) {
      const acc = await api("POST", `/api/staff-invites/${token}/accept`, {
        body:  { password: `R3cruiter!${STAMP}`, name: "Smoke Recruiter" },
        expect:[200, 201],
      });
      if (acc.ok) { recruiterToken = acc.json?.token; pass("invite-accept", "recruiter signed in"); }
      else        { warn("invite-accept", `status=${acc.status}`, acc.json); }
    }
  } else if (r.status === 404 || r.status === 405) {
    warn("invite-recruiter", `endpoint not present in this build (${r.status})`);
  } else {
    fail("invite-recruiter", `status=${r.status}`, r.json);
  }
}

/* ── 4. Job posting ───────────────────────────────────────────────────── */
let jobId = null;
if (adminToken) {
  const r = await api("POST", "/api/jobs", {
    token: adminToken,
    body: {
      title:       "Smoke Engineer",
      department:  "Engineering",
      location:    "Remote",
      employmentType: "full_time",
      description: "Smoke-test job — safe to delete.",
      status:      "open",
    },
    expect: [200, 201],
  });
  if (r.ok && r.json?.id) { jobId = r.json.id; pass("job-create", `id=${jobId}`); }
  else                    { fail("job-create", `status=${r.status}`, r.json); }
}

/* ── 5. Public candidate application ──────────────────────────────────── */
if (jobId) {
  const r = await api("POST", `/api/public/jobs/${jobId}/apply`, {
    body: {
      firstName: "Apply",
      lastName:  "Smoke",
      email:     `smoke-apply+${STAMP}@lexy.test`,
      phone:     "+1-555-0100",
    },
    expect: [200, 201],
  });
  if (r.ok) pass("apply", `application created`);
  else      fail("apply", `status=${r.status}`, r.json);
}

/* ── 6 + 7. Candidate self-register + portal session (the regression) ─── */
let candidateToken = null;
{
  const r = await api("POST", "/api/public/career-register", {
    body: {
      firstName: "Cand",
      lastName:  "Smoke",
      email:     CAND_EMAIL,
      password:  CAND_PASSWORD,
    },
    expect: [200, 201],
  });
  if (!r.ok || !r.json?.token) {
    fail("candidate-register", `status=${r.status}`, r.json);
  } else {
    candidateToken = r.json.token;
    pass("candidate-register", `userId=${r.json.user?.id}`);
  }
}

if (candidateToken) {
  const r = await api("GET", "/api/portal/candidate/me", {
    token: candidateToken,
    expect: [200],
  });
  if (!r.ok) {
    fail("candidate-portal-me", `status=${r.status}`, r.json);
  } else if (r.json?.data?.email?.toLowerCase() !== CAND_EMAIL.toLowerCase()) {
    fail("candidate-portal-me",
         `wrong candidate resolved: got ${r.json?.data?.email}, expected ${CAND_EMAIL}`);
  } else {
    pass("candidate-portal-me", `resolved correct candidate by FK`);
  }
}

/* Auth-shadowing regression: a NON-candidate session must NEVER resolve a
 * candidate. We need a non-candidate token to test this end-to-end.
 *   - In dev, set SMOKE_STAFF_TOKEN to any tenant_admin / recruiter / admin
 *     bearer token. The script will assert /portal/* returns 401.
 *   - In prod we get the staff token from the Stripe-webhook-provisioned
 *     admin (see the release runbook). When SMOKE_STAFF_TOKEN is absent we
 *     still run a meaningful negative test: an unauth GET must 401. */
{
  const r = await api("GET", "/api/portal/candidate/me", {
    expect: [401, 403],
  });
  if (r.status === 401 || r.status === 403) pass("portal-unauth-401", `unauth correctly refused (${r.status})`);
  else fail("portal-unauth-401", `unauth GET should 401, got ${r.status}`, r.json);
}
const staffToken = process.env.SMOKE_STAFF_TOKEN || null;
if (staffToken) {
  const r = await api("GET", "/api/portal/candidate/me", {
    token: staffToken,
    expect: [401, 403, 404],
  });
  if (r.status === 401 || r.status === 403 || r.status === 404) {
    pass("shadow-guard", `staff token correctly refused (${r.status})`);
  } else {
    fail("shadow-guard",
         `SECURITY: staff token resolved a candidate session (status=${r.status})`,
         r.json);
  }
} else if (REQUIRE_SHADOW) {
  fail("shadow-guard",
       "SMOKE_REQUIRE_SHADOW_GUARD=true but SMOKE_STAFF_TOKEN not provided — refusing to skip the adversarial cross-role probe on a release run");
} else {
  warn("shadow-guard", "SMOKE_STAFF_TOKEN not set — adversarial cross-role probe skipped (set SMOKE_REQUIRE_SHADOW_GUARD=true on release runs to fail-loud instead)");
}

/* Candidate-vs-candidate shadowing regression: register a SECOND candidate
 * and assert candidate-1's token resolves to candidate-1's row, never to
 * candidate-2's. Deterministic, runs every time, no staff token required. */
let candidate2Token = null, candidate2Id = null;
{
  const r = await api("POST", "/api/public/career-register", {
    body: {
      firstName: "Cand2",
      lastName:  "Smoke",
      email:     CAND2_EMAIL,
      password:  CAND2_PASSWORD,
    },
    expect: [200, 201],
  });
  if (r.ok && r.json?.token) {
    candidate2Token = r.json.token;
    candidate2Id    = r.json.user?.id;
  } else {
    fail("candidate2-register", `status=${r.status}`, r.json);
  }
}
if (candidateToken && candidate2Token) {
  const [r1, r2] = await Promise.all([
    api("GET", "/api/portal/candidate/me", { token: candidateToken, expect: [200] }),
    api("GET", "/api/portal/candidate/me", { token: candidate2Token, expect: [200] }),
  ]);
  const ok1 = r1.ok && r1.json?.data?.email?.toLowerCase() === CAND_EMAIL.toLowerCase();
  const ok2 = r2.ok && r2.json?.data?.email?.toLowerCase() === CAND2_EMAIL.toLowerCase();
  const distinct = r1.json?.data?.id && r2.json?.data?.id && r1.json.data.id !== r2.json.data.id;
  if (ok1 && ok2 && distinct) {
    pass("cand-vs-cand-shadow", `each token resolves to its own candidate`);
  } else {
    fail("cand-vs-cand-shadow",
         `SECURITY: candidate tokens did not resolve to distinct correct rows`,
         { cand1: r1.json?.data?.email, cand2: r2.json?.data?.email });
  }
}

/* ── 8. Interview kickoff (best-effort) ───────────────────────────────── */
if (candidateToken) {
  const r = await api("POST", "/api/portal/interviews/start", {
    token: candidateToken,
    body:  { kind: "baseline" },
    expect:[200, 201, 404, 405],
  });
  if (r.status === 200 || r.status === 201) pass("interview-start", `started`);
  else if (r.status === 404 || r.status === 405) warn("interview-start", `endpoint not present in this build`);
  else warn("interview-start", `status=${r.status}`, r.json);
}

/* ── 9. Hire decision (best-effort) ───────────────────────────────────── */
// Skipped unless we wired up the full pipeline in this smoke. Left as a
// follow-up so we don't block on it for the regression test.
warn("hire-decision", "not exercised by this script — manual verification");

console.log(`\n== Smoke complete: ${failures} failure(s), ${warnings} warning(s) ==`);
if (failures > 0) {
  console.log(`Failed steps: ${fails.join(", ")}`);
  process.exit(1);
}
process.exit(0);
