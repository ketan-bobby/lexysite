/**
 * cross-tenant-pipeline-intel-seal.test.ts — TWO-TENANT PROOF FOR THE CONFIRMED
 * CROSS-TENANT LEAKS (audit rows: pipeline sourced-branch + intelligence by-candidate).
 *
 * Both surfaces gated the ENTRY point (the job / the candidate row) but then
 * returned child rows without an explicit tenant predicate — and both underlying
 * tables (sourced_candidates on the board, candidate_job_intelligence by-candidate)
 * are NOT RLS-enforced in this environment, so the app layer is the ONLY seal.
 *
 *   1. GET /jobs/:jobId/pipeline-stages — the sourced branch pulled the 50 most
 *      recent sourced_candidates across ALL tenants and, via the `!raw.jobId`
 *      unattributed clause, surfaced OTHER tenants' leads on this job's board.
 *      Fix: scope the sourced query to the job's tenant.
 *
 *   2. GET /intelligence/candidate/:candidateId — authorised the candidate ROW's
 *      tenant, then returned every intelligence row for that candidateId, incl.
 *      rows scored against OTHER tenants' jobs (cross-tenant / platform-pool
 *      scoring writes the JOB's tenant). Fix: scope rows to the caller's subtree.
 *
 * Harness identical to recruiter-admin-intel-analytics-scoping.test.ts: outside
 * withTenantContext the `db` proxy falls through to dbAdmin (no RLS), so this
 * isolates the app-layer seal. Two INDEPENDENT tenants (no parent link) make the
 * probe a true cross-tenant one. Each test asserts the OWN row is present (guards
 * against an all-empty false-pass) AND the foreign row is absent.
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
  sourcedCandidatesTable,
  candidateJobIntelligenceTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import pipelineRouter from "./pipeline";
import intelligenceRouter from "./intelligence";

const P = "xtpi_";
const id = (s: string) => P + s;

const T1 = id("t1");
const T2 = id("t2");
const TENANT_IDS = [T1, T2];

let server: Server;
let baseUrl: string;

const adminT1 = () => issueToken({ userId: id("adminT1"), role: "tenant_admin", tenantId: T1 });

async function api(method: string, path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, { method, headers: { Authorization: `Bearer ${token}` } });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(candidateJobIntelligenceTable).where(inArray(candidateJobIntelligenceTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(sourcedCandidatesTable).where(inArray(sourcedCandidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

async function seed() {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values([
    { id: T1, name: "Tenant One", slug: T1, plan: "enterprise" },
    { id: T2, name: "Tenant Two", slug: T2, plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("adminT1"), tenantId: T1, email: id("adminT1") + "@t.test", name: "Admin One", passwordHash: "x", role: "tenant_admin", status: "active" },
  ]);
  await dbAdmin.insert(jobsTable).values([
    { id: id("jobT1"), tenantId: T1, title: "Job T1", description: "d", status: "active" },
    { id: id("jobT2"), tenantId: T2, title: "Job T2", description: "d", status: "active" },
  ]);
  // A candidate that lives in T1 (so the by-candidate ownership gate passes for
  // adminT1) but carries an intelligence row scored against T2's job as well.
  await dbAdmin.insert(candidatesTable).values([
    { id: id("candShared"), tenantId: T1, firstName: "Shared", lastName: "Cand", email: id("candShared") + "@t.test", pool: "tenant", source: "career_site" },
  ]);
  await dbAdmin.insert(candidateJobIntelligenceTable).values([
    { id: id("intelOwn"),  tenantId: T1, jobId: id("jobT1"), candidateId: id("candShared"), hireProbability: 90 },
    { id: id("intelLeak"), tenantId: T2, jobId: id("jobT2"), candidateId: id("candShared"), hireProbability: 80 },
  ]);
  // Sourced leads: one legit T1 lead attributed to jobT1, plus two T2 leads that
  // the old query would have surfaced on T1's board (one unattributed, one whose
  // rawData.jobId even points at T1's job while the row itself lives in T2).
  await dbAdmin.insert(sourcedCandidatesTable).values([
    { id: id("srcOwn"),         tenantId: T1, source: "linkedin", createdAt: new Date(), rawData: { jobId: id("jobT1"), firstName: "Own", lastName: "Lead", email: id("srcOwn") + "@t.test" } },
    { id: id("srcLeakUnattr"),  tenantId: T2, source: "linkedin", createdAt: new Date(), rawData: { firstName: "Leak", lastName: "Unattr", email: id("srcLeakUnattr") + "@t.test" } },
    { id: id("srcLeakAttr"),    tenantId: T2, source: "linkedin", createdAt: new Date(), rawData: { jobId: id("jobT1"), firstName: "Leak", lastName: "Attr", email: id("srcLeakAttr") + "@t.test" } },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(pipelineRouter);                       // pipeline routes mount at root
  app.use("/intelligence", intelligenceRouter);  // intelligence router self-applies resolveUser
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

/* ── PIPELINE BOARD sourced branch ─────────────────────────────────────────── */
test("pipeline board: the job owner's own sourced lead appears (no all-empty false-pass)", async () => {
  const { status, json } = await api("GET", `/jobs/${id("jobT1")}/pipeline-stages`, adminT1());
  assert.equal(status, 200, JSON.stringify(json));
  const sourcedIds = new Set<string>(
    Object.values(json.stages ?? {}).flat().map((r: any) => r.sourcedId).filter(Boolean),
  );
  assert.ok(sourcedIds.has(id("srcOwn")), "the job's own T1 sourced lead MUST be on the board");
});

test("pipeline board: another tenant's sourced leads NEVER appear on this job's board", async () => {
  const { status, json } = await api("GET", `/jobs/${id("jobT1")}/pipeline-stages`, adminT1());
  assert.equal(status, 200, JSON.stringify(json));
  const sourcedIds = new Set<string>(
    Object.values(json.stages ?? {}).flat().map((r: any) => r.sourcedId).filter(Boolean),
  );
  assert.ok(!sourcedIds.has(id("srcLeakUnattr")), "LEAK: a foreign-tenant UNATTRIBUTED sourced lead appeared on the board");
  assert.ok(!sourcedIds.has(id("srcLeakAttr")), "LEAK: a foreign-tenant sourced lead (rawData.jobId spoofed to this job) appeared on the board");
});

/* ── INTELLIGENCE by-candidate ─────────────────────────────────────────────── */
test("intelligence by-candidate: the caller's own intelligence row is returned (no all-empty false-pass)", async () => {
  const { status, json } = await api("GET", `/intelligence/candidate/${id("candShared")}`, adminT1());
  assert.equal(status, 200, JSON.stringify(json));
  const ids = new Set<string>((json.data ?? []).map((r: any) => r.id));
  assert.ok(ids.has(id("intelOwn")), "the candidate's T1 intelligence row MUST be returned");
});

test("intelligence by-candidate: a foreign tenant's intelligence row for the same candidate NEVER leaks", async () => {
  const { status, json } = await api("GET", `/intelligence/candidate/${id("candShared")}`, adminT1());
  assert.equal(status, 200, JSON.stringify(json));
  const ids = new Set<string>((json.data ?? []).map((r: any) => r.id));
  assert.ok(!ids.has(id("intelLeak")), "LEAK: a T2 intelligence row (scored against another tenant's job) was returned to a T1 caller");
});
