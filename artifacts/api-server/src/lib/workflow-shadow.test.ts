import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  JobWorkflowState,
  PlannedCandidateWorkflow,
  PlannedWorkflowJourney,
} from "@workspace/api-zod";
import { buildWorkflowShadow } from "./workflow-shadow";

const job = {
  id: "job-a",
  status: "active" as const,
  recruitingMode: "human_assisted" as const,
  internalMobility: false,
};
const hash = "1".repeat(64);
const keys = [
  "screening",
  "verification",
  "engagement",
  "human_interview",
  "evaluation_review",
  "hiring_decision",
];
const journey = (): PlannedWorkflowJourney => ({
  id: "journey-a",
  version: 1,
  status: "approved",
  briefHash: hash,
  stale: false,
  interviewPath: "human",
  createdById: "actor",
  approvedById: "approver",
  steps: keys.map((key) => ({
    key,
    label: key,
    authority: "human_review",
    status: "pending",
    evidence: null,
  })),
});
const workflow = (): PlannedCandidateWorkflow => ({
  id: "workflow-a",
  candidateId: "candidate-a",
  candidateName: "Candidate A",
  journeyId: "journey-a",
  journeyVersion: 1,
  interviewPath: "human",
  status: "ready",
  revision: 1,
  stale: false,
  steps: structuredClone(journey().steps),
});
function state(): JobWorkflowState {
  return {
    briefHash: hash,
    autonomyExecutionEnabled: false,
    canEdit: true,
    canApprove: false,
    jobApproved: true,
    journeys: [journey()],
    workflows: [workflow()],
    candidates: [],
    events: [],
  };
}
const proposal = (s: JobWorkflowState) =>
  buildWorkflowShadow(job, s, "2026-10-05T00:00:00.000Z").proposals[1];
test("pure shadow rules do not mutate inputs, enable execution, call models or fabricate a cost quote", () => {
  const s = state(),
    before = structuredClone(s);
  const view = buildWorkflowShadow(job, s);
  assert.deepEqual(s, before);
  assert.equal(view.methodology, "deterministic_workflow_rules");
  assert.equal(view.modelCalls, 0);
  assert.equal(view.executionAllowed, false);
  assert.equal(view.autonomyExecutionEnabled, false);
  assert.equal(view.estimatedExecutionCost, null);
  assert.ok(view.proposals.every((p) => p.executionAllowed === false));
});
test("internal-first scope distinguishes this client's employees from known nonemployees", () => {
  const normal = buildWorkflowShadow(job, state());
  const mobility = buildWorkflowShadow({ ...job, internalMobility: true }, state());
  assert.equal(normal.sourcingScope, "known_nonemployees_then_permitted_external");
  assert.match(normal.proposals[0].explanation, /Internal review is advisory/);
  assert.match(normal.proposals[0].explanation, /separately approved scope and budget/);
  assert.equal(mobility.sourcingScope, "client_current_employees");
  assert.match(mobility.proposals[0].explanation, /owned by this hiring client/);
});
test("a mode preset never grants execution authority", () => {
  for (const recruitingMode of ["human_assisted", "lexy_autonomous"] as const) {
    const view = buildWorkflowShadow({ ...job, recruitingMode }, state());
    assert.equal(view.executionAllowed, false);
    assert.equal(view.proposals[1].executionAllowed, false);
  }
});
test("no current approved journey blocks requisition sourcing suggestions", () => {
  const s = state();
  s.journeys = [];
  s.workflows = [];
  const view = buildWorkflowShadow(job, s);
  assert.equal(view.proposals.length, 1);
  assert.equal(view.proposals[0].disposition, "blocked");
  assert.match(view.proposals[0].reasons.join(" "), /no approved journey/);
});
test("first unresolved step is grounded in this workflow's manual notes, not AI assessment scores", () => {
  const s = state();
  assert.equal(proposal(s).nextStepKey, "screening");
  s.workflows[0].steps[0].status = "completed";
  s.workflows[0].steps[0].evidence = "Human screening note";
  assert.equal(proposal(s).nextStepKey, "verification");
  assert.equal(proposal(s).completedSteps, 1);
  assert.equal(proposal(s).evidenceSource, "manual_workflow_notes");
  assert.match(proposal(s).explanation, /not AI scores/);
});
for (const status of ["failed", "review_required"] as const) {
  test(`${status} asks for human recovery, never rejection or skipped stages`, () => {
    const s = state();
    s.workflows[0].steps[0].status = status;
    s.workflows[0].steps[0].evidence = "Unresolved evidence";
    const p = proposal(s);
    assert.equal(p.nextStepKey, "screening");
    assert.equal(p.disposition, "review_required");
    assert.match(p.explanation, /do not infer a rejection/);
  });
}
for (const change of ["paused", "stale", "unapproved", "wrong_version", "job_not_live"] as const) {
  test(`${change} blocks the proposal rather than authorizing a fallback`, () => {
    const s = state();
    if (change === "paused") s.workflows[0].status = "paused";
    if (change === "stale") s.workflows[0].stale = true;
    if (change === "unapproved") s.journeys[0].status = "draft";
    if (change === "wrong_version") s.workflows[0].journeyVersion = 2;
    if (change === "job_not_live") s.jobApproved = false;
    assert.equal(proposal(s).disposition, "blocked");
    assert.ok(proposal(s).reasons.length);
  });
}
for (const status of ["cancelled", "completed"] as const) {
  test(`${status} is terminal and never proposes a restart`, () => {
    const s = state();
    s.workflows[0].status = status;
    assert.equal(proposal(s).disposition, "terminal");
    assert.equal(proposal(s).nextStepKey, null);
  });
}
test("final hiring decision remains a human review checkpoint with current-role authority", () => {
  const s = state();
  for (const step of s.workflows[0].steps.slice(0, -1)) {
    step.status = "completed";
    step.evidence = "Human note";
  }
  const p = proposal(s);
  assert.equal(p.disposition, "review_required");
  assert.equal(p.nextStepKey, "hiring_decision");
  assert.match(p.reasons.join(" "), /role cannot record/);
  s.canApprove = true;
  assert.equal(proposal(s).executionAllowed, false);
  assert.equal(proposal(s).disposition, "review_required");
});
test("missing manual evidence, unsupported steps and invented authority fail closed", () => {
  const missing = state();
  missing.workflows[0].steps[0].status = "completed";
  assert.equal(proposal(missing).disposition, "review_required");
  assert.match(proposal(missing).title, /missing completion evidence/);
  for (const key of ["unknown", "constructor", "toString"]) {
    const s = state();
    s.workflows[0].steps[0].key = key;
    assert.equal(proposal(s).disposition, "review_required");
  }
  const bad = state();
  Object.assign(bad.workflows[0].steps[0], { authority: "automatic" });
  assert.equal(proposal(bad).disposition, "review_required");
});
test("interview proposals name consent/scheduling/budget checks without asserting those checks passed", () => {
  for (const path of ["ai", "human", "ai_then_human", "human_then_ai"] as const) {
    const s = state();
    s.journeys[0].interviewPath = path;
    s.workflows[0].interviewPath = path;
    const interviews =
      path === "ai"
        ? ["ai_interview"]
        : path === "human"
          ? ["human_interview"]
          : path === "ai_then_human"
            ? ["ai_interview", "human_interview"]
            : ["human_interview", "ai_interview"];
    s.workflows[0].steps = [
      "screening",
      "verification",
      "engagement",
      ...interviews,
      "evaluation_review",
      "hiring_decision",
    ].map((key, i) => ({
      key,
      label: key,
      authority: "human_review",
      status: i < 3 ? "completed" : "pending",
      evidence: i < 3 ? "Manual note" : null,
    }));
    const p = proposal(s);
    assert.equal(p.disposition, "proposed");
    assert.equal(p.nextStepKey, interviews[0]);
    assert.match(
      p.requiredChecks.join(" "),
      interviews[0] === "ai_interview" ? /AI consent/ : /Calendar permission/,
    );
    assert.equal(p.executionAllowed, false);
  }
});
