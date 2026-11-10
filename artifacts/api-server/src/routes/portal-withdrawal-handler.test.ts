import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Execute the actual route body, without importing its unrelated SDK/DB graph.
// Only auth resolution, persistence and best-effort side effects are substituted.
const source = readFileSync(new URL("./career-profile.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("career-profile.ts", source, ts.ScriptTarget.Latest, true);
let handlerSource: string | undefined;
function findHandler(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(ast) === "router.post" &&
    node.arguments[0] &&
    ts.isStringLiteral(node.arguments[0]) &&
    node.arguments[0].text === "/portal/applications/:applicationId/withdraw"
  ) {
    assert.equal(handlerSource, undefined, "withdrawal route must be unique");
    handlerSource = node.arguments[1]?.getText(ast);
  }
  ts.forEachChild(node, findHandler);
}
findHandler(ast);
assert.ok(handlerSource, "withdrawal handler must exist");
const compiled = ts.transpileModule(`export const handler = ${handlerSource};`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

async function runCase(
  options: {
    caller?: string | null;
    stage?: string;
    missing?: boolean;
    failWrite?: boolean;
    reason?: unknown;
  } = {},
) {
  const app = {
    id: "test-application",
    tenantId: "test-tenant",
    candidateId: "test-candidate",
    jobId: "test-job",
    stage: options.stage ?? "applied",
  };
  const mutations: Record<string, unknown>[] = [];
  const effects: string[] = [];
  const errors: unknown[] = [];
  let status = 200;
  let body: Record<string, unknown> | undefined;
  const table = { id: "id", candidateId: "candidateId" };
  const exports: { handler?: (req: unknown, res: unknown) => Promise<unknown> } = {};
  runInNewContext(compiled, {
    exports,
    getCandidateId: async () => (options.caller === undefined ? app.candidateId : options.caller),
    applicationsTable: table,
    eq: (column: keyof typeof app, value: unknown) => ({ column, value }),
    and: (...conditions: unknown[]) => conditions,
    db: {
      select: () => ({
        from: (selected: unknown) => {
          assert.equal(selected, table);
          return {
            where: (conditions: { column: keyof typeof app; value: unknown }[]) => ({
              limit: async () =>
                !options.missing && conditions.every((c) => app[c.column] === c.value)
                  ? [{ ...app }]
                  : [],
            }),
          };
        },
      }),
    },
    changeCandidateStage: async (input: Record<string, unknown>) => {
      if (options.failWrite) throw new Error("test-only stage write failure");
      mutations.push(JSON.parse(JSON.stringify(input)));
      const from = app.stage;
      app.stage = String(input.to);
      return { eventId: "test-event", from, to: app.stage, changed: true };
    },
    require: (path: string) => {
      if (path === "../lib/governance/decision-enforcement.js") {
        return {
          applyHumanDecision: async () => {
            effects.push("decision");
          },
        };
      }
      if (path === "../lib/record-terminal-outcome.js") {
        return {
          recordTerminalOutcome: async () => {
            effects.push("outcome");
          },
        };
      }
      throw new Error(`Unexpected side-effect import: ${path}`);
    },
    logger: { warn: (err: unknown) => errors.push(err), error: (err: unknown) => errors.push(err) },
  });
  assert.ok(exports.handler);
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: Record<string, unknown>) {
      body = JSON.parse(JSON.stringify(value));
      return this;
    },
  };
  await exports.handler(
    { params: { applicationId: app.id }, body: { reason: options.reason } },
    res,
  );
  // Allow the existing non-blocking audit/outcome callbacks to settle.
  await new Promise((resolve) => setImmediate(resolve));
  return { status, body, app, mutations, effects, errors };
}

test("successful self-withdrawal returns the stage result rather than a post-save failure", async () => {
  const result = await runCase({ reason: "Test withdrawal" });
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { ok: true, stage: "withdrawn" });
  assert.equal(result.app.stage, "withdrawn");
  assert.deepEqual(result.mutations, [
    {
      tenantId: "test-tenant",
      candidateId: "test-candidate",
      jobId: "test-job",
      to: "withdrawn",
      from: "applied",
      actor: { type: "candidate", role: "candidate", id: "test-candidate" },
      source: "candidate_portal",
      reason: "Test withdrawal",
      applicationId: "test-application",
    },
  ]);
  assert.deepEqual(result.effects.sort(), ["decision", "outcome"]);
  assert.deepEqual(result.errors, []);
});

test("unauthenticated, foreign and missing applications cannot be withdrawn", async () => {
  for (const [options, status] of [
    [{ caller: null }, 401],
    [{ caller: "foreign-candidate" }, 404],
    [{ missing: true }, 404],
  ] as const) {
    const result = await runCase(options);
    assert.equal(result.status, status);
    assert.equal(result.app.stage, "applied");
    assert.deepEqual(result.mutations, []);
    assert.deepEqual(result.effects, []);
  }
});

test("terminal-stage withdrawal restrictions remain unchanged", async () => {
  for (const stage of ["withdrawn", "rejected", "hired"]) {
    const result = await runCase({ stage });
    assert.equal(result.status, 409);
    assert.equal(result.app.stage, stage);
    assert.deepEqual(result.mutations, []);
    assert.deepEqual(result.effects, []);
  }
});

test("failed stage writes never return success or trigger follow-up evidence", async () => {
  const result = await runCase({ failWrite: true });
  assert.equal(result.status, 500);
  assert.equal(result.app.stage, "applied");
  assert.deepEqual(result.mutations, []);
  assert.deepEqual(result.effects, []);
});
