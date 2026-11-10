import { randomUUID } from "node:crypto";
import { and, eq, exists, or, sql } from "drizzle-orm";
import { z } from "zod";
import {
  dbAdmin,
  jobsTable,
  sourcingPoliciesTable as policies,
  candidatesTable as candidates,
  applicationsTable as applications,
  sourcedCandidatesTable as sourced,
  sourcingReservationsTable as holds,
  recruitingJourneysTable as journeys,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import {
  readBrief,
  fingerprint,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { nativeProfileUrl } from "./sourcing-native-provider-ports";
import { originFields } from "./sourcing-origin";
import {
  NATIVE_DISCOVERY_ACTION,
  NATIVE_IMPORT_ACTION,
  NativeDiscoveryRecord,
  NativeImportRecord,
  NativeImportInput,
} from "./sourcing-native-records";

type Transaction = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Transaction | typeof dbAdmin;

/** Human admission only. This never calls providers, scores, advances or contacts. */
export async function importNativeProfile(
  scope: WorkflowScope,
  input: z.infer<typeof NativeImportInput>,
  handle: Handle = dbAdmin,
) {
  input = NativeImportInput.parse(input);
  if (!scope.canApprove) throw new WorkflowConflict("Administrator approval required.", 403);
  if (nativeProfileUrl(input.profileUrl) !== input.profileUrl)
    throw new WorkflowConflict("Choose a canonical saved discovery profile.");
  const identity = input.profileUrl.toLowerCase();
  const inputHash = fingerprint({
    reservationId: input.reservationId,
    operationId: input.operationId,
    profileUrl: input.profileUrl,
    fullName: input.fullName,
  });
  return handle.transaction(async (tx) => {
    // Use the same job-first lock order as sourcing-control commands.
    await tx
      .select({ id: jobsTable.id })
      .from(jobsTable)
      .where(and(eq(jobsTable.id, scope.jobId), eq(jobsTable.tenantId, scope.tenantId)))
      .for("update");
    const [hold] = await tx
      .select()
      .from(holds)
      .where(
        and(
          eq(holds.id, input.reservationId),
          eq(holds.jobId, scope.jobId),
          eq(holds.tenantId, scope.tenantId),
        ),
      )
      .for("update");
    if (!hold) throw new WorkflowConflict("Not found", 404);
    const current = await readBrief(tx, scope);
    if (
      current.job.status !== "active" ||
      !current.job.approvedById ||
      current.job.internalMobility ||
      current.hash !== input.expectedBriefHash ||
      hold.briefHash !== current.hash
    )
      throw new WorkflowConflict("The approved external sourcing scope changed; review it first.");
    const [policy] = await tx
      .select()
      .from(policies)
      .where(and(eq(policies.jobId, scope.jobId), eq(policies.tenantId, scope.tenantId)));
    if (!policy || policy.status !== "approved" || policy.revision !== hold.policyRevision)
      throw new WorkflowConflict("Review and approve the current sourcing policy first.");
    const [journey] = await tx
      .select()
      .from(journeys)
      .where(
        and(
          eq(journeys.id, hold.journeyId!),
          eq(journeys.jobId, scope.jobId),
          eq(journeys.tenantId, scope.tenantId),
        ),
      );
    if (
      !journey ||
      journey.status !== "approved" ||
      journey.briefHash !== current.hash ||
      !hold.limits.allowExternal ||
      hold.status === "cancelled" ||
      hold.status === "paused"
    )
      throw new WorkflowConflict("External sourcing approval is not current.");
    const imports = (
      await tx
        .select({ note: events.note })
        .from(events)
        .where(
          and(
            eq(events.jobId, scope.jobId),
            eq(events.tenantId, scope.tenantId),
            eq(events.action, NATIVE_IMPORT_ACTION),
            sql`${events.note}::jsonb->>'reservationId' = ${hold.id}`,
          ),
        )
    ).map((row) => NativeImportRecord.parse(JSON.parse(row.note!)));
    const replay = imports.find((r) => r.idempotencyKey === input.idempotencyKey);
    if (replay) {
      if (replay.inputHash !== inputHash)
        throw new WorkflowConflict("Request key was already used for a different selection.");
      return { id: replay.candidateId, replayed: true, autonomyExecutionEnabled: false as const };
    }
    if (hold.revision !== input.expectedRevision)
      throw new WorkflowConflict("Refresh the sourcing run before adding this profile.");
    const records = await tx
      .select({ note: events.note })
      .from(events)
      .where(
        and(
          eq(events.jobId, scope.jobId),
          eq(events.tenantId, scope.tenantId),
          eq(events.action, NATIVE_DISCOVERY_ACTION),
          sql`${events.note}::jsonb->>'operationId' = ${input.operationId}`,
        ),
      );
    const record = records
      .map((r) => NativeDiscoveryRecord.parse(JSON.parse(r.note!)))
      .find(
        (r) =>
          r.reservationId === hold.id &&
          r.status === "succeeded" &&
          (r.provider === "pdl" || r.provider === "serp") &&
          r.profiles.some((p) => p.url === input.profileUrl),
      );
    if (!record || !hold.limits.providers.includes(record.provider))
      throw new WorkflowConflict("Select a profile from this run's successful discovery results.");
    const prior = imports.find((r) => r.profileUrl.toLowerCase() === identity);
    if (prior)
      return { id: prior.candidateId, replayed: true, autonomyExecutionEnabled: false as const };
    if (imports.length >= hold.limits.maxCandidates)
      throw new WorkflowConflict("The approved shortlist size has been reached.");
    const profile = record.profiles.find((p) => p.url === input.profileUrl)!;
    // Canonical URL is the stable effect identity, not a caller request key.
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${scope.tenantId}), hashtext(${identity}))`,
    );
    const bareIdentity = identity.replace("https://www.", "");
    const [existing] = await tx
      .select()
      .from(candidates)
      .where(
        and(
          eq(candidates.tenantId, scope.tenantId),
          sql`regexp_replace(regexp_replace(regexp_replace(lower(${candidates.linkedinUrl}), '^https?://(www\\.)?', ''), '[?#].*$', ''), '/+$', '') = ${bareIdentity}`,
        ),
      )
      .for("update");
    if (
      existing &&
      (existing.pool !== "tenant" ||
        existing.doNotContact ||
        existing.dataErasedAt ||
        existing.isCurrentEmployee)
    )
      throw new WorkflowConflict("This profile cannot be added to this sourcing scope.");
    const words = input.fullName.trim().split(/\s+/);
    const candidateId = existing?.id ?? randomUUID();
    if (!existing)
      await tx.insert(candidates).values({
        id: candidateId,
        tenantId: scope.tenantId,
        firstName: words[0],
        lastName: words.slice(1).join(" "),
        email: `${candidateId}@import.local`,
        linkedinUrl: input.profileUrl,
        source: record.provider,
        pool: "tenant",
        createdById: scope.actorId,
        skills: [],
      });
    const [source] = await tx
      .select({ id: sourced.id })
      .from(sourced)
      .where(
        and(eq(sourced.tenantId, scope.tenantId), eq(sourced.normalizedCandidateId, candidateId)),
      )
      .limit(1);
    const sourceId = source?.id ?? randomUUID();
    if (!source)
      await tx.insert(sourced).values({
        id: sourceId,
        tenantId: scope.tenantId,
        normalizedCandidateId: candidateId,
        source: record.provider as "pdl" | "serp",
        rawData: {
          jobId: scope.jobId,
          name: input.fullName,
          linkedinUrl: input.profileUrl,
          profileUrl: input.profileUrl,
          summary: profile.snippet,
          stage: "sourced",
          humanReviewed: true,
          nativeDiscovery: { reservationId: hold.id, operationId: input.operationId },
        },
      });
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${scope.jobId}), hashtext(${candidateId}))`,
    );
    const [application] = await tx
      .select({ id: applications.id })
      .from(applications)
      .where(
        and(
          or(
            eq(applications.tenantId, scope.tenantId),
            exists(
              tx
                .select({ id: jobsTable.id })
                .from(jobsTable)
                .where(
                  and(eq(jobsTable.id, applications.jobId), eq(jobsTable.tenantId, scope.tenantId)),
                ),
            ),
          ),
          eq(applications.jobId, scope.jobId),
          eq(applications.candidateId, candidateId),
        ),
      )
      .limit(1);
    if (!application)
      await tx.insert(applications).values({
        tenantId: scope.tenantId,
        jobId: scope.jobId,
        candidateId,
        stage: "sourced",
        matchScore: null,
        ...originFields(
          "ai_sourcing",
          {
            provider: record.provider,
            reservationId: hold.id,
            operationId: input.operationId,
            profileUrl: input.profileUrl,
            humanReviewed: true,
          },
          scope.actorId,
        ),
      });
    await tx.insert(events).values({
      tenantId: scope.tenantId,
      jobId: scope.jobId,
      journeyId: hold.journeyId,
      actorId: scope.actorId,
      action: NATIVE_IMPORT_ACTION,
      note: JSON.stringify(
        NativeImportRecord.parse({
          reservationId: hold.id,
          operationId: input.operationId,
          profileUrl: input.profileUrl,
          candidateId,
          sourceId,
          idempotencyKey: input.idempotencyKey,
          inputHash,
        }),
      ),
    });
    return { id: candidateId, replayed: false, autonomyExecutionEnabled: false as const };
  });
}
