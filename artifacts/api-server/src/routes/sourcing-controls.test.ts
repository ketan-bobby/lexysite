import { before, after, afterEach, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { Server } from "node:http";
import express from "express";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowEventsTable as events,
  recruitingWorkflowReceiptsTable as receipts,
  sourcingPoliciesTable as policies,
  sourcingReservationsTable as holds,
  sourcingExecutionLeasesTable as leases,
  sourcingCostOperationsTable as costs,
  type SourcingLimits,
  candidatesTable,
  applicationsTable,
  sourcedCandidatesTable,
} from "@workspace/db";
import type { SourcingControlView } from "@workspace/api-zod";
import workflowRouter from "./recruiting-workflows";
import sourcingRouter from "./sourcing-controls";
import { getSourcingMonthlyPackages } from "../lib/sourcing-monthly-packages";
import { issueToken } from "../lib/auth-token";
import {
  acquireMeterLease,
  prepareCostOperation,
  beginCostDispatch,
  settleCostOperation,
  dispatchBoundedTestOperation,
  assertRealSourcingDispatchAllowed,
  renewMeterLease,
  checkpointInternalSourcing,
  type TrustedCostBound,
  type CostRequest,
  dispatchNativeSourcingOperation,
  livePricingCatalog,
} from "../lib/sourcing-meter";
import { getSourcingControls } from "../lib/sourcing-controls";
import { registerSourcingWorkerTests } from "../lib/sourcing-worker.test";
import { internalSourcingPlanHash } from "../lib/sourcing-worker-plan";
import { importNativeProfile } from "../lib/sourcing-native-import";

const prefix = `srcctl_${randomUUID().slice(0, 8)}`;
const tenant = `${prefix}_tenant`,
  foreign = `${prefix}_foreign`;
const roles = {
  admin: "tenant_admin",
  recruiter: "recruiter",
  peer: "recruiter",
  interviewer: "interviewer",
  candidate: "candidate",
  foreign: "tenant_admin",
} as const;
type Actor = keyof typeof roles;
const actorId = (actor: Actor) => `${prefix}_${actor}`;
const limits: SourcingLimits = {
  allowExternal: false,
  providers: [],
  maxCandidates: 8,
  maxDurationSeconds: 180,
  maxRuns: 3,
  runBudgetCents: 100,
  totalBudgetCents: 150,
};
let base: string, server: Server;
type Result = SourcingControlView & {
  id: string;
  replayed: boolean;
  autonomyExecutionEnabled: boolean;
};
async function request(
  method: string,
  path: string,
  body?: unknown,
  actor: Actor | null = "admin",
) {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(actor
        ? {
            Authorization: `Bearer ${issueToken({ userId: actorId(actor), tenantId: actor === "foreign" ? foreign : tenant, role: roles[actor] })}`,
          }
        : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: (await response.json()) as Result };
}
const endpoint = (jobId: string) => `/jobs/${jobId}/sourcing-controls`;
const read = (jobId: string, actor: Actor | null = "admin") =>
  request("GET", endpoint(jobId), undefined, actor);
const command = (jobId: string, body: unknown, actor: Actor | null = "admin") =>
  request("POST", endpoint(jobId), body, actor);
const key = () => randomUUID();
async function makeJob(internalMobility = false) {
  const id = `${prefix}_${randomUUID()}`;
  await dbAdmin.insert(jobsTable).values({
    id,
    tenantId: tenant,
    title: "Sourcing controls fixture",
    description: "Short fixture",
    status: "active",
    recruitingMode: "lexy_autonomous",
    internalMobility,
    assignedRecruiterId: actorId("recruiter"),
    interviewPath: "human",
  });
  const state = await read(id);
  const draft = await request("POST", `/jobs/${id}/workflow-journeys`, {
    idempotencyKey: key(),
    expectedBriefHash: state.body.briefHash,
  });
  assert.equal(draft.status, 200);
  const approval = await request("POST", `/jobs/${id}/workflow-journeys/${draft.body.id}/approve`, {
    idempotencyKey: key(),
    expectedBriefHash: state.body.briefHash,
  });
  assert.equal(approval.status, 200);
  return { id, hash: state.body.briefHash, journeyId: draft.body.id };
}
async function configured(custom = limits, internalMobility = false) {
  const job = await makeJob(internalMobility);
  const saved = await command(job.id, {
    action: "save",
    idempotencyKey: key(),
    expectedRevision: 0,
    expectedBriefHash: job.hash,
    limits: custom,
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));
  const approved = await command(job.id, {
    action: "approve",
    idempotencyKey: key(),
    expectedRevision: 1,
    expectedBriefHash: job.hash,
    journeyId: job.journeyId,
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  return job;
}
const reserve = (job: { id: string; hash: string }, idempotencyKey = key()) =>
  command(job.id, {
    action: "reserve",
    idempotencyKey,
    expectedRevision: 2,
    expectedBriefHash: job.hash,
  });
before(async () => {
  process.env.NODE_ENV = "test";
  await dbAdmin.insert(tenantsTable).values([
    { id: tenant, name: "Sourcing controls test", slug: tenant },
    { id: foreign, name: "Foreign test", slug: foreign },
  ]);
  await dbAdmin.insert(usersTable).values(
    Object.entries(roles).map(([actor, role]) => ({
      id: actorId(actor as Actor),
      tenantId: actor === "foreign" ? foreign : tenant,
      name: actor,
      email: `${prefix}_${actor}@example.invalid`,
      role,
      status: "active" as const,
      passwordHash: "unused",
    })),
  );
  const app = express();
  app.use(express.json(), workflowRouter, sourcingRouter);
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});
afterEach(async (context) => {
  if (!context.name.startsWith("native admission:")) return;
  // These cases create bench entries. Remove only their uniquely tagged,
  // tenant-private fictional identities so unrelated discovery fixtures
  // cannot accidentally discover candidates from an earlier admission case.
  const rows = await dbAdmin
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.tenantId, tenant),
        sql`position(${`/in/${prefix}-`} in lower(${candidatesTable.linkedinUrl})) > 0`,
      ),
    );
  const ids = rows.map((r) => r.id);
  if (!ids.length) return;
  await dbAdmin
    .delete(applicationsTable)
    .where(
      and(
        inArray(applicationsTable.tenantId, [tenant, foreign]),
        inArray(applicationsTable.candidateId, ids),
      ),
    );
  await dbAdmin
    .delete(sourcedCandidatesTable)
    .where(
      and(
        eq(sourcedCandidatesTable.tenantId, tenant),
        inArray(sourcedCandidatesTable.normalizedCandidateId, ids),
      ),
    );
  await dbAdmin
    .delete(candidatesTable)
    .where(and(eq(candidatesTable.tenantId, tenant), inArray(candidatesTable.id, ids)));
});
after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  for (const table of [
    applicationsTable,
    sourcedCandidatesTable,
    costs,
    leases,
    holds,
    policies,
    events,
    receipts,
    journeys,
    jobsTable,
  ])
    await dbAdmin.delete(table).where(eq(table.tenantId, tenant));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.tenantId, [tenant, foreign]));
  await dbAdmin.delete(usersTable).where(inArray(usersTable.tenantId, [tenant, foreign]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [tenant, foreign]));
  await pool.end();
});

async function nativeAdmissionFixture(maxCandidates = 2) {
  const job = await configured({
    ...limits,
    allowExternal: true,
    providers: ["pdl", "serp"],
    maxCandidates,
  });
  await dbAdmin
    .update(jobsTable)
    .set({ approvedById: actorId("admin") })
    .where(eq(jobsTable.id, job.id));
  const reserved = await reserve(job);
  assert.equal(reserved.status, 200);
  const state = await read(job.id);
  const hold = state.body.reservations.find((r) => r.id === reserved.body.id)!;
  const operationId = key();
  const profiles = [1, 2].map((i) => ({
    title: "Synthetic public reference — not a real candidate",
    url: `https://www.linkedin.com/in/${prefix}-${key()}-${i}`,
    snippet: "Synthetic fixture only",
  }));
  await dbAdmin.insert(events).values({
    tenantId: tenant,
    jobId: job.id,
    actorId: actorId("admin"),
    journeyId: job.journeyId,
    action: "sourcing.native_discovery",
    note: JSON.stringify({
      reservationId: hold.id,
      operationId,
      provider: "pdl",
      status: "succeeded",
      profiles,
    }),
  });
  const body = {
    action: "import_profile",
    idempotencyKey: key(),
    expectedRevision: hold.revision,
    expectedBriefHash: state.body.briefHash,
    reservationId: hold.id,
    operationId,
    profileUrl: profiles[0].url,
    fullName: "Synthetic Reviewer",
  };
  return { job, hold, profiles, body };
}

test("native admission: confirms a sourced entry, preserves unknown scores and replay creates no duplicates", async () => {
  const { job, body } = await nativeAdmissionFixture();
  const imported = await command(job.id, body);
  assert.equal(imported.status, 200, JSON.stringify(imported.body));
  assert.equal(imported.body.autonomyExecutionEnabled, false);
  const repeats = await Promise.all([
    command(job.id, body),
    command(job.id, { ...body, idempotencyKey: key() }),
  ]);
  for (const repeat of repeats) {
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.id, imported.body.id);
    assert.equal(repeat.body.replayed, true);
  }
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, imported.body.id));
  assert.equal(candidate.pool, "tenant");
  assert.equal(candidate.verificationStatus, "unverified");
  assert.ok(candidate.email.endsWith("@import.local"));
  assert.deepEqual(candidate.skills, []);
  const apps = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.candidateId, imported.body.id));
  assert.equal(apps.length, 1);
  assert.equal(apps[0].stage, "sourced");
  assert.equal(apps[0].matchScore, null);
  assert.equal(apps[0].entryType, "sourced");
  const sources = await dbAdmin
    .select()
    .from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.normalizedCandidateId, imported.body.id));
  assert.equal(sources.length, 1);
  const state = await read(job.id);
  assert.equal(state.body.externalRuns?.[0].profiles[0].imported, true);
  assert.equal((await command(job.id, { ...body, fullName: "Changed Identity" })).status, 409);
});

test("native admission: gates roles, foreign scope, fabricated profiles, stale revisions and missing name", async () => {
  const { job, body, hold } = await nativeAdmissionFixture();
  for (const [actor, status] of [
    [null, 401],
    ["candidate", 403],
    ["recruiter", 403],
    ["foreign", 404],
  ] as const)
    assert.equal((await command(job.id, body, actor)).status, status);
  for (const patch of [
    { profileUrl: "https://www.linkedin.com/in/not-a-saved-seed" },
    { operationId: key() },
    { expectedBriefHash: "0".repeat(64) },
    { expectedRevision: hold.revision + 1 },
  ])
    assert.equal((await command(job.id, { ...body, ...patch })).status, 409);
  const { fullName: _, ...missing } = body;
  assert.equal((await command(job.id, missing)).status, 400);
  const other = await nativeAdmissionFixture();
  assert.equal((await command(job.id, { ...body, reservationId: other.hold.id })).status, 404);
  assert.equal(
    (await dbAdmin.select().from(applicationsTable).where(eq(applicationsTable.jobId, job.id)))
      .length,
    0,
  );
});

test("native admission: respects approved shortlist size and rejects paused controls", async () => {
  const { job, body, profiles, hold } = await nativeAdmissionFixture(1);
  assert.equal((await command(job.id, body)).status, 200);
  assert.equal(
    (await command(job.id, { ...body, idempotencyKey: key(), profileUrl: profiles[1].url })).status,
    409,
  );
  await dbAdmin.update(holds).set({ status: "paused" }).where(eq(holds.id, hold.id));
  assert.equal((await command(job.id, body)).status, 409);
});

test("native admission: rolls back candidate, source and application if audit persistence fails", async () => {
  const { job, body } = await nativeAdmissionFixture();
  const { action: _, ...input } = body;
  const handle = {
    transaction: (fn: (tx: unknown) => Promise<unknown>) =>
      dbAdmin.transaction((tx) =>
        fn(
          new Proxy(tx, {
            get(target, property) {
              if (property === "insert")
                return (table: unknown) => {
                  if (table === events) throw new Error("fixture audit failure");
                  return target.insert(table as typeof candidatesTable);
                };
              const value = Reflect.get(target, property);
              return typeof value === "function" ? value.bind(target) : value;
            },
          }),
        ),
      ),
  } as unknown as Parameters<typeof importNativeProfile>[2];
  await assert.rejects(
    importNativeProfile(
      {
        jobId: job.id,
        tenantId: tenant,
        actorId: actorId("admin"),
        canApprove: true,
      },
      input,
      handle,
    ),
    /fixture audit failure/,
  );
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(candidatesTable)
        .where(eq(candidatesTable.linkedinUrl, body.profileUrl))
    ).length,
    0,
  );
  assert.equal(
    (await dbAdmin.select().from(applicationsTable).where(eq(applicationsTable.jobId, job.id)))
      .length,
    0,
  );
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(sourcedCandidatesTable)
        .where(sql`${sourcedCandidatesTable.rawData}->>'jobId' = ${job.id}`)
    ).length,
    0,
  );
});

test("native admission: cannot restore erased/DNC/platform/employee rows and reuses existing canonical identities", async () => {
  for (const restricted of [
    { doNotContact: true },
    { dataErasedAt: new Date() },
    { pool: "platform" },
    { isCurrentEmployee: true },
  ]) {
    const { job, body } = await nativeAdmissionFixture();
    await dbAdmin.insert(candidatesTable).values({
      id: key(),
      tenantId: tenant,
      firstName: "Synthetic",
      lastName: "Restricted",
      email: `${key()}@import.local`,
      linkedinUrl: body.profileUrl,
      ...restricted,
    });
    assert.equal((await command(job.id, body)).status, 409);
    assert.equal(
      (await dbAdmin.select().from(applicationsTable).where(eq(applicationsTable.jobId, job.id)))
        .length,
      0,
    );
  }
  const { job, body } = await nativeAdmissionFixture();
  const candidateId = key();
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId: tenant,
    firstName: "Original",
    lastName: "Identity",
    email: `${key()}@import.local`,
    linkedinUrl: body.profileUrl.replace("www.", "") + "/?tracking=fixture",
  });
  // Applications can be owned by the agency while their job and canonical
  // candidate belong to its client. Admission must not duplicate or restore
  // an existing application merely because its row tenant differs.
  const applicationId = key();
  await dbAdmin.insert(applicationsTable).values({
    id: applicationId,
    tenantId: foreign,
    jobId: job.id,
    candidateId,
    stage: "applied",
    entryType: "applied",
    matchScore: 72,
  });
  const result = await command(job.id, body);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.id, candidateId);
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId));
  assert.equal(candidate.firstName, "Original");
  const applications = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(
      and(eq(applicationsTable.jobId, job.id), eq(applicationsTable.candidateId, candidateId)),
    );
  assert.equal(applications.length, 1);
  assert.equal(applications[0].id, applicationId);
  assert.equal(applications[0].stage, "applied");
  assert.equal(applications[0].entryType, "applied");
  assert.equal(applications[0].matchScore, 72);
});

test("USD controls require current staff authority and requisition assignment", async () => {
  const job = await makeJob();
  for (const [actor, status] of [
    [null, 401],
    ["candidate", 403],
    ["peer", 404],
    ["foreign", 404],
    ["interviewer", 200],
    ["recruiter", 200],
  ] as const)
    assert.equal((await read(job.id, actor)).status, status);
  const body = {
    action: "save",
    idempotencyKey: key(),
    expectedRevision: 0,
    expectedBriefHash: job.hash,
    limits,
  };
  assert.equal((await command(job.id, body, "interviewer")).status, 403);
  assert.equal((await command(job.id, body, "recruiter")).status, 200);
  assert.equal(
    (
      await command(
        job.id,
        {
          action: "approve",
          idempotencyKey: key(),
          expectedRevision: 1,
          expectedBriefHash: job.hash,
          journeyId: job.journeyId,
        },
        "recruiter",
      )
    ).status,
    403,
  );
  assert.equal(
    (
      await command(
        job.id,
        {
          action: "reserve",
          idempotencyKey: key(),
          expectedRevision: 1,
          expectedBriefHash: job.hash,
        },
        "recruiter",
      )
    ).status,
    403,
  );
});

test("local internal discovery persists a scoped shortlist and replays without restarting work", async () => {
  const job = await configured();
  const held = await reserve(job);
  const savedId = `${prefix}_saved`;
  await dbAdmin.insert(candidatesTable).values([
    {
      id: savedId,
      tenantId: tenant,
      pool: "tenant",
      firstName: "Saved",
      lastName: "Talent",
      email: `${savedId}@example.invalid`,
      currentTitle: "Sourcing controls fixture",
    },
    {
      id: `${prefix}_private`,
      tenantId: tenant,
      pool: "platform",
      firstName: "Private",
      lastName: "Profile",
      email: `${prefix}_private@example.invalid`,
      currentTitle: "Sourcing controls fixture",
    },
    {
      id: `${prefix}_employee`,
      tenantId: tenant,
      pool: "tenant",
      firstName: "Current",
      lastName: "Employee",
      email: `${prefix}_employee@example.invalid`,
      isCurrentEmployee: true,
    },
    {
      id: `${prefix}_dnc`,
      tenantId: tenant,
      pool: "tenant",
      firstName: "Do not",
      lastName: "Contact",
      email: `${prefix}_dnc@example.invalid`,
      doNotContact: true,
    },
    {
      id: `${prefix}_erased`,
      tenantId: tenant,
      pool: "tenant",
      firstName: "Erased",
      lastName: "Profile",
      email: `${prefix}_erased@example.invalid`,
      dataErasedAt: new Date(),
    },
    {
      id: `${prefix}_other`,
      tenantId: foreign,
      pool: "tenant",
      firstName: "Foreign",
      lastName: "Talent",
      email: `${prefix}_other@example.invalid`,
      currentTitle: "Sourcing controls fixture",
    },
  ]);
  const input = {
    action: "start_internal",
    reservationId: held.body.id,
    expectedRevision: 1,
    idempotencyKey: key(),
  };
  for (const [actor, status] of [
    [null, 401],
    ["candidate", 403],
    ["peer", 404],
    ["foreign", 404],
    ["interviewer", 403],
  ] as const)
    assert.equal((await command(job.id, input, actor)).status, status);
  // Assigned recruiter can run local-only work; paid budget authority remains separate.
  const started = await command(job.id, input, "recruiter");
  assert.equal(started.status, 200, JSON.stringify(started.body));
  const view = (await read(job.id)).body;
  assert.equal(view.executionEnabled, false);
  assert.equal(view.internalDiscoveryEnabled, true);
  const run = view.internalRuns?.find((r) => r.reservationId === held.body.id);
  assert.equal(run?.status, "completed");
  assert.deepEqual(
    run?.candidates.map((c) => c.id),
    [savedId],
  );
  assert.equal(view.costOperations.length, 0);
  const [lease] = await dbAdmin.select().from(leases).where(eq(leases.reservationId, held.body.id));
  const again = await command(job.id, input, "recruiter");
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.replayed, true);
  const [recovered] = await dbAdmin
    .select()
    .from(leases)
    .where(eq(leases.reservationId, held.body.id));
  assert.deepEqual(recovered.candidateIds, lease.candidateIds);
  assert.equal(recovered.deadline.getTime(), lease.deadline.getTime());
  await dbAdmin
    .update(candidatesTable)
    .set({ doNotContact: true })
    .where(eq(candidatesTable.id, savedId));
  assert.equal(
    (await read(job.id)).body.internalRuns?.find((r) => r.reservationId === held.body.id)
      ?.candidates.length,
    0,
    "current compliance hides saved results",
  );
});

test("internal discovery obeys hold revision, pause/cancel and stale approval", async () => {
  const job = await configured();
  const held = await reserve(job);
  const start = (revision: number) =>
    command(job.id, {
      action: "start_internal",
      reservationId: held.body.id,
      expectedRevision: revision,
      idempotencyKey: key(),
    });
  assert.equal((await start(999)).status, 409);
  assert.equal(
    (
      await command(job.id, {
        action: "pause",
        reservationId: held.body.id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  assert.equal((await start(2)).status, 409);
  assert.equal(
    (
      await command(job.id, {
        action: "resume",
        reservationId: held.body.id,
        expectedRevision: 2,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  assert.equal((await start(3)).status, 200);
  await dbAdmin
    .update(jobsTable)
    .set({ description: "Changed approval snapshot" })
    .where(eq(jobsTable.id, job.id));
  assert.equal((await start(3)).status, 409);
  assert.equal(
    (
      await command(job.id, {
        action: "cancel",
        reservationId: held.body.id,
        expectedRevision: 3,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  assert.equal((await start(4)).status, 409);
});

test("interrupted internal discovery resumes its bound plan and preserves the deadline", async () => {
  const job = await configured();
  const held = await reserve(job);
  const [row] = await dbAdmin.select().from(holds).where(eq(holds.id, held.body.id));
  const scope = scopeOf(job);
  const lease = await acquireMeterLease(
    scope,
    row.id,
    `sourcing-plan:${internalSourcingPlanHash(row)}:${key()}`,
    { internalOnly: true },
  );
  await dbAdmin
    .update(leases)
    .set({ leaseUntil: new Date(Date.now() - 1000) })
    .where(eq(leases.reservationId, row.id));
  const readBefore = (await read(job.id)).body.internalRuns?.find(
    (r) => r.reservationId === row.id,
  );
  assert.equal(readBefore?.status, "interrupted");
  const resumed = await command(job.id, {
    action: "start_internal",
    reservationId: row.id,
    expectedRevision: 1,
    idempotencyKey: key(),
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.body));
  const [recovered] = await dbAdmin.select().from(leases).where(eq(leases.reservationId, row.id));
  assert.equal(recovered.deadline.getTime(), lease.deadline.getTime());
  assert.equal(recovered.generation, lease.generation + 1);
  await assert.rejects(checkpointInternalSourcing(scope, lease, []), /expired|fenced/);
});

test("internal checkpoint rejects paused work, revoked approval and expired runtime", async () => {
  for (const stop of ["pause", "revoke", "deadline"] as const) {
    const job = await configured();
    const held = await reserve(job);
    const [row] = await dbAdmin.select().from(holds).where(eq(holds.id, held.body.id));
    const scope = scopeOf(job);
    const lease = await acquireMeterLease(
      scope,
      row.id,
      `sourcing-plan:${internalSourcingPlanHash(row)}:${key()}`,
      { internalOnly: true },
    );
    if (stop === "pause") {
      assert.equal(
        (
          await command(job.id, {
            action: "pause",
            reservationId: row.id,
            expectedRevision: 1,
            idempotencyKey: key(),
          })
        ).status,
        200,
      );
    } else if (stop === "revoke") {
      await dbAdmin.update(policies).set({ status: "draft" }).where(eq(policies.jobId, job.id));
    } else {
      await dbAdmin
        .update(leases)
        .set({ deadline: new Date(Date.now() - 1000) })
        .where(eq(leases.reservationId, row.id));
    }
    await assert.rejects(checkpointInternalSourcing(scope, lease, []));
    assert.notEqual(
      (await read(job.id)).body.internalRuns?.find((r) => r.reservationId === row.id)?.status,
      "completed",
    );
  }
});

test("internal mobility returns employees only and never creates paid operations", async () => {
  const job = await configured(limits, true);
  const held = await reserve(job);
  assert.equal(
    (
      await command(job.id, {
        action: "start_internal",
        reservationId: held.body.id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  const view = (await read(job.id)).body;
  assert.deepEqual(
    view.internalRuns?.find((r) => r.reservationId === held.body.id)?.candidates.map((c) => c.id),
    [`${prefix}_employee`],
  );
  assert.equal(view.costOperations.length, 0);
});
test("invalid limits, invented execution authority and branch payloads are rejected atomically", async () => {
  const job = await makeJob();
  for (const patch of [
    { runBudgetCents: -1 },
    { totalBudgetCents: 20 },
    { providers: ["serp", "serp"], allowExternal: true },
    { allowExternal: true },
    { maxCandidates: 26 },
    { maxDurationSeconds: 1 },
  ]) {
    assert.ok(
      (
        await command(job.id, {
          action: "save",
          idempotencyKey: key(),
          expectedRevision: 0,
          expectedBriefHash: job.hash,
          limits: { ...limits, ...patch },
        })
      ).status >= 400,
    );
  }
  assert.equal(
    (
      await command(job.id, {
        action: "save",
        idempotencyKey: key(),
        expectedRevision: 0,
        expectedBriefHash: job.hash,
        limits,
        executionEnabled: true,
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await command(job.id, {
        action: "save",
        idempotencyKey: key(),
        expectedRevision: 0,
        expectedBriefHash: job.hash,
      })
    ).status,
    400,
  );
  assert.equal((await read(job.id)).body.policy, null);
});
test("employee-only scope forbids external providers; known nonemployees can explicitly plan them", async () => {
  const employee = await makeJob(true);
  assert.equal(
    (
      await command(employee.id, {
        action: "save",
        idempotencyKey: key(),
        expectedRevision: 0,
        expectedBriefHash: employee.hash,
        limits: { ...limits, allowExternal: true, providers: ["serp"] },
      })
    ).status,
    409,
  );
  const normal = await configured({ ...limits, allowExternal: true, providers: ["serp"] });
  const state = (await read(normal.id)).body;
  assert.equal(state.policy?.status, "approved");
  assert.equal(state.trustedPricingAvailable, false);
  assert.equal(state.executionEnabled, false);
  assert.equal(state.outreachEnabled, false);
});
test("concurrent internal-test reservations are not blocked by advisory USD allocations", async () => {
  const job = await configured();
  const results = await Promise.all([reserve(job), reserve(job)]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 200]);
  const state = (await read(job.id)).body;
  assert.equal(state.allocatedCents, 200);
  assert.equal(state.availableCents, 0);
  assert.equal(state.reservations.length, 2);
});
test("same-key retries allocate once and mismatched key reuse conflicts", async () => {
  const job = await configured(),
    idempotencyKey = key();
  const results = await Promise.all([reserve(job, idempotencyKey), reserve(job, idempotencyKey)]);
  assert.equal(results[0].body.id, results[1].body.id);
  assert.equal(results.filter((r) => r.body.replayed).length, 1);
  assert.equal((await read(job.id)).body.allocatedCents, 100);
  assert.equal(
    (
      await command(job.id, {
        action: "reserve",
        idempotencyKey,
        expectedRevision: 1,
        expectedBriefHash: job.hash,
      })
    ).status,
    409,
  );
});
test("prepared holds survive reads, pause retains allocation, cancel releases only the unused hold", async () => {
  const job = await configured(),
    prepared = await reserve(job);
  const id = prepared.body.id;
  const pause = { action: "pause", reservationId: id, expectedRevision: 1, idempotencyKey: key() };
  assert.equal((await command(job.id, pause)).status, 200);
  assert.equal((await command(job.id, pause)).body.replayed, true);
  const state = (await read(job.id)).body;
  assert.equal(state.allocatedCents, 100);
  assert.equal(state.reservations[0].status, "paused");
  assert.equal(
    (
      await command(job.id, {
        action: "resume",
        reservationId: id,
        expectedRevision: 2,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await command(job.id, {
        action: "cancel",
        reservationId: id,
        expectedRevision: 3,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  assert.equal((await read(job.id)).body.allocatedCents, 0);
  assert.equal((await read(job.id)).body.reservations[0].status, "cancelled");
  assert.equal(
    (
      await command(job.id, {
        action: "resume",
        reservationId: id,
        expectedRevision: 4,
        idempotencyKey: key(),
      })
    ).status,
    409,
  );
});
test("approved run-count scope remains enforced but advisory USD can be revised", async () => {
  const job = await configured({ ...limits, totalBudgetCents: 500, maxRuns: 1 });
  assert.equal((await reserve(job)).status, 200);
  assert.equal((await reserve(job)).status, 409);
  assert.equal(
    (
      await command(job.id, {
        action: "save",
        expectedRevision: 2,
        expectedBriefHash: job.hash,
        idempotencyKey: key(),
        limits: { ...limits, runBudgetCents: 10, totalBudgetCents: 50 },
      })
    ).status,
    200,
  );
});
test("brief edits invalidate approval and resume; cancellation remains available", async () => {
  const job = await configured(),
    prepared = await reserve(job);
  assert.equal(
    (
      await command(job.id, {
        action: "pause",
        reservationId: prepared.body.id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  await dbAdmin
    .update(jobsTable)
    .set({ title: "Materially changed fixture" })
    .where(eq(jobsTable.id, job.id));
  assert.equal((await read(job.id)).body.policy?.stale, true);
  assert.equal((await read(job.id)).body.reservations[0].stale, true);
  assert.equal((await reserve(job)).status, 409);
  assert.equal(
    (
      await command(job.id, {
        action: "resume",
        reservationId: prepared.body.id,
        expectedRevision: 2,
        idempotencyKey: key(),
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await command(job.id, {
        action: "cancel",
        reservationId: prepared.body.id,
        expectedRevision: 2,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
});
test("save revokes approval, exact approved journey is required, other jobs cannot control a hold", async () => {
  const job = await configured(),
    prepared = await reserve(job),
    other = await makeJob();
  assert.equal(
    (
      await command(other.id, {
        action: "cancel",
        reservationId: prepared.body.id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await command(other.id, {
        action: "save",
        expectedRevision: 0,
        expectedBriefHash: other.hash,
        idempotencyKey: key(),
        limits,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await command(other.id, {
        action: "approve",
        expectedRevision: 1,
        expectedBriefHash: other.hash,
        idempotencyKey: key(),
        journeyId: job.journeyId,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await command(job.id, {
        action: "save",
        expectedRevision: 2,
        expectedBriefHash: job.hash,
        idempotencyKey: key(),
        limits,
      })
    ).status,
    200,
  );
  assert.equal((await read(job.id)).body.policy?.status, "draft");
  assert.equal((await reserve(job)).status, 409);
});
test("RLS hides control rows from a foreign app-role context", async () => {
  const job = await configured();
  await reserve(job);
  const connection = await pool.connect();
  try {
    await connection.query("BEGIN");
    await connection.query("SET LOCAL ROLE lexy_app");
    await connection.query(
      "SELECT set_config('app.allowed_tenant_ids',$1,true),set_config('app.is_platform_admin','false',true)",
      [foreign],
    );
    assert.equal(
      (await connection.query("SELECT * FROM sourcing_policies WHERE job_id=$1", [job.id]))
        .rowCount,
      0,
    );
    assert.equal(
      (await connection.query("SELECT * FROM sourcing_reservations WHERE job_id=$1", [job.id]))
        .rowCount,
      0,
    );
    await connection.query("SELECT set_config('app.allowed_tenant_ids',$1,true)", [tenant]);
    assert.equal(
      (await connection.query("SELECT * FROM sourcing_reservations WHERE job_id=$1", [job.id]))
        .rowCount,
      1,
    );
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
});
test("controls do not queue work, contact candidates, create pipeline runs or usage charges", async () => {
  const result = await dbAdmin.execute(sql`SELECT
    (SELECT count(*) FROM ai_jobs WHERE tenant_id=${tenant}) AS ai,
    (SELECT count(*) FROM agent_runs WHERE tenant_id=${tenant}) AS agents,
    (SELECT count(*) FROM interview_sessions WHERE tenant_id=${tenant}) AS interviews,
    (SELECT count(*) FROM outreach_messages WHERE tenant_id=${tenant}) AS outreach,
    (SELECT count(*) FROM credit_usage_events WHERE tenant_id=${tenant}) AS credits,
    (SELECT count(*) FROM applications WHERE tenant_id=${tenant}) AS applications`);
  assert.ok(Object.values(result.rows[0]).every((value) => Number(value) === 0));
});

const scopeOf = (job: { id: string }) => ({
  jobId: job.id,
  tenantId: tenant,
  actorId: actorId("admin"),
  canApprove: true,
});
test("monthly packages use the existing country catalog without creating a sourcing allowance", async () => {
  const job = await configured();
  const response = await read(job.id);
  assert.equal(response.status, 200);
  const view = response.body as unknown as SourcingControlView;
  const packages = view.monthlyPackages;
  assert.ok(packages);
  assert.equal(packages.displayTerm, "monthly");
  assert.equal(packages.sourcingAllowanceConfigured, false);
  assert.deepEqual(
    packages.tiers.map((p: { code: string }) => p.code),
    ["starter", "growth", "enterprise"],
  );
  assert.equal(packages.tiers[0].maxOpenJobs, 5);
  assert.equal(packages.tiers[1].maxStaffSeats, 10);
  assert.match(packages.note, /not a new charge/);
  assert.equal(view.executionEnabled, false);
});
test("child work orders use root-company country and plan, not a child snapshot", async () => {
  const rootId = key();
  const childId = key();
  await dbAdmin.insert(tenantsTable).values([
    {
      id: rootId,
      name: "Monthly package fixture root",
      slug: rootId,
      plan: "growth",
      country: "IN",
    },
    {
      id: childId,
      name: "Monthly package fixture child",
      slug: childId,
      parentId: rootId,
      plan: "demo",
      country: "IN",
    },
  ]);
  try {
    const packages = await getSourcingMonthlyPackages(childId);
    assert.equal(packages?.currentPlan, "growth");
    assert.equal(packages?.country, "IN");
    assert.equal(packages?.tiers[0].currency, "INR");
    assert.equal(packages?.sourcingAllowanceConfigured, false);
  } finally {
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, childId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, rootId));
  }
});
test("account rate evidence persists and revokes prior approval without unlocking pricing", async () => {
  const job = await configured();
  const before = await getSourcingControls(dbAdmin, scopeOf(job));
  const accountRates = {
    serp: {
      microsPerCredit: 25_001,
      basis: "prepaid_allocation",
      source: "fixture-only package allocation",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  };
  const saved = await command(job.id, {
    action: "save",
    idempotencyKey: key(),
    expectedRevision: before.policy!.revision,
    expectedBriefHash: before.briefHash,
    limits: { ...limits, accountRates },
  });
  assert.equal(saved.status, 200);
  const after = await getSourcingControls(dbAdmin, scopeOf(job));
  assert.deepEqual(after.policy!.limits.accountRates, accountRates);
  assert.equal(after.policy!.status, "draft");
  assert.equal(after.trustedPricingAvailable, false);
  assert.equal(after.executionEnabled, false);
  assert.equal(after.costAnalysis.complete, false);
});
test("planning allowance above allocation does not prevent an internal-test reservation", async () => {
  const job = await configured({
    ...limits,
    allowExternal: true,
    providers: ["pdl"],
    accountRates: {
      pdl: {
        microsPerCredit: 1_000_000,
        basis: "payg",
        source: "fixture-only tariff",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    },
  });
  const held = await reserve(job);
  assert.equal(held.status, 200);
  assert.ok(held.body.id);
});
test("zero, malformed, and caller-declared verified account rates are rejected", async () => {
  const job = await configured();
  const before = await getSourcingControls(dbAdmin, scopeOf(job));
  for (const rate of [
    {
      microsPerCredit: 1,
      basis: "payg",
      source: "fixture@example.invalid",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
    { microsPerCredit: 0, basis: "payg", source: "fixture", expiresAt: "2099-01-01T00:00:00.000Z" },
    { microsPerCredit: 1, basis: "payg", source: "fixture", expiresAt: "bad" },
    {
      microsPerCredit: 1,
      basis: "payg",
      source: "fixture",
      expiresAt: "2099-01-01T00:00:00.000Z",
      verified: true,
    },
  ]) {
    const saved = await command(job.id, {
      action: "save",
      idempotencyKey: key(),
      expectedRevision: before.policy!.revision,
      expectedBriefHash: before.briefHash,
      limits: { ...limits, accountRates: { serp: rate } },
    });
    assert.equal(saved.status, 400);
  }
});
const quote = (upperMicros = 600_000): TrustedCostBound => ({
  upperMicros,
  pricingVersion: "fixture-only-not-vendor-pricing",
  evidence: "bounded fake adapter test contract",
  expiresAt: new Date(Date.now() + 60_000),
});
const operation = (operationKey = key(), candidateId?: string) => ({
  operationKey,
  provider: "model" as const,
  request: { maxTokens: 20 },
  candidateId,
});
const expireLease = (id: string) =>
  dbAdmin
    .update(leases)
    .set({ leaseUntil: new Date(Date.now() - 2000) })
    .where(eq(leases.reservationId, id));
async function metered(custom = limits) {
  const job = await configured(custom);
  const held = await reserve(job);
  const scope = scopeOf(job);
  const lease = await acquireMeterLease(scope, held.body.id, key());
  return { job, scope, lease, id: held.body.id };
}
registerSourcingWorkerTests(async () => {
  const job = await configured();
  const held = await reserve(job);
  return { scope: scopeOf(job), id: held.body.id };
});
test("meter denies live dispatch, unknown/expired/zero prices and unapproved providers", async () => {
  const { scope, lease } = await metered();
  assert.doesNotThrow(assertRealSourcingDispatchAllowed);
  for (const price of [undefined, quote(0), { ...quote(), expiresAt: new Date(0) }])
    await assert.rejects(prepareCostOperation(scope, lease, operation(), price));
  await assert.rejects(
    prepareCostOperation(scope, lease, { ...operation(), provider: "serp" }, quote()),
    /outside approved scope/,
  );
  let invoked = 0;
  await assert.rejects(
    dispatchBoundedTestOperation(scope, lease, operation(), {
      mode: "test",
      bound: () => undefined,
      invoke: async () => {
        invoked++;
        return { actualMicros: 0, billingEvidence: "fake" };
      },
    }),
  );
  assert.equal(invoked, 0);
});

test("native discovery: internal HTTP dispatch needs authority, not pricing", async (t) => {
  const { NATIVE_SOURCING_ADAPTERS } = await import("../lib/sourcing-live-adapters");
  t.mock.method(NATIVE_SOURCING_ADAPTERS.serp, "isConfigured", () => true);
  let calls = 0;
  t.mock.method(NATIVE_SOURCING_ADAPTERS.serp, "invoke", async () => {
    calls++;
    return { profiles: [] };
  });
  const job = await configured({ ...limits, allowExternal: true, providers: ["serp"] });
  const held = await reserve(job);
  assert.equal((await reserve(job)).status, 200);
  const before = await getSourcingControls(dbAdmin, scopeOf(job));
  assert.ok(before.allocatedCents > limits.totalBudgetCents);
  const input = {
    action: "start_external",
    reservationId: held.body.id,
    expectedRevision: before.reservations.find((r) => r.id === held.body.id)!.revision,
    idempotencyKey: key(),
  };
  assert.equal((await command(job.id, input, "recruiter")).status, 403);
  assert.equal((await command(job.id, input, "foreign")).status, 404);
  assert.equal((await command(job.id, input)).status, 200);
  assert.equal(calls, 1);
  const state = await getSourcingControls(dbAdmin, scopeOf(job));
  assert.equal(state.externalDispatch?.ready, true);
  assert.ok(!state.externalDispatch?.blockers.some((s) => s.includes("price bound")));
  assert.equal(state.costOperations.length, 0);
  assert.equal(state.externalRuns?.[0].status, "succeeded");
  const revision = state.reservations.find((r) => r.id === held.body.id)!.revision;
  await command(job.id, { ...input, expectedRevision: revision, idempotencyKey: key() });
  assert.equal(calls, 1);
});

test("native providers: PDL and Serp discovery seed deduplicated EnrichLayer requests without prices", async (t) => {
  const { NATIVE_SOURCING_ADAPTERS: ports } = await import("../lib/sourcing-providers");
  const sequence: string[] = [];
  const ref = (slug: string) => ({
    title: slug,
    url: `https://www.linkedin.com/in/${slug}`,
    snippet: "Fixture engineer",
  });
  for (const id of ["pdl", "serp", "enrichlayer"] as const) {
    t.mock.method(ports[id], "isConfigured", () => true);
    t.mock.method(ports[id], "isEnabled", () => true);
  }
  t.mock.method(ports.pdl, "invoke", async () => {
    sequence.push("pdl");
    return { profiles: [ref("fixture-pdl"), ref("fixture-common")] };
  });
  t.mock.method(ports.serp, "invoke", async () => {
    sequence.push("serp");
    return { profiles: [ref("fixture-common"), ref("fixture-serp")] };
  });
  t.mock.method(ports.enrichlayer, "invoke", async (input: CostRequest) => {
    const url = (input.request as { url: string }).url;
    sequence.push(`enrich:${url}`);
    return { profiles: [{ title: "Enriched fixture", url, snippet: "Public work details" }] };
  });
  const job = await configured({
    ...limits,
    allowExternal: true,
    providers: ["pdl", "serp", "enrichlayer"],
  });
  const hold = await reserve(job);
  const input = {
    action: "start_external",
    reservationId: hold.body.id,
    expectedRevision: 1,
    idempotencyKey: key(),
  };
  assert.equal((await command(job.id, input, "recruiter")).status, 403);
  assert.equal((await command(job.id, input, "foreign")).status, 404);
  assert.equal(sequence.length, 0);
  assert.equal((await command(job.id, input)).status, 200);
  assert.deepEqual(sequence.slice(0, 2), ["pdl", "serp"]);
  assert.equal(sequence.length, 5);
  assert.equal(new Set(sequence.slice(2)).size, 3);
  const state = (await read(job.id)).body;
  assert.equal(state.externalRuns?.filter((run) => run.provider === "enrichlayer").length, 3);
  assert.ok(state.externalRuns?.every((run) => run.status === "succeeded"));
  assert.equal(state.costOperations.length, 0);
  assert.equal((await command(job.id, { ...input, idempotencyKey: key() })).status, 200);
  assert.equal(sequence.length, 5);
});

test("native providers: missing PDL credentials are visible and do not block configured Serp discovery", async (t) => {
  const { NATIVE_SOURCING_ADAPTERS: ports } = await import("../lib/sourcing-providers");
  t.mock.method(ports.pdl, "isConfigured", () => false);
  t.mock.method(ports.serp, "isConfigured", () => true);
  t.mock.method(ports.serp, "isEnabled", () => true);
  let calls = 0;
  t.mock.method(ports.serp, "invoke", async () => {
    calls++;
    return { profiles: [] };
  });
  const job = await configured({ ...limits, allowExternal: true, providers: ["pdl", "serp"] });
  const hold = await reserve(job);
  assert.equal(
    (
      await command(job.id, {
        action: "start_external",
        reservationId: hold.body.id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  const state = (await read(job.id)).body;
  assert.equal(calls, 1);
  assert.ok(
    state.externalRuns?.some(
      (run) => run.provider === "pdl" && run.status === "skipped" && run.reason,
    ),
  );
  assert.ok(
    state.externalRuns?.some((run) => run.provider === "serp" && run.status === "succeeded"),
  );
});

test("native providers: PDL-only discovery needs no Serp account and failures remain visible without retries", async (t) => {
  const { NATIVE_SOURCING_ADAPTERS: ports } = await import("../lib/sourcing-providers");
  t.mock.method(ports.pdl, "isConfigured", () => true);
  t.mock.method(ports.pdl, "isEnabled", () => true);
  t.mock.method(ports.enrichlayer, "isConfigured", () => true);
  t.mock.method(ports.enrichlayer, "isEnabled", () => true);
  let calls = 0,
    enrich = 0;
  t.mock.method(ports.pdl, "invoke", async () => {
    calls++;
    throw new Error("fixture provider failure");
  });
  t.mock.method(ports.enrichlayer, "invoke", async () => {
    enrich++;
    return { profiles: [] };
  });
  const job = await configured({
    ...limits,
    allowExternal: true,
    providers: ["pdl", "enrichlayer"],
  });
  const hold = await reserve(job);
  const input = {
    action: "start_external",
    reservationId: hold.body.id,
    expectedRevision: 1,
    idempotencyKey: key(),
  };
  assert.equal((await command(job.id, input)).status, 200);
  const state = (await read(job.id)).body;
  assert.equal(state.externalDispatch?.ready, true);
  assert.ok(
    state.externalRuns?.some((run) => run.provider === "pdl" && run.status === "uncertain"),
  );
  assert.ok(
    state.externalRuns?.some((run) => run.provider === "enrichlayer" && run.status === "skipped"),
  );
  assert.equal((await command(job.id, { ...input, idempotencyKey: key() })).status, 200);
  assert.equal(calls, 1);
  assert.equal(enrich, 0);
});

test("native enrichment: foreign-run seeds and out-of-scope extra profiles never reach transport", async (t) => {
  const { dispatchInternalNativeSourcing } = await import("../lib/sourcing-internal-dispatch");
  const { NATIVE_SOURCING_ADAPTERS } = await import("../lib/sourcing-providers");
  t.mock.method(NATIVE_SOURCING_ADAPTERS.enrichlayer, "isEnabled", () => true);
  const { scope, lease, id } = await metered({
    ...limits,
    maxCandidates: 1,
    allowExternal: true,
    providers: ["pdl", "enrichlayer"],
  });
  const url = "https://www.linkedin.com/in/fixture-scoped";
  const second = "https://www.linkedin.com/in/fixture-extra";
  let calls = 0;
  const invoke = async () => {
    calls++;
    return { profiles: [] };
  };
  const input: CostRequest = {
    provider: "enrichlayer",
    operationKey: "seed-one",
    request: { url },
  };
  await dbAdmin.insert(events).values({
    jobId: scope.jobId,
    tenantId: scope.tenantId,
    actorId: scope.actorId,
    action: "sourcing.native_discovery",
    note: JSON.stringify({
      reservationId: "another-test-run",
      operationId: randomUUID(),
      provider: "pdl",
      profiles: [{ title: "Fixture", url, snippet: "" }],
    }),
  });
  await assert.rejects(
    dispatchInternalNativeSourcing(scope, lease, input, new AbortController().signal, invoke),
    /saved discovery/,
  );
  assert.equal(calls, 0);
  await dbAdmin.insert(events).values({
    jobId: scope.jobId,
    tenantId: scope.tenantId,
    actorId: scope.actorId,
    action: "sourcing.native_discovery",
    note: JSON.stringify({
      reservationId: id,
      operationId: randomUUID(),
      provider: "pdl",
      profiles: [
        { title: "Fixture", url, snippet: "" },
        { title: "Extra", url: second, snippet: "" },
      ],
    }),
  });
  await dispatchInternalNativeSourcing(scope, lease, input, new AbortController().signal, invoke);
  assert.equal(calls, 1);
  await assert.rejects(
    dispatchInternalNativeSourcing(
      scope,
      lease,
      { ...input, operationKey: "relabelled" },
      new AbortController().signal,
      invoke,
    ),
    /relabelled/,
  );
  await assert.rejects(
    dispatchInternalNativeSourcing(
      scope,
      lease,
      { ...input, operationKey: "seed-two", request: { url: second } },
      new AbortController().signal,
      invoke,
    ),
    /candidate scope/,
  );
  assert.equal(calls, 1);
});

test("native discovery: bounded claim retains unknown actual cost and never retries", async () => {
  const { SERP_DISCOVERY_VERSION } = await import("../lib/sourcing-live-adapters");
  const catalog = livePricingCatalog as Map<string, TrustedCostBound>;
  const { scope, lease, id } = await metered({
    ...limits,
    allowExternal: true,
    providers: ["serp"],
  });
  const input = {
    operationKey: "single-discovery",
    provider: "serp" as const,
    request: { q: "site:linkedin.com/in synthetic-fixture", num: 1 },
  };
  let calls = 0;
  const invoke = async () => {
    calls++;
    return { profiles: [] };
  };
  await assert.rejects(
    dispatchNativeSourcingOperation(scope, lease, input, new AbortController().signal, invoke),
  );
  assert.equal(calls, 0);
  catalog.set(SERP_DISCOVERY_VERSION, {
    ...quote(1000),
    pricingVersion: SERP_DISCOVERY_VERSION,
  });
  try {
    const result = await dispatchNativeSourcingOperation(
      scope,
      lease,
      input,
      new AbortController().signal,
      invoke,
    );
    assert.equal(result.status, "uncertain");
    assert.equal(calls, 1);
    assert.deepEqual(result.discovery?.profiles, []);
    const state = await getSourcingControls(dbAdmin, scope);
    assert.equal(state.uncertainMicros, 1000);
    assert.equal(state.spentMicros, 0);
    assert.equal(state.costOperations[0].actualMicros, null);
    const repeated = await dispatchNativeSourcingOperation(
      scope,
      lease,
      input,
      new AbortController().signal,
      invoke,
    );
    assert.equal(repeated.status, "uncertain");
    assert.equal(calls, 1);
    await assert.rejects(
      dispatchNativeSourcingOperation(
        scope,
        lease,
        { ...input, operationKey: "different-label" },
        new AbortController().signal,
        invoke,
      ),
    );
    await assert.rejects(
      dispatchNativeSourcingOperation(
        scope,
        lease,
        { ...input, request: { ...input.request, num: 2 } },
        new AbortController().signal,
        invoke,
      ),
    );
    await assert.rejects(
      dispatchNativeSourcingOperation(
        scope,
        lease,
        { ...input, provider: "model" },
        new AbortController().signal,
        invoke,
      ),
    );
    assert.equal(calls, 1);
    assert.equal((await dbAdmin.select().from(costs).where(eq(costs.reservationId, id))).length, 1);
  } finally {
    catalog.delete(SERP_DISCOVERY_VERSION);
  }
});

test("internal discovery: absent prices allow execution, not replay or relabelling", async () => {
  const { dispatchInternalNativeSourcing } = await import("../lib/sourcing-internal-dispatch");
  const { scope, lease } = await metered({ ...limits, allowExternal: true, providers: ["serp"] });
  const input = {
    provider: "serp" as const,
    operationKey: "internal-search",
    request: { q: "site:linkedin.com/in controlled-fixture", num: 1 },
  };
  let calls = 0;
  const fake = async () => {
    calls++;
    return { profiles: [] };
  };
  const results = await Promise.all([
    dispatchInternalNativeSourcing(scope, lease, input, new AbortController().signal, fake),
    dispatchInternalNativeSourcing(scope, lease, input, new AbortController().signal, fake),
  ]);
  assert.equal(calls, 1);
  assert.ok(results.every((result) => result.costStatus === "unknown"));
  const state = await getSourcingControls(dbAdmin, scope);
  assert.equal(state.costOperations.length, 0);
  assert.equal(state.externalRuns?.[0].status, "succeeded");
  await assert.rejects(
    dispatchInternalNativeSourcing(
      scope,
      lease,
      { ...input, operationKey: "new-label" },
      new AbortController().signal,
      fake,
    ),
  );
  await assert.rejects(
    dispatchInternalNativeSourcing(
      scope,
      lease,
      { ...input, request: { ...input.request, num: 2 } },
      new AbortController().signal,
      fake,
    ),
  );
  assert.equal(calls, 1);
});

test("internal discovery: uncertain effects cannot resend, cancellation still prevents transport", async () => {
  const { dispatchInternalNativeSourcing } = await import("../lib/sourcing-internal-dispatch");
  const { scope, lease } = await metered({ ...limits, allowExternal: true, providers: ["serp"] });
  const input = {
    provider: "serp" as const,
    operationKey: "uncertain-internal-search",
    request: { q: "site:linkedin.com/in controlled-fixture", num: 1 },
  };
  let calls = 0;
  const failed = async () => {
    calls++;
    throw new Error("Synthetic transport failure");
  };
  await assert.rejects(
    dispatchInternalNativeSourcing(scope, lease, input, new AbortController().signal, failed),
  );
  const replay = await dispatchInternalNativeSourcing(
    scope,
    lease,
    input,
    new AbortController().signal,
    failed,
  );
  assert.equal(replay.costStatus, "unknown");
  assert.equal(calls, 1);
  const state = await getSourcingControls(dbAdmin, scope);
  assert.equal(state.externalRuns?.[0].status, "uncertain");
  const stopped = new AbortController();
  stopped.abort();
  await assert.rejects(dispatchInternalNativeSourcing(scope, lease, input, stopped.signal, failed));
  assert.equal(calls, 1);
});
test("operation reservations serialize per-run micro-USD caps and key identity", async () => {
  const { scope, lease } = await metered();
  const request = operation();
  const results = await Promise.all([
    prepareCostOperation(scope, lease, request, quote()),
    prepareCostOperation(scope, lease, request, quote()),
  ]);
  assert.equal(results[0].operation.id, results[1].operation.id);
  assert.equal(results.filter((r) => r.replayed).length, 1);
  await assert.rejects(
    prepareCostOperation(scope, lease, { ...request, request: { maxTokens: 21 } }, quote()),
    /different request/,
  );
  await assert.rejects(prepareCostOperation(scope, lease, operation(), quote()), /cost cap/);
});
test("settlement is exactly once; cancellation retains sub-cent billed cost", async () => {
  const { scope, lease, job, id } = await metered();
  let calls = 0;
  const request = operation();
  const adapter = {
    mode: "test" as const,
    bound: () => quote(),
    invoke: async () => {
      calls++;
      return { actualMicros: 200_001, billingEvidence: "fake-receipt-1" };
    },
  };
  const settled = await dispatchBoundedTestOperation(scope, lease, request, adapter);
  await dispatchBoundedTestOperation(scope, lease, request, adapter);
  assert.equal(calls, 1);
  assert.equal(settled.status, "settled");
  await assert.rejects(
    settleCostOperation(scope, settled.id, settled.attemptToken, 200_002, "different"),
    /Conflicting settlement/,
  );
  assert.equal(
    (
      await command(job.id, {
        action: "cancel",
        reservationId: id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  const state = await getSourcingControls(dbAdmin, scope);
  assert.equal(state.spentMicros, 200_001);
  assert.equal(state.allocatedCents, 21);
  assert.equal(state.availableCents, 129);
});
test("timeout retains uncertainty; pause/cancel/restart never resend the charged attempt", async () => {
  const { scope, lease, job, id } = await metered();
  const input = operation();
  let calls = 0;
  await assert.rejects(
    dispatchBoundedTestOperation(scope, lease, input, {
      mode: "test",
      bound: () => quote(),
      invoke: async () => {
        calls++;
        throw new Error("ambiguous connection failure");
      },
    }),
  );
  let state = await getSourcingControls(dbAdmin, scope);
  assert.equal(state.uncertainMicros, 600_000);
  await assert.rejects(prepareCostOperation(scope, lease, operation(), quote()), /uncertain/);
  await expireLease(id);
  const resumed = await acquireMeterLease(scope, id, key());
  await dispatchBoundedTestOperation(scope, resumed, input, {
    mode: "test",
    bound: () => quote(),
    invoke: async () => {
      calls++;
      return { actualMicros: 0, billingEvidence: "never" };
    },
  });
  assert.equal(calls, 1);
  assert.equal(
    (
      await command(job.id, {
        action: "cancel",
        reservationId: id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  state = await getSourcingControls(dbAdmin, scope);
  assert.equal(state.allocatedCents, 60);
  assert.equal(state.uncertainMicros, 600_000);
  const op = state.costOperations[0];
  const [raw] = await dbAdmin.select().from(costs).where(eq(costs.id, op.id));
  await settleCostOperation(scope, raw.id, raw.attemptToken, 123_456, "late-fake-receipt");
  state = await getSourcingControls(dbAdmin, scope);
  assert.equal(state.uncertainMicros, 0);
  assert.equal(state.allocatedCents, 13);
});
test("crash markers recover as uncertain; old workers are fenced", async () => {
  const { scope, lease, id } = await metered();
  const { operation: prepared } = await prepareCostOperation(scope, lease, operation(), quote());
  await beginCostDispatch(scope, lease, prepared.id);
  await expireLease(id);
  const recovered = await acquireMeterLease(scope, id, key());
  assert.equal(recovered.generation, lease.generation + 1);
  await assert.rejects(beginCostDispatch(scope, lease, prepared.id), /fenced/);
  await assert.rejects(beginCostDispatch(scope, recovered, prepared.id), /never resend/);
  assert.equal((await getSourcingControls(dbAdmin, scope)).uncertainMicros, 600_000);
});
test("never-dispatched crash recovery adopts one identity, cancellation voids it", async () => {
  const { scope, lease, job, id } = await metered();
  const input = operation();
  const prepared = await prepareCostOperation(scope, lease, input, quote());
  await expireLease(id);
  const recovered = await acquireMeterLease(scope, id, key());
  const again = await prepareCostOperation(scope, recovered, input, quote());
  assert.equal(again.operation.id, prepared.operation.id);
  assert.equal(again.operation.generation, recovered.generation);
  assert.equal(
    (
      await command(job.id, {
        action: "cancel",
        reservationId: id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  const state = await getSourcingControls(dbAdmin, scope);
  assert.equal(state.pendingMicros, 0);
  assert.equal(state.allocatedCents, 0);
  assert.equal(state.costOperations[0].status, "void");
  await assert.rejects(beginCostDispatch(scope, recovered, prepared.operation.id));
});
test("pause fences a worker, resume preserves its original runtime deadline", async () => {
  const { scope, lease, job, id } = await metered();
  assert.equal(
    (
      await command(job.id, {
        action: "pause",
        reservationId: id,
        expectedRevision: 1,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  await assert.rejects(renewMeterLease(scope, lease), /unpaused/);
  assert.equal(
    (
      await command(job.id, {
        action: "resume",
        reservationId: id,
        expectedRevision: 2,
        idempotencyKey: key(),
      })
    ).status,
    200,
  );
  const resumed = await acquireMeterLease(scope, id, key());
  assert.equal(resumed.deadline.getTime(), lease.deadline.getTime());
  await assert.rejects(renewMeterLease(scope, lease), /fenced/);
  await dbAdmin
    .update(leases)
    .set({ deadline: new Date(0) })
    .where(eq(leases.reservationId, id));
  await assert.rejects(prepareCostOperation(scope, resumed, operation(), quote()), /runtime/);
});
test("candidate stops, expired quotes and live authority are checked again before dispatch", async () => {
  const { scope, lease, job } = await metered({ ...limits, maxCandidates: 1 });
  const first = await prepareCostOperation(
    scope,
    lease,
    operation(key(), "fixture-candidate-a"),
    quote(10),
  );
  await assert.rejects(
    prepareCostOperation(scope, lease, operation(key(), "fixture-candidate-b"), quote(10)),
    /Candidate/,
  );
  await dbAdmin
    .update(costs)
    .set({ quoteExpiresAt: new Date(0) })
    .where(eq(costs.id, first.operation.id));
  await assert.rejects(beginCostDispatch(scope, lease, first.operation.id), /Pricing expired/);
  await dbAdmin
    .update(jobsTable)
    .set({ title: "Changed before dispatch" })
    .where(eq(jobsTable.id, job.id));
  await assert.rejects(beginCostDispatch(scope, lease, first.operation.id), /stale/);
});
test("revoked actor authority stops operations; abnormal over-quote receipts retain cost", async () => {
  const { scope, lease } = await metered();
  const prepared = await prepareCostOperation(scope, lease, operation(), quote());
  await beginCostDispatch(scope, lease, prepared.operation.id);
  const abnormal = await settleCostOperation(
    scope,
    prepared.operation.id,
    prepared.operation.attemptToken,
    700_000,
    "fake-abnormal-receipt",
  );
  assert.equal(abnormal.status, "uncertain");
  assert.equal((await getSourcingControls(dbAdmin, scope)).uncertainMicros, 700_000);
  await dbAdmin
    .update(usersTable)
    .set({ status: "suspended" })
    .where(eq(usersTable.id, scope.actorId));
  try {
    await assert.rejects(prepareCostOperation(scope, lease, operation(), quote()), /authority/);
  } finally {
    await dbAdmin
      .update(usersTable)
      .set({ status: "active" })
      .where(eq(usersTable.id, scope.actorId));
  }
});
test("foreign worker scopes cannot access or settle metered operations", async () => {
  const { scope, lease } = await metered();
  const prepared = await prepareCostOperation(scope, lease, operation(), quote());
  const foreignScope = { ...scope, tenantId: foreign, actorId: actorId("foreign") };
  await assert.rejects(beginCostDispatch(foreignScope, lease, prepared.operation.id), /Not found/);
  await assert.rejects(
    settleCostOperation(
      foreignScope,
      prepared.operation.id,
      prepared.operation.attemptToken,
      0,
      "foreign",
    ),
    /Not found/,
  );
  assert.equal((await getSourcingControls(dbAdmin, scope)).pendingMicros, 600_000);
});
test("meter lease claim is exclusive and deadlines do not reset after expiration", async () => {
  const job = await configured(),
    held = await reserve(job),
    scope = scopeOf(job);
  const claims = await Promise.allSettled([
    acquireMeterLease(scope, held.body.id, key()),
    acquireMeterLease(scope, held.body.id, key()),
  ]);
  assert.equal(claims.filter((r) => r.status === "fulfilled").length, 1);
  await expireLease(held.body.id);
  await dbAdmin
    .update(leases)
    .set({ deadline: new Date(0) })
    .where(eq(leases.reservationId, held.body.id));
  await assert.rejects(acquireMeterLease(scope, held.body.id, key()), /never resets/);
});
test("expiry interrupts an ignoring test adapter and retains uncertainty", async () => {
  const { scope, lease, id } = await metered();
  await dbAdmin
    .update(leases)
    .set({ leaseUntil: new Date(Date.now() + 600) })
    .where(eq(leases.reservationId, id));
  await assert.rejects(
    dispatchBoundedTestOperation(scope, lease, operation(), {
      mode: "test",
      bound: () => quote(),
      invoke: async () => new Promise<never>(() => {}),
    }),
  );
  assert.equal((await getSourcingControls(dbAdmin, scope)).uncertainMicros, 600_000);
});
test("new meter tables enforce tenant RLS and parent scope", async () => {
  const { scope, lease, id } = await metered();
  await prepareCostOperation(scope, lease, operation(), quote());
  const conn = await pool.connect();
  try {
    await conn.query("BEGIN");
    await conn.query("SET LOCAL ROLE lexy_app");
    await conn.query(
      "SELECT set_config('app.allowed_tenant_ids',$1,true), set_config('app.is_platform_admin','false',true)",
      [foreign],
    );
    for (const table of ["sourcing_cost_operations", "sourcing_execution_leases"])
      assert.equal(
        (await conn.query(`SELECT * FROM ${table} WHERE reservation_id=$1`, [id])).rowCount,
        0,
      );
    // Even a row with an allowed tenant cannot be linked to another tenant's hold.
    await assert.rejects(
      conn.query(
        `INSERT INTO sourcing_cost_operations
      (id,reservation_id,tenant_id,job_id,operation_key,request_hash,provider,
       pricing_version,quote_expires_at,evidence,upper_micros,status,generation,attempt_token)
      VALUES ($1,$2,$3,$4,'foreign-op','foreign-hash','model','fake',now(),'fake',1,'prepared',1,$1)`,
        [key(), id, foreign, scope.jobId],
      ),
      /foreign key/,
    );
  } finally {
    await conn.query("ROLLBACK");
    conn.release();
  }
});
