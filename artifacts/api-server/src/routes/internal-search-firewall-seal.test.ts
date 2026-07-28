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
import { inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  jobPipelinesTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import sourcingRouter from "./sourcing";

const P = "isfs_";
const id = (s: string) => P + s;

// The company doing the internal search.
const COMPANY = id("company");
const TENANT_IDS = [COMPANY];

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
    { id: id("job"), tenantId: COMPANY, title: "Senior Backend Engineer", description: "d", status: "active" },
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
