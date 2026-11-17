import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { greenhouseControlledOfferAssembly } from "./greenhouse-offer-assembly";
import { readGreenhouseOfferConfiguration } from "./greenhouse-offer-configuration";
import { offerDigest, offerRevision, type OfferSnapshot } from "./greenhouse-offer-policy";
import {
  type OfferAttempt,
  type OfferControlStore,
  type OfferControlSource,
} from "./greenhouse-offer-controls";
import type { GreenhouseWireOffer } from "./greenhouse-offer-wire";
import type { GreenhouseEmployerOfferReview } from "./greenhouse-offer-review";
import { GREENHOUSE_OFFER_CONFIGURATION_SCOPES } from "./greenhouse-offer-configuration";
import type { GreenhouseApprovalFlow } from "./greenhouse-offer-evidence";

const stamp = "2026-11-15T12:00:00Z";
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "Content-Type": "application/json" },
  });
async function fixture() {
  const s: OfferSnapshot = {
    actor: { id: "owner", tenantId: "tenant" },
    scope: { workflowId: "workflow" },
    accountRef: "a".repeat(64),
    connectionRevision: "connection",
    binding: { applicationId: "300", candidateId: "200", jobId: "100" },
    sourceRevision: "b".repeat(64),
    termsOwnerId: "owner",
    approverId: "approver",
    submitterId: "submitter",
    currentHumanDecision: true,
    writePermissionConfirmed: true,
    canReadRemote: true,
    existingChain: null,
    existingApprovalState: "none",
    openingId: "101",
    startDate: "2026-12-01",
    values: { salary: { amountMinor: 12000000, currency: "USD" } },
    contract: {
      accountRef: "a".repeat(64),
      connectionRevision: "connection",
      bindingHash: offerDigest({ applicationId: "300", candidateId: "200", jobId: "100" }),
      chainHash: offerDigest(null),
      revision: "c".repeat(64),
      evidenceReference: "d".repeat(64),
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
          max: 50000000,
        },
      ],
    },
  };
  const f = {
    s,
    now: 1500,
    active: true,
    calls: [] as { path: string; method: string; body: string | undefined }[],
    records: [] as OfferAttempt[],
    row: null as GreenhouseWireOffer | null,
    candidate: null as GreenhouseApprovalFlow | null,
    review: null as GreenhouseEmployerOfferReview | null,
    scopeMissing: "",
    createMode: "ok",
    approvalMode: "ok",
    fieldChanged: false,
    failDraftCommit: false,
    storageDown: false,
    revokeAfterCreate: false,
    changeJobAfterCreate: false,
    corruptReceipt: false,
    job: {
      id: 500,
      job_id: 100,
      offer_id: null,
      approval_type: "offer_job",
      version: 1,
      requested_by_id: 7,
      approval_status: "approved",
      sequential: false,
      created_at: stamp,
      updated_at: stamp,
    } as GreenhouseApprovalFlow,
  };
  const fetcher: typeof fetch = async (input, init) => {
    const u = new URL(String(input));
    const method = init?.method ?? "GET";
    f.calls.push({ path: u.pathname + u.search, method, body: init?.body as string | undefined });
    assert.equal(u.hostname, "harvest.greenhouse.io");
    if (method === "POST") {
      if (u.pathname === "/v3/offers") {
        const body = JSON.parse(init!.body as string);
        f.row = {
          id: 400,
          version: 1,
          application_id: 300,
          candidate_id: 200,
          job_id: 100,
          opening_id: body.opening_id,
          starts_on: body.starts_on,
          sent_on: null,
          resolved_at: null,
          updated_at: stamp,
          status: "Created",
          custom_fields: Object.fromEntries(
            body.custom_fields.map((v: { name_key: string; value: unknown }) => [
              v.name_key,
              { name: v.name_key, type: "currency", value: v.value },
            ]),
          ),
        };
        f.candidate = {
          ...f.job,
          id: 501,
          offer_id: 400,
          approval_type: "offer_candidate",
          requested_by_id: null,
          approval_status: "pending",
        };
        if (f.createMode === "already_requested") f.candidate.requested_by_id = 7;
        if (f.createMode === "bad_flow_binding") f.candidate.offer_id = 999;
        if (f.createMode === "bad_flow_version") f.candidate.version = 2;
        if (f.revokeAfterCreate) f.active = false;
        if (f.changeJobAfterCreate) f.job.approval_status = "rejected";
        if (f.createMode === "unknown") throw new Error("Synthetic lost create response");
        if (f.createMode === "extra_value")
          f.row.custom_fields!.bonus = { name: "Bonus", type: "number", value: 100000 };
        return json(f.row, 201);
      }
      assert.equal(u.pathname, "/v3/approval_flows/501/request_approvals");
      assert.equal(init?.body, "{}");
      assert.equal(f.records.at(-1)?.state, "draft_created");
      if (f.approvalMode !== "no_effect") f.candidate!.requested_by_id = 7;
      if (f.approvalMode === "unknown") throw new Error("Synthetic lost approval response");
      if (f.approvalMode === "wrong_terms")
        f.row!.custom_fields!.salary.value = { amount: 1, currency_code: "USD" };
      if (f.approvalMode === "rejected") f.candidate!.approval_status = "rejected";
      if (f.approvalMode === "rate_limit") return json({}, 429);
      return new Response(null, { status: 204 });
    }
    switch (u.pathname) {
      case "/v3/jobs":
        return json([
          {
            id: 100,
            status: "open",
            is_template: false,
            office_ids: [],
            department_id: null,
            updated_at: stamp,
          },
        ]);
      case "/v3/custom_fields":
        return json([
          {
            id: 1,
            name_key: "salary",
            name: "Salary",
            field_type: "offer",
            active: true,
            value_type: "currency",
            private: true,
            required: !f.fieldChanged,
            trigger_new_version: true,
            internal_type: null,
            default_value: null,
            updated_at: stamp,
          },
        ]);
      case "/v3/custom_field_offices":
      case "/v3/custom_field_departments":
      case "/v3/custom_field_options":
      case "/v3/offices":
      case "/v3/departments":
        return json([]);
      case "/v3/openings":
        return json([
          {
            id: 101,
            job_id: 100,
            opening_id: "External label",
            open: true,
            application_id: null,
            closed_at: null,
            updated_at: stamp,
          },
        ]);
      case "/v3/offers":
        return json(f.row ? [f.row] : []);
      case "/v3/approval_flows":
        return json(
          u.searchParams.get("approval_type") === "offer_job"
            ? [f.job]
            : f.candidate
              ? [f.candidate]
              : [],
        );
      default:
        throw new Error("Unexpected mock path");
    }
  };
  const cfg = await readGreenhouseOfferConfiguration(s, async (path) =>
    (await fetcher("https://harvest.greenhouse.io" + path)).json(),
  );
  f.review = {
    tenantId: "tenant",
    workflowId: "workflow",
    contractHash: offerDigest(s.contract),
    configurationHash: cfg.metadataRevision,
    evidenceReference: s.contract.evidenceReference,
    reviewedBy: "verified-employer-admin",
    reviewedAt: 1000,
    expiresAt: 2000,
    currencyDigits: { USD: 2 },
    choiceLabelEncodingVerified: false,
    jobApprovalNotRequiredVerified: false,
    operation: "create_or_version_then_request_internal_approval_without_candidate_delivery",
  };
  f.calls.length = 0;
  const source: OfferControlSource = {
    current: async (actor, scope) => {
      assert.equal(actor.tenantId, "tenant");
      assert.equal(scope.workflowId, "workflow");
      assert.ok(["owner", "approver", "submitter"].includes(actor.id));
      assert.ok(f.active);
      return { ...structuredClone(s), actor: structuredClone(actor) };
    },
    fence: async (actor, scope, work) => work(await source.current(actor, scope)),
  };
  const latest = () => f.records.at(-1);
  const store: OfferControlStore = {
    prepare: async (row) => {
      const prior = f.records.find((v) => v.prepareRequestId === row.prepareRequestId);
      if (prior) return structuredClone(prior);
      f.records.push(structuredClone(row));
      return structuredClone(row);
    },
    approve: async (actor, _scope, id, revision) => {
      const row = latest()!;
      assert.equal(row.id, id);
      assert.equal(row.revision, revision);
      assert.equal(row.state, "prepared");
      const next = { ...row, state: "approved" as const, approvedBy: actor.id };
      f.records.push(next);
      return structuredClone(next);
    },
    latest: async () => structuredClone(latest() ?? null),
    get: async (_actor, _scope, id) =>
      structuredClone([...f.records].reverse().find((v) => v.id === id) ?? null),
    claim: async (_actor, _scope, id, revision, requestId) => {
      const row = latest()!;
      assert.equal(row.id, id);
      assert.equal(row.revision, revision);
      if (row.state !== "approved") return { acquired: false, attempt: structuredClone(row) };
      const next = { ...row, state: "claimed" as const, executionRequestId: requestId };
      f.records.push(next);
      return { acquired: true, attempt: structuredClone(next) };
    },
    record: async (_actor, row, state, receiptHash) => {
      if (f.storageDown) throw new Error("Synthetic storage unavailable");
      assert.equal(latest()!.id, row.id);
      assert.equal(latest()!.executionRequestId, row.executionRequestId);
      const next = { ...latest()!, state, receiptHash: receiptHash ?? latest()!.receiptHash };
      if (state === "draft_created" && f.corruptReceipt) next.receiptHash = "f".repeat(64);
      f.records.push(next);
      if (state === "draft_created" && f.failDraftCommit) {
        f.storageDown = true;
        throw new Error("Synthetic crash after committed draft receipt");
      }
      return structuredClone(next);
    },
  };
  const engine = () =>
    greenhouseControlledOfferAssembly({
      fetcher,
      now: () => f.now,
      timeoutMs: 2000,
      readEmployerReview: async () => structuredClone(f.review),
      readCustody: async (snapshot) => {
        const token = "synthetic-token";
        return {
          token,
          authority: {
            tenantId: snapshot.actor.tenantId,
            actorId: snapshot.actor.id,
            workflowId: snapshot.scope.workflowId,
            accountRef: snapshot.accountRef,
            credentialHash: offerDigest(token),
            connectionRevision: snapshot.connectionRevision,
            bindingHash: offerDigest(snapshot.binding),
            employerConfirmed: true,
            evidenceReference: "e".repeat(64),
            observedAt: f.now,
            expiresAt: f.now + 1000,
            grantedScopes: [
              ...GREENHOUSE_OFFER_CONFIGURATION_SCOPES,
              "harvest:offers:list",
              "harvest:offers:create",
              "harvest:approval_flows:request_approvals",
            ].filter((v) => v !== f.scopeMissing),
            identity: {
              kind: "site_admin",
              credentialSubjectId: "7",
              verifiedSubjectId: "7",
              active: f.active,
              privateOffersPermission: "verified",
            },
          },
        };
      },
    })(source, store);
  const actor = (id: string) => ({ id, tenantId: "tenant" });
  const command = () => ({
    expectedRevision: offerRevision(s),
    requestId: randomUUID(),
    confirm: true as const,
  });
  async function approved() {
    const row = await engine().prepare(actor("owner"), s.scope, command());
    await engine().approve(actor("approver"), s.scope, row.id, command());
    return row;
  }
  return Object.assign(f, { engine, actor, command, approved, store });
}

test("separate humans prepare, approve and submit; exact draft and approval read-back are verified", async () => {
  const f = await fixture();
  const row = await f.approved();
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 0);
  const outcome = await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command());
  assert.equal(outcome.state, "verified_submission");
  assert.deepEqual(
    f.records.map((v) => v.state),
    [
      "prepared",
      "approved",
      "claimed",
      "draft_created",
      "provider_accepted",
      "verified_submission",
    ],
  );
  assert.deepEqual(
    f.calls.filter((v) => v.method === "POST").map((v) => v.path),
    ["/v3/offers", "/v3/approval_flows/501/request_approvals"],
  );
  assert.ok(!JSON.stringify(f.records).includes("120000"));
  assert.ok(!JSON.stringify(f.records).includes("synthetic-token"));
  await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command());
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 2);
});
test("approval cannot be skipped and the designated submitter cannot be substituted", async () => {
  const f = await fixture();
  const row = await f.engine().prepare(f.actor("owner"), f.s.scope, f.command());
  await assert.rejects(f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command()));
  await f.engine().approve(f.actor("approver"), f.s.scope, row.id, f.command());
  await assert.rejects(f.engine().submit(f.actor("owner"), f.s.scope, row.id, f.command()));
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 0);
});
test("concurrent submits across reconstructed engines acquire one durable claim", async () => {
  const f = await fixture(),
    row = await f.approved();
  await Promise.all(
    Array.from({ length: 5 }, () =>
      f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command()),
    ),
  );
  assert.equal(f.calls.filter((v) => v.method === "POST" && v.path === "/v3/offers").length, 1);
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 2);
});
for (const mode of ["unknown", "extra_value", "bad_flow_binding", "bad_flow_version"])
  test(`create ${mode} never triggers an approval request or resend`, async () => {
    const f = await fixture(),
      row = await f.approved();
    f.createMode = mode;
    const result = await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command());
    assert.equal(result.state, "review_required");
    await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command());
    assert.equal(f.calls.filter((v) => v.method === "POST").length, 1);
  });
test("an approval request cannot use a mismatched persisted draft receipt", async () => {
  const f = await fixture(),
    row = await f.approved();
  f.corruptReceipt = true;
  assert.equal(
    (await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command())).state,
    "review_required",
  );
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 1);
});
for (const mode of ["unknown", "no_effect", "wrong_terms", "rejected", "rate_limit"])
  test(`approval ${mode} stays held without retrying the financial or approval operation`, async () => {
    const f = await fixture(),
      row = await f.approved();
    f.approvalMode = mode;
    const result = await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command());
    assert.equal(result.state, "review_required");
    await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command());
    assert.equal(f.calls.filter((v) => v.method === "POST").length, 2);
    if (mode === "unknown") {
      assert.equal(
        (await f.engine().recover(f.actor("owner"), f.s.scope, row.id)).state,
        "observed_match",
      );
      assert.equal(f.calls.filter((v) => v.method === "POST").length, 2);
    }
  });
test("a committed draft receipt survives a reconstructed engine; recovery remains read-only after review expiry", async () => {
  const f = await fixture(),
    row = await f.approved();
  f.failDraftCommit = true;
  await assert.rejects(f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command()));
  assert.equal(f.records.at(-1)!.state, "draft_created");
  f.storageDown = false;
  assert.equal(
    (await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command())).state,
    "draft_created",
  );
  f.now = 3000;
  assert.equal(
    (await f.engine().recover(f.actor("owner"), f.s.scope, row.id)).state,
    "observed_match",
  );
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 1);
});
test("authority revoked after draft creation prevents internal approval emails", async () => {
  const f = await fixture(),
    row = await f.approved();
  f.revokeAfterCreate = true;
  assert.equal(
    (await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command())).state,
    "review_required",
  );
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 1);
});
test("a rejected job approval after draft creation prevents internal approval emails", async () => {
  const f = await fixture(),
    row = await f.approved();
  f.changeJobAfterCreate = true;
  assert.equal(
    (await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command())).state,
    "review_required",
  );
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 1);
});
test("an already-started candidate flow is observed, not requested a second time", async () => {
  const f = await fixture(),
    row = await f.approved();
  f.createMode = "already_requested";
  assert.equal(
    (await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command())).state,
    "verified_submission",
  );
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 1);
});
for (const change of ["tenant", "contract", "configuration", "precision", "expiry", "fields"])
  test(`invalid reviewed ${change} blocks before financial writes`, async () => {
    const f = await fixture();
    if (change === "tenant") f.review!.tenantId = "foreign";
    if (change === "contract") f.review!.contractHash = "f".repeat(64);
    if (change === "configuration") f.review!.configurationHash = "f".repeat(64);
    if (change === "precision") f.review!.currencyDigits = {};
    if (change === "expiry") f.now = 3000;
    if (change === "fields") f.fieldChanged = true;
    await assert.rejects(f.engine().prepare(f.actor("owner"), f.s.scope, f.command()));
    assert.equal(f.calls.filter((v) => v.method === "POST").length, 0);
  });
test("missing request-approvals scope prevents creating an unusable draft", async () => {
  const f = await fixture(),
    row = await f.approved();
  f.scopeMissing = "harvest:approval_flows:request_approvals";
  assert.equal(
    (await f.engine().submit(f.actor("submitter"), f.s.scope, row.id, f.command())).state,
    "review_required",
  );
  assert.equal(f.calls.filter((v) => v.method === "POST").length, 0);
});
