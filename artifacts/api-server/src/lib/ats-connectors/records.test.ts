import assert from "node:assert/strict";
import { test } from "node:test";
import {
  atsMappingConflicts,
  atsRecordId,
  verifyAtsRecordMapping,
  type AtsMappingIdentity,
  type AtsRecordReader,
  type LocalAtsBinding,
} from "./records";
import { atsProviderDefinition } from "./providers";

const mapping: AtsMappingIdentity = {
  system: "Greenhouse",
  accountRef: "employer-account",
  externalJobId: "101",
  externalCandidateId: "202",
  externalApplicationId: "303",
};
const binding: LocalAtsBinding = {
  tenantId: "employer",
  workflowId: "workflow-one",
  jobId: "job-one",
  candidateId: "person-one",
  mapping,
};
const records = () => ({
  job: { id: "101", privateSalary: "excluded" },
  candidate: { id: "202", email: "excluded@example.invalid" },
  application: { id: "303", jobId: "101", candidateId: "202", offer: "excluded" },
});
function reader(): AtsRecordReader {
  return {
    tenantId: "employer",
    system: "greenhouse",
    accountRef: mapping.accountRef,
    readRecords: async () => records(),
  };
}
function other(patch: Partial<LocalAtsBinding> = {}): LocalAtsBinding {
  return { ...binding, workflowId: "workflow-two", ...patch };
}

test("record identifiers retain vendor strings, trim edges and reject empty/control/oversize input", () => {
  assert.equal(atsRecordId(" 000123 "), "000123");
  for (const value of [" ", "x\nx", "x\u007fx", "a".repeat(129)])
    assert.throws(() => atsRecordId(value), { code: "invalid_identifier" });
});

test("duplicate application is rejected even when local job/person agree", () => {
  assert.equal(atsMappingConflicts(binding, other()), true);
});

test("job mappings are bijective inside an account", () => {
  assert.equal(atsMappingConflicts(binding, other({ jobId: "job-other" })), true);
  assert.equal(
    atsMappingConflicts(
      binding,
      other({ mapping: { ...mapping, externalJobId: "999", externalApplicationId: "304" } }),
    ),
    true,
  );
});

test("candidate mappings are bijective inside an account", () => {
  assert.equal(atsMappingConflicts(binding, other({ candidateId: "person-other" })), true);
  assert.equal(
    atsMappingConflicts(
      binding,
      other({ mapping: { ...mapping, externalCandidateId: "999", externalApplicationId: "304" } }),
    ),
    true,
  );
});

test("same person may apply to another job with a distinct application", () => {
  assert.equal(
    atsMappingConflicts(
      binding,
      other({
        jobId: "job-other",
        mapping: { ...mapping, externalJobId: "102", externalApplicationId: "304" },
      }),
    ),
    false,
  );
});

test("separate people may share a job with distinct applications", () => {
  assert.equal(
    atsMappingConflicts(
      binding,
      other({
        candidateId: "person-other",
        mapping: { ...mapping, externalCandidateId: "203", externalApplicationId: "304" },
      }),
    ),
    false,
  );
});

test("tenant, provider and case-sensitive account boundaries isolate record IDs", () => {
  assert.equal(atsMappingConflicts(binding, other({ tenantId: "foreign" })), false);
  for (const patch of [{ system: "Lever" }, { accountRef: "Employer-account" }])
    assert.equal(atsMappingConflicts(binding, other({ mapping: { ...mapping, ...patch } })), false);
  assert.equal(
    atsMappingConflicts(binding, other({ mapping: { ...mapping, system: " GREENHOUSE " } })),
    true,
  );
  assert.equal(atsMappingConflicts(binding, binding), false);
});

test("verified read reconstructs only identifiers, never provider private fields", async () => {
  assert.deepEqual(await verifyAtsRecordMapping("employer", mapping, reader()), {
    job: { id: "101" },
    candidate: { id: "202" },
    application: { id: "303", jobId: "101", candidateId: "202" },
  });
});

test("foreign tenant, provider and account are rejected before any adapter read", async () => {
  let reads = 0;
  for (const patch of [
    { tenantId: "foreign" },
    { system: "lever" },
    { accountRef: "another-account" },
  ]) {
    await assert.rejects(
      verifyAtsRecordMapping("employer", mapping, {
        ...reader(),
        ...patch,
        readRecords: async () => {
          reads++;
          return records();
        },
      }),
      { code: "scope_mismatch" },
    );
  }
  assert.equal(reads, 0);
});

test("record existence alone cannot verify a mismatched job or candidate relationship", async () => {
  for (const patch of [{ id: "different" }, { jobId: "different" }, { candidateId: "different" }]) {
    const result = records();
    result.application = { ...result.application, ...patch };
    await assert.rejects(
      verifyAtsRecordMapping("employer", mapping, {
        ...reader(),
        readRecords: async () => result,
      }),
      { code: "invalid_response" },
    );
  }
});

test("unexpected normalized job or candidate IDs fail closed", async () => {
  for (const field of ["job", "candidate"] as const) {
    const result = records();
    result[field].id = "999";
    await assert.rejects(
      verifyAtsRecordMapping("employer", mapping, {
        ...reader(),
        readRecords: async () => result,
      }),
      { code: "invalid_response" },
    );
  }
});

test("a caller cannot change mapping identity during asynchronous verification", async () => {
  const input = { ...mapping };
  const result = await verifyAtsRecordMapping("employer", input, {
    ...reader(),
    readRecords: async (request) => {
      input.externalJobId = "999";
      request.externalJobId = "999";
      return records();
    },
  });
  assert.equal(result.job.id, "101");
});

test("provider failures remain failures without leaking their private exception", async () => {
  await assert.rejects(
    verifyAtsRecordMapping("employer", mapping, {
      ...reader(),
      readRecords: async () => {
        throw new Error("private provider URL and authorization details");
      },
    }),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "read_failed" &&
      !error.message.includes("private provider") &&
      error.cause === undefined,
  );
});

test("Greenhouse definition requires current v3 scopes without claiming connectivity or write support", () => {
  const definition = atsProviderDefinition(" Greenhouse ");
  assert.equal(definition?.apiVersion, "harvest_v3");
  assert.equal(definition?.partnerAuthorization, "oauth_authorization_code");
  assert.deepEqual(definition?.recordReadScopes, [
    "harvest:jobs:list",
    "harvest:candidates:list",
    "harvest:applications:list",
  ]);
  assert.equal(definition?.capabilities.recordVerification, "read_only");
  assert.equal(definition?.capabilities.externalWrites, false);
  assert.equal(definition?.capabilities.synchronization, false);
  assert.equal(definition?.capabilities.offerAutomation, false);
  assert.ok(Object.isFrozen(definition?.capabilities));
  assert.equal(atsProviderDefinition("Lever"), null);
  assert.equal(atsProviderDefinition("custom ATS"), null);
});
