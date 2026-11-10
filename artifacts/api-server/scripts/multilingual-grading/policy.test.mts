import assert from "node:assert/strict";
import test from "node:test";
import { fixtures, caseKinds } from "./fixtures.mts";
import {
  diagnosticGrade,
  diagnosticUsageArea,
  gradeIssues,
  parityIssues,
  renderTemplate,
} from "./policy.mts";
import { contractSpans } from "../rubric-extract.mjs";

test("usage labels fit the existing durable-sink allowlist without a schema change", () => {
  for (const f of fixtures)
    for (const kind of caseKinds) {
      const area = diagnosticUsageArea("00000000-0000-0000-0000-000000000000", f.locale, kind);
      assert.match(area, /^workflow:[A-Za-z0-9_-]{1,128}:ai_interview$/);
      assert.ok(area.includes("grading_diag_"));
    }
  assert.throws(() => diagnosticUsageArea("foreign:scope", "hi", "thin"), /Invalid/);
  assert.throws(() => diagnosticUsageArea("x".repeat(128), "hi", "thin"), /Invalid/);
});

test("all ten synthetic translations preserve the named tools and outcome numbers", () => {
  assert.equal(fixtures.length, 10);
  assert.equal(new Set(fixtures.map((f) => f.locale)).size, fixtures.length);
  for (const f of fixtures) {
    for (const fact of ["2.4", "60%", "Redis MGET", "30", "320", "18%"])
      assert.ok(f.substantive.includes(fact), `${f.locale} lacks ${fact}`);
    assert.ok(f.question && f.thin && f.refusal);
  }
  assert.deepEqual(caseKinds, ["substantive", "thin", "refusal", "missing"]);
});

test("live queued-grader templates render without changing the frozen contract", () => {
  const spans = new Map(contractSpans());
  const prompt = renderTemplate(spans.get("src/lib/ai-queue/handlers.ts#user-prompt")!, {
    "args.focusLine": "",
    "args.questionText": "Question with ${literal}",
    ans: "తెలుగు answer with ${literal}",
    langLabel: "Telugu",
  });
  assert.ok(prompt.includes("\n\nQuestion: Question with ${literal}\nAnswer: తెలుగు"));
  assert.ok(prompt.includes("1 honest sentence in Telugu"));
  assert.throws(() => renderTemplate("x ${newSlot}`", {}), /Unknown grading slot/);
});

test("missing capture never invokes the provider and remains null, not zero", async () => {
  let calls = 0;
  const grader = async () => {
    calls++;
    return { score: 100 };
  };
  assert.equal(await diagnosticGrade("q", " \n ", "te", grader), null);
  assert.equal(calls, 0);
  assert.deepEqual(gradeIssues("missing", null), []);
  assert.deepEqual(gradeIssues("missing", { score: 0 }), ["missing_capture_was_scored"]);
});

test("provider failures and malformed grades stay unavailable in every fixture locale", async () => {
  for (const f of fixtures) {
    for (const value of [{}, { score: "90" }, { score: NaN }, { score: 101 }, null]) {
      assert.equal(await diagnosticGrade(f.question, f.refusal, f.locale, async () => value), null);
    }
    assert.equal(
      await diagnosticGrade(f.question, f.refusal, f.locale, async () => {
        throw new Error("synthetic provider outage");
      }),
      null,
    );
  }
});

test("valid zero is retained and refusal threshold is strict", async () => {
  const result = await diagnosticGrade("q", "I don't know", "en-US", async () => ({
    score: 0,
    feedback: "No experience stated.",
  }));
  assert.equal(result?.score, 0);
  assert.deepEqual(gradeIssues("refusal", result), []);
  assert.deepEqual(gradeIssues("refusal", { score: 20, feedback: "x" }), ["refusal_not_below_20"]);
  assert.deepEqual(gradeIssues("thin", { score: 71, feedback: "x" }), [
    "generic_answer_above_average_band",
  ]);
  assert.deepEqual(gradeIssues("substantive", { score: 74, feedback: "x" }), [
    "substance_below_existing_probe_floor",
  ]);
});

test("failed parity is not silently waived or treated as a missing zero", () => {
  assert.deepEqual(parityIssues(90, 80), []);
  assert.deepEqual(parityIssues(90, 79), ["translated_score_gap_over_10"]);
  assert.deepEqual(parityIssues(null, 0), ["parity_not_measurable"]);
});
