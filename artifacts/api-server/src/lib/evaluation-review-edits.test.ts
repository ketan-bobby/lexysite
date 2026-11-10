import assert from "node:assert/strict";
import test from "node:test";
import { mergeEvaluation, type EvaluationContent } from "./evaluation-synthesis";
import {
  EvaluationReviewEditsSchema,
  readEvaluationReviewEdits,
  reviewEditsStatus,
  sealEvaluationReviewEdits,
} from "./evaluation-review-edits";

const binding = {
  id: "report-a",
  tenantId: "tenant-a",
  jobId: "job-a",
  candidateId: "candidate-a",
};

test("human narrative edits cannot erase server-derived assessment quality gaps", () => {
  const warning = "Only 1 of 3 answers have valid grades. This assessment is incomplete.";
  const aiContent = { ...content, assessmentQualityWarnings: [warning] };
  const source = { ...binding, aiContent };
  const edits = sealEvaluationReviewEdits(
    source,
    { riskAssessment: { concerns: [], toValidate: [] } },
    "staff-a",
  );
  const merged = mergeEvaluation(aiContent, edits, ["problem_solving"], source);
  assert.deepEqual(merged.riskAssessment.concerns, [warning]);
  assert.deepEqual(merged.recommendation, aiContent.recommendation);
});
const content: EvaluationContent = {
  headline: "Job assessment",
  executiveSummary: "Original",
  roleAlignment: "API work",
  competencies: [
    {
      key: "problem_solving",
      label: "Problem solving",
      score: 50,
      insufficientEvidence: false,
      evidence: "Job answer",
      rationale: "Observed",
    },
  ],
  behavioralInsights: [],
  observations: [],
  developmentOpportunities: [],
  riskAssessment: { concerns: [], toValidate: [] },
  verification: { status: "pending", summary: "Pending" },
  recommendation: { band: "further_assessment", rationale: "Review" },
  evidenceBasis: {
    hasInterview: true,
    interviewAnswers: 5,
    hasIntelligence: false,
    hasResume: false,
    provenance: {
      kind: "job_bound_evaluation_v1",
      jobId: binding.jobId,
      candidateId: binding.candidateId,
      interviewSessionId: "session-a",
    },
  },
};
const source = { ...binding, aiContent: content };

test("legacy free-form notes remain stored but never merge, even with valid AI provenance", () => {
  const legacy = {
    executiveSummary: "PRIVATE_PREP_SENTINEL",
    recruiterComments: "PRIVATE_BASELINE_SENTINEL",
  };
  const merged = mergeEvaluation(content, legacy, ["problem_solving"], binding);
  assert.ok(!JSON.stringify(merged).includes("SENTINEL"));
  assert.equal(readEvaluationReviewEdits(content, legacy, binding), null);
  const sealed = sealEvaluationReviewEdits(
    { ...source, humanEdits: legacy },
    { headline: "Reviewed job evidence" },
    "staff-a",
  );
  assert.deepEqual(sealed.legacyPrivateEdits, legacy);
  assert.ok(
    !JSON.stringify(mergeEvaluation(content, sealed, ["problem_solving"], binding)).includes(
      "SENTINEL",
    ),
  );
});

test("authorized job-bound edits merge all editorial fields; zero and clear values are honest", () => {
  const edits = {
    headline: "Corrected",
    executiveSummary: "",
    roleAlignment: "Job-specific correction",
    behavioralInsights: [{ dimension: "Collaboration", descriptor: "Job example" }],
    observations: [{ observed: "API design", whyItMatters: "Role requirement", followUps: [] }],
    developmentOpportunities: [
      { area: "API validation", impact: "high" as const, coaching: "Assess in next job interview" },
    ],
    riskAssessment: { concerns: ["Transcript quality"], toValidate: ["Repeat assessment"] },
    verification: { summary: "Identity review pending" },
    recommendation: { rationale: "Provisional job assessment" },
    competencyOverrides: {
      problem_solving: {
        score: 0,
        insufficientEvidence: false,
        evidence: "",
        rationale: "No evidence shown",
      },
    },
    recruiterComments: "Human review required",
  };
  const sealed = sealEvaluationReviewEdits(source, edits, "staff-a");
  const merged = mergeEvaluation(content, sealed, ["problem_solving"], binding);
  assert.equal(merged.headline, "Corrected");
  assert.equal(merged.executiveSummary, "");
  assert.equal(merged.competencies[0].score, 0);
  assert.equal(merged.competencies[0].insufficientEvidence, false);
  assert.deepEqual(merged.observations, edits.observations);
  assert.deepEqual(merged.behavioralInsights, edits.behavioralInsights);
  assert.deepEqual(merged.developmentOpportunities, edits.developmentOpportunities);
  assert.equal(merged.recruiterComments, edits.recruiterComments);
  assert.equal(merged.verification.status, "pending");
  assert.equal(merged.verification.summary, edits.verification.summary);
  assert.equal(merged.recommendation.band, content.recommendation.band);
  assert.equal(reviewEditsStatus({ ...source, humanEdits: sealed }), "verified");
});

test("copies to foreign report, tenant, job or candidate never become evidence", () => {
  const sealed = sealEvaluationReviewEdits(
    source,
    { recruiterComments: "VALID_JOB_NOTE" },
    "staff-a",
  );
  for (const key of ["id", "tenantId", "jobId", "candidateId"] as const)
    assert.equal(readEvaluationReviewEdits(content, sealed, { ...binding, [key]: "other" }), null);
  assert.equal(readEvaluationReviewEdits(content, sealed), null);
});

test("changed AI evidence invalidates edits without deleting them; empty re-save clears visible notes", () => {
  const sealed = sealEvaluationReviewEdits(
    source,
    { recruiterComments: "Earlier review" },
    "staff-a",
  );
  const updated = { ...content, executiveSummary: "New job evidence" };
  assert.equal(readEvaluationReviewEdits(updated, sealed, binding), null);
  assert.equal(
    reviewEditsStatus({ ...source, aiContent: updated, humanEdits: sealed }),
    "requires_review",
  );
  const cleared = sealEvaluationReviewEdits({ ...source, humanEdits: sealed }, {}, "staff-a");
  assert.equal(mergeEvaluation(content, cleared, [], binding).recruiterComments, "");
  assert.equal(reviewEditsStatus({ ...source, humanEdits: null }), "none");
});

test("unknown/private fields, forged provenance and server-owned decisions are rejected", () => {
  for (const payload of [
    { privateBaseline: "PRIVATE" },
    { kind: "job_bound_recruiter_review_v1", editedByUserId: "forged" },
    { recommendation: { band: "strongly_recommend" } },
    { verification: { status: "verified" } },
    { confidence: 100 },
    { competencyOverrides: { problem_solving: { score: 101 } } },
    { competencyOverrides: { problem_solving: { score: Number.NaN } } },
    {
      observations: [{ observed: "x", whyItMatters: "y", followUps: [], privateNotes: "PRIVATE" }],
    },
  ])
    assert.equal(EvaluationReviewEditsSchema.safeParse(payload).success, false);
});

test("missing evidence cannot coexist with a scored competency", () => {
  const sealed = sealEvaluationReviewEdits(
    source,
    {
      competencyOverrides: {
        problem_solving: { score: 80, insufficientEvidence: true },
      },
    },
    "staff-a",
  );
  const comp = mergeEvaluation(content, sealed, ["problem_solving"], binding).competencies[0];
  assert.equal(comp.score, null);
  assert.equal(comp.insufficientEvidence, true);
});
