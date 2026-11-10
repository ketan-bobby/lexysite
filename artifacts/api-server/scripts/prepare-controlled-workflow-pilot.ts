/**
 * Prepare an isolated internal workflow pilot. This is NOT an execution runner.
 * It never calls a provider, sends mail, creates an interview, or writes evidence.
 * Only existing livepilot fixtures are accepted; ordinary customer jobs cannot
 * be used as sources. Run without --execute for a read-only prerequisite check.
 */
import { parseArgs } from "node:util";
import {
  dbAdmin,
  pool,
  jobsTable,
  tenantsTable,
  usersTable,
  candidatesTable,
  applicationsTable,
  jobRecruitersTable,
  jobPipelinesTable,
  icpTable,
  recruitingJourneysTable,
  recruitingWorkflowsTable,
  recruitingWorkflowEventsTable,
} from "@workspace/db";
import { and, eq, like, sql } from "drizzle-orm";
import {
  readBrief,
  draftJourney,
  approveJourney,
  enrollWorkflow,
} from "../src/lib/recruiting-workflows";
import {
  assertPilotPreparationScope,
  assertReusablePreparedPilot,
} from "../src/lib/pilot-preparation-policy";

const { values } = parseArgs({
  options: {
    "source-job": { type: "string" },
    candidate: { type: "string" },
    recipient: { type: "string" },
    key: { type: "string" },
    execute: { type: "boolean", default: false },
    "approve-plan": { type: "boolean", default: false },
  },
});

async function main() {
  const sourceId = values["source-job"];
  const candidateId = values.candidate;
  const recipient = values.recipient?.trim().toLowerCase();
  const key = values.key;
  if (
    !sourceId?.startsWith("livepilot_") ||
    !candidateId?.startsWith("livepilot_candidate_") ||
    !key?.match(/^livepilot_e2e_[a-z0-9_]{1,40}$/) ||
    !recipient
  ) {
    throw new Error(
      "An isolated source, controlled candidate, recipient and pilot key are required.",
    );
  }
  const [source] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, sourceId));
  if (!source || !source.tenantId.startsWith("livepilot_") || source.status !== "active")
    throw new Error("Source must be an approved, isolated livepilot requisition.");
  const [operator] = await dbAdmin
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, source.createdById ?? ""));
  const [candidate] = await dbAdmin
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId));
  if (
    !operator ||
    operator.status !== "active" ||
    operator.role !== "tenant_admin" ||
    operator.tenantId !== source.tenantId ||
    !candidate ||
    candidate.tenantId !== source.tenantId ||
    candidate.pool !== "tenant" ||
    candidate.doNotContact ||
    candidate.dataErasedAt ||
    candidate.email?.trim().toLowerCase() !== recipient
  ) {
    throw new Error("Pilot operator, candidate scope, privacy or recipient check failed.");
  }
  assertPilotPreparationScope(source, operator, candidate, recipient);
  console.log(JSON.stringify({ prerequisitesPassed: true, execute: values.execute }));
  if (!values.execute) return;

  const jobId = `${key}_job`;
  const now = new Date();
  await dbAdmin.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
    const [existing] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    if (existing) {
      assertReusablePreparedPilot(existing, source.tenantId, operator.id);
      return;
    }
    const [tenant] = await tx
      .select()
      .from(tenantsTable)
      .where(eq(tenantsTable.id, source.tenantId));
    if (!tenant) throw new Error("Pilot tenant missing.");
    const year = now.getUTCFullYear();
    const numbers = await tx
      .select({ number: jobsTable.workOrderNumber })
      .from(jobsTable)
      .where(like(jobsTable.workOrderNumber, `%WO-${year}-%`));
    const max = numbers.reduce((n, row) => {
      const match = row.number?.match(/WO-\d{4}-[A-Z0-9]+-[A-Z0-9]+-(\d{4})$/);
      return Math.max(n, match ? Number(match[1]) : 0);
    }, 0);
    const code = (tenant.slug || tenant.name)
      .replace(/[^a-zA-Z0-9]/g, "")
      .toUpperCase()
      .slice(0, 4)
      .padEnd(2, "X");
    await tx.insert(jobsTable).values({
      ...source,
      id: jobId,
      workOrderNumber: `WO-${year}-${code}-MAIN-${String(max + 1).padStart(4, "0")}`,
      clientWorkOrderNumber: null,
      title: "[AUTONOMY PILOT] TypeScript Backend Engineer — controlled workflow",
      createdById: operator.id,
      assignedRecruiterId: operator.id,
      assignedHiringManagerId: null,
      approvedById: values["approve-plan"] ? operator.id : null,
      status: values["approve-plan"] ? "active" : "pending_approval",
      recruitingMode: "lexy_autonomous",
      interviewPath: "ai",
      platformRecommendationsEnabled: false,
      createdAt: now,
      updatedAt: now,
    });
    const profiles = await tx.select().from(icpTable).where(eq(icpTable.jobId, source.id));
    for (const profile of profiles) {
      if (profile.tenantId !== source.tenantId) throw new Error("Foreign source ICP.");
      await tx.insert(icpTable).values({
        ...profile,
        id: `${key}_icp_${profile.version}`,
        jobId,
        createdAt: now,
      });
    }
    await tx.insert(jobRecruitersTable).values({
      tenantId: source.tenantId,
      jobId,
      recruiterUserId: operator.id,
      assignedByUserId: operator.id,
    });
    await tx.insert(jobPipelinesTable).values({
      tenantId: source.tenantId,
      jobId,
      // Preparation must not trigger uncontrolled contact with discovered people.
      autoRun: false,
      targetCandidates: 5,
      interviewTypes: ["technical"],
    });
    await tx.insert(applicationsTable).values({
      id: `${key}_application`,
      tenantId: source.tenantId,
      jobId,
      candidateId,
      stage: "sourced",
    });
  });
  const scope = {
    jobId,
    tenantId: source.tenantId,
    actorId: operator.id,
    canApprove: true,
  };
  const current = await readBrief(dbAdmin, scope);
  const draft = await draftJourney(scope, {
    expectedBriefHash: current.hash,
    idempotencyKey: `${key}:draft`,
  });
  if (values["approve-plan"]) {
    await approveJourney(scope, draft.id, {
      expectedBriefHash: current.hash,
      idempotencyKey: `${key}:approve-preparation`,
    });
    await enrollWorkflow(
      scope,
      {
        journeyId: draft.id,
        candidateId,
        expectedBriefHash: current.hash,
        idempotencyKey: `${key}:enroll`,
      },
      async (tx, id) => {
        const [linked] = await tx
          .select({ id: applicationsTable.id })
          .from(applicationsTable)
          .where(
            and(
              eq(applicationsTable.jobId, jobId),
              eq(applicationsTable.candidateId, id),
              eq(applicationsTable.tenantId, scope.tenantId),
            ),
          );
        const [currentCandidate] = await tx
          .select()
          .from(candidatesTable)
          .where(and(eq(candidatesTable.id, id), eq(candidatesTable.tenantId, scope.tenantId)));
        return (
          id === candidate.id &&
          !!linked &&
          !!currentCandidate &&
          currentCandidate.pool === "tenant" &&
          !currentCandidate.doNotContact &&
          !currentCandidate.dataErasedAt &&
          currentCandidate.email?.trim().toLowerCase() === recipient
        );
      },
    );
  }
  await dbAdmin
    .update(recruitingWorkflowEventsTable)
    .set({
      note: "Internal pilot prepared by Replit Agent at the owner's explicit request, using the designated pilot operator. Configuration approval only: no execution, outreach, assessment or hiring evidence is claimed. Paid autonomous dispatch remains locked.",
    })
    .where(
      and(
        eq(recruitingWorkflowEventsTable.jobId, jobId),
        eq(recruitingWorkflowEventsTable.tenantId, scope.tenantId),
        eq(recruitingWorkflowEventsTable.action, "journey.approved"),
      ),
    );
  const [job] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, jobId));
  const journeys = await dbAdmin
    .select({ status: recruitingJourneysTable.status })
    .from(recruitingJourneysTable)
    .where(eq(recruitingJourneysTable.jobId, jobId));
  const workflows = await dbAdmin
    .select()
    .from(recruitingWorkflowsTable)
    .where(eq(recruitingWorkflowsTable.jobId, jobId));
  console.log(
    JSON.stringify({
      jobId,
      workOrderNumber: job.workOrderNumber,
      journeyStatus: journeys[0]?.status,
      workflowId: workflows[0]?.id,
      interviewPath: job.interviewPath,
      steps: workflows[0]?.steps.map((step) => ({ key: step.key, status: step.status })),
      liveExecutionStarted: false,
      emailsSent: 0,
      interviewsCreated: 0,
    }),
  );
}

main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
