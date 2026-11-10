import assert from "node:assert/strict";
import { test } from "node:test";
import { observeRequestCost } from "./vendor-cost-observation";
import { bodyReceiptUnits, headerReceiptUnits } from "./vendor-receipts";
import { meteredFetch, type Attempt } from "./vendor-usage";

test("provider receipts are whitelisted; observed PDL credits preserve zero", () => {
  assert.deepEqual(
    headerReceiptUnits(
      "pdl",
      new Headers({
        "x-request-id": "fixture-request-123",
        "x-call-credits-spent": "0",
        "x-totallimit-remaining": "1000",
        authorization: "private-secret",
      }),
    ),
    { provider_request_id: "fixture-request-123", provider_reported_credits: 0 },
  );
  for (const invalid of ["-1", "1.5", "NaN", "9007199254740992"]) {
    assert.deepEqual(
      headerReceiptUnits(
        "pdl",
        new Headers({
          "x-call-credits-spent": invalid,
        }),
      ),
      {},
    );
  }
  assert.deepEqual(
    bodyReceiptUnits("serpapi", {
      search_metadata: { id: "0123456789abcdef01234567", json_endpoint: "https://private.example" },
      profiles: [{ email: "private@example.invalid" }],
    }),
    { provider_request_id: "0123456789abcdef01234567" },
  );
  assert.deepEqual(
    bodyReceiptUnits("serpapi", {
      search_metadata: { id: "https://private.example/?key=secret" },
    }),
    {},
  );
  assert.deepEqual(bodyReceiptUnits("enrichlayer", { id: "candidate-person-id" }), {});
});

test("bound operation keys join receipts to effects without saving request URLs", async () => {
  const rows: Attempt[] = [];
  await meteredFetch(
    "enrichlayer",
    async () => new Response("{}"),
    async (attempt) => {
      rows.push(structuredClone(attempt));
    },
    { operationKey: "native-enrichlayer:fixturehash" },
  )("https://fixture.invalid/profile");
  assert.equal(rows.at(-1)?.units.observed_operation_key, "native-enrichlayer:fixturehash");
  const invalid: Attempt[] = [];
  await meteredFetch(
    "enrichlayer",
    async () => new Response("{}"),
    async (attempt) => {
      invalid.push(structuredClone(attempt));
    },
    { operationKey: "https://private.example/in/person?key=secret" },
  )("https://fixture.invalid/profile");
  assert.equal(invalid.at(-1)?.units.observed_operation_key, undefined);
  assert.ok(!JSON.stringify(invalid).includes("private.example"));
});

const chat = {
  provider: "openai_direct",
  operation: "chat",
  status: "succeeded",
  model: "gpt-4o",
  units: { input_tokens: 1000, cached_input_tokens: 200, output_tokens: 100, reasoning_tokens: 50 },
};
test("public estimates avoid double counting cached and reasoning tokens", () => {
  const cost = observeRequestCost(chat);
  assert.equal(cost.estimatedCostUsd, 0.00325);
  assert.equal(cost.verifiedCostUsd, null);
  assert.equal(cost.costStatus, "public_rate_estimate");
  assert.ok(cost.rateSource);
});

test("unknown or incompatible pricing never becomes zero, a charge or admission authority", () => {
  for (const change of [
    { provider: "openai_proxy" },
    { provider: "azure_openai" },
    { status: "http_error" },
    { model: "gpt-4o-alias" },
    { units: { input_tokens: 1, cached_input_tokens: null, output_tokens: 1 } },
    { units: { input_tokens: 1, cached_input_tokens: 2, output_tokens: 1 } },
  ]) {
    assert.equal(observeRequestCost({ ...chat, ...change }).estimatedCostUsd, null);
  }
  const zero = observeRequestCost({
    ...chat,
    units: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0 },
  });
  assert.equal(zero.estimatedCostUsd, 0);
  assert.equal(zero.verifiedCostUsd, null);
  assert.equal(
    observeRequestCost({
      ...chat,
      operation: "embedding",
      model: "text-embedding-3-small",
      units: { input_tokens: 1000 },
    }).estimatedCostUsd,
    0.00002,
  );
});

test("transport records credits and receipt without retaining returned profiles", async () => {
  const rows: Attempt[] = [];
  let calls = 0;
  const result = await meteredFetch(
    "pdl",
    async () => {
      calls++;
      return new Response(JSON.stringify({ data: [{ email: "private@example.invalid" }] }), {
        headers: {
          "content-type": "application/json",
          "x-request-id": "fixture-pdl",
          "x-call-credits-spent": "3",
        },
      });
    },
    async (attempt) => {
      rows.push(structuredClone(attempt));
    },
  )("https://fixture.invalid/search");
  assert.equal(calls, 1);
  assert.equal(rows.at(-1)?.units.provider_reported_credits, 3);
  assert.equal(rows.at(-1)?.units.provider_request_id, "fixture-pdl");
  assert.equal(rows.at(-1)?.costStatus, "unknown");
  assert.ok(!JSON.stringify(rows).includes("private@example"));
  const original = (await result.json()) as { data: { email: string }[] };
  assert.ok(original.data[0].email); // Caller still receives original response.
});

test("slow accounting receipts do not hold the provider response; late usage updates same attempt", async () => {
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const stream = new ReadableStream<Uint8Array>({
    start(value) {
      controller = value;
    },
  });
  const rows: Attempt[] = [];
  let received!: () => void;
  const late = new Promise<void>((resolve) => {
    received = resolve;
  });
  let calls = 0;
  const started = Date.now();
  const result = await meteredFetch(
    "openai_direct",
    async () => {
      calls++;
      return new Response(stream, {
        headers: { "content-type": "application/json", "x-request-id": "fixture-delayed" },
      });
    },
    async (attempt) => {
      rows.push(structuredClone(attempt));
      if (attempt.units.input_tokens === 10) received();
    },
  )("https://fixture.invalid/chat/completions");
  assert.ok(Date.now() - started < 1500);
  assert.equal(rows.at(-1)?.status, "succeeded");
  controller.enqueue(
    new TextEncoder().encode(
      JSON.stringify({
        usage: { prompt_tokens: 10, completion_tokens: 2 },
      }),
    ),
  );
  controller.close();
  const original = (await result.json()) as { usage: { prompt_tokens: number } };
  assert.equal(original.usage.prompt_tokens, 10);
  await late;
  assert.equal(new Set(rows.map((row) => row.id)).size, 1);
  assert.equal(calls, 1);
});

test("failed accounting persistence does not prevent a provider request or alter its result", async () => {
  let calls = 0;
  const result = await meteredFetch(
    "serpapi",
    async () => {
      calls++;
      return new Response("original");
    },
    async () => {
      throw new Error("fixture accounting failure");
    },
  )("https://fixture.invalid/search");
  assert.equal(calls, 1);
  assert.equal(await result.text(), "original");
});
