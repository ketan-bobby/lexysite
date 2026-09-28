import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedShortlistPresentation } from "./approved-shortlist-presentation";

const row = {
  id: "submission",
  candidateId: "candidate",
  fullName: "Test Candidate",
  bio: "PRIVATE_BASELINE_DEVELOPMENT_NOTE",
  note: "PRIVATE_PRACTICE_WEAKNESS",
  growthAreas: ["PRIVATE_GROWTH"],
  recordingUrl: "PRIVATE_RECORDING",
  analysis: "PRIVATE_ANALYSIS",
};
const introduction = {
  candidateId: "candidate",
  summary: "Candidate-approved professional introduction.",
  strengths: [{ title: "Support", evidence: "Three years of account support." }],
  achievements: [],
  careerDirection: "Customer success",
  preferences: null,
  availability: null,
  approvedAt: new Date(),
};

test("shortlist never serializes historical narrative or private extra fields", () => {
  const result = approvedShortlistPresentation(row, introduction);
  assert.equal(result?.bio, introduction.summary);
  assert.equal(result?.note, null);
  assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
});

test("withdrawal or missing approval suppresses the old presentation", () => {
  assert.equal(approvedShortlistPresentation(row, undefined), null);
});

test("an introduction for a different candidate never authorizes presentation", () => {
  assert.equal(approvedShortlistPresentation(row, { ...introduction, candidateId: "other" }), null);
});