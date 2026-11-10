import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import * as tables from "@workspace/db";
import { createTransactionalDb } from "../test-fixtures/transactional-db";

let fixture: Awaited<ReturnType<typeof createTransactionalDb>>;
let resolve: typeof import("./workflow-profile-screening").workflowScreeningApplication;
let move: typeof import("./change-candidate-stage").changeCandidateStage;
const owner = randomUUID();
const agency = randomUUID();
const jobId = randomUUID();
const candidateId = randomUUID();
before(async () => {
  fixture = await createTransactionalDb([
    tables.tenantsTable,
    tables.jobsTable,
    tables.candidatesTable,
    tables.applicationsTable,
    tables.sourcedCandidatesTable,
    tables.candidateEventsTable,
    tables.auditLogsTable,
  ]);
  resolve = (await import("./workflow-profile-screening")).workflowScreeningApplication;
  move = (await import("./change-candidate-stage")).changeCandidateStage;
  await fixture.db
    .insert(tables.tenantsTable)
    .values([owner, agency].map((id) => ({ id, name: "Synthetic stage owner", slug: id })));
  await fixture.db.insert(tables.jobsTable).values({
    id: jobId,
    tenantId: owner,
    title: "Synthetic SQL engineer",
    description: "Isolated regression fixture.",
    status: "active",
  });
  await fixture.db.insert(tables.candidatesTable).values({
    id: candidateId,
    tenantId: agency,
    firstName: "Synthetic",
    lastName: "Stage",
    email: `${candidateId}@example.invalid`,
  });
});
after(async () => fixture?.close());

test("job-authorized dual-tenant application and source move atomically with one audit event", async () => {
  const id = randomUUID();
  await fixture.db.insert(tables.applicationsTable).values({
    id,
    tenantId: agency,
    candidateId,
    jobId,
    stage: "sourced",
  });
  const [source] = await fixture.db
    .insert(tables.sourcedCandidatesTable)
    .values({
      tenantId: owner,
      source: "internal",
      normalizedCandidateId: candidateId,
      rawData: { jobId, stage: "sourced" },
    })
    .returning();
  assert.equal(await resolve(owner, jobId, candidateId), id);
  assert.equal(await resolve(agency, jobId, candidateId), undefined);
  assert.equal(await resolve(owner, jobId, randomUUID()), undefined);
  const result = await move({
    tenantId: owner,
    jobId,
    candidateId,
    applicationId: id,
    sourcedId: source.id,
    to: "screening",
    actor: { type: "agent", label: "Screening Agent" },
    source: "agent_orchestrator",
    sourcedRawDataPatch: {
      screeningScore: 85,
      screeningResult: { score: 85, recommendation: "advance" },
    },
  });
  assert.equal(result.changed, true);
  const [application] = await fixture.db
    .select()
    .from(tables.applicationsTable)
    .where(eq(tables.applicationsTable.id, id));
  const [saved] = await fixture.db
    .select()
    .from(tables.sourcedCandidatesTable)
    .where(eq(tables.sourcedCandidatesTable.id, source.id));
  assert.equal(application.stage, "screening");
  assert.equal((saved.rawData as any).stage, "screening");
  assert.equal((saved.rawData as any).screeningScore, 85);
  assert.equal((await fixture.db.select().from(tables.candidateEventsTable)).length, 1);
  assert.equal((await fixture.db.select().from(tables.auditLogsTable)).length, 1);
  await move({
    tenantId: owner,
    jobId,
    candidateId,
    applicationId: id,
    to: "interview",
    actor: { type: "agent", label: "Synthetic test setup" },
  });
  assert.equal(await resolve(owner, jobId, candidateId), undefined);
});

test("ambiguous duplicate applications are not arbitrarily advanced", async () => {
  await fixture.db.insert(tables.applicationsTable).values({
    tenantId: owner,
    jobId,
    candidateId,
    stage: "sourced",
  });
  assert.equal(await resolve(owner, jobId, candidateId), undefined);
});
