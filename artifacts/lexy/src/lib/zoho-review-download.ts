import type {
  ZohoCampaignApplicantReview,
  ZohoStageHandoff,
  ZohoReviewExportInput,
  ZohoReviewExportReceipt,
} from "@workspace/api-client-react";
import type { CandidateDataFile } from "./candidate-data-download";

interface ReviewDownloadRequest {
  campaignId: string;
  recipientId: string;
  expectedRevision: string;
  isCurrentView(): boolean;
  readReview(): Promise<ZohoCampaignApplicantReview>;
  readHandoff(): Promise<ZohoStageHandoff>;
  recordPreparation(input: ZohoReviewExportInput): Promise<ZohoReviewExportReceipt>;
  now?: () => Date;
}

const changed = () =>
  new Error(
    "The applicant, access or saved decision changed. Refresh and review before downloading.",
  );

/** Fresh authorized reads plus a mandatory local audit receipt. Never writes to an ATS. */
export async function prepareZohoReviewDownload(
  request: ReviewDownloadRequest,
): Promise<CandidateDataFile> {
  const current = (review: ZohoCampaignApplicantReview) => {
    const event = review?.history?.[0];
    if (
      !request.isCurrentView() ||
      review.campaignId !== request.campaignId ||
      review.recipientId !== request.recipientId ||
      review.revision !== request.expectedRevision ||
      !review.reviewable ||
      review.decisionStale ||
      review.answersTruncated ||
      !["completed", "reviewed"].includes(review.sessionStatus) ||
      !review.completedAt ||
      !Number.isFinite(Date.parse(review.completedAt)) ||
      !event?.evidenceCurrent ||
      !["advance", "hold", "decline"].includes(event.decision) ||
      !event.reason?.trim()
    )
      throw changed();
    return event;
  };
  if (!request.isCurrentView()) throw changed();
  const before = await request.readReview();
  current(before);
  const handoff = await request.readHandoff();
  if (
    !request.isCurrentView() ||
    handoff?.campaignId !== request.campaignId ||
    handoff.recipientId !== request.recipientId ||
    ![handoff.applicationId, handoff.externalJobId, handoff.externalCandidateId].every(
      (id) => typeof id === "string" && /^[1-9]\d{0,39}$/.test(id),
    )
  )
    throw changed();
  // Handoff reads also authorize current employer/privacy state. Read the review
  // again so a concurrent evidence/decision correction cannot mix two snapshots.
  const review = await request.readReview();
  const event = current(review);
  if (event.id !== before.history[0].id || handoff.decision !== event.decision) throw changed();
  const score = review.assessment.score;
  if (score !== null && (!Number.isFinite(score) || score < 0 || score > 100)) throw changed();
  const receipt = await request.recordPreparation({
    expectedRevision: review.revision,
    expectedHandoffRevision: handoff.revision,
    confirm: true,
  });
  if (
    !request.isCurrentView() ||
    receipt.campaignId !== request.campaignId ||
    receipt.recipientId !== request.recipientId ||
    receipt.reviewId !== event.id ||
    receipt.reviewRevision !== review.revision ||
    receipt.handoffRevision !== handoff.revision ||
    receipt.state !== "prepared" ||
    receipt.delivery !== "unverified" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(receipt.id) ||
    !Number.isFinite(Date.parse(receipt.preparedAt))
  )
    throw changed();
  // Saving an audit event is not permission to export after a subsequent access
  // denial or decision correction. A lost response is never automatically retried.
  const after = await request.readReview();
  if (current(after).id !== event.id) throw changed();
  const packet = {
    schemaVersion: 1,
    purpose: "manual_ats_review_handoff",
    exportedAt: (request.now?.() ?? new Date()).toISOString(),
    notice:
      "Dated review snapshot only. Verify current records and employer permissions before acting. This file does not update Zoho, authorize an offer, establish employment or contact a candidate.",
    provider: "zoho_recruit",
    preparation: {
      id: receipt.id,
      preparedAt: receipt.preparedAt,
      state: receipt.state,
      delivery: receipt.delivery,
    },
    campaignId: request.campaignId,
    recipientId: request.recipientId,
    externalRecords: {
      jobId: handoff.externalJobId,
      applicationId: handoff.applicationId,
      candidateId: handoff.externalCandidateId,
      liveVerifiedByThisExport: false,
    },
    interview: {
      candidateName: review.candidateName,
      sessionId: review.sessionId,
      completedAt: review.completedAt,
      evidenceRevision: review.revision,
    },
    humanReview: {
      id: event.id,
      decision: event.decision,
      reason: event.reason,
      reviewedBy: event.reviewedBy,
      reviewedAt: event.createdAt,
    },
    aiAssessment: {
      advisoryOnly: true,
      score,
      summary: review.assessment.summary,
      recommendation: review.assessment.recommendation,
      strengths: review.assessment.strengths,
      developmentAreas: review.assessment.developmentAreas,
      concerns: review.assessment.concerns,
    },
  };
  const safeId = request.recipientId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
  return {
    filename: `lexy-zoho-reviewed-handoff-${safeId}.json`,
    blob: new Blob([JSON.stringify(packet, null, 2)], {
      type: "application/json;charset=utf-8",
    }),
  };
}
