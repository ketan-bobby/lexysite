/**
 * Transaction-bound source reads only. Keep this leaf free of route/AI imports
 * so the real publication fence can run in credential-free database fixtures.
 */
import { and, eq, desc, sql } from "drizzle-orm";
import {
  dbAdmin,
  interviewSessionsTable as sessions,
  interviewPlansTable as plans,
  interviewSummariesTable as summaries,
  jobsTable,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
  zohoCampaignReviewsTable as reviews,
} from "@workspace/db";
import { CalendarError } from "../outlook-calendar-core";
import type { ZohoActor } from "./zoho-oauth-store";

type Handle = Pick<typeof dbAdmin, "select">;
const conflict = (message: string) => new CalendarError(409, "review_conflict", message);

export const zohoSourceEvidenceHash = sql<string>`md5(jsonb_build_array(
  ${sessions.id},${sessions.status},${sessions.completedAt},${sessions.score},${sessions.answers},
  ${plans.questions},${plans.focusDirective},${jobsTable.title},${jobsTable.description},${jobsTable.status},
  ${summaries.id},${summaries.overallScore},${summaries.recruiterSummary},${summaries.strengths},
  ${summaries.weaknesses},${summaries.redFlags},${summaries.recommendation}
)::text)`;

export function orderZohoReviews<T extends { id: string; previousReviewId: string | null }>(
  events: T[],
): T[] {
  if (!events.length) return [];
  const parents = new Set(events.map((e) => e.previousReviewId).filter(Boolean));
  const leaves = events.filter((e) => !parents.has(e.id));
  if (leaves.length !== 1) throw conflict("Review history requires reconciliation.");
  const map = new Map(events.map((e) => [e.id, e]));
  const ordered: T[] = [];
  let next: T | undefined = leaves[0];
  while (next && ordered.length <= events.length) {
    ordered.push(next);
    next = next.previousReviewId ? map.get(next.previousReviewId) : undefined;
  }
  if (ordered.length !== events.length) throw conflict("Review history requires reconciliation.");
  return ordered;
}

/** Internal read; caller must hold the publication source locks. */
export async function readZohoNoteSource(
  actor: ZohoActor,
  campaignId: string,
  recipientId: string,
  handle: Handle,
) {
  const [row] = await handle
    .select({ evidenceHash: zohoSourceEvidenceHash })
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
    .leftJoin(summaries, eq(summaries.interviewSessionId, sessions.id))
    .where(
      and(
        eq(recipients.tenantId, actor.tenantId),
        eq(recipients.campaignId, campaignId),
        eq(recipients.id, recipientId),
      ),
    );
  const events = orderZohoReviews(
    await handle
      .select({ id: reviews.id, previousReviewId: reviews.previousReviewId })
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
  return { evidenceHash: row?.evidenceHash ?? null, latestReviewId: events[0]?.id ?? null };
}

/** Internal, transaction-bound source recheck after publication source locks. */
export async function assertZohoNoteSourceCurrent(
  actor: ZohoActor,
  campaignId: string,
  recipientId: string,
  expectedHash: string,
  expectedReviewId: string | null,
  handle: Handle,
) {
  const source = await readZohoNoteSource(actor, campaignId, recipientId, handle);
  if (source.evidenceHash !== expectedHash || source.latestReviewId !== expectedReviewId)
    throw conflict("The interview evidence or human review changed. Preview the note again.");
}
