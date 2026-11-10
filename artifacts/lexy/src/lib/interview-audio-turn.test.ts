import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  interviewResumeGreeting,
  isInterviewGreetingOnly,
  shouldTranscribeInterviewSegment,
  shouldUseServerInterviewCapture,
} from "./interview-audio-turn";

const desktop = {
  language: "en",
  userAgent: "Chrome/140",
  mobile: false,
  browserSpeechAvailable: true,
};
test("Chrome English validates answers with the configured server capture", () => {
  assert.equal(shouldUseServerInterviewCapture(desktop), true);
});
test("greetings do not consume a question, but substantive or honest gap answers do", () => {
  for (const text of ["Hi", "Hello Lexy!", "Good morning.", "नमस्ते"])
    assert.equal(isInterviewGreetingOnly(text), true);
  for (const text of [
    "I don't know TypeScript",
    "No",
    "Hi, I build APIs",
    "Hello world is printed by this function",
  ])
    assert.equal(isInterviewGreetingOnly(text), false);
});
test("Edge uses the existing server transcription chain, not its unreliable browser recognizer", () => {
  assert.equal(
    shouldUseServerInterviewCapture({ ...desktop, userAgent: "Chrome/140 Edg/140" }),
    true,
  );
});
test("mobile, non-English, and missing browser speech use existing server capture", () => {
  assert.equal(shouldUseServerInterviewCapture({ ...desktop, mobile: true }), true);
  assert.equal(shouldUseServerInterviewCapture({ ...desktop, language: "ta" }), true);
  assert.equal(
    shouldUseServerInterviewCapture({ ...desktop, browserSpeechAvailable: false }),
    true,
  );
});
test("resumed English interviews introduce Lexy without pretending to start over", () => {
  const greeting = interviewResumeGreeting("en-US", 3, 3);
  assert.match(greeting!, /I'm Lexy/);
  assert.match(greeting!, /earlier answers are saved/);
  assert.match(greeting!, /question 3 of 3/);
});
test("resume after the last answer announces closing steps, never question four of three", () => {
  for (const nextQuestion of [4, 5]) {
    const greeting = interviewResumeGreeting("en-US", nextQuestion, 3);
    assert.match(greeting!, /I'm Lexy/);
    assert.match(greeting!, /All of your interview answers are saved/);
    assert.match(greeting!, /remaining closing steps/);
    assert.doesNotMatch(greeting!, /question \d+ of/);
  }
});
test("missing or invalid counts never produce an impossible spoken question number", () => {
  for (const total of [0, -1, NaN]) {
    assert.match(interviewResumeGreeting("en", 3, total)!, /continue where you left off/);
  }
});
test("new and non-English interviews keep their established generated opening", () => {
  assert.equal(interviewResumeGreeting("en", 1, 3), null);
  assert.equal(interviewResumeGreeting("ta", 3, 3), null);
  assert.equal(interviewResumeGreeting("ta", 4, 3), null);
});
test("silence auto-finalization never transcribes unvoiced room noise", () => {
  assert.equal(shouldTranscribeInterviewSegment(false, true, false), false);
  assert.equal(shouldTranscribeInterviewSegment(false, false, false), false);
});
test("voiced segments and explicitly submitted quiet answers are retained", () => {
  assert.equal(shouldTranscribeInterviewSegment(true, false, false), true);
  assert.equal(shouldTranscribeInterviewSegment(true, true, false), true);
  assert.equal(shouldTranscribeInterviewSegment(false, true, true), true);
});
