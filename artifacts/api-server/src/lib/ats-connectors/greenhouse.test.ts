import assert from "node:assert/strict";
import { test } from "node:test";
import { createGreenhouseRecordReader } from "./greenhouse";
import { verifyAtsRecordMapping, type AtsMappingIdentity } from "./records";

const mapping: AtsMappingIdentity = {
  system: "Greenhouse",
  accountRef: "employer-account",
  externalJobId: "101",
  externalCandidateId: "202",
  externalApplicationId: "303",
};

function fixture() {
  const calls: string[] = [];
  let grants = 0;
  const payloads: Record<string, unknown> = {
    "/v3/jobs?ids=101": [{ id: 101, notes: "private" }],
    "/v3/candidates?ids=202": [{ id: 202, email_addresses: ["private"] }],
    "/v3/applications?ids=303": [{ id: 303, job_id: 101, candidate_id: 202 }],
  };
  const connection = {
    tenantId: "employer",
    accountRef: "employer-account",
    async assertCurrentReadGrant() {
      grants++;
    },
    async get(path: string): Promise<unknown> {
      calls.push(path);
      return payloads[path];
    },
  };
  return { connection, calls, payloads, grants: () => grants };
}

test("reads three filtered v3 resources and returns only verified identifiers", async () => {
  const f = fixture();
  const reader = createGreenhouseRecordReader(f.connection);
  assert.deepEqual(await verifyAtsRecordMapping("employer", mapping, reader), {
    job: { id: "101" },
    candidate: { id: "202" },
    application: { id: "303", jobId: "101", candidateId: "202" },
  });
  assert.deepEqual(f.calls, [
    "/v3/jobs?ids=101",
    "/v3/candidates?ids=202",
    "/v3/applications?ids=303",
  ]);
  assert.equal(f.grants(), 4);
});

test("foreign tenant, account and provider never reach the connection", async () => {
  const f = fixture();
  const reader = createGreenhouseRecordReader(f.connection);
  for (const [tenant, input] of [
    ["other", mapping],
    ["employer", { ...mapping, accountRef: "other" }],
    ["employer", { ...mapping, system: "lever" }],
  ] as const) {
    await assert.rejects(verifyAtsRecordMapping(tenant, input, reader), {
      code: "scope_mismatch",
    });
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.grants(), 0);
});

test("direct adapter rejects foreign account/provider before I/O", async () => {
  const f = fixture();
  const reader = createGreenhouseRecordReader(f.connection);
  for (const input of [
    { ...mapping, accountRef: "other" },
    { ...mapping, system: "lever" },
  ])
    await assert.rejects(reader.readRecords(input), { code: "scope_mismatch" });
  assert.deepEqual(f.calls, []);
});

test("invalid or lossy request identifiers never reach the connection", async () => {
  for (const id of ["0", "-1", "01", "1.2", "1e2", "1&ids=2", " 101", "9007199254740993"]) {
    const f = fixture();
    await assert.rejects(
      createGreenhouseRecordReader(f.connection).readRecords({ ...mapping, externalJobId: id }),
      { code: "invalid_identifier" },
    );
    assert.deepEqual(f.calls, []);
  }
});

test("missing, duplicate, unfiltered and malformed lists fail closed", async () => {
  for (const payload of [
    [],
    [{ id: 101 }, { id: 101 }],
    [{ id: 999 }],
    { data: [{ id: 101 }] },
    null,
    [null],
    [{ id: "101" }],
    [{ id: Number.MAX_SAFE_INTEGER + 1 }],
  ]) {
    const f = fixture();
    f.payloads["/v3/jobs?ids=101"] = payload;
    await assert.rejects(createGreenhouseRecordReader(f.connection).readRecords(mapping), {
      code: "invalid_response",
    });
    assert.equal(f.calls.length, 1);
  }
});

test("jobless prospects and application relationship mismatches are not verified", async () => {
  for (const row of [
    { id: 303, job_id: null, candidate_id: 202 },
    { id: 303, job_id: 999, candidate_id: 202 },
    { id: 303, job_id: 101, candidate_id: 999 },
    { id: 303, job_id: 101 },
  ]) {
    const f = fixture();
    f.payloads["/v3/applications?ids=303"] = [row];
    await assert.rejects(createGreenhouseRecordReader(f.connection).readRecords(mapping), {
      code: "invalid_response",
    });
  }
});

test("expired authorization prevents any request", async () => {
  const f = fixture();
  f.connection.assertCurrentReadGrant = async () => {
    throw new Error("private token");
  };
  await assert.rejects(createGreenhouseRecordReader(f.connection).readRecords(mapping), {
    code: "read_failed",
    message: "ATS record verification is unavailable. No synchronization occurred.",
  });
  assert.deepEqual(f.calls, []);
});

test("revocation between reads or after last read prevents success", async () => {
  for (const revokeAt of [2, 3, 4]) {
    const f = fixture();
    let count = 0;
    f.connection.assertCurrentReadGrant = async () => {
      if (++count === revokeAt) throw new Error("revoked");
    };
    await assert.rejects(createGreenhouseRecordReader(f.connection).readRecords(mapping), {
      code: "read_failed",
    });
    assert.equal(f.calls.length, revokeAt - 1);
  }
});

test("transport failures remain sanitized and do not retry requests", async () => {
  const f = fixture();
  f.connection.get = async (path) => {
    f.calls.push(path);
    throw new Error("private authorization and response body");
  };
  await assert.rejects(createGreenhouseRecordReader(f.connection).readRecords(mapping), (error) => {
    assert.ok(error instanceof Error);
    assert.equal(error.message.includes("private"), false);
    assert.equal("cause" in error, false);
    return true;
  });
  assert.equal(f.calls.length, 1);
});

test("binding and expected mapping cannot change during reads", async () => {
  const f = fixture();
  const input = { ...mapping };
  const originalGet = f.connection.get;
  f.connection.get = async (path) => {
    input.externalJobId = "999";
    f.connection.accountRef = "other";
    return originalGet(path);
  };
  const reader = createGreenhouseRecordReader(f.connection);
  const result = await reader.readRecords(input);
  assert.equal(result.job.id, "101");
  assert.equal(reader.accountRef, "employer-account");
  assert.equal(Object.isFrozen(reader), true);
});
