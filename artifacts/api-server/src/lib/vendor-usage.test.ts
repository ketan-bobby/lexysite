import { test } from "node:test";
import assert from "node:assert/strict";
import OpenAI from "openai";
import { dbAdmin, pool, vendorUsageAttemptsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { meteredFetch, receiptUnits, vendorUsageScope, type Attempt } from "./vendor-usage";
import { createServer } from "node:http";
import { once } from "node:events";

test("Meet telemetry observes status without cloning private recording metadata", async () => {
  const rows: Attempt[] = [];
  const response = Response.json({
    privateRecordingTitle: "private-fixture-only",
    file: "private-file-id",
  });
  Object.defineProperty(response, "clone", {
    value: () => {
      assert.fail("Meet telemetry must not clone/read a recording response");
    },
  });
  const result = await meteredFetch(
    "google_meet",
    async () => response,
    async (row) => {
      rows.push(row);
    },
  )("https://meet.googleapis.com/v2/conferenceRecords/fixture/recordings");
  assert.equal(result, response);
  assert.equal(response.bodyUsed, false);
  assert.ok(rows.some((row) => row.status === "succeeded" && row.provider === "google_meet"));
  assert.ok(!JSON.stringify(rows).includes("private-fixture-only"));
  assert.ok(!JSON.stringify(rows).includes("private-file-id"));
  assert.ok(rows.every((row) => row.costStatus === "unknown"));
});

test("custom fetch preserves real streamed multipart transcription uploads in Node", async () => {
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    assert.ok(req.headers["content-type"]?.startsWith("multipart/form-data"));
    assert.ok(body.includes("synthetic-audio"));
    assert.ok(body.includes("gpt-4o-transcribe"));
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("synthetic transcription");
  }).listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as { port: number }).port;
    const rows: Attempt[] = [];
    const client = new OpenAI({
      apiKey: "fake-only",
      baseURL: `http://127.0.0.1:${port}`,
      maxRetries: 0,
      fetch: meteredFetch("openai_direct", fetch, async (attempt) => {
        rows.push(structuredClone(attempt));
      }),
    });
    const result = await client.audio.transcriptions.create({
      model: "gpt-4o-transcribe",
      file: new File(["synthetic-audio"], "sample.mp3", { type: "audio/mpeg" }),
      response_format: "text",
    });
    assert.equal(result, "synthetic transcription");
    assert.equal(rows.at(-1)?.status, "succeeded");
    assert.equal(JSON.stringify(rows).includes("synthetic-audio"), false);
  } finally {
    server.close();
  }
});

test("receipts whitelist numbers, preserve zero, and do not invent missing usage", () => {
  assert.deepEqual(receiptUnits({ usage: { prompt_tokens: 0, completion_tokens: 12 } }), {
    input_tokens: 0,
    output_tokens: 12,
    cached_input_tokens: null,
    reasoning_tokens: null,
    audio_seconds: null,
  });
  assert.equal(receiptUnits({ duration: 1.25 }).audio_seconds, 1.25);
  assert.equal(
    receiptUnits({ usage: { input_tokens: -1 }, duration: Infinity }).input_tokens,
    null,
  );
});

test("real SDK retries produce separate attempts, preserve helper result, and exclude PII", async () => {
  const rows: Attempt[] = [];
  let calls = 0;
  const sdk = new OpenAI({
    apiKey: "fake-only",
    maxRetries: 1,
    fetch: meteredFetch(
      "openai_direct",
      async () => {
        calls++;
        return new Response(
          JSON.stringify(
            calls === 1
              ? { error: { message: "private-error-body" } }
              : {
                  choices: [{ message: { role: "assistant", content: "private-answer" } }],
                  usage: { prompt_tokens: 40, completion_tokens: 10 },
                },
          ),
          {
            status: calls === 1 ? 429 : 200,
            headers: { "content-type": "application/json", "retry-after-ms": "1" },
          },
        );
      },
      async (row) => void rows.push(row),
    ),
  });
  const response = await vendorUsageScope.run(
    { tenantId: "fixture-tenant", area: "interview_unclassified" },
    () =>
      sdk.chat.completions.create({
        model: "gpt-4o",
        messages: [{ role: "user", content: "private-prompt" }],
      }),
  );
  assert.equal(response.choices[0].message.content, "private-answer");
  assert.equal(calls, 2);
  assert.deepEqual(
    rows.map((row) => row.status),
    ["started", "http_error", "started", "succeeded"],
  );
  assert.deepEqual(
    rows.map((row) => row.retryIndex),
    [0, 0, 1, 1],
  );
  assert.equal(rows[3].units.input_tokens, 40);
  assert.equal(rows[3].model, "gpt-4o");
  assert.equal(rows[3].costStatus, "unknown");
  for (const secret of ["private-prompt", "private-answer", "private-error-body", "fake-only"]) {
    assert.ok(!JSON.stringify(rows).includes(secret));
  }
});

test("transport failure remains uncertain and throws the identical error", async () => {
  const rows: Attempt[] = [];
  const error = new Error("private-network-error");
  const transport = meteredFetch(
    "openai_proxy",
    async () => {
      throw error;
    },
    async (row) => void rows.push(row),
  );
  await assert.rejects(transport("https://fixture.invalid/chat/completions"), (e) => e === error);
  assert.equal(rows[1].status, "uncertain");
  assert.equal(rows[1].costStatus, "unknown");
  assert.ok(!JSON.stringify(rows).includes(error.message));
});

test("TTS observes Unicode input characters without storing speech text", async () => {
  const rows: Attempt[] = [];
  const transport = meteredFetch(
    "openai_direct",
    async () => new Response(new Uint8Array([1, 2]), { headers: { "content-type": "audio/mpeg" } }),
    async (row) => void rows.push(row),
  );
  await transport("https://fixture.invalid/audio/speech", {
    body: JSON.stringify({ model: "tts-1", input: "A😀" }),
  });
  assert.equal(rows[1].units.input_characters, 2);
  assert.equal(rows[1].tenantId, null);
  assert.equal(rows[1].area, "unattributed");
  assert.equal(rows[1].costStatus, "unknown");
});

test("workflow usage carries tenant and bound step without leaking to later calls", async () => {
  const rows: Attempt[] = [];
  const transport = meteredFetch(
    "openai_proxy",
    async () =>
      new Response(JSON.stringify({ usage: { prompt_tokens: 12, completion_tokens: 4 } }), {
        headers: { "content-type": "application/json" },
      }),
    async (row) => void rows.push(row),
  );
  await vendorUsageScope.run(
    { tenantId: "fixture-tenant", area: "workflow:fixture-workflow:screening" },
    () => transport("https://fixture.invalid/chat/completions"),
  );
  await transport("https://fixture.invalid/chat/completions");
  const complete = rows.filter((r) => r.status === "succeeded");
  assert.equal(complete[0].tenantId, "fixture-tenant");
  assert.equal(complete[0].area, "workflow:fixture-workflow:screening");
  assert.equal(complete[0].units.input_tokens, 12);
  assert.equal(complete[0].costStatus, "unknown");
  assert.equal(complete[1].tenantId, null);
  assert.equal(complete[1].area, "unattributed");
  assert.equal(vendorUsageScope.getStore(), undefined);
});

test("same-tenant concurrent workflows retain distinct usage labels", async () => {
  const rows: Attempt[] = [];
  const transport = meteredFetch(
    "openai_direct",
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    async (row) => void rows.push(row),
  );
  await Promise.all(
    ["first", "second"].map((id) =>
      vendorUsageScope.run(
        { tenantId: "fixture-tenant", area: `workflow:${id}:screening` },
        async () => {
          await new Promise((resolve) => setImmediate(resolve));
          await transport("https://fixture.invalid/chat/completions");
        },
      ),
    ),
  );
  const complete = rows.filter((r) => r.status === "succeeded");
  assert.equal(complete.length, 2);
  assert.deepEqual(
    new Set(complete.map((r) => r.area)),
    new Set(["workflow:first:screening", "workflow:second:screening"]),
  );
  assert.ok(complete.every((r) => r.tenantId === "fixture-tenant" && r.costStatus === "unknown"));
  assert.equal(vendorUsageScope.getStore(), undefined);
});

test("concurrent usage scopes stay isolated", async () => {
  const rows: Attempt[] = [];
  const transport = meteredFetch(
    "openai_direct",
    async () => new Response("{}", { headers: { "content-type": "application/json" } }),
    async (row) => void rows.push(row),
  );
  await Promise.all(
    ["tenant-a", "tenant-b"].map((tenantId) =>
      vendorUsageScope.run({ tenantId, area: "interview_unclassified" }, async () => {
        await new Promise((r) => setImmediate(r));
        await transport("https://fixture.invalid/audio/transcriptions");
      }),
    ),
  );
  for (const id of new Set(rows.map((row) => row.id))) {
    assert.equal(new Set(rows.filter((row) => row.id === id).map((row) => row.tenantId)).size, 1);
  }
});

test(
  "slow telemetry does not block transport; late insert/update remain ordered",
  { timeout: 3000 },
  async () => {
    const rows: Attempt[] = [];
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = meteredFetch(
      "openai_direct",
      async () => new Response("{}", { headers: { "content-type": "application/json" } }),
      async (row) => {
        await gate;
        rows.push(row);
      },
    );
    try {
      const response = await transport("https://fixture.invalid/chat/completions");
      assert.equal(response.status, 200);
      assert.equal(rows.length, 0);
    } finally {
      release();
    }
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(
      rows.map((row) => row.status),
      ["started", "succeeded"],
    );
  },
);

test("workflow labels upgrade the original telemetry schema without weakening security", async () => {
  const { randomUUID } = await import("node:crypto");
  const { readFile } = await import("node:fs/promises");
  const schema = `usage_upgrade_${randomUUID().replaceAll("-", "")}`;
  const connection = await pool.connect();
  const migration = async (name: string) =>
    (await readFile(new URL(`../../../../lib/db/drizzle/${name}`, import.meta.url), "utf8"))
      .replace(/^BEGIN;\s*$/gm, "")
      .replace(/^COMMIT;\s*$/gm, "");
  try {
    await connection.query("BEGIN");
    await connection.query(`CREATE SCHEMA "${schema}"`);
    await connection.query(`SET LOCAL search_path = "${schema}"`);
    await connection.query(await migration("0072_vendor_usage_attempts.sql"));
    await connection.query(
      "INSERT INTO vendor_usage_attempts (id,area,provider,operation,status) VALUES ('legacy','unattributed','fixture','chat','started')",
    );
    await connection.query("SAVEPOINT old_constraint");
    await assert.rejects(
      connection.query(
        "INSERT INTO vendor_usage_attempts (id,area,provider,operation,status) VALUES ('scope','workflow:fixture:engagement','fixture','chat','started')",
      ),
      (error: any) => error.code === "23514",
    );
    await connection.query("ROLLBACK TO SAVEPOINT old_constraint");
    await connection.query(await migration("0074_workflow_vendor_usage_labels.sql"));
    await connection.query(
      "INSERT INTO vendor_usage_attempts (id,area,provider,operation,status) VALUES ('scope','workflow:fixture:engagement','fixture','chat','started')",
    );
    await connection.query("SAVEPOINT assessment_only");
    await assert.rejects(
      connection.query(
        "INSERT INTO vendor_usage_attempts (id,area,provider,operation,status) VALUES ('native','workflow:sourcing-reservation-fixture:discovery','fixture','search','started')",
      ),
      (error: any) => error.code === "23514",
    );
    await connection.query("ROLLBACK TO SAVEPOINT assessment_only");
    await connection.query(await migration("0075_native_sourcing_usage_labels.sql"));
    for (const phase of ["discovery", "enrichment"]) {
      await connection.query(
        "INSERT INTO vendor_usage_attempts (id,area,provider,operation,status,units) VALUES ($1,$2,'fixture','search','started',$3)",
        [
          `native_${phase}`,
          `workflow:sourcing-reservation-fixture:${phase}`,
          JSON.stringify({
            observed_operation_key: "native-fixture",
            provider_request_id: "fixture-id",
          }),
        ],
      );
    }
    assert.equal(
      (
        await connection.query(
          "SELECT count(*)::int AS n FROM vendor_usage_attempts WHERE cost_status='unknown'",
        )
      ).rows[0].n,
      4,
    );
    const {
      rows: [security],
    } = await connection.query(
      "SELECT relrowsecurity,relforcerowsecurity,(SELECT count(*)::int FROM pg_policy WHERE polrelid=c.oid) AS policies FROM pg_class c WHERE c.oid=to_regclass($1)",
      [`${schema}.vendor_usage_attempts`],
    );
    assert.deepEqual(security, { relrowsecurity: true, relforcerowsecurity: true, policies: 0 });
  } finally {
    await connection.query("ROLLBACK");
    connection.release();
  }
});

test("fake HTTP receipts persist across transport instances; application role cannot read them", async () => {
  const { randomUUID } = await import("node:crypto");
  const id = randomUUID();
  // Use a fixture-only model to collect IDs for deterministic cleanup, never
  // perform any HTTP request or use a candidate/employer's real activity.
  const fixtureModel = `fixture-${id}`;
  try {
    const observe = () =>
      meteredFetch(
        "openai_direct",
        async () =>
          new Response(JSON.stringify({ usage: { prompt_tokens: 23, completion_tokens: 4 } }), {
            headers: { "content-type": "application/json", "x-request-id": `receipt-${id}` },
          }),
        undefined,
        { operationKey: `native-fixture:${id}` },
      )("https://fixture.invalid/chat/completions", {
        body: JSON.stringify({ model: fixtureModel }),
      });
    await observe();
    await vendorUsageScope.run(
      { tenantId: `meter-fixture-${id}`, area: `workflow:sourcing-reservation-${id}:enrichment` },
      observe,
    );
    const rows = await dbAdmin
      .select()
      .from(vendorUsageAttemptsTable)
      .where(eq(vendorUsageAttemptsTable.model, fixtureModel));
    assert.equal(rows.length, 2);
    for (const row of rows) {
      assert.equal(row.status, "succeeded");
      assert.equal(row.units.input_tokens, 23);
      assert.equal(row.units.provider_request_id, `receipt-${id}`);
      assert.equal(row.units.observed_operation_key, `native-fixture:${id}`);
      assert.equal(row.costStatus, "unknown");
    }
    const bound = rows.find((row) => row.area === `workflow:sourcing-reservation-${id}:enrichment`);
    assert.equal(bound?.tenantId, `meter-fixture-${id}`);
    assert.ok(rows.some((row) => row.area === "unattributed" && row.tenantId === null));
    await assert.rejects(
      pool.query(
        "INSERT INTO vendor_usage_attempts (id,area,provider,operation,status,model) VALUES ($1,$2,'fixture','chat','started',$3)",
        [`invalid-${id}`, `workflow:${id}:unapproved-action`, fixtureModel],
      ),
      (error: any) => error.code === "23514",
    );

    const connection = await pool.connect();
    try {
      await connection.query("BEGIN");
      await connection.query("SET LOCAL ROLE lexy_app");
      try {
        const result = await connection.query(
          "SELECT id FROM vendor_usage_attempts WHERE model=$1",
          [fixtureModel],
        );
        assert.equal(result.rows.length, 0);
      } catch (error: any) {
        assert.equal(error.code, "42501", "Only access-denial errors are acceptable");
      }
    } finally {
      await connection.query("ROLLBACK");
      connection.release();
    }
  } finally {
    await dbAdmin
      .delete(vendorUsageAttemptsTable)
      .where(eq(vendorUsageAttemptsTable.model, fixtureModel));
  }
});
