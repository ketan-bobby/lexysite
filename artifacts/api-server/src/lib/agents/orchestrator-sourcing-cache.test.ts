import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  jobsTable,
  candidatesTable,
  applicationsTable,
  sourcedCandidatesTable,
  interviewPlansTable,
  interviewSessionsTable,
  outreachMessagesTable,
} from "@workspace/db";
import { orchestrator } from "./orchestrator";

const P = "osc_";
const TENANT_ID = `${P}tenant`;
const SOURCE_JOB_ID = `${P}source-job`;
const TARGET_JOB_ID = `${P}target-job`;
const EMPLOYEE_ID = `${P}employee`;
const CACHED_SOURCE_ID = `${P}cached-source`;
const TARGET_PLAN_ID = `${P}target-plan`;

async function cleanup() {
  await dbAdmin.delete(outreachMessagesTable).where(eq(outreachMessagesTable.tenantId, TENANT_ID));
  await dbAdmin
    .delete(interviewSessionsTable)
    .where(eq(interviewSessionsTable.candidateId, EMPLOYEE_ID));
  await dbAdmin.delete(interviewPlansTable).where(eq(interviewPlansTable.tenantId, TENANT_ID));
  await dbAdmin.delete(applicationsTable).where(eq(applicationsTable.tenantId, TENANT_ID));
  await dbAdmin
    .delete(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.tenantId, TENANT_ID));
  await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, TENANT_ID));
  await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, TENANT_ID));
  await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, TENANT_ID));
}

before(async () => {
  await cleanup();
  await dbAdmin.insert(tenantsTable).values({
    id: TENANT_ID,
    name: "Orchestrator cache fixture",
    slug: `${P}tenant-slug`,
  } as any);
  await dbAdmin.insert(jobsTable).values([
    {
      id: SOURCE_JOB_ID,
      tenantId: TENANT_ID,
      title: "Previous requisition",
      description: "Cached source row's original requisition",
      status: "active",
    },
    {
      id: TARGET_JOB_ID,
      tenantId: TENANT_ID,
      title: "Internal Mobility Engineer",
      description: "Current requisition",
      status: "active",
      internalMobility: true,
    },
  ] as any);
  await dbAdmin.insert(candidatesTable).values({
    id: EMPLOYEE_ID,
    tenantId: TENANT_ID,
    pool: "tenant",
    isCurrentEmployee: true,
    source: "hris_sync",
    firstName: "Internal",
    lastName: "Engineer",
    email: `${P}employee@unknown.local`,
    currentTitle: "Internal Mobility Engineer",
    skills: ["typescript"],
  } as any);
  await dbAdmin.insert(sourcedCandidatesTable).values({
    id: CACHED_SOURCE_ID,
    tenantId: TENANT_ID,
    normalizedCandidateId: EMPLOYEE_ID,
    source: "internal",
    rawData: {
      jobId: SOURCE_JOB_ID,
      firstName: "Internal",
      lastName: "Engineer",
      source: "internal",
      stage: "verification",
      screened: true,
      screeningResult: { recommendation: "advance" },
      outreachSent: false,
    },
  } as any);
  await dbAdmin.insert(interviewPlansTable).values({
    id: TARGET_PLAN_ID,
    tenantId: TENANT_ID,
    jobId: TARGET_JOB_ID,
    title: "Existing regression-test plan",
    interviewType: "general",
    questions: [],
  } as any);
});

after(cleanup);

test("job links preserve cache identity but cannot reuse another job's workflow flags", async () => {
  const result = await (orchestrator as any)._runSourcing({
    jobId: TARGET_JOB_ID,
    targetCandidates: 1,
    minScore: 0,
  });
  assert.equal(result.sourced, 0, "the global sourced cache row is reused, not duplicated");

  const [application] = await dbAdmin
    .select()
    .from(applicationsTable)
    .where(
      and(
        eq(applicationsTable.jobId, TARGET_JOB_ID),
        eq(applicationsTable.candidateId, EMPLOYEE_ID),
      ),
    );
  assert.ok(application, "internal source selection has a job-scoped application link");
  assert.equal((application.originEvidence as any)?.channel, "internal_mobility");

  const [cached] = await dbAdmin
    .select()
    .from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.id, CACHED_SOURCE_ID));
  assert.ok(cached);
  assert.equal(
    (cached.rawData as any)?.jobId,
    SOURCE_JOB_ID,
    "job B's application does not rewrite job A's global cache metadata",
  );

  const outreach = await (orchestrator as any)._runOutreach({
    jobId: TARGET_JOB_ID,
    candidateId: CACHED_SOURCE_ID,
  });
  assert.deepEqual(
    outreach.skippedUnverified,
    [CACHED_SOURCE_ID],
    "job A's verification-stage flag does not authorize outreach for job B",
  );
  assert.equal(outreach.messagesQueued, 0);

  const interview = await (orchestrator as any)._runInterview({
    jobId: TARGET_JOB_ID,
    candidateId: EMPLOYEE_ID,
  });
  assert.equal(interview.interviewLinksGenerated, 0);
  assert.equal(
    interview.skipped[0]?.reason,
    "not_sourced_for_job",
    "job A's screened/advance flags cannot authorize a job B interview",
  );
  const sessions = await dbAdmin
    .select()
    .from(interviewSessionsTable)
    .where(eq(interviewSessionsTable.candidateId, EMPLOYEE_ID));
  assert.equal(sessions.length, 0, "no interview session is created from the other job's flags");
});

test("native interview creation preserves the original outreach send and positive reply", async () => {
  const sentAt = new Date("2026-01-01T10:00:00Z");
  const repliedAt = new Date("2026-01-01T10:05:00Z");
  // Hard-suppressed demo transport plus a saved plan: no email or model call.
  await dbAdmin
    .update(candidatesTable)
    .set({ email: "chronology@demo.lexy.example" })
    .where(eq(candidatesTable.id, EMPLOYEE_ID));
  await dbAdmin.insert(interviewPlansTable).values({
    id: `${P}chronology-plan`,
    tenantId: TENANT_ID,
    jobId: SOURCE_JOB_ID,
    title: "Synthetic chronology regression",
    interviewType: "general",
    questions: [{ id: "fixture-question", text: "Fictional test only", order: 1 }],
  });
  const [message] = await dbAdmin
    .insert(outreachMessagesTable)
    .values({
      tenantId: TENANT_ID,
      jobId: SOURCE_JOB_ID,
      candidateId: EMPLOYEE_ID,
      subject: "Synthetic chronology fixture — never sent",
      body: "Invented first-touch and reply evidence for a regression test only.",
      status: "replied",
      sentAt,
      repliedAt,
      replySentiment: "positive",
    })
    .returning();

  const result = await (orchestrator as any)._runInterview({
    jobId: SOURCE_JOB_ID,
    candidateId: EMPLOYEE_ID,
  });
  assert.equal(result.interviewLinksGenerated, 1);
  assert.equal(result.invitationAccepted, 0, "demo email must not reach a provider");
  const [saved] = await dbAdmin
    .select()
    .from(outreachMessagesTable)
    .where(eq(outreachMessagesTable.id, message.id));
  assert.equal(saved.sentAt?.toISOString(), sentAt.toISOString());
  assert.equal(saved.repliedAt?.toISOString(), repliedAt.toISOString());
  assert.equal(saved.replySentiment, "positive");
  assert.equal(saved.status, "replied");
  assert.equal(saved.interviewLink, `/interviews/${result.sessionIds[0]}/room`);
});
