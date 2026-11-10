import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { Readable } from "node:stream";
import OpenAI from "openai";
import { SESv2Client, SendEmailCommand } from "@aws-sdk/client-sesv2";
import ts from "typescript";
import { meteredFetch, vendorUsageScope, type Attempt } from "./vendor-usage";
import { meterSesHandler } from "./vendor-usage-ses";
import { PUBLIC_RATE_REFERENCE } from "./vendor-rate-reference";
import { observeWebsocketStt } from "./vendor-usage-websocket";

test("WebSocket sessions preserve results/errors without invented HTTP receipts or duration", async () => {
  const rows: Attempt[] = [];
  const sink = async (row: Attempt) => {
    rows.push(row);
  };
  assert.equal(
    await observeWebsocketStt(640, async () => "private-transcript", sink),
    "private-transcript",
  );
  const error = new Error("private-signed-url-error");
  await assert.rejects(
    observeWebsocketStt(
      640,
      async () => {
        throw error;
      },
      sink,
    ),
    (caught) => caught === error,
  );
  assert.deepEqual(
    rows.map((row) => row.status),
    ["started", "succeeded", "started", "uncertain"],
  );
  assert.ok(rows.every((row) => row.httpStatus === null && row.units.audio_seconds === null));
  assert.ok(rows.every((row) => row.units.observed_websocket_sessions === 1));
  assert.ok(rows.every((row) => row.units.observed_api_requests === undefined));
  assert.ok(!JSON.stringify(rows).includes("private-"));
});

test("embedding SDK preserves vectors and records reported input tokens, never text/vectors", async () => {
  const rows: Attempt[] = [];
  const client = new OpenAI({
    apiKey: "fake-only",
    fetch: meteredFetch(
      "openai_direct",
      async () =>
        new Response(
          JSON.stringify({
            data: [{ embedding: [0.125, 0.25], index: 0, object: "embedding" }],
            usage: { prompt_tokens: 37, total_tokens: 37 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      async (row) => {
        rows.push(row);
      },
    ),
  });
  const result = await client.embeddings.create({
    model: "text-embedding-3-small",
    input: "private-profile-text",
    encoding_format: "float",
  });
  assert.deepEqual(result.data[0].embedding, [0.125, 0.25]);
  assert.equal(rows[1].operation, "embedding");
  assert.equal(rows[1].units.input_tokens, 37);
  for (const forbidden of ["private-profile-text", "0.125", "fake-only"]) {
    assert.ok(!JSON.stringify(rows).includes(forbidden));
  }
});

test("speech fallbacks preserve responses, record only reported seconds, and keep model/bytes", async () => {
  const rows: Attempt[] = [];
  const fixtures = [
    [
      "deepgram",
      "/v1/listen?model=nova-2",
      "nova-2",
      {
        metadata: { duration: 1.75, request_id: "private-id" },
        results: { transcript: "private-transcript" },
      },
      1.75,
    ],
    ["elevenlabs", "/v1/speech-to-text", "scribe_v1", { text: "private-transcript" }, null],
    [
      "sarvam",
      "/speech-to-text",
      "saarika:v2.5",
      { transcript: "private-transcript", request_id: "private-id" },
      null,
    ],
  ] as const;
  for (const [provider, path, model, body, seconds] of fixtures) {
    const response = new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
    const fetcher = meteredFetch(
      provider,
      async () => response,
      async (row) => {
        rows.push(row);
      },
      { model, audioBytes: 999 },
    );
    assert.equal(await fetcher(`https://fixture.invalid${path}`), response);
    assert.deepEqual(await response.json(), body);
    const row = rows.at(-1)!;
    assert.equal(row.operation, "stt");
    assert.equal(row.model, model);
    assert.equal(row.units.audio_seconds, seconds);
    assert.equal(row.units.audio_bytes, 999);
    assert.equal(row.costStatus, "unknown");
  }
  assert.ok(!JSON.stringify(rows).includes("private-"));
});

test("sourcing fan-out, avatar polls and voice requests are separate observations, not credit debits", async () => {
  const rows: Attempt[] = [];
  const fixtures = [
    ["serpapi", "/search.json?api_key=private-key&q=private-query", "search"],
    ["pdl", "/v5/person/search", "search"],
    ["enrichlayer", "/api/v2/profile?url=private-profile", "enrichment"],
    ["heygen", "/v2/video/generate", "video_generate"],
    ["heygen", "/v1/video_status.get?video_id=private-video", "video_status"],
    ["heygen", "/v1/video_status.get?video_id=private-video", "video_status"],
    ["heygen", "/v1/talking_photo", "video_upload"],
    ["heygen", "/v2/voices", "voice_list"],
  ] as const;
  for (const [provider, path, operation] of fixtures) {
    const fetcher = meteredFetch(
      provider,
      async () =>
        new Response(
          JSON.stringify({
            data: { video_id: "private-video", duration: 30 },
            duration: 30,
            organic_results: [{ email: "private-address", name: "private-name" }],
          }),
          { headers: { "content-type": "application/json" } },
        ),
      async (row) => {
        rows.push(row);
      },
    );
    await fetcher(`https://fixture.invalid${path}`);
    assert.equal(rows.at(-1)?.operation, operation);
    assert.equal(rows.at(-1)?.units.observed_api_requests, 1);
    assert.equal(
      rows.at(-1)?.units.audio_seconds,
      null,
      "Video polls must not become audio duration",
    );
  }
  assert.equal(new Set(rows.map((row) => row.id)).size, fixtures.length);
  assert.ok(rows.every((row) => row.costStatus === "unknown"));
  assert.ok(!JSON.stringify(rows).includes("private-"));
});

test("real SES SDK retries are observed at native transport, preserving output and excluding mail/IDs", async () => {
  const rows: Attempt[] = [];
  let calls = 0;
  const handler = {
    handle: async () => {
      calls++;
      return {
        response: {
          statusCode: calls === 1 ? 500 : 200,
          headers: { "content-type": "application/json" },
          body: Readable.from([
            JSON.stringify(
              calls === 1
                ? { message: "private-server-error" }
                : { MessageId: "private-vendor-id" },
            ),
          ]),
        },
      };
    },
  };
  meterSesHandler(handler, async (row) => {
    rows.push(row);
  });
  const client = new SESv2Client({
    region: "us-east-1",
    maxAttempts: 2,
    requestHandler: handler,
    credentials: { accessKeyId: "fake-access", secretAccessKey: "fake-secret" },
  });
  try {
    const output = await vendorUsageScope.run(
      { tenantId: "fixture-email", area: "unattributed" },
      () =>
        client.send(
          new SendEmailCommand({
            FromEmailAddress: "private-sender@example.invalid",
            Destination: {
              ToAddresses: ["private-to@example.invalid"],
              CcAddresses: ["private-cc@example.invalid"],
            },
            Content: {
              Simple: {
                Subject: { Data: "private-subject" },
                Body: { Text: { Data: "private-body" } },
              },
            },
          }),
        ),
    );
    assert.equal(output.MessageId, "private-vendor-id");
    assert.equal(calls, 2);
    assert.deepEqual(
      rows.map((row) => row.status),
      ["started", "http_error", "started", "succeeded"],
    );
    assert.deepEqual(
      rows.map((row) => row.retryIndex),
      [0, 0, 1, 1],
    );
    assert.ok(rows.every((row) => row.tenantId === "fixture-email"));
    assert.ok(rows.every((row) => row.units.observed_email_recipients === 2));
    assert.ok(rows.every((row) => row.operation === "email" && row.costStatus === "unknown"));
    for (const forbidden of ["private-", "fake-access", "fake-secret"]) {
      assert.ok(!JSON.stringify(rows).includes(forbidden));
    }
  } finally {
    client.destroy();
  }
});

test("Graph accepted mail preserves response and observes counts, not recipient identities or delivery", async () => {
  const rows: Attempt[] = [];
  const response = new Response(null, { status: 202 });
  const fetcher = meteredFetch(
    "ms_graph",
    async () => response,
    async (row) => {
      rows.push(row);
    },
  );
  assert.equal(
    await fetcher("https://fixture.invalid/v1.0/me/sendMail", {
      body: JSON.stringify({
        message: {
          subject: "private-subject",
          body: { content: "private-body" },
          toRecipients: [{ emailAddress: { address: "private-to@example.invalid" } }],
        },
      }),
    }),
    response,
  );
  assert.equal(rows[1].httpStatus, 202);
  assert.equal(rows[1].operation, "email");
  assert.equal(rows[1].units.observed_email_recipients, 1);
  assert.equal(rows[1].costStatus, "unknown");
  assert.ok(!JSON.stringify(rows).includes("private-"));
});

function assertSesClientsMetered(source: string) {
  const ast = ts.createSourceFile("email.ts", source, ts.ScriptTarget.Latest, true);
  let clients = 0;
  const visit = (node: ts.Node) => {
    if (ts.isNewExpression(node) && node.expression.getText(ast) === "SESv2Client") {
      clients++;
      const declaration = node.parent;
      assert.ok(ts.isVariableDeclaration(declaration) && ts.isIdentifier(declaration.name));
      const statement = declaration.parent.parent;
      assert.ok(ts.isVariableStatement(statement) && ts.isBlock(statement.parent));
      const next = statement.parent.statements[statement.parent.statements.indexOf(statement) + 1];
      // Bind to the constructed transport, not a historical cache-variable name.
      // Requiring the next statement also catches metering after a return/cache.
      assert.ok(
        next &&
          ts.isExpressionStatement(next) &&
          ts.isCallExpression(next.expression) &&
          next.expression.expression.getText(ast) === "meterSesHandler" &&
          next.expression.arguments[0]?.getText(ast) ===
            `${declaration.name.text}.config.requestHandler`,
        `${declaration.name.text}: meter the new SES handler before caching or returning it`,
      );
    }
    ts.forEachChild(node, visit);
  };
  visit(ast);
  assert.ok(clients > 0, "SES transport inventory must not silently disappear");
}

test("SES factory guard binds each new transport and rejects absent, wrong or late metering", () => {
  const source = `
    function normal() {
      const primary = new SESv2Client({});
      meterSesHandler(primary.config.requestHandler);
      return primary;
    }
    function offer() {
      const singleAttempt = new SESv2Client({ maxAttempts: 1 });
      meterSesHandler(singleAttempt.config.requestHandler);
      return singleAttempt;
    }
  `;
  assert.doesNotThrow(() => assertSesClientsMetered(source));
  assert.throws(() =>
    assertSesClientsMetered(source.replace("meterSesHandler(primary.config.requestHandler);", "")),
  );
  assert.throws(() =>
    assertSesClientsMetered(
      source.replace("primary.config.requestHandler", "cached.config.requestHandler"),
    ),
  );
  assert.throws(() =>
    assertSesClientsMetered(
      source.replace("meterSesHandler(singleAttempt.config.requestHandler);", ""),
    ),
  );
  assert.throws(() =>
    assertSesClientsMetered(
      source.replace(
        "meterSesHandler(primary.config.requestHandler);",
        "return primary; meterSesHandler(primary.config.requestHandler);",
      ),
    ),
  );
  assert.throws(() => assertSesClientsMetered("export const unrelated = true;"));
});

test("all production OpenAI constructors stay metered; known native/fetch provider paths retain wiring", () => {
  const root = new URL("../", import.meta.url);
  const files: URL[] = [];
  const walk = (dir: URL) => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = new URL(`${item.name}${item.isDirectory() ? "/" : ""}`, dir);
      if (item.isDirectory()) walk(path);
      else if (item.name.endsWith(".ts") && !item.name.endsWith(".test.ts")) files.push(path);
    }
  };
  walk(root);
  const inventory: Record<string, number> = {};
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    const ast = ts.createSourceFile(file.pathname, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node) => {
      if (
        ts.isNewExpression(node) &&
        ["OpenAI", "AzureOpenAI"].includes(node.expression.getText(ast))
      ) {
        const key = `${file.pathname.slice(root.pathname.length)}:${node.expression.getText(ast)}`;
        inventory[key] = (inventory[key] ?? 0) + 1;
        const options = node.arguments?.[0];
        assert.ok(options && ts.isObjectLiteralExpression(options), file.pathname);
        const fetchOption = options.properties.find((p) => p.name?.getText(ast) === "fetch");
        assert.ok(fetchOption?.getText(ast).includes("meteredFetch"), file.pathname);
      }
      ts.forEachChild(node, visit);
    };
    visit(ast);
  }
  // An arbitrary minimum masked factory drift. Enumerate the real factories,
  // while retaining the per-constructor metered-fetch assertion above.
  assert.deepEqual(
    inventory,
    {
      "lib/ai.ts:OpenAI": 2,
      "lib/ai.ts:AzureOpenAI": 1,
      "lib/anti-ghost-engine.ts:OpenAI": 1,
      "lib/interview-speech.ts:OpenAI": 1,
      "lib/market-intelligence-ask.ts:OpenAI": 1,
      "lib/outreach-engine.ts:OpenAI": 1,
      "lib/transcribe.ts:OpenAI": 1,
      "routes/career-profile.ts:OpenAI": 1,
      "routes/interviews.ts:OpenAI": 1,
    },
    "Deliberate SDK factory changes must update this metering inventory",
  );

  function hasCall(
    file: string,
    name: string,
    matches: (node: ts.CallExpression, ast: ts.SourceFile) => boolean,
  ) {
    const url = new URL(file, root);
    const ast = ts.createSourceFile(
      url.pathname,
      readFileSync(url, "utf8"),
      ts.ScriptTarget.Latest,
      true,
    );
    let found = false;
    function visit(node: ts.Node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === name && matches(node, ast))
        found = true;
      ts.forEachChild(node, visit);
    }
    visit(ast);
    return found;
  }
  assert.ok(
    hasCall(
      "lib/transcribe.ts",
      "observeWebsocketStt",
      (node, ast) => node.arguments[0]?.getText(ast) === "pcm.length",
    ),
  );
  for (const [file, providers] of [
    ["lib/transcribe.ts", ["elevenlabs", "deepgram", "sarvam"]],
    ["lib/external-sourcing.ts", ["serpapi", "pdl", "enrichlayer"]],
    ["lib/heygen.ts", ["heygen"]],
    ["lib/graph-mail.ts", ["ms_graph"]],
  ] as const) {
    for (const provider of providers)
      assert.ok(
        hasCall(file, "meteredFetch", (node) => {
          const argument = node.arguments[0];
          if (!argument || !ts.isStringLiteral(argument) || argument.text !== provider)
            return false;
          return (
            provider !== "heygen" ||
            (ts.isBinaryExpression(node.parent) &&
              node.parent.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
              node.parent.left.getText() === "opts.fetchImpl")
          );
        }),
        `${file}: ${provider} must retain its metered transport`,
      );
  }
  assertSesClientsMetered(readFileSync(new URL("lib/email.ts", root), "utf8"));
});

test("public rate evidence remains explicit reference-only and cannot authorize spend", () => {
  assert.equal(PUBLIC_RATE_REFERENCE.accountVerified, false);
  assert.equal(PUBLIC_RATE_REFERENCE.status, "public_reference_only");
  assert.deepEqual(
    PUBLIC_RATE_REFERENCE.rates.map((rate) => rate.input),
    [2.5, 0.15, 0.02],
  );
  const report = readFileSync(
    new URL("../scripts/vendor-usage-report.ts", import.meta.url),
    "utf8",
  );
  assert.ok(report.includes("NULL::numeric AS verified_cost_usd"));
  assert.ok(report.includes("embedding_attempts_missing_usage"));
  for (const file of ["sourcing-controls.ts", "sourcing-meter.ts"]) {
    assert.ok(
      !readFileSync(new URL(file, import.meta.url), "utf8").includes("vendor-rate-reference"),
    );
  }
});
