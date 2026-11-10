import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { resolveInterviewSummary } from "./interview-summary-result.js";

const transcript = "Q: Have you used TypeScript?\nA: I don't have experience";
const graded = (score: unknown = 10) => [{ answer: "I don't have experience", score }];
const result = {
  overallScore: 10,
  strengths: [],
  weaknesses: ["No demonstrated backend experience"],
  redFlags: [],
  recommendation: "no",
  recruiterSummary: "The candidate reported no relevant development experience.",
};

test("empty strengths never turn into invented positive evidence", () => {
  const summary = resolveInterviewSummary(result, graded(), transcript);
  assert.deepEqual(summary.strengths, []);
  assert.equal(summary.overallScore, 10);
  assert.equal(summary.recommendation, "no");
});

test("missing, malformed or unanchored bullets stay empty", () => {
  for (const strengths of [
    undefined,
    null,
    "Strong candidate",
    [null, 42, " "],
    ['Used "production TypeScript"'],
  ]) {
    const summary = resolveInterviewSummary(
      { ...result, strengths, weaknesses: [] },
      graded(),
      transcript,
    );
    assert.deepEqual(summary.strengths, []);
    assert.deepEqual(summary.weaknesses, []);
  }
});

test("real evidence and quote anchoring are preserved", () => {
  const summary = resolveInterviewSummary(
    {
      ...result,
      strengths: ["Reported limits honestly"],
      redFlags: ['Denied "I don\'t have experience"', 'Claimed "production TypeScript"'],
    },
    graded(),
    transcript,
  );
  assert.deepEqual(summary.strengths, ["Reported limits honestly"]);
  assert.equal(summary.redFlags.length, 1);
});

test("headline still averages actual grades and preserves a real zero", () => {
  assert.equal(resolveInterviewSummary(result, graded(0), transcript).overallScore, 0);
  assert.equal(
    resolveInterviewSummary(result, [...graded(0), ...graded(20), ...graded(null)], transcript)
      .overallScore,
    10,
  );
});

test("missing or invalid assessment scores never default to 75", () => {
  for (const overallScore of [undefined, null, "75", NaN, Infinity, -1, 101]) {
    assert.throws(
      () =>
        resolveInterviewSummary(
          { ...result, overallScore: 75 },
          [{ answer: "I don't have experience", score: overallScore }],
          transcript,
        ),
      /valid assessment score/,
    );
  }
});

test("invalid results, recommendations and narratives fail instead of producing a solid candidate", () => {
  for (const value of [null, undefined, [], "invalid"]) {
    assert.throws(() => resolveInterviewSummary(value, graded(), transcript), /invalid result/);
  }
  assert.throws(
    () => resolveInterviewSummary({ ...result, recommendation: undefined }, graded(), transcript),
    /valid hiring recommendation/,
  );
  for (const recruiterSummary of [undefined, "", " ", 'Candidate built "production TypeScript"']) {
    assert.throws(
      () => resolveInterviewSummary({ ...result, recruiterSummary }, graded(), transcript),
      /supported narrative/,
    );
  }
});

test("generated headline never substitutes for failed grading or missing capture", () => {
  for (const answers of [[], graded(null), graded("82"), graded(NaN), graded(101)]) {
    assert.throws(
      () => resolveInterviewSummary({ ...result, overallScore: 99 }, answers, transcript),
      /no (captured candidate answers|valid assessment score)/,
    );
  }
  assert.throws(
    () => resolveInterviewSummary(result, [{ answer: " ", score: 0 }], transcript),
    /no captured/,
  );
  assert.equal(
    resolveInterviewSummary({ ...result, overallScore: "fabricated" }, graded(0), transcript)
      .overallScore,
    0,
  );
});

test("interviewer questions cannot support quoted candidate claims, including curly quotes", () => {
  const summary = resolveInterviewSummary(
    {
      ...result,
      strengths: ['Used "Have you used TypeScript"', "Used “Have you used TypeScript”"],
    },
    graded(),
    transcript,
  );
  assert.deepEqual(summary.strengths, []);
  assert.throws(
    () =>
      resolveInterviewSummary(
        {
          ...result,
          recruiterSummary: 'Candidate stated "Have you used TypeScript".',
        },
        graded(),
        transcript,
      ),
    /supported narrative/,
  );
});

test("quoted evidence preserves apostrophes and rejects partial or fabricated continuations", () => {
  const summary = resolveInterviewSummary(
    {
      ...result,
      strengths: [
        'Said "I don’t have experience"',
        'Said "I don\'t have experience with production TypeScript"',
      ],
    },
    graded(),
    transcript,
  );
  assert.deepEqual(summary.strengths, ['Said "I don’t have experience"']);
});

test("ordinary contractions are not misread as invented quotation marks", () => {
  assert.equal(
    resolveInterviewSummary(
      {
        ...result,
        recruiterSummary: "The candidate doesn't claim experience; they've reported limits.",
      },
      graded(),
      transcript,
    ).recommendation,
    "no",
  );
});

test("the real queue handler validates before saving and propagates generation failures", () => {
  const source = readFileSync(new URL("./ai-queue/handlers.ts", import.meta.url), "utf8");
  const handler = source.slice(
    source.indexOf("const summarizeInterview:"),
    source.indexOf("/* AEDT"),
  );
  assert.ok(
    handler.indexOf("resolveInterviewSummary(generatedSummary") <
      handler.indexOf(".insert(interviewSummariesTable)"),
  );
  assert.match(handler, /assessment not saved[\s\S]*throw err;/);
  assert.doesNotMatch(
    handler,
    /Solid candidate|Clear communication|Relevant experience|overallScore = 75/,
  );
});
