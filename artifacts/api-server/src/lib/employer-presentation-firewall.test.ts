import assert from "node:assert/strict";
import test from "node:test";
import {
  sanitizeEmployerPackageSnapshot,
  sanitizeEmployerSignals,
} from "./employer-presentation-firewall";

const PRIVATE_SENTINELS = [
  "BASELINE_TRANSCRIPT_SENTINEL",
  "MOCK_PREP_SENTINEL",
  "GROWTH_NOTE_SENTINEL",
  "SKILL_GAP_SENTINEL",
];

function assertNoPrivateDevelopmentContent(value: unknown) {
  const serialized = JSON.stringify(value);
  for (const sentinel of PRIVATE_SENTINELS) {
    assert.equal(
      serialized.includes(sentinel),
      false,
      `LEAK: employer-facing output included private developmental sentinel ${sentinel}`,
    );
  }
}

test("HM snapshot fails closed: transcripts, gaps, notes and arbitrary browser fields never survive", () => {
  const snapshot = sanitizeEmployerPackageSnapshot(
    {
      candidate: {
        firstName: "Ada",
        lastName: "Lovelace",
        currentTitle: "Engineer",
        skills: ["TypeScript"],
        summary: "BASELINE_TRANSCRIPT_SENTINEL",
      },
      resumeScreen: {
        extractedSkills: ["TypeScript"],
        missingSkills: ["SKILL_GAP_SENTINEL"],
        recruiterSummary: "GROWTH_NOTE_SENTINEL",
      },
      interviews: [{ transcript: "MOCK_PREP_SENTINEL", summary: "BASELINE_TRANSCRIPT_SENTINEL" }],
      preparedBy: "Agency",
      arbitraryPrivatePayload: "GROWTH_NOTE_SENTINEL",
    },
    { includeContact: false },
  );

  assert.deepEqual(snapshot, {
    candidate: { firstName: "Ada", lastName: "Lovelace", currentTitle: "Engineer", skills: ["TypeScript"] },
    resumeScreen: { extractedSkills: ["TypeScript"] },
    preparedBy: "Agency",
  });
  assertNoPrivateDevelopmentContent(snapshot);
});

test("legacy intelligence interview/gap snapshots fail closed without exact assessment provenance", () => {
  const signals = sanitizeEmployerSignals(
    {
      screening: {
        score: 77,
        gapAreas: ["SKILL_GAP_SENTINEL"],
        recommendation: "GROWTH_NOTE_SENTINEL",
      },
      interview: {
        overallScore: 99,
        transcript: "BASELINE_TRANSCRIPT_SENTINEL",
        strengths: ["MOCK_PREP_SENTINEL"],
      },
    },
    { jobId: "job-a", candidateId: "candidate-a" },
  );

  assert.deepEqual(signals, { screening: { score: 77 } });
  assertNoPrivateDevelopmentContent(signals);
});

test("only the matching job-bound assessment is retained; a different job cannot influence the employer score", () => {
  const mismatch = sanitizeEmployerSignals(
    {
      interview: {
        overallScore: 92,
        strengths: ["MOCK_PREP_SENTINEL"],
        provenance: {
          kind: "job_bound_assessment_v1",
          jobId: "other-job",
          candidateId: "candidate-a",
          sessionId: "session-other",
        },
      },
    },
    { jobId: "job-a", candidateId: "candidate-a" },
  );
  assert.deepEqual(mismatch, {});

  const matching = sanitizeEmployerSignals(
    {
      interview: {
        overallScore: 92,
        strengths: ["Built a typed API"],
        provenance: {
          kind: "job_bound_assessment_v1",
          jobId: "job-a",
          candidateId: "candidate-a",
          sessionId: "session-a",
        },
      },
    },
    { jobId: "job-a", candidateId: "candidate-a" },
  );
  assert.deepEqual(matching, {
    interview: {
      overallScore: 92,
      strengths: ["Built a typed API"],
      provenance: {
        kind: "job_bound_assessment_v1",
        jobId: "job-a",
        candidateId: "candidate-a",
        sessionId: "session-a",
      },
    },
  });
  assertNoPrivateDevelopmentContent(matching);
});