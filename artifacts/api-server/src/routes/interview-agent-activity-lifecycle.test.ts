/**
 * interview-agent-activity-lifecycle.test.ts — Dashboard "Agent Activity" panel
 * + interview-session lifecycle VERIFICATION.
 *
 * Regression package for the bug where the recruiter dashboard's "Agent Activity"
 * panel showed 5 phantom rows all reading "AI Interview in progress · just now",
 * plus a permanently-stuck "active" session that inflated the "agents online"
 * header forever.
 *
 * Two surfaces are exercised:
 *
 * 1. GET /analytics/dashboard (REAL Express mount, tenant_admin over HTTP) —
 *    proves the feed now GROUNDS each row's label + timestamp in the session's
 *    real status, DEDUPES minted duplicate scheduled links into one row, and
 *    heartbeat-gates the "agents online" count so a stale "active" session does
 *    NOT flip the header.
 *
 * 2. The lifecycle-sweep functions exported from interview-invite-scheduler.ts,
 *    called directly (no interval) —
 *      • sweepInactiveLiveSessions()   active/in_progress/resumed gone silent → abandoned
 *      • expireStaleScheduledSessions() never-sent, never-started scheduled → expired
 *
 * Harness mirrors recruiter-ownership-sweep.test.ts: seed via `dbAdmin`
 * (BYPASSRLS), issue a real bearer token with issueToken(), hit the mounted
 * router with global fetch(). Outside withTenantContext the `db` proxy falls
 * through to `dbAdmin`, so RLS never filters — isolating the logic under test.
 * A dedicated unique tenant keeps the dashboard feed free of unrelated rows.
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
  interviewSessionsTable,
} from "@workspace/db";
import { issueToken } from "../lib/auth-token";
import {
  sweepInactiveLiveSessions,
  expireStaleScheduledSessions,
} from "../lib/interview-invite-scheduler";
import analyticsRouter from "./analytics";

const P = "iaal_";
const id = (s: string) => P + s;

const MIN = 60 * 1000;
const HR = 60 * MIN;
const DAY = 24 * HR;
const ago = (ms: number) => new Date(Date.now() - ms);

// Feed tenant (dashboard HTTP tests read ONLY this tenant's rows) and a
// SEPARATE lifecycle tenant so the sweep-fixture scheduled/live rows never leak
// into the dashboard feed under test. The sweep functions scan globally, so they
// still operate on the lifecycle tenant's rows regardless of this split.
const TENANT_ID = id("t");
const TENANT_LC = id("t2");
// All interview_sessions ids created by this test (feed rows + lifecycle rows).
const SESSION_IDS = [
  // dashboard feed rows
  "ph1", "ph2", "ph3", "ph4", "ph5", // 5 phantom scheduled (same candidate)
  "live", "staleActive", "done", "abnd",
  // lifecycle-sweep rows
  "lcStaleActive", "lcFreshActive", "lcStaleSched", "lcRecentSched", "lcInviteSched",
].map(id);

let server: Server;
let baseUrl: string;

function tAdminToken() {
  return issueToken({ userId: id("tadmin"), role: "tenant_admin", tenantId: TENANT_ID });
}

async function api(method: string, path: string, token: string): Promise<{ status: number; json: any }> {
  const res = await fetch(baseUrl + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
  });
  let json: any = null;
  try { json = await res.json(); } catch { json = null; }
  return { status: res.status, json };
}

async function cleanup() {
  await dbAdmin.delete(interviewSessionsTable).where(inArray(interviewSessionsTable.id, SESSION_IDS));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, [TENANT_ID, TENANT_LC]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [TENANT_ID, TENANT_LC]));
}

async function seed() {
  await cleanup();

  await dbAdmin.insert(tenantsTable).values([
    { id: TENANT_ID, name: "IAAL Tenant", slug: TENANT_ID, plan: "enterprise" },
    { id: TENANT_LC, name: "IAAL Lifecycle Tenant", slug: TENANT_LC, plan: "enterprise" },
  ]);

  await dbAdmin.insert(usersTable).values([
    { id: id("tadmin"), tenantId: TENANT_ID, email: id("tadmin") + "@t.test", name: "TAdmin", passwordHash: "x", role: "tenant_admin" },
  ]);

  // ── Dashboard feed rows (tenant is unique so ONLY these appear) ──────────
  // 5 phantom scheduled links minted for the SAME candidate 3 days ago:
  // inviteSentAt null (out-of-band generate-link), never started/completed.
  const phantoms = ["ph1", "ph2", "ph3", "ph4", "ph5"].map((s) => ({
    id: id(s),
    tenantId: TENANT_ID,
    applicationId: "pipeline",
    planId: id("plan-" + s),
    candidateId: id("phantomCand"),
    status: "scheduled" as const,
    createdAt: ago(3 * DAY),
  }));

  await dbAdmin.insert(interviewSessionsTable).values([
    ...phantoms,
    // genuinely-live: fresh heartbeat → counts toward agentsOnline + reads "in progress".
    { id: id("live"), tenantId: TENANT_ID, applicationId: "pipeline", planId: id("plan-live"), candidateId: id("liveCand"), status: "active", startedAt: ago(10 * MIN), lastActiveAt: ago(2 * MIN) },
    // stale "active": heartbeat 5h old → must NOT count toward agentsOnline.
    { id: id("staleActive"), tenantId: TENANT_ID, applicationId: "pipeline", planId: id("plan-stale"), candidateId: id("staleCand"), status: "active", startedAt: ago(5 * HR), lastActiveAt: ago(5 * HR) },
    // completed with a score.
    { id: id("done"), tenantId: TENANT_ID, applicationId: "pipeline", planId: id("plan-done"), candidateId: id("doneCand"), status: "completed", score: 82, startedAt: ago(2 * HR), completedAt: ago(1 * HR), lastActiveAt: ago(1 * HR) },
    // abandoned terminal state.
    { id: id("abnd"), tenantId: TENANT_ID, applicationId: "pipeline", planId: id("plan-abnd"), candidateId: id("abndCand"), status: "abandoned", startedAt: ago(6 * HR), abandonedAt: ago(2 * HR), lastActiveAt: ago(6 * HR) },

    // ── Lifecycle-sweep rows (separate tenant; mutated by the direct-call tests) ─
    // stale live (5h silent) → sweepInactiveLiveSessions should abandon it.
    { id: id("lcStaleActive"), tenantId: TENANT_LC, applicationId: "pipeline", planId: id("plan-lcsa"), candidateId: id("lcStaleCand"), status: "active", startedAt: ago(6 * HR), lastActiveAt: ago(5 * HR) },
    // fresh live → must be left ACTIVE.
    { id: id("lcFreshActive"), tenantId: TENANT_LC, applicationId: "pipeline", planId: id("plan-lcfa"), candidateId: id("lcFreshCand"), status: "active", startedAt: ago(10 * MIN), lastActiveAt: ago(1 * MIN) },
    // stale scheduled, never sent/started, 8d old → expireStaleScheduledSessions should expire it.
    { id: id("lcStaleSched"), tenantId: TENANT_LC, applicationId: "pipeline", planId: id("plan-lcss"), candidateId: id("lcStaleSchedCand"), status: "scheduled", createdAt: ago(8 * DAY) },
    // recent scheduled (1d) → must stay scheduled.
    { id: id("lcRecentSched"), tenantId: TENANT_LC, applicationId: "pipeline", planId: id("plan-lcrs"), candidateId: id("lcRecentSchedCand"), status: "scheduled", createdAt: ago(1 * DAY) },
    // 8d old scheduled BUT invite-tracked (inviteSentAt set) → expiry must NOT touch it.
    { id: id("lcInviteSched"), tenantId: TENANT_LC, applicationId: "pipeline", planId: id("plan-lcis"), candidateId: id("lcInviteSchedCand"), status: "scheduled", createdAt: ago(8 * DAY), inviteSentAt: ago(8 * DAY) },
  ]);
}

before(async () => {
  await seed();
  const app = express();
  app.use(express.json());
  app.use(analyticsRouter);
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
  await cleanup();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

async function sessionStatus(sid: string): Promise<any> {
  const [row] = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.id, id(sid)));
  return row;
}

/* ───────────────────────── Dashboard feed (HTTP) ─────────────────────────── */

test("dashboard: 5 phantom minted links collapse into ONE grounded 'scheduled' row (not 5× 'in progress · just now')", async () => {
  const { status, json } = await api("GET", "/analytics/dashboard", tAdminToken());
  assert.equal(status, 200);
  const feed: any[] = json.agentActivity;
  assert.ok(Array.isArray(feed));

  const scheduled = feed.filter((e) => e.action === "AI Interview scheduled");
  // Deduped to exactly one row for the single candidate.
  assert.equal(scheduled.length, 1, "5 minted duplicates must collapse to one feed row");
  const s = scheduled[0];
  assert.equal(s.status, "pending", "scheduled link is not a live/running agent");
  assert.equal(s.meta, "5 sessions", "collapsed row notes the duplicate count");
  // Timestamp is grounded in the real createdAt (3 days ago), NEVER a now() fallback.
  assert.notEqual(s.ago, "just now", "grounded timestamp must not read 'just now'");
  assert.match(s.ago, /day/, "3-day-old link should read in days");
});

test("dashboard: labels are grounded per real status (live / completed / abandoned)", async () => {
  const { json } = await api("GET", "/analytics/dashboard", tAdminToken());
  const feed: any[] = json.agentActivity;

  const live = feed.find((e) => e.id === `sess-${id("live")}`);
  assert.ok(live, "live session present in feed");
  assert.equal(live.status, "running");
  assert.equal(live.action, "AI Interview in progress");

  const done = feed.find((e) => e.id === `sess-${id("done")}`);
  assert.ok(done, "completed session present");
  assert.equal(done.status, "completed");
  assert.match(done.action, /^AI Interview completed/);
  assert.equal(done.meta, "Score: 82/100");

  const abnd = feed.find((e) => e.id === `sess-${id("abnd")}`);
  assert.ok(abnd, "abandoned session present");
  assert.equal(abnd.status, "flagged");
  assert.equal(abnd.action, "AI Interview abandoned");
});

test("dashboard: agentsOnline counts only heartbeat-fresh live sessions (stale 'active' does NOT flip the header)", async () => {
  const { json } = await api("GET", "/analytics/dashboard", tAdminToken());
  // Isolated tenant, no agent runs → the ONLY live agent is the fresh interview.
  // The 5h-stale "active" session must be excluded by the 30-min heartbeat gate.
  assert.equal(json.agentsOnline, 1, "exactly one genuinely-live session counts");
  assert.ok(json.agentsOnline > 0, "a live session flips the header to Active");
});

/* ─────────────────────── Lifecycle sweeps (direct) ───────────────────────── */

test("sweepInactiveLiveSessions: stale live session → abandoned; fresh live untouched", async () => {
  await sweepInactiveLiveSessions();

  const stale = await sessionStatus("lcStaleActive");
  assert.equal(stale.status, "abandoned", "5h-silent live session is swept to abandoned");
  assert.ok(stale.abandonedAt, "abandonedAt is stamped");

  const fresh = await sessionStatus("lcFreshActive");
  assert.equal(fresh.status, "active", "actively-answering session is never swept");
});

test("expireStaleScheduledSessions: never-sent 8d-old scheduled → expired; recent + invite-tracked untouched", async () => {
  await expireStaleScheduledSessions();

  const stale = await sessionStatus("lcStaleSched");
  assert.equal(stale.status, "expired", "8d-old never-sent scheduled link is expired");
  assert.ok(stale.expiredAt, "expiredAt is stamped");

  const recent = await sessionStatus("lcRecentSched");
  assert.equal(recent.status, "scheduled", "recent scheduled link is left alone");

  const invited = await sessionStatus("lcInviteSched");
  assert.equal(invited.status, "scheduled", "invite-tracked scheduled link is NOT expiry's domain");
});

test("post-sweep: the swept stale 'active' resolves to its true terminal state in the feed and stays uncounted", async () => {
  // sweepInactiveLiveSessions scans ALL tenants, so it also swept the feed
  // tenant's 5h-silent `staleActive`. That phantom "in progress" row must now
  // read as its true state (abandoned/flagged), and agentsOnline must still be
  // 1 — only the genuinely-live `live` session counts (the stale one never did,
  // and is now terminal). This is the "5 phantoms resolve to true states" goal.
  const { json } = await api("GET", "/analytics/dashboard", tAdminToken());
  assert.equal(json.agentsOnline, 1, "only the one heartbeat-fresh live session counts");

  const stale = feedEntry(json, id("staleActive"));
  assert.ok(stale, "swept session still surfaces in the recent-activity feed");
  assert.equal(stale.status, "flagged", "swept stale 'active' now renders as a terminal state");
  assert.equal(stale.action, "AI Interview abandoned");
});

function feedEntry(json: any, sessionId: string): any {
  return (json.agentActivity as any[]).find((e) => e.id === `sess-${sessionId}`);
}
