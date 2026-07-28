/**
 * job-apply-enumeration.test.ts
 * ────────────────────────────────────────────────────────────────────────────
 * PERMANENT regression net: the unauthenticated, internet-facing
 * POST /public/jobs/:id/apply endpoint MUST NOT behave as an enumeration
 * oracle, and MUST NOT hand the caller a portal magic-link token.
 *
 * Before the fix:
 *   - a duplicate (email, job) application returned a distinct 409
 *     "already applied" — letting anyone probe whether a person applied to a
 *     specific job (i.e. "this person is job-seeking at this company");
 *   - the 201 body returned a live portalInviteToken for the typed email's
 *     portal account, which /accept-invite exchanges for a session with no
 *     email-ownership proof — an account-takeover primitive.
 *
 * INVARIANTS PROVEN:
 *   1. Fresh-email, existing-candidate-email, and already-applied responses
 *      are byte-identical (same status, same body, no set-cookie).
 *   2. The body carries NO token / candidateId / applicationId / portal flag.
 *   3. The duplicate branch creates no second application row (side-effect
 *      control), while the fresh branch really creates candidate+application
 *      (anti-vacuous control).
 *
 * SES creds are blanked so sendEmail() takes its simulated-send branch.
 * Harness mirrors career-register-enumeration.test.ts.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { and, eq, inArray, like } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  jobsTable,
  applicationsTable,
} from "@workspace/db";
import publicRouter from "./public";

const P = "japenum_";
const id = (s: string) => P + s;

const TENANT = id("tenant");
const JOB = id("job");

/* Email that is already a candidate in this tenant (existing-candidate branch). */
const EXISTING_EMAIL = id("existing") + "@js.test";
const EXISTING_CAND = id("cand_existing");
/* Email that already APPLIED to this job (duplicate-application branch). */
const APPLIED_EMAIL = id("applied") + "@js.test";
const APPLIED_CAND = id("cand_applied");
const APPLIED_APP = id("app_applied");
/* Never-before-seen email (fresh branch / control). */
const NEW_EMAIL = id("fresh") + "@js.test";

let server: Server;
let baseUrl: string;

const SES_ENV_KEYS = [
  "SES_FROM_EMAIL",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
] as const;
const savedEnv: Record<string, string | undefined> = {};

type ApplyResult = { status: number; json: any; setCookie: string | null };

async function applyCall(email: string): Promise<ApplyResult> {
  const res = await fetch(`${baseUrl}/jobs/${JOB}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ firstName: "Probe", lastName: "Tester", email }),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json, setCookie: res.headers.get("set-cookie") };
}

let fresh: ApplyResult;
let existingCand: ApplyResult;
let duplicate: ApplyResult;

async function cleanup() {
  await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.tenantId, TENANT));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, TENANT));
  await dbAdmin.delete(usersTable).where(like(usersTable.email, `${P}%`));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, TENANT));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.id, JOB));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [TENANT]));
}

async function seed() {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: TENANT, name: "Apply Enum Co", slug: TENANT, plan: "enterprise", website: "https://japenum.test" },
  ]);
  await dbAdmin.insert(jobsTable).values([
    { id: JOB, tenantId: TENANT, title: "Enum Probe Engineer", description: "probe", status: "active" } as any,
  ]);
  await dbAdmin.insert(candidatesTable).values([
    { id: EXISTING_CAND, tenantId: TENANT, firstName: "Ex", lastName: "Isting", email: EXISTING_EMAIL } as any,
    { id: APPLIED_CAND, tenantId: TENANT, firstName: "Al", lastName: "Ready", email: APPLIED_EMAIL } as any,
  ]);
  await dbAdmin.insert(applicationsTable).values([
    { id: APPLIED_APP, tenantId: TENANT, jobId: JOB, candidateId: APPLIED_CAND, stage: "applied" } as any,
  ]);
}

before(async () => {
  for (const k of SES_ENV_KEYS) { savedEnv[k] = process.env[k]; delete process.env[k]; }
  await seed();
  const app = express();
  app.use(express.json());
  app.use(publicRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
  fresh = await applyCall(NEW_EMAIL);
  existingCand = await applyCall(EXISTING_EMAIL);
  duplicate = await applyCall(APPLIED_EMAIL);
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await cleanup();
  for (const k of SES_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});

test("fresh / existing-candidate / already-applied responses are byte-identical", () => {
  assert.equal(fresh.status, 201, `fresh status: ${fresh.status} ${JSON.stringify(fresh.json)}`);
  assert.equal(existingCand.status, fresh.status, "existing-candidate status must match fresh");
  assert.equal(duplicate.status, fresh.status, "already-applied status must match fresh (was 409 pre-fix)");

  assert.deepEqual(existingCand.json, fresh.json, "existing-candidate body must equal fresh body");
  assert.deepEqual(duplicate.json, fresh.json, "already-applied body must equal fresh body");

  assert.equal(fresh.setCookie, null, "no session cookie on any branch");
  assert.equal(existingCand.setCookie, null);
  assert.equal(duplicate.setCookie, null);
});

test("body carries no token or identifying artifacts", () => {
  assert.equal(fresh.json?.success, true, "success envelope expected");
  assert.equal(typeof fresh.json?.message, "string");
  for (const leaky of [
    "portalInviteToken", "token", "candidateId", "applicationId",
    "hasPortalAccount", "alreadyApplied", "error",
  ]) {
    assert.ok(!(leaky in (fresh.json ?? {})), `body must not carry '${leaky}'`);
    assert.ok(!(leaky in (duplicate.json ?? {})), `duplicate body must not carry '${leaky}'`);
  }
});

test("duplicate branch creates no second application; fresh branch creates candidate+application (controls)", async () => {
  const appsForApplied = await dbAdmin
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(and(eq(applicationsTable.jobId, JOB), eq(applicationsTable.candidateId, APPLIED_CAND)));
  assert.equal(appsForApplied.length, 1, "already-applied branch must not insert a second application row");

  const candsForNew = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(and(eq(candidatesTable.tenantId, TENANT), eq(candidatesTable.email, NEW_EMAIL)));
  assert.equal(candsForNew.length, 1, "fresh branch must create exactly one candidate");

  const appsForNew = await dbAdmin
    .select({ id: applicationsTable.id })
    .from(applicationsTable)
    .where(and(eq(applicationsTable.jobId, JOB), eq(applicationsTable.candidateId, candsForNew[0].id)));
  assert.equal(appsForNew.length, 1, "fresh branch must create exactly one application");
});
