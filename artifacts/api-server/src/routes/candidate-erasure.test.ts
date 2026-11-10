import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { jsonObjectSchema, readJsonObject } from "../test-utils/json-response";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Server } from "node:http";
import express from "express";
import ts from "typescript";
import * as tables from "@workspace/db";
import * as orm from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { issueToken, getAuthUserId } from "../lib/auth-token";
import { resolveCandidateId } from "../lib/portal-auth";
import { resolveUser, requireRole } from "../middlewares/resolveUser";
import { withTenantContext } from "../middlewares/withTenantContext";
import { rejectErasedAccount } from "../middlewares/rejectErasedAccount";
import { getAllowedTenantIds } from "../lib/tenantUtils";
import {
  CANDIDATE_LINKED_TABLES,
  RETAINED_CANDIDATE_TABLES,
  purgeCandidateLinkedData,
  collectCandidateRecordingPaths,
  purgeCandidateRecordings,
} from "../lib/candidate-erasure";
import {
  stageErasureCleanup,
  processErasureCleanup,
  serializeErasureRequest,
  latestCandidateCleanup,
} from "../lib/erasure-cleanup";

const { dbAdmin } = tables;
const prefix = `erasure_${randomUUID().slice(0, 8)}`;
const id = (name: string) => `${prefix}_${name}`;
const tenantIds = [id("tenant"), id("foreign")];
const names = ["self", "staff", "admin", "rollback", "peer", "foreign"] as const;
const candidateIds = names.map(id);
const userIds = [...names.map((name) => id(`${name}_user`)), id("recruiter"), id("platform")];
const jobIds = tenantIds.map((_, i) => id(`job_${i}`));
const sessionIds = names.map(() => randomUUID());
const storageCalls: string[] = [];
let failCascade = false;
let fixturesReady = false;
let server: Server;
let baseUrl: string;
const notifications: unknown[] = [];
const audits: any[] = [];

const fakeStorage = {
  async deleteObjectByPath(path: string) {
    storageCalls.push(path);
    return { ok: false, error: "fixture_storage_unavailable" };
  },
  async deleteObjectsUnderPrefix(path: string) {
    storageCalls.push(path);
    return { deleted: 0, error: "fixture_storage_unavailable" };
  },
};

// Execute the actual current controllers over disposable DB rows. Substitute
// only infrastructure side effects; never contact AWS or send a real email.
function controller(fileName: string, method: string, path: string, helperNames: string[] = []) {
  const file = new URL(fileName, import.meta.url);
  const source = ts.createSourceFile(
    file.pathname,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let handler: ts.Node | undefined;
  const helpers: ts.Node[] = [];
  function visit(node: ts.Node) {
    if (ts.isFunctionDeclaration(node) && node.name && helperNames.includes(node.name.text))
      helpers.push(node);
    if (
      ts.isCallExpression(node) &&
      node.expression.getText(source) === `router.${method}` &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[0].text === path
    )
      handler = node.arguments.at(-1);
    ts.forEachChild(node, visit);
  }
  visit(source);
  assert.ok(handler, `${method} ${path} must exist`);
  assert.equal(helpers.length, helperNames.length);
  const printer = ts.createPrinter();
  const compiled = ts.transpileModule(
    helpers.map((node) => printer.printNode(ts.EmitHint.Unspecified, node, source)).join("\n") +
      `\nexport const handler = ${printer.printNode(ts.EmitHint.Unspecified, handler, source)};`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } },
  ).outputText;
  const output: { handler?: express.RequestHandler } = {};
  runInNewContext(compiled, {
    exports: output,
    ...tables,
    ...orm,
    db: dbAdmin,
    controlDb: dbAdmin,
    getAuthUserId,
    getAllowedTenantIds,
    getCandidateId: resolveCandidateId,
    CANDIDATE_LINKED_TABLES,
    purgeCandidateLinkedData: guardedPurge,
    collectCandidateRecordingPaths,
    stageErasureCleanup: (tx: any, input: Parameters<typeof stageErasureCleanup>[1]) =>
      stageErasureCleanup(tx, { ...input, origin: "fixture" }),
    processErasureCleanup: (requestId: string) =>
      processErasureCleanup(requestId, {
        storage: fakeStorage,
        sendConfirmation: async (event) => {
          notifications.push(event);
          return true;
        },
      }),
    serializeErasureRequest,
    latestCandidateCleanup,
    purgeCandidateRecordings: (candidate: string, paths: string[]) =>
      purgeCandidateRecordings(candidate, paths, fakeStorage),
    logger: { info() {}, error() {}, warn() {} },
    recordAudit: async (event: any) => {
      audits.push(event);
    },
    require(module: string) {
      if (module === "@workspace/db") return tables;
      if (module === "drizzle-orm") return orm;
      if (module.endsWith("erasure-cleanup"))
        return {
          stageErasureCleanup: (tx: any, input: Parameters<typeof stageErasureCleanup>[1]) =>
            stageErasureCleanup(tx, { ...input, origin: "fixture" }),
          processErasureCleanup: (requestId: string) =>
            processErasureCleanup(requestId, {
              storage: fakeStorage,
              sendConfirmation: async (event) => {
                notifications.push(event);
                return true;
              },
            }),
          serializeErasureRequest,
          latestCandidateCleanup,
        };
      if (module.endsWith("candidate-erasure"))
        return {
          purgeCandidateLinkedData: guardedPurge,
          collectCandidateRecordingPaths,
          purgeCandidateRecordings: (candidate: string, paths: string[]) =>
            purgeCandidateRecordings(candidate, paths, fakeStorage),
        };
      if (module.endsWith("decision-enforcement.js")) return { applyHumanDecision: async () => {} };
      if (module.endsWith("objectStorage"))
        return {
          ObjectStorageService: class {
            deleteObjectByPath = fakeStorage.deleteObjectByPath;
            deleteObjectsUnderPrefix = fakeStorage.deleteObjectsUnderPrefix;
          },
        };
      if (module.endsWith("deletion-emails.js"))
        return {
          sendDeletionFulfilledConfirmationToCandidate: async (event: unknown) => {
            notifications.push(event);
          },
        };
      throw new Error(`Unexpected controller dependency: ${module}`);
    },
  });
  return output.handler!;
}

async function guardedPurge(
  tx: any,
  candidate: string,
  options?: { retainApplications?: boolean },
) {
  if (!failCascade) return purgeCandidateLinkedData(tx, candidate, options);
  let calls = 0;
  return purgeCandidateLinkedData(
    {
      execute: async (query) => {
        if (++calls === 10) throw new Error("Injected erasure failure");
        return tx.execute(query);
      },
    },
    candidate,
    options,
  );
}

before(async () => {
  await dbAdmin.transaction(async (tx) => {
    await tx.insert(tables.tenantsTable).values(
      tenantIds.map((tenant) => ({
        id: tenant,
        name: "Disposable erasure fixture",
        slug: tenant,
        plan: "enterprise" as const,
      })),
    );
    await tx.insert(tables.usersTable).values(
      userIds.map((user, i) => ({
        id: user,
        tenantId: tenantIds[i === 5 ? 1 : 0]!,
        email: `${user}@example.invalid`,
        name: "Disposable fixture",
        passwordHash: "not-a-login",
        role: (i === 6 ? "recruiter" : i === 7 ? "platform_admin" : "candidate") as
          | "candidate"
          | "recruiter"
          | "platform_admin",
      })),
    );
    await tx.insert(tables.candidatesTable).values(
      candidateIds.map((candidate, i) => ({
        id: candidate,
        tenantId: tenantIds[i === 5 ? 1 : 0]!,
        userId: userIds[i],
        firstName: "Disposable",
        lastName: "Fixture",
        email: `${candidate}@example.invalid`,
        verificationResult: { private: "fixture" },
        sponsorshipNotes: "Private fixture",
        currentEmployerDomain: "example.invalid",
        timezone: "Asia/Calcutta",
      })),
    );
    await tx.insert(tables.jobsTable).values(
      jobIds.map((job, i) => ({
        id: job,
        tenantId: tenantIds[i]!,
        title: "Disposable fixture",
        description: "No live recruiting",
      })),
    );
    for (const [i, candidate] of candidateIds.entries()) {
      const tenant = tenantIds[i === 5 ? 1 : 0]!;
      const job = jobIds[i === 5 ? 1 : 0]!;
      await tx.insert(tables.applicationsTable).values({
        id: `${candidate}_app`,
        tenantId: tenant,
        candidateId: candidate,
        jobId: job,
        stage: i === 0 ? "hired" : "applied",
        notes: "Private fixture note",
      });
      await tx.insert(tables.interviewSessionsTable).values({
        id: sessionIds[i]!,
        tenantId: tenant,
        candidateId: candidate,
        applicationId: `${candidate}_app`,
        planId: `${candidate}_plan`,
        answers: [{ private: "fixture speech" }],
        recordingUrl: `/objects/fixture-${candidate}.webm`,
      });
      await tx.insert(tables.interviewSummariesTable).values({
        interviewSessionId: sessionIds[i]!,
        overallScore: 50,
        recruiterSummary: "Private fixture summary",
        transcript: [{ private: "fixture transcript" }],
      });
      await tx.insert(tables.interviewSchedulesTable).values({
        id: `${candidate}_schedule`,
        tenantId: tenant,
        applicationId: `${candidate}_app`,
        scheduledAt: new Date(),
        type: "human",
        notes: "Private fixture schedule",
      });
      await tx.execute(orm.sql`INSERT INTO candidate_learning_profiles(id,candidate_id,tenant_id)
        VALUES (${`${candidate}_learning`},${candidate},${tenant})`);
      await tx.execute(orm.sql`INSERT INTO candidate_evaluations(candidate_id,tenant_id,job_id,ai_content)
        VALUES (${candidate},${tenant},${job},${JSON.stringify({ private: "fixture evaluation" })}::jsonb)`);
      await tx.execute(orm.sql`INSERT INTO sourced_candidates(id,tenant_id,source,normalized_candidate_id,raw_data)
        VALUES (${`${candidate}_source`},${tenant},'github',${candidate},${JSON.stringify({ email: `${candidate}@example.invalid` })}::jsonb)`);
      await tx.insert(tables.recruitingJourneysTable).values({
        id: `${candidate}_journey`,
        tenantId: tenant,
        jobId: job,
        briefHash: "fixture",
        brief: {},
        version: i + 1,
        interviewPath: "human",
        steps: [],
        createdById: userIds[6]!,
      });
      await tx.insert(tables.recruitingWorkflowsTable).values({
        id: `${candidate}_workflow`,
        tenantId: tenant,
        jobId: job,
        candidateId: candidate,
        journeyId: `${candidate}_journey`,
        journeyVersion: i + 1,
        interviewPath: "human",
        steps: [],
        createdById: userIds[6]!,
      });
      await tx.insert(tables.recruitingWorkflowEventsTable).values({
        id: `${candidate}_event`,
        tenantId: tenant,
        jobId: job,
        workflowId: `${candidate}_workflow`,
        journeyId: `${candidate}_journey`,
        action: "fixture",
        actorId: userIds[6]!,
        note: "Private fixture event",
      });
    }
    await tx.insert(tables.deletionRequestsTable).values({
      id: id("request"),
      candidateId: candidateIds[2]!,
      jurisdiction: "gdpr",
      candidateEmailSnapshot: `${candidateIds[2]}@example.invalid`,
    });
  });
  fixturesReady = true;
  const app = express();
  app.use(express.json(), rejectErasedAccount, withTenantContext);
  app.delete("/portal/me", controller("./career-profile.ts", "delete", "/portal/me"));
  app.delete(
    "/dnc/:candidateId/data",
    controller("./dnc.ts", "delete", "/dnc/:candidateId/data", ["getCallerUser"]),
  );
  app.post(
    "/admin/deletion-requests/:id/fulfil",
    resolveUser,
    requireRole("platform_admin"),
    controller("./admin-deletion.ts", "post", "/admin/deletion-requests/:id/fulfil", [
      "collectCandidateObjectPaths",
    ]),
  );
  app.post(
    "/admin/deletion-requests/:id/retry-cleanup",
    resolveUser,
    requireRole("platform_admin"),
    controller("./admin-deletion.ts", "post", "/admin/deletion-requests/:id/retry-cleanup", []),
  );
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!fixturesReady) return;
  // Every predicate is tied to the fixture inventory, never broad tenant cleanup.
  await dbAdmin.transaction(async (tx) => {
    for (const candidate of candidateIds) {
      await purgeCandidateLinkedData(tx, candidate);
      await tx.delete(tables.candidatesTable).where(orm.eq(tables.candidatesTable.id, candidate));
      await tx
        .delete(tables.recruitingJourneysTable)
        .where(orm.eq(tables.recruitingJourneysTable.id, `${candidate}_journey`));
    }
    await tx
      .delete(tables.deletionRequestsTable)
      .where(orm.inArray(tables.deletionRequestsTable.candidateId, Object.values(candidateIds)));
    await tx.delete(tables.jobsTable).where(orm.inArray(tables.jobsTable.id, jobIds));
    await tx.delete(tables.usersTable).where(orm.inArray(tables.usersTable.id, userIds));
    await tx.delete(tables.tenantsTable).where(orm.inArray(tables.tenantsTable.id, tenantIds));
  });
});

async function request(path: string, method: string, userIndex?: number) {
  const token =
    userIndex === undefined
      ? undefined
      : issueToken({
          userId: userIds[userIndex]!,
          tenantId: tenantIds[userIndex === 5 ? 1 : 0]!,
          role: userIndex === 6 ? "recruiter" : userIndex === 7 ? "platform_admin" : "candidate",
        });
  const result = await fetch(`${baseUrl}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(method === "POST" ? { body: "{}" } : {}),
  });
  return { status: result.status, body: await readJsonObject(result) };
}

async function assertPurged(candidate: string, retainApplications: boolean) {
  for (const table of CANDIDATE_LINKED_TABLES) {
    const result = await dbAdmin.execute(
      orm.sql`SELECT count(*)::int AS n FROM ${orm.sql.identifier(table)} WHERE candidate_id=${candidate}`,
    );
    assert.equal(result.rows[0]!.n, table === "applications" && retainApplications ? 1 : 0, table);
  }
  const sessions = await dbAdmin.execute(orm.sql`SELECT count(*)::int AS n FROM interview_summaries
    WHERE interview_session_id=${sessionIds[candidateIds.indexOf(candidate)]}`);
  assert.equal(sessions.rows[0]!.n, 0);
  const schedules = await dbAdmin.execute(
    orm.sql`SELECT count(*)::int AS n FROM interview_schedules WHERE application_id=${`${candidate}_app`}`,
  );
  assert.equal(schedules.rows[0]!.n, 0);
  const sources = await dbAdmin.execute(
    orm.sql`SELECT count(*)::int AS n FROM sourced_candidates WHERE normalized_candidate_id=${candidate}`,
  );
  assert.equal(sources.rows[0]!.n, 0);
  const events = await dbAdmin.execute(
    orm.sql`SELECT count(*)::int AS n FROM recruiting_workflow_events WHERE workflow_id=${`${candidate}_workflow`}`,
  );
  assert.equal(events.rows[0]!.n, 0);
  for (const peer of candidateIds.slice(4)) {
    const [row] = await dbAdmin
      .select()
      .from(tables.candidatesTable)
      .where(orm.eq(tables.candidatesTable.id, peer));
    assert.equal(row!.firstName, "Disposable");
    assert.equal(row!.dataErasedAt, null);
    const learning = await dbAdmin.execute(
      orm.sql`SELECT count(*)::int AS n FROM candidate_learning_profiles WHERE candidate_id=${peer}`,
    );
    assert.equal(learning.rows[0]!.n, 1);
  }
}

test("anonymous, candidate-role staff calls and foreign-tenant erasure are refused", async () => {
  assert.equal(
    (await request(`/admin/deletion-requests/${id("request")}/retry-cleanup`, "POST")).status,
    401,
  );
  assert.equal(
    (await request(`/admin/deletion-requests/${id("request")}/retry-cleanup`, "POST", 0)).status,
    403,
  );
  assert.equal(
    (await request(`/admin/deletion-requests/${id("missing")}/retry-cleanup`, "POST", 7)).status,
    404,
  );
  assert.equal((await request("/portal/me", "DELETE")).status, 401);
  assert.equal((await request(`/dnc/${candidateIds[1]}/data`, "DELETE", 0)).status, 403);
  assert.equal((await request(`/dnc/${candidateIds[5]}/data`, "DELETE", 6)).status, 404);
  assert.equal(
    (await request(`/admin/deletion-requests/${id("request")}/fulfil`, "POST", 0)).status,
    403,
  );
});

test("self erasure removes private learning, interviews, evaluations, source and workflow copies but not peers", async () => {
  const result = await request("/portal/me", "DELETE", 0);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await assertPurged(candidateIds[0]!, true);
  const [row] = await dbAdmin
    .select()
    .from(tables.candidatesTable)
    .where(orm.eq(tables.candidatesTable.id, candidateIds[0]!));
  assert.ok(row!.dataErasedAt);
  assert.equal(row!.verificationResult, null);
  assert.equal(row!.sponsorshipNotes, null);
  assert.equal(row!.currentEmployerDomain, null);
  assert.equal(row!.timezone, null);
  assert.equal(row!.doNotContact, true);
  const [closed] = await dbAdmin
    .select()
    .from(tables.applicationsTable)
    .where(orm.eq(tables.applicationsTable.id, `${candidateIds[0]}_app`));
  assert.equal(closed!.stage, "hired", "erasing a profile must not undo a historical hire");
  assert.equal(closed!.notes, "Candidate self-erased per GDPR request.");
  assert.equal(result.body.cleanupPending, true);
  const purge = jsonObjectSchema.parse(result.body.purge);
  assert.equal(jsonObjectSchema.parse(purge.recordings).cleanupPending, true);
  assert.ok(storageCalls.includes(`recording-segments/${sessionIds[0]}/`));
  assert.equal(
    (await request("/portal/me", "DELETE", 0)).status,
    401,
    "erased identity cannot reuse its previous session",
  );
});

test("authorised staff erasure uses the same complete cascade", async () => {
  const result = await request(`/dnc/${candidateIds[1]}/data`, "DELETE", 6);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.cleanupPending, true);
  await assertPurged(candidateIds[1]!, true);
  assert.ok(storageCalls.includes(`recording-segments/${sessionIds[1]}/`));
});

test("admin hard erasure removes the candidate and FK-linked workflow events", async () => {
  const result = await request(`/admin/deletion-requests/${id("request")}/fulfil`, "POST", 7);
  assert.equal(result.status, 200, JSON.stringify(result.body));
  await assertPurged(candidateIds[2]!, false);
  assert.equal(result.body.cleanupPending, true);
  assert.equal(notifications.length, 0, "no complete-deletion email while storage failed");
  assert.equal(
    (
      await dbAdmin
        .select()
        .from(tables.candidatesTable)
        .where(orm.eq(tables.candidatesTable.id, candidateIds[2]!))
    ).length,
    0,
  );
  assert.ok(audits.some((event) => event.action === "candidate.database_erased"));
  const retry = await request(`/admin/deletion-requests/${id("request")}/retry-cleanup`, "POST", 7);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.cleanupPending, true);
  assert.equal(
    (await request(`/admin/deletion-requests/${id("request")}/fulfil`, "POST", 7)).status,
    409,
  );
});

test("a mid-cascade failure rolls back anonymisation and child deletes without storage calls", async () => {
  const previousStorageCalls = storageCalls.length;
  failCascade = true;
  let result;
  try {
    result = await request("/portal/me", "DELETE", 3);
  } finally {
    failCascade = false;
  }
  assert.equal(result.status, 500);
  assert.equal(result.body.detail, undefined);
  assert.equal(storageCalls.length, previousStorageCalls);
  const [row] = await dbAdmin
    .select()
    .from(tables.candidatesTable)
    .where(orm.eq(tables.candidatesTable.id, candidateIds[3]!));
  assert.equal(row!.firstName, "Disposable");
  assert.equal(row!.dataErasedAt, null);
  const sessions = await dbAdmin
    .select()
    .from(tables.interviewSessionsTable)
    .where(orm.eq(tables.interviewSessionsTable.id, sessionIds[3]!));
  assert.equal(sessions.length, 1);
  const profiles = await dbAdmin.execute(
    orm.sql`SELECT count(*)::int AS n FROM candidate_learning_profiles WHERE candidate_id=${candidateIds[3]}`,
  );
  assert.equal(profiles.rows[0]!.n, 1);
});

test("decision and fee history survives the cascade; immutable fixtures are rolled back, never committed", async () => {
  const rollback = new Error("fixture rollback");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      const candidate = candidateIds[3]!;
      await tx.insert(tables.decisionEventsTable).values({
        id: id("decision"),
        tenantId: tenantIds[0]!,
        candidateId: candidate,
        eventType: "fixture",
        actorKind: "human",
      });
      await tx.insert(tables.feeLineItemsTable).values({
        id: id("fee"),
        tenantId: tenantIds[0]!,
        candidateId: candidate,
        applicationId: `${candidate}_app`,
        jobId: jobIds[0]!,
        itemType: "per_hire",
        amount: 0,
        currency: "USD",
        planCode: "enterprise",
        originChannel: "linx",
        evidence: { fixture: true },
      });
      await purgeCandidateLinkedData(tx, candidate);
      for (const table of ["decision_events", "fee_line_items"]) {
        const result = await tx.execute(
          orm.sql`SELECT count(*)::int AS n FROM ${orm.sql.identifier(table)} WHERE candidate_id=${candidate}`,
        );
        assert.equal(result.rows[0]!.n, 1, table);
      }
      throw rollback;
    }),
    (err) => err === rollback,
  );
  assert.equal(
    CANDIDATE_LINKED_TABLES.some((table) =>
      (RETAINED_CANDIDATE_TABLES as readonly string[]).includes(table),
    ),
    false,
  );
});

test("the application database role can erase the authorised subject without deleting a same-tenant peer", async () => {
  const rollback = new Error("app-role fixture rollback");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      await tx.execute(orm.sql`SET LOCAL ROLE lexy_app`);
      await tx.execute(orm.sql`SELECT set_config('app.current_tenant_id', ${tenantIds[0]}, true),
      set_config('app.allowed_tenant_ids', ${tenantIds[0]}, true),
      set_config('app.is_platform_admin', 'false', true)`);
      const paths = await collectCandidateRecordingPaths(tx, candidateIds[3]!);
      assert.ok(paths.includes(`/objects/fixture-${candidateIds[3]}.webm`));
      await purgeCandidateLinkedData(tx, candidateIds[3]!, { retainApplications: true });
      for (const table of CANDIDATE_LINKED_TABLES.filter((name) => name !== "applications")) {
        const result = await tx.execute(
          orm.sql`SELECT count(*)::int AS n FROM ${orm.sql.identifier(table)} WHERE candidate_id=${candidateIds[3]}`,
        );
        assert.equal(result.rows[0]!.n, 0, table);
      }
      // Verify physical peer survival as the fixture administrator, rather than
      // mistaking owner-RLS invisibility for deletion.
      await tx.execute(orm.sql`RESET ROLE`);
      const peer = await tx.execute(
        orm.sql`SELECT count(*)::int AS n FROM candidate_learning_profiles WHERE candidate_id=${candidateIds[4]}`,
      );
      assert.equal(peer.rows[0]!.n, 1);
      throw rollback;
    }),
    (err) => err === rollback,
  );
});

test("media snapshots retain canonical résumé, share and avatar references before their rows disappear", async () => {
  const paths = await collectCandidateRecordingPaths(
    {
      async execute(query) {
        const compiled = new PgDialect().sqlToQuery(query);
        if (compiled.sql === "SET LOCAL ROLE NONE") return { rows: [] };
        assert.ok(
          compiled.params.includes("fixture-owner"),
          "every snapshot query must bind its owner",
        );
        if (compiled.sql.includes("FOR UPDATE"))
          return { rows: [{ resume_url: "/objects/fixture-resume.docx" }] };
        if (compiled.sql.includes("hiring_manager_shares"))
          return { rows: [{ object_path: "/objects/fixture-share.docx" }] };
        if (compiled.sql.includes("recruiter_avatar_video_jobs"))
          return { rows: [{ object_path: "/objects/fixture-intro.mp4" }] };
        return { rows: [] };
      },
    },
    "fixture-owner",
  );
  assert.deepEqual(paths, [
    "/objects/fixture-resume.docx",
    "/objects/fixture-share.docx",
    "/objects/fixture-intro.mp4",
  ]);
});

test("recording cleanup reports unsupported paths and failures, and continues to sweep checkpoint prefixes", async () => {
  const calls: string[] = [];
  const result = await purgeCandidateRecordings(
    "fixture-only",
    [
      "/objects/a.webm",
      "/objects/recording-segments/fixture/",
      "https://example.invalid/no-delete",
    ],
    {
      async deleteObjectByPath(path) {
        calls.push(path);
        throw new Error("fixture");
      },
      async deleteObjectsUnderPrefix(path) {
        calls.push(path);
        return { deleted: 0, error: "fixture" };
      },
    },
  );
  assert.equal(result.cleanupPending, true);
  assert.equal(result.failed, 4);
  assert.deepEqual(calls, [
    "/objects/a.webm",
    "recording-segments/fixture/",
    "interview-recordings/fixture-only",
  ]);
});
