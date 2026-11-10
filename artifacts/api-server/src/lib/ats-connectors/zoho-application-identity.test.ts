import assert from "node:assert/strict";
import { test } from "node:test";
import { zohoApplicationIdentity } from "./zoho-application-identity";
import { zohoJobApplicants } from "./zoho-intake-record";
import { applicationBinding } from "./zoho-stage-metadata-policy";

const native = {
  id: "300000000000000003",
  $Job_Opening_Id: "100000000000000001",
  $Candidate_Id: "200000000000000002",
  Job_Opening_Name: "Display title is not identity",
  Application_Status: "Associated",
};
const expected = {
  applicationId: native.id,
  jobId: native.$Job_Opening_Id,
  candidateId: native.$Candidate_Id,
};

test("native application identity works for applicant pages and stage binding", () => {
  assert.deepEqual(zohoApplicationIdentity(native), expected);
  const page = zohoJobApplicants(expected.jobId, 1, {
    data: [native],
    info: { more_records: false },
  });
  assert.deepEqual(page.applications, [
    { applicationId: expected.applicationId, candidateId: expected.candidateId },
  ]);
  assert.deepEqual(
    applicationBinding(
      { data: [native] },
      expected.jobId,
      expected.applicationId,
      expected.candidateId,
    ),
    { ...expected, currentStatus: "Associated" },
  );
});

test("legacy object lookups and agreeing native/object identities remain supported", () => {
  const lookup = {
    id: native.id,
    Job_Opening_Name: { id: expected.jobId },
    Candidate_Name: { id: expected.candidateId },
  };
  assert.deepEqual(zohoApplicationIdentity(lookup), expected);
  assert.deepEqual(zohoApplicationIdentity({ ...native, ...lookup }), expected);
});

test("names and email alone never establish an application identity", () => {
  for (const row of [
    { id: native.id, Job_Opening_Name: "Display", Candidate_Name: "Display" },
    { id: native.id, Email: "synthetic@example.test" },
    { ...native, $Candidate_Id: undefined },
    { ...native, $Job_Opening_Id: undefined },
  ])
    assert.equal(zohoApplicationIdentity(row), null);
});

test("conflicting, malformed, null and numeric references fail closed", () => {
  for (const row of [
    { ...native, Job_Opening_Name: { id: "999" } },
    { ...native, Candidate_Name: { id: "999" } },
    { ...native, Candidate_Name: {} },
    { ...native, $Candidate_Id: Number(native.$Candidate_Id) },
    { ...native, $Candidate_Id: null },
    { ...native, $Job_Opening_Id: "../Job_Openings" },
    { ...native, id: Number(native.id) },
  ]) {
    assert.equal(zohoApplicationIdentity(row), null);
    assert.throws(() =>
      zohoJobApplicants(expected.jobId, 1, { data: [row], info: { more_records: false } }),
    );
  }
});

test("native IDs cannot cross the selected job, candidate or application boundary", () => {
  assert.throws(() =>
    zohoJobApplicants("999", 1, { data: [native], info: { more_records: false } }),
  );
  for (const args of [
    ["999", expected.applicationId, expected.candidateId],
    [expected.jobId, "999", expected.candidateId],
    [expected.jobId, expected.applicationId, "999"],
  ])
    assert.throws(() => applicationBinding({ data: [native] }, args[0]!, args[1]!, args[2]!));
});
