/**
 * recruiter-admin-extended-permissions.test.ts — Recruiter Admin ceiling on the
 * REST of the app (beyond jobs & candidates CRUD).
 *
 * Companion to recruiter-admin-permissions.test.ts. That suite proves the
 * `recruiter_admin` data ceiling on the jobs + candidates routes. This one
 * extends the SAME guarantee to the other tenant-scoped surfaces that lean on
 * getDataScopeTenantIds:
 *
 *   • pipeline board   GET  /jobs/:jobId/pipeline-stages
 *   • applications     GET  /applications  and  GET /applications/:id
 *   • talent match     GET  /talent-matches/by-candidate/:id  and  POST /talent-match
 *   • push-to-client   POST /candidates/:candidateId/push-to-client
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * Identical harness to the companion suite: the recruiter_admin ceiling is an
 * APP-layer check (getDataScopeTenantIds + inArray on the row's tenantId), not
 * Postgres RLS. So we mount the REAL routers on a bare Express app, seed a
 * tenant hierarchy via `dbAdmin` (BYPASSRLS), issue real bearer tokens, and hit
 * the routes over HTTP. Outside withTenantContext the `db` proxy falls through
 * to dbAdmin, so RLS never filters — isolating the app-layer permission logic.
 *
 * ─── Fixture (all ids prefixed `radx_` for safe teardown) ────────────────────
 *   agency  (parent)
 *    ├─ clientA  ← assigned to raPartial
 *    ├─ clientB  ← assigned to raPartial
 *    └─ clientC  ← NOT assigned (the unassigned client)
 *   other   (unrelated tenant, outside the agency subtree)
 *
 *   raZero    — recruiter_admin, ZERO assignments
 *   raPartial — recruiter_admin, assigned [clientA, clientB]
 *   tAdmin    — tenant_admin, used to prove blocks are role-specific
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
  talentMatchesTable,
  talentPoolSubmissionsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import pipelineRouter from "./pipeline";
import applicationsRouter from "./applications";
import talentMatchRouter from "./talent_match";
import candidatesRouter from "./candidates";

const P = "radx_";
const id = (s: string) => P + s;

const TENANT_IDS = ["agency", "clientA", "clientB", "clientC", "other"].map(id);

let server: Server;
let baseUrl: string;

/** issueToken only needs a valid userId — handlers re-read role/tenant from the DB row. */
function tokenFor(userId: string, role: string, tenantId: string | null) {
  return issueToken({ userId, role, tenantId });
}
const tok = {
  pAdmin: () => tokenFor(id("padmin"), "platform_admin", id("agency")),
  tAdmin: () => tokenFor(id("tadmin"), "tenant_admin", id("agency")),
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
  // FK-safe order: talent pool / matches / applications → assignments → jobs/candidates → users → tenants.
  await dbAdmin.delete(talentPoolSubmissionsTable).where(inArray(talentPoolSubmissionsTable.clientTenantId as any, TENANT_IDS));
  await dbAdmin.delete(talentMatchesTable).where(inArray(talentMatchesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(recruiterAdminClientsTable).where(inArray(recruiterAdminClientsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: id("agency"), name: "RADX Agency", slug: id("agency"), plan: "enterprise" },
    { id: id("clientA"), name: "RADX Client A", slug: id("clientA"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientB"), name: "RADX Client B", slug: id("clientB"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientC"), name: "RADX Client C", slug: id("clientC"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("other"), name: "RADX Other", slug: id("other"), plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("padmin"), tenantId: id("agency"), email: id("padmin") + "@t.test", name: "PAdmin", passwordHash: "x", role: "platform_admin" },
    { id: id("tadmin"), tenantId: id("agency"), email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin" },
    { id: id("razero"), tenantId: id("agency"), email: id("razero") + "@t.test", name: "RAZero", passwordHash: "x", role: "recruiter_admin" },
    { id: id("rapartial"), tenantId: id("agency"), email: id("rapartial") + "@t.test", name: "RAPartial", passwordHash: "x", role: "recruiter_admin" },
  ]);

  // raPartial is assigned clientA + clientB (NOT clientC).
  await dbAdmin.insert(recruiterAdminClientsTable).values([
    { tenantId: id("agency"), recruiterAdminUserId: id("rapartial"), clientTenantId: id("clientA") },
    { tenantId: id("agency"), recruiterAdminUserId: id("rapartial"), clientTenantId: id("clientB") },
  ]);

  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA"), tenantId: id("clientA"), title: "Job A", description: "desc", status: "active" },
    { id: id("jobB"), tenantId: id("clientB"), title: "Job B", description: "desc", status: "active" },
    { id: id("jobC"), tenantId: id("clientC"), title: "Job C", description: "desc", status: "active" },
    { id: id("jobAgency"), tenantId: id("agency"), title: "Job Agency", description: "desc", status: "active" },
    { id: id("jobOther"), tenantId: id("other"), title: "Job Other", description: "desc", status: "active" },
  ]);

  // currentTitle is required by the talent_pool_submissions snapshot (NOT NULL).
  await dbAdmin.insert(candidatesTable).values([
    { id: id("candA"), tenantId: id("clientA"), firstName: "Cand", lastName: "A", email: id("candA") + "@t.test", currentTitle: "Engineer", pool: "tenant" },
    { id: id("candB"), tenantId: id("clientB"), firstName: "Cand", lastName: "B", email: id("candB") + "@t.test", currentTitle: "Engineer", pool: "tenant" },
    { id: id("candC"), tenantId: id("clientC"), firstName: "Cand", lastName: "C", email: id("candC") + "@t.test", currentTitle: "Engineer", pool: "tenant" },
  ]);

  await dbAdmin.insert(applicationsTable).values([
    { id: id("appA"), tenantId: id("clientA"), jobId: id("jobA"), candidateId: id("candA"), stage: "applied" },
    { id: id("appB"), tenantId: id("clientB"), jobId: id("jobB"), candidateId: id("candB"), stage: "applied" },
    { id: id("appC"), tenantId: id("clientC"), jobId: id("jobC"), candidateId: id("candC"), stage: "applied" },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use("/api", pipelineRouter);
  app.use("/api", applicationsRouter);
  app.use("/api", talentMatchRouter);
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
 * PIPELINE BOARD — GET /jobs/:jobId/pipeline-stages
 * gateJobAccess narrows recruiter_admin to assigned clients (404 otherwise).
 * ──────────────────────────────────────────────────────────────────────────── */
test("pipeline board: zero-assignment recruiter_admin is blocked on every job (404)", async () => {
  for (const j of [id("jobA"), id("jobB"), id("jobC"), id("jobAgency")]) {
    const { status } = await api("GET", `/api/jobs/${j}/pipeline-stages`, tok.raZero());
    assert.equal(status, 404, `raZero must be blocked from ${j}`);
  }
});

test("pipeline board: partial recruiter_admin sees assigned jobs, blocked on unassigned", async () => {
  const okA = await api("GET", `/api/jobs/${id("jobA")}/pipeline-stages`, tok.raPartial());
  assert.equal(okA.status, 200, "should see the board for an assigned client's job");
  assert.ok(okA.json.stages, "board returns a stages map");

  const okB = await api("GET", `/api/jobs/${id("jobB")}/pipeline-stages`, tok.raPartial());
  assert.equal(okB.status, 200, "should see the board for the other assigned client's job");

  for (const blocked of [id("jobC"), id("jobAgency"), id("jobOther")]) {
    const { status } = await api("GET", `/api/jobs/${blocked}/pipeline-stages`, tok.raPartial());
    assert.equal(status, 404, `raPartial must be blocked from ${blocked}`);
  }
});

test("pipeline board: tenant_admin sees the unassigned client's board (block is role-specific)", async () => {
  const { status } = await api("GET", `/api/jobs/${id("jobC")}/pipeline-stages`, tok.tAdmin());
  assert.equal(status, 200, "tenant_admin reaches every subtree job, incl. the unassigned client");
  const other = await api("GET", `/api/jobs/${id("jobOther")}/pipeline-stages`, tok.tAdmin());
  assert.equal(other.status, 404, "tenant_admin still cannot reach the unrelated tenant");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * APPLICATIONS — GET /applications (list) and GET /applications/:id (detail)
 * Both gate via getDataScopeTenantIds. List returns an array.
 * ──────────────────────────────────────────────────────────────────────────── */
test("applications list: zero-assignment recruiter_admin sees nothing", async () => {
  const { status, json } = await api("GET", "/api/applications", tok.raZero());
  assert.equal(status, 200);
  assert.deepEqual(json, []);
});

test("applications list: partial recruiter_admin sees ONLY assigned clients", async () => {
  const { status, json } = await api("GET", "/api/applications", tok.raPartial());
  assert.equal(status, 200);
  const got = idsOf(json);
  assert.ok(got.has(id("appA")), "should see appA (clientA)");
  assert.ok(got.has(id("appB")), "should see appB (clientB)");
  assert.ok(!got.has(id("appC")), "must NOT see appC (unassigned clientC)");
});

test("applications detail: zero-assignment recruiter_admin gets 404", async () => {
  const { status } = await api("GET", `/api/applications/${id("appA")}`, tok.raZero());
  assert.equal(status, 404);
});

test("applications detail: partial recruiter_admin allowed for assigned, 404 for unassigned", async () => {
  const ok = await api("GET", `/api/applications/${id("appA")}`, tok.raPartial());
  assert.equal(ok.status, 200);
  assert.equal(ok.json.id, id("appA"));
  const blocked = await api("GET", `/api/applications/${id("appC")}`, tok.raPartial());
  assert.equal(blocked.status, 404);
});

test("applications list: tenant_admin sees the unassigned client's application too", async () => {
  const { status, json } = await api("GET", "/api/applications", tok.tAdmin());
  assert.equal(status, 200);
  const got = idsOf(json);
  for (const a of [id("appA"), id("appB"), id("appC")]) {
    assert.ok(got.has(a), `tenant_admin should see ${a}`);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * TALENT MATCH — GET /talent-matches/by-candidate/:id and POST /talent-match
 * Both gate the candidate (and job) via getDataScopeTenantIds.
 * ──────────────────────────────────────────────────────────────────────────── */
test("talent match by-candidate: zero-assignment recruiter_admin gets 404", async () => {
  const { status } = await api("GET", `/api/talent-matches/by-candidate/${id("candA")}`, tok.raZero());
  assert.equal(status, 404);
});

test("talent match by-candidate: partial allowed for assigned, 404 for unassigned", async () => {
  const ok = await api("GET", `/api/talent-matches/by-candidate/${id("candA")}`, tok.raPartial());
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.json.matches), "returns a matches array");
  const blocked = await api("GET", `/api/talent-matches/by-candidate/${id("candC")}`, tok.raPartial());
  assert.equal(blocked.status, 404);
});

test("talent match compute: zero-assignment recruiter_admin gets 404", async () => {
  const { status } = await api("POST", "/api/talent-match", tok.raZero(), {
    candidateId: id("candA"), jobId: id("jobA"),
  });
  assert.equal(status, 404);
});

test("talent match compute: partial allowed for assigned pair, 404 for unassigned", async () => {
  const ok = await api("POST", "/api/talent-match", tok.raPartial(), {
    candidateId: id("candA"), jobId: id("jobA"),
  });
  assert.equal(ok.status, 200, "compute fit for an assigned client's candidate↔job");

  const blocked = await api("POST", "/api/talent-match", tok.raPartial(), {
    candidateId: id("candC"), jobId: id("jobC"),
  });
  assert.equal(blocked.status, 404, "must be blocked computing fit for an unassigned client");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * PUSH-TO-CLIENT — POST /candidates/:candidateId/push-to-client
 * Narrows recruiter_admin to assigned clients for BOTH the source candidate and
 * the target client tenant (404 when out of scope).
 * ──────────────────────────────────────────────────────────────────────────── */
test("push-to-client: zero-assignment recruiter_admin is blocked (404)", async () => {
  const { status } = await api("POST", `/api/candidates/${id("candA")}/push-to-client`, tok.raZero(), {
    clientTenantId: id("clientA"),
  });
  assert.equal(status, 404, "zero-assignment recruiter_admin has an empty scope ⇒ client not found");
});

test("push-to-client: partial recruiter_admin can push within assigned, blocked otherwise", async () => {
  // Push an assigned client's candidate to an assigned client → allowed.
  const ok = await api("POST", `/api/candidates/${id("candA")}/push-to-client`, tok.raPartial(), {
    clientTenantId: id("clientB"),
  });
  assert.equal(ok.status, 200, "should push within assigned clients");
  assert.equal(ok.json.ok, true);

  // Target an UNASSIGNED client → 404.
  const blockedTarget = await api("POST", `/api/candidates/${id("candA")}/push-to-client`, tok.raPartial(), {
    clientTenantId: id("clientC"),
  });
  assert.equal(blockedTarget.status, 404, "must be blocked pushing to an unassigned client");

  // Source an UNASSIGNED client's candidate → 404 (cannot lift it into an assigned client).
  const blockedSource = await api("POST", `/api/candidates/${id("candC")}/push-to-client`, tok.raPartial(), {
    clientTenantId: id("clientA"),
  });
  assert.equal(blockedSource.status, 404, "must be blocked pushing an unassigned client's candidate");

  // Confirm only the one legitimate submission landed.
  const rows = await dbAdmin.select().from(talentPoolSubmissionsTable)
    .where(inArray(talentPoolSubmissionsTable.clientTenantId as any, TENANT_IDS));
  assert.equal(rows.length, 1, "exactly one push should have succeeded");
  assert.equal(rows[0].clientTenantId, id("clientB"));
});
