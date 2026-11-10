import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import {
  accountInterviewTurn,
  isInterviewAudioClarification,
  interviewEvaluationWarning,
  parseInterviewGrade,
  type ConversationAnswer,
} from "./interview-turn-policy";

const clarification =
  "I may not have caught that correctly — could you repeat what you said about your experience with TypeScript?";
const first: ConversationAnswer[] = [
  {
    questionId: "turn-1",
    questionText: "Describe your API project.",
    answer: "unclear capture",
    score: null,
  },
];
const turn = (questionText: string, answerText = "I built REST APIs.", turnNumber = 2) => ({
  questionText,
  answerText,
  turnNumber,
});

test("positive low score and negative strong score need human review, including a real zero", () => {
  for (const score of [0, 46, 69])
    assert.match(interviewEvaluationWarning(score, "yes")!, /human decision/);
  assert.match(interviewEvaluationWarning(85, "no")!, /declining/);
  assert.match(interviewEvaluationWarning(100, "decline")!, /declining/);
  assert.equal(interviewEvaluationWarning(70, "advance"), null);
  assert.equal(interviewEvaluationWarning(84, "no"), null);
  assert.equal(interviewEvaluationWarning(46, "maybe"), null);
  assert.equal(interviewEvaluationWarning(46, "no"), null);
  for (const score of [null, undefined, NaN, -1, 101, "46"]) {
    assert.match(interviewEvaluationWarning(score, "yes")!, /no valid interview score/);
  }
});

test("audio clarification recognition is conservative, not skill-gap adaptation", () => {
  assert.equal(isInterviewAudioClarification(clarification), true);
  assert.equal(
    isInterviewAudioClarification("I couldn't hear that. Could you say that again?"),
    true,
  );
  assert.equal(isInterviewAudioClarification("मुझे सुनाई नहीं दिया। कृपया फिर से बताएं।"), true);
  assert.equal(
    isInterviewAudioClarification("Je n'ai pas bien entendu. Pouvez-vous répéter ?"),
    true,
  );
  for (const question of [
    "What languages do you know?",
    "Could you repeat your deployment strategy?",
    "You don't know TypeScript. Tell me about Python instead.",
    "How would you repeat failed API requests safely?",
    "I didn't catch the exception in my code. How would you implement repeat retries?",
  ]) {
    assert.equal(isInterviewAudioClarification(question), false);
  }
});

test("malformed grades are unscored, never coerced or clamped; real zero survives", () => {
  for (const grade of [
    null,
    [],
    "82",
    {},
    { score: null },
    { score: "82" },
    { score: NaN },
    { score: Infinity },
    { score: -1 },
    { score: 101 },
  ]) {
    assert.equal(parseInterviewGrade(grade), null);
  }
  assert.deepEqual(parseInterviewGrade({ score: 0, feedback: " No relevant example. " }), {
    score: 0,
    feedback: "No relevant example.",
  });
  assert.deepEqual(parseInterviewGrade({ score: 82.4, feedback: 42 }), { score: 82 });
});

test("partial or absent grading requires review even for Maybe and zero is assessed", () => {
  assert.match(
    interviewEvaluationWarning(
      82,
      "maybe",
      [
        { score: 82, answer: "Used indexed queries." },
        { score: null, answer: "Other answer." },
      ],
      2,
    )!,
    /Only 1 of 2/,
  );
  assert.match(interviewEvaluationWarning(82, "no", [{ score: 82 }], 3)!, /Only 1 of 3/);
  assert.match(
    interviewEvaluationWarning(99, "maybe", [{ score: 0, answer: " " }], 1)!,
    /No valid graded answers/,
  );
  assert.match(interviewEvaluationWarning(99, "maybe", [], 1)!, /No valid graded answers/);
  assert.equal(
    interviewEvaluationWarning(0, "no", [{ score: 0, answer: "I don't know." }], 1),
    null,
  );
});

test("headline mismatch and conflicting recommendation remain visible together", () => {
  const warning = interviewEvaluationWarning(60, "yes", [{ score: 10 }], 1)!;
  assert.match(warning, /saved answer-grade average 10/);
  assert.match(warning, /explicit human decision/);
});

test("recapture replaces only the ungraded answer, preserves original question and evidence, consumes no slot", () => {
  const before = JSON.stringify(first);
  const corrected = accountInterviewTurn(first, 1, turn(clarification));
  assert.equal(corrected.currentQuestionIndex, 1);
  assert.equal(corrected.answers.length, 1);
  assert.equal(corrected.answers[0].questionId, "turn-1");
  assert.equal(corrected.answers[0].questionText, first[0].questionText);
  assert.equal(corrected.answers[0].answer, "I built REST APIs.");
  assert.equal(corrected.answers[0].score, null);
  assert.equal(corrected.answers[0].captureClarifications?.[0].previousAnswer, "unclear capture");
  assert.equal(JSON.stringify(first), before);
  const retry = accountInterviewTurn(corrected.answers, 1, turn(clarification));
  assert.equal(retry.answers[0].captureClarifications?.length, 1);
  const repeated = accountInterviewTurn(retry.answers, 1, turn(clarification, "I built two APIs."));
  assert.equal(repeated.answers.length, 1);
  assert.equal(repeated.currentQuestionIndex, 1);
  const substantive = accountInterviewTurn(
    repeated.answers,
    1,
    turn("How did you validate requests?"),
  );
  assert.equal(substantive.answers.length, 2);
  assert.equal(substantive.currentQuestionIndex, 2);
});

test("normal retry is idempotent; out-of-order, missing prior answer and graded corrections fail", () => {
  const next = accountInterviewTurn(first, 1, turn("Which database did you use?"));
  assert.deepEqual(
    accountInterviewTurn(next.answers, 2, turn("Which database did you use?")),
    next,
  );
  assert.throws(
    () => accountInterviewTurn(first, 1, turn(clarification, "answer", 3)),
    /preceding/,
  );
  assert.throws(() => accountInterviewTurn([], 0, turn(clarification, "answer", 1)), /preceding/);
  assert.throws(
    () => accountInterviewTurn([{ ...first[0], score: 0 }], 1, turn(clarification)),
    /assessed/,
  );
  assert.throws(() => accountInterviewTurn(first, 1, turn("Next?", "answer", 3)), /sequence/);
  assert.throws(() => accountInterviewTurn(first, 1, turn("Next?", "", 2)), /Invalid/);
});

test("UI, persistence and workflow warnings use the same policy; saves are locked and completed sessions protected", () => {
  const room = readFileSync(
    new URL("../../../lexy/src/pages/recruiter/interviews/room.tsx", import.meta.url),
    "utf8",
  );
  const routes = readFileSync(new URL("../routes/interviews.ts", import.meta.url), "utf8");
  const report = readFileSync(
    new URL("../../../lexy/src/pages/recruiter/interviews/[id].tsx", import.meta.url),
    "utf8",
  );
  const evidence = readFileSync(new URL("./workflow-runtime-evidence.ts", import.meta.url), "utf8");
  assert.match(room, /const nextQ = clarification \? qNum : qNum \+ 1/);
  assert.match(room, /await save/);
  assert.match(room, /answerSaveError &&/);
  assert.match(routes, /accountInterviewTurn/);
  assert.match(routes, /\.for\("update"\)/);
  assert.match(routes, /"in_progress", "active", "resumed"/);
  assert.match(
    report,
    /interviewEvaluationWarning\(overallScore, recommendation, answers, interview.totalQuestions\)/,
  );
  assert.match(report, /Human evaluation review required/);
  assert.match(evidence, /interviewEvaluationWarning\(\s*a\.overallScore,\s*a\.recommendation,/);
});
