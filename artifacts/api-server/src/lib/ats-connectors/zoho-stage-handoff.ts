import { randomUUID } from "node:crypto";
import { and, eq, asc } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  jobsTable,
  candidatesTable,
  interviewSessionsTable,
  interviewSummariesTable,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
  zohoStageMappingsTable as mappings,
  zohoStageHandoffEventsTable as events,
} from "@workspace/db";
import type { z } from "zod/v4";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import type { ZohoActor } from "./zoho-oauth-store";
import { zohoCampaignReviews } from "./zoho-campaign-reviews";
import { campaignById, type CampaignTx } from "./zoho-interview-campaigns";
import { CalendarError } from "../outlook-calendar-core";
import { fingerprint } from "../recruiting-workflows";
import {
  emptyMapping,
  handoffReadiness,
  stageMappingInput,
  stageHandoffInput,
} from "./zoho-stage-handoff-policy";

const unavailable = () =>
  new CalendarError(404, "not_found", "This interview handoff is unavailable.");
const conflict = () =>
  new CalendarError(
    409,
    "handoff_conflict",
    "The mapping or human decision changed. Reload, review and confirm again.",
  );
type Handle = Pick<typeof dbAdmin, "select">;

/** Local preparation only: this module has no provider client, token access or live executor. */
export function zohoStageHandoff({ actorLookup = zohoEmployerAdmin } = {}) {
  const reviewService = zohoCampaignReviews({ actorLookup });
  async function authorize(actor: ZohoActor) {
    const current = await actorLookup(actor.id);
    if (current.id !== actor.id || current.tenantId !== actor.tenantId) throw unavailable();
  }
  async function mapping(actor: ZohoActor, campaignId: string, handle: Handle = dbAdmin) {
    const [row] = await handle
      .select()
      .from(mappings)
      .where(and(eq(mappings.campaignId, campaignId), eq(mappings.tenantId, actor.tenantId)));
    return row
      ? {
          revision: row.revision,
          advance: row.advance,
          hold: row.hold,
          decline: row.decline,
          updatedAt: row.updatedAt.toISOString(),
          updatedBy: row.updatedBy,
        }
      : emptyMapping(campaignId);
  }
  async function current(
    actor: ZohoActor,
    campaignId: string,
    recipientId: string,
    handle: Handle = dbAdmin,
  ) {
    // Canonical review authorization includes current privacy, DNC and exact session binding.
    const review = await reviewService.detail(actor, campaignId, recipientId);
    const campaign = await campaignById(actor, campaignId);
    const [recipient] = await handle
      .select()
      .from(recipients)
      .where(
        and(
          eq(recipients.id, recipientId),
          eq(recipients.campaignId, campaignId),
          eq(recipients.tenantId, actor.tenantId),
        ),
      );
    if (
      !recipient?.candidateId ||
      !recipient.externalApplicationId ||
      !recipient.externalCandidateId
    )
      throw unavailable();
    const map = await mapping(actor, campaignId, handle);
    const readiness = handoffReadiness(review, map);
    const revision = fingerprint({
      campaignId,
      recipientId,
      review: review.revision,
      mapping: map.revision,
      application: recipient.externalApplicationId,
      candidate: recipient.externalCandidateId,
      job: campaign.externalJobId,
    });
    return { review, campaign, recipient, map, readiness, revision };
  }
  async function detail(actor: ZohoActor, campaignId: string, recipientId: string) {
    await authorize(actor);
    const c = await current(actor, campaignId, recipientId);
    const history = await dbAdmin
      .select()
      .from(events)
      .where(
        and(
          eq(events.tenantId, actor.tenantId),
          eq(events.campaignId, campaignId),
          eq(events.recipientId, recipientId),
        ),
      )
      .orderBy(asc(events.createdAt), asc(events.id));
    return {
      campaignId,
      recipientId,
      applicationId: c.recipient.externalApplicationId,
      externalJobId: c.campaign.externalJobId,
      externalCandidateId: c.recipient.externalCandidateId,
      revision: c.revision,
      mapping: c.map,
      ...c.readiness,
      liveEnabled: false,
      history: history.map((e) => ({
        id: e.id,
        state: "simulated" as const,
        targetStatus: e.targetStatus,
        decision: e.decision as "advance" | "hold" | "decline",
        approvedBy: e.approvedBy,
        createdAt: e.createdAt.toISOString(),
      })),
    };
  }
  async function lock(actor: ZohoActor, campaignId: string, tx: CampaignTx) {
    const [user] = await tx
      .select()
      .from(usersTable)
      .where(and(eq(usersTable.id, actor.id), eq(usersTable.tenantId, actor.tenantId)))
      .for("share");
    if (!user || user.role !== "tenant_admin" || user.status !== "active" || user.accountErasedAt)
      throw unavailable();
    const [campaign] = await tx
      .select()
      .from(campaigns)
      .where(and(eq(campaigns.id, campaignId), eq(campaigns.tenantId, actor.tenantId)))
      .for("update");
    if (!campaign) throw unavailable();
    return campaign;
  }
  return {
    detail,
    async saveMapping(
      actor: ZohoActor,
      campaignId: string,
      input: z.infer<typeof stageMappingInput>,
    ) {
      input = stageMappingInput.parse(input);
      await authorize(actor);
      await campaignById(actor, campaignId);
      await dbAdmin.transaction(async (tx) => {
        await lock(actor, campaignId, tx);
        const previous = await mapping(actor, campaignId, tx);
        if (previous.revision !== input.expectedRevision) throw conflict();
        const values = {
          tenantId: actor.tenantId,
          advance: input.advance,
          hold: input.hold,
          decline: input.decline,
          revision: fingerprint({
            previous: previous.revision,
            actor: actor.id,
            nonce: randomUUID(),
            ...input,
          }),
          updatedBy: actor.id,
          updatedAt: new Date(),
        };
        await tx
          .insert(mappings)
          .values({ campaignId, ...values })
          .onConflictDoUpdate({ target: mappings.campaignId, set: values });
      });
      return mapping(actor, campaignId);
    },
    async simulate(
      actor: ZohoActor,
      campaignId: string,
      recipientId: string,
      input: z.infer<typeof stageHandoffInput>,
    ) {
      // Validate again even for internal callers; a caller cannot inject live mode.
      input = stageHandoffInput.parse(input);
      await authorize(actor);
      const requestHash = fingerprint({ actor: actor.id, campaignId, recipientId, ...input });
      await dbAdmin.transaction(async (tx) => {
        const campaign = await lock(actor, campaignId, tx);
        const [recipient] = await tx
          .select()
          .from(recipients)
          .where(
            and(
              eq(recipients.id, recipientId),
              eq(recipients.campaignId, campaignId),
              eq(recipients.tenantId, actor.tenantId),
            ),
          )
          .for("update");
        if (!recipient?.candidateId || !recipient.sessionId) throw unavailable();
        await tx
          .select({ id: candidatesTable.id })
          .from(candidatesTable)
          .where(
            and(
              eq(candidatesTable.id, recipient.candidateId),
              eq(candidatesTable.tenantId, actor.tenantId),
            ),
          )
          .for("share");
        await tx
          .select({ id: jobsTable.id })
          .from(jobsTable)
          .where(and(eq(jobsTable.id, campaign.jobId), eq(jobsTable.tenantId, actor.tenantId)))
          .for("share");
        await tx
          .select({ id: interviewSessionsTable.id })
          .from(interviewSessionsTable)
          .where(
            and(
              eq(interviewSessionsTable.id, recipient.sessionId),
              eq(interviewSessionsTable.tenantId, actor.tenantId),
            ),
          )
          .for("share");
        await tx
          .select({ id: interviewSummariesTable.id })
          .from(interviewSummariesTable)
          .innerJoin(
            interviewSessionsTable,
            eq(interviewSessionsTable.id, interviewSummariesTable.interviewSessionId),
          )
          .where(
            and(
              eq(interviewSessionsTable.id, recipient.sessionId),
              eq(interviewSessionsTable.tenantId, actor.tenantId),
            ),
          )
          .for("share", { of: interviewSummariesTable });
        const c = await current(actor, campaignId, recipientId, tx);
        const [prior] = await tx
          .select()
          .from(events)
          .where(and(eq(events.tenantId, actor.tenantId), eq(events.requestId, input.requestId)));
        if (prior) {
          if (prior.requestHash !== requestHash) throw conflict();
          return;
        }
        if (
          c.revision !== input.expectedRevision ||
          !c.readiness.ready ||
          !c.readiness.decision ||
          !c.readiness.targetStatus
        )
          throw conflict();
        const [duplicate] = await tx
          .select()
          .from(events)
          .where(
            and(
              eq(events.tenantId, actor.tenantId),
              eq(events.recipientId, recipientId),
              eq(events.reviewRevision, c.review.revision),
              eq(events.mappingRevision, c.map.revision),
            ),
          );
        if (duplicate) return;
        await tx.insert(events).values({
          id: randomUUID(),
          tenantId: actor.tenantId,
          campaignId,
          recipientId,
          candidateId: recipient.candidateId,
          requestId: input.requestId,
          requestHash,
          reviewRevision: c.review.revision,
          mappingRevision: c.map.revision,
          decision: c.readiness.decision,
          targetStatus: c.readiness.targetStatus,
          state: "simulated",
          approvedBy: actor.id,
        });
      });
      return detail(actor, campaignId, recipientId);
    },
  };
}
