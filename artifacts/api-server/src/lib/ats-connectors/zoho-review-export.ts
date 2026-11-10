import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { sql } from "drizzle-orm";
import { auditLogsTable, dbAdmin, type InsertAuditLog } from "@workspace/db";
import { CalendarError } from "../outlook-calendar-core";
import { zohoCampaignReviews } from "./zoho-campaign-reviews";
import { zohoStageHandoff } from "./zoho-stage-handoff";
import type { ZohoActor } from "./zoho-oauth-store";

export const zohoReviewExportInput = z.strictObject({
  expectedRevision: z.string().regex(/^[a-f0-9]{64}$/),
  expectedHandoffRevision: z.string().regex(/^[a-f0-9]{64}$/),
  confirm: z.literal(true),
});

type Review = Awaited<ReturnType<ReturnType<typeof zohoCampaignReviews>["detail"]>>;
type Handoff = Awaited<ReturnType<ReturnType<typeof zohoStageHandoff>["detail"]>>;
type ExportStore = Pick<typeof dbAdmin, "transaction">;
const changed = () =>
  new CalendarError(
    409,
    "zoho_review_export_changed",
    "The applicant, access or saved decision changed. Refresh before downloading.",
  );

/** Local audit preparation only. No token access, provider writes or file-delivery claims. */
export function zohoReviewExport({
  store = dbAdmin as ExportStore,
  readReview = (actor: ZohoActor, campaignId: string, recipientId: string): Promise<Review> =>
    zohoCampaignReviews().detail(actor, campaignId, recipientId),
  readHandoff = (actor: ZohoActor, campaignId: string, recipientId: string): Promise<Handoff> =>
    zohoStageHandoff().detail(actor, campaignId, recipientId),
  persist = async (row: InsertAuditLog): Promise<string | undefined> => {
    // Unlike best-effort recordAudit, preparation must fail if its receipt cannot be saved.
    return store.transaction(async (tx) => {
      const references = row.metadata as {
        campaignId: string;
        recipientId: string;
        reviewId: string;
      };
      const binding = sql`SELECT c.id FROM candidates c
        JOIN zoho_campaign_recipients r ON r.candidate_id=c.id
        JOIN interview_sessions s ON s.id=r.session_id AND s.candidate_id=c.id
        JOIN zoho_campaign_reviews v ON v.recipient_id=r.id AND v.session_id=s.id
          AND v.campaign_id=r.campaign_id AND v.tenant_id=r.tenant_id AND v.candidate_id=c.id
        JOIN users u ON u.id=${row.actorId} AND u.tenant_id=r.tenant_id
          AND u.role='tenant_admin' AND u.status='active'
        WHERE r.id=${references.recipientId} AND r.id=${row.subjectId}
          AND r.campaign_id=${references.campaignId} AND r.tenant_id=${row.tenantId}
          AND v.id=${references.reviewId} AND c.data_erased_at IS NULL
          AND s.status IN ('completed','reviewed')
          AND NOT EXISTS (SELECT 1 FROM candidate_erasure_tombstones t
            WHERE t.subject_id=c.id OR t.subject_id='ats-profile:' ||
              md5(jsonb_build_array(r.tenant_id,'zoho_recruit',r.account_ref,r.external_candidate_id)::text))
        FOR UPDATE OF c`;
      if (!(await tx.execute(binding)).rows.length) throw changed();
      // Erasure takes the same candidate lock. A second statement is deliberate:
      // after waiting for that lock, READ COMMITTED needs a fresh snapshot to see
      // deleted recipient/review rows or a newly committed tombstone.
      if (!(await tx.execute(binding)).rows.length) throw changed();
      const [saved] = await tx
        .insert(auditLogsTable)
        .values(row)
        .returning({ id: auditLogsTable.id });
      if (saved?.id !== row.id) throw new Error("Export audit preparation could not be saved.");
      return saved.id;
    });
  },
  now = () => new Date(),
} = {}) {
  return {
    async prepare(
      actor: ZohoActor,
      campaignId: string,
      recipientId: string,
      input: z.infer<typeof zohoReviewExportInput>,
    ) {
      const selection = zohoReviewExportInput.parse(input);
      const requireCurrent = (review: Review) => {
        const event = review.history[0];
        if (
          review.campaignId !== campaignId ||
          review.recipientId !== recipientId ||
          review.revision !== selection.expectedRevision ||
          !review.reviewable ||
          review.decisionStale ||
          review.answersTruncated ||
          !["completed", "reviewed"].includes(review.sessionStatus ?? "") ||
          !review.completedAt ||
          !Number.isFinite(new Date(review.completedAt).getTime()) ||
          !event?.evidenceCurrent ||
          !["advance", "hold", "decline"].includes(event.decision) ||
          !event.reason.trim()
        )
          throw changed();
        return event;
      };
      // Each canonical detail read rechecks active exact-employer admin, campaign,
      // recipient/session bindings, DNC and candidate privacy. No OAuth grant is needed.
      const before = await readReview(actor, campaignId, recipientId);
      requireCurrent(before);
      const handoff = await readHandoff(actor, campaignId, recipientId);
      if (
        handoff.campaignId !== campaignId ||
        handoff.recipientId !== recipientId ||
        handoff.revision !== selection.expectedHandoffRevision ||
        ![handoff.applicationId, handoff.externalJobId, handoff.externalCandidateId].every(
          (id) => typeof id === "string" && /^[1-9]\d{0,39}$/.test(id),
        )
      )
        throw changed();
      const review = await readReview(actor, campaignId, recipientId);
      const event = requireCurrent(review);
      if (event.id !== before.history[0].id || handoff.decision !== event.decision) throw changed();
      const receipt = {
        id: randomUUID(),
        campaignId,
        recipientId,
        reviewId: event.id,
        reviewRevision: review.revision,
        handoffRevision: handoff.revision,
        preparedAt: now(),
        state: "prepared" as const,
        delivery: "unverified" as const,
      };
      const saved = await persist({
        id: receipt.id,
        tenantId: actor.tenantId,
        actorType: "user",
        actorId: actor.id,
        subjectType: "external",
        subjectId: recipientId,
        channel: "in_app",
        direction: "internal",
        action: "zoho.review_export.prepared",
        title: "Reviewed Zoho handoff prepared; delivery unverified",
        createdAt: receipt.preparedAt,
        metadata: {
          provider: "zoho_recruit",
          campaignId,
          recipientId,
          reviewId: receipt.reviewId,
          reviewRevision: receipt.reviewRevision,
          handoffRevision: receipt.handoffRevision,
          state: receipt.state,
          delivery: receipt.delivery,
        },
      });
      if (saved !== receipt.id) throw new Error("Export audit preparation could not be saved.");
      return receipt;
    },
  };
}
