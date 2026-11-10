import { test } from "node:test";
import assert from "node:assert/strict";
import {
  withInterviewLoadTimeout,
  interviewResumeState,
  interviewStartView,
} from "./interview-session-load";

test("session load returns data without waiting for optional metadata", async () => {
  assert.equal(await withInterviewLoadTimeout(async () => "session"), "session");
});
test("unresponsive request times out and aborts instead of spinning indefinitely", async () => {
  let signal!: AbortSignal;
  await assert.rejects(
    withInterviewLoadTimeout((s) => {
      signal = s;
      return new Promise(() => {});
    }, 5),
    /took too long/,
  );
  assert.equal(signal.aborted, true);
});
test("authorization errors propagate unchanged to the verification handler", async () => {
  const error = Object.assign(new Error("verification needed"), { status: 401 });
  await assert.rejects(
    withInterviewLoadTimeout(async () => {
      throw error;
    }),
    (e) => e === error,
  );
});
test("resuming two saved answers restores their transcript and question three", () => {
  const result = interviewResumeState({
    currentQuestionIndex: 2,
    answers: [
      { questionText: "Q1", answer: "A1" },
      { questionText: "Q2", answer: "A2" },
    ],
  });
  assert.equal(result.nextQuestion, 3);
  assert.deepEqual(
    result.history.map((turn) => turn.text),
    ["Q1", "A1", "Q2", "A2"],
  );
});
test("new session starts at question one", () => {
  assert.deepEqual(interviewResumeState({ currentQuestionIndex: 0 }), {
    history: [],
    nextQuestion: 1,
  });
});

test("fresh interview retains its original start wording", () => {
  const view = interviewStartView({ status: "scheduled", currentQuestionIndex: 0, answers: [] }, 3);
  assert.equal(view.resuming, false);
  assert.equal(view.title, null);
  assert.equal(view.action, "Start Interview with Lexy");
});

test("refresh before the first answer still explains that the interview already started", () => {
  const view = interviewStartView(
    { status: "active", startedAt: "2026-10-07T11:00:00Z", currentQuestionIndex: 0 },
    3,
  );
  assert.equal(view.resuming, true);
  assert.equal(view.saved, 0);
  assert.equal(view.nextQuestion, 1);
  assert.equal(view.action, "Continue interview");
});

test("refresh with partial progress shows continue and the next unanswered question", () => {
  const view = interviewStartView({ currentQuestionIndex: 2, answers: [{}, {}] }, 3);
  assert.equal(view.resuming, true);
  assert.equal(view.saved, 2);
  assert.equal(view.nextQuestion, 3);
  assert.equal(view.allAnswered, false);
  assert.equal(view.action, "Continue interview");
  assert.equal(view.pending, "Resuming interview…");
});

test("all answers saved shows finish, not a new start or question four of three", () => {
  const view = interviewStartView({ currentQuestionIndex: 3, answers: [{}, {}, {}] }, 3);
  assert.equal(view.allAnswered, true);
  assert.equal(view.title, "Finish your interview");
  assert.equal(view.action, "Finish interview");
});

test("saved answers still signal resumption when optional start metadata is absent", () => {
  const view = interviewStartView({ answers: [{}] }, 3);
  assert.equal(view.resuming, true);
  assert.equal(view.saved, 1);
  assert.equal(view.action, "Continue interview");
});
