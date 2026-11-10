/**
 * One explicitly executed provider-only pilot. No imports, scores, interviews or
 * contact. Original customer/pilot work orders and their approvals are unchanged.
 * A stable key reuses the same reservation; claimed effects are never repeated.
 */
import { parseArgs } from "node:util";
import {
  dbAdmin,
  pool,
  jobsTable,
  usersTable,
  icpTable,
  jobRecruitersTable,
  jobPipelinesTable,
  sourcingReservationsTable,
  vendorUsageAttemptsTable,
} from "@workspace/db";
import { and, eq, like, sql } from "drizzle-orm";
import { readBrief, draftJourney, approveJourney } from "../src/lib/recruiting-workflows";
import { issueToken } from "../src/lib/auth-token";
import { getNativeSourcingRuns, nativeSourcingReadiness } from "../src/lib/sourcing-native-run";

const { values } = parseArgs({
  options: {
    "source-job": { type: "string" },
    key: { type: "string" },
    execute: { type: "boolean", default: false },
    "broad-discovery": { type: "boolean", default: false },
  },
});

async function main() {
  const sourceId = values["source-job"];
  const key = values.key;
  if (!sourceId?.startsWith("livepilot_") || !key?.match(/^livepilot_native_[a-z0-9_]{1,32}$/))
    throw new Error("An isolated source and stable native-pilot key are required.");
  const [source] = await dbAdmin.select().from(jobsTable).where(eq(jobsTable.id, sourceId));
  if (
    !source ||
    !source.tenantId.startsWith("livepilot_") ||
    source.status !== "active" ||
    !source.approvedById ||
    !source.title.includes("PILOT")
  )
    throw new Error("Source must be an approved isolated pilot, not a customer work order.");
  const [operator] = await dbAdmin
    .select()
    .from(usersTable)
    .where(eq(usersTable.id, source.createdById ?? ""));
  if (
    !operator ||
    !operator.id.startsWith("livepilot_") ||
    operator.status !== "active" ||
    operator.role !== "tenant_admin" ||
    operator.tenantId !== source.tenantId
  )
    throw new Error("Isolated pilot operator validation failed.");
  const readiness = nativeSourcingReadiness(
    { allowExternal: true, providers: ["pdl", "serp", "enrichlayer"] },
    false,
  );
  if (!readiness.ready || readiness.providers.some((p) => !p.available))
    throw new Error("All three selected providers must be configured for this live check.");
  const origin = process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : null;
  if (!origin) throw new Error("Development origin is unavailable.");
  const constraint = await dbAdmin.execute(sql`
    SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid='vendor_usage_attempts'::regclass AND conname='vendor_usage_attempts_area_check'
  `);
  if (!String(constraint.rows[0]?.definition).includes("|discovery|enrichment"))
    throw new Error("Apply the native observation-label migration before this live check.");
  const title = values["broad-discovery"] ? "Software Engineer" : "Backend Engineer";
  console.log(
    JSON.stringify({
      prerequisitesPassed: true,
      execute: values.execute,
      title,
      location: values["broad-discovery"] ? null : source.location,
      providers: readiness.providers.map((p) => p.provider),
      maximumEnrichmentProfiles: 2,
      contactEnabled: false,
      costs: "unknown",
    }),
  );
  if (!values.execute) return;
  const jobId = `${key}_job`;
  await dbAdmin.transaction(async (tx) => {
    const [existing] = await tx.select().from(jobsTable).where(eq(jobsTable.id, jobId));
    if (existing) {
      if (
        existing.tenantId !== source.tenantId ||
        existing.createdById !== operator.id ||
        existing.title !== title ||
        existing.platformRecommendationsEnabled
      )
        throw new Error("Existing native pilot does not match; nothing will be overwritten.");
      return;
    }
    await tx.insert(jobsTable).values({
      ...source,
      id: jobId,
      workOrderNumber: `INTERNAL-${key.toUpperCase()}`,
      clientWorkOrderNumber: null,
      title,
      ...(values["broad-discovery"] ? { workType: "remote", location: null } : {}),
      description:
        "INTERNAL PROVIDER-ONLY PILOT. Not a real vacancy. No candidate contact or import.",
      internalMobility: false,
      platformRecommendationsEnabled: false,
      approvedById: operator.id,
      assignedRecruiterId: operator.id,
      assignedHiringManagerId: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    const profiles = await tx.select().from(icpTable).where(eq(icpTable.jobId, source.id));
    for (const profile of profiles) {
      if (profile.tenantId !== source.tenantId) throw new Error("Foreign source ICP.");
      await tx.insert(icpTable).values({
        ...profile,
        ...(values["broad-discovery"] ? { location: null } : {}),
        id: `${key}_icp_${profile.version}`,
        jobId,
        createdAt: new Date(),
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
      autoRun: false,
      targetCandidates: 2,
      interviewTypes: ["technical"],
    });
  });
  const scope = { jobId, tenantId: source.tenantId, actorId: operator.id, canApprove: true };
  const brief = await readBrief(dbAdmin, scope);
  const draft = await draftJourney(scope, {
    expectedBriefHash: brief.hash,
    idempotencyKey: `${key}:draft`,
  });
  await approveJourney(scope, draft.id, {
    expectedBriefHash: brief.hash,
    idempotencyKey: `${key}:approve-journey`,
  });
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${issueToken({ userId: operator.id, role: operator.role, tenantId: operator.tenantId })}`,
  };
  const endpoint = `${origin}/api/jobs/${jobId}/sourcing-controls`;
  const post = async (body: object) => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(210_000),
    });
    if (!response.ok)
      throw new Error(
        `Pilot command failed: HTTP ${response.status}; inspect saved records before retrying.`,
      );
    return response.json() as Promise<{ id: string; replayed?: boolean }>;
  };
  let [hold] = await dbAdmin
    .select()
    .from(sourcingReservationsTable)
    .where(
      and(
        eq(sourcingReservationsTable.jobId, jobId),
        eq(sourcingReservationsTable.tenantId, scope.tenantId),
      ),
    );
  if (!hold) {
    await post({
      action: "save",
      expectedRevision: 0,
      expectedBriefHash: brief.hash,
      idempotencyKey: `${key}:save`,
      limits: {
        allowExternal: true,
        providers: ["pdl", "serp", "enrichlayer"],
        maxCandidates: 2,
        maxDurationSeconds: 180,
        maxRuns: 1,
        runBudgetCents: 100,
        totalBudgetCents: 100,
      },
    });
    await post({
      action: "approve",
      expectedRevision: 1,
      expectedBriefHash: brief.hash,
      journeyId: draft.id,
      idempotencyKey: `${key}:approve-scope`,
    });
    const reserved = await post({
      action: "reserve",
      expectedRevision: 2,
      expectedBriefHash: brief.hash,
      idempotencyKey: `${key}:reserve`,
    });
    [hold] = await dbAdmin
      .select()
      .from(sourcingReservationsTable)
      .where(eq(sourcingReservationsTable.id, reserved.id));
  }
  if (!hold) throw new Error("Pilot reservation missing.");
  await post({
    action: "start_external",
    expectedRevision: hold.revision,
    reservationId: hold.id,
    idempotencyKey: `${key}:execute`,
  });
  const receipts = () =>
    dbAdmin
      .select()
      .from(vendorUsageAttemptsTable)
      .where(
        and(
          eq(vendorUsageAttemptsTable.tenantId, scope.tenantId),
          like(vendorUsageAttemptsTable.area, `workflow:sourcing-reservation-${hold.id}:%`),
        ),
      );
  const before = await receipts();
  const replay = await post({
    action: "start_external",
    expectedRevision: hold.revision,
    reservationId: hold.id,
    idempotencyKey: `${key}:replay-check`,
  });
  const after = await receipts();
  const runs = (await getNativeSourcingRuns(scope)).filter((r) => r.reservationId === hold.id);
  console.log(
    JSON.stringify({
      jobId,
      reservationId: hold.id,
      results: runs.map((r) => ({
        provider: r.provider,
        status: r.status,
        profileCount: r.profiles.length,
        reason: r.reason ?? null,
      })),
      receipts: after.map((r) => ({
        provider: r.provider,
        status: r.status,
        httpStatus: r.httpStatus,
        units: r.units,
        operationKey: r.units.observed_operation_key ?? null,
      })),
      replayed: replay.replayed,
      replayAddedRequests: after.length - before.length,
      actualCosts: "unknown",
      candidatesImported: 0,
      candidatesContacted: 0,
    }),
  );
}
main()
  .catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
