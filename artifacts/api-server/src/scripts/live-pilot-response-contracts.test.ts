import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import ts from "typescript";
import { z } from "zod";

function schema(file: string, name: string): z.ZodType<Record<string, unknown>> {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let declaration: ts.VariableDeclaration | undefined;
  for (const statement of tree.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    declaration = statement.declarationList.declarations.find(
      (node) => node.name.getText(tree) === name,
    );
    if (declaration) break;
  }
  assert.ok(declaration?.initializer);
  // Read the current schemas without importing/executing either live-send script.
  const code = ts.transpileModule(`const parsed = ${declaration.initializer.getText(tree)};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function("z", `${code}; return parsed;`)(z);
}

test("interview receipts require a real session ID and retain optional fields and additional evidence", () => {
  const reply = schema("./live-communications-pilot.ts", "PilotInterviewReply");
  const value = {
    sessionId: "fixture-session",
    emailSent: true,
    reused: false,
    questionCount: 3,
    interviewType: "technical",
    extraEvidence: { approved: true },
  };
  assert.deepEqual(reply.parse(value), value);
  assert.deepEqual(reply.parse({ sessionId: "fixture-session" }), { sessionId: "fixture-session" });
  for (const invalid of [
    null,
    {},
    { sessionId: "" },
    { sessionId: 2 },
    { sessionId: "fixture", emailSent: "true" },
  ])
    assert.equal(reply.safeParse(invalid).success, false);
});

test("sourcing start receipts fail explicitly without a run ID and retain existing evidence", () => {
  const reply = schema("./live-sourcing-pilot.ts", "PilotRunStartReply");
  const value = { runId: "fixture-run", status: "running", usage: { observed: true } };
  assert.deepEqual(reply.parse(value), value);
  for (const invalid of [null, {}, { runId: "" }, { runId: [] }])
    assert.equal(reply.safeParse(invalid).success, false);
});

test("poll and cancellation receipts require run status without stripping progress or events", () => {
  const reply = schema("./live-sourcing-pilot.ts", "PilotRunStateReply");
  for (const status of ["running", "queued", "completed", "failed", "cancelled"]) {
    const value = {
      run: { status, id: "fixture-run", progress: { total: 6 } },
      events: [{ seq: 1 }],
    };
    assert.deepEqual(reply.parse(value), value);
  }
  for (const invalid of [null, {}, { run: null }, { run: {} }, { run: { status: 2 } }])
    assert.equal(reply.safeParse(invalid).success, false);
});
