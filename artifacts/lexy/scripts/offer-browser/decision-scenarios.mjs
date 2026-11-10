import assert from "node:assert/strict";
import { absent, fill, state, tid, value, workflow, job } from "./harness.mjs";

function decision(completed = false) {
  return {
    canApprove: true,
    jobApproved: true,
    offerState: state("draft"),
    wf: {
      id: workflow,
      candidateId: "synthetic-candidate",
      candidateName: "Synthetic Candidate",
      journeyId: "synthetic-journey",
      journeyVersion: 1,
      interviewPath: "ai",
      status: completed ? "completed" : "ready",
      revision: 10,
      stale: false,
      steps: [
        {
          key: "evaluation_review",
          label: "Evaluation",
          authority: "human",
          status: "completed",
          evidence: "Synthetic review.",
        },
        {
          key: "hiring_decision",
          label: "Hiring decision",
          authority: "human",
          status: completed ? "completed" : "pending",
          evidence: null,
          ...(completed
            ? {
                humanDecision: {
                  outcome: "hire",
                  reason: "Synthetic original intent.",
                  actorId: "synthetic-approver",
                  actorName: "Synthetic Approver",
                  decidedAt: "2026-01-01T00:00:00Z",
                  testOnly: true,
                },
              }
            : {}),
        },
      ],
    },
  };
}
export const decisionScenarios = [
  ...["authority", "job approval", "current brief"].map((change) => ({
    name: `Human decision confirmation resets after losing ${change}`,
    mode: "decision",
    initial: () => decision(),
    async run({ page, posts, snapshot }) {
      await page.click(tid("button-decision-hire"));
      await fill(page, tid("input-decision-reason"), "Synthetic reviewed hiring intent.");
      await page.click(tid("button-decision-review"));
      await page.waitForSelector(tid("confirm-decision"));
      const changed = decision();
      if (change === "authority") changed.canApprove = false;
      if (change === "job approval") changed.jobApproved = false;
      if (change === "current brief") changed.wf.stale = true;
      await snapshot(changed);
      await page.waitForFunction(
        (selector) => !document.querySelector(selector),
        {},
        tid("confirm-decision"),
      );
      await snapshot(decision());
      await page.waitForSelector(tid("button-decision-review"));
      await absent(page, tid("button-decision-confirm"));
      await value(page, tid("input-decision-reason"), "Synthetic reviewed hiring intent.");
      assert.equal(posts.length, 0);
    },
  })),
  {
    name: "Changing candidate workflow resets decision intent and private written reason",
    mode: "decision",
    initial: () => decision(),
    async run({ page, posts, snapshot }) {
      await page.click(tid("button-decision-hire"));
      await fill(
        page,
        tid("input-decision-reason"),
        "Synthetic private reason for first candidate.",
      );
      const next = decision();
      next.wf.id = `${workflow}-other`;
      next.wf.candidateId = "synthetic-other-candidate";
      await snapshot(next, `${job}-other`, `${workflow}-other`);
      await value(page, tid("input-decision-reason", `${workflow}-other`), "");
      assert.equal(
        await page.$eval(tid("button-decision-hire", `${workflow}-other`), (el) =>
          el.getAttribute("aria-checked"),
        ),
        "false",
      );
      assert.equal(posts.length, 0);
    },
  },
  {
    name: "Open decision correction closes when authority is revoked and requires deliberate reopening",
    mode: "decision",
    initial: () => decision(true),
    async run({ page, posts, snapshot }) {
      await page.click(tid("correction-open"));
      await page.waitForSelector('form[aria-label="Correct hiring decision"]');
      await snapshot({ ...decision(true), canApprove: false });
      await page.waitForFunction(
        () => !document.querySelector('form[aria-label="Correct hiring decision"]'),
      );
      await snapshot(decision(true));
      await page.waitForSelector(tid("correction-open"));
      await absent(page, 'form[aria-label="Correct hiring decision"]');
      assert.equal(posts.length, 0);
    },
  },
];
