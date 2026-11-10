import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { assertApplicantInterviewReview } from "./ats-applicant-interviews";
import { interviewMintLockKey } from "./interview-mint-lock";

test("preparation review requires explicit consent and all current revisions", () => {
  const current = {
    workflowRevision: 2,
    bindingRevision: 3,
    importRevision: 4,
    planHash: "a".repeat(64),
  };
  const input = {
    planId: "plan",
    expectedWorkflowRevision: 2,
    expectedBindingRevision: 3,
    expectedImportRevision: 4,
    expectedPlanHash: "a".repeat(64),
    acknowledge: true,
  };
  assert.doesNotThrow(() => assertApplicantInterviewReview(current, input));
  assert.throws(
    () => assertApplicantInterviewReview(current, { ...input, acknowledge: false }),
    /acknowledgement/,
  );
  for (const field of [
    "expectedWorkflowRevision",
    "expectedBindingRevision",
    "expectedImportRevision",
  ] as const)
    assert.throws(
      () => assertApplicantInterviewReview(current, { ...input, [field]: 99 }),
      /changed/,
    );
  assert.throws(
    () => assertApplicantInterviewReview(current, { ...input, expectedPlanHash: "b".repeat(64) }),
    /changed/,
  );
});

test("native and ATS preparations retain the original shared mint-lock namespace", () => {
  const expected = createHash("sha256")
    .update("interview_mint:tenant:candidate:job:general")
    .digest()
    .readBigInt64BE(0);
  assert.equal(interviewMintLockKey("tenant", "candidate", "job", "general"), expected);
  for (const args of [
    ["other", "candidate", "job", "general"],
    ["tenant", "other", "job", "general"],
    ["tenant", "candidate", "other", "general"],
    ["tenant", "candidate", "job", "technical"],
  ])
    assert.notEqual(interviewMintLockKey(args[0], args[1], args[2], args[3]), expected);
});
