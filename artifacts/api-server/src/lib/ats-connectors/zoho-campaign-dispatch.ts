import { randomUUID } from "node:crypto";
import { and, eq, inArray, lt, sql } from "drizzle-orm";
import {
  dbAdmin,
  candidatesTable as people,
  atsCandidateProfilesTable as profiles,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
  interviewSessionsTable as sessions,
  interviewPlansTable as plans,
  jobsTable,
  tenantAiBrandProfilesTable as brands,
} from "@workspace/db";
import { zohoReviewedImport } from "./zoho-reviewed-import";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import { campaignJob, type CampaignTx } from "./zoho-interview-campaigns";
import { campaignDelivery } from "./zoho-campaign-policy";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "../../routes/candidates";
import { hasBoundInvitationWorkflow } from "../workflow-contact-gates";
import { buildMessageContext } from "../ai-message-context";
import { sendEmail } from "../email";
import { inviteEmailHtml } from "../interview-invite-copy";
import { interviewRoomUrl } from "../interview-link-url";
import { fingerprint } from "../recruiting-workflows";
import { logger } from "../logger";

class CampaignBlock extends Error {
  constructor(public code: string) {
    super(code);
  }
}
const block = (code: string): never => {
  throw new CampaignBlock(code);
};
const defaultSource = () => zohoReviewedImport();
type Recipient = typeof recipients.$inferSelect;
async function allowed(person: typeof people.$inferSelect, tenantId: string) {
  return (
    person.pool === "tenant" &&
    !person.doNotContact &&
    !person.dataErasedAt &&
    (await applyCandidatePrivacyFilter(applyCandidateHardExclusions([person]), tenantId)).length ===
      1
  );
}
async function fence(tx: CampaignTx, r: Recipient, email: string) {
  const [row] = (
    await tx.execute(sql`SELECT EXISTS(
    SELECT 1 FROM candidate_erasure_tombstones WHERE subject_id='ats-profile:' ||
    md5(jsonb_build_array(${r.tenantId}::text,'zoho_recruit'::text,
      ${r.accountRef}::text,${r.externalCandidateId}::text)::text)
  ) OR public.lexy_erasure_job_blocked(${JSON.stringify({ email, candidateEmail: email })}::jsonb,NULL::text) AS blocked`)
  ).rows;
  if (row?.blocked !== false) block("privacy_or_erasure");
}
export function zohoCampaignDispatcher({
  source = defaultSource,
  actorLookup = zohoEmployerAdmin,
  send = sendEmail,
  context = buildMessageContext,
  tenantId = undefined as string | undefined,
  dispatchLane = "live" as "live" | "isolated_test",
} = {}) {
  if (
    dispatchLane === "isolated_test" &&
    (!tenantId || send === sendEmail || source === defaultSource)
  ) {
    throw new Error(
      "Isolated campaign dispatch requires a tenant and injected source and delivery.",
    );
  }
  async function state(r: Recipient, next: string, reason: string | null) {
    await dbAdmin
      .update(recipients)
      .set({ state: next, reason, updatedAt: new Date() })
      .where(
        and(
          eq(recipients.id, r.id),
          eq(recipients.tenantId, r.tenantId),
          inArray(recipients.state, ["preparing", "sending"]),
        ),
      );
  }
  return {
    async tick() {
      // A lost process may have sent already. Never reclaim these as queued.
      await dbAdmin
        .update(recipients)
        .set({ state: "review_required", reason: "interrupted_attempt", updatedAt: new Date() })
        .where(
          and(
            inArray(recipients.state, ["preparing", "sending"]),
            tenantId ? eq(recipients.tenantId, tenantId) : undefined,
            sql`EXISTS (SELECT 1 FROM ${campaigns}
              WHERE ${campaigns.id} = ${recipients.campaignId}
                AND ${campaigns.tenantId} = ${recipients.tenantId}
                AND ${campaigns.dispatchLane} = ${dispatchLane})`,
            lt(recipients.updatedAt, new Date(Date.now() - 10 * 60_000)),
          ),
        );
      const r = await dbAdmin.transaction(async (tx) => {
        const [next] = await tx
          .select({ r: recipients })
          .from(recipients)
          .innerJoin(
            campaigns,
            and(
              eq(campaigns.id, recipients.campaignId),
              eq(campaigns.tenantId, recipients.tenantId),
            ),
          )
          .where(
            and(
              eq(recipients.state, "queued"),
              eq(campaigns.state, "approved"),
              eq(campaigns.dispatchLane, dispatchLane),
              tenantId ? eq(recipients.tenantId, tenantId) : undefined,
            ),
          )
          .orderBy(recipients.updatedAt)
          .limit(1)
          .for("update", { of: recipients, skipLocked: true });
        if (!next) return null;
        const [claimed] = await tx
          .update(recipients)
          .set({ state: "preparing", updatedAt: new Date() })
          .where(
            and(
              eq(recipients.id, next.r.id),
              eq(recipients.tenantId, next.r.tenantId),
              eq(recipients.state, "queued"),
            ),
          )
          .returning();
        return claimed;
      });
      if (!r) return false;
      let attempted = false;
      try {
        const [campaign] = await dbAdmin
          .select()
          .from(campaigns)
          .where(and(eq(campaigns.id, r.campaignId), eq(campaigns.tenantId, r.tenantId)));
        if (!campaign?.approvedBy || campaign.state !== "approved") block("campaign_cancelled");
        const actor = await actorLookup(campaign.approvedBy);
        if (actor.tenantId !== r.tenantId) block("authority_changed");
        const connection = await source().campaignSource(actor, campaign.revision);
        if (connection.accountRef !== r.accountRef) block("account_changed");
        const fields = await connection.candidate(
          r.externalJobId,
          r.externalApplicationId,
          r.externalCandidateId,
        );
        const ctx = await context({ tenantId: r.tenantId, jobId: campaign.jobId });
        if (!ctx.aiMessagingEnabled) block("messaging_disabled");
        const prepared = await dbAdmin.transaction(async (tx) => {
          await connection.lockCurrent(tx);
          await tx.execute(
            sql`SELECT pg_advisory_xact_lock(hashtextextended(${`ats-employer:${r.tenantId}`},0))`,
          );
          const [current] = await tx
            .select()
            .from(campaigns)
            .where(and(eq(campaigns.id, campaign.id), eq(campaigns.tenantId, r.tenantId)))
            .for("share");
          if (current?.state !== "approved") block("campaign_cancelled");
          const { job, hash } = await campaignJob(actor, campaign.jobId, campaign.planId, tx);
          if (hash !== campaign.briefHash) block("job_or_plan_changed");
          const [plan] = await tx
            .select()
            .from(plans)
            .where(
              and(
                eq(plans.id, campaign.frozenPlanId!),
                eq(plans.tenantId, r.tenantId),
                eq(plans.jobId, job.id),
              ),
            );
          if (!plan || !Array.isArray(plan.questions) || !plan.questions.length)
            block("plan_unavailable");
          await fence(tx, r, fields.email!);
          const [mapping] = await tx
            .select()
            .from(profiles)
            .where(
              and(
                eq(profiles.tenantId, r.tenantId),
                eq(profiles.system, "zoho_recruit"),
                eq(profiles.accountRef, r.accountRef),
                eq(profiles.externalCandidateId, r.externalCandidateId),
              ),
            );
          const matches = await tx
            .select()
            .from(people)
            .where(
              and(
                eq(people.tenantId, r.tenantId),
                eq(sql<string>`lower(btrim(${people.email}))`, fields.email!),
              ),
            );
          if (!mapping && matches.length) block("identity_link_required");
          if (mapping && matches.some((p) => p.id !== mapping.candidateId))
            block("identity_conflict");
          let person: typeof people.$inferSelect;
          if (mapping) {
            const [existing] = await tx
              .select()
              .from(people)
              .where(and(eq(people.id, mapping.candidateId), eq(people.tenantId, r.tenantId)))
              .for("update");
            if (
              !existing ||
              existing.email.trim().toLowerCase() !== fields.email ||
              !(await allowed(existing, r.tenantId))
            )
              block("privacy_or_identity");
            person = existing;
          } else {
            [person] = await tx
              .insert(people)
              .values({
                id: randomUUID(),
                tenantId: r.tenantId,
                firstName: fields.firstName!,
                lastName: fields.lastName!,
                email: fields.email!,
                pool: "tenant",
                source: "ats:zoho_recruit",
                createdById: actor.id,
                userId: null,
              })
              .returning();
            await tx.insert(profiles).values({
              id: randomUUID(),
              tenantId: r.tenantId,
              system: "zoho_recruit",
              accountRef: r.accountRef,
              externalCandidateId: r.externalCandidateId,
              candidateId: person.id,
              fields: ["name", "email"],
              importedBy: actor.id,
              idempotencyKey: `zoho:${r.accountRef}:${r.externalCandidateId}`,
              requestHash: fingerprint({
                accountRef: r.accountRef,
                recordId: r.externalCandidateId,
                candidateId: person.id,
              }),
            });
          }
          if (await hasBoundInvitationWorkflow(job.id, r.tenantId, person.id))
            block("existing_workflow_approval_required");
          const [existingSession] = await tx
            .select({ id: sessions.id })
            .from(sessions)
            .innerJoin(plans, and(eq(plans.id, sessions.planId), eq(plans.tenantId, r.tenantId)))
            .where(
              and(
                eq(sessions.tenantId, r.tenantId),
                eq(sessions.candidateId, person.id),
                eq(plans.jobId, job.id),
              ),
            );
          if (existingSession) block("existing_interview");
          const sessionId = randomUUID();
          const roomUrl = interviewRoomUrl(sessionId); // Validate owning-environment origin before mint.
          await tx.insert(sessions).values({
            id: sessionId,
            tenantId: r.tenantId,
            applicationId: `ats-campaign:${r.id}`,
            planId: plan.id,
            candidateId: person.id,
            status: "scheduled",
            language: plan.language,
            totalQuestions: Array.isArray(plan.questions) ? plan.questions.length : 0,
            currentQuestionIndex: 0,
            answers: [],
            inviteSentAt: null,
          });
          const [updated] = await tx
            .update(recipients)
            .set({ candidateId: person.id, sessionId, state: "sending", updatedAt: new Date() })
            .where(
              and(
                eq(recipients.id, r.id),
                eq(recipients.tenantId, r.tenantId),
                eq(recipients.state, "preparing"),
              ),
            )
            .returning();
          if (!updated) block("attempt_interrupted");
          return { person, job, roomUrl, sessionId };
        });
        // Commit the irreversible-attempt claim BEFORE touching the email provider.
        await dbAdmin.transaction(async (tx) => {
          await connection.lockCurrent(tx);
          const [current] = await tx
            .select()
            .from(campaigns)
            .where(and(eq(campaigns.id, campaign.id), eq(campaigns.tenantId, r.tenantId)))
            .for("share");
          if (current?.state !== "approved") block("campaign_cancelled");
          const [person] = await tx
            .select()
            .from(people)
            .where(and(eq(people.id, prepared.person.id), eq(people.tenantId, r.tenantId)))
            .for("share");
          if (
            !person ||
            !(await allowed(person, r.tenantId)) ||
            person.email.trim().toLowerCase() !== fields.email
          )
            block("privacy_or_identity");
          await fence(tx, r, fields.email!);
          const [brand] = await tx
            .select()
            .from(brands)
            .where(eq(brands.tenantId, r.tenantId))
            .for("share");
          if (brand?.aiMessagingEnabled === false) block("messaging_disabled");
          const [job] = await tx
            .select()
            .from(jobsTable)
            .where(and(eq(jobsTable.id, campaign.jobId), eq(jobsTable.tenantId, r.tenantId)))
            .for("share");
          if (!job || job.status !== "active") block("job_not_approved");
          await tx
            .select({ id: plans.id })
            .from(plans)
            .where(and(eq(plans.id, campaign.planId), eq(plans.tenantId, r.tenantId)))
            .for("share");
          const { hash } = await campaignJob(actor, campaign.jobId, campaign.planId, tx);
          if (hash !== campaign.briefHash) block("job_or_plan_changed");
          if (await hasBoundInvitationWorkflow(job.id, r.tenantId, person.id))
            block("existing_workflow_approval_required");
          const [attempt] = await tx
            .select()
            .from(recipients)
            .where(and(eq(recipients.id, r.id), eq(recipients.tenantId, r.tenantId)))
            .for("update");
          if (attempt?.state !== "sending") block("attempt_interrupted");
          const employer = ctx.companyName || "the hiring team";
          const text = `Hi ${person.firstName || "there"},\n\n${employer} invites you to an AI interview with Lexy for the ${job.title} role you applied for.\n\nStart your interview:\n${prepared.roomUrl}\n\nThis link is personal to you. Please do not share it. Allow microphone and camera access when prompted. Your interview will be assessed for this role; the employer makes the hiring decision.\n\n— Lexy AI Hiring Platform\nOn behalf of ${employer}`;
          attempted = true;
          const result = await send({
            to: person.email,
            subject: `Interview invitation — ${job.title}`,
            text,
            html: inviteEmailHtml(text),
            singleAttempt: true,
            audit: {
              tenantId: r.tenantId,
              actorLabel: "Employer-approved ATS campaign",
              subjectType: "candidate",
              subjectId: person.id,
              action: "interview.campaign.invite",
              metadata: {
                campaignId: campaign.id,
                recipientId: r.id,
                sessionId: prepared.sessionId,
                jobId: job.id,
              },
            },
          });
          const outcome = campaignDelivery(result);
          await tx
            .update(recipients)
            .set({ ...outcome, messageId: result.messageId ?? null, updatedAt: new Date() })
            .where(and(eq(recipients.id, r.id), eq(recipients.tenantId, r.tenantId)));
          if (outcome.state === "sent")
            await tx
              .update(sessions)
              .set({ inviteSentAt: new Date() })
              .where(and(eq(sessions.id, prepared.sessionId), eq(sessions.tenantId, r.tenantId)));
        });
      } catch (error) {
        await state(
          r,
          attempted ? "review_required" : "blocked",
          attempted
            ? "delivery_uncertain"
            : error instanceof CampaignBlock
              ? error.code
              : "source_or_authority_unavailable",
        );
        logger.warn(
          { campaignId: r.campaignId, recipientId: r.id, attempted },
          "[zoho-campaign] Dispatch held for review",
        );
      }
      return true;
    },
  };
}
let running = false;
export function startZohoCampaignScheduler() {
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      const dispatcher = zohoCampaignDispatcher();
      for (let i = 0; i < 5; i++) if (!(await dispatcher.tick())) break;
    } catch {
      // Missing production migration or storage failures must not fabricate completion.
      logger.warn("[zoho-campaign] Queue unavailable; pending invitations remain saved");
    } finally {
      running = false;
    }
  };
  setInterval(() => void tick(), 5000).unref();
}
