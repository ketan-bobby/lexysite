import { randomUUID } from "node:crypto";
import { and, eq, desc, inArray, sql } from "drizzle-orm";
import {
  dbAdmin,
  jobsTable,
  interviewPlansTable as plans,
  interviewSessionsTable as sessions,
  zohoImportedJobsTable as importedJobs,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
} from "@workspace/db";
import { zohoReviewedImport } from "./zoho-reviewed-import";
import { zohoIntakeFailure } from "./zoho-intake-record";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import type { ZohoActor } from "./zoho-oauth-store";
import { fingerprint } from "../recruiting-workflows";
import { campaignBrief, campaignRecipients, campaignClaimStates } from "./zoho-campaign-policy";
import type { z } from "zod/v4";
import type { campaignSelection, campaignAction } from "./zoho-campaign-policy";
import { CalendarError } from "../outlook-calendar-core";
import { campaignDeliveryEvidence } from "./zoho-campaign-delivery-evidence";

export type CampaignTx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
export type Campaign = typeof campaigns.$inferSelect;
export async function campaignJob(
  actor: ZohoActor,
  jobId: string,
  planId: string,
  handle: Pick<typeof dbAdmin, "select"> = dbAdmin,
) {
  const [job] = await handle
    .select()
    .from(jobsTable)
    .where(and(eq(jobsTable.id, jobId), eq(jobsTable.tenantId, actor.tenantId)));
  const [plan] = await handle
    .select()
    .from(plans)
    .where(and(eq(plans.id, planId), eq(plans.tenantId, actor.tenantId), eq(plans.jobId, jobId)));
  if (
    !job ||
    job.status !== "active" ||
    !plan ||
    !Array.isArray(plan.questions) ||
    !plan.questions.length
  )
    throw zohoIntakeFailure(
      "Choose an approved imported job with an existing, nonempty interview plan.",
    );
  return { job, plan, hash: campaignBrief(job, plan) };
}
export async function campaignById(
  actor: ZohoActor,
  id: string,
  tx: CampaignTx | typeof dbAdmin = dbAdmin,
) {
  const [row] = await tx
    .select()
    .from(campaigns)
    .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, actor.tenantId)));
  if (!row) throw new CalendarError(404, "not_found", "Campaign not found.");
  return row;
}
async function summary(row: Campaign) {
  const rows = await dbAdmin
    .select({ state: recipients.state, count: sql<number>`count(*)::int` })
    .from(recipients)
    .where(
      and(
        eq(recipients.campaignId, row.id),
        eq(recipients.tenantId, row.tenantId),
        eq(recipients.accountRef, row.accountRef),
        eq(recipients.externalJobId, row.externalJobId),
      ),
    )
    .groupBy(recipients.state);
  return {
    id: row.id,
    jobId: row.jobId,
    externalJobId: row.externalJobId,
    planId: row.planId,
    state: row.state,
    snapshotHash: row.snapshotHash,
    applicationCount: row.applicationCount,
    recipientCount: rows.reduce((n, r) => n + r.count, 0),
    counts: rows,
    createdAt: row.createdAt,
  };
}
export function zohoInterviewCampaigns({
  source = () => zohoReviewedImport(),
  actorLookup = zohoEmployerAdmin,
  dispatchLane = "live" as "live" | "isolated_test",
} = {}) {
  async function current(actor: ZohoActor) {
    const resolved = await actorLookup(actor.id);
    if (resolved.id !== actor.id || resolved.tenantId !== actor.tenantId) throw zohoIntakeFailure();
  }
  async function detail(actor: ZohoActor, id: string) {
    await current(actor);
    const row = await campaignById(actor, id);
    const rows = await dbAdmin
      .select({
        id: recipients.id,
        applicationId: recipients.externalApplicationId,
        candidateId: recipients.externalCandidateId,
        state: recipients.state,
        reason: recipients.reason,
        messageId: recipients.messageId,
        updatedAt: recipients.updatedAt,
        sessionId: recipients.sessionId,
        interviewStatus: sessions.status,
      })
      .from(recipients)
      .leftJoin(
        sessions,
        and(eq(sessions.id, recipients.sessionId), eq(sessions.tenantId, actor.tenantId)),
      )
      .where(
        and(
          eq(recipients.campaignId, id),
          eq(recipients.tenantId, actor.tenantId),
          eq(recipients.accountRef, row.accountRef),
          eq(recipients.externalJobId, row.externalJobId),
        ),
      )
      .orderBy(recipients.id);
    return {
      campaign: await summary(row),
      recipients: rows.map(({ messageId, updatedAt, ...recipient }) => ({
        ...recipient,
        deliveryEvidence: campaignDeliveryEvidence({ ...recipient, messageId, updatedAt }),
      })),
    };
  }
  return {
    detail,
    async workspace(actor: ZohoActor) {
      await current(actor);
      const rows = await dbAdmin
        .select({ mapping: importedJobs, job: jobsTable })
        .from(importedJobs)
        .innerJoin(
          jobsTable,
          and(eq(jobsTable.id, importedJobs.jobId), eq(jobsTable.tenantId, actor.tenantId)),
        )
        .where(and(eq(importedJobs.tenantId, actor.tenantId), eq(jobsTable.status, "active")));
      const jobPlans = await dbAdmin.select().from(plans).where(eq(plans.tenantId, actor.tenantId));
      const allCampaigns = await dbAdmin
        .select()
        .from(campaigns)
        .where(eq(campaigns.tenantId, actor.tenantId))
        .orderBy(desc(campaigns.createdAt))
        .limit(20);
      const frozen = new Set(allCampaigns.map((r) => r.frozenPlanId).filter(Boolean));
      return {
        jobs: rows.map(({ mapping, job }) => ({
          id: job.id,
          title: job.title,
          externalJobId: mapping.externalJobId,
          plans: jobPlans
            .filter(
              (p) =>
                p.jobId === job.id &&
                !frozen.has(p.id) &&
                Array.isArray(p.questions) &&
                p.questions.length > 0,
            )
            .map((p) => ({
              id: p.id,
              title: p.title,
              language: p.language,
              questionCount: (p.questions as unknown[]).length,
            })),
        })),
        campaigns: await Promise.all(allCampaigns.map(summary)),
      };
    },
    async create(actor: ZohoActor, input: z.infer<typeof campaignSelection>) {
      await current(actor);
      const [prior] = await dbAdmin
        .select()
        .from(campaigns)
        .where(
          and(eq(campaigns.tenantId, actor.tenantId), eq(campaigns.requestId, input.requestId)),
        );
      if (prior) {
        if (
          prior.jobId !== input.jobId ||
          prior.planId !== input.planId ||
          prior.revision !== input.revision ||
          prior.dispatchLane !== dispatchLane
        )
          throw zohoIntakeFailure("That request belongs to a different campaign selection.");
        return detail(actor, prior.id);
      }
      const { job, plan, hash } = await campaignJob(actor, input.jobId, input.planId);
      const connection = await source().campaignSource(actor, input.revision);
      const [mapping] = await dbAdmin
        .select()
        .from(importedJobs)
        .where(
          and(
            eq(importedJobs.tenantId, actor.tenantId),
            eq(importedJobs.jobId, job.id),
            eq(importedJobs.accountRef, connection.accountRef),
          ),
        );
      if (!mapping)
        throw zohoIntakeFailure("This local job is not linked to the current Zoho account.");
      const snapshot = await connection.snapshot(mapping.externalJobId);
      const selected = campaignRecipients(snapshot.applications);
      if (!selected.length)
        throw zohoIntakeFailure("Zoho returned no verified applicants. No campaign was created.");
      const id = randomUUID();
      await dbAdmin.transaction(async (tx) => {
        await connection.lockCurrent(tx);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${actor.tenantId}`},0))`,
        );
        const latest = await campaignJob(actor, job.id, plan.id);
        if (latest.hash !== hash)
          throw zohoIntakeFailure("Job or interview plan changed. Review again.");
        const inserted = await tx
          .insert(campaigns)
          .values({
            id,
            tenantId: actor.tenantId,
            dispatchLane,
            accountRef: connection.accountRef,
            revision: input.revision,
            jobId: job.id,
            externalJobId: mapping.externalJobId,
            planId: plan.id,
            requestId: input.requestId,
            briefHash: hash,
            createdBy: actor.id,
            applicationCount: snapshot.applications.length,
            snapshotHash: fingerprint({
              job: snapshot.job,
              applications: [...snapshot.applications].sort((a, b) =>
                a.applicationId.localeCompare(b.applicationId),
              ),
              brief: hash,
            }),
          })
          .onConflictDoNothing()
          .returning();
        if (!inserted.length) return;
        // Store no contact fields or provider payloads in the campaign snapshot.
        await tx.insert(recipients).values(
          selected.map((app) => ({
            id: randomUUID(),
            campaignId: id,
            tenantId: actor.tenantId,
            accountRef: connection.accountRef,
            externalJobId: mapping.externalJobId,
            externalApplicationId: app.applicationId,
            externalCandidateId: app.candidateId,
            state: "draft",
          })),
        );
      });
      const [saved] = await dbAdmin
        .select()
        .from(campaigns)
        .where(
          and(eq(campaigns.tenantId, actor.tenantId), eq(campaigns.requestId, input.requestId)),
        );
      if (!saved || saved.dispatchLane !== dispatchLane) throw zohoIntakeFailure();
      return detail(actor, saved.id);
    },
    async act(actor: ZohoActor, id: string, input: z.infer<typeof campaignAction>) {
      await current(actor);
      const before = await campaignById(actor, id);
      if (before.snapshotHash !== input.snapshotHash)
        throw zohoIntakeFailure("The campaign snapshot changed.");
      const connection =
        input.action === "approve" ? await source().campaignSource(actor, before.revision) : null;
      if (connection && connection.accountRef !== before.accountRef) throw zohoIntakeFailure();
      await dbAdmin.transaction(async (tx) => {
        if (connection) await connection.lockCurrent(tx);
        await tx.execute(
          sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${actor.tenantId}`},0))`,
        );
        const [row] = await tx
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.id, id), eq(campaigns.tenantId, actor.tenantId)))
          .for("update");
        if (!row || row.snapshotHash !== input.snapshotHash) throw zohoIntakeFailure();
        if (input.action === "cancel") {
          await tx.update(campaigns).set({ state: "cancelled" }).where(eq(campaigns.id, id));
          await tx
            .update(recipients)
            .set({ state: "cancelled", updatedAt: new Date() })
            .where(
              and(
                eq(recipients.campaignId, id),
                eq(recipients.tenantId, actor.tenantId),
                inArray(recipients.state, ["draft", "queued"]),
              ),
            );
          return;
        }
        if (row.state === "approved") return;
        if (row.state !== "draft")
          throw zohoIntakeFailure("Cancelled campaigns cannot be approved.");
        const { plan, hash } = await campaignJob(actor, row.jobId, row.planId);
        if (hash !== row.briefHash)
          throw zohoIntakeFailure("Job or plan changed. Create a fresh campaign.");
        const frozenId = randomUUID();
        await tx.insert(plans).values({
          ...plan,
          id: frozenId,
          title: `${plan.title} · ATS campaign`,
          createdAt: new Date(),
        });
        const drafts = await tx
          .select()
          .from(recipients)
          .where(and(eq(recipients.campaignId, id), eq(recipients.tenantId, actor.tenantId)));
        for (const recipient of drafts) {
          const [claim] = await tx
            .select({ id: recipients.id })
            .from(recipients)
            .where(
              and(
                eq(recipients.tenantId, actor.tenantId),
                eq(recipients.accountRef, row.accountRef),
                eq(recipients.externalJobId, row.externalJobId),
                eq(recipients.externalCandidateId, recipient.externalCandidateId),
                inArray(recipients.state, campaignClaimStates),
              ),
            );
          await tx
            .update(recipients)
            .set({
              state: claim ? "skipped" : "queued",
              reason: claim ? "already_in_campaign" : null,
              updatedAt: new Date(),
            })
            .where(and(eq(recipients.id, recipient.id), eq(recipients.tenantId, actor.tenantId)));
        }
        await tx
          .update(campaigns)
          .set({
            state: "approved",
            approvedBy: actor.id,
            approvedAt: new Date(),
            frozenPlanId: frozenId,
          })
          .where(eq(campaigns.id, id));
      });
      return detail(actor, id);
    },
  };
}
