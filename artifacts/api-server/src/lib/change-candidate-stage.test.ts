/**
 * change-candidate-stage.test.ts — proves the choke-point's atomic contract.
 *
 * Ticket 4d requires that a canonical stage move writes FOUR things as a unit:
 *   1. applications.stage
 *   2. the sourced_candidates rawData.stage mirror
 *   3. a candidate_events STAGE_CHANGED row (truthful from→to + actor)
 *   4. a thin-pointer audit_logs row referencing that event
 * All four commit, or none do. These tests pin that contract against a live DB:
 *   - happy path: all four land, synchronized, with correct attribution + pointer
 *   - forced failure AFTER both stage writes: EVERY write rolls back, so the two
 *     stage values can never be left disagreeing (the whole point of consolidation)
 *   - a same-stage call is a no-op: patches apply, but no transition trail is written
 *
 * The forced failure is injected with a non-serializable (circular) metadata
 * payload: the stage columns are written first inside the transaction, then the
 * candidate_events insert throws while serializing jsonb — exercising rollback of
 * writes that already succeeded earlier in the same transaction. No mocking.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";
import {
  db,
  applicationsTable,
  sourcedCandidatesTable,
  candidateEventsTable,
  auditLogsTable,
} from "@workspace/db";
import { changeCandidateStage } from "./change-candidate-stage.js";

interface Seed {
  tenantId: string;
  jobId: string;
  candidateId: string;
  applicationId: string;
  sourcedId: string;
}

async function seed(): Promise<Seed> {
  const tenantId = `t_4dtest_${crypto.randomUUID()}`;
  const jobId = `job_${crypto.randomUUID()}`;
  const candidateId = `cand_${crypto.randomUUID()}`;

  const [app] = await db.insert(applicationsTable).values({
    tenantId,
    jobId,
    candidateId,
    stage: "applied",
  }).returning({ id: applicationsTable.id });

  const [sc] = await db.insert(sourcedCandidatesTable).values({
    tenantId,
    source: "internal",
    normalizedCandidateId: candidateId,
    rawData: { stage: "applied", jobId },
  }).returning({ id: sourcedCandidatesTable.id });

  return { tenantId, jobId, candidateId, applicationId: app.id, sourcedId: sc.id };
}

async function cleanup(tenantId: string): Promise<void> {
  await db.delete(auditLogsTable).where(eq(auditLogsTable.tenantId, tenantId)).catch(() => {});
  await db.delete(candidateEventsTable).where(eq(candidateEventsTable.tenantId, tenantId)).catch(() => {});
  await db.delete(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.tenantId, tenantId)).catch(() => {});
  await db.delete(applicationsTable).where(eq(applicationsTable.tenantId, tenantId)).catch(() => {});
}

test("happy path — stage + sourced mirror + STAGE_CHANGED + audit pointer all land synchronized", async () => {
  const s = await seed();
  try {
    const result = await changeCandidateStage({
      tenantId: s.tenantId,
      candidateId: s.candidateId,
      jobId: s.jobId,
      to: "screening",
      actor: { type: "user", role: "recruiter", id: "user_test_123" },
      source: "recruiter_action",
      applicationId: s.applicationId,
      sourcedId: s.sourcedId,
      sourcedRawDataPatch: { jobId: s.jobId },
    });

    assert.equal(result.changed, true, "a real transition must report changed=true");
    assert.equal(result.from, "applied");
    assert.equal(result.to, "screening");
    assert.ok(result.eventId, "a changed move must return the candidate_events eventId");

    // 1. applications.stage
    const [app] = await db.select({ stage: applicationsTable.stage })
      .from(applicationsTable).where(eq(applicationsTable.id, s.applicationId)).limit(1);
    assert.equal(app.stage, "screening", "applications.stage must be updated");

    // 2. sourced mirror — same value, never desynced
    const [sc] = await db.select({ rawData: sourcedCandidatesTable.rawData })
      .from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, s.sourcedId)).limit(1);
    assert.equal((sc.rawData as any).stage, "screening", "sourced rawData.stage mirror must match applications.stage");

    // 3. candidate_events STAGE_CHANGED — truthful from→to + actor
    const events = await db.select().from(candidateEventsTable)
      .where(eq(candidateEventsTable.tenantId, s.tenantId));
    const stageEvents = events.filter(e => e.eventType === "STAGE_CHANGED");
    assert.equal(stageEvents.length, 1, "exactly one STAGE_CHANGED event");
    const ev = stageEvents[0];
    assert.equal(ev.candidateId, s.candidateId);
    assert.equal(ev.jobId, s.jobId);
    assert.equal(ev.applicationId, s.applicationId);
    assert.equal(ev.actorType, "recruiter", "a user/recruiter move records actor_type=recruiter (never null)");
    assert.equal(ev.source, "recruiter_action");
    assert.equal((ev.metadataJson as any).from, "applied");
    assert.equal((ev.metadataJson as any).to, "screening");

    // 4. audit_logs thin pointer → references the candidate_events row
    const audits = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.tenantId, s.tenantId));
    const stageAudits = audits.filter(a => a.action === "stage.changed");
    assert.equal(stageAudits.length, 1, "exactly one stage.changed audit row");
    const au = stageAudits[0];
    assert.equal(au.subjectType, "candidate");
    assert.equal(au.subjectId, s.candidateId);
    assert.equal(au.actorType, "user", "audit actor_type is never null");
    assert.equal((au.metadata as any).candidateEventId, ev.eventId, "audit pointer must reference the candidate_events eventId");
    assert.equal((au.metadata as any).from, "applied");
    assert.equal((au.metadata as any).to, "screening");
  } finally {
    await cleanup(s.tenantId);
  }
});

test("forced failure after the stage writes rolls back ALL four — the two stage values can never disagree", async () => {
  const s = await seed();
  try {
    // Circular metadata makes the candidate_events jsonb serialization throw —
    // AFTER applications.stage and the sourced mirror have been written inside the
    // same transaction. A correct choke-point must roll BOTH of them back.
    const circular: any = { marker: "boom" };
    circular.self = circular;

    await assert.rejects(
      changeCandidateStage({
        tenantId: s.tenantId,
        candidateId: s.candidateId,
        jobId: s.jobId,
        to: "screening",
        actor: { type: "user", role: "recruiter", id: "user_test_123" },
        source: "recruiter_action",
        applicationId: s.applicationId,
        sourcedId: s.sourcedId,
        metadata: circular,
      }),
      "a non-serializable metadata payload must throw",
    );

    // applications.stage rolled back
    const [app] = await db.select({ stage: applicationsTable.stage })
      .from(applicationsTable).where(eq(applicationsTable.id, s.applicationId)).limit(1);
    assert.equal(app.stage, "applied", "applications.stage must roll back to its original value");

    // sourced mirror rolled back — still equal to applications.stage
    const [sc] = await db.select({ rawData: sourcedCandidatesTable.rawData })
      .from(sourcedCandidatesTable).where(eq(sourcedCandidatesTable.id, s.sourcedId)).limit(1);
    assert.equal((sc.rawData as any).stage, "applied", "sourced rawData.stage must roll back — never left disagreeing with applications.stage");

    // no partial trail
    const events = await db.select().from(candidateEventsTable)
      .where(eq(candidateEventsTable.tenantId, s.tenantId));
    assert.equal(events.filter(e => e.eventType === "STAGE_CHANGED").length, 0, "no STAGE_CHANGED event may survive a rolled-back move");
    const audits = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.tenantId, s.tenantId));
    assert.equal(audits.filter(a => a.action === "stage.changed").length, 0, "no audit row may survive a rolled-back move");
  } finally {
    await cleanup(s.tenantId);
  }
});

test("same-stage call is a no-op — patches apply, but no transition trail is written", async () => {
  const s = await seed();
  try {
    const result = await changeCandidateStage({
      tenantId: s.tenantId,
      candidateId: s.candidateId,
      jobId: s.jobId,
      to: "applied", // already 'applied'
      actor: { type: "user", role: "recruiter", id: "user_test_123" },
      source: "recruiter_action",
      applicationId: s.applicationId,
      sourcedId: s.sourcedId,
    });

    assert.equal(result.changed, false, "a same-stage write is not a move");
    assert.equal(result.eventId, null, "no event id for a no-op");

    const events = await db.select().from(candidateEventsTable)
      .where(eq(candidateEventsTable.tenantId, s.tenantId));
    assert.equal(events.filter(e => e.eventType === "STAGE_CHANGED").length, 0, "no STAGE_CHANGED trail for a no-op");
    const audits = await db.select().from(auditLogsTable)
      .where(eq(auditLogsTable.tenantId, s.tenantId));
    assert.equal(audits.filter(a => a.action === "stage.changed").length, 0, "no audit trail for a no-op");
  } finally {
    await cleanup(s.tenantId);
  }
});
