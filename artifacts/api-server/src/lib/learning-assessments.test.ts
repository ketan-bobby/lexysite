import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateAssessment, getAssessmentDefinition } from "./learning-assessments/catalog";
import { getLearningCourse } from "../lib/learning-courses/catalog";

test("assessment evaluator reports current evidence without scores", () => {
  const definition = getAssessmentDefinition("support-communication-foundations", "voice");
  assert.ok(definition);
  const report = evaluateAssessment(
    definition,
    Object.fromEntries(
      definition.tasks.map((task) => [
        task.key,
        "I acknowledge the concern, check the order, and confirm the next update on Wednesday.",
      ]),
    ),
  );
  assert.equal(report.rubricVersion, "support-communication-v1");
  assert.equal(report.taskSetVersion, 1);
  assert.ok(
    report.dimensions.every((dimension) =>
      ["emerging", "developing", "consistent", "not_observed"].includes(dimension.level),
    ),
  );
  assert.equal("percentage" in report, false);
  assert.equal("score" in report, false);
  assert.ok(report.dimensions.some((dimension) => dimension.recommendationLessonIds.length > 0));
});

test("assessment definitions keep recommendations inside their selected path", () => {
  for (const path of ["voice", "chat_email"] as const) {
    const definition = getAssessmentDefinition("support-communication-foundations", path);
    assert.ok(definition);
    const course = getLearningCourse(definition.courseId);
    assert.ok(course);
    const selected = new Set(
      course.lessons
        .filter((lesson) => lesson.track === "shared" || lesson.track === path)
        .map((lesson) => lesson.id),
    );
    for (const task of definition.tasks) {
      for (const lessonId of Object.values(task.recommendationLessonIds).flat()) {
        assert.equal(
          selected.has(lessonId),
          true,
          `${path} recommendation ${lessonId} must be in selected path`,
        );
      }
    }
  }
});

test("evaluator is deterministic and preserves response boundaries", () => {
  const definition = getAssessmentDefinition("support-communication-foundations", "voice");
  assert.ok(definition);
  const task = definition.tasks[0];
  const cases = [
    { name: "empty", response: "", expected: "not_observed" },
    {
      name: "below minimum",
      response: "x".repeat(task.minimumNonSpaceCharacters - 1),
      expected: "not_observed",
    },
    {
      name: "bounded evidence",
      response:
        "The order was approved today; stock arrives Wednesday; dispatch follows a quality check.",
      expected: "consistent",
    },
    {
      name: "unsafe promise is downgraded",
      response: "I guarantee a refund immediately and will update you next.",
      expected: "emerging",
    },
  ] as const;
  for (const item of cases) {
    const responses = Object.fromEntries(
      definition.tasks.map((candidate) => [
        candidate.key,
        candidate.key === task.key ? item.response : "",
      ]),
    );
    const first = evaluateAssessment(definition, responses);
    const second = evaluateAssessment(definition, responses);
    assert.deepEqual(second, first, `${item.name} must be deterministic`);
    const outcome = first.dimensions.find((dimension) =>
      task.coveredDimensions.includes(dimension.dimension),
    );
    assert.ok(outcome);
    assert.equal(outcome.level, item.expected, item.name);
  }
});

test("evaluator accepts array responses without mutating inputs", () => {
  const definition = getAssessmentDefinition("support-communication-foundations", "chat_email");
  assert.ok(definition);
  const responses = definition.tasks.map(
    () => "I acknowledge the issue, ask a focused question, and confirm the next update.",
  );
  const before = [...responses];
  const report = evaluateAssessment(definition, responses);
  assert.deepEqual(responses, before);
  assert.equal(report.courseId, definition.courseId);
  assert.equal(report.path, "chat_email");
  assert.equal(report.dimensions.length, 5);
  assert.deepEqual(report.recommendations, [
    ...new Set(report.dimensions.flatMap((item) => item.recommendationLessonIds)),
  ]);
});
