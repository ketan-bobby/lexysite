import { VOICE_PROGRESS_DIMENSIONS } from "./types";
import type { VoiceProgressComparison, VoiceProgressDimensionResult, VoiceProgressEvaluation, VoiceProgressFormDefinition } from "./types";

const levelOrder = ["not_observed", "emerging", "developing", "consistent"] as const;
const safeRegex = (pattern: string) => new RegExp(pattern, "iu");

export function evaluateVoiceProgress(form: VoiceProgressFormDefinition, responses: Record<string, string>): VoiceProgressEvaluation {
  const dimensions: VoiceProgressDimensionResult[] = VOICE_PROGRESS_DIMENSIONS.map((dimension) => {
    const prompts = form.prompts.filter((prompt) => prompt.coveredDimensions.includes(dimension));
    let possible = 0;
    let observed = 0;
    let unsafe = false;
    const evidence: string[] = [];
    const recommendations = new Set<string>();
    for (const prompt of prompts) {
      const text = (responses[prompt.key] ?? "").trim();
      if (text.replace(/\s/gu, "").length < prompt.minimumNonSpaceCharacters) continue;
      for (const fact of prompt.facts) {
        possible += 1;
        const match = fact.patterns.find((pattern) => safeRegex(pattern).test(text));
        if (match) {
          observed += 1;
          evidence.push(`Observed ${fact.id}: "${text.match(safeRegex(match))?.[0]?.slice(0, 48) ?? match}"`);
        } else evidence.push(`Not observed: ${fact.id}`);
      }
      possible += 1;
      if (/[.!?]/u.test(text) && /\b(?:check|confirm|next|update|question|if)\b/iu.test(text)) observed += 1;
      else evidence.push("No clear response boundary observed");
      if (prompt.unsafePatterns.some((pattern) => safeRegex(pattern).test(text))) {
        unsafe = true;
        evidence.push("Unsupported promise pattern observed");
      }
      for (const lesson of prompt.recommendationLessonIds[dimension] ?? []) recommendations.add(lesson);
    }
    let level: VoiceProgressDimensionResult["level"] = possible === 0 ? "not_observed" : observed === 0 ? "emerging" : observed >= possible && !unsafe ? "consistent" : observed * 2 >= possible ? "developing" : "emerging";
    if (unsafe && level !== "not_observed") level = levelOrder[Math.max(1, levelOrder.indexOf(level) - 1)] as VoiceProgressDimensionResult["level"];
    return { dimension, level, observed, possible, evidence: evidence.slice(0, 12), recommendationLessonIds: [...recommendations] };
  });
  return {
    form: form.form,
    comparisonFamilyVersion: form.comparisonFamilyVersion,
    rubricVersion: form.rubricVersion,
    evaluatorVersion: form.evaluatorVersion,
    dimensions,
    recommendations: [...new Set(dimensions.flatMap((dimension) => dimension.recommendationLessonIds))],
    overallSummary: "This private voice progress report describes observed communication evidence in the submitted responses. It does not establish professional proficiency or hiring readiness.",
  };
}

export function compareVoiceProgress(
  baseline: VoiceProgressEvaluation,
  progress: VoiceProgressEvaluation,
): VoiceProgressComparison {
  if (baseline.comparisonFamilyVersion !== progress.comparisonFamilyVersion || baseline.rubricVersion !== progress.rubricVersion || baseline.evaluatorVersion !== progress.evaluatorVersion || baseline.form !== "A" || progress.form !== "B") {
    return { comparable: false, reason: "These observations use different structured forms or evaluator versions, so observed change cannot be compared safely.", dimensions: VOICE_PROGRESS_DIMENSIONS.map((dimension) => ({ dimension, baselineLevel: "not_comparable", progressLevel: "not_comparable", observedDifference: "not_comparable", evidence: [] })) };
  }
  return {
    comparable: true,
    reason: "This comparison describes observed differences between two equivalent structured voice forms. It is not proof that training caused the difference.",
    dimensions: baseline.dimensions.map((before) => {
      const after = progress.dimensions.find((item) => item.dimension === before.dimension)!;
      const beforeIndex = levelOrder.indexOf(before.level);
      const afterIndex = levelOrder.indexOf(after.level);
      return {
        dimension: before.dimension,
        baselineLevel: before.level,
        progressLevel: after.level,
        observedDifference: afterIndex > beforeIndex ? "higher" : afterIndex < beforeIndex ? "lower" : "same",
        evidence: [...after.evidence],
      };
    }),
  };
}