/**
 * pipeline-run-triggered-by.test.ts — the canvas / workflow-board pipeline
 * trigger (POST /jobs/:jobId/pipeline/run) must stamp a durable forensic "who"
 * on the pipeline_runs row: triggeredByUserId = the authenticated caller's id.
 * The coarse `triggeredBy` label ("user"/"canvas"/…) is NOT a user id, so
 * without this stamp there's no way to attribute a canvas-triggered run.
 *
 * Hermeticity: the run route inserts the row synchronously (awaited) BEFORE the
 * fire-and-forget setImmediate that runs the orchestrator, so we read the row
 * right after the 202. The seeded pipeline enables only an UNKNOWN agent id, so
 * the background orchestrator dispatch (a switch with no default) no-ops without
 * any AI / sourcing network calls.
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  jobPipelinesTable,
  pipelineRunsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import pipelineRouter from "./pipeline";

const P = "gltrig_";
const id = (s: string) => P + s;
const T = id("t");
const JOB = id("job");
const ADMIN = id("admin");

let server: Server;
let baseUrl: string;

const tok = () => issueToken({ userId: ADMIN, role: "tenant_admin", tenantId: T });

async function api(method: string, path: string, token: string, body?: unknown) {
  const res = await fetch(baseUrl + path, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(pipelineRunsTable).where(eq(pipelineRunsTable.tenantId, T));
  await dbAdmin.delete(jobPipelinesTable).where(eq(jobPipelinesTable.tenantId, T));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, T));
  await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, T));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, T));
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({ id: T, name: "GL Trig Tenant", slug: T, plan: "enterprise" });
  await dbAdmin.insert(usersTable).values({
    id: ADMIN, tenantId: T, email: ADMIN + "@t.test", name: "Admin", passwordHash: "x", role: "tenant_admin", status: "active",
  });
  await dbAdmin.insert(jobsTable).values({ id: JOB, tenantId: T, title: "Engineer", description: "Build things", status: "active" });
  // Only an UNKNOWN agent is enabled → background orchestrator dispatch no-ops.
  await dbAdmin.insert(jobPipelinesTable).values({
    jobId: JOB, tenantId: T, autoRun: false, status: "idle",
    agents: [{ id: "unknown_test_agent", order: 1, enabled: true, label: "Noop", config: {} }],
  } as any);

  const app = express();
  app.use(express.json());
  app.use("/", pipelineRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${typeof addr === "object" && addr ? addr.port : 0}`;
      resolve();
    });
  });
});

after(async () => {
  await cleanup();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("canvas pipeline run stamps triggeredByUserId with the authenticated caller", async () => {
  const r = await api("POST", `/jobs/${JOB}/pipeline/run`, tok(), { triggeredBy: "canvas" });
  assert.equal(r.status, 202, "run accepted");
  assert.ok(r.json.runId, "returns a runId");

  const [row] = await dbAdmin.select().from(pipelineRunsTable).where(eq(pipelineRunsTable.id, r.json.runId)).limit(1);
  assert.ok(row, "run row persisted");
  assert.equal(row.triggeredBy, "canvas", "coarse label preserved");
  assert.equal(row.triggeredByUserId, ADMIN, "durable forensic who = the caller");
});

test("an unauthenticated run is rejected (no anonymous canvas trigger)", async () => {
  const res = await fetch(baseUrl + `/jobs/${JOB}/pipeline/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ triggeredBy: "canvas" }),
  });
  assert.equal(res.status, 401);
});
