import assert from "node:assert/strict";
import { test } from "node:test";
import { createZohoRecruitRecordReader, type ZohoRecruitReadPath } from "./zoho-recruit";
import { verifyAtsRecordMapping, type AtsMappingIdentity } from "./records";

const mapping: AtsMappingIdentity = {
  system: "Zoho_Recruit",
  accountRef: "employer-account",
  externalJobId: "100001000000025064",
  externalCandidateId: "100001000000028010",
  externalApplicationId: "100001000000043143",
};
const jobPath = `/recruit/v2/Job_Openings/${mapping.externalJobId}`;
const candidatePath = `/recruit/v2/Candidates/${mapping.externalCandidateId}`;
const applicationPath = `/recruit/v2/Applications/${mapping.externalApplicationId}`;

function fixture() {
  const calls: string[] = [];
  let grants = 0;
  const application = {
    id: mapping.externalApplicationId,
    Job_Opening_Name: { id: mapping.externalJobId, name: "Not returned" },
    Candidate_Name: { id: mapping.externalCandidateId, name: "Not returned" },
    Application_Status: "Offered",
    private_notes: "Must not escape the adapter",
  };
  const payloads: Record<string, unknown> = {
    [jobPath]: { data: [{ id: mapping.externalJobId, Job_Description: "Private" }] },
    [candidatePath]: { data: [{ id: mapping.externalCandidateId, Email: "private@example.test" }] },
    [applicationPath]: { data: [application] },
  };
  const connection = {
    tenantId: "employer",
    accountRef: "employer-account",
    async assertCurrentReadGrant() {
      grants++;
    },
    async get(path: ZohoRecruitReadPath): Promise<unknown> {
      calls.push(path);
      return payloads[path];
    },
  };
  return { connection, calls, payloads, application, grants: () => grants };
}

test("Zoho Recruit verifies native application IDs without inferring identity from display names", async () => {
  const f = fixture();
  f.payloads[applicationPath] = {
    data: [
      {
        id: mapping.externalApplicationId,
        $Job_Opening_Id: mapping.externalJobId,
        $Candidate_Id: mapping.externalCandidateId,
        Job_Opening_Name: "Display only",
        Application_Status: "Associated",
      },
    ],
  };
  const verified = await createZohoRecruitRecordReader(f.connection).readRecords(mapping);
  assert.deepEqual(verified.application, {
    id: mapping.externalApplicationId,
    jobId: mapping.externalJobId,
    candidateId: mapping.externalCandidateId,
  });
});

test("Zoho Recruit verifies exact records, preserves long string IDs and strips private fields", async () => {
  const f = fixture();
  assert.deepEqual(
    await verifyAtsRecordMapping("employer", mapping, createZohoRecruitRecordReader(f.connection)),
    {
      job: { id: mapping.externalJobId },
      candidate: { id: mapping.externalCandidateId },
      application: {
        id: mapping.externalApplicationId,
        jobId: mapping.externalJobId,
        candidateId: mapping.externalCandidateId,
      },
    },
  );
  assert.deepEqual(f.calls, [jobPath, candidatePath, applicationPath]);
  assert.equal(f.grants(), 4);
});

test("foreign employers, accounts and generic Zoho/CRM providers never perform reads", async () => {
  const f = fixture();
  const reader = createZohoRecruitRecordReader(f.connection);
  for (const [tenant, input] of [
    ["other", mapping],
    ["employer", { ...mapping, accountRef: "other" }],
    ["employer", { ...mapping, system: "zoho" }],
    ["employer", { ...mapping, system: "zoho_crm" }],
    ["employer", { ...mapping, system: "greenhouse" }],
  ] as const)
    await assert.rejects(verifyAtsRecordMapping(tenant, input, reader), { code: "scope_mismatch" });
  await assert.rejects(reader.readRecords({ ...mapping, accountRef: "other" }), {
    code: "scope_mismatch",
  });
  assert.deepEqual(f.calls, []);
  assert.equal(f.grants(), 0);
});

test("all request IDs reject coercion, path/query injection and noncanonical values before I/O", async () => {
  for (const field of ["externalJobId", "externalCandidateId", "externalApplicationId"] as const)
    for (const id of [
      "",
      "0",
      "-1",
      "01",
      "1.2",
      "1e16",
      " 123",
      "123 ",
      "123/Notes",
      "123?fields=Email",
      "%31",
      "1\n",
      "9".repeat(41),
    ]) {
      const f = fixture();
      await assert.rejects(
        createZohoRecruitRecordReader(f.connection).readRecords({ ...mapping, [field]: id }),
        { code: "invalid_identifier" },
      );
      assert.deepEqual(f.calls, []);
    }
});

test("empty, duplicate, broad, rounded numeric and malformed payloads fail closed", async () => {
  for (const path of [jobPath, candidatePath, applicationPath])
    for (const payload of [
      null,
      [],
      {},
      { data: [] },
      { data: [null] },
      { data: [{ id: "999" }] },
      { data: [{ id: Number(mapping.externalJobId) }] },
      { data: [{ id: mapping.externalJobId }, { id: mapping.externalJobId }] },
      { code: "NO_PERMISSION", message: "private" },
    ]) {
      const f = fixture();
      f.payloads[path] = payload;
      await assert.rejects(createZohoRecruitRecordReader(f.connection).readRecords(mapping), {
        code: "invalid_response",
      });
      assert.equal(f.calls.at(-1), path);
    }
});

test("application must explicitly bind the expected candidate and opening, not display names", async () => {
  for (const field of ["Candidate_Name", "Job_Opening_Name"] as const)
    for (const lookup of [
      null,
      [],
      "name",
      {},
      { name: "Same name" },
      { id: 123 },
      { id: "999" },
    ]) {
      const f = fixture();
      f.payloads[applicationPath] = { data: [{ ...f.application, [field]: lookup }] };
      await assert.rejects(createZohoRecruitRecordReader(f.connection).readRecords(mapping), {
        code: "invalid_response",
      });
    }
});

test("expired or revoked grants stop at each boundary including after the final read", async () => {
  for (const revokeAt of [1, 2, 3, 4]) {
    const f = fixture();
    let count = 0;
    f.connection.assertCurrentReadGrant = async () => {
      if (++count === revokeAt) throw new Error("private grant");
    };
    await assert.rejects(createZohoRecruitRecordReader(f.connection).readRecords(mapping), {
      code: "read_failed",
    });
    assert.equal(f.calls.length, revokeAt - 1);
  }
});

test("provider errors are sanitized without retrying or exposing a cause", async () => {
  const f = fixture();
  f.connection.get = async (path) => {
    f.calls.push(path);
    throw new Error("private URL credential response");
  };
  await assert.rejects(
    createZohoRecruitRecordReader(f.connection).readRecords(mapping),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error.message.includes("private"), false);
      assert.equal("cause" in error, false);
      return true;
    },
  );
  assert.equal(f.calls.length, 1);
});

test("connection and mapping mutation during I/O cannot change the verified identity", async () => {
  const f = fixture();
  const input = { ...mapping };
  const get = f.connection.get;
  f.connection.get = async (path) => {
    input.externalJobId = "999";
    input.externalCandidateId = "888";
    input.externalApplicationId = "777";
    f.connection.accountRef = "other";
    return get(path);
  };
  const reader = createZohoRecruitRecordReader(f.connection);
  const result = await reader.readRecords(input);
  assert.equal(result.job.id, mapping.externalJobId);
  assert.equal(result.candidate.id, mapping.externalCandidateId);
  assert.equal(result.application.id, mapping.externalApplicationId);
  assert.equal(reader.accountRef, mapping.accountRef);
  assert.equal(Object.isFrozen(reader), true);
});
