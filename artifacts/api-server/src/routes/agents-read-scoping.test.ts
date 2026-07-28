/**
 * agents-read-scoping.test.ts — Auth + tenant scoping for the agent READ routes
 *
 * Covers the security fix for the agent dashboard reads:
 *   GET /agents        (statuses + recentRuns + events)
 *   GET /agents/runs   (recent run history)
 *
 * Both endpoints read the orchestrator's IN-MEMORY run/event history — data RLS
 * can never scope (it never touches the `db` connection), so authorization and
 * tenant scoping are enforced in the route (resolveAgentViewer) + the accessor
 * filters (getRecentRuns/getEvents/getAgentStatuses with an `allowed` set).
 *
 * ─── How this test works ─────────────────────────────────────────────────────
 * The agents router is mounted on a bare Express app (no withTenantContext — the
 * scoping under test is app-layer, mirroring recruiter-admin-permissions.test).
 * Users/tenants are seeded via dbAdmin; the in-memory AgentRun/AgentEvent records
 * are seeded by pushing straight onto the orchestrator singleton's arrays (cast
 * to any) so we exercise the visibility filter deterministically, WITHOUT firing
 * real agents (which would make external API calls).
 *
 * ─── Fixture (all ids prefixed `arst_`) ──────────────────────────────────────
 *   tenantA / tenantB  — two unrelated top-level tenants
 *   taA   — tenant_admin in tenantA (recruiter-class → allowed to read)
 *   candA — candidate in tenantA   (excluded role → 403)
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray } from "drizzle-orm";
import { dbAdmin, tenantsTable, usersTable } from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import { orchestrator } from "../lib/agents/orchestrator";
import agentsRouter from "./agents";

const P = "arst_";
const id = (s: string) => P + s;

const TENANT_IDS = ["tenantA", "tenantB"].map(id);
const USER_IDS = ["taA", "candA", "pAdmin"].map(id);

// Marker so we can find (and clean up) only the runs/events this test injects.
const RUN_ID_A = id("run_tenantA");
const RUN_ID_B = id("run_tenantB");
const EVT_ID_A = id("evt_tenantA");
const EVT_ID_B = id("evt_tenantB");

let server: Server;
let baseUrl: string;

const tok = {
  taA: () => issueToken({ userId: id("taA"), role: "tenant_admin", tenantId: id("tenantA") }),
  candA: () => issueToken({ userId: id("candA"), role: "candidate", tenantId: id("tenantA") }),
  pAdmin: () => issueToken({ userId: id("pAdmin"), role: "platform_admin", tenantId: id("tenantA") }),
};

async function api(
  method: string,
  path: string,
  token?: string,
): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: token ? { Authorization: `Bearer ${token}` } : {},
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

function seedOrchestratorRuns() {
  const now = new Date().toISOString();
  const runs: any[] = (orchestrator as any).runs;
  const events: any[] = (orchestrator as any).events;
  runs.push(
    {
      id: RUN_ID_A, agentId: "sourcing", triggeredBy: "user",
      tenantId: id("tenantA"), jobId: id("jobA"), triggeredByUserId: id("taA"),
      input: { jobId: id("jobA") }, output: { candidatesFound: 3 },
      status: "completed", startedAt: now, completedAt: now, durationMs: 100,
    },
    {
      id: RUN_ID_B, agentId: "screening", triggeredBy: "user",
      tenantId: id("tenantB"), jobId: id("jobB"), triggeredByUserId: id("taB"),
      input: { jobId: id("jobB") }, output: { score: 80 },
      status: "completed", startedAt: now, completedAt: now, durationMs: 100,
    },
  );
  events.push(
    { id: EVT_ID_A, type: "sourcing_completed", agentId: "sourcing", tenantId: id("tenantA"), payload: { runId: RUN_ID_A }, timestamp: now, processed: false },
    { id: EVT_ID_B, type: "screening_completed", agentId: "screening", tenantId: id("tenantB"), payload: { runId: RUN_ID_B }, timestamp: now, processed: false },
  );
}

function cleanupOrchestrator() {
  const runsArr: any[] = (orchestrator as any).runs;
  const evtsArr: any[] = (orchestrator as any).events;
  const keepRuns = runsArr.filter(r => r.id !== RUN_ID_A && r.id !== RUN_ID_B);
  const keepEvts = evtsArr.filter(e => e.id !== EVT_ID_A && e.id !== EVT_ID_B);
  runsArr.length = 0; runsArr.push(...keepRuns);
  evtsArr.length = 0; evtsArr.push(...keepEvts);
}

async function cleanupDb() {
  await dbAdmin.delete(usersTable).where(inArray(usersTable.id, USER_IDS));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, TENANT_IDS));
}

before(async () => {
  await cleanupDb();
  await dbAdmin.insert(tenantsTable).values([
    { id: id("tenantA"), name: "ARST Tenant A", slug: id("tenantA"), plan: "enterprise" },
    { id: id("tenantB"), name: "ARST Tenant B", slug: id("tenantB"), plan: "enterprise" },
  ]);
  await dbAdmin.insert(usersTable).values([
    { id: id("taA"), tenantId: id("tenantA"), email: id("taA") + "@t.test", name: "TA A", passwordHash: "x", role: "tenant_admin" },
    { id: id("candA"), tenantId: id("tenantA"), email: id("candA") + "@t.test", name: "Cand A", passwordHash: "x", role: "candidate" },
    { id: id("pAdmin"), tenantId: id("tenantA"), email: id("pAdmin") + "@t.test", name: "P Admin", passwordHash: "x", role: "platform_admin" },
  ]);
  seedOrchestratorRuns();

  const app = express();
  app.use(express.json());
  app.use(agentsRouter);
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
  cleanupOrchestrator();
  await cleanupDb();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/* ── No token → 401 ──────────────────────────────────────────────────────── */
test("GET /agents/runs without a token → 401", async () => {
  const { status } = await api("GET", "/agents/runs");
  assert.equal(status, 401);
});

test("GET /agents without a token → 401", async () => {
  const { status } = await api("GET", "/agents");
  assert.equal(status, 401);
});

/* ── Candidate role → 403 (no business reading agent operations) ──────────── */
test("GET /agents/runs as a candidate → 403", async () => {
  const { status } = await api("GET", "/agents/runs", tok.candA());
  assert.equal(status, 403);
});

test("GET /agents as a candidate → 403", async () => {
  const { status } = await api("GET", "/agents", tok.candA());
  assert.equal(status, 403);
});

/* ── Tenant A sees its own runs, zero tenant B runs ──────────────────────── */
test("GET /agents/runs: tenant A sees its own run and ZERO tenant B runs", async () => {
  const { status, json } = await api("GET", "/agents/runs", tok.taA());
  assert.equal(status, 200);
  assert.ok(Array.isArray(json));
  // Our seeded tenant-A run is present …
  assert.ok(json.some((r: any) => r.id === RUN_ID_A), "tenant A run should be visible");
  // … the tenant-B run is not, and NOTHING with tenantB leaks through.
  assert.ok(!json.some((r: any) => r.id === RUN_ID_B), "tenant B run must NOT be visible");
  assert.ok(
    json.every((r: any) => r.tenantId === id("tenantA")),
    "every visible run must belong to tenant A",
  );
});

test("GET /agents: recentRuns + events are scoped to tenant A only", async () => {
  const { status, json } = await api("GET", "/agents", tok.taA());
  assert.equal(status, 200);
  // recentRuns scoped
  assert.ok(json.recentRuns.some((r: any) => r.id === RUN_ID_A));
  assert.ok(!json.recentRuns.some((r: any) => r.id === RUN_ID_B));
  assert.ok(json.recentRuns.every((r: any) => r.tenantId === id("tenantA")));
  // events scoped
  assert.ok(json.events.some((e: any) => e.id === EVT_ID_A));
  assert.ok(!json.events.some((e: any) => e.id === EVT_ID_B));
  assert.ok(json.events.every((e: any) => e.tenantId === id("tenantA")));
  // statuses derive from visible runs: sourcing lastRun is tenant A's; screening
  // has no tenant-A run so its lastRun is null (tenant B's run must not surface).
  const statuses: any[] = json.agents;
  const sourcing = statuses.find(s => s.id === "sourcing");
  const screening = statuses.find(s => s.id === "screening");
  assert.equal(sourcing?.lastRun?.id, RUN_ID_A);
  assert.equal(screening?.lastRun ?? null, null);
});

/* ── Platform admin sees ALL tenants (allowed=null contract) ─────────────── */
test("GET /agents/runs: platform_admin sees runs from BOTH tenants", async () => {
  const { status, json } = await api("GET", "/agents/runs", tok.pAdmin());
  assert.equal(status, 200);
  assert.ok(Array.isArray(json));
  assert.ok(json.some((r: any) => r.id === RUN_ID_A), "platform admin should see tenant A run");
  assert.ok(json.some((r: any) => r.id === RUN_ID_B), "platform admin should see tenant B run");
});

test("GET /agents: platform_admin sees cross-tenant runs + events", async () => {
  const { status, json } = await api("GET", "/agents", tok.pAdmin());
  assert.equal(status, 200);
  assert.ok(json.recentRuns.some((r: any) => r.id === RUN_ID_A));
  assert.ok(json.recentRuns.some((r: any) => r.id === RUN_ID_B));
  assert.ok(json.events.some((e: any) => e.id === EVT_ID_A));
  assert.ok(json.events.some((e: any) => e.id === EVT_ID_B));
});
