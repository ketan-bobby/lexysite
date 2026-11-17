import assert from "node:assert/strict";
import { test } from "node:test";
import {
  greenhouseOfferHttp,
  GreenhouseOfferHttpError,
  type GreenhouseOfferHttpPermit,
} from "./greenhouse-offer-http";
import { GREENHOUSE_OFFER_CONFIGURATION_SCOPES } from "./greenhouse-offer-configuration";
import { offerDigest, offerRevision, type OfferSnapshot } from "./greenhouse-offer-policy";

const stamp = "2026-11-15T12:00:00Z";
const field = (id: number, value_type = "short_text") => ({
  id,
  name_key: `field_${id}`,
  name: `Field ${id}`,
  field_type: "offer",
  active: true,
  value_type,
  private: true,
  required: true,
  trigger_new_version: true,
  internal_type: null as string | null,
  default_value: null as unknown,
  updated_at: stamp,
});
function fixture() {
  const s: OfferSnapshot = {
    actor: { id: "reader", tenantId: "tenant" },
    scope: { workflowId: "workflow" },
    accountRef: "a".repeat(64),
    connectionRevision: "connection",
    binding: { applicationId: "300", candidateId: "200", jobId: "100" },
    sourceRevision: "b".repeat(64),
    termsOwnerId: "owner",
    approverId: "reviewer",
    submitterId: "submitter",
    currentHumanDecision: false,
    writePermissionConfirmed: false,
    canReadRemote: true,
    existingChain: null,
    existingApprovalState: "none",
    openingId: null,
    startDate: null,
    values: {},
    contract: {
      accountRef: "a".repeat(64),
      connectionRevision: "connection",
      bindingHash: offerDigest({ applicationId: "300", candidateId: "200", jobId: "100" }),
      chainHash: offerDigest(null),
      revision: "c".repeat(64),
      evidenceReference: "synthetic",
      verifiedAt: 1000,
      expiresAt: 2000,
      applicationBound: false,
      sideEffectsReviewed: false,
      approvalFlowConfirmed: false,
      candidateDeliveryDisabled: false,
      startDateRequired: false,
      openingRequired: false,
      allowedOpeningIds: [],
      fields: [],
    },
  };
  const token = "synthetic-configuration-token";
  const p: GreenhouseOfferHttpPermit = {
    tenantId: s.actor.tenantId,
    accountRef: s.accountRef,
    connectionRevision: s.connectionRevision,
    expectedRevision: offerRevision(s),
    expiresAt: 1900,
    privateOfferReadVerified: true,
    approvalReadVerified: true,
    offerCreateVerified: false,
    claimedAttemptId: null,
    reviewedBodyHash: null,
    currencyDigits: {},
    token,
    authority: {
      tenantId: s.actor.tenantId,
      actorId: s.actor.id,
      workflowId: s.scope.workflowId,
      accountRef: s.accountRef,
      credentialHash: offerDigest(token),
      connectionRevision: s.connectionRevision,
      bindingHash: offerDigest(s.binding),
      employerConfirmed: true,
      evidenceReference: "d".repeat(64),
      observedAt: 1000,
      expiresAt: 2000,
      grantedScopes: ["harvest:offers:list", ...GREENHOUSE_OFFER_CONFIGURATION_SCOPES],
      identity: {
        kind: "site_admin",
        credentialSubjectId: "77",
        verifiedSubjectId: "77",
        active: true,
        privateOffersPermission: "verified",
      },
    },
  };
  const tree = (id: number, parent_id: number | null) => ({ id, parent_id, updated_at: stamp });
  const opening = (id: number) => ({
    id,
    job_id: 100,
    open: true,
    application_id: null,
    closed_at: null,
    opening_id: "external-label-not-a-primary-id",
    updated_at: stamp,
  });
  const data = {
    jobs: [
      {
        id: 100,
        status: "open",
        is_template: false,
        department_id: 21 as number | null,
        office_ids: [11],
        updated_at: stamp,
      },
    ],
    custom_fields: [field(1, "currency"), field(2, "single_select"), field(3, "long_text")],
    offices: [tree(10, null), tree(11, 10), tree(12, null)],
    departments: [tree(20, null), tree(21, 20), tree(22, null)],
    openings: [opening(101), opening(102)],
    offers: [
      {
        id: 400,
        job_id: 100,
        application_id: 999,
        opening_id: 102,
        status: "Created",
        resolved_at: null,
        version: 1,
        updated_at: stamp,
      },
    ],
    approval_flows: [
      {
        id: 500,
        job_id: 100,
        offer_id: null as number | null,
        approval_type: "offer_job",
        version: 1,
        requested_by_id: null as number | null,
        approval_status: "pending",
        sequential: true,
        created_at: stamp,
        updated_at: stamp,
      },
    ],
    custom_field_options: [
      { id: 60, custom_field_id: 2, name: "Full-time", active: true, updated_at: stamp },
    ],
    custom_field_offices: [
      { id: 70, custom_field_id: 1, office_id: 10, updated_at: stamp },
      { id: 71, custom_field_id: 3, office_id: 12, updated_at: stamp },
    ],
    custom_field_departments: [
      { id: 80, custom_field_id: 1, department_id: 20, updated_at: stamp },
      { id: 81, custom_field_id: 2, department_id: 22, updated_at: stamp },
    ],
  };
  const calls: { url: URL; init: RequestInit }[] = [];
  let reply = async (url: URL): Promise<Response> =>
    json(data[url.pathname.slice(4) as keyof typeof data]);
  const client = (timeoutMs = 1000) =>
    greenhouseOfferHttp({
      authorize: async () => structuredClone(p),
      now: () => 1500,
      timeoutMs,
      fetcher: (async (url, init) => {
        const target = new URL(String(url));
        calls.push({ url: target, init: init! });
        return reply(target);
      }) as typeof fetch,
    });
  return {
    s,
    p,
    data,
    calls,
    client,
    reply(next: typeof reply) {
      reply = next;
    },
  };
}
const json = (data: unknown, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
async function denied(work: Promise<unknown>) {
  await assert.rejects(
    work,
    (e: unknown) =>
      e instanceof GreenhouseOfferHttpError &&
      e.message === "Greenhouse offer request unavailable." &&
      !("cause" in e),
  );
}

test("configuration inventory binds the exact job and preserves required/private/version/default rules", async () => {
  const f = fixture();
  f.data.custom_fields[0].default_value = 0;
  const result = await f.client().readEmployerConfiguration(f.s);
  assert.equal(result.executionReady, false);
  assert.deepEqual(result.context.binding, f.s.binding);
  assert.equal(result.fields[0].required, true);
  assert.equal(result.fields[0].private, true);
  assert.equal(result.fields[0].triggersNewVersion, true);
  assert.equal(result.fields[0].hasDefault, true);
  assert.equal(result.fields[0].defaultHash, offerDigest(0));
  assert.deepEqual(result.fields[1].choices, [{ id: "60", name: "Full-time" }]);
  assert.deepEqual(result.systemRequirements, { startDateRequired: null, openingRequired: null });
  assert.deepEqual(result.currencyRules, [
    { fieldId: "1", allowedCodes: null, minorUnitDigits: null },
  ]);
  assert.equal(result.jobApproval.state, "not_requested");
  assert.equal(result.offerApproval.state, "unverified");
  assert.equal(f.calls.length, 20); // Ten scoped reads, repeated once to detect drift.
  assert.ok(
    f.calls.every(
      (c) =>
        c.url.origin === "https://harvest.greenhouse.io" &&
        c.init.method === "GET" &&
        c.init.body === undefined &&
        c.init.redirect === "error",
    ),
  );
  assert.equal(f.calls[0].url.searchParams.get("ids"), "100");
  assert.ok(
    f.calls
      .filter((c) => c.url.pathname === "/v3/openings")
      .every((c) => c.url.searchParams.get("job_ids") === "100"),
  );
});
test("office and department rules compose with AND and include ancestor matches", async () => {
  const f = fixture(),
    r = await f.client().readEmployerConfiguration(f.s);
  assert.deepEqual(
    r.fields.map((v) => v.applies),
    [true, false, false],
  );
  f.data.jobs[0].office_ids = [];
  f.data.jobs[0].department_id = null;
  const unrestricted = await f.client().readEmployerConfiguration(f.s);
  assert.ok(unrestricted.fields.every((v) => v.applies));
});
test("unresolved existing offers reserve numeric opening IDs rather than external opening labels", async () => {
  const f = fixture(),
    r = await f.client().readEmployerConfiguration(f.s);
  assert.deepEqual(r.openings, [
    { id: "101", availability: "candidate", reservedByCurrentChain: false },
    { id: "102", availability: "reserved", reservedByCurrentChain: false },
  ]);
  assert.ok(r.unresolved.includes("verified_application_binding"));
});
test("managed requirements are known only from explicit applicable definitions", async () => {
  const f = fixture();
  f.data.custom_fields.push({ ...field(4, "date"), internal_type: "start_date", required: false });
  f.data.custom_fields.push({ ...field(5), internal_type: "offer_opening" });
  const r = await f.client().readEmployerConfiguration(f.s);
  assert.deepEqual(r.systemRequirements, { startDateRequired: false, openingRequired: true });
});
test("unsupported fields are retained for review rather than silently mapped to text", async () => {
  const f = fixture();
  f.data.custom_fields[0].value_type = "currency_range";
  const r = await f.client().readEmployerConfiguration(f.s);
  assert.equal(r.fields[0].supported, false);
  assert.ok(r.unresolved.includes("unsupported_offer_field_types"));
});
for (const scope of GREENHOUSE_OFFER_CONFIGURATION_SCOPES) {
  test(`missing ${scope} prevents configuration reads before I/O`, async () => {
    const f = fixture();
    f.p.authority.grantedScopes = f.p.authority.grantedScopes.filter((v) => v !== scope);
    await denied(f.client().readEmployerConfiguration(f.s));
    assert.equal(f.calls.length, 0);
  });
}
test("permission loss after the first metadata response exposes no partial inventory", async () => {
  const f = fixture();
  f.reply(async () => {
    f.p.authority.identity.active = false;
    return json(f.data.jobs);
  });
  await denied(f.client().readEmployerConfiguration(f.s));
  assert.equal(f.calls.length, 1);
});
test("one deadline bounds the complete configuration plan, including an unresponsive fetch", async () => {
  const f = fixture();
  f.reply(() => new Promise<Response>(() => {}));
  await denied(f.client(20).readEmployerConfiguration(f.s));
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].init.signal?.aborted, true);
});
test("pagination, permission errors and oversized metadata fail without following or retrying", async () => {
  for (const response of [
    () => json([], 200, { Link: '<https://foreign.invalid/>; rel="next"' }),
    () => json({}, 403),
    () => json({}, 429),
    () => json({}, 503),
    () => json([], 200, { "Content-Length": "524289" }),
  ]) {
    const f = fixture();
    f.reply(async () => response());
    await denied(f.client().readEmployerConfiguration(f.s));
    assert.equal(f.calls.length, 1);
  }
});
test("metadata drift between complete sweeps is rejected, not reported as a stable employer contract", async () => {
  const f = fixture();
  let jobReads = 0;
  f.reply(async (url) => {
    const name = url.pathname.slice(4) as keyof typeof f.data;
    const value = structuredClone(f.data[name]);
    if (name === "jobs" && ++jobReads === 2)
      (value as typeof f.data.jobs)[0].updated_at = "2026-11-15T12:00:01Z";
    return json(value);
  });
  await denied(f.client().readEmployerConfiguration(f.s));
  assert.equal(jobReads, 2);
});
test("canonical fingerprints ignore harmless response ordering", async () => {
  const baseline = fixture();
  const expected = await baseline.client().readEmployerConfiguration(baseline.s);
  const f = fixture();
  f.reply(async (url) => {
    const data = structuredClone(f.data[url.pathname.slice(4) as keyof typeof f.data]);
    return json(f.calls.length > 10 ? data.reverse() : data);
  });
  assert.equal((await f.client().readEmployerConfiguration(f.s)).revision, expected.revision);
});
test("caller mutations cannot switch the configuration read to another account or job", async () => {
  const f = fixture();
  f.reply(async (url) => {
    f.s.accountRef = "f".repeat(64);
    f.s.binding.jobId = "999";
    f.s.actor.id = "different-reader";
    return json(f.data[url.pathname.slice(4) as keyof typeof f.data]);
  });
  const result = await f.client().readEmployerConfiguration(f.s);
  assert.equal(result.context.accountRef, "a".repeat(64));
  assert.equal(result.context.binding.jobId, "100");
  assert.equal(result.context.actorId, "reader");
});
test("one overall deadline stops cumulative reads and prevents deferred requests", async () => {
  const f = fixture();
  f.reply(async (url) => {
    await new Promise((resolve) => setTimeout(resolve, 4));
    return json(f.data[url.pathname.slice(4) as keyof typeof f.data]);
  });
  await denied(f.client(30).readEmployerConfiguration(f.s));
  const count = f.calls.length;
  assert.ok(count < 20);
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(f.calls.length, count);
});
test("100 fields are batched in groups of 50 with at most 28 fixed GETs including offer approval", async () => {
  const f = fixture();
  f.data.custom_fields = Array.from({ length: 100 }, (_, n) => field(n + 1, "single_select"));
  f.data.custom_field_options = f.data.custom_fields.map((v) => ({
    id: 1000 + v.id,
    custom_field_id: v.id,
    name: "Choice",
    active: true,
    updated_at: stamp,
  }));
  f.s.existingChain = { id: "400", version: 1, revision: "e".repeat(64) };
  f.s.existingApprovalState = "pending";
  f.s.contract.chainHash = offerDigest(f.s.existingChain);
  f.p.expectedRevision = offerRevision(f.s);
  f.data.offers[0].application_id = 300;
  f.data.approval_flows.push({
    ...f.data.approval_flows[0],
    id: 501,
    offer_id: 400,
    approval_type: "offer_candidate",
    requested_by_id: 77,
    approval_status: "approved",
  });
  f.reply(async (url) => {
    const name = url.pathname.slice(4) as keyof typeof f.data;
    const ids = url.searchParams.get("custom_field_ids")?.split(",").map(Number);
    if (ids)
      return json(
        (f.data[name] as { custom_field_id: number }[]).filter((v) =>
          ids.includes(v.custom_field_id),
        ),
      );
    if (name === "approval_flows")
      return json(
        f.data.approval_flows.filter(
          (v) => v.approval_type === url.searchParams.get("approval_type"),
        ),
      );
    return json(f.data[name]);
  });
  const r = await f.client().readEmployerConfiguration(f.s);
  assert.equal(r.fields.length, 100);
  assert.ok(r.fields.every((v) => v.choices.length === 1));
  assert.equal(r.offerApproval.state, "approved");
  assert.equal(r.executionReady, false);
  assert.equal(f.calls.length, 28);
  assert.ok(
    f.calls.every(
      (c) =>
        !c.url.searchParams.has("custom_field_ids") ||
        c.url.searchParams.get("custom_field_ids")!.split(",").length <= 50,
    ),
  );
});
test("a discovered current offer belonging to another application cannot match the claimed chain", async () => {
  const f = fixture();
  f.s.existingChain = { id: "400", version: 1, revision: "e".repeat(64) };
  f.s.existingApprovalState = "pending";
  f.p.expectedRevision = offerRevision(f.s);
  await denied(f.client().readEmployerConfiguration(f.s));
});
test("foreign, archived, duplicate, unbound and structurally inconsistent rows fail closed", async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    (f) => {
      f.data.jobs[0].id = 999;
    },
    (f) => {
      f.data.custom_fields[0].active = false;
    },
    (f) => {
      f.data.custom_fields[0].field_type = "candidate";
    },
    (f) => {
      f.data.custom_fields[1].name_key = f.data.custom_fields[0].name_key;
    },
    (f) => {
      f.data.openings[0].job_id = 999;
    },
    (f) => {
      f.data.offers[0].job_id = 999;
    },
    (f) => {
      f.data.custom_field_options[0].custom_field_id = 999;
    },
    (f) => {
      f.data.custom_field_offices[0].custom_field_id = 999;
    },
    (f) => {
      f.data.custom_field_departments[0].department_id = 999;
    },
    (f) => {
      f.data.offices[0].parent_id = 11;
    },
    (f) => {
      f.data.offices[1].parent_id = 999;
    },
    (f) => {
      f.data.custom_fields.push(f.data.custom_fields[0]);
    },
    (f) => {
      f.data.custom_field_options.push({ ...f.data.custom_field_options[0], id: 61 });
    },
    (f) => {
      f.data.custom_fields[0].id = Number.MAX_SAFE_INTEGER + 1;
    },
    (f) => {
      f.data.custom_fields = Array.from({ length: 101 }, (_, n) => field(n + 1));
    },
  ];
  for (const change of changes) {
    const f = fixture();
    change(f);
    await denied(f.client().readEmployerConfiguration(f.s));
  }
});
