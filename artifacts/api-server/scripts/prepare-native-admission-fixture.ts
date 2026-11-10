/** Private synthetic UI fixture only; never invokes a provider or message transport. */
import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  usersTable,
  jobRecruitersTable,
  jobPipelinesTable,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import { draftJourney, approveJourney, readBrief } from "../src/lib/recruiting-workflows";
import {
  saveSourcingPolicy,
  approveSourcingPolicy,
  reserveSourcingRun,
} from "../src/lib/sourcing-controls";
import { issueToken } from "../src/lib/auth-token";
import { NativeDiscoveryRecord, NATIVE_DISCOVERY_ACTION } from "../src/lib/sourcing-native-records";

async function main() {
  const [source] = await dbAdmin
    .select()
    .from(jobsTable)
    .where(eq(jobsTable.id, "livepilot_native_20261009_broad_job"));
  if (!source || !source.tenantId.startsWith("livepilot_"))
    throw new Error("Isolated pilot source unavailable.");
  const [actor] = await dbAdmin
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, source.createdById!));
  if (
    !actor ||
    actor.tenantId !== source.tenantId ||
    actor.status !== "active" ||
    actor.role !== "tenant_admin"
  )
    throw new Error("Active isolated pilot approver required.");
  const jobId = `native_admission_synthetic_${randomUUID()}`;
  await dbAdmin.transaction(async (tx) => {
    await tx.insert(jobsTable).values({
      ...source,
      id: jobId,
      workOrderNumber: `TEST-${randomUUID()}`,
      clientWorkOrderNumber: null,
      title: "[SYNTHETIC UI TEST] Native profile admission",
      description:
        "Fictional UI fixture, not a real vacancy. No provider calls, scoring or contact authorized.",
      platformRecommendationsEnabled: false,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    await tx.insert(jobRecruitersTable).values({
      tenantId: source.tenantId,
      jobId,
      recruiterUserId: actor.id,
      assignedByUserId: actor.id,
    });
    await tx.insert(jobPipelinesTable).values({
      tenantId: source.tenantId,
      jobId,
      autoRun: false,
      targetCandidates: 2,
    });
  });
  const scope = { jobId, tenantId: source.tenantId, actorId: actor.id, canApprove: true };
  const { hash } = await readBrief(dbAdmin, scope);
  const draft = await draftJourney(scope, {
    expectedBriefHash: hash,
    idempotencyKey: randomUUID(),
  });
  await approveJourney(scope, draft.id, { expectedBriefHash: hash, idempotencyKey: randomUUID() });
  await saveSourcingPolicy(scope, {
    expectedRevision: 0,
    expectedBriefHash: hash,
    idempotencyKey: randomUUID(),
    limits: {
      allowExternal: true,
      providers: ["pdl", "serp"],
      maxCandidates: 2,
      maxRuns: 1,
      maxDurationSeconds: 180,
      runBudgetCents: 100,
      totalBudgetCents: 100,
    },
  });
  await approveSourcingPolicy(scope, {
    expectedRevision: 1,
    expectedBriefHash: hash,
    journeyId: draft.id,
    idempotencyKey: randomUUID(),
  });
  const hold = await reserveSourcingRun(scope, {
    expectedRevision: 2,
    expectedBriefHash: hash,
    idempotencyKey: randomUUID(),
  });
  const operationId = randomUUID();
  const profileUrl = `https://www.linkedin.com/in/lexy-fictional-${randomUUID()}`;
  await dbAdmin.insert(events).values({
    tenantId: source.tenantId,
    jobId,
    actorId: actor.id,
    journeyId: draft.id,
    action: NATIVE_DISCOVERY_ACTION,
    note: JSON.stringify(
      NativeDiscoveryRecord.parse({
        reservationId: hold.id,
        operationId,
        provider: "pdl",
        status: "succeeded",
        profiles: [
          {
            url: profileUrl,
            title: "FICTIONAL public reference — UI fixture only",
            snippet: "Mocked discovery record; no real provider result or assessment evidence.",
          },
        ],
      }),
    ),
  });
  const filePath = "/tmp/native-admission-browser-auth.json";
  await writeFile(
    filePath,
    JSON.stringify({
      token: issueToken({ userId: actor.id, role: actor.role, tenantId: actor.tenantId }),
      jobId,
      profileUrl,
      reservationId: hold.id,
      operationId,
    }),
    { mode: 0o600 },
  );
  console.log(
    JSON.stringify({
      jobId,
      path: `/jobs/${jobId}`,
      authenticationFile: filePath,
      syntheticOnly: true,
      providerRequests: 0,
      emails: 0,
    }),
  );
}
main().catch(() => {
  console.error("Synthetic fixture preparation failed; inspect its scoped records.");
  process.exitCode = 1;
});
