/**
 * internal-search-firewall-seal.test.ts — PROOF THAT THE INTERNAL-TALENT
 * FIREWALL IS A REAL RULE, NOT THE OLD TENANT-ID COINCIDENCE.
 *
 * Thesis A (pure firewall): an employer's internal-talent search must read ONLY
 * that company's own tenant-owned records (pool='tenant': current employees +
 * previously-saved/applied candidates) and must NEVER surface a personal
 * platform-pool job-seeker profile (pool='platform'/'pending_profile').
 *
 * The firewall USED to filter candidatesTable by tenantId ALONE. That was only
 * INCIDENTALLY safe: it relied on every platform profile carrying a sentinel
 * tenantId ("platform" via import, or the super-admin tenant via self-register)
 * that never collides with a real customer tenant. The fix adds an explicit
 * eq(candidatesTable.pool, "tenant") predicate so a platform profile can never
 * surface regardless of any tenant-id coincidence.
 *
 * This test constructs exactly the worst case the old accidental firewall would
 * have leaked: a personal platform profile whose tenantId DELIBERATELY COLLIDES
 * with the querying company's tenant id. If the pool='tenant' predicate is ever
 * dropped, that profile leaks into the employer's internal search and this test
 * fails loudly.
 *
 * Harness mirrors cross-tenant-pipeline-intel-seal.test.ts: outside
 * withTenantContext the `db` proxy falls through to dbAdmin (no RLS), so this
 * isolates the app-layer seal. The route reads the caller via the Bearer token
 * (getAuthUserId) so no resolveUser middleware is needed. The job carries NO ICP
 * and NO location, so the handler runs the deterministic title/skill fallback
 * and makes no external AI calls.
 *
 * Each assertion checks BOTH sides: the company's own tenant-owned candidate IS
 * returned (guards against an all-empty false-pass) AND the colliding platform
 * profile is absent.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { and, eq, inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  jobPipelinesTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { isFeeEligible } from "../lib/fee-ledger";
import sourcingRouter from "./sourcing";

const P = "isfs_";
const id = (s: string) => P + s;

// The company doing the internal search.
const COMPANY = id("company");
const TENANT_IDS = [COMPANY];
const JOB_ID = id("job");

let server: Server;
let baseUrl: string;

const admin = () => issueToken({ userId: id("admin"), role: "tenant_admin", tenantId: COMPANY });

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(applicationsTable).where(inArray(applicationsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobPipelinesTable).where(inArray(jobPipelinesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: COMPANY, name: "Acme Corp", slug: COMPANY, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("admin"), tenantId: COMPANY, email: id("admin") + "@t.test", name: "Acme Admin", passwordHash: "x", role: "tenant_admin", status: "active" },
  ]);
  // Approved job, NO ICP, NO location → deterministic title/skill fallback, no AI.
  await dbAdmin.insert(jobsTable).values([
    { id: JOB_ID, tenantId: COMPANY, title: "Senior Backend Engineer", description: "d", status: "active" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    // (1) POSITIVE CONTROL — a legitimately tenant-owned candidate (saved/employee).
    //     MUST appear in the company's internal search.
    {
      id: id("owned"), tenantId: COMPANY, pool: "tenant", source: "career_site",
      firstName: "Owned", lastName: "Talent", email: id("owned") + "@t.test",
      currentTitle: "Senior Backend Engineer", skills: ["node", "postgres"],
    },
    // (2) THE WORST CASE — a personal platform job-seeker profile whose tenantId
    //     COLLIDES with the querying company's tenant id. The old tenantId-only
    //     firewall would have leaked this. It MUST NOT appear.
    {
      id: id("platformCollide"), tenantId: COMPANY, pool: "platform", source: "career_site",
      firstName: "Personal", lastName: "JobSeeker", email: id("platformCollide") + "@t.test",
      currentTitle: "Senior Backend Engineer", skills: ["node", "postgres"],
    },
    // (3) A transitional self-register profile (pending_profile) that also
    //     happens to carry the company tenant id — also must never surface.
    {
      id: id("pendingCollide"), tenantId: COMPANY, pool: "pending_profile", source: "career_site",
      firstName: "Pending", lastName: "JobSeeker", email: id("pendingCollide") + "@t.test",
      currentTitle: "Senior Backend Engineer", skills: ["node", "postgres"],
    },
    {
      id: id("currentEmployee"), tenantId: COMPANY, pool: "tenant", source: "hris_sync",
      isCurrentEmployee: true, firstName: "Current", lastName: "Employee",
      email: id("currentEmployee") + "@t.test", currentTitle: "Senior Backend Engineer",
      skills: ["node", "postgres"],
    },
    {
      id: id("dncEmployee"), tenantId: COMPANY, pool: "tenant", source: "hris_sync",
      isCurrentEmployee: true, doNotContact: true, firstName: "DNC", lastName: "Employee",
      email: id("dncEmployee") + "@t.test", currentTitle: "Senior Backend Engineer",
      skills: ["node", "postgres"],
    },
    {
      id: id("erasedEmployee"), tenantId: COMPANY, pool: "tenant", source: "hris_sync",
      isCurrentEmployee: true, dataErasedAt: new Date(), firstName: "Erased", lastName: "Employee",
      email: id("erasedEmployee") + "@t.test", currentTitle: "Senior Backend Engineer",
      skills: ["node", "postgres"],
    },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(sourcingRouter);
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

test("internal search returns the company's OWN tenant-owned candidate (no all-empty false-pass)", async () => {
  const { status, json } = await api("POST", "/sourcing/internal", admin(), { jobId: id("job") });
  assert.equal(status, 200, JSON.stringify(json));
  const candidateIds = new Set<string>((json.candidates ?? []).map((c: any) => c.candidateId));
  assert.ok(candidateIds.has(id("owned")), "the company's own tenant-owned candidate MUST appear in internal search");
});

test("FIREWALL: a personal platform profile whose tenantId COLLIDES with the company NEVER leaks", async () => {
  const { status, json } = await api("POST", "/sourcing/internal", admin(), { jobId: id("job") });
  assert.equal(status, 200, JSON.stringify(json));
  const candidateIds = new Set<string>((json.candidates ?? []).map((c: any) => c.candidateId));
  assert.ok(
    !candidateIds.has(id("platformCollide")),
    "LEAK: a pool='platform' personal profile with a colliding tenantId surfaced in the employer's internal search",
  );
  assert.ok(
    !candidateIds.has(id("pendingCollide")),
    "LEAK: a pool='pending_profile' self-register profile with a colliding tenantId surfaced in the employer's internal search",
  );
});

test("unchecked jobs rediscover known non-employees but never current employees", async () => {
  const { status, json } = await api("POST", "/sourcing/internal", admin(), { jobId: JOB_ID });
  assert.equal(status, 200, JSON.stringify(json));
  const candidateIds = new Set<string>((json.candidates ?? []).map((c: any) => c.candidateId));
  assert.ok(candidateIds.has(id("owned")), "known tenant candidate remains discoverable");
  assert.ok(!candidateIds.has(id("currentEmployee")), "current employee is not in known-talent mode");
  assert.ok(!candidateIds.has(id("dncEmployee")), "DNC employee is excluded");
  assert.ok(!candidateIds.has(id("erasedEmployee")), "erased employee is excluded");
});

test("stored Internal Mobility setting wins over a client flag and returns only safe same-tenant employees", async () => {
  await dbAdmin
    .update(jobsTable)
    .set({ internalMobility: true } as any)
    .where(eq(jobsTable.id, JOB_ID));
  const { status, json } = await api("POST", "/sourcing/internal", admin(), {
    jobId: JOB_ID,
    internalMobility: false,
  });
  assert.equal(status, 200, JSON.stringify(json));
  const candidateIds = new Set<string>((json.candidates ?? []).map((c: any) => c.candidateId));
  assert.deepEqual([...candidateIds], [id("currentEmployee")]);
  assert.equal(json.internalMobility, true);
  assert.equal(json.sourceSummary?.externalEnabled, false);
});

test("/sourcing/search links Internal Mobility selections to this job", async () => {
  await dbAdmin
    .update(jobsTable)
    .set({ internalMobility: true } as any)
    .where(eq(jobsTable.id, JOB_ID));
  const { status, json } = await api("POST", "/sourcing/search", admin(), {
    jobId: JOB_ID,
    internalMobility: false,
  });
  assert.equal(status, 200, JSON.stringify(json));
  assert.equal(json.internalMobility, true);
  assert.ok(
    (json.candidates ?? []).some((candidate: any) => candidate.candidateId === id("currentEmployee")),
    JSON.stringify(json),
  );
  const secondRun = await api("POST", "/sourcing/search", admin(), {
    jobId: JOB_ID,
    internalMobility: false,
  });
  assert.equal(secondRun.status, 200, JSON.stringify(secondRun.json));
  const linkedApplications = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.jobId, JOB_ID),
        eq(applicationsTable.candidateId, id("currentEmployee")),
      ),
    );
  assert.equal(linkedApplications.length, 1, "repeat sourcing is idempotent for this exact job/candidate");
  const [application] = linkedApplications;
  assert.ok(application, "the employee selection has an application link");
  assert.equal(application.jobId, JOB_ID);
  assert.equal(application.stage, "sourced");
  assert.equal((application.originEvidence as any)?.channel, "internal_mobility");
});

test("/sourcing/search keeps capped Known Talent rediscovery out of fee attribution", async () => {
  await dbAdmin
    .update(jobsTable)
    .set({ internalMobility: false } as any)
    .where(eq(jobsTable.id, JOB_ID));
  const { status, json } = await api("POST", "/sourcing/search", admin(), {
    jobId: JOB_ID,
    maxPerSource: 1,
    sources: [],
  });
  assert.equal(status, 200, JSON.stringify(json));
  const [application] = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.candidateId, id("owned")));
  assert.ok(application, "the one returned known-talent candidate is linked");
  assert.equal(application.jobId, JOB_ID);
  assert.equal((application.originEvidence as any)?.channel, "known_talent_rediscovery");
  assert.equal(application.entryType, "sourced");
  assert.equal(isFeeEligible(application.entryType, application.originEvidence), false);
});
