/**
 * recruiter-admin-intel-analytics-scoping.test.ts — Recruiter Admin ceiling on
 * the intelligence & analytics surfaces.
 *
 * Companion to recruiter-admin-extended-permissions.test.ts. That suite proves
 * the `recruiter_admin` data ceiling on the pipeline board, applications,
 * talent-match and push-to-client. This one extends the SAME guarantee to the
 * two remaining tenant-scoped surfaces that used to lean on the raw agency
 * subtree (getAllowedTenantIds) instead of the assigned-clients-only ceiling
 * (getDataScopeTenantIds):
 *
 *   • intelligence  GET /intelligence            (candidate×job intelligence rows)
 *   • analytics     GET /analytics/overview      (tenant-scoped KPI counts)
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * Identical harness to the companion suite: the recruiter_admin ceiling is an
 * APP-layer check (getDataScopeTenantIds + a tenantId filter), not Postgres RLS.
 * So we mount the REAL routers on a bare Express app, seed a tenant hierarchy
 * via `dbAdmin` (BYPASSRLS), issue real bearer tokens, and hit the routes over
 * HTTP. Outside withTenantContext the `db` proxy falls through to dbAdmin, so
 * RLS never filters — isolating the app-layer permission logic.
 *
 * ─── Fixture (all ids prefixed `radia_` for safe teardown) ───────────────────
 *   agency  (parent)
 *    ├─ clientA  ← assigned to raPartial
 *    ├─ clientB  ← assigned to raPartial
 *    └─ clientC  ← NOT assigned (the unassigned client)
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
  candidateJobIntelligenceTable,
  outreachCampaignsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import analyticsRouter from "./analytics";
import intelligenceRouter from "./intelligence";

const P = "radia_";
const id = (s: string) => P + s;

const TENANT_IDS = ["agency", "clientA", "clientB", "clientC"].map(id);

let server: Server;
let baseUrl: string;

/** issueToken only needs a valid userId — handlers re-read role/tenant from the DB row. */
function tokenFor(userId: string, role: string, tenantId: string | null) {
  return issueToken({ userId, role, tenantId });
}
const tok = {
  tAdmin: () => tokenFor(id("tadmin"), "tenant_admin", id("agency")),
  raZero: () => tokenFor(id("razero"), "recruiter_admin", id("agency")),
  raPartial: () => tokenFor(id("rapartial"), "recruiter_admin", id("agency")),
};

async function api(
  method: string,
  path: string,
  token: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
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
  // FK-safe order: intelligence / applications / campaigns → assignments → jobs/candidates → users → tenants.
  await dbAdmin.delete(outreachCampaignsTable).where(inArray(outreachCampaignsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidateJobIntelligenceTable).where(inArray(candidateJobIntelligenceTable.tenantId, TENANT_IDS));
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
    { id: id("agency"), name: "RADIA Agency", slug: id("agency"), plan: "enterprise" },
    { id: id("clientA"), name: "RADIA Client A", slug: id("clientA"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientB"), name: "RADIA Client B", slug: id("clientB"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
    { id: id("clientC"), name: "RADIA Client C", slug: id("clientC"), parentId: id("agency"), clientType: "sub_client", plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
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
  ]);

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

  // One intelligence row per client so the GET /intelligence list has rows to scope.
  await dbAdmin.insert(candidateJobIntelligenceTable).values([
    { id: id("intelA"), tenantId: id("clientA"), jobId: id("jobA"), candidateId: id("candA"), hireProbability: 90 },
    { id: id("intelB"), tenantId: id("clientB"), jobId: id("jobB"), candidateId: id("candB"), hireProbability: 80 },
    { id: id("intelC"), tenantId: id("clientC"), jobId: id("jobC"), candidateId: id("candC"), hireProbability: 70 },
  ]);

  // One outreach campaign per client so GET /analytics/engagement's outreachSummary
  // (campaigns count + totalSent) has per-client rows to scope.
  await dbAdmin.insert(outreachCampaignsTable).values([
    { id: id("campA"), tenantId: id("clientA"), jobId: id("jobA"), name: "Campaign A", sentCount: 10 },
    { id: id("campB"), tenantId: id("clientB"), jobId: id("jobB"), name: "Campaign B", sentCount: 20 },
    { id: id("campC"), tenantId: id("clientC"), jobId: id("jobC"), name: "Campaign C", sentCount: 40 },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use("/api", analyticsRouter);
  app.use("/api/intelligence", intelligenceRouter);
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
 * INTELLIGENCE — GET /intelligence  (candidate×job intelligence rows)
 * Scoped via getDataScopeTenantIds: recruiter_admin sees only assigned clients.
 * ──────────────────────────────────────────────────────────────────────────── */
test("intelligence list: zero-assignment recruiter_admin sees nothing", async () => {
  const { status, json } = await api("GET", "/api/intelligence", tok.raZero());
  assert.equal(status, 200);
  assert.deepEqual(json.data, []);
});

test("intelligence list: partial recruiter_admin sees ONLY assigned clients", async () => {
  const { status, json } = await api("GET", "/api/intelligence", tok.raPartial());
  assert.equal(status, 200);
  const got = idsOf(json.data);
  assert.ok(got.has(id("intelA")), "should see intelA (clientA)");
  assert.ok(got.has(id("intelB")), "should see intelB (clientB)");
  assert.ok(!got.has(id("intelC")), "must NOT see intelC (unassigned clientC)");
});

test("intelligence list: tenant_admin sees the unassigned client's row too (block is role-specific)", async () => {
  const { status, json } = await api("GET", "/api/intelligence", tok.tAdmin());
  assert.equal(status, 200);
  const got = idsOf(json.data);
  for (const i of [id("intelA"), id("intelB"), id("intelC")]) {
    assert.ok(got.has(i), `tenant_admin should see ${i}`);
  }
});

/* ─────────────────────────────────────────────────────────────────────────────
 * ANALYTICS — GET /analytics/overview  (tenant-scoped KPI counts)
 * Scoped via getDataScopeTenantIds: counts cover only assigned clients.
 * ──────────────────────────────────────────────────────────────────────────── */
test("analytics overview: zero-assignment recruiter_admin sees all-zero counts", async () => {
  const { status, json } = await api("GET", "/api/analytics/overview", tok.raZero());
  assert.equal(status, 200);
  assert.equal(json.totalJobs, 0);
  assert.equal(json.totalCandidates, 0);
  assert.equal(json.totalApplications, 0);
});

test("analytics overview: partial recruiter_admin counts ONLY assigned clients", async () => {
  const { status, json } = await api("GET", "/api/analytics/overview", tok.raPartial());
  assert.equal(status, 200);
  // clientA + clientB only (clientC is unassigned and must be excluded).
  assert.equal(json.totalJobs, 2, "jobA + jobB only");
  assert.equal(json.totalCandidates, 2, "candA + candB only");
  assert.equal(json.totalApplications, 2, "appA + appB only");
});

test("analytics overview: tenant_admin counts the unassigned client too (block is role-specific)", async () => {
  const { status, json } = await api("GET", "/api/analytics/overview", tok.tAdmin());
  assert.equal(status, 200);
  assert.equal(json.totalJobs, 3, "tenant_admin sees all three clients' jobs");
  assert.equal(json.totalCandidates, 3, "tenant_admin sees all three clients' candidates");
  assert.equal(json.totalApplications, 3, "tenant_admin sees all three clients' applications");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * ANALYTICS — GET /analytics/dashboard  (recommended actions feed)
 * Scoped via getDataScopeTenantIds. The "new-apps" recommended action counts
 * applications in the `applied` stage — one per client (appA/appB/appC) — so its
 * label text is a clean per-client scope signal.
 * ──────────────────────────────────────────────────────────────────────────── */
const newAppsLabel = (json: any): string | null =>
  (json?.recommendedActions ?? []).find((a: any) => a.id === "new-apps")?.label ?? null;

test("analytics dashboard: zero-assignment recruiter_admin sees no recommended actions", async () => {
  const { status, json } = await api("GET", "/api/analytics/dashboard", tok.raZero());
  assert.equal(status, 200);
  assert.deepEqual(json.recommendedActions, [], "zero-assignment sees no actions at all");
});

test("analytics dashboard: partial recruiter_admin counts ONLY assigned clients' applications", async () => {
  const { status, json } = await api("GET", "/api/analytics/dashboard", tok.raPartial());
  assert.equal(status, 200);
  // appA + appB only (appC belongs to unassigned clientC and must be excluded).
  assert.equal(newAppsLabel(json), "2 New Applications Awaiting Review");
});

test("analytics dashboard: tenant_admin counts the unassigned client too (block is role-specific)", async () => {
  const { status, json } = await api("GET", "/api/analytics/dashboard", tok.tAdmin());
  assert.equal(status, 200);
  assert.equal(newAppsLabel(json), "3 New Applications Awaiting Review");
});

/* ─────────────────────────────────────────────────────────────────────────────
 * ANALYTICS — GET /analytics/engagement  (re-engagement / outreach metrics)
 * Scoped via getDataScopeTenantIds. The outreachSummary aggregates outreach
 * campaigns — one per client (campA/campB/campC, distinct sentCounts) — so its
 * campaign count and totalSent are clean per-client scope signals.
 * ──────────────────────────────────────────────────────────────────────────── */
test("analytics engagement: zero-assignment recruiter_admin sees an empty outreach summary", async () => {
  const { status, json } = await api("GET", "/api/analytics/engagement", tok.raZero());
  assert.equal(status, 200);
  assert.equal(json.outreachSummary.campaigns, 0, "zero-assignment counts no campaigns");
  assert.equal(json.outreachSummary.totalSent, 0, "zero-assignment sums no sent");
});

test("analytics engagement: partial recruiter_admin aggregates ONLY assigned clients", async () => {
  const { status, json } = await api("GET", "/api/analytics/engagement", tok.raPartial());
  assert.equal(status, 200);
  // campA + campB only (campC belongs to unassigned clientC and must be excluded).
  assert.equal(json.outreachSummary.campaigns, 2, "campA + campB only");
  assert.equal(json.outreachSummary.totalSent, 30, "sent 10 + 20 (clientC's 40 excluded)");
});

test("analytics engagement: tenant_admin aggregates the unassigned client too (block is role-specific)", async () => {
  const { status, json } = await api("GET", "/api/analytics/engagement", tok.tAdmin());
  assert.equal(status, 200);
  assert.equal(json.outreachSummary.campaigns, 3, "tenant_admin sees all three campaigns");
  assert.equal(json.outreachSummary.totalSent, 70, "tenant_admin sums 10 + 20 + 40");
});
