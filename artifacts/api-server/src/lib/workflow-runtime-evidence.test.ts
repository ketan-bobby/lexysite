import { test } from "node:test";
import assert from "node:assert/strict";
import { journeySteps } from "./recruiting-workflows";
import {
  projectRuntimeEvidence,
  runtimeEvidenceBlockedReason,
  verificationActivity,
  type Observation,
} from "./workflow-runtime-evidence";
import type { recruitingWorkflowsTable } from "@workspace/db";

const start = new Date("2026-01-01T00:00:00Z");
const at = (seconds: number) => new Date(start.getTime() + seconds * 1000).toISOString();
const workflow = () =>
  ({
    id: "wf",
    tenantId: "tenant",
    jobId: "job",
    candidateId: "candidate",
    journeyId: "journey",
    journeyVersion: 1,
    interviewPath: "ai",
    status: "ready",
    revision: 1,
    steps: journeySteps("ai"),
    createdById: "human",
    createdAt: start,
    updatedAt: start,
  }) as typeof recruitingWorkflowsTable.$inferSelect;
const observation = (stepKey: string, overrides: Partial<Observation> = {}): Observation => ({
  candidateId: "candidate",
  stepKey,
  sourceType: "fixture",
  sourceId: stepKey,
  occurredAt: at(20),
  initiatedAt: at(10),
  scope: "job",
  summary: "Saved source",
  qualifies: true,
  attentionRequired: false,
  ...overrides,
});
const now = new Date(at(100));

test("pending verification is visible as unresolved, never a reviewable completed check", () => {
  const wf = workflow();
  wf.steps[0].status = "completed";
  const before = JSON.stringify(wf);
  const activity = verificationActivity("pending")!;
  assert.equal(activity.qualifies, false);
  assert.equal(activity.attentionRequired, true);
  const result = projectRuntimeEvidence(
    wf,
    [observation("verification", { sourceType: "identity_verification", ...activity })],
    null,
    now,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].readyForReview, false);
  assert.equal(result[0].attentionRequired, true);
  assert.match(result[0].summary, /not completed verification evidence/);
  assert.match(result[0].reason!, /Identity verification is still pending/);
  assert.equal(JSON.stringify(wf), before);
});

test("pre-enrollment pending identity remains visible for resolution, not completion", () => {
  const wf = workflow();
  wf.steps[0].status = "completed";
  const [result] = projectRuntimeEvidence(
    wf,
    [
      observation("verification", {
        sourceType: "identity_verification",
        ...verificationActivity("pending")!,
        initiatedAt: at(-100),
        occurredAt: at(-100),
      }),
    ],
    null,
    now,
  );
  assert.equal(result.readyForReview, false);
  assert.equal(result.attentionRequired, true);
  assert.match(result.reason!, /pending/);
});

test("real flagged verification outcomes remain visible and require human attention", () => {
  const wf = workflow();
  wf.steps[0].status = "completed";
  const activity = verificationActivity("flagged")!;
  const [result] = projectRuntimeEvidence(
    wf,
    [observation("verification", { sourceType: "identity_verification", ...activity })],
    null,
    now,
  );
  assert.equal(result.readyForReview, true);
  assert.equal(result.attentionRequired, true);
  assert.match(result.summary, /flagged/);
  assert.equal(wf.steps[1].status, "pending");
});

test("verified outcomes can be reviewed after screening, but never complete steps automatically", () => {
  const wf = workflow();
  wf.steps[0].status = "completed";
  const [result] = projectRuntimeEvidence(
    wf,
    [
      observation("verification", {
        sourceType: "identity_verification",
        ...verificationActivity("verified")!,
      }),
    ],
    null,
    now,
  );
  assert.equal(result.readyForReview, true);
  assert.equal(result.attentionRequired, false);
  assert.equal(wf.steps[1].status, "pending");
});

test("unstarted and unknown verification states do not claim an observed check", () => {
  assert.equal(verificationActivity("unverified"), null);
  assert.equal(verificationActivity("unknown"), null);
  for (const status of ["review", "rejected", "failed"]) {
    assert.equal(verificationActivity(status)?.attentionRequired, true);
    assert.equal(verificationActivity(status)?.qualifies, true);
  }
});

test("verification excludes other candidates, future and completed earlier-attempt evidence", () => {
  const inputs = [
    observation("verification", {
      sourceType: "identity_verification",
      ...verificationActivity("pending")!,
      candidateId: "foreign",
    }),
    observation("verification", {
      sourceType: "identity_verification",
      ...verificationActivity("verified")!,
      initiatedAt: at(-1),
    }),
    observation("verification", {
      sourceType: "identity_verification",
      ...verificationActivity("pending")!,
      occurredAt: at(101),
    }),
  ];
  assert.deepEqual(projectRuntimeEvidence(workflow(), inputs, null, now), []);
});

test("observations do not mutate steps, revision, stage or approval; next step needs human review", () => {
  const wf = workflow();
  const before = JSON.stringify(wf);
  const result = projectRuntimeEvidence(wf, [observation("screening")], null, now);
  assert.equal(result.length, 1);
  assert.equal(result[0].readyForReview, true);
  assert.equal(JSON.stringify(wf), before);
});
test("old, future, other-candidate and wrong-path activity never becomes workflow evidence", () => {
  const result = projectRuntimeEvidence(
    workflow(),
    [
      observation("screening", { initiatedAt: at(-1) }),
      observation("screening", { occurredAt: at(101) }),
      observation("screening", { candidateId: "foreign" }),
      observation("human_interview"),
    ],
    null,
    now,
  );
  assert.deepEqual(result, []);
});
test("sent mail is not positive interest; prior reviews and reply timing are required", () => {
  const wf = workflow();
  const inputs = [
    observation("engagement", { qualifies: false }),
    observation("ai_interview"),
    observation("evaluation_review", { sourceType: "interview_assessment" }),
  ];
  const result = projectRuntimeEvidence(wf, inputs, null, now);
  assert.ok(result.every((entry) => !entry.readyForReview));
  assert.equal(result.find((e) => e.stepKey === "ai_interview")?.attentionRequired, true);
  assert.equal(result.find((e) => e.stepKey === "evaluation_review")?.attentionRequired, true);
});
test("an interview following recorded interest is reviewable only after preceding human reviews", () => {
  const wf = workflow();
  const inputs = [
    observation("engagement", { occurredAt: at(2), initiatedAt: at(1) }),
    observation("ai_interview"),
  ];
  assert.equal(projectRuntimeEvidence(wf, inputs, null, now)[1].readyForReview, false);
  wf.steps.slice(0, 3).forEach((s) => {
    s.status = "completed";
  });
  const ai = projectRuntimeEvidence(wf, inputs, null, now).find(
    (e) => e.stepKey === "ai_interview",
  )!;
  assert.equal(ai.readyForReview, true);
  assert.equal(ai.attentionRequired, false);
});
test("a later reply never validates an earlier invitation", () => {
  const wf = workflow();
  wf.steps.slice(0, 3).forEach((s) => {
    s.status = "completed";
  });
  const result = projectRuntimeEvidence(
    wf,
    [observation("engagement", { occurredAt: at(15) }), observation("ai_interview")],
    null,
    now,
  );
  assert.equal(result.find((e) => e.stepKey === "ai_interview")?.readyForReview, false);
});
test("evaluation observations honor the selected AI/human path", () => {
  const wf = workflow();
  wf.steps = journeySteps("human");
  const result = projectRuntimeEvidence(
    wf,
    [
      observation("evaluation_review", { sourceType: "interview_assessment" }),
      observation("evaluation_review", { sourceType: "human_interview_feedback" }),
    ],
    null,
    now,
  );
  assert.equal(result.length, 1);
  assert.equal(result[0].sourceType, "human_interview_feedback");
});
test("paused history is blocked; cancelled history freezes; stale/unapproved briefs link nothing", () => {
  const wf = workflow();
  wf.status = "paused";
  const reason = runtimeEvidenceBlockedReason(wf, true, true);
  assert.equal(
    projectRuntimeEvidence(wf, [observation("screening")], reason, now)[0].readyForReview,
    false,
  );
  wf.status = "cancelled";
  wf.updatedAt = new Date(at(15));
  assert.deepEqual(
    projectRuntimeEvidence(
      wf,
      [observation("screening")],
      runtimeEvidenceBlockedReason(wf, true, true),
      now,
    ),
    [],
  );
  assert.deepEqual(
    projectRuntimeEvidence(
      wf,
      [observation("screening")],
      runtimeEvidenceBlockedReason(wf, false, true),
      now,
    ),
    [],
  );
  assert.deepEqual(
    projectRuntimeEvidence(
      wf,
      [observation("screening")],
      runtimeEvidenceBlockedReason(wf, true, false),
      now,
    ),
    [],
  );
});
test("source tokens are stable but bind to workflow, journey version, step and source revision", () => {
  const wf = workflow();
  const id = projectRuntimeEvidence(wf, [observation("screening")], null, now)[0].id;
  assert.equal(projectRuntimeEvidence(wf, [observation("screening")], null, now)[0].id, id);
  wf.journeyVersion++;
  assert.notEqual(projectRuntimeEvidence(wf, [observation("screening")], null, now)[0].id, id);
  wf.journeyVersion--;
  assert.notEqual(
    projectRuntimeEvidence(wf, [observation("screening", { version: "changed" })], null, now)[0].id,
    id,
  );
});
