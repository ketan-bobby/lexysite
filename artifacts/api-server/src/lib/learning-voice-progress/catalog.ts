import type { VoiceProgressFormDefinition, VoiceProgressPrompt } from "./types";

export const VOICE_PROGRESS_COMPARISON_FAMILY_VERSION = "support-voice-progress-v1" as const;
export const VOICE_PROGRESS_RUBRIC_VERSION = "support-communication-v1" as const;
export const VOICE_PROGRESS_EVALUATOR_VERSION = "deterministic-evaluator-v1" as const;

const common = {
  minimumNonSpaceCharacters: 40,
  unsafePatterns: ["guarantee", "definitely refund", "no matter what", "promise"],
};

const formA: VoiceProgressPrompt[] = [
  {
    ...common,
    key: "baseline-order-update",
    prompt: "A customer is waiting for an order update. Explain what you know, acknowledge the delay, ask one focused question if needed, and describe the next bounded step.",
    coveredDimensions: ["clarity_structure", "empathy_tone", "clarification", "action_accuracy"],
    facts: [
      { id: "acknowledge", patterns: ["acknowledge", "understand", "sorry", "concern"] },
      { id: "order-detail", patterns: ["order", "delivery", "update", "delay"] },
      { id: "focused-check", patterns: ["check", "confirm", "order number", "address"] },
      { id: "bounded-next-step", patterns: ["next", "update", "contact", "within", "by"] },
    ],
    recommendationLessonIds: { clarity_structure: ["foundations-plain-accurate-sentences"], empathy_tone: ["foundations-reading-for-intent-detail"], clarification: ["foundations-clarify-confirm"], action_accuracy: ["foundations-summarize-reconstruct"] },
  },
  {
    ...common,
    key: "baseline-billing-question",
    prompt: "A customer questions a charge. Respond as a support representative: clarify the relevant transaction, show care, and explain what you can verify before proposing a next step.",
    coveredDimensions: ["clarity_structure", "empathy_tone", "clarification", "action_accuracy"],
    facts: [
      { id: "billing-detail", patterns: ["charge", "billing", "invoice", "payment"] },
      { id: "care", patterns: ["understand", "sorry", "concern", "review"] },
      { id: "verify", patterns: ["check", "confirm", "transaction", "date", "amount"] },
      { id: "condition", patterns: ["if", "once", "after", "next", "update"] },
    ],
    recommendationLessonIds: { clarity_structure: ["foundations-plain-accurate-sentences"], empathy_tone: ["foundations-reading-for-intent-detail"], clarification: ["foundations-clarify-confirm"], action_accuracy: ["foundations-summarize-reconstruct"] },
  },
  {
    ...common,
    key: "baseline-technical-check",
    prompt: "A customer says a feature is not working. Give a calm spoken response that gathers the most useful missing detail, avoids unsupported certainty, and sets out the next check.",
    coveredDimensions: ["empathy_tone", "clarification", "action_accuracy", "channel_execution"],
    facts: [
      { id: "acknowledge", patterns: ["understand", "sorry", "frustrat", "help"] },
      { id: "missing-detail", patterns: ["device", "browser", "error", "when", "steps"] },
      { id: "check", patterns: ["check", "confirm", "try", "review"] },
      { id: "next", patterns: ["next", "update", "follow up", "if"] },
    ],
    recommendationLessonIds: { empathy_tone: ["foundations-reading-for-intent-detail"], clarification: ["foundations-clarify-confirm"], action_accuracy: ["foundations-summarize-reconstruct"], channel_execution: ["foundations-support-vocabulary"] },
  },
  {
    ...common,
    key: "baseline-handoff",
    prompt: "You need to hand a customer issue to another team. Give a concise spoken handoff that captures the issue, what has been checked, the customer's need, and what happens next.",
    coveredDimensions: ["clarity_structure", "action_accuracy", "channel_execution"],
    facts: [
      { id: "issue", patterns: ["issue", "problem", "request", "customer"] },
      { id: "checked", patterns: ["check", "confirmed", "reviewed", "verified"] },
      { id: "need", patterns: ["need", "needs", "waiting", "impact"] },
      { id: "handoff-next", patterns: ["handoff", "team", "next", "update", "follow up"] },
    ],
    recommendationLessonIds: { clarity_structure: ["foundations-plain-accurate-sentences"], action_accuracy: ["foundations-summarize-reconstruct"], channel_execution: ["foundations-support-vocabulary"] },
  },
];

const formB: VoiceProgressPrompt[] = [
  {
    ...common, key: "progress-subscription-delay",
    prompt: "A customer is waiting for a subscription change to take effect. Explain what you know, acknowledge the impact, ask one focused question if needed, and describe the next bounded step.",
    coveredDimensions: ["clarity_structure", "empathy_tone", "clarification", "action_accuracy"],
    facts: [
      { id: "subscription-detail", patterns: ["subscription", "plan", "change", "active", "billing cycle"] },
      { id: "impact", patterns: ["understand", "sorry", "impact", "concern", "inconvenience"] },
      { id: "account-check", patterns: ["check", "confirm", "account", "email", "plan"] },
      { id: "activation-step", patterns: ["next", "update", "effective", "within", "by"] },
    ],
    recommendationLessonIds: { clarity_structure: ["foundations-plain-accurate-sentences"], empathy_tone: ["foundations-reading-for-intent-detail"], clarification: ["foundations-clarify-confirm"], action_accuracy: ["foundations-summarize-reconstruct"] },
  },
  {
    ...common, key: "progress-invoice-question",
    prompt: "A customer questions an invoice line. Respond as a support representative: clarify the relevant transaction, show care, and explain what you can verify before proposing a next step.",
    coveredDimensions: ["clarity_structure", "empathy_tone", "clarification", "action_accuracy"],
    facts: [
      { id: "invoice-detail", patterns: ["invoice", "line", "statement", "charge", "billing"] },
      { id: "care", patterns: ["understand", "sorry", "concern", "review", "help"] },
      { id: "transaction-check", patterns: ["check", "confirm", "transaction", "date", "amount"] },
      { id: "resolution-condition", patterns: ["if", "once", "after", "next", "update"] },
    ],
    recommendationLessonIds: { clarity_structure: ["foundations-plain-accurate-sentences"], empathy_tone: ["foundations-reading-for-intent-detail"], clarification: ["foundations-clarify-confirm"], action_accuracy: ["foundations-summarize-reconstruct"] },
  },
  {
    ...common, key: "progress-login-check",
    prompt: "A customer says they cannot sign in. Give a calm spoken response that gathers the most useful missing detail, avoids unsupported certainty, and sets out the next check.",
    coveredDimensions: ["empathy_tone", "clarification", "action_accuracy", "channel_execution"],
    facts: [
      { id: "access-concern", patterns: ["sign in", "login", "access", "sorry", "frustrat"] },
      { id: "diagnostic-detail", patterns: ["device", "browser", "error", "when", "steps"] },
      { id: "account-check", patterns: ["check", "confirm", "try", "review", "reset"] },
      { id: "follow-up", patterns: ["next", "update", "follow up", "if", "again"] },
    ],
    recommendationLessonIds: { empathy_tone: ["foundations-reading-for-intent-detail"], clarification: ["foundations-clarify-confirm"], action_accuracy: ["foundations-summarize-reconstruct"], channel_execution: ["foundations-support-vocabulary"] },
  },
  {
    ...common, key: "progress-specialist-handoff",
    prompt: "You need to hand a customer's account issue to a specialist team. Give a concise spoken handoff that captures the issue, what has been checked, the customer's need, and what happens next.",
    coveredDimensions: ["clarity_structure", "action_accuracy", "channel_execution"],
    facts: [
      { id: "account-issue", patterns: ["account", "issue", "problem", "request", "customer"] },
      { id: "diagnostic-history", patterns: ["check", "confirmed", "reviewed", "verified", "tried"] },
      { id: "customer-need", patterns: ["need", "waiting", "impact", "access", "resolution"] },
      { id: "specialist-next", patterns: ["specialist", "team", "handoff", "next", "update"] },
    ],
    recommendationLessonIds: { clarity_structure: ["foundations-plain-accurate-sentences"], action_accuracy: ["foundations-summarize-reconstruct"], channel_execution: ["foundations-support-vocabulary"] },
  },
];

export const VOICE_PROGRESS_FORMS: Readonly<Record<"A" | "B", VoiceProgressFormDefinition>> = {
  A: { form: "A", comparisonFamilyVersion: VOICE_PROGRESS_COMPARISON_FAMILY_VERSION, rubricVersion: VOICE_PROGRESS_RUBRIC_VERSION, evaluatorVersion: VOICE_PROGRESS_EVALUATOR_VERSION, prompts: formA },
  B: { form: "B", comparisonFamilyVersion: VOICE_PROGRESS_COMPARISON_FAMILY_VERSION, rubricVersion: VOICE_PROGRESS_RUBRIC_VERSION, evaluatorVersion: VOICE_PROGRESS_EVALUATOR_VERSION, prompts: formB },
};

export function getVoiceProgressForm(form: "A" | "B"): VoiceProgressFormDefinition {
  return VOICE_PROGRESS_FORMS[form];
}

function validateCatalog(): void {
  const a = VOICE_PROGRESS_FORMS.A;
  const b = VOICE_PROGRESS_FORMS.B;
  if (a.prompts.length !== b.prompts.length) throw new Error("Voice progress forms must have equal prompt counts");
  for (let i = 0; i < a.prompts.length; i += 1) {
    const aDimensions = [...a.prompts[i].coveredDimensions].sort().join(",");
    const bDimensions = [...b.prompts[i].coveredDimensions].sort().join(",");
    if (aDimensions !== bDimensions) throw new Error(`Voice progress form coverage mismatch at ${i}`);
    if (a.prompts[i].facts.length !== b.prompts[i].facts.length) throw new Error(`Voice progress fact mismatch at ${i}`);
  }
}
validateCatalog();