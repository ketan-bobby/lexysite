/**
 * Explicitly opt-in live smoke samples for human review, using the configured
 * conversation model/routing. Synthetic histories only: no candidate sessions,
 * emails, saved answers, assessment updates or interview resets.
 *
 * pnpm --filter @workspace/api-server exec tsx scripts/check-interview-adaptation.mts --live
 */
import assert from "node:assert/strict";
import { generateWithAI } from "../src/lib/ai.js";
import {
  buildInterviewContinuationDirective,
  buildInterviewSystemPrompt,
} from "../src/lib/interview-conversation-prompt.js";

if (!process.argv.includes("--live")) {
  throw new Error("Pass --live to generate five synthetic samples using the configured provider.");
}

const directive = buildInterviewContinuationDirective(
  "technical depth, problem-solving approaches, past projects, architectural thinking, tools and technologies",
);
const system = buildInterviewSystemPrompt({
  jobTitle: "Backend Engineer",
  interviewType: "technical",
  langLabel: "English",
  candidateCtxBlock: "\nCANDIDATE BACKGROUND: JavaScript developer",
  jobCtxBlock: "\nJOB CONTEXT: TypeScript, JavaScript, PostgreSQL, APIs",
  focusBlock: "",
  customQBlock: "",
  phase: "continuing",
});

const samples = [
  {
    name: "declared_gap",
    expected: "Acknowledge the gap and ask about JavaScript or another relevant competency.",
    history:
      "Lexy: Tell me about your experience with TypeScript.\n\nCandidate: I am completely new to TypeScript, but I have experience with JavaScript.",
  },
  {
    name: "confirmed_gap",
    expected:
      "No repeated clarification or assumed TypeScript experience; explore the JavaScript API.",
    history:
      "Lexy: Tell me about TypeScript.\n\nCandidate: I do not know TypeScript.\n\nLexy: Just to clarify, have you used it at work?\n\nCandidate: No, I have never used it. I built a Node.js API using JavaScript.",
  },
  {
    name: "unclear_transcript",
    expected: "Clarify the uncertain meaning without inventing or praising TypeScript experience.",
    history:
      "Lexy: Tell me about your experience with TypeScript.\n\nCandidate: I say I am no idea about ice cream but as it is similar to JavaScript I can use it with the help of books internet.",
  },
  {
    name: "conflicting_claim",
    expected:
      "Neutral clarification of hands-on versus assisted experience, not assumed proficiency.",
    history:
      "Lexy: Tell me about TypeScript.\n\nCandidate: I do not know TypeScript. I only know JavaScript.\n\nLexy: Have you used TypeScript in any project?\n\nCandidate: I used TypeScript in many projects, but I completed them with the help of the internet and books.",
  },
  {
    name: "experienced_candidate",
    expected: "A substantive technical follow-up is still allowed when experience is stated.",
    history:
      "Lexy: Tell me about a TypeScript backend project.\n\nCandidate: I have used TypeScript professionally for three years. I designed a typed repository with generics and discriminated unions, and used PostgreSQL transactions for consistency.",
  },
];

for (const sample of samples) {
  const response = await generateWithAI(
    `${directive}\n\nConversation so far:\n${sample.history}`,
    system,
    "en-US",
    { model: "gpt-4o-mini", maxTokens: 220 },
  );
  assert.ok(response.trim(), "Provider must return a non-empty response");
  console.log(JSON.stringify({ sample: sample.name, expected: sample.expected, response }));
}
