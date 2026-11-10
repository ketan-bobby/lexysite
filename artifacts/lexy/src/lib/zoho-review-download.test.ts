import assert from "node:assert/strict";
import test from "node:test";
import type { ZohoCampaignApplicantReview, ZohoStageHandoff } from "@workspace/api-client-react";
import { prepareZohoReviewDownload } from "./zoho-review-download";

const stamp = "2026-11-02T00:00:00.000Z";
function fixture() {
  const review: ZohoCampaignApplicantReview = {
    campaignId: "campaign",
    recipientId: "recipient",
    candidateName: "Synthetic applicant",
    sessionId: "session",
    sessionStatus: "completed",
    completedAt: stamp,
    revision: "revision",
    reviewable: true,
    decisionStale: false,
    answersTruncated: false,
    assessment: {
      score: 0,
      summary: "Job-specific assessment",
      recommendation: "Review",
      strengths: [],
      developmentAreas: [],
      concerns: [],
    },
    answers: [{ question: "Question", answer: "DO_NOT_EXPORT_TRANSCRIPT", score: null }],
    history: [
      {
        id: "decision",
        decision: "hold",
        reason: "Needs a human technical follow-up.",
        reviewedBy: "admin",
        createdAt: stamp,
        evidenceCurrent: true,
      },
    ],
  };
  const handoff: ZohoStageHandoff = {
    campaignId: "campaign",
    recipientId: "recipient",
    applicationId: "9007199254740993001",
    externalJobId: "9007199254740993002",
    externalCandidateId: "9007199254740993003",
    revision: "handoff",
    mapping: {
      revision: "mapping",
      advance: null,
      hold: null,
      decline: null,
      updatedAt: null,
      updatedBy: null,
    },
    decision: "hold",
    targetStatus: null,
    ready: false,
    liveEnabled: false,
    reason: "No proposed mapping",
    history: [],
  };
  const reads: string[] = [];
  const request = {
    campaignId: review.campaignId,
    recipientId: review.recipientId,
    expectedRevision: review.revision,
    isCurrentView: () => true,
    readReview: async () => {
      reads.push("review");
      return structuredClone(review);
    },
    readHandoff: async () => {
      reads.push("handoff");
      return structuredClone(handoff);
    },
    recordPreparation: async () => {
      reads.push("audit");
      return {
        id: "11111111-1111-4111-8111-111111111111",
        campaignId: review.campaignId,
        recipientId: review.recipientId,
        reviewId: review.history[0].id,
        reviewRevision: review.revision,
        handoffRevision: handoff.revision,
        preparedAt: stamp,
        state: "prepared" as const,
        delivery: "unverified" as const,
      };
    },
    now: () => new Date(stamp),
  };
  return { review, handoff, reads, request };
}

test("downloads a minimal dated human-review snapshot without requiring a live connection or mapping", async () => {
  const f = fixture();
  Object.assign(f.review, {
    privateCoaching: "PRIVATE_SENTINEL",
    email: "CONTACT_SENTINEL",
    recordingUrl: "RECORDING_SENTINEL",
  });
  Object.assign(f.review.assessment, { privateNarrative: "PRIVATE_ASSESSMENT_SENTINEL" });
  const file = await prepareZohoReviewDownload(f.request);
  const text = await file.blob.text();
  const packet = JSON.parse(text);
  assert.deepEqual(f.reads, ["review", "handoff", "review", "audit", "review"]);
  assert.equal(file.filename, "lexy-zoho-reviewed-handoff-recipient.json");
  assert.equal(packet.externalRecords.applicationId, f.handoff.applicationId);
  assert.equal(packet.externalRecords.liveVerifiedByThisExport, false);
  assert.equal(packet.exportedAt, stamp);
  assert.equal(packet.humanReview.decision, "hold");
  assert.equal(packet.aiAssessment.score, 0);
  assert.equal(packet.aiAssessment.advisoryOnly, true);
  assert.equal(packet.preparation.state, "prepared");
  assert.equal(packet.preparation.delivery, "unverified");
  assert.match(packet.notice, /does not update Zoho, authorize an offer/);
  assert.doesNotMatch(text, /SENTINEL|DO_NOT_EXPORT|targetStatus|refreshToken|answers/);
});

test("preserves a missing assessment score as null", async () => {
  const f = fixture();
  f.review.assessment.score = null;
  const file = await prepareZohoReviewDownload(f.request);
  assert.equal(JSON.parse(await file.blob.text()).aiAssessment.score, null);
});

test("audit failure blocks the file without retrying or using cached data", async () => {
  const f = fixture();
  let calls = 0;
  f.request.recordPreparation = async () => {
    calls++;
    throw new Error("Audit unavailable");
  };
  await assert.rejects(prepareZohoReviewDownload(f.request), /Audit unavailable/);
  assert.equal(calls, 1);
  assert.deepEqual(f.reads, ["review", "handoff", "review"]);
});

test("foreign or malformed audit receipts cannot authorize a download", async () => {
  for (const field of [
    "campaignId",
    "reviewId",
    "reviewRevision",
    "handoffRevision",
    "id",
    "preparedAt",
    "state",
    "delivery",
  ]) {
    const f = fixture();
    const prepare = f.request.recordPreparation;
    f.request.recordPreparation = async () => ({ ...(await prepare()), [field]: "invalid" });
    await assert.rejects(prepareZohoReviewDownload(f.request));
  }
});

test("decision changes after auditing suppress the download, not the historical audit", async () => {
  const f = fixture();
  const prepare = f.request.recordPreparation;
  f.request.recordPreparation = async () => {
    const receipt = await prepare();
    f.review.decisionStale = true;
    return receipt;
  };
  await assert.rejects(prepareZohoReviewDownload(f.request));
  assert.deepEqual(f.reads, ["review", "handoff", "review", "audit", "review"]);
});

for (const state of ["unreviewed", "stale", "incomplete", "truncated", "wrong-scope"]) {
  test(`rejects ${state} review evidence before reading handoff data`, async () => {
    const f = fixture();
    if (state === "unreviewed") f.review.history = [];
    if (state === "stale") f.review.decisionStale = true;
    if (state === "incomplete") f.review.sessionStatus = "in_progress";
    if (state === "truncated") f.review.answersTruncated = true;
    if (state === "wrong-scope") f.review.campaignId = "foreign-campaign";
    await assert.rejects(prepareZohoReviewDownload(f.request));
    assert.deepEqual(f.reads, ["review"]);
  });
}

test("rejects a changed evidence revision or decision during preparation", async () => {
  for (const change of ["revision", "decision"]) {
    const f = fixture();
    f.request.readHandoff = async () => {
      if (change === "revision") f.review.revision = "new-revision";
      else f.review.history[0].id = "corrected-decision";
      return f.handoff;
    };
    await assert.rejects(prepareZohoReviewDownload(f.request));
  }
});

test("rejects foreign bindings, invalid IDs and disagreement with the saved human decision", async () => {
  for (const field of ["campaignId", "recipientId", "applicationId", "decision"] as const) {
    const f = fixture();
    f.handoff[field] = "different";
    await assert.rejects(prepareZohoReviewDownload(f.request));
  }
});

test("stale navigation or authority suppresses downloads before and after awaited reads", async () => {
  for (const expiresAt of [0, 1, 2, 3, 4, 5]) {
    const f = fixture();
    f.request.isCurrentView = () => f.reads.length < expiresAt;
    await assert.rejects(prepareZohoReviewDownload(f.request));
    assert.equal(f.reads.length, expiresAt);
  }
});

test("failed current authorization never falls back to cached evidence", async () => {
  const f = fixture();
  f.request.readHandoff = async () => {
    throw new Error("HTTP 403");
  };
  await assert.rejects(prepareZohoReviewDownload(f.request), /HTTP 403/);
  assert.deepEqual(f.reads, ["review"]);
});

test("rejects invalid scores and sanitizes the filename", async () => {
  const f = fixture();
  f.review.assessment.score = Number.NaN;
  await assert.rejects(prepareZohoReviewDownload(f.request));
  f.review.assessment.score = null;
  f.request.recipientId = "../../recipient";
  f.review.recipientId = f.request.recipientId;
  f.handoff.recipientId = f.request.recipientId;
  const file = await prepareZohoReviewDownload(f.request);
  assert.doesNotMatch(file.filename, /[./\\].*recipient/);
});
