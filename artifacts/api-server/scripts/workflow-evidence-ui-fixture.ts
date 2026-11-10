/**
 * Disposable, provider-free browser fixture. No production/customer records are touched.
 * Authentication is minted ONLY for this synthetic user, never an existing operator.
 */
import { randomUUID } from "node:crypto";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { and, eq } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  tenantsTable,
  usersTable,
  jobsTable,
  jobPipelinesTable,
  icpTable,
  sourcedCandidatesTable,
  candidateEventsTable,
  auditLogsTable,
  verificationRecordsTable,
  candidatesTable,
  applicationsTable,
  recruitingWorkflowsTable,
  recruitingJourneysTable,
  recruitingWorkflowEventsTable,
  recruitingWorkflowReceiptsTable,
  resumeScreensTable,
  outreachMessagesTable,
} from "@workspace/db";
import { issueToken } from "../src/lib/auth-token";
import {
  readBrief,
  draftJourney,
  approveJourney,
  enrollWorkflow,
  recordWorkflowEvidence,
} from "../src/lib/recruiting-workflows";
import { executeWorkflowAction } from "../src/lib/workflow-execution";
import { WorkflowPreEffectError } from "../src/lib/workflow-action-recovery";

const recoveryTest = process.argv.includes("--recovery");
const readinessTest = process.argv.includes("--screening-handoff");
const qualifiedScreening = process.argv.includes("--qualified-screening");
const verificationPilot = process.argv.includes("--verification-pilot");
const engagementPilot = process.argv.includes("--engagement-pilot");
const recipientIndex = process.argv.indexOf("--controlled-recipient");
const controlledRecipient =
  recipientIndex >= 0 ? process.argv[recipientIndex + 1]?.trim().toLowerCase() : null;
const path = readinessTest
  ? "/tmp/workflow-screening-ui-fixture.json"
  : recoveryTest
    ? "/tmp/workflow-recovery-ui-fixture.json"
    : "/tmp/workflow-evidence-ui-fixture.json";
async function main() {
  if (process.argv.includes("--cleanup")) {
    const fixture = JSON.parse(await readFile(path, "utf8"));
    if (!String(fixture.tenantId).startsWith("evidence_ui_"))
      throw new Error("Refusing to clean a non-fixture tenant.");
    for (const table of [
      resumeScreensTable,
      outreachMessagesTable,
      verificationRecordsTable,
      recruitingWorkflowEventsTable,
      recruitingWorkflowReceiptsTable,
      recruitingWorkflowsTable,
      recruitingJourneysTable,
      auditLogsTable,
      candidateEventsTable,
      sourcedCandidatesTable,
      applicationsTable,
      icpTable,
      jobPipelinesTable,
      jobsTable,
      candidatesTable,
      usersTable,
    ])
      await dbAdmin.delete(table).where(eq(table.tenantId, fixture.tenantId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, fixture.tenantId));
    await unlink(path);
    process.stdout.write("Disposable browser fixture removed.\n");
    return;
  }
  const tenantId = `evidence_ui_${randomUUID()}`;
  if (qualifiedScreening && !readinessTest)
    throw new Error("Qualified screening preparation requires the screening-handoff fixture.");
  if (verificationPilot && !(qualifiedScreening && readinessTest))
    throw new Error("Verification preparation requires the isolated qualified screening fixture.");
  if (engagementPilot) {
    if (!verificationPilot || !controlledRecipient)
      throw new Error(
        "Engagement preparation requires verification setup and an owner-authorized test inbox.",
      );
    const [recipient] = await dbAdmin
      .select({ role: usersTable.role, status: usersTable.status })
      .from(usersTable)
      .where(eq(usersTable.email, controlledRecipient));
    if (recipient?.role !== "candidate" || recipient.status !== "active")
      throw new Error(
        "This fixture requires an active candidate-portal inbox; no account role is changed.",
      );
  }
  const testRecipient = process.argv.includes("--test-recipient");
  const userId = `${tenantId}_user`,
    jobId = `${tenantId}_job`,
    candidateId = `${tenantId}_candidate`;
  // Claim the private metadata path before writing any rows. Do not overwrite
  // an active pilot or lose the exact cleanup scope if preparation later fails.
  await writeFile(path, JSON.stringify({ tenantId, jobId, candidateId, phase: "preparing" }), {
    mode: 0o600,
    flag: "wx",
  });
  await dbAdmin
    .insert(tenantsTable)
    .values({ id: tenantId, name: "Disposable evidence UI", slug: tenantId });
  await dbAdmin.insert(usersTable).values({
    id: userId,
    tenantId,
    name: "Evidence fixture reviewer",
    email: `${tenantId}@example.invalid`,
    role: "tenant_admin",
    status: "active",
    passwordHash: "NO_PASSWORD_LOGIN_FOR_DISPOSABLE_FIXTURE",
  });
  await dbAdmin.insert(jobsTable).values({
    id: jobId,
    tenantId,
    title: qualifiedScreening
      ? "[AUTONOMY PILOT] Synthetic SQL backend engineer"
      : readinessTest
        ? "[AUTONOMY PILOT] Disposable screening readiness"
        : recoveryTest
          ? "[AUTONOMY PILOT] Disposable recovery test"
          : testRecipient
            ? "[AUTONOMY PILOT] Disposable recipient permission test"
            : "Disposable runtime evidence test",
    description: qualifiedScreening
      ? "Isolated fictional backend engineering role requiring SQL, PostgreSQL and API design. No candidate contact or automatic pipeline execution."
      : "No live recruiting",
    status: "active",
    recruitingMode: "lexy_autonomous",
    interviewPath: "ai",
    assignedRecruiterId: userId,
    platformRecommendationsEnabled: false,
  });
  await dbAdmin.insert(jobPipelinesTable).values({ tenantId, jobId, autoRun: false });
  if (qualifiedScreening)
    await dbAdmin.insert(icpTable).values({
      tenantId,
      jobId,
      jobTitle: "SQL backend engineer",
      requiredSkills: ["SQL", "PostgreSQL", "API design"],
      preferredSkills: ["automated testing"],
      seniority: "mid",
    });
  await dbAdmin.insert(candidatesTable).values({
    id: candidateId,
    tenantId,
    firstName: "Synthetic",
    lastName: "Evidence",
    ...(engagementPilot ? { verificationStatus: "pending" as const } : {}),
    email: engagementPilot
      ? controlledRecipient!
      : qualifiedScreening
        ? `${tenantId}@example.invalid`
        : `${candidateId}@example.invalid`,
    currentTitle: qualifiedScreening
      ? "SQL backend engineer"
      : recoveryTest
        ? "Synthetic recovery engineer"
        : null,
    skills: qualifiedScreening
      ? ["SQL", "PostgreSQL", "API design", "automated testing"]
      : recoveryTest
        ? ["Synthetic recovery qualification"]
        : [],
  });
  if (testRecipient)
    await dbAdmin.insert(usersTable).values({
      id: `${tenantId}_portal`,
      tenantId,
      name: "Fictional portal recipient",
      email: `${candidateId}@example.invalid`,
      role: "candidate",
      status: "active",
      passwordHash: "NO_PASSWORD_LOGIN_FOR_DISPOSABLE_FIXTURE",
    });
  await dbAdmin.insert(applicationsTable).values({
    id: `${tenantId}_application`,
    tenantId,
    jobId,
    candidateId,
    stage: "sourced",
  });
  const scope = { tenantId, jobId, actorId: userId, canApprove: true };
  const { hash } = await readBrief(dbAdmin, scope);
  const draft = await draftJourney(scope, {
    idempotencyKey: randomUUID(),
    expectedBriefHash: hash,
  });
  await approveJourney(scope, draft.id, { idempotencyKey: randomUUID(), expectedBriefHash: hash });
  const enrolled = await enrollWorkflow(
    scope,
    {
      idempotencyKey: randomUUID(),
      expectedBriefHash: hash,
      journeyId: draft.id,
      candidateId,
    },
    async () => true,
  );
  if (verificationPilot) {
    const [current] = await dbAdmin
      .select({ revision: recruitingWorkflowsTable.revision })
      .from(recruitingWorkflowsTable)
      .where(
        and(
          eq(recruitingWorkflowsTable.id, enrolled.id),
          eq(recruitingWorkflowsTable.tenantId, tenantId),
        ),
      );
    await dbAdmin
      .update(candidatesTable)
      .set({
        verificationResult: {
          syntheticFixture: { kind: "staff_inbox", workflowId: enrolled.id },
        },
      })
      .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, tenantId)));
    await recordWorkflowEvidence(
      scope,
      enrolled.id,
      {
        idempotencyKey: randomUUID(),
        expectedRevision: current.revision,
        stepKey: "screening",
        status: "completed",
        evidence:
          "[SYNTHETIC FIXTURE SETUP ONLY] Predecessor workflow clearance for an isolated verification test. No native screening call, real qualification approval or hiring evidence is claimed.",
      },
      async () => true,
    );
  }
  const unparsedCandidateId = readinessTest ? `${tenantId}_unparsed_candidate` : null;
  if (unparsedCandidateId) {
    await dbAdmin.insert(candidatesTable).values({
      id: unparsedCandidateId,
      tenantId,
      firstName: "Synthetic unparsed",
      lastName: "Resume input preparation example",
      email: `${unparsedCandidateId}@example.invalid`,
      resumeUrl: "/objects/fictional-unparsed-resume.pdf",
    });
    await dbAdmin.insert(applicationsTable).values({
      id: `${tenantId}_unparsed_application`,
      tenantId,
      jobId,
      candidateId: unparsedCandidateId,
      stage: "sourced",
    });
  }
  if (!readinessTest)
    await dbAdmin.insert(resumeScreensTable).values({
      id: `${tenantId}_screen`,
      tenantId,
      jobId,
      candidateId,
      screeningScore: 0,
      recruiterSummary: "Synthetic zero-score evidence. Human review remains required.",
    });
  let unknownWorkflowId: string | null = null;
  if (recoveryTest) {
    if (process.env.NODE_ENV !== "test")
      throw new Error("Recovery fixture requires a test-only process.");
    const context = (workflowId: string, target: string) => ({
      scope,
      candidateAllowed: async () => true,
      input: {
        workflowId,
        candidateId: target,
        journeyId: draft.id,
        journeyVersion: 1,
        expectedRevision: 1,
        stepKey: "screening",
        actionKind: "agent" as const,
        payloadHash: "a".repeat(64),
        idempotencyKey: randomUUID(),
      },
    });
    await executeWorkflowAction(context(enrolled.id, candidateId), {
      mode: "controlled_test",
      invoke: async () => {
        throw new WorkflowPreEffectError("Fictional eligibility failed before any external work.");
      },
    });
    const target = `${tenantId}_unknown_candidate`;
    await dbAdmin.insert(candidatesTable).values({
      id: target,
      tenantId,
      firstName: "Synthetic",
      lastName: "Unknown",
      email: `${target}@example.invalid`,
      currentTitle: "Synthetic recovery engineer",
      skills: ["Synthetic recovery qualification"],
    });
    await dbAdmin.insert(applicationsTable).values({
      id: `${tenantId}_unknown_application`,
      tenantId,
      jobId,
      candidateId: target,
      stage: "sourced",
    });
    const unknown = await enrollWorkflow(
      scope,
      {
        idempotencyKey: randomUUID(),
        expectedBriefHash: hash,
        journeyId: draft.id,
        candidateId: target,
      },
      async () => true,
    );
    unknownWorkflowId = unknown.id;
    await executeWorkflowAction(context(unknown.id, target), {
      mode: "controlled_test",
      invoke: async () => {
        throw new Error("Fictional ambiguous failure");
      },
    });
  }
  await writeFile(
    path,
    JSON.stringify({
      tenantId,
      jobId,
      workflowId: enrolled.id,
      unknownWorkflowId,
      candidateId,
      unparsedCandidateId,
      journeyId: draft.id,
      verificationPilot,
      engagementPilot,
      controlledRecipient: engagementPilot ? controlledRecipient : null,
      testRecipientEmail: testRecipient ? `${candidateId}@example.invalid` : null,
      token: issueToken({ userId, tenantId, role: "tenant_admin" }),
    }),
    { mode: 0o600 },
  );
  process.stdout.write(
    `Disposable browser fixture ready; metadata in ${path}. No email or provider calls.\n`,
  );
}
main()
  .catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
