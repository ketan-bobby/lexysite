import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { meteredFetch, type Attempt } from "./vendor-usage";
import { withUsageActivity, requestUsageActivity } from "./vendor-usage-context";
import {
  aggregateEconomics,
  economicsEvidenceSchema,
  billingRoot,
  type EconomicsAttempt,
} from "./usage-economics";

const from = new Date("2026-10-01T00:00:00Z"),
  to = new Date("2026-11-01T00:00:00Z");
const tree = [
  { id: "root", parentId: null },
  { id: "child", parentId: "root" },
  { id: "sibling", parentId: "root" },
  { id: "foreign", parentId: null },
];
const row = (
  id: string,
  tenantId = "child",
  units: EconomicsAttempt["units"] = {},
): EconomicsAttempt => ({
  id,
  tenantId,
  createdAt: new Date("2026-10-10T00:00:00Z"),
  area: "activity:matching",
  provider: "openai_direct",
  operation: "chat",
  model: "gpt-4o",
  retryIndex: 0,
  status: "succeeded",
  units: {
    input_tokens: 100,
    cached_input_tokens: 20,
    output_tokens: 30,
    reasoning_tokens: 5,
    billing_root_id: tenantId === "foreign" ? "foreign" : "root",
    billing_country: "US",
    billing_plan: "enterprise",
    account_ref: "fake-account",
    ...units,
  },
});
const report = (
  rows: EconomicsAttempt[],
  allowedTenantIds: Set<string> | null = null,
  evidence?: unknown,
) =>
  aggregateEconomics(rows, tree, {
    from,
    to,
    allowedTenantIds,
    evidence: evidence === undefined ? undefined : economicsEvidenceSchema.parse(evidence),
  });
const tariff = (unit: string, amountMicros = 100) => ({
  id: unit,
  provider: "openai_direct",
  accountRef: "fake-account",
  model: "gpt-4o",
  operation: "chat",
  unit,
  amountMicros,
  perUnits: 1,
  currency: "USD",
  from: from.toISOString(),
  to: to.toISOString(),
  evidenceRef: "fake-invoice",
  verifiedOn: from.toISOString(),
});

test("fake SDK retry and network failure remain independent unknown exposures, never zero", async () => {
  const attempts = new Map<string, Attempt>();
  let calls = 0;
  const client = new OpenAI({
    apiKey: "fake-only",
    maxRetries: 1,
    fetch: meteredFetch(
      "openai_direct",
      async () => {
        calls++;
        return new Response(
          JSON.stringify(
            calls === 1
              ? { error: { message: "private-error" } }
              : {
                  model: "gpt-4o-2024-08-06",
                  choices: [{ message: { content: "private-answer" } }],
                  usage: {
                    prompt_tokens: 100,
                    completion_tokens: 30,
                    prompt_tokens_details: { cached_tokens: 20 },
                  },
                },
          ),
          {
            status: calls === 1 ? 429 : 200,
            headers: { "content-type": "application/json", "retry-after-ms": "1" },
          },
        );
      },
      async (attempt) => {
        attempts.set(attempt.id, structuredClone(attempt));
      },
    ),
  });
  await withUsageActivity("child", "matching", () =>
    client.chat.completions.create({
      model: "gpt-4o",
      messages: [{ role: "user", content: "private-prompt" }],
    }),
  );
  const failing = meteredFetch(
    "openai_direct",
    async () => {
      throw new Error("private-provider-error");
    },
    async (attempt) => {
      attempts.set(attempt.id, structuredClone(attempt));
    },
  );
  await assert.rejects(
    withUsageActivity("child", "screening", () =>
      failing("https://fixture.invalid/chat/completions"),
    ),
    /private-provider-error/,
  );
  const snapshots = [...attempts.values()];
  assert.deepEqual(
    snapshots.map((attempt) => attempt.status),
    ["http_error", "succeeded", "uncertain"],
  );
  assert.equal(snapshots[1].units.returned_model, "gpt-4o-2024-08-06");
  assert.equal(snapshots[1].model, "gpt-4o");
  assert.deepEqual(
    snapshots.slice(0, 2).map((attempt) => attempt.retryIndex),
    [0, 1],
  );
  assert.equal(JSON.stringify(snapshots).includes("private-"), false);
  const result = report(
    snapshots.map((a) => ({ ...a, createdAt: new Date("2026-10-10T00:00:00Z") })),
  );
  assert.equal(result.billingRootTotals[0].attempts, 3);
  assert.equal(result.billingRootTotals[0].unknownAmountAttempts, 3);
  assert.equal(result.billingRootTotals[0].failedOrAmbiguous, 2);
  assert.deepEqual(result.billingRootTotals[0].accountVerifiedTariffCalculation, {});
});

test("child roots roll up once and leaf scope never includes foreign tenants or siblings", () => {
  const rows = [row("a"), row("b", "sibling"), row("foreign-private", "foreign")];
  const all = report(rows);
  assert.equal(all.billingRootTotals.find((r) => r.billingRoot === "root")?.attempts, 2);
  const scoped = report(rows, new Set(["child"]));
  assert.equal(scoped.rows.length, 1);
  assert.equal(scoped.billingRootTotals[0].attempts, 1);
  assert.equal(JSON.stringify(scoped).includes("foreign"), false);
  assert.equal(JSON.stringify(scoped).includes("sibling"), false);
  assert.equal(report(rows, new Set()).rows.length, 0);
  assert.equal(
    report(
      [row("null", undefined, {})].map((r) => ({ ...r, tenantId: null })),
      new Set(["child"]),
    ).rows.length,
    0,
  );
  assert.equal(billingRoot("a", new Map([["a", { id: "a", parentId: "a" }]])), null);
});

test("start/final duplicate rows and duplicate provider receipts cannot multiply units or tariffs", () => {
  const a = row("one", "child", { provider_request_id: "fake-receipt" });
  const result = report([a, a, { ...a, id: "second-observation" }], null, {
    tariffs: [
      tariff("uncached_input_tokens"),
      tariff("cached_input_tokens", 20),
      tariff("output_tokens", 300),
    ],
  });
  const r = result.rows[0];
  assert.equal(r.attempts, 2);
  assert.equal(r.duplicateReceipts, 1);
  assert.equal(r.observedUnits.input_tokens, 100);
  assert.equal(r.observedBillableUnits.uncached_input_tokens, 80);
  assert.equal(r.observedBillableUnits.output_tokens, 30); // reasoning isn't additive
  assert.deepEqual(r.accountVerifiedTariffCalculation.USD, {
    numeratorMicros: "17400",
    denominator: "1",
  });
  assert.equal(r.unknownAmountAttempts, 1);
  assert.equal(result.verifiedInvoiceCost, null);
});

test("missing cached units, wrong account, expired or conflicting rates stay unknown", () => {
  assert.equal(
    report([row("missing", "child", { cached_input_tokens: null })]).rows[0].unknownAmountAttempts,
    1,
  );
  for (const rates of [
    [{ ...tariff("output_tokens"), accountRef: "another-account" }],
    [{ ...tariff("output_tokens"), to: "2026-10-02T00:00:00Z" }],
    [tariff("output_tokens"), { ...tariff("output_tokens"), id: "conflict" }],
  ]) {
    const result = report([row("a")], null, { tariffs: rates });
    assert.deepEqual(result.rows[0].accountVerifiedTariffCalculation, {});
    assert.equal(result.rows[0].unknownAmountAttempts, 1);
  }
  const legacy = report([row("legacy", "child", { billing_plan: null, billing_country: null })]);
  assert.equal(legacy.rows[0].plan, null);
  assert.equal(legacy.rows[0].country, null);
});

test("processed speech/video duration is not billed duration and status polls are not renders", async () => {
  const attempts: EconomicsAttempt[] = [];
  const fetcher = meteredFetch(
    "heygen",
    async () =>
      new Response(
        JSON.stringify({
          data: { video_id: "fake-video", duration: 9.5, usage: { billed_credits: 2.5 } },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    async (a) => {
      if (a.status !== "started")
        attempts.push({ ...a, createdAt: new Date("2026-10-10T00:00:00Z") });
    },
  );
  await fetcher("https://fixture.invalid/v2/video/generate");
  await fetcher("https://fixture.invalid/v1/video_status");
  await fetcher("https://fixture.invalid/v1/video_status");
  const result = report(attempts);
  assert.equal(
    result.rows.find((r) => r.operation === "video_generate")?.observedBillableUnits
      .provider_reported_credits,
    2.5,
  );
  assert.deepEqual(
    result.rows.find((r) => r.operation === "video_status")?.observedBillableUnits,
    {},
  );
  const speech = report([
    { ...row("speech", "child", { audio_seconds: 30.2, input_characters: 100 }), operation: "stt" },
  ]);
  assert.deepEqual(speech.rows[0].observedBillableUnits, {});
  assert.equal(speech.rows[0].unknownAmountAttempts, 1);
});

test("allocation uses exact fractions, keeps the full denominator and excludes tariff-covered commitments", () => {
  const allocation = {
    id: "support-allocation",
    sourceRef: "fake-invoice-line",
    evidenceRef: "fake-bill",
    category: "direct_support",
    currency: "USD",
    totalMicros: 100,
    basis: "support_minutes",
    from: from.toISOString(),
    to: to.toISOString(),
    shares: [
      { tenantId: "child", basisUnits: 1 },
      { tenantId: "foreign", basisUnits: 2 },
    ],
    treatment: "incremental",
  };
  const scoped = report([], new Set(["child"]), { allocations: [allocation] });
  assert.equal(scoped.allocations.length, 1);
  assert.deepEqual(scoped.allocations[0].amount, { numeratorMicros: "100", denominator: "3" });
  assert.equal(JSON.stringify(scoped.allocations).includes("foreign"), false);
  const excluded = report([], null, {
    allocations: [{ ...allocation, treatment: "already_in_tariff" }],
  });
  assert.ok(
    excluded.allocations.every((r) => r.amount === null && r.status === "excluded_double_count"),
  );
  assert.throws(() =>
    report([], null, { allocations: [allocation, { ...allocation, id: "second" }] }),
  );
  assert.throws(() =>
    report([], null, { allocations: [{ ...allocation, rawTranscript: "private" }] }),
  );
  const zero = report([], null, { allocations: [{ ...allocation, totalMicros: 0 }] });
  assert.deepEqual(zero.allocations[0].amount, { numeratorMicros: "0", denominator: "1" });
});

test("nested and concurrent private development scopes are isolated and contain no candidate identity", async () => {
  const { vendorUsageScope } = await import("./vendor-usage");
  const values = await Promise.all(
    ["child", "foreign"].map((tenant) =>
      withUsageActivity(tenant, "development_private", async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return vendorUsageScope.getStore();
      }),
    ),
  );
  assert.deepEqual(
    values.map((s) => s?.tenantId),
    ["child", "foreign"],
  );
  await vendorUsageScope.run({ tenantId: "child", area: "workflow:fake:screening" }, async () => {
    withUsageActivity("child", "matching", () =>
      assert.equal(vendorUsageScope.getStore()?.area, "workflow:fake:screening"),
    );
    withUsageActivity("foreign", "matching", () =>
      assert.equal(vendorUsageScope.getStore()?.tenantId, "foreign"),
    );
  });
  assert.equal(vendorUsageScope.getStore(), undefined);
  assert.equal(requestUsageActivity("/learning/assessment", true), "development_private");
});

test("audio token components are separate billable units, not added to total input twice", async () => {
  const attempts: EconomicsAttempt[] = [];
  const fetcher = meteredFetch(
    "openai_direct",
    async () =>
      new Response(
        JSON.stringify({
          usage: {
            input_tokens: 100,
            output_tokens: 10,
            input_token_details: { audio_tokens: 80, text_tokens: 20 },
          },
        }),
        { headers: { "content-type": "application/json" } },
      ),
    async (a) => {
      if (a.status !== "started")
        attempts.push({ ...a, createdAt: new Date("2026-10-10T00:00:00Z") });
    },
    { accountRef: "fake-account", model: "gpt-4o" },
  );
  await withUsageActivity("child", "interview", () =>
    fetcher("https://fixture.invalid/audio/transcriptions"),
  );
  const rates = ["input_audio_tokens", "input_text_tokens", "output_tokens"].map((name) => ({
    ...tariff(name),
    operation: "stt",
  }));
  const result = report(attempts, null, { tariffs: rates });
  assert.deepEqual(result.rows[0].observedBillableUnits, {
    input_audio_tokens: 80,
    input_text_tokens: 20,
    output_tokens: 10,
  });
  assert.deepEqual(result.rows[0].accountVerifiedTariffCalculation.USD, {
    numeratorMicros: "11000",
    denominator: "1",
  });
  assert.equal(result.rows[0].unknownAmountAttempts, 0);
});
