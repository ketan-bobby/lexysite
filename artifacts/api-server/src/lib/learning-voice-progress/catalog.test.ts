import assert from "node:assert/strict";
import { test } from "node:test";
import { compareVoiceProgress, evaluateVoiceProgress } from "./evaluator";
import { VOICE_PROGRESS_FORMS, VOICE_PROGRESS_COMPARISON_FAMILY_VERSION, VOICE_PROGRESS_EVALUATOR_VERSION, VOICE_PROGRESS_RUBRIC_VERSION } from "./catalog";

test("paired forms cover the same constructs with fresh prompts and exact versions", () => {
  const a = VOICE_PROGRESS_FORMS.A;
  const b = VOICE_PROGRESS_FORMS.B;
  assert.equal(a.prompts.length, 4);
  assert.equal(b.prompts.length, 4);
  assert.equal(new Set(a.prompts.map((prompt) => prompt.key)).size, 4);
  assert.equal(new Set(b.prompts.map((prompt) => prompt.key)).size, 4);
  assert.deepEqual(a.prompts.map((prompt) => [...prompt.coveredDimensions].sort()), b.prompts.map((prompt) => [...prompt.coveredDimensions].sort()));
  assert.equal(a.comparisonFamilyVersion, VOICE_PROGRESS_COMPARISON_FAMILY_VERSION);
  assert.equal(a.rubricVersion, VOICE_PROGRESS_RUBRIC_VERSION);
  assert.equal(a.evaluatorVersion, VOICE_PROGRESS_EVALUATOR_VERSION);
  assert.notDeepEqual(a.prompts.map((prompt) => prompt.prompt), b.prompts.map((prompt) => prompt.prompt));
});

test("evaluation is deterministic and unsafe promises cannot produce consistent evidence", () => {
  const form = VOICE_PROGRESS_FORMS.A;
  const responses = Object.fromEntries(form.prompts.map((prompt) => [prompt.key, "I acknowledge the concern, check the order details, confirm the next update, and provide a careful answer."]));
  assert.deepEqual(evaluateVoiceProgress(form, responses), evaluateVoiceProgress(form, responses));
  const unsafe = { ...responses, [form.prompts[0].key]: "I guarantee a refund no matter what. I will definitely update you next." };
  const result = evaluateVoiceProgress(form, unsafe);
  assert.notEqual(result.dimensions.find((dimension) => dimension.dimension === "clarity_structure")?.level, "consistent");
  assert.ok(result.overallSummary.includes("not"));
});

test("incompatible versions fail closed as not comparable", () => {
  const responses = Object.fromEntries(VOICE_PROGRESS_FORMS.A.prompts.map((prompt) => [prompt.key, "I acknowledge the concern, check the order details, confirm the next update, and provide a careful answer."]));
  const baseline = evaluateVoiceProgress(VOICE_PROGRESS_FORMS.A, responses);
  const progress = evaluateVoiceProgress({ ...VOICE_PROGRESS_FORMS.B, rubricVersion: "different-rubric" }, responses);
  const comparison = compareVoiceProgress(baseline, progress);
  assert.equal(comparison.comparable, false);
  assert.ok(comparison.dimensions.every((dimension) => dimension.observedDifference === "not_comparable"));
});

test("semantically equivalent paired answers produce the same levels", () => {
  const answersA = [
    "I understand the order delay and acknowledge your concern. I will check the order number, confirm the delivery update, and explain the next step.",
    "I understand your concern about the charge. I will review the invoice, confirm the transaction date and amount, and provide the next update.",
    "I am sorry the feature is not working. I will check your device and browser error, confirm the steps you tried, and explain what happens next.",
    "I will summarize the customer issue, explain what we checked and verified, note the customer's need, and hand it to the team for the next update.",
  ];
  const answersB = [
    "I understand the impact of the subscription delay. I will check the account and plan, confirm when the change becomes active, and provide the next update.",
    "I understand your concern about the invoice line. I will review the statement, confirm the transaction date and amount, and explain the next update once checked.",
    "I am sorry you cannot sign in. I will check your device and browser error, confirm the steps you tried, and explain the next check if access still fails.",
    "I will summarize the account issue, explain what we checked and verified, note the customer's need, and hand it to the specialist team for the next update.",
  ];
  const baseline = evaluateVoiceProgress(VOICE_PROGRESS_FORMS.A, Object.fromEntries(VOICE_PROGRESS_FORMS.A.prompts.map((prompt, index) => [prompt.key, answersA[index]])));
  const progress = evaluateVoiceProgress(VOICE_PROGRESS_FORMS.B, Object.fromEntries(VOICE_PROGRESS_FORMS.B.prompts.map((prompt, index) => [prompt.key, answersB[index]])));
  assert.deepEqual(progress.dimensions.map((dimension) => dimension.level), baseline.dimensions.map((dimension) => dimension.level));
});