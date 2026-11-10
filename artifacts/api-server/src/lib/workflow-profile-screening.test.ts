import assert from "node:assert/strict";
import { test } from "node:test";
import type { candidatesTable } from "@workspace/db";
import { workflowProfileSnapshot, workflowScreeningReadiness } from "./workflow-profile-screening";

test("screening readiness never mistakes a name, profile link or unparsed CV for qualifications", () => {
  const empty = { currentTitle: null, skills: [], resumeUrl: null };
  assert.equal(workflowScreeningReadiness(empty).ready, false);
  assert.match(workflowScreeningReadiness(empty).reason!, /name and profile link/);
  assert.equal(
    workflowScreeningReadiness({ ...empty, currentTitle: " ", skills: [" "] }).ready,
    false,
  );
  const attached = workflowScreeningReadiness({ ...empty, resumeUrl: "/private/cv.pdf" });
  assert.equal(attached.ready, false);
  assert.match(attached.reason!, /parsing/);
});

test("saved role or skills are usable inputs without EnrichLayer or a paid tier", () => {
  for (const fields of [
    { currentTitle: "Software Engineer", skills: [] },
    { currentTitle: null, skills: ["PostgreSQL"] },
  ]) {
    assert.deepEqual(workflowScreeningReadiness({ ...fields, resumeUrl: null }), {
      ready: true,
      reason: null,
    });
  }
});

test("source reuse refreshes canonical qualifications without resetting stage, grade or provenance", () => {
  const candidate = {
    firstName: "Synthetic",
    lastName: "Fixture",
    currentTitle: "Current saved role",
    currentCompany: null,
    location: null,
    skills: ["SQL"],
  } as typeof candidatesTable.$inferSelect;
  const previous = {
    jobId: "fixture_job",
    stage: "screening",
    currentTitle: "Old role",
    skills: ["Old skill"],
    screeningResult: { score: 72 },
    nativeDiscovery: { operationId: "fixture" },
  };
  const snapshot = workflowProfileSnapshot(candidate, previous);
  assert.equal(snapshot.currentTitle, candidate.currentTitle);
  assert.deepEqual(snapshot.skills, ["SQL"]);
  assert.equal(snapshot.stage, "screening");
  assert.deepEqual(snapshot.screeningResult, previous.screeningResult);
  assert.deepEqual(snapshot.nativeDiscovery, previous.nativeDiscovery);
  assert.equal(previous.currentTitle, "Old role");
  assert.ok(!("verificationStatus" in snapshot));
});
