/**
 * agent-write-role-gate.test.ts — Interim role gate on the agent/sourcing WRITE routes
 *
 * Covers the interim (pre-Tier-2) authorization on three write endpoints:
 *   POST /agents/:agentId/run
 *   POST /agents/run-selection
 *   POST /sourcing/merge
 *
 * These require a recruiter-class caller (recruiter / recruiter_admin /
 * tenant_admin / platform_admin). A candidate-role token must be rejected with
 * 403.
 *
 * NOTE: Tier-2 recruiter-OWNERSHIP has since landed on POST /sourcing/merge —
 * a plain recruiter must OWN (be assigned to a req linked to) the primary AND
 * every duplicate candidate, else 404. Admin-class callers bypass that ceiling.
 * The owner-2xx / peer-404 / admin-2xx ownership matrix for merge is proven in
 * recruiter-ownership-sweep.test.ts; this file keeps the role-gate + the
 * data-integrity checks below, and exercises the admin (ceiling-bypass) write.
 *
 * /sourcing/merge additionally validates that primaryCandidateId exists and is
 * inside the caller's subtree before writing merge pointers (the arbitrary-id
 * data-integrity hole).
 *
 * Harness: both routers are mounted on a bare Express app (no withTenantContext
 * — the gates under test are app-layer). Seed via dbAdmin; ids prefixed `awrg_`.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";
import { dbAdmin, tenantsTable, usersTable, candidatesTable, jobsTable } from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import agentsRouter from "./agents";
import sourcingRouter from "./sourcing";

const P = "awrg_";
const id = (s: string) => P + s;

const TENANT_IDS = ["tenantA", "tenantB"].map(id);
const USER_IDS = ["recA", "candA", "tadminA"].map(id);
const CAND_IDS = ["primaryA", "primaryB"].map(id);
const JOB_IDS = ["jobA"].map(id);

let server: Server;
let baseUrl: string;

const tok = {
  recA: () => issueToken({ userId: id("recA"), role: "recruiter", tenantId: id("tenantA") }),
  candA: () => issueToken({ userId: id("candA"), role: "candidate", tenantId: id("tenantA") }),
  tadminA: () => issueToken({ userId: id("tadminA"), role: "tenant_admin", tenantId: id("tenantA") }),
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

async function cleanupDb() {
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, CAND_IDS));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, JOB_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

before(async () => {
  await cleanupDb();
  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenantA"), name: "AWRG Tenant A", slug: id("tenantA"), plan: "enterprise" },
    { id: id("tenantB"), name: "AWRG Tenant B", slug: id("tenantB"), plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("recA"), tenantId: id("tenantA"), email: id("recA") + "@t.test", name: "Rec A", passwordHash: "x", role: "recruiter" },
    { id: id("candA"), tenantId: id("tenantA"), email: id("candA") + "@t.test", name: "Cand A", passwordHash: "x", role: "candidate" },
    { id: id("tadminA"), tenantId: id("tenantA"), email: id("tadminA") + "@t.test", name: "Admin A", passwordHash: "x", role: "tenant_admin" },
  ]);
  await dbAdmin.insert(candidatesTable).values([
    { id: id("primaryA"), tenantId: id("tenantA"), firstName: "Primary", lastName: "A", email: id("primaryA") + "@t.test", pool: "tenant" },
    { id: id("primaryB"), tenantId: id("tenantB"), firstName: "Primary", lastName: "B", email: id("primaryB") + "@t.test", pool: "tenant" },
  ]);
  await dbAdmin.insert(jobsTable).values([
    { id: id("jobA"), tenantId: id("tenantA"), title: "Job A", description: "desc", status: "active" },
  ]);

  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
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
  await cleanupDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ── candidate-role token → 403 on all three write routes ────────────────── */
test("POST /agents/:agentId/run as a candidate → 403", async () => {
  const { status } = await api("POST", "/agents/sourcing/run", { jobId: id("jobA") }, tok.candA());
  assert.equal(status, 403);
});

test("POST /agents/run-selection as a candidate → 403", async () => {
  const { status } = await api("POST", "/agents/run-selection", { agentIds: ["sourcing"], jobId: id("jobA") }, tok.candA());
  assert.equal(status, 403);
});

test("POST /sourcing/merge as a candidate → 403", async () => {
  const { status } = await api("POST", "/sourcing/merge", { primaryCandidateId: id("primaryA"), duplicateCandidateIds: [id("dupX")] }, tok.candA());
  assert.equal(status, 403);
});

/* ── no token → 401 (auth precondition of the gate) ──────────────────────── */
test("POST /sourcing/merge without a token → 401", async () => {
  const { status } = await api("POST", "/sourcing/merge", { primaryCandidateId: id("primaryA"), duplicateCandidateIds: [id("dupX")] });
  assert.equal(status, 401);
});

/* ── /sourcing/merge data-integrity: unknown primaryCandidateId → 404 ────── */
test("POST /sourcing/merge with a non-existent primary candidate → 404", async () => {
  const { status } = await api(
    "POST",
    "/sourcing/merge",
    { primaryCandidateId: id("ghost"), duplicateCandidateIds: [id("dupX")] },
    tok.recA(),
  );
  assert.equal(status, 404);
});

/* ── /sourcing/merge data-integrity: primary in ANOTHER tenant → 404 ─────────
 * 404 (not 403): out-of-scope is indistinguishable from non-existent, so a
 * caller can't probe cross-tenant candidate existence. */
test("POST /sourcing/merge with an out-of-subtree primary candidate → 404", async () => {
  const { status } = await api(
    "POST",
    "/sourcing/merge",
    { primaryCandidateId: id("primaryB"), duplicateCandidateIds: [id("dupX")] },
    tok.recA(),
  );
  assert.equal(status, 404);
});

/* ── admin caller clears the gate + ceiling with an in-scope primary → 200 ─── */
test("POST /sourcing/merge as tenant_admin with in-scope primary → 200 (bypasses the Tier-2 ceiling)", async () => {
  const { status, json } = await api(
    "POST",
    "/sourcing/merge",
    { primaryCandidateId: id("primaryA"), duplicateCandidateIds: [id("dupX")] },
    tok.tadminA(),
  );
  assert.equal(status, 200);
  assert.equal(json.success, true);
});

/* ── plain recruiter, NOT assigned to the primary's req → Tier-2 ceiling 404 ─ */
test("POST /sourcing/merge as unassigned recruiter with in-scope primary → 404 (ceiling)", async () => {
  const { status } = await api(
    "POST",
    "/sourcing/merge",
    { primaryCandidateId: id("primaryA"), duplicateCandidateIds: [id("dupX")] },
    tok.recA(),
  );
  assert.equal(status, 404);
});
