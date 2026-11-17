import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  greenhouseOfferHttp,
  GreenhouseOfferHttpError,
  type GreenhouseOfferHttpPermit,
} from "./greenhouse-offer-http";
import {
  greenhouseOfferDraftBody,
  greenhouseOfferChain,
  boundGreenhouseOffer,
} from "./greenhouse-offer-wire";
import { offerDigest, offerRevision, type OfferSnapshot } from "./greenhouse-offer-policy";
import {
  boundGreenhouseApprovalFlow,
  greenhouseApprovalState,
  greenhouseCombinedApprovalState,
  greenhouseOfferCapabilities,
  type GreenhouseApprovalFlow,
  type GreenhouseOfferAuthority,
} from "./greenhouse-offer-evidence";

function fixture() {
  const binding = { applicationId: "300", candidateId: "200", jobId: "100" };
  const s: OfferSnapshot = {
    actor: { id: "submitter", tenantId: randomUUID() },
    scope: { workflowId: randomUUID() },
    accountRef: "a".repeat(64),
    connectionRevision: "connection-1",
    binding,
    sourceRevision: "b".repeat(64),
    termsOwnerId: "owner",
    approverId: "reviewer",
    submitterId: "submitter",
    currentHumanDecision: true,
    writePermissionConfirmed: true,
    canReadRemote: true,
    existingChain: null,
    existingApprovalState: "none",
    openingId: "101",
    startDate: "2026-12-01",
    values: { salary: { amountMinor: 12345678, currency: "USD" } },
    contract: {
      accountRef: "a".repeat(64),
      connectionRevision: "connection-1",
      bindingHash: offerDigest(binding),
      chainHash: offerDigest(null),
      revision: "c".repeat(64),
      evidenceReference: "synthetic-only",
      verifiedAt: 1000,
      expiresAt: 2000,
      applicationBound: true,
      sideEffectsReviewed: true,
      approvalFlowConfirmed: true,
      candidateDeliveryDisabled: true,
      startDateRequired: true,
      openingRequired: true,
      allowedOpeningIds: ["101"],
      fields: [
        {
          key: "salary",
          type: "currency",
          required: true,
          choices: [],
          currencies: ["USD"],
          min: 0,
          max: Number.MAX_SAFE_INTEGER,
        },
      ],
    },
  };
  const digits = { USD: 2, JPY: 0, KWD: 3 };
  const p: GreenhouseOfferHttpPermit = {
    tenantId: s.actor.tenantId,
    accountRef: s.accountRef,
    connectionRevision: s.connectionRevision,
    expectedRevision: offerRevision(s),
    expiresAt: 1900,
    privateOfferReadVerified: true,
    authority: authority(s),
    approvalReadVerified: true,
    offerCreateVerified: true,
    claimedAttemptId: randomUUID(),
    reviewedBodyHash: offerDigest(greenhouseOfferDraftBody(s, digits)),
    currencyDigits: digits,
    token: "synthetic-token-not-a-secret",
  };
  const row = {
    id: 400,
    version: 1,
    application_id: 300,
    candidate_id: 200,
    job_id: 100,
    opening_id: 101,
    starts_on: "2026-12-01",
    sent_on: null,
    resolved_at: null,
    updated_at: "2026-11-14T12:00:00Z",
    status: "Created",
    custom_fields: {
      salary: {
        name: "Base salary",
        type: "currency",
        value: { amount: 123456.78, currency_code: "USD" },
      },
    },
  };
  const calls: { url: string; init: RequestInit }[] = [];
  let reply: () => Promise<Response> = async () => json(row, 201);
  let authorize: Parameters<typeof greenhouseOfferHttp>[0]["authorize"] = async () =>
    structuredClone(p);
  const client = (timeoutMs = 1000) =>
    greenhouseOfferHttp({
      authorize: (snap, op, signal) => authorize(snap, op, signal),
      now: () => 1500,
      timeoutMs,
      fetcher: (async (url, init) => {
        calls.push({ url: String(url), init: init! });
        return reply();
      }) as typeof fetch,
    });
  return {
    s,
    p,
    row,
    calls,
    client,
    reply: (next: typeof reply) => {
      reply = next;
    },
    authorize: (next: typeof authorize) => {
      authorize = next;
    },
  };
}
const json = (value: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
async function sanitized(work: Promise<unknown>) {
  await assert.rejects(
    work,
    (e: unknown) =>
      e instanceof GreenhouseOfferHttpError &&
      e.message === "Greenhouse offer request unavailable." &&
      !("cause" in e),
  );
}

function authority(s: OfferSnapshot): GreenhouseOfferAuthority {
  return {
    tenantId: s.actor.tenantId,
    actorId: s.actor.id,
    workflowId: s.scope.workflowId,
    accountRef: s.accountRef,
    credentialHash: offerDigest("synthetic-token-not-a-secret"),
    connectionRevision: s.connectionRevision,
    bindingHash: offerDigest(s.binding),
    employerConfirmed: true,
    evidenceReference: "d".repeat(64),
    observedAt: 1000,
    expiresAt: 2000,
    grantedScopes: ["harvest:offers:list", "harvest:offers:create", "harvest:approval_flows:list"],
    identity: {
      kind: "site_admin",
      credentialSubjectId: "11",
      verifiedSubjectId: "11",
      active: true,
      privateOffersPermission: "verified",
    },
  };
}
function flow(target: "job" | "offer"): GreenhouseApprovalFlow {
  return {
    id: target === "job" ? 500 : 501,
    job_id: 100,
    offer_id: target === "job" ? null : 400,
    approval_type: target === "job" ? "offer_job" : "offer_candidate",
    version: 1,
    requested_by_id: 11,
    approval_status: "approved",
    sequential: true,
    created_at: "2026-11-14T12:00:00Z",
    updated_at: "2026-11-14T12:00:01Z",
  };
}
function approvalFixture() {
  const f = fixture();
  f.s.existingChain = greenhouseOfferChain(boundGreenhouseOffer(f.row, f.s));
  f.s.existingApprovalState = "pending";
  f.s.contract.chainHash = offerDigest(f.s.existingChain);
  f.p.expectedRevision = offerRevision(f.s);
  f.p.approvalReadVerified = true;
  return f;
}

test("capabilities require independently held exact scopes and private permission, not a Site Admin label", () => {
  const { s } = fixture();
  const p = authority(s);
  const all = {
    privateOfferReadVerified: true,
    offerCreateVerified: true,
    approvalReadVerified: true,
  };
  assert.deepEqual(greenhouseOfferCapabilities(s, p, 1500), all);
  for (const state of ["missing", "unknown"] as const) {
    const denied = structuredClone(p);
    if (denied.identity.kind === "site_admin") denied.identity.privateOffersPermission = state;
    assert.ok(Object.values(greenhouseOfferCapabilities(s, denied, 1500)).every((v) => !v));
  }
  const listOnly = { ...p, grantedScopes: ["harvest:offers:list"] };
  assert.deepEqual(greenhouseOfferCapabilities(s, listOnly, 1500), {
    privateOfferReadVerified: true,
    offerCreateVerified: false,
    approvalReadVerified: false,
  });
  assert.equal(
    greenhouseOfferCapabilities(
      s,
      { ...p, grantedScopes: ["harvest:offers:create", "harvest:approval_flows:list"] },
      1500,
    ).offerCreateVerified,
    false,
  );
  const notHumanApproval = structuredClone(s);
  notHumanApproval.currentHumanDecision = false;
  assert.deepEqual(greenhouseOfferCapabilities(notHumanApproval, p, 1500), all);
  // Capabilities are not financial approval: create still checks the human intent.
});

for (const field of [
  "tenantId",
  "actorId",
  "workflowId",
  "accountRef",
  "connectionRevision",
  "bindingHash",
  "employerConfirmed",
  "observedAt",
  "expiresAt",
] as const) {
  test(`foreign or stale authority evidence ${field} grants nothing`, () => {
    const { s } = fixture();
    const p = authority(s);
    const bad = {
      ...p,
      [field]:
        field === "employerConfirmed"
          ? false
          : field === "observedAt"
            ? 1501
            : field === "expiresAt"
              ? 1500
              : "foreign",
    };
    assert.ok(Object.values(greenhouseOfferCapabilities(s, bad, 1500)).every((v) => !v));
  });
}
test("integration-user access requires explicit reviewed custody and cannot impersonate a subject token", () => {
  const { s } = fixture();
  const p = authority(s);
  p.identity = {
    kind: "integration_user",
    credentialSubjectId: null,
    verifiedSubjectId: "12",
    active: true,
    integrationAccessReviewed: true,
  };
  assert.equal(greenhouseOfferCapabilities(s, p, 1500).offerCreateVerified, true);
  p.identity.integrationAccessReviewed = false;
  assert.equal(greenhouseOfferCapabilities(s, p, 1500).privateOfferReadVerified, false);
  assert.equal(
    greenhouseOfferCapabilities(
      s,
      { ...p, identity: { ...p.identity, credentialSubjectId: "11" } },
      1500,
    ).privateOfferReadVerified,
    false,
  );
  const subject = authority(s);
  if (subject.identity.kind === "site_admin") subject.identity.credentialSubjectId = "12";
  assert.equal(greenhouseOfferCapabilities(s, subject, 1500).privateOfferReadVerified, false);
  assert.equal(greenhouseOfferCapabilities(s, authority(s), NaN).privateOfferReadVerified, false);
  assert.equal(
    greenhouseOfferCapabilities(s, { ...p, expiresAt: 100000 }, 1500).privateOfferReadVerified,
    false,
  );
});
test("inactive identities, wildcard scope assumptions and malformed evidence grant nothing", () => {
  const { s } = fixture();
  const p = authority(s);
  for (const bad of [
    { ...p, identity: { ...p.identity, active: false } },
    { ...p, identity: { ...p.identity, kind: "job_admin" } },
    { ...p, grantedScopes: ["harvest:*"] },
    { ...p, grantedScopes: [...p.grantedScopes, p.grantedScopes[0]] },
    { ...p, evidenceReference: "" },
    { ...p, observedAt: 2100, expiresAt: 2000 },
  ])
    assert.ok(Object.values(greenhouseOfferCapabilities(s, bad, 1500)).every((v) => !v));
});

test("approval metadata reads use fixed offer/job filters and never write or request approval emails", async () => {
  const f = approvalFixture();
  for (const target of ["job", "offer"] as const) {
    f.reply(async () => json([flow(target)]));
    const result = await f.client().readApprovalFlow(f.s, target);
    assert.deepEqual(result, flow(target));
    const call = f.calls.at(-1)!;
    const url = new URL(call.url);
    assert.equal(url.origin + url.pathname, "https://harvest.greenhouse.io/v3/approval_flows");
    assert.equal(
      url.searchParams.get("approval_type"),
      target === "job" ? "offer_job" : "offer_candidate",
    );
    assert.equal(
      url.searchParams.get(target === "job" ? "job_ids" : "offer_ids"),
      target === "job" ? "100" : "400",
    );
    assert.equal(url.searchParams.get("per_page"), "2");
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.body, undefined);
  }
  assert.equal(f.calls.length, 2);
});
test("approval-read permission and a concrete offer binding are required before I/O", async () => {
  const f = approvalFixture();
  f.p.approvalReadVerified = false;
  await sanitized(f.client().readApprovalFlow(f.s, "job"));
  assert.equal(f.calls.length, 0);
  f.p.approvalReadVerified = true;
  f.s.existingChain = null;
  f.p.expectedRevision = offerRevision(f.s);
  await sanitized(f.client().readApprovalFlow(f.s, "offer"));
  assert.equal(f.calls.length, 0);
});
test("approval permission lost during a read hides its result", async () => {
  const f = approvalFixture();
  f.reply(async () => {
    f.p.approvalReadVerified = false;
    return json([flow("offer")]);
  });
  await sanitized(f.client().readApprovalFlow(f.s, "offer"));
  assert.equal(f.calls.length, 1);
});
test("true permit flags cannot bypass credential-bound authority evidence", async () => {
  for (const change of [
    (f: ReturnType<typeof approvalFixture>) => {
      f.p.token = "different-synthetic-token";
    },
    (f: ReturnType<typeof approvalFixture>) => {
      f.p.authority.actorId = "other-actor";
    },
    (f: ReturnType<typeof approvalFixture>) => {
      f.p.authority.expiresAt = 1500;
    },
    (f: ReturnType<typeof approvalFixture>) => {
      f.p.authority.grantedScopes = ["harvest:offers:list"];
    },
    (f: ReturnType<typeof approvalFixture>) => {
      if (f.p.authority.identity.kind === "site_admin")
        f.p.authority.identity.privateOffersPermission = "unknown";
    },
  ]) {
    const f = approvalFixture();
    change(f);
    await sanitized(f.client().createOfferDraft(f.s));
    await sanitized(f.client().readApprovalFlow(f.s, "offer"));
    assert.equal(f.calls.length, 0);
  }
});
test("authority lost during approval I/O hides results even if all permit flags stay true", async () => {
  const f = approvalFixture();
  f.reply(async () => {
    f.p.authority.identity.active = false;
    return json([flow("offer")]);
  });
  await sanitized(f.client().readApprovalFlow(f.s, "offer"));
  assert.equal(f.calls.length, 1);
});
test("approval reads reject pagination and failures without retries", async () => {
  for (const reply of [
    () => json([flow("offer")], 200, { Link: '<https://foreign.invalid/next>; rel="next"' }),
    () => json([], 403),
    () => json([], 429),
    () => json([], 503),
  ]) {
    const f = approvalFixture();
    f.reply(async () => reply());
    await sanitized(f.client().readApprovalFlow(f.s, "offer"));
    assert.equal(f.calls.length, 1);
  }
});
test("approval reads remain deadline-bounded even when fetch ignores cancellation", async () => {
  const f = approvalFixture();
  f.reply(() => new Promise<Response>(() => {}));
  await sanitized(f.client(20).readApprovalFlow(f.s, "offer"));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal?.aborted, true);
});
test("approval reads reject foreign jobs/offers, prototypes, duplicate flows and unsafe identifiers", async () => {
  for (const rows of [
    [{ ...flow("offer"), job_id: 999 }],
    [{ ...flow("offer"), offer_id: 999 }],
    [{ ...flow("offer"), offer_id: null }],
    [{ ...flow("offer"), approval_type: "open_job" }],
    [{ ...flow("offer"), version: 2 }],
    [{ ...flow("offer"), id: Number.MAX_SAFE_INTEGER + 1 }],
    [flow("offer"), flow("offer")],
  ]) {
    const f = approvalFixture();
    f.reply(async () => json(rows));
    await sanitized(f.client().readApprovalFlow(f.s, "offer"));
    assert.equal(f.calls.length, 1);
  }
});
test("missing flows never imply approval or waived approval requirements", async () => {
  const f = approvalFixture();
  f.reply(async () => json([]));
  assert.equal(await f.client().readApprovalFlow(f.s, "offer"), null);
  assert.equal(greenhouseApprovalState(null), "unverified");
  assert.equal(greenhouseCombinedApprovalState(f.s, flow("job"), null), "unverified");
  assert.equal(
    greenhouseCombinedApprovalState(
      f.s,
      { ...flow("job"), approval_type: "open_job" },
      flow("offer"),
    ),
    "unverified",
  );
  assert.equal(
    greenhouseCombinedApprovalState(f.s, flow("job"), { ...flow("offer"), offer_id: 999 }),
    "unverified",
  );
  assert.throws(() => boundGreenhouseApprovalFlow([flow("offer")], f.s, "job"));
});
test("approval state distinguishes unrequested, pending, rejected and fully approved gates", () => {
  const f = approvalFixture();
  const job = flow("job"),
    offer = flow("offer");
  assert.equal(greenhouseCombinedApprovalState(f.s, job, offer), "approved");
  assert.equal(
    greenhouseCombinedApprovalState(f.s, job, { ...offer, approval_status: "pending" }),
    "pending",
  );
  assert.equal(
    greenhouseCombinedApprovalState(f.s, job, { ...offer, approval_status: "rejected" }),
    "rejected",
  );
  assert.equal(
    greenhouseApprovalState({ ...offer, approval_status: "pending", requested_by_id: null }),
    "not_requested",
  );
  assert.equal(
    greenhouseApprovalState({ ...offer, approval_status: null, requested_by_id: null }),
    "not_requested",
  );
  assert.equal(
    greenhouseApprovalState({ ...offer, approval_status: "approved", requested_by_id: null }),
    "unverified",
  );
  assert.equal(greenhouseApprovalState({ ...offer, approval_status: null }), "unverified");
  assert.equal(
    greenhouseCombinedApprovalState(
      f.s,
      { ...job, approval_status: "pending", requested_by_id: null },
      offer,
    ),
    "not_requested",
  );
  const changed = structuredClone(offer);
  changed.updated_at = "2026-11-14T12:00:02Z";
  assert.notEqual(offerDigest(changed), offerDigest(offer));
});

test("wire body uses Harvest field arrays and explicit currency precision without delivery fields", () => {
  const f = fixture();
  assert.deepEqual(greenhouseOfferDraftBody(f.s, f.p.currencyDigits), {
    application_id: 300,
    opening_id: 101,
    starts_on: "2026-12-01",
    custom_fields: [{ name_key: "salary", value: { amount: 123456.78, currency_code: "USD" } }],
  });
  for (const [currency, amountMinor, expected] of [
    ["JPY", 123, 123],
    ["KWD", 123456, 123.456],
  ] as const) {
    f.s.values.salary = { amountMinor, currency };
    assert.equal(
      (
        greenhouseOfferDraftBody(f.s, f.p.currencyDigits).custom_fields[0].value as {
          amount: number;
        }
      ).amount,
      expected,
    );
  }
  assert.throws(() => greenhouseOfferDraftBody(f.s, {}));
  f.s.values.salary = { amountMinor: Number.MAX_SAFE_INTEGER, currency: "USD" };
  assert.throws(() => greenhouseOfferDraftBody(f.s, f.p.currencyDigits));
});
test("valid draft creation makes one pinned POST and only reports a Created draft", async () => {
  const f = fixture();
  const result = await f.client().createOfferDraft(f.s);
  assert.equal(result.status, "created");
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, "https://harvest.greenhouse.io/v3/offers");
  assert.equal(call.init.method, "POST");
  assert.equal(call.init.redirect, "error");
  assert.equal(call.init.credentials, "omit");
  assert.equal(call.init.cache, "no-store");
  assert(call.init.signal instanceof AbortSignal);
  assert.deepEqual(
    JSON.parse(String(call.init.body)),
    greenhouseOfferDraftBody(f.s, f.p.currencyDigits),
  );
  assert(!JSON.stringify(call.init.body).includes("sent_on"));
});
for (const field of [
  "tenantId",
  "accountRef",
  "connectionRevision",
  "expectedRevision",
  "privateOfferReadVerified",
  "offerCreateVerified",
  "claimedAttemptId",
  "reviewedBodyHash",
  "expiresAt",
  "token",
]) {
  test(`invalid server permit ${field} is rejected before network I/O`, async () => {
    const f = fixture();
    (f.p as Record<string, unknown>)[field] =
      field === "expiresAt"
        ? 1500
        : field.endsWith("Verified")
          ? false
          : field === "token"
            ? "invalid\r\nheader"
            : field === "claimedAttemptId"
              ? null
              : "invalid";
    await sanitized(f.client().createOfferDraft(f.s));
    assert.equal(f.calls.length, 0);
  });
}
test("stale human intent or wrong designated submitter cannot create", async () => {
  for (const mutate of [
    (s: OfferSnapshot) => {
      s.values.salary = { amountMinor: 5, currency: "USD" };
    },
    (s: OfferSnapshot) => {
      s.actor.id = s.termsOwnerId;
    },
    (s: OfferSnapshot) => {
      s.currentHumanDecision = false;
    },
  ]) {
    const f = fixture();
    mutate(f.s);
    f.p.expectedRevision = offerRevision(f.s);
    await sanitized(f.client().createOfferDraft(f.s));
    assert.equal(f.calls.length, 0);
  }
});
for (const status of [301, 401, 403, 422, 429, 500, 503]) {
  test(`HTTP ${status} leaves create uncertain with no refresh or retry`, async () => {
    const f = fixture();
    f.reply(async () =>
      json({ error: "sensitive-provider-message" }, status, {
        "Retry-After": "0",
        Location: "https://other.invalid/",
      }),
    );
    assert.deepEqual(await f.client().createOfferDraft(f.s), { status: "uncertain" });
    assert.equal(f.calls.length, 1);
  });
}
test("network rejection is uncertain and never exposes its cause", async () => {
  const f = fixture();
  f.reply(async () => {
    throw new Error("secret-token and private salary");
  });
  assert.deepEqual(await f.client().createOfferDraft(f.s), { status: "uncertain" });
  assert.equal(f.calls.length, 1);
});
test("UTF-8 request byte limit is enforced before the write", async () => {
  const f = fixture();
  f.s.values = {};
  f.s.contract.fields = [];
  for (let i = 0; i < 100; i++) {
    const key = `field_${i}`;
    f.s.values[key] = "🙂".repeat(2000);
    f.s.contract.fields.push({
      key,
      type: "text",
      required: true,
      choices: [],
      currencies: [],
      min: null,
      max: null,
    });
  }
  f.p.expectedRevision = offerRevision(f.s);
  f.p.reviewedBodyHash = offerDigest(greenhouseOfferDraftBody(f.s, f.p.currencyDigits));
  await sanitized(f.client().createOfferDraft(f.s));
  assert.equal(f.calls.length, 0);
});
test("deadline bounds fetch even if injected fetch ignores abort", async () => {
  const f = fixture();
  f.reply(() => new Promise(() => {}));
  assert.deepEqual(await f.client(20).createOfferDraft(f.s), { status: "uncertain" });
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal?.aborted, true);
});
test("late authorization after deadline never starts a deferred write", async () => {
  const f = fixture();
  let release!: () => void;
  f.authorize(
    () =>
      new Promise((resolve) => {
        release = () => resolve(structuredClone(f.p));
      }),
  );
  await sanitized(f.client(20).createOfferDraft(f.s));
  release();
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(f.calls.length, 0);
});
test("slow response body is cancelled at deadline", async () => {
  const f = fixture();
  let cancelled = false;
  f.reply(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode("{"));
          },
          cancel() {
            cancelled = true;
          },
        }),
        { status: 201, headers: { "Content-Type": "application/json" } },
      ),
  );
  assert.deepEqual(await f.client(20).createOfferDraft(f.s), { status: "uncertain" });
  assert(cancelled);
});
test("malformed, oversized, redirected and wrong-binding responses remain uncertain", async () => {
  for (const reply of [
    async () =>
      new Response("not-json", { status: 201, headers: { "Content-Type": "application/json" } }),
    async () => json({ ...fixture().row, application_id: 999 }, 201),
    async () => json({ ...fixture().row, version: Number.MAX_SAFE_INTEGER + 1 }, 201),
    async () => json({ ...fixture().row, sent_on: "2026-11-14" }, 201),
    async () => json(fixture().row, 201, { "Content-Length": "524289" }),
    async () =>
      new Response("x".repeat(524289), {
        status: 201,
        headers: { "Content-Type": "application/json" },
      }),
    async () => json(fixture().row, 201, { Link: '<https://other.invalid/>; rel="next"' }),
    async () => {
      const r = json(fixture().row, 201);
      Object.defineProperty(r, "redirected", { value: true });
      return r;
    },
  ]) {
    const f = fixture();
    f.reply(reply);
    assert.deepEqual(await f.client().createOfferDraft(f.s), { status: "uncertain" });
    assert.equal(f.calls.length, 1);
  }
});
test("wrong or additional financial terms and non-Created statuses never confirm creation", async () => {
  for (const mutate of [
    (r: ReturnType<typeof fixture>["row"]) => {
      r.custom_fields.salary.value.amount += 1;
    },
    (r: ReturnType<typeof fixture>["row"]) => {
      r.status = "Accepted";
    },
    (r: ReturnType<typeof fixture>["row"]) => {
      r.opening_id = 999;
    },
    (r: ReturnType<typeof fixture>["row"]) => {
      Object.assign(r.custom_fields, { bonus: { name: "Bonus", type: "number", value: 999 } });
    },
  ]) {
    const f = fixture();
    mutate(f.row);
    assert.deepEqual(await f.client().createOfferDraft(f.s), { status: "uncertain" });
  }
});
test("scoped read is exact, never follows pagination and rechecks private permission", async () => {
  const f = fixture();
  f.reply(async () => json([f.row]));
  const row = await f.client().readCurrent(f.s);
  assert(row);
  const url = new URL(f.calls[0].url);
  assert.equal(url.searchParams.get("application_ids"), "300");
  assert.equal(url.searchParams.get("candidate_ids"), "200");
  assert.equal(url.searchParams.get("job_ids"), "100");
  assert.equal(url.searchParams.get("current_only"), "true");
  assert.equal(f.calls[0].init.method, "GET");
  assert.equal(f.calls[0].init.body, undefined);
  const revision = greenhouseOfferChain(row);
  assert.notEqual(
    greenhouseOfferChain({ ...row, updated_at: "2026-11-14T12:01:00Z" }).revision,
    revision.revision,
  );
  let reads = 0;
  f.authorize(async () => {
    if (++reads === 2) throw new Error("Revoked private access");
    return f.p;
  });
  await sanitized(f.client().readCurrent(f.s));
});
test("empty lists require verified private read access; ambiguous or foreign lists fail closed", async () => {
  const f = fixture();
  f.reply(async () => json([]));
  assert.equal(await f.client().readCurrent(f.s), null);
  f.p.privateOfferReadVerified = false as true;
  await sanitized(f.client().readCurrent(f.s));
  assert.equal(f.calls.length, 1);
  f.p.privateOfferReadVerified = true;
  for (const list of [[f.row, f.row], [{ ...f.row, candidate_id: 999 }], { data: [f.row] }]) {
    f.reply(async () => json(list));
    await sanitized(f.client().readCurrent(f.s));
  }
});
