import { LEARNING_COURSES } from "../learning-courses/catalog";
import { FOUNDATIONS_ASSESSMENTS } from "./course-foundations";
import { PRACTICE_ASSESSMENTS } from "./course-practice";
import type {
  AssessmentDefinition,
  AssessmentDimensionId,
  AssessmentLevel,
  AssessmentReport,
  AssessmentResponses,
  RubricDimension,
} from "./types";

export * from "./types";
export const ASSESSMENT_RUBRIC_VERSION = "support-communication-v1" as const;
export const ASSESSMENT_TASK_SET_VERSION = 1 as const;

export const RUBRIC_DIMENSIONS: RubricDimension[] = [
  { id: "clarity_structure", label: "Clarity and structure", description: "States relevant facts in an understandable order.", anchors: { emerging: "Few relevant facts are visible.", developing: "Some relevant facts are organized.", consistent: "Relevant facts and conditions are organized for the reader or listener." } },
  { id: "empathy_tone", label: "Empathy and tone", description: "Acknowledges the customer's experience with respectful, non-blaming language.", anchors: { emerging: "Little acknowledgement is visible.", developing: "Acknowledgement is present but uneven.", consistent: "Acknowledgement and respectful tone are clear." } },
  { id: "clarification", label: "Clarification", description: "Uses focused questions to establish missing or ambiguous information.", anchors: { emerging: "The missing detail is not yet narrowed.", developing: "A useful question or check is partly visible.", consistent: "The response narrows the relevant uncertainty with a focused question or check." } },
  { id: "action_accuracy", label: "Action and next-step accuracy", description: "Separates known actions from conditions and avoids unsupported certainty.", anchors: { emerging: "The next action is sparse or overconfident.", developing: "Some actions or conditions are accurately stated.", consistent: "Actions, conditions, and next steps are accurately bounded." } },
  { id: "channel_execution", label: "Channel execution", description: "Uses the requested written or spoken response format and captures operational details.", anchors: { emerging: "The requested channel details are sparse.", developing: "Several requested details are captured.", consistent: "The response captures the requested details in a usable channel format." } },
];

const DEFINITIONS: AssessmentDefinition[] = [
  ...Object.values(FOUNDATIONS_ASSESSMENTS),
  ...Object.values(PRACTICE_ASSESSMENTS),
];
export const ASSESSMENT_DEFINITIONS: readonly AssessmentDefinition[] = DEFINITIONS;

const levelOrder: AssessmentLevel[] = ["not_observed", "emerging", "developing", "consistent"];

function responseFor(responses: AssessmentResponses, key: string, index: number): string {
  if (Array.isArray(responses)) return responses[index] ?? "";
  return responses[key] ?? "";
}

function safeRegex(source: string): RegExp {
  return new RegExp(source, "iu");
}

function observation(text: string): number {
  // These are deliberately broad response-shape observations, not grammar tests.
  return (/[.!?]/u.test(text) ? 1 : 0) + (/\b(?:check|confirm|next|update|email|question)\b/iu.test(text) ? 1 : 0);
}

export function getAssessmentDefinition(courseId: string, path: "voice" | "chat_email"): AssessmentDefinition | undefined {
  return DEFINITIONS.find((definition) => definition.courseId === courseId && definition.path === path);
}

export function evaluateAssessment(definition: AssessmentDefinition, responses: AssessmentResponses): AssessmentReport {
  const outcomes = RUBRIC_DIMENSIONS.map((rubric) => {
    const relevant = definition.tasks.flatMap((task, index) =>
      task.coveredDimensions.includes(rubric.id) ? [{ task, index, response: responseFor(responses, task.key, index) }] : [],
    );
    const evidence: string[] = [];
    let possible = 0;
    let observed = 0;
    let unsafe = false;
    const recommendations = new Set<string>();

    for (const item of relevant) {
      const text = item.response.trim();
      if (!text || text.replace(/\s/gu, "").length < item.task.minimumNonSpaceCharacters) continue;
      item.task.facts.forEach((fact) => {
        possible += 1;
        const match = fact.patterns.map(safeRegex).find((pattern) => pattern.test(text));
        if (match) {
          observed += 1;
          const found = text.match(match)?.[0] ?? "";
          evidence.push(`Matched ${fact.id}: "${found.slice(0, 48)}"`);
        } else {
          evidence.push(`Not observed: ${fact.id}`);
        }
      });
      possible += 1;
      if (observation(text) > 0) observed += 1;
      else evidence.push("No clear response boundary observed");
      if (item.task.unsafePromises.some((promise) => promise.patterns.map(safeRegex).some((pattern) => pattern.test(text)))) {
        unsafe = true;
        evidence.push("Unsupported promise pattern observed");
      }
      for (const lesson of item.task.recommendationLessonIds[rubric.id] ?? []) recommendations.add(lesson);
    }

    let level: AssessmentLevel;
    if (possible === 0) level = "not_observed";
    else if (observed === 0) level = "emerging";
    else if (observed >= possible && !unsafe) level = "consistent";
    else if (observed * 2 >= possible) level = "developing";
    else level = "emerging";
    if (unsafe && level !== "not_observed") level = levelOrder[Math.max(1, levelOrder.indexOf(level) - 1)];
    return {
      dimension: rubric.id,
      label: rubric.label,
      level,
      evidence: evidence.slice(0, 12),
      observed,
      possible,
      recommendationLessonIds: [...recommendations],
    };
  });
  const recommendations = [...new Set(outcomes.flatMap((outcome) => outcome.recommendationLessonIds))];
  const visible = outcomes.filter((outcome) => outcome.level !== "not_observed");
  const overallSummary = visible.length === 0
    ? "No eligible response was supplied, so no current developmental evidence is available."
    : "This private report summarizes current evidence from the submitted developmental tasks and suggests practice lessons where useful.";
  return { rubricVersion: ASSESSMENT_RUBRIC_VERSION, taskSetVersion: ASSESSMENT_TASK_SET_VERSION, courseId: definition.courseId, path: definition.path, dimensions: outcomes, overallSummary, recommendations };
}

function validateCatalog(): void {
  const courses = new Map(LEARNING_COURSES.map((course) => [course.id, course]));
  for (const definition of DEFINITIONS) {
    const taskKeys = new Set<string>();
    const factKeys = new Set<string>();
    for (const task of definition.tasks) {
      if (taskKeys.has(task.key)) throw new Error(`Duplicate assessment task key: ${task.key}`);
      taskKeys.add(task.key);
      for (const fact of task.facts) {
        if (factKeys.has(fact.id)) throw new Error(`Duplicate assessment fact id: ${fact.id}`);
        factKeys.add(fact.id);
        fact.patterns.forEach(safeRegex);
      }
      task.unsafePromises.forEach((promise) => promise.patterns.forEach(safeRegex));
      Object.values(task.recommendationLessonIds).flat().forEach((lessonId) => {
        const lesson = courses.get(definition.courseId)?.lessons.find((candidate) => candidate.id === lessonId);
        if (!lesson || (lesson.track !== "shared" && lesson.track !== definition.path)) {
          throw new Error(`Recommendation lesson is not in target course path: ${lessonId}`);
        }
      });
    }
    for (const dimension of RUBRIC_DIMENSIONS) {
      if (!definition.tasks.some((task) => task.coveredDimensions.includes(dimension.id))) throw new Error(`Assessment has no task for ${dimension.id}`);
    }
  }
}
validateCatalog();