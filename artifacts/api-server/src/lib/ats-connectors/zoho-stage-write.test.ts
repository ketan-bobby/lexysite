import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  stageWriteRevision,
  zohoStageWriter,
  type StageWriteAttempt,
  type StageWriteSnapshot,
  type StageWriteStore,
  type StageApplication,
  type StageWriteAcknowledgment,
} from "./zoho-stage-write-core";
import { zohoStageWriteHttp } from "./zoho-stage-write-http";

const at = Date.parse("2026-11-06T10:00:00Z");
test("a claimed worker waiting for its source fence cannot write after independent closure", async () => {
  const s = fixture();
  let writes = 0,
    reads = 0;
  const attempt: StageWriteAttempt = {
    id: randomUUID(),
    requestId: randomUUID(),
    snapshot: s,
    revision: stageWriteRevision(s),
    state: "claimed",
  };
  const writer = zohoStageWriter({
    now: () => at,
    source: {
      current: async () => s,
      fence: async (_actor, _scope, work) => {
        attempt.closed = true;
        attempt.state = "observed_target";
        return work(s);
      },
    },
    store: {
      claim: async () => ({ acquired: true, attempt: structuredClone(attempt) }),
      get: async () => structuredClone(attempt),
      record: async () => structuredClone(attempt), // real ledger preserves closed outcomes
    },
    provider: {
      read: async () => {
        reads++;
        return { ...s.binding, currentStatus: s.currentStatus };
      },
      change: async () => {
        writes++;
        return "accepted";
      },
    },
  });
  const result = await writer.execute(s.actor, s.scope, {
    expectedRevision: attempt.revision,
    requestId: attempt.requestId,
    confirm: true,
  });
  assert.equal(result.attempt?.closed, true);
  assert.equal(result.attempt?.state, "observed_target");
  assert.equal(writes, 0);
  assert.equal(reads, 0);
});
test("content revisions exclude only the acting staff ID, not tenant, scope, proof or transition content", () => {
  const original = fixture(),
    revision = stageWriteRevision(original);
  assert.equal(
    stageWriteRevision({ ...original, actor: { ...original.actor, id: "another-staff" } }),
    revision,
  );
  const changes: Array<(s: StageWriteSnapshot) => void> = [
    (s) => {
      s.actor.tenantId = "foreign";
    },
    (s) => {
      s.scope.campaignId = "another-campaign";
    },
    (s) => {
      s.scope.recipientId = "another-recipient";
    },
    (s) => {
      s.binding.applicationId = "301";
    },
    (s) => {
      s.binding.candidateId = "201";
    },
    (s) => {
      s.binding.jobId = "101";
    },
    (s) => {
      s.accountRef = "c".repeat(64);
    },
    (s) => {
      s.connectionRevision = "another-connection";
    },
    (s) => {
      s.sourceRevision = "d".repeat(64);
    },
    (s) => {
      s.currentStatus = "Changed";
    },
    (s) => {
      s.targetStatus = "Changed";
    },
    (s) => {
      s.targetStage = "Changed";
    },
    (s) => {
      s.decision = "hold";
    },
    (s) => {
      s.currentHumanDecision = false;
    },
    (s) => {
      s.writePermissionConfirmed = false;
    },
    (s) => {
      s.proof!.verifiedBy = "another-proof-reviewer";
    },
    (s) => {
      s.proof!.evidenceReference = "another-report";
    },
    (s) => {
      s.proof!.verifiedAt++;
    },
    (s) => {
      s.proof!.expiresAt++;
    },
    (s) => {
      s.proof = null;
    },
  ];
  for (const change of changes) {
    const changed = structuredClone(original);
    change(changed);
    assert.notEqual(stageWriteRevision(changed), revision);
  }
});
function fixture(): StageWriteSnapshot {
  return {
    actor: { id: "synthetic-admin", tenantId: "synthetic-employer" },
    scope: { campaignId: "synthetic-campaign", recipientId: "synthetic-recipient" },
    binding: { applicationId: "300", candidateId: "200", jobId: "100" },
    accountRef: "a".repeat(64),
    connectionRevision: "synthetic-connection",
    sourceRevision: "b".repeat(64),
    currentStatus: "Associated",
    targetStatus: "In Review",
    targetStage: "Screening",
    decision: "advance",
    currentHumanDecision: true,
    writePermissionConfirmed: true,
    proof: {
      contract: "recruit-candidate-job-status-v2",
      evidenceReference: "synthetic-contract-proof-not-a-live-provider-verification",
      accountRef: "a".repeat(64),
      connectionRevision: "synthetic-connection",
      applicationId: "300",
      candidateId: "200",
      jobId: "100",
      fromStatus: "Associated",
      toStatus: "In Review",
      verifiedBy: "synthetic-admin",
      verifiedAt: at - 1000,
      expiresAt: at + 60_000,
      employerWriteApproved: true,
      applicationTransitionVerified: true,
      sideEffectsReviewed: true,
    },
  };
}
/**
 * Synthetic committed-journal double shared across writer instances.
 * This proves protocol/dedupe behavior, NOT PostgreSQL locking or crash durability.
 */
function journal() {
  const attempts = new Map<string, StageWriteAttempt>();
  const copy = (a: StageWriteAttempt) => structuredClone(a);
  const store: StageWriteStore = {
    async claim(snapshot, input) {
      const sameScope = [...attempts.values()].filter(
        (a) =>
          a.snapshot.actor.tenantId === snapshot.actor.tenantId &&
          a.snapshot.scope.campaignId === snapshot.scope.campaignId &&
          a.snapshot.scope.recipientId === snapshot.scope.recipientId,
      );
      const sameRequest = sameScope.find((a) => a.requestId === input.requestId);
      if (sameRequest && sameRequest.revision !== input.expectedRevision)
        throw Error("request_id_conflict");
      const same = sameRequest || sameScope.find((a) => a.revision === input.expectedRevision);
      if (same) return { acquired: false, attempt: copy(same) };
      if (sameScope.some((a) => !["verified", "not_sent"].includes(a.state)))
        throw Error("previous_outcome_unresolved");
      const attempt: StageWriteAttempt = {
        id: randomUUID(),
        requestId: input.requestId,
        revision: input.expectedRevision,
        snapshot: structuredClone(snapshot),
        state: "claimed",
      };
      attempts.set(attempt.id, attempt);
      return { acquired: true, attempt: copy(attempt) };
    },
    async get(actor, scope, attemptId) {
      const a = attempts.get(attemptId);
      return a &&
        a.snapshot.actor.tenantId === actor.tenantId &&
        a.snapshot.scope.campaignId === scope.campaignId &&
        a.snapshot.scope.recipientId === scope.recipientId
        ? copy(a)
        : null;
    },
    async record(attempt, state) {
      const current = attempts.get(attempt.id);
      assert.ok(current);
      // Terminal verified evidence cannot be downgraded by concurrent recovery.
      if (current.state !== "verified") current.state = state;
      return copy(current);
    },
  };
  return { store, attempts };
}
function harness() {
  const snapshot = fixture();
  const j = journal();
  let reads = 0,
    writes = 0,
    clock = at;
  let remote: StageApplication = {
    ...snapshot.binding,
    currentStatus: snapshot.currentStatus,
  };
  let result: StageWriteAcknowledgment = "accepted";
  let locked = () => structuredClone(snapshot);
  let readFailure = false,
    writeFailure = false;
  const dependencies = {
    store: j.store,
    now: () => clock,
    source: {
      async current() {
        return structuredClone(snapshot);
      },
      async fence<T>(
        _actor: unknown,
        _scope: unknown,
        work: (value: StageWriteSnapshot) => Promise<T>,
      ) {
        return work(locked());
      },
    },
    provider: {
      async read() {
        reads++;
        if (readFailure) throw Error("synthetic confidential read failure");
        return structuredClone(remote);
      },
      async change() {
        writes++;
        // Simulates a request accepted by Zoho before the response is lost.
        remote.currentStatus = snapshot.targetStatus;
        if (writeFailure) throw Error("synthetic confidential timeout");
        return result;
      },
    },
  };
  return {
    snapshot,
    j,
    dependencies,
    writer: zohoStageWriter(dependencies),
    input: () => ({
      expectedRevision: stageWriteRevision(snapshot),
      requestId: randomUUID(),
      confirm: true as const,
    }),
    counters: () => ({ reads, writes }),
    setResult: (value: StageWriteAcknowledgment) => (result = value),
    setLocked: (value: () => StageWriteSnapshot) => (locked = value),
    setRemote: (value: StageApplication) => (remote = value),
    setClock: (value: number) => (clock = value),
    failRead: () => (readFailure = true),
    failWrite: () => (writeFailure = true),
  };
}
test("approval binds all authority, application, decision and mapping fields", async () => {
  const h = harness();
  const input = h.input();
  h.snapshot.sourceRevision = "c".repeat(64);
  await assert.rejects(h.writer.execute(h.snapshot.actor, h.snapshot.scope, input), {
    code: "zoho_stage_write_changed",
  });
  assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
  assert.equal(h.j.attempts.size, 0);
});
for (const [name, change, expected] of [
  [
    "missing transition proof",
    (s: StageWriteSnapshot) => (s.proof = null),
    "application_transition_contract_required",
  ],
  [
    "missing write permission",
    (s: StageWriteSnapshot) => (s.writePermissionConfirmed = false),
    "employer_write_permission_required",
  ],
  [
    "stale human decision",
    (s: StageWriteSnapshot) => (s.currentHumanDecision = false),
    "current_human_decision_required",
  ],
  [
    "another application's proof",
    (s: StageWriteSnapshot) => (s.proof!.applicationId = "999"),
    "application_transition_contract_required",
  ],
  [
    "another employer's proof",
    (s: StageWriteSnapshot) => (s.proof!.accountRef = "f".repeat(64)),
    "application_transition_contract_required",
  ],
  [
    "a replaced connection's proof",
    (s: StageWriteSnapshot) => (s.proof!.connectionRevision = "old-connection"),
    "application_transition_contract_required",
  ],
  [
    "another job's proof",
    (s: StageWriteSnapshot) => (s.proof!.jobId = "999"),
    "application_transition_contract_required",
  ],
  [
    "another candidate's proof",
    (s: StageWriteSnapshot) => (s.proof!.candidateId = "999"),
    "application_transition_contract_required",
  ],
  [
    "different source status",
    (s: StageWriteSnapshot) => (s.proof!.fromStatus = "Applied"),
    "application_transition_contract_required",
  ],
  [
    "different target status",
    (s: StageWriteSnapshot) => (s.proof!.toStatus = "Qualified"),
    "application_transition_contract_required",
  ],
  [
    "expired proof",
    (s: StageWriteSnapshot) => (s.proof!.expiresAt = at),
    "transition_proof_expired",
  ],
  [
    "future-dated proof",
    (s: StageWriteSnapshot) => (s.proof!.verifiedAt = at + 1),
    "transition_proof_expired",
  ],
  [
    "overlong proof",
    (s: StageWriteSnapshot) => (s.proof!.expiresAt = at + 900_000),
    "transition_proof_expired",
  ],
  [
    "employment target",
    (s: StageWriteSnapshot) => (s.targetStatus = "Joined"),
    "separate_human_process",
  ],
  [
    "offer stage with innocent label",
    (s: StageWriteSnapshot) => (s.targetStage = "Offered"),
    "separate_human_process",
  ],
] as const) {
  test(`blocks ${name} before claiming or contacting provider`, async () => {
    const h = harness();
    change(h.snapshot);
    const preview = await h.writer.preview(h.snapshot.actor, h.snapshot.scope);
    assert.equal(preview.ready, false);
    assert.equal(preview.blocker, expected);
    await assert.rejects(h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input()), {
      code: expected,
    });
    assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
    assert.equal(h.j.attempts.size, 0);
  });
}
test("a matching current status is a no-op, not a delivery receipt", async () => {
  const h = harness();
  h.snapshot.currentStatus = h.snapshot.targetStatus;
  h.snapshot.proof!.fromStatus = h.snapshot.targetStatus;
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.deepEqual(result, { attempt: null, noUpdateNeeded: true });
  assert.equal(h.j.attempts.size, 0);
  assert.equal(h.counters().writes, 0);
});
test("only an exact accepted response plus exact application read-back verifies delivery", async () => {
  const h = harness();
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(result.attempt?.state, "verified");
  assert.deepEqual(h.counters(), { reads: 2, writes: 1 });
});
test("concurrent duplicate clicks and a new writer instance do not resend", async () => {
  const h = harness();
  const input = h.input();
  await Promise.all([
    h.writer.execute(h.snapshot.actor, h.snapshot.scope, input),
    h.writer.execute(h.snapshot.actor, h.snapshot.scope, input),
  ]);
  const restarted = zohoStageWriter(h.dependencies);
  await restarted.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(h.counters().writes, 1);
  assert.equal(h.j.attempts.size, 1);
});
test("revoked authority between claim and dispatch prevents the write", async () => {
  const h = harness();
  h.setLocked(() => ({ ...h.snapshot, writePermissionConfirmed: false }));
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(result.attempt?.state, "not_sent");
  assert.equal(h.counters().writes, 0);
});
test("proof expiring during the preflight read prevents the write", async () => {
  const h = harness();
  const read = h.dependencies.provider.read;
  h.dependencies.provider.read = async () => {
    const value = await read();
    h.setClock(at + 60_000);
    return value;
  };
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(result.attempt?.state, "not_sent");
  assert.equal(h.counters().writes, 0);
});
for (const mismatch of ["applicationId", "jobId", "candidateId", "currentStatus"] as const) {
  test(`preflight rejects mismatched ${mismatch} without changing Zoho`, async () => {
    const h = harness();
    h.setRemote({
      ...h.snapshot.binding,
      currentStatus: h.snapshot.currentStatus,
      [mismatch]: mismatch === "currentStatus" ? "Other" : "999",
    });
    const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
    assert.equal(result.attempt?.state, "not_sent");
    assert.equal(h.counters().writes, 0);
  });
}
for (const outcome of ["rejected", "uncertain"] as const) {
  test(`${outcome} provider response is held and cannot be automatically retried`, async () => {
    const h = harness();
    h.setResult(outcome);
    const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
    assert.equal(result.attempt?.state, "review_required");
    await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
    assert.equal(h.counters().writes, 1);
  });
}
test("response loss permits read-only recovery, not attribution or resend", async () => {
  const h = harness();
  h.failWrite();
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(result.attempt?.state, "review_required");
  assert.ok(result.attempt);
  const recovered = await h.writer.recover(h.snapshot.actor, h.snapshot.scope, result.attempt.id);
  assert.equal(recovered.state, "observed_target");
  await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(h.counters().writes, 1);
});
test("read-only recovery showing another status never unlocks a retry", async () => {
  const h = harness();
  h.failWrite();
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.ok(result.attempt);
  h.setRemote({ ...h.snapshot.binding, currentStatus: "Associated" });
  assert.equal(
    (await h.writer.recover(h.snapshot.actor, h.snapshot.scope, result.attempt.id)).state,
    "observed_other",
  );
  await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(h.counters().writes, 1);
});
test("a provider read failure before invocation is explicitly not sent", async () => {
  const h = harness();
  h.failRead();
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(result.attempt?.state, "not_sent");
  assert.equal(h.counters().writes, 0);
});
test("accepted write with mismatched read-back is not verified", async () => {
  const h = harness();
  const change = h.dependencies.provider.change;
  h.dependencies.provider.change = async () => {
    const result = await change();
    h.setRemote({ ...h.snapshot.binding, applicationId: "999", currentStatus: "In Review" });
    return result;
  };
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(result.attempt?.state, "review_required");
});
test("a lost receipt commit preserves the unresolved claim and prevents resend", async () => {
  const h = harness();
  h.j.store.record = async () => {
    throw Error("synthetic receipt storage unavailable");
  };
  await assert.rejects(h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input()));
  assert.equal([...h.j.attempts.values()][0].state, "claimed");
  await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.equal(h.counters().writes, 1);
});
test("tenant/recipient mismatch, forged authority and unconfirmed input fail closed", async () => {
  const h = harness();
  await assert.rejects(
    h.writer.preview({ ...h.snapshot.actor, tenantId: "foreign" }, h.snapshot.scope),
    { code: "not_found" },
  );
  await assert.rejects(
    h.writer.preview(h.snapshot.actor, { ...h.snapshot.scope, recipientId: "foreign" }),
    { code: "not_found" },
  );
  for (const extra of [{ confirm: false }, { tenantId: "foreign" }, { mode: "live" }]) {
    await assert.rejects(
      h.writer.execute(h.snapshot.actor, h.snapshot.scope, { ...h.input(), ...extra } as never),
    );
  }
  assert.equal(h.counters().writes, 0);
});
test("replacement connection prevents recovery reads of an old employer attempt", async () => {
  const h = harness();
  h.failWrite();
  const result = await h.writer.execute(h.snapshot.actor, h.snapshot.scope, h.input());
  assert.ok(result.attempt);
  h.snapshot.connectionRevision = "replacement";
  const before = h.counters();
  await assert.rejects(h.writer.recover(h.snapshot.actor, h.snapshot.scope, result.attempt.id), {
    code: "zoho_stage_write_changed",
  });
  assert.deepEqual(h.counters(), before);
});
const acceptedBody = (id = "200") => ({
  data: [[{ code: "SUCCESS", status: "success", details: { id } }]],
});
for (const scenario of [
  "accepted",
  "lost-response",
  "wrong-candidate",
  "permission-denied",
  "readback-mismatch",
] as const) {
  test(`composed writer and HTTP adapter: ${scenario} preserves scoped execution and recovery`, async () => {
    const h = harness();
    let requests = 0;
    let held = false;
    const wire = zohoStageWriteHttp({
      region: "us",
      token: "synthetic-nonsecret-token",
      now: () => at,
      request: (async (_url, init) => {
        assert.equal(held, true, "provider mutation must remain inside the authority fence");
        assert.equal([...h.j.attempts.values()][0]?.state, "claimed", "claim precedes transport");
        requests++;
        const body = JSON.parse(String(init?.body));
        assert.deepEqual(body.data[0].ids, [h.snapshot.binding.candidateId]);
        assert.deepEqual(body.data[0].jobids, [h.snapshot.binding.jobId]);
        if (scenario === "permission-denied")
          return Response.json({ code: "NO_PERMISSION" }, { status: 403 });
        if (scenario !== "readback-mismatch")
          h.setRemote({ ...h.snapshot.binding, currentStatus: h.snapshot.targetStatus });
        if (scenario === "lost-response") throw Error("private simulated lost response");
        return Response.json(acceptedBody(scenario === "wrong-candidate" ? "999" : "200"));
      }) as typeof fetch,
    });
    const dependencies = {
      ...h.dependencies,
      source: {
        ...h.dependencies.source,
        async fence<T>(
          actor: StageWriteSnapshot["actor"],
          scope: StageWriteSnapshot["scope"],
          work: (snapshot: StageWriteSnapshot) => Promise<T>,
        ) {
          held = true;
          try {
            return await h.dependencies.source.fence(actor, scope, work);
          } finally {
            held = false;
          }
        },
      },
      provider: {
        read: h.dependencies.provider.read,
        change: wire.change,
      },
    };
    const writer = zohoStageWriter(dependencies);
    const input = h.input();
    const result = await writer.execute(h.snapshot.actor, h.snapshot.scope, input);
    assert.ok(result.attempt);
    assert.equal(result.attempt.state, scenario === "accepted" ? "verified" : "review_required");
    assert.equal(requests, 1);
    // A replacement worker and a different request ID must not repeat transport.
    const restarted = zohoStageWriter(dependencies);
    const replay = await restarted.execute(h.snapshot.actor, h.snapshot.scope, {
      ...input,
      requestId: randomUUID(),
    });
    assert.equal(replay.attempt?.id, result.attempt.id);
    assert.equal(requests, 1);
    const recovery = await restarted.recover(h.snapshot.actor, h.snapshot.scope, result.attempt.id);
    assert.equal(
      recovery.state,
      scenario === "accepted"
        ? "verified"
        : ["lost-response", "wrong-candidate"].includes(scenario)
          ? "observed_target"
          : "observed_other",
    );
    assert.equal(requests, 1, "read-only recovery cannot resend");
    assert.equal(held, false);
  });
}

test("HTTP payload is fixed-origin, job-scoped, single-candidate and never retries", async () => {
  let calls = 0;
  const adapter = zohoStageWriteHttp({
    region: "us",
    token: "synthetic-nonsecret-token",
    now: () => at,
    request: (async (url, init) => {
      calls++;
      assert.equal(url, "https://recruit.zoho.com/recruit/v2/Candidates/status");
      assert.equal(init?.method, "PUT");
      assert.equal(init?.redirect, "error");
      assert.deepEqual(JSON.parse(String(init?.body)), {
        data: [
          {
            ids: ["200"],
            jobids: ["100"],
            Candidate_Status: "In Review",
            comments: "Human-approved Lexy application-stage handoff.",
          },
        ],
      });
      return Response.json(acceptedBody());
    }) as typeof fetch,
  });
  assert.equal(await adapter.change(fixture()), "accepted");
  assert.equal(calls, 1);
});
for (const [name, response, expected] of [
  ["wrong candidate", () => Response.json(acceptedBody("999")), "uncertain"],
  [
    "ambiguous batch",
    () => Response.json({ data: [acceptedBody().data[0], acceptedBody().data[0]] }),
    "uncertain",
  ],
  ["flat undocumented success", () => Response.json({ data: acceptedBody().data[0] }), "uncertain"],
  ["malformed body", () => new Response("not JSON"), "uncertain"],
  ["oversized body", () => new Response(" ".repeat(128001)), "uncertain"],
  ["server failure", () => Response.json({ code: "SERVER_ERROR" }, { status: 500 }), "uncertain"],
  [
    "locked Blueprint record",
    () => Response.json({ code: "RECORD_LOCKED" }, { status: 400 }),
    "rejected",
  ],
  [
    "missing permission",
    () => Response.json({ code: "NO_PERMISSION" }, { status: 403 }),
    "rejected",
  ],
  [
    "undocumented client failure",
    () => Response.json({ code: "OTHER" }, { status: 400 }),
    "uncertain",
  ],
  ["no content", () => new Response(null, { status: 204 }), "uncertain"],
] as const) {
  test(`HTTP ${name} is ${expected}, not a verified stage update`, async () => {
    let calls = 0;
    const adapter = zohoStageWriteHttp({
      region: "in",
      token: "synthetic-nonsecret-token",
      now: () => at,
      request: (async (url) => {
        calls++;
        assert.equal(url, "https://recruit.zoho.in/recruit/v2/Candidates/status");
        return response();
      }) as typeof fetch,
    });
    assert.equal(await adapter.change(fixture()), expected);
    assert.equal(calls, 1);
  });
}
test("HTTP timeout stays uncertain with no fallback, retry or raw error leak", async () => {
  let calls = 0;
  const adapter = zohoStageWriteHttp({
    region: "us",
    token: "synthetic-nonsecret-token",
    now: () => at,
    request: (async () => {
      calls++;
      throw Error("synthetic confidential provider error");
    }) as typeof fetch,
  });
  assert.equal(await adapter.change(fixture()), "uncertain");
  assert.equal(calls, 1);
});
test("transport independently blocks missing proof, permission and offer writes", async () => {
  const adapter = zohoStageWriteHttp({
    region: "us",
    token: "synthetic-nonsecret-token",
    now: () => at,
    request: (async () => {
      throw Error("MUST NOT REACH REQUEST");
    }) as typeof fetch,
  });
  for (const s of [
    { ...fixture(), proof: null },
    { ...fixture(), writePermissionConfirmed: false },
    { ...fixture(), targetStatus: "Offer-Made" },
  ])
    assert.equal(await adapter.change(s), "rejected");
});
