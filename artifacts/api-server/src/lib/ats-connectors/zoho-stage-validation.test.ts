import assert from "node:assert/strict";
import { test } from "node:test";
import { zohoConsent, zohoOAuthConfig, zohoOAuthProvider } from "./zoho-oauth-provider";
import {
  applicationBinding,
  stageCatalogPage,
  matchStageMappings,
  stageMetadataInput,
} from "./zoho-stage-metadata-policy";
import { zohoReviewedImport } from "./zoho-reviewed-import";
import type { ZohoRow, ZohoStore } from "./zoho-oauth-store";
import { zohoStageValidation } from "./zoho-stage-validation";
import { stageEligibility } from "./zoho-stage-eligibility";
import { zohoStageHandoff } from "./zoho-stage-handoff";
import { CalendarError } from "../outlook-calendar-core";
import express from "express";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";

test("metadata route resolves staff and rejects unconfirmed or caller-overridden identities before provider access", async () => {
  let authorized = true,
    calls = 0;
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          if (!authorized) throw new CalendarError(403, "denied", "Denied");
          return actor;
        },
        service: () => {
          throw Error("unexpected OAuth");
        },
        config: () => null,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        check: async () => {
          calls++;
          throw new CalendarError(
            409,
            "synthetic_metadata_unavailable",
            "Synthetic metadata unavailable",
          );
        },
      }),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr !== "string");
  const url = `http://127.0.0.1:${addr.port}/api/zoho-recruit/campaigns/11111111-1111-4111-8111-111111111111/recipients/22222222-2222-4222-8222-222222222222/stage-validation`;
  const post = (body: unknown) =>
    fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  const valid = { expectedRevision: "a".repeat(64), confirm: true };
  try {
    for (const change of [
      { confirm: false },
      { expectedRevision: "old" },
      { jobId: "999" },
      { candidateId: "999" },
      { mode: "live" },
    ])
      assert.equal((await post({ ...valid, ...change })).status, 400);
    assert.equal(calls, 0);
    const r = await post(valid);
    assert.equal(r.status, 409);
    assert.equal(r.headers.get("cache-control"), "no-store");
    authorized = false;
    assert.equal((await post(valid)).status, 403);
    assert.equal(calls, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const config = zohoOAuthConfig({
  ZOHO_CLIENT_ID: "1000.synthetic",
  ZOHO_CLIENT_SECRET: "synthetic",
  ZOHO_REDIRECT_URI: "https://app.test/api/zoho-recruit/callback",
  ZOHO_SETTINGS_URL: "https://app.test/settings/ats",
  ZOHO_DATA_CENTER: "us",
  SESSION_SECRET: "synthetic",
})!;
const actor = { id: "synthetic-owner", tenantId: "synthetic-employer" };
const revision = "11111111-1111-4111-8111-111111111111";
const payload = {
  data: [
    {
      id: "300",
      Job_Opening_Name: { id: "100" },
      Candidate_Name: { id: "200" },
      Application_Status: "New",
      privateNotes: "never return",
    },
  ],
};
const page = {
  stages: [
    {
      id: "10",
      name: "Screening",
      status: [
        { id: "11", actual_value: "Qualified", display_value: "Qualified" },
        { id: "12", actual_value: "On-Hold", display_value: "On hold" },
      ],
    },
  ],
  info: { page: 1, more_records: false },
};

test("metadata parser proves exact application binding and does not infer permission from a catalog match", () => {
  assert.deepEqual(applicationBinding(payload, "100", "300", "200"), {
    applicationId: "300",
    jobId: "100",
    candidateId: "200",
    currentStatus: "New",
  });
  for (const ids of [
    ["999", "300", "200"],
    ["100", "999", "200"],
    ["100", "300", "999"],
  ])
    assert.throws(() => applicationBinding(payload, ...(ids as [string, string, string])));
  const catalog = stageCatalogPage(page, 1);
  const matches = matchStageMappings(
    { advance: "Qualified", hold: "On hold", decline: null },
    catalog.statuses,
  );
  assert.deepEqual(
    matches.map((m) => m.result),
    ["matched", "missing", "unset"],
  );
  assert.equal(matches[0].statusId, "11");
  assert.throws(() => stageCatalogPage(page, 2));
  assert.throws(() => stageCatalogPage({ ...page, info: undefined }, 1));
  assert.throws(() => stageCatalogPage({ ...page, stages: [...page.stages, ...page.stages] }, 1));
  assert.deepEqual(stageCatalogPage({ data: [] }, 1).statuses, []);
  assert.equal(
    stageMetadataInput.safeParse({ expectedRevision: "a".repeat(64), confirm: false }).success,
    false,
  );
  assert.equal(
    stageMetadataInput.safeParse({ expectedRevision: "a".repeat(64), confirm: true, jobId: "999" })
      .success,
    false,
  );
  assert.equal(
    matchStageMappings({ advance: "Qualified", hold: null, decline: null }, [
      ...catalog.statuses,
      { ...catalog.statuses[0], id: "99", stageId: "20" },
    ])[0].result,
    "ambiguous",
  );
  assert.equal(
    matchStageMappings({ advance: "Offer-Made", hold: null, decline: null }, [
      { id: "90", value: "Offer-Made", label: "Offer made", stageId: "91", stageName: "Offered" },
    ])[0].result,
    "restricted",
  );
});

test("metadata transport is fixed-host GET-only and extra read scope requires explicit opt-in", async () => {
  assert.ok(
    !new URL(zohoConsent(config, "state")).searchParams.get("scope")!.includes("settings.stage"),
  );
  const scopes = new URL(zohoConsent(config, "state", true)).searchParams.get("scope")!;
  assert.ok(scopes.includes("ZohoRecruit.settings.stage.READ"));
  assert.ok(!/UPDATE|CREATE|DELETE|stage.ALL/.test(scopes));
  const calls: URL[] = [];
  const provider = zohoOAuthProvider(config, async (url, init) => {
    const u = new URL(String(url));
    calls.push(u);
    assert.equal(init?.method, "GET");
    assert.equal(init?.redirect, "error");
    assert.equal(u.origin, "https://recruit.zoho.com");
    assert.equal(u.pathname, "/recruit/v2/settings/stages");
    assert.equal(u.searchParams.get("per_page"), "200");
    assert.ok(!u.href.includes("synthetic-token"));
    return new Response(JSON.stringify(page));
  });
  await provider.readStageCatalog("synthetic-token", 1);
  for (const n of [0, 11, 1.5, NaN])
    await assert.rejects(provider.readStageCatalog("synthetic-token", n));
  assert.equal(calls.length, 1);
  const empty = zohoOAuthProvider(config, async () => new Response(null, { status: 204 }));
  assert.deepEqual(await empty.readStageCatalog("synthetic-token", 1), { data: [] });
  const denied = zohoOAuthProvider(
    config,
    async () =>
      new Response(
        JSON.stringify({ code: "OAUTH_SCOPE_MISMATCH", message: "private provider message" }),
        { status: 401 },
      ),
  );
  await assert.rejects(denied.readStageCatalog("synthetic-token", 1), {
    code: "zoho_module_scope_missing",
  });
});

test("application dispositions require exact canonical status and never authorize writes or infer delivery", () => {
  const statuses = stageCatalogPage(page, 1).statuses;
  const evaluate = (advance: string | null, currentStatus = "New", catalog = statuses) =>
    stageEligibility(
      matchStageMappings({ advance, hold: null, decline: null }, catalog),
      currentStatus,
    )[0];
  assert.equal(evaluate(null).nextAction, "mapping_required");
  assert.equal(evaluate("Unknown").nextAction, "mapping_review_required");
  assert.equal(
    evaluate("Qualified", "New", [...statuses, { ...statuses[0], id: "99" }]).nextAction,
    "mapping_review_required",
  );
  assert.equal(evaluate("Qualified").nextAction, "transition_verification_required");
  assert.equal(evaluate("Qualified", "Qualified").nextAction, "no_update_needed");
  assert.match(evaluate("Qualified", "Qualified").explanation, /not a Lexy delivery receipt/);
  for (const current of ["qualified", "Qualified ", "QUALIFIED"])
    assert.equal(evaluate("Qualified", current).nextAction, "transition_verification_required");
  const restricted = evaluate("Offer-Made", "Offer-Made", [
    { id: "90", value: "Offer-Made", label: "Offer made", stageId: "91", stageName: "Offered" },
  ]);
  assert.equal(restricted.nextAction, "separate_human_process");
  for (const r of [
    evaluate(null),
    evaluate("Unknown"),
    evaluate("Qualified"),
    evaluate("Qualified", "Qualified"),
    restricted,
  ])
    assert.equal(r.canWrite, false);
});

function sourceFixture() {
  let active = true,
    changed = false,
    mismatched = false,
    repeated = false,
    driftDuringRead = false;
  const row: ZohoRow = {
    ...actor,
    userId: actor.id,
    revision,
    fingerprint: config.fingerprint,
    accountRef: "account",
    companyName: "Synthetic",
    refreshTokenEnc: "sealed",
    approvedAt: new Date(),
    updatedAt: new Date(),
    flowHash: null,
    browserHash: null,
    flowExpiresAt: null,
  };
  const unused = async (): Promise<never> => {
    throw Error("unexpected store write");
  };
  const store: ZohoStore = {
    get: async () => ({
      ...row,
      revision: changed ? "22222222-2222-4222-8222-222222222222" : revision,
    }),
    begin: unused,
    consume: unused,
    save: unused,
    approve: unused,
    disconnect: unused,
  };
  let requests = 0;
  const source = zohoReviewedImport({
    config,
    store,
    actorLookup: async () => {
      if (!active) throw new CalendarError(403, "denied", "Denied");
      return actor;
    },
    unseal: () =>
      JSON.stringify({
        purpose: "zoho-recruit",
        tenantId: actor.tenantId,
        userId: actor.id,
        accountRef: row.accountRef,
        fingerprint: config.fingerprint,
        token: "synthetic",
      }),
    providerFactory: () => ({
      ...zohoOAuthProvider(config, async () => {
        throw Error("unexpected network");
      }),
      refresh: async () => "synthetic",
      organization: async () => ({ accountRef: "account", companyName: "Synthetic" }),
      readIntakeRecord: async () => ({
        data: [
          {
            id: "100",
            Posting_Title: "Synthetic engineer",
            Job_Description: "Test",
            Job_Opening_Status: "In-progress",
          },
        ],
      }),
      readApplication: async () =>
        mismatched ? { data: [{ ...payload.data[0], Candidate_Name: { id: "999" } }] } : payload,
      readStageCatalog: async (_t, n) => {
        requests++;
        if (driftDuringRead) changed = true;
        return { ...page, info: { page: n, more_records: repeated } };
      },
    }),
  });
  return {
    source,
    setActive: (v: boolean) => {
      active = v;
    },
    setMismatch: () => {
      mismatched = true;
    },
    setRepeated: () => {
      repeated = true;
    },
    setDrift: () => {
      driftDuringRead = true;
    },
    requests: () => requests,
  };
}

test("metadata source enforces employer custody and current authority before and after provider reads", async () => {
  const f = sourceFixture();
  const result = await f.source.stageMetadata(actor, revision, "100", "300", "200");
  assert.equal(result.accountRef, "account");
  assert.equal(result.statuses.length, 2);
  assert.ok(!JSON.stringify(result).includes("privateNotes"));
  f.setActive(false);
  await assert.rejects(result.assertCurrent());
  await assert.rejects(f.source.stageMetadata(actor, revision, "100", "300", "200"));
  const mismatch = sourceFixture();
  mismatch.setMismatch();
  await assert.rejects(mismatch.source.stageMetadata(actor, revision, "100", "300", "200"));
  assert.equal(mismatch.requests(), 0);
  const repeated = sourceFixture();
  repeated.setRepeated();
  await assert.rejects(repeated.source.stageMetadata(actor, revision, "100", "300", "200"));
  assert.equal(repeated.requests(), 2);
  const drift = sourceFixture();
  drift.setDrift();
  await assert.rejects(drift.source.stageMetadata(actor, revision, "100", "300", "200"));
  assert.equal(drift.requests(), 1);
});

test("validation is snapshot-only, rechecks local privacy/revisions and never reports a live transition", async () => {
  let changed = false,
    hidden = false,
    denied = false,
    reads = 0;
  const view = {
    campaignId: "campaign",
    recipientId: "recipient",
    applicationId: "300",
    externalJobId: "100",
    externalCandidateId: "200",
    revision: "a".repeat(64),
    mapping: {
      revision: "b".repeat(64),
      advance: "Qualified",
      hold: null,
      decline: null,
      updatedAt: null,
      updatedBy: null,
    },
    decision: null,
    targetStatus: null,
    ready: false,
    liveEnabled: false,
    reason: "Test",
    history: [],
  };
  const f = sourceFixture();
  const service = zohoStageValidation({
    handoff: {
      ...zohoStageHandoff(),
      detail: async () => {
        if (hidden) throw Error("privacy changed");
        return { ...view, revision: changed ? "c".repeat(64) : view.revision };
      },
    },
    campaignLookup: async () =>
      ({ accountRef: "account", revision }) as Awaited<
        ReturnType<typeof import("./zoho-interview-campaigns").campaignById>
      >,
    source: {
      ...f.source,
      stageMetadata: async (...args) => {
        reads++;
        if (denied) throw new CalendarError(409, "zoho_module_scope_missing", "private");
        return f.source.stageMetadata(...args);
      },
    },
  });
  const input = { expectedRevision: view.revision, confirm: true as const };
  const checked = await service.check(actor, "campaign", "recipient", input);
  assert.equal(checked.identityVerified, true);
  assert.equal(checked.transitionEligibilityVerified, false);
  assert.equal(checked.liveEnabled, false);
  assert.equal(checked.catalogScope, "organization_default");
  assert.equal(checked.mappings[0].result, "matched");
  assert.equal(checked.mappings[0].nextAction, "transition_verification_required");
  assert.equal(checked.mappings[0].canWrite, false);
  assert.equal(checked.mappings[1].nextAction, "mapping_required");
  changed = true;
  await assert.rejects(service.check(actor, "campaign", "recipient", input), {
    code: "zoho_stage_validation_changed",
  });
  assert.equal(reads, 1);
  changed = false;
  hidden = true;
  await assert.rejects(service.check(actor, "campaign", "recipient", input));
  assert.equal(reads, 1);
  hidden = false;
  denied = true;
  await assert.rejects(service.check(actor, "campaign", "recipient", input), {
    code: "zoho_stage_metadata_access_required",
  });
});
