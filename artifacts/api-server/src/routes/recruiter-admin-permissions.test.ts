/**
 * recruiter-admin-permissions.test.ts — Recruiter Admin access-rule guards
 *
 * Guards the `recruiter_admin` role's data ceiling (added in the Recruiter
 * Admin work): a recruiter_admin may ONLY see/act on the client sub-tenants
 * explicitly ASSIGNED to them via recruiter_admin_clients. No assignments ⇒
 * sees and does nothing.
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * The recruiter_admin ceiling is enforced at the APP layer (getDataScopeTenantIds
 * + inArray on the row's tenantId), NOT by Postgres RLS. So we can exercise the
 * real route handlers end-to-end over HTTP without any RLS / lexy_app plumbing:
 *
 *   • mount the REAL jobs + candidates routers on a bare Express app,
 *   • seed a tenant hierarchy + users via `dbAdmin` (BYPASSRLS),
 *   • issue real bearer tokens with issueToken(), and
 *   • hit the routes with the global fetch() against an ephemeral port.
 *
 * Outside `withTenantContext`, the `db` proxy falls through to `dbAdmin`, so RLS
 * never filters here — which is exactly what we want: it isolates and proves the
 * app-layer Recruiter Admin permission logic, the thing under test.
 *
 * ─── Fixture (all ids prefixed `radt_` for safe teardown) ────────────────────
 *   agency  (parent)
 *    ├─ clientA  ← assigned to raPartial
 *    ├─ clientB  ← assigned to raPartial
 *    └─ clientC  ← NOT assigned (the unassigned client)
 *   other   (unrelated tenant, outside the agency subtree)
 *
 *   raZero    — recruiter_admin, ZERO assignments
 *   raPartial — recruiter_admin, assigned [clientA, clientB]
 *   tAdmin / recr / hm / pAdmin — other roles, used to prove they're unaffected
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  recruiterAdminClientsTable,
  candidateEventsTable,
  candidateOutcomesTable,
  jobRecruitersTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import jobsRouter from "./jobs";
import candidatesRouter from "./candidates";

const P = "radt_";
const id = (s: string) => P + s;

const TENANT_IDS = ["agency", "clientA", "clientB", "clientC", "other"].map(id);
const USER_IDS = ["padmin", "tadmin", "recr", "hm", "razero", "rapartial"].map(id);
const JOB_IDS = ["jobA", "jobB", "jobBdel", "jobC", "jobAgency", "jobOther"].map(id);
const CAND_IDS = ["candA", "candB", "candC", "candAgency", "candOther"].map(id);

let server: Server;
let baseUrl: string;

/** issueToken only needs a valid userId — getCallerUser re-reads role/tenant from the DB row. */
function tokenFor(userId: string, role: string, tenantId: string | null) {
  return issueToken({ userId, role, tenantId });
}
const tok = {
  pAdmin: () => tokenFor(id("padmin"), "platform_admin", id("agency")),
  tAdmin: () => tokenFor(id("tadmin"), "tenant_admin", id("agency")),
  recr: () => tokenFor(id("recr"), "recruiter", id("agency")),
  hm: () => tokenFor(id("hm"), "hiring_manager", id("agency")),
  raZero: () => tokenFor(id("razero"), "recruiter_admin", id("agency")),
  raPartial: () => tokenFor(id("rapartial"), "recruiter_admin", id("agency")),
};

async function api(
  method: string,
  path: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    json = null;
  }
  return { status: res.status, json };
}

async function cleanup() {
  // Delete in FK-safe order: events/outcomes → applications → jobs/candidates/assignments → users → tenants.
  await dbAdmin.delete(candidateEventsTable).where(inArray(candidateEventsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidateOutcomesTable).where(inArray(candidateOutcomesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(recruiterAdminClientsTable).where(inArray(recruiterAdminClientsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobRecruitersTable).where(inArray(jobRecruitersTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();

  // Tenants — clients get an `enterprise` plan (maxOpenJobs = -1, no expiry) so
  // the job-create plan gate never interferes with permission assertions.
  await dbAdmin.insert(tenantsTable).values([
    { id: id("agency"), name: "RADT Agency", slug: id("agency"), plan: "enterprise" },
    { id: id("clientA"), name: "RADT Client A", slug: id("clientA"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientB"), name: "RADT Client B", slug: id("clientB"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientC"), name: "RADT Client C", slug: id("clientC"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("other"), name: "RADT Other", slug: id("other"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("padmin"), tenantId: id("agency"), email: id("padmin") + "@t.test", name: "PAdmin", passwordHash: "x", role: "platform_admin" },
    { id: id("tadmin"), tenantId: id("agency"), email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin" },
    { id: id("recr"), tenantId: id("agency"), email: id("recr") + "@t.test", name: "Recr", passwordHash: "x", role: "recruiter" },
    { id: id("hm"), tenantId: id("agency"), email: id("hm") + "@t.test", name: "HM", passwordHash: "x", role: "hiring_manager" },
    { id: id("razero"), tenantId: id("agency"), email: id("razero") + "@t.test", name: "RAZero", passwordHash: "x", role: "recruiter_admin" },
    { id: id("rapartial"), tenantId: id("agency"), email: id("rapartial") + "@t.test", name: "RAPartial", passwordHash: "x", role: "recruiter_admin" },
    // Extra recruiters for the approve-with-roster tests: two in-scope (agency
    // subtree) recruiters, and one recruiter in the UNRELATED tenant (out of scope).
    { id: id("recr2"), tenantId: id("agency"), email: id("recr2") + "@t.test", name: "Recr2", passwordHash: "x", role: "recruiter" },
    { id: id("recrother"), tenantId: id("other"), email: id("recrother") + "@t.test", name: "RecrOther", passwordHash: "x", role: "recruiter" },
  ]);

  // raPartial is assigned clientA + clientB (NOT clientC).
  await dbAdmin.insert(recruiterAdminClientsTable).values([
    { tenantId: id("agency"), recruiterAdminUserId: id("rapartial"), clientTenantId: id("clientA") },
    { tenantId: id("agency"), recruiterAdminUserId: id("rapartial"), clientTenantId: id("clientB") },
  ]);

  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA"), tenantId: id("clientA"), title: "Job A", description: "desc", status: "active" },
    { id: id("jobB"), tenantId: id("clientB"), title: "Job B", description: "desc", status: "active" },
    { id: id("jobBdel"), tenantId: id("clientB"), title: "Job B (deletable)", description: "desc", status: "active" },
    { id: id("jobC"), tenantId: id("clientC"), title: "Job C", description: "desc", status: "active" },
    { id: id("jobAgency"), tenantId: id("agency"), title: "Job Agency", description: "desc", status: "active", assignedRecruiterId: id("recr"), assignedHiringManagerId: id("hm") },
    { id: id("jobOther"), tenantId: id("other"), title: "Job Other", description: "desc", status: "active" },
    // Dedicated fixtures for the close / reopen / role-outcome mutation routes so
    // those state-machine tests never couple to the CRUD jobs above.
    { id: id("jobAclose"), tenantId: id("clientA"), title: "Job A (closeable)", description: "desc", status: "active" },
    { id: id("jobAclosed"), tenantId: id("clientA"), title: "Job A (closed)", description: "desc", status: "closed" },
    { id: id("jobAapp"), tenantId: id("clientA"), title: "Job A (with app)", description: "desc", status: "active" },
    // Approval-flow fixtures (PATCH /jobs/:jobId/approve):
    //   jobApend     — pending in ASSIGNED clientA, created by tadmin → raPartial approves + staffs roster
    //   jobApendSelf — pending in clientA but CREATED BY raPartial → self-approval blocked
    //   jobCpend     — pending in UNASSIGNED clientC → 404 for raPartial
    { id: id("jobApend"), tenantId: id("clientA"), title: "Job A (pending)", description: "desc", status: "pending_approval", createdById: id("tadmin") },
    { id: id("jobApendSelf"), tenantId: id("clientA"), title: "Job A (pending, self)", description: "desc", status: "pending_approval", createdById: id("rapartial") },
    { id: id("jobCpend"), tenantId: id("clientC"), title: "Job C (pending)", description: "desc", status: "pending_approval", createdById: id("tadmin") },
  ]);

  await dbAdmin.insert(candidatesTable).values([
    { id: id("candA"), tenantId: id("clientA"), firstName: "Cand", lastName: "A", email: id("candA") + "@t.test", pool: "tenant" },
    { id: id("candB"), tenantId: id("clientB"), firstName: "Cand", lastName: "B", email: id("candB") + "@t.test", pool: "tenant" },
    { id: id("candC"), tenantId: id("clientC"), firstName: "Cand", lastName: "C", email: id("candC") + "@t.test", pool: "tenant" },
    { id: id("candAgency"), tenantId: id("agency"), firstName: "Cand", lastName: "Agency", email: id("candAgency") + "@t.test", pool: "tenant" },
    { id: id("candOther"), tenantId: id("other"), firstName: "Cand", lastName: "Other", email: id("candOther") + "@t.test", pool: "tenant" },
  ]);

  // Link candAgency ↔ jobAgency so the plain recruiter (assigned jobAgency) can
  // legitimately see exactly one candidate — proving the recruiter ceiling is
  // independent of the recruiter_admin narrowing.
  await dbAdmin.insert(applicationsTable).values([
    { id: id("appAgency"), tenantId: id("agency"), jobId: id("jobAgency"), candidateId: id("candAgency"), stage: "applied" },
    // appA lives in clientA (assigned to raPartial) → role-outcome allowed;
    // appAgency lives in agency (NOT a recruiter_admin client) → role-outcome denied.
    { id: id("appA"), tenantId: id("clientA"), jobId: id("jobAapp"), candidateId: id("candA"), stage: "applied" },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use("/api", jobsRouter);
  app.use("/api", candidatesRouter);
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

const idsOf = (rows: any[] | undefined) => new Set((rows ?? []).map((r) => r.id));

/* ─────────────────────────────────────────────────────────────────────────────
 * ZERO assignments — a recruiter_admin with no clients sees and does NOTHING.
 * ──────────────────────────────────────────────────────────────────────────── */
test("zero-assignment recruiter_admin: empty job list", async () => {
  const { status, json } = await api("GET", "/api/jobs", tok.raZero());
  assert.equal(status, 200);
  assert.deepEqual(json.jobs, []);
  assert.equal(json.total, 0);
});

test("zero-assignment recruiter_admin: empty candidate list", async () => {
  const { status, json } = await api("GET", "/api/candidates", tok.raZero());
  assert.equal(status, 200);
  assert.deepEqual(json.candidates, []);
  assert.equal(json.total, 0);
});

test("zero-assignment recruiter_admin: empty client list", async () => {
  const { status, json } = await api("GET", "/api/clients", tok.raZero());
  assert.equal(status, 200);
  assert.deepEqual(json.clients, []);
});

test("zero-assignment recruiter_admin: 403 creating a job in any client", async () => {
  const { status } = await api("POST", "/api/jobs", tok.raZero(), {
    title: "Nope", description: "x", clientId: id("clientA"),
  });
  assert.equal(status, 403);
});

test("zero-assignment recruiter_admin: 404 on job detail / mutate / delete", async () => {
  const get = await api("GET", `/api/jobs/${id("jobA")}`, tok.raZero());
  assert.equal(get.status, 404);
  const put = await api("PUT", `/api/jobs/${id("jobA")}`, tok.raZero(), { title: "Hacked" });
  assert.equal(put.status, 404);
  const del = await api("DELETE", `/api/jobs/${id("jobA")}`, tok.raZero());
  assert.equal(del.status, 404);
});

test("zero-assignment recruiter_admin: 404 on candidate detail", async () => {
  const { status } = await api("GET", `/api/candidates/${id("candA")}`, tok.raZero());
  assert.equal(status, 404);
});

test("zero-assignment recruiter_admin: 404 linking a candidate to a job", async () => {
  // Candidate-create with a jobId in an unassigned client must be rejected
  // (the foreign-jobId data-scope gate fires for an empty scope).
  const { status } = await api("POST", "/api/candidates", tok.raZero(), {
    firstName: "New", lastName: "Person", email: id("zero_new") + "@t.test", jobId: id("jobA"), confirmDuplicate: true,
  });
  assert.equal(status, 404);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * PARTIAL assignments — acts on assigned [A,B]; blocked on unassigned C & agency.
 * ──────────────────────────────────────────────────────────────────────────── */
test("partial recruiter_admin: job list shows ONLY assigned clients", async () => {
  const { status, json } = await api("GET", "/api/jobs", tok.raPartial());
  assert.equal(status, 200);
  const got = idsOf(json.jobs);
  assert.ok(got.has(id("jobA")), "should see jobA (clientA)");
  assert.ok(got.has(id("jobB")), "should see jobB (clientB)");
  assert.ok(!got.has(id("jobC")), "must NOT see jobC (unassigned clientC)");
  assert.ok(!got.has(id("jobAgency")), "must NOT see agency job");
  assert.ok(!got.has(id("jobOther")), "must NOT see unrelated tenant job");
});

test("partial recruiter_admin: candidate list shows ONLY assigned clients", async () => {
  const { status, json } = await api("GET", "/api/candidates", tok.raPartial());
  assert.equal(status, 200);
  const got = idsOf(json.candidates);
  assert.ok(got.has(id("candA")));
  assert.ok(got.has(id("candB")));
  assert.ok(!got.has(id("candC")), "must NOT see candC (unassigned)");
  assert.ok(!got.has(id("candAgency")), "must NOT see agency candidate");
  assert.ok(!got.has(id("candOther")), "must NOT see unrelated tenant candidate");
});

test("partial recruiter_admin: client list shows ONLY assigned clients", async () => {
  const { status, json } = await api("GET", "/api/clients", tok.raPartial());
  assert.equal(status, 200);
  const got = idsOf(json.clients);
  assert.deepEqual(got, new Set([id("clientA"), id("clientB")]));
});

test("partial recruiter_admin: job detail allowed for assigned, 404 for unassigned", async () => {
  const okJob = await api("GET", `/api/jobs/${id("jobA")}`, tok.raPartial());
  assert.equal(okJob.status, 200);
  assert.equal(okJob.json.id, id("jobA"));
  const blocked = await api("GET", `/api/jobs/${id("jobC")}`, tok.raPartial());
  assert.equal(blocked.status, 404);
  const blockedOther = await api("GET", `/api/jobs/${id("jobOther")}`, tok.raPartial());
  assert.equal(blockedOther.status, 404);
});

test("partial recruiter_admin: candidate detail allowed for assigned, 404 for unassigned", async () => {
  const ok = await api("GET", `/api/candidates/${id("candA")}`, tok.raPartial());
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id ?? ok.json.candidate?.id, id("candA"));
  const blocked = await api("GET", `/api/candidates/${id("candC")}`, tok.raPartial());
  assert.equal(blocked.status, 404);
});

test("partial recruiter_admin: create job allowed in assigned client, blocked elsewhere", async () => {
  const okCreate = await api("POST", "/api/jobs", tok.raPartial(), {
    title: "New A Role", description: "desc", clientId: id("clientA"),
  });
  assert.equal(okCreate.status, 201);
  assert.equal(okCreate.json.tenantId, id("clientA"));
  if (okCreate.json?.id) {
    await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, [okCreate.json.id]));
  }

  const blockedClient = await api("POST", "/api/jobs", tok.raPartial(), {
    title: "Nope C", description: "desc", clientId: id("clientC"),
  });
  assert.equal(blockedClient.status, 403);

  const blockedAgency = await api("POST", "/api/jobs", tok.raPartial(), {
    title: "Nope Agency", description: "desc", clientId: id("agency"),
  });
  assert.equal(blockedAgency.status, 403);

  const noClient = await api("POST", "/api/jobs", tok.raPartial(), {
    title: "Nope None", description: "desc",
  });
  assert.equal(noClient.status, 403);
});

test("partial recruiter_admin: update job allowed in assigned, 404 in unassigned", async () => {
  const ok = await api("PUT", `/api/jobs/${id("jobA")}`, tok.raPartial(), { title: "Job A (edited)" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.title, "Job A (edited)");
  const blocked = await api("PUT", `/api/jobs/${id("jobC")}`, tok.raPartial(), { title: "Hacked C" });
  assert.equal(blocked.status, 404);
});

test("partial recruiter_admin: delete job allowed in assigned, 404 in unassigned", async () => {
  const blocked = await api("DELETE", `/api/jobs/${id("jobC")}`, tok.raPartial());
  assert.equal(blocked.status, 404);
  const ok = await api("DELETE", `/api/jobs/${id("jobBdel")}`, tok.raPartial());
  assert.equal(ok.status, 200);
  // Confirm the unassigned job still exists (delete was truly blocked, not silent).
  const stillThere = await dbAdmin.select().from(jobsTable).where(inArray(jobsTable.id, [id("jobC")]));
  assert.equal(stillThere.length, 1);
});

/* ─────────────────────────────────────────────────────────────────────────────
 * OTHER ROLES are unaffected by the recruiter_admin narrowing.
 * ──────────────────────────────────────────────────────────────────────────── */
test("platform_admin: sees all jobs and all clients across tenants", async () => {
  const jobs = await api("GET", "/api/jobs", tok.pAdmin());
  assert.equal(jobs.status, 200);
  const jids = idsOf(jobs.json.jobs);
  for (const j of [id("jobA"), id("jobB"), id("jobC"), id("jobAgency"), id("jobOther")]) {
    assert.ok(jids.has(j), `platform_admin should see ${j}`);
  }
  const clients = await api("GET", "/api/clients", tok.pAdmin());
  const cids = idsOf(clients.json.clients);
  for (const t of TENANT_IDS) assert.ok(cids.has(t), `platform_admin should see tenant ${t}`);
});

test("tenant_admin: sees full agency subtree but NOT the unrelated tenant", async () => {
  const jobs = await api("GET", "/api/jobs", tok.tAdmin());
  assert.equal(jobs.status, 200);
  const jids = idsOf(jobs.json.jobs);
  // Full subtree: agency + all three clients (including the UNASSIGNED clientC).
  for (const j of [id("jobA"), id("jobB"), id("jobC"), id("jobAgency")]) {
    assert.ok(jids.has(j), `tenant_admin should see ${j}`);
  }
  assert.ok(!jids.has(id("jobOther")), "tenant_admin must NOT see the unrelated tenant's job");

  // Detail of the unassigned client's job works for tenant_admin (proves the
  // recruiter_admin 404 is role-specific, not a generic block).
  const detailC = await api("GET", `/api/jobs/${id("jobC")}`, tok.tAdmin());
  assert.equal(detailC.status, 200);
  const detailOther = await api("GET", `/api/jobs/${id("jobOther")}`, tok.tAdmin());
  assert.equal(detailOther.status, 404);

  const clients = await api("GET", "/api/clients", tok.tAdmin());
  const cids = idsOf(clients.json.clients);
  assert.deepEqual(
    cids,
    new Set([id("agency"), id("clientA"), id("clientB"), id("clientC")]),
  );
});

test("tenant_admin: can create a job in any subtree client (incl. the unassigned one)", async () => {
  const created = await api("POST", "/api/jobs", tok.tAdmin(), {
    title: "TA Job In C", description: "desc", clientId: id("clientC"),
  });
  assert.equal(created.status, 201);
  assert.equal(created.json.tenantId, id("clientC"));
  if (created.json?.id) {
    await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, [created.json.id]));
  }
});

test("recruiter: sees ONLY assigned requisitions and their linked candidate", async () => {
  const jobs = await api("GET", "/api/jobs", tok.recr());
  assert.equal(jobs.status, 200);
  const jids = idsOf(jobs.json.jobs);
  assert.deepEqual(jids, new Set([id("jobAgency")]), "recruiter sees only the req assigned to them");

  const cands = await api("GET", "/api/candidates", tok.recr());
  const cids = idsOf(cands.json.candidates);
  assert.ok(cids.has(id("candAgency")), "recruiter sees the candidate tied to their assigned req");
  assert.ok(!cids.has(id("candA")), "recruiter does NOT see an unrelated client's candidate");

  // Detail of a candidate NOT tied to their req is 404.
  const blocked = await api("GET", `/api/candidates/${id("candA")}`, tok.recr());
  assert.equal(blocked.status, 404);
});

test("hiring_manager: sees ONLY requisitions assigned to them", async () => {
  const jobs = await api("GET", "/api/jobs", tok.hm());
  assert.equal(jobs.status, 200);
  const jids = idsOf(jobs.json.jobs);
  assert.deepEqual(jids, new Set([id("jobAgency")]), "HM sees only the req where they are the assigned HM");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * ADDITIONAL JOB MUTATION ROUTES (state-machine, not plain CRUD):
 *   PATCH /jobs/:jobId/close, PATCH /jobs/:jobId/reopen, POST /jobs/:jobId/role-outcome
 * These gate on getDataScopeTenantIds and return 403 (not 404) when out of scope.
 * ──────────────────────────────────────────────────────────────────────────── */
test("recruiter_admin: can close an assigned client's job, blocked on unassigned", async () => {
  // raPartial closes jobAclose (clientA, assigned) → allowed.
  const ok = await api("PATCH", `/api/jobs/${id("jobAclose")}/close`, tok.raPartial());
  assert.equal(ok.status, 200, "should close a job in an assigned client");

  // raPartial cannot close jobC (clientC, unassigned) → 403, row unchanged.
  const blocked = await api("PATCH", `/api/jobs/${id("jobC")}/close`, tok.raPartial());
  assert.equal(blocked.status, 403, "must be forbidden from closing an unassigned client's job");
  const stillActive = await dbAdmin.select().from(jobsTable).where(inArray(jobsTable.id, [id("jobC")]));
  assert.equal(stillActive[0].status, "active", "blocked close must NOT mutate the job");
});

test("recruiter_admin: ZERO assignments cannot close any job (403)", async () => {
  const blocked = await api("PATCH", `/api/jobs/${id("jobA")}/close`, tok.raZero());
  assert.equal(blocked.status, 403, "zero-assignment recruiter_admin must be forbidden");
});

test("recruiter_admin: can reopen an assigned client's job, blocked on unassigned", async () => {
  const ok = await api("PATCH", `/api/jobs/${id("jobAclosed")}/reopen`, tok.raPartial());
  assert.equal(ok.status, 200, "should reopen a closed job in an assigned client");

  const blocked = await api("PATCH", `/api/jobs/${id("jobC")}/reopen`, tok.raPartial());
  assert.equal(blocked.status, 403, "must be forbidden from reopening an unassigned client's job");
});

test("recruiter_admin: role-outcome allowed for assigned client's application, blocked otherwise", async () => {
  // appA lives in clientA (assigned) → allowed. succeeded:false avoids any
  // started/outcome side-effects; it only logs a ROLE_OUTCOME_REPORTED event.
  const ok = await api("POST", `/api/jobs/${id("jobAapp")}/role-outcome`, tok.raPartial(), {
    applicationId: id("appA"), succeeded: false,
  });
  assert.equal(ok.status, 200, "should report a role outcome for an assigned client's application");

  // appAgency lives in the agency tenant (NOT a recruiter_admin client) → 403.
  const blocked = await api("POST", `/api/jobs/${id("jobAgency")}/role-outcome`, tok.raPartial(), {
    applicationId: id("appAgency"), succeeded: false,
  });
  assert.equal(blocked.status, 403, "must be forbidden from an application outside assigned clients");

  // Zero-assignment recruiter_admin is forbidden even for the same application.
  const blockedZero = await api("POST", `/api/jobs/${id("jobAapp")}/role-outcome`, tok.raZero(), {
    applicationId: id("appA"), succeeded: false,
  });
  assert.equal(blockedZero.status, 403, "zero-assignment recruiter_admin must be forbidden");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * CANDIDATE NON-CRUD MUTATION ROUTES (authz via getDataScopeTenantIds):
 *   PUT /candidates/:id (allow + deny), POST /candidates/:id/message (deny),
 *   POST /candidates/:id/resume (deny).
 * For message/resume only the DENY path is asserted: the recruiter_admin gate
 * runs (and returns 403) BEFORE any side-effect (email send / resume parse),
 * so deny is the meaningful, side-effect-free assertion for those routes. The
 * shared ALLOW path (same getDataScopeTenantIds gate) is proven by PUT below.
 * ──────────────────────────────────────────────────────────────────────────── */
test("recruiter_admin: can update an assigned client's candidate, blocked on unassigned", async () => {
  const ok = await api("PUT", `/api/candidates/${id("candA")}`, tok.raPartial(), { firstName: "Edited" });
  assert.equal(ok.status, 200, "should update a candidate in an assigned client");

  const blocked = await api("PUT", `/api/candidates/${id("candC")}`, tok.raPartial(), { firstName: "Hacked" });
  assert.equal(blocked.status, 403, "must be forbidden from updating an unassigned client's candidate");
  const row = await dbAdmin.select().from(candidatesTable).where(inArray(candidatesTable.id, [id("candC")]));
  assert.equal(row[0].firstName, "Cand", "blocked update must NOT mutate the candidate");
});

test("recruiter_admin: message route is forbidden for out-of-scope candidates (before send)", async () => {
  const blockedPartial = await api("POST", `/api/candidates/${id("candC")}/message`, tok.raPartial(), {
    subject: "Hi", body: "Hello",
  });
  assert.equal(blockedPartial.status, 403, "partial must be forbidden messaging an unassigned candidate");

  const blockedZero = await api("POST", `/api/candidates/${id("candA")}/message`, tok.raZero(), {
    subject: "Hi", body: "Hello",
  });
  assert.equal(blockedZero.status, 403, "zero-assignment must be forbidden messaging any candidate");
});

test("recruiter_admin: resume route is forbidden for out-of-scope candidates (before parse)", async () => {
  const blockedPartial = await api("POST", `/api/candidates/${id("candC")}/resume`, tok.raPartial(), {
    objectPath: "/resumes/x.pdf",
  });
  assert.equal(blockedPartial.status, 403, "partial must be forbidden attaching a resume to an unassigned candidate");

  const blockedZero = await api("POST", `/api/candidates/${id("candA")}/resume`, tok.raZero(), {
    objectPath: "/resumes/x.pdf",
  });
  assert.equal(blockedZero.status, 403, "zero-assignment must be forbidden attaching a resume to any candidate");
});

/* Other roles remain unaffected on these additional mutation routes. */
test("other roles unaffected: tenant_admin can close an unassigned client's job; recruiter is gated by req", async () => {
  // tenant_admin acts across the full subtree, incl. the UNASSIGNED clientC.
  const taClose = await api("PATCH", `/api/jobs/${id("jobC")}/close`, tok.tAdmin());
  assert.equal(taClose.status, 200, "tenant_admin should close any subtree job (proves block is role-specific)");

  // A plain recruiter may only close requisitions assigned to them; jobAclose
  // (clientA) is not assigned to recr → 403, independent of recruiter_admin.
  const recrBlocked = await api("PATCH", `/api/jobs/${id("jobAapp")}/close`, tok.recr());
  assert.equal(recrBlocked.status, 403, "recruiter cannot close a req not assigned to them");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * APPROVE & STAFF (PATCH /jobs/:jobId/approve) — recruiter_admin end-to-end:
 * a recruiter_admin may approve a pending_approval work order in an ASSIGNED
 * client and staff a multi-recruiter roster at approval time. Self-approval
 * is blocked, out-of-scope jobs 404, and out-of-scope roster ids 400.
 * ──────────────────────────────────────────────────────────────────────────── */
test("recruiter_admin approve: out-of-scope recruiter in roster → 400, job stays pending", async () => {
  // recrOther lives in the unrelated tenant → validateRecruiterIds must reject.
  const bad = await api("PATCH", `/api/jobs/${id("jobApend")}/approve`, tok.raPartial(), {
    assignedRecruiterId: id("recr"),
    assignedRecruiterIds: [id("recr"), id("recrother")],
  });
  assert.equal(bad.status, 400, "roster containing an out-of-scope recruiter must be rejected");
  const [row] = await dbAdmin.select().from(jobsTable).where(inArray(jobsTable.id, [id("jobApend")]));
  assert.equal(row.status, "pending_approval", "rejected approval must NOT mutate the job");
  assert.equal(row.assignedRecruiterId, null, "rejected approval must NOT assign a recruiter");
});

test("recruiter_admin approve: multi-recruiter roster → active, lead set, roster synced", async () => {
  // Mirrors the frontend buildApprovePayload shape: BOTH assignedRecruiterId
  // (lead = first pick) and assignedRecruiterIds (full roster).
  const ok = await api("PATCH", `/api/jobs/${id("jobApend")}/approve`, tok.raPartial(), {
    assignedRecruiterId: id("recr"),
    assignedRecruiterIds: [id("recr"), id("recr2")],
  });
  assert.equal(ok.status, 200, "recruiter_admin should approve a pending WO in an assigned client");
  assert.equal(ok.json.status, "active", "approved job must become active");
  assert.equal(ok.json.assignedRecruiterId, id("recr"), "lead recruiter = assignedRecruiterId");
  assert.equal(ok.json.approvedById, id("rapartial"), "approver must be recorded");

  // The join table holds the COMPLETE roster (lead included).
  const roster = await dbAdmin.select().from(jobRecruitersTable)
    .where(inArray(jobRecruitersTable.jobId, [id("jobApend")]));
  const rosterIds = new Set(roster.map((r) => r.recruiterUserId));
  assert.deepEqual(rosterIds, new Set([id("recr"), id("recr2")]), "job_recruiters must contain the full roster");
  assert.ok(roster.every((r) => r.tenantId === id("clientA")), "roster rows must carry the job's tenant");
});

test("recruiter_admin approve: self-approval blocked (403), job stays pending", async () => {
  const blocked = await api("PATCH", `/api/jobs/${id("jobApendSelf")}/approve`, tok.raPartial(), {
    assignedRecruiterId: id("recr"),
    assignedRecruiterIds: [id("recr")],
  });
  assert.equal(blocked.status, 403, "creator must not approve their own work order");
  const [row] = await dbAdmin.select().from(jobsTable).where(inArray(jobsTable.id, [id("jobApendSelf")]));
  assert.equal(row.status, "pending_approval", "blocked self-approval must NOT mutate the job");
});

test("recruiter_admin approve: unassigned client 404; zero-assignment 404", async () => {
  const partial = await api("PATCH", `/api/jobs/${id("jobCpend")}/approve`, tok.raPartial(), {});
  assert.equal(partial.status, 404, "pending WO in an UNASSIGNED client must be invisible (404)");

  const zero = await api("PATCH", `/api/jobs/${id("jobApendSelf")}/approve`, tok.raZero(), {});
  assert.equal(zero.status, 404, "zero-assignment recruiter_admin must see no pending WO (404)");

  const [row] = await dbAdmin.select().from(jobsTable).where(inArray(jobsTable.id, [id("jobCpend")]));
  assert.equal(row.status, "pending_approval", "blocked approvals must NOT mutate the job");
});
