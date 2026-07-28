/**
 * agent-parse-tenant-gate.test.ts — Tenant-membership gate on the patched
 * agent/CV write routes.
 *
 * Covers the Step-2 hardening that copied gateJobAccess (routes/pipeline.ts)
 * onto every caller-supplied resource id on these WRITE routes:
 *   POST /agents/:agentId/run       — jobId + optional candidateId
 *   POST /agents/run-selection      — jobId + optional candidateId
 *   POST /candidates/parse-cvs      — optional jobId
 *
 * For EACH route, three cases:
 *   (1) no auth               → 401 (auth precondition, before any tenant work)
 *   (2) valid auth, resource in ANOTHER tenant → 404 (missing == out-of-scope,
 *       so an id from a foreign tenant is indistinguishable from a bad id)
 *   (3) valid auth, OWN-tenant resource the caller LEGITIMATELY owns → succeeds
 *       (202 for the agent runs, 200 import for parse-cvs) — proving the gate
 *       adds no regression for legitimate callers. Under the recruiter
 *       ownership ceiling a recruiter is a legitimate caller only when the req
 *       is ASSIGNED to them (jobs.assigned_recruiter_id), so the fixture assigns
 *       jobA to recA; own-tenant-but-unassigned recruiters are correctly 404'd
 *       by the Tier-2 recruiterOwnsResource(jobId) gate in these handlers.
 *
 * GET /agents/runs cross-tenant isolation ("zero cross-tenant runs" with two
 * tenants seeded) is already proven by agents-read-scoping.test.ts; this file
 * focuses on the write routes whose gates were added in this pass.
 *
 * Harness: routers on a bare Express app (no withTenantContext — the gates
 * under test are app-layer, mirroring agent-write-role-gate.test.ts). Seed via
 * dbAdmin; ids prefixed `aptg_`. orchestrator.runPipeline is stubbed to a
 * no-op so the 202 success paths don't fire real (external-calling) agents.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray, eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  jobsTable,
  pipelineRunsTable,
  sourcedCandidatesTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { orchestrator } from "../lib/agents/orchestrator";
import agentsRouter from "./agents";
import candidatesRouter from "./candidates";

const P = "aptg_";
const id = (s: string) => P + s;

const TENANT_IDS = ["tenantA", "tenantB"].map(id);
const USER_IDS = ["recA"].map(id);
const CAND_IDS = ["candA", "candB"].map(id);
const JOB_IDS = ["jobA", "jobB"].map(id);

let server: Server;
let baseUrl: string;
let realRunPipeline: typeof orchestrator.runPipeline;

const tok = {
  recA: () => issueToken({ userId: id("recA"), role: "recruiter", tenantId: id("tenantA") }),
};

async function api(
  method: string,
  path: string,
  body: any,
  token?: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

// Multipart helper for parse-cvs. Fields + optional CSV file.
async function apiForm(
  path: string,
  fields: Record<string, string>,
  file: { name: string; type: string; content: string } | null,
  token?: string,
): Promise<{ status: number; json: any }> {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  if (file) form.append("files", new Blob([file.content], { type: file.type }), file.name);
  const res = await fetch(baseUrl + path, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanupDb() {
  // Runs created by the success paths (keyed on our seeded jobs) + CSV imports.
  await dbAdmin.delete(pipelineRunsTable).where(inArray(pipelineRunsTable.jobId, JOB_IDS));
  await dbAdmin.delete(sourcedCandidatesTable).where(inArray(sourcedCandidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, TENANT_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, JOB_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

before(async () => {
  await cleanupDb();
  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenantA"), name: "APTG Tenant A", slug: id("tenantA"), plan: "enterprise" },
    { id: id("tenantB"), name: "APTG Tenant B", slug: id("tenantB"), plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("recA"), tenantId: id("tenantA"), email: id("recA") + "@t.test", name: "Rec A", passwordHash: "x", role: "recruiter" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    { id: id("candA"), tenantId: id("tenantA"), firstName: "Cand", lastName: "A", email: id("candA") + "@t.test", pool: "tenant" },
    { id: id("candB"), tenantId: id("tenantB"), firstName: "Cand", lastName: "B", email: id("candB") + "@t.test", pool: "tenant" },
  ]);
  await dbAdmin.insert(jobsTable).values([
    // jobA is ASSIGNED to recA so the recruiter is a legitimate owner under the
    // ownership ceiling — the Tier-2 recruiterOwnsResource(jobId) gate on these
    // write routes requires assignment, not merely same-tenant membership.
    { id: id("jobA"), tenantId: id("tenantA"), title: "Job A", description: "desc", status: "active", assignedRecruiterId: id("recA") },
    { id: id("jobB"), tenantId: id("tenantB"), title: "Job B", description: "desc", status: "active" },
  ]);

  // Stub the pipeline executor so the 202 success paths don't fire real agents
  // (which make external API calls). We only assert the route reaches 202.
  realRunPipeline = orchestrator.runPipeline.bind(orchestrator);
  (orchestrator as any).runPipeline = async () => {};

  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
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
  (orchestrator as any).runPipeline = realRunPipeline;
  await cleanupDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ══ POST /agents/:agentId/run ═══════════════════════════════════════════════ */

test("POST /agents/:agentId/run without a token → 401", async () => {
  const { status } = await api("POST", "/agents/sourcing/run", { jobId: id("jobA") });
  assert.equal(status, 401);
});

test("POST /agents/:agentId/run with a job from ANOTHER tenant → 404", async () => {
  const { status } = await api("POST", "/agents/sourcing/run", { jobId: id("jobB") }, tok.recA());
  assert.equal(status, 404);
});

test("POST /agents/:agentId/run with a candidate from ANOTHER tenant → 404", async () => {
  const { status } = await api(
    "POST",
    "/agents/sourcing/run",
    { jobId: id("jobA"), candidateId: id("candB") },
    tok.recA(),
  );
  assert.equal(status, 404);
});

test("POST /agents/:agentId/run with own-tenant job → 202 (unchanged)", async () => {
  const { status, json } = await api("POST", "/agents/sourcing/run", { jobId: id("jobA") }, tok.recA());
  assert.equal(status, 202);
  assert.ok(json.runId, "should return a runId");
  assert.equal(json.jobId, id("jobA"));
});

/* ══ POST /agents/run-selection ══════════════════════════════════════════════ */

test("POST /agents/run-selection without a token → 401", async () => {
  const { status } = await api("POST", "/agents/run-selection", { agentIds: ["sourcing"], jobId: id("jobA") });
  assert.equal(status, 401);
});

test("POST /agents/run-selection with a job from ANOTHER tenant → 404", async () => {
  const { status } = await api(
    "POST",
    "/agents/run-selection",
    { agentIds: ["sourcing"], jobId: id("jobB") },
    tok.recA(),
  );
  assert.equal(status, 404);
});

test("POST /agents/run-selection with a candidate from ANOTHER tenant → 404", async () => {
  const { status } = await api(
    "POST",
    "/agents/run-selection",
    { agentIds: ["sourcing"], jobId: id("jobA"), candidateId: id("candB") },
    tok.recA(),
  );
  assert.equal(status, 404);
});

test("POST /agents/run-selection with own-tenant job → 202 (unchanged)", async () => {
  const { status, json } = await api(
    "POST",
    "/agents/run-selection",
    { agentIds: ["sourcing"], jobId: id("jobA") },
    tok.recA(),
  );
  assert.equal(status, 202);
  assert.ok(json.runId, "should return a runId");
});

/* ══ POST /candidates/parse-cvs ══════════════════════════════════════════════ */

test("POST /candidates/parse-cvs without a token → 401", async () => {
  const { status } = await apiForm("/candidates/parse-cvs", { jobId: id("jobA") }, null);
  assert.equal(status, 401);
});

test("POST /candidates/parse-cvs with a job from ANOTHER tenant → 404", async () => {
  const { status } = await apiForm("/candidates/parse-cvs", { jobId: id("jobB") }, null, tok.recA());
  assert.equal(status, 404);
});

test("POST /candidates/parse-cvs with own-tenant job + CSV → 200 import (unchanged)", async () => {
  const email = `aptg-csv-${Date.now()}@t.test`;
  const csv = `firstName,lastName,email\nCsv,Import,${email}\n`;
  const { status, json } = await apiForm(
    "/candidates/parse-cvs",
    { jobId: id("jobA") },
    { name: "roster.csv", type: "text/csv", content: csv },
    tok.recA(),
  );
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.results), "results array expected");
  const csvResult = json.results.find((r: any) => r.csv);
  assert.ok(csvResult, "CSV result entry expected");
  assert.equal(csvResult.imported, 1, "one candidate imported");

  // Prove the candidate landed under the JOB's tenant (tenantA), not elsewhere.
  const [row] = await dbAdmin
    .select({ tenantId: candidatesTable.tenantId })
    .from(candidatesTable)
    .where(eq(candidatesTable.email, email))
    .limit(1);
  assert.ok(row, "imported candidate row should exist");
  assert.equal(row.tenantId, id("tenantA"));
});
