/**
 * candidate-portal-existence-leak.test.ts
 * ────────────────────────────────────────────────────────────────────────────
 * PERMANENT regression net for LEAK A: GET /candidates/:candidateId must not
 * disclose the EXISTENCE of a separate, cross-pool job-seeker account that
 * happens to share the candidate's email address.
 *
 * Before the fix, the handler resolved `users WHERE email = candidate.email`
 * (across every tenant and pool) and returned `portalInvited: !!portalUser`.
 * So an employer viewing their OWN imported employee's ATS record could learn —
 * from `portalInvited: true` — that the person independently holds a Lexy career
 * account elsewhere (i.e. "my employee is quietly job-hunting"). That is a
 * cross-tenant existence disclosure.
 *
 * INVARIANTS PROVEN:
 *   1. No leak: for an employer's own imported employee (no invite accepted, no
 *      career profile under THIS candidate id) whose email ALSO belongs to a
 *      job-seeker account in a different tenant, the response carries
 *      hasPortalAccess:false and NO `portalInvited` field at all.
 *   2. Field is gone: `portalInvited` is absent from the payload entirely (it
 *      had no frontend consumer and was the sole carrier of the leak).
 *   3. CONTROL — still meaningful: a candidate who genuinely activated the
 *      portal via an accepted invite (keyed by THIS candidate id) still reports
 *      hasPortalAccess:true, proving activation is computed from c.id and the
 *      signal was not simply hard-wired to false.
 *
 * Harness mirrors candidate-privacy-seal-combinatorial.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  inviteTokensTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import candidatesRouter from "./candidates";

const P = "cpel_"; // candidate portal existence leak
const id = (s: string) => P + s;

const EMPLOYER = id("employer");   // the viewing tenant
const OTHER = id("other");         // where the employee's OWN job-seeker account lives
const ADMIN = id("adminEmployer");

/* This person is on the employer's payroll AND (secretly) a Lexy job-seeker. */
const SHARED_EMAIL = id("moonlighter") + "@js.test";

const C = {
  // Employer's own imported employee record — no invite accepted, no profile.
  employee: id("employeeRow"),
  // A genuinely portal-activated employer candidate (CONTROL for invariant 3).
  activated: id("activatedRow"),
};

/* The separate job-seeker USER account in OTHER, sharing SHARED_EMAIL — the
 * cross-pool existence the old code leaked. */
const OTHER_USER = id("otherUser");

const ALL_TENANTS = [EMPLOYER, OTHER];

let server: Server;
let baseUrl: string;

const tok = () => issueToken({ userId: ADMIN, role: "tenant_admin", tenantId: EMPLOYER });

async function getCandidate(candidateId: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${baseUrl}/candidates/${candidateId}`, {
    headers: { Authorization: `Bearer ${tok()}` },
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(inviteTokensTable).where(inArray(inviteTokensTable.candidateId, [C.employee, C.activated]));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, [C.employee, C.activated]));
  for (const t of ALL_TENANTS) {
    await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, t));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, t));
  }
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: EMPLOYER, name: "Employer Co", slug: EMPLOYER, plan: "enterprise", website: "https://employer.test" },
    { id: OTHER, name: "Other Pool", slug: OTHER, plan: "starter", website: "https://other.test" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: ADMIN, tenantId: EMPLOYER, email: id("admin") + "@employer.test", name: "Employer Admin", passwordHash: "x", role: "tenant_admin", status: "active" },
    // The employee's OWN independent job-seeker account, in a DIFFERENT tenant,
    // sharing the same email. This is precisely the existence the old code leaked.
    { id: OTHER_USER, tenantId: OTHER, email: SHARED_EMAIL, name: "Moonlighter", passwordHash: "x", role: "candidate", status: "active" },
  ]);

  await dbAdmin.insert(candidatesTable).values([
    // Employer's imported employee — pool=tenant, userId null (no portal user of
    // its OWN), never accepted an invite, no career profile under this id.
    { id: C.employee, tenantId: EMPLOYER, firstName: "Moon", lastName: "Lighter", email: SHARED_EMAIL, pool: "tenant", source: "manual" },
    // A separate employer candidate who genuinely activated via accepted invite.
    { id: C.activated, tenantId: EMPLOYER, firstName: "Real", lastName: "Activated", email: id("activated") + "@js.test", pool: "tenant", source: "manual" },
  ]);

  // Accepted invite keyed by THIS candidate id → activation is real for C.activated.
  await dbAdmin.insert(inviteTokensTable).values([
    { token: id("tok"), candidateId: C.activated, userId: null, tenantId: EMPLOYER, expiresAt: new Date(Date.now() + 86_400_000), usedAt: new Date() },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(candidatesRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
});

test("imported employee sharing an email with a cross-pool account leaks no existence signal", async () => {
  const { status, json } = await getCandidate(C.employee);
  assert.equal(status, 200, `GET /candidates/${C.employee} → ${status}: ${JSON.stringify(json)}`);

  // The leaked field must be gone entirely — no cross-pool oracle.
  assert.ok(!("portalInvited" in json), "response must NOT carry the leaky 'portalInvited' field");

  // Activation is computed from THIS candidate id, which never accepted an invite
  // nor built a career profile → false, regardless of the cross-pool account.
  assert.equal(json.hasPortalAccess, false, "employee with no own activation must report hasPortalAccess:false");
});

test("CONTROL — a genuinely activated candidate still reports hasPortalAccess:true", async () => {
  const { status, json } = await getCandidate(C.activated);
  assert.equal(status, 200, `GET /candidates/${C.activated} → ${status}: ${JSON.stringify(json)}`);
  assert.ok(!("portalInvited" in json), "response must NOT carry the leaky 'portalInvited' field");
  assert.equal(json.hasPortalAccess, true, "candidate with an accepted invite (by c.id) must report hasPortalAccess:true");
});
