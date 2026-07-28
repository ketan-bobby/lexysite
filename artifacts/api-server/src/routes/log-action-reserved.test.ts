/**
 * log-action-reserved.test.ts — API-level PROOF that POST /portal/log-action
 * rejects RESERVED system event types before insert.
 *
 * Incident class: candidate_action_events.eventType was caller-supplied, so a
 * candidate could forge eventType="recruiter_view" rows — spoofing their own
 * "who viewed you" counts and triggering view-burst emails — or fake
 * "role_open_at_target" market events. The handler now 400s reserved types
 * BEFORE the insert; the CI guard (scripts/check-viewer-privacy-read.mjs)
 * allowlists this route ONLY because of that check.
 *
 * This test locks the behavior at the API level so a refactor that loosens
 * the reserved-type check fails a test immediately, not just a static scan:
 *   1. eventType="recruiter_view"      → 400, and NO row is inserted.
 *   2. eventType="role_open_at_target" → 400, and NO row is inserted.
 *   3. CANARY: a benign self-event ("practice_session") → 200 AND the row
 *      exists — proving the endpoint still works (no all-reject false pass).
 *   4. Unauthenticated request → 401 (no anonymous event writes).
 */
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { Server } from "node:http";
import { inArray, eq, and } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  candidatesTable,
  candidateActionEventsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";

const P = "lar_" + crypto.randomUUID().slice(0, 8) + "_";
const id = (s: string) => P + s;

const TENANT = id("tenant");
const USER = id("user");
const CAND = id("cand");

async function cleanup() {
  await dbAdmin.delete(candidateActionEventsTable)
    .where(eq(candidateActionEventsTable.candidateId, CAND)).catch(() => {});
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.id, CAND)).catch(() => {});
  await dbAdmin.delete(usersTable).where(eq(usersTable.id, USER)).catch(() => {});
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, TENANT)).catch(() => {});
}

let server: Server;
let base: string;
let token: string;

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({
    id: TENANT, name: "LogAction Test Co", slug: TENANT, plan: "enterprise",
  });
  await dbAdmin.insert(usersTable).values({
    id: USER, tenantId: TENANT, email: USER + "@js.test", name: "Log Action",
    passwordHash: "x", role: "candidate", status: "active",
  });
  await dbAdmin.insert(candidatesTable).values({
    id: CAND, tenantId: TENANT, firstName: "Log", lastName: "Action",
    email: CAND + "@js.test", source: "career_site", userId: USER,
  });

  const careerProfileRouter = (await import("./career-profile")).default;
  const app = express();
  app.use(express.json());
  app.use(careerProfileRouter);
  server = await new Promise((resolve) => {
    const s = app.listen(0, "127.0.0.1", () => resolve(s));
  });
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  token = issueToken({ userId: USER, role: "candidate", tenantId: TENANT });
});

after(async () => {
  await new Promise<void>((resolve) => server?.close(() => resolve()));
  await cleanup();
});

const postLogAction = (eventType: string, auth = true) =>
  fetch(`${base}/portal/log-action`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(auth ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ eventType, payload: { probe: true } }),
  });

const rowCount = async (eventType: string) => {
  const rows = await dbAdmin.select({ id: candidateActionEventsTable.id })
    .from(candidateActionEventsTable)
    .where(and(
      eq(candidateActionEventsTable.candidateId, CAND),
      eq(candidateActionEventsTable.eventType, eventType),
    ));
  return rows.length;
};

test("RESERVED: eventType=recruiter_view is rejected with 400 and never inserted", async () => {
  const res = await postLogAction("recruiter_view");
  assert.equal(res.status, 400,
    `FORGERY HOLE: a candidate-supplied recruiter_view insert must 400, got ${res.status}`);
  assert.equal(await rowCount("recruiter_view"), 0,
    "FORGERY HOLE: a recruiter_view row reached the table despite the 400 — check ordering (reject must precede insert)");
});

test("RESERVED: eventType=role_open_at_target is rejected with 400 and never inserted", async () => {
  const res = await postLogAction("role_open_at_target");
  assert.equal(res.status, 400,
    `FORGERY HOLE: a candidate-supplied role_open_at_target insert must 400, got ${res.status}`);
  assert.equal(await rowCount("role_open_at_target"), 0,
    "FORGERY HOLE: a role_open_at_target row reached the table despite the 400");
});

test("CANARY: a benign self-event type still succeeds and persists", async () => {
  const res = await postLogAction("practice_session");
  assert.equal(res.status, 200,
    `FALSE PASS RISK: benign event types must still work (got ${res.status}) — ` +
    "an endpoint that rejects everything would make the reserved-type tests meaningless");
  assert.equal(await rowCount("practice_session"), 1,
    "benign event was accepted (200) but the row was not persisted");
});

test("AUTH: unauthenticated log-action is 401 (no anonymous event writes)", async () => {
  const res = await postLogAction("practice_session", false);
  assert.equal(res.status, 401, `unauthenticated request must 401, got ${res.status}`);
  assert.equal(await rowCount("practice_session"), 1,
    "unauthenticated request must not add rows (count must stay at the canary's 1)");
});
