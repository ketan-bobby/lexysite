import { randomUUID } from "node:crypto";
import { and, eq, desc, sql } from "drizzle-orm";
import {
  dbAdmin,
  usersTable,
  candidatesTable as people,
  interviewSessionsTable as sessions,
  interviewPlansTable as plans,
  interviewSummariesTable as summaries,
  jobsTable,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
  zohoCampaignReviewsTable as reviews,
} from "@workspace/db";
import { zohoEmployerAdmin } from "./zoho-oauth-service";
import type { ZohoActor } from "./zoho-oauth-store";
import { campaignById, type CampaignTx } from "./zoho-interview-campaigns";
import { CalendarError } from "../outlook-calendar-core";
import { applyCandidateHardExclusions, applyCandidatePrivacyFilter } from "../../routes/candidates";
import { classBRead, CLASS_B_READ_EXEMPTION } from "../class-b-read";
import { fingerprint } from "../recruiting-workflows";
import {
  interviewScore,
  reviewAnswers,
  reviewRevision,
  zohoReviewInput,
} from "./zoho-review-policy";
import type { z } from "zod/v4";
import {
  zohoSourceEvidenceHash as evidenceHash,
  orderZohoReviews as historyOrder,
} from "./zoho-note-source-current";
export { assertZohoNoteSourceCurrent } from "./zoho-note-source-current";

type Handle = Pick<typeof dbAdmin, "select">;
type Review = typeof reviews.$inferSelect;
const unavailable = () =>
  new CalendarError(404, "not_found", "This campaign interview is unavailable.");
const conflict = (message: string) => new CalendarError(409, "review_conflict", message);

// No recruiter comments, recordings, session bindings, private coaching or unrelated interviews.
async function evidence(
  actor: ZohoActor,
  campaignId: string,
  handle: Handle = dbAdmin,
  recipientId?: string,
) {
  classBRead(CLASS_B_READ_EXEMPTION.TENANT_SCOPED_VIA_JOIN);
  return handle
    .select({
      recipient: recipients,
      person: people,
      sessionId: sessions.id,
      sessionStatus: sessions.status,
      sessionStartedAt: sessions.startedAt,
      completedAt: sessions.completedAt,
      sessionScore: sessions.score,
      answers: sessions.answers,
      questions: plans.questions,
      summaryId: summaries.id,
      overallScore: summaries.overallScore,
      narrative: summaries.recruiterSummary,
      strengths: summaries.strengths,
      weaknesses: summaries.weaknesses,
      redFlags: summaries.redFlags,
      recommendation: summaries.recommendation,
      jobStatus: jobsTable.status,
      evidenceHash,
    })
    .from(recipients)
    .innerJoin(
      campaigns,
      and(
        eq(campaigns.id, recipients.campaignId),
        eq(campaigns.tenantId, actor.tenantId),
        eq(recipients.accountRef, campaigns.accountRef),
        eq(recipients.externalJobId, campaigns.externalJobId),
      ),
    )
    .innerJoin(
      jobsTable,
      and(eq(jobsTable.id, campaigns.jobId), eq(jobsTable.tenantId, actor.tenantId)),
    )
    .leftJoin(
      sessions,
      and(
        eq(sessions.id, recipients.sessionId),
        eq(sessions.tenantId, actor.tenantId),
        eq(sessions.candidateId, recipients.candidateId),
        eq(sessions.planId, campaigns.frozenPlanId),
        eq(sessions.applicationId, sql<string>`'ats-campaign:' || ${recipients.id}`),
      ),
    )
    .leftJoin(
      plans,
      and(
        eq(plans.id, sessions.planId),
        eq(plans.tenantId, actor.tenantId),
        eq(plans.jobId, campaigns.jobId),
      ),
    )
    .leftJoin(
      people,
      and(eq(people.id, recipients.candidateId), eq(people.tenantId, actor.tenantId)),
    )
    .leftJoin(summaries, eq(summaries.interviewSessionId, sessions.id))
    .where(
      and(
        eq(recipients.tenantId, actor.tenantId),
        eq(recipients.campaignId, campaignId),
        recipientId ? eq(recipients.id, recipientId) : undefined,
      ),
    );
}
type Evidence = Awaited<ReturnType<typeof evidence>>[number];
async function permitted(rows: Evidence[], tenantId: string) {
  const candidates = rows.flatMap((r) => (r.person ? [r.person] : []));
  const visible = await applyCandidatePrivacyFilter(
    applyCandidateHardExclusions(candidates),
    tenantId,
  );
  return new Set(
    visible.filter((p) => p.tenantId === tenantId && p.pool === "tenant").map((p) => p.id),
  );
}
function ready(row: Evidence) {
  const normalized = reviewAnswers(row.answers, row.questions);
  return (
    !!row.sessionId &&
    !!row.completedAt &&
    ["completed", "reviewed"].includes(row.sessionStatus ?? "") &&
    !normalized.truncated &&
    (normalized.answers.length > 0 || !!row.summaryId)
  );
}
async function history(
  actor: ZohoActor,
  campaignId: string,
  recipientId: string,
  handle: Handle = dbAdmin,
) {
  return historyOrder(
    await handle
      .select()
      .from(reviews)
      .where(
        and(
          eq(reviews.tenantId, actor.tenantId),
          eq(reviews.campaignId, campaignId),
          eq(reviews.recipientId, recipientId),
        ),
      )
      .orderBy(desc(reviews.createdAt)),
  );
}
function detailOf(row: Evidence, events: Review[]) {
  const answers = reviewAnswers(row.answers, row.questions);
  return {
    campaignId: row.recipient.campaignId,
    recipientId: row.recipient.id,
    candidateName: `${row.person!.firstName} ${row.person!.lastName}`.trim(),
    sessionId: row.sessionId!,
    sessionStatus: row.sessionStatus!,
    completedAt: row.completedAt,
    revision: reviewRevision(row.evidenceHash, events[0]?.id ?? null),
    assessment: {
      score: interviewScore(row.overallScore) ?? interviewScore(row.sessionScore),
      summary: row.narrative ?? null,
      recommendation: row.recommendation ?? null,
      strengths: row.strengths ?? [],
      developmentAreas: row.weaknesses ?? [],
      concerns: row.redFlags ?? [],
    },
    answers: answers.answers,
    answersTruncated: answers.truncated,
    reviewable: ready(row),
    decisionStale: !!events[0] && events[0].evidenceHash !== row.evidenceHash,
    history: events.map((e) => ({
      id: e.id,
      decision: e.decision,
      reason: e.reason,
      reviewedBy: e.reviewedBy,
      createdAt: e.createdAt,
      evidenceCurrent: e.evidenceHash === row.evidenceHash,
    })),
  };
}
export function zohoCampaignReviews({ actorLookup = zohoEmployerAdmin } = {}) {
  async function authorize(actor: ZohoActor) {
    const current = await actorLookup(actor.id);
    if (current.id !== actor.id || current.tenantId !== actor.tenantId) throw unavailable();
  }
  async function detail(actor: ZohoActor, campaignId: string, recipientId: string) {
    await authorize(actor);
    await campaignById(actor, campaignId);
    const [row] = await evidence(actor, campaignId, dbAdmin, recipientId);
    if (
      !row?.person ||
      !row.sessionId ||
      !(await permitted([row], actor.tenantId)).has(row.person.id)
    )
      throw unavailable();
    return detailOf(row, await history(actor, campaignId, recipientId));
  }
  return {
    detail,
    /** Same candidate/privacy/session seals as the review, including before completion. */
    async noteContext(actor: ZohoActor, campaignId: string, recipientId: string) {
      await authorize(actor);
      const campaign = await campaignById(actor, campaignId);
      const [row] = await evidence(actor, campaignId, dbAdmin, recipientId);
      if (!row?.person || !(await permitted([row], actor.tenantId)).has(row.person.id))
        throw unavailable();
      return {
        tenantId: actor.tenantId,
        campaignId,
        recipientId,
        candidateId: row.person.id,
        accountRef: campaign.accountRef,
        connectionRevision: campaign.revision,
        externalJobId: row.recipient.externalJobId,
        externalCandidateId: row.recipient.externalCandidateId,
        applicationId: row.recipient.externalApplicationId,
        sourceEvidenceHash: row.evidenceHash,
        latestReviewId: (await history(actor, campaignId, recipientId))[0]?.id ?? null,
        invitation: {
          state: row.recipient.state,
          accepted: row.recipient.state === "sent" && !!row.recipient.messageId,
          at: row.recipient.updatedAt.toISOString(),
        },
        sessionId: row.sessionId,
        sessionStatus: row.sessionStatus,
        startedAt: row.sessionStartedAt?.toISOString() ?? null,
        completedAt: row.completedAt?.toISOString() ?? null,
      };
    },
    async queue(actor: ZohoActor, campaignId: string) {
      await authorize(actor);
      await campaignById(actor, campaignId);
      const rows = await evidence(actor, campaignId);
      const visible = await permitted(rows, actor.tenantId);
      const events = await dbAdmin
        .select()
        .from(reviews)
        .where(and(eq(reviews.tenantId, actor.tenantId), eq(reviews.campaignId, campaignId)));
      const grouped = new Map<string, Review[]>();
      for (const event of events)
        grouped.set(event.recipientId, [...(grouped.get(event.recipientId) ?? []), event]);
      return {
        campaignId,
        rows: rows.map((row) => {
          const allowed = !!row.person && !!row.sessionId && visible.has(row.person.id);
          const last = allowed ? historyOrder(grouped.get(row.recipient.id) ?? [])[0] : undefined;
          return {
            recipientId: row.recipient.id,
            applicationId: row.recipient.externalApplicationId,
            externalCandidateId: row.recipient.externalCandidateId,
            candidateName: allowed
              ? `${row.person!.firstName} ${row.person!.lastName}`.trim()
              : null,
            sessionStatus: allowed ? row.sessionStatus : null,
            score: allowed
              ? (interviewScore(row.overallScore) ?? interviewScore(row.sessionScore))
              : null,
            reviewable: allowed && ready(row),
            decision: last?.decision ?? null,
            decisionStale: !!last && last.evidenceHash !== row.evidenceHash,
          };
        }),
      };
    },
    async record(
      actor: ZohoActor,
      campaignId: string,
      recipientId: string,
      input: z.infer<typeof zohoReviewInput>,
    ) {
      await authorize(actor);
      const requestHash = fingerprint({ actor: actor.id, campaignId, recipientId, ...input });
      await dbAdmin.transaction(async (tx: CampaignTx) => {
        const [user] = await tx
          .select()
          .from(usersTable)
          .where(and(eq(usersTable.id, actor.id), eq(usersTable.tenantId, actor.tenantId)))
          .for("share");
        if (
          !user ||
          user.role !== "tenant_admin" ||
          user.status !== "active" ||
          user.accountErasedAt
        )
          throw unavailable();
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
          .select({ id: people.id })
          .from(people)
          .where(and(eq(people.id, recipient.candidateId), eq(people.tenantId, actor.tenantId)))
          .for("share");
        await tx
          .select({ id: sessions.id })
          .from(sessions)
          .where(and(eq(sessions.id, recipient.sessionId), eq(sessions.tenantId, actor.tenantId)))
          .for("share");
        await tx
          .select({ id: summaries.id })
          .from(summaries)
          .innerJoin(
            sessions,
            and(
              eq(sessions.id, summaries.interviewSessionId),
              eq(sessions.tenantId, actor.tenantId),
            ),
          )
          .where(and(eq(sessions.id, recipient.sessionId), eq(sessions.tenantId, actor.tenantId)))
          .for("share", { of: summaries });
        const [row] = await evidence(actor, campaignId, tx, recipientId);
        if (
          !row?.person ||
          !row.sessionId ||
          !(await permitted([row], actor.tenantId)).has(row.person.id)
        )
          throw unavailable();
        const [prior] = await tx
          .select()
          .from(reviews)
          .where(and(eq(reviews.tenantId, actor.tenantId), eq(reviews.requestId, input.requestId)));
        if (prior) {
          if (prior.requestHash !== requestHash)
            throw conflict("That request ID belongs to another review.");
          return;
        }
        if (!ready(row))
          throw conflict(
            "Complete this interview and review its usable evidence before recording a decision.",
          );
        if (input.decision === "advance" && row.jobStatus !== "active")
          throw conflict("This job is no longer active. Advancement cannot be recorded.");
        const events = await history(actor, campaignId, recipientId, tx);
        if (reviewRevision(row.evidenceHash, events[0]?.id ?? null) !== input.expectedRevision)
          throw conflict(
            "Interview evidence or another staff decision changed. Refresh and review before saving.",
          );
        await tx.insert(reviews).values({
          id: randomUUID(),
          tenantId: actor.tenantId,
          campaignId,
          recipientId,
          candidateId: row.person.id,
          sessionId: row.sessionId,
          decision: input.decision,
          reason: input.reason,
          evidenceHash: row.evidenceHash,
          previousReviewId: events[0]?.id ?? null,
          reviewedBy: actor.id,
          requestId: input.requestId,
          requestHash,
        });
      });
      return detail(actor, campaignId, recipientId);
    },
  };
}
