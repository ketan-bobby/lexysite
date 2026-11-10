import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Exercise current source bodies without importing the DB/provider/AI graph.
// These are offline regression checks, not database-backed acceptance tests.
const source = readFileSync(new URL("./orchestrator.ts", import.meta.url), "utf8");
const ast = ts.createSourceFile("orchestrator.ts", source, ts.ScriptTarget.Latest, true);
function uniqueText(predicate: (node: ts.Node) => boolean): string {
  const matches: string[] = [];
  function visit(node: ts.Node) {
    if (predicate(node)) matches.push(node.getText(ast));
    ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.equal(matches.length, 1, "source target must be unique");
  return matches[0]!;
}
function load<T>(code: string, context: Record<string, unknown>): T {
  const exports = {};
  const compiled = ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText;
  runInNewContext(compiled, { exports, ...context });
  return exports as T;
}
const invitation = uniqueText(
  (n) => ts.isIfStatement(n) && n.expression.getText(ast) === "toEmail",
);
const feeder = uniqueText(
  (n) => ts.isMethodDeclaration(n) && n.name.getText(ast) === "_feedIntelligence",
);
const internalMapper = uniqueText(
  (n) => ts.isCallExpression(n) && n.expression.getText(ast) === "internalScored.map",
);

test("internal sourcing retains canonical IDs without inventing IDs for external profiles", () => {
  const { result } = load<{ result: { candidateId?: string; isInternalCandidate: boolean }[] }>(
    `export const result = ${internalMapper};`,
    {
      internalRes: { candidates: [{ id: "internal-a", candidateId: "canonical-a" }] },
      internalScored: [
        { id: "internal-a", candidateId: "wrong-id", matchScore: 90 },
        { id: "internal-b", candidateId: "canonical-b" },
        { id: "external-c" },
      ],
    },
  );
  assert.equal(result[0]?.candidateId, "canonical-a");
  assert.equal(result[1]?.candidateId, "canonical-b");
  assert.equal(result[2]?.candidateId, undefined);
});

async function invitationCase(employerName: string | null, bound = false) {
  const sent: { text: string; to: string }[] = [];
  const tenantsTable = { id: "tenant-id", name: "tenant-name" };
  const { send } = load<{ send: () => Promise<number> }>(
    `export async function send() { let invitationAccepted = 0; ${invitation}; return invitationAccepted; }`,
    {
      toEmail: "pilot@example.invalid",
      toName: "Test Candidate",
      jobForInterview: { tenantId: "job-tenant", title: "Test Engineer" },
      tenantsTable,
      db: {
        select: (projection: unknown) => {
          assert.deepEqual(JSON.parse(JSON.stringify(projection)), { name: tenantsTable.name });
          return {
            from: (table: unknown) => {
              assert.equal(table, tenantsTable);
              return {
                where: (condition: unknown) => {
                  assert.deepEqual(condition, { column: tenantsTable.id, value: "job-tenant" });
                  return {
                    limit: async () => (employerName === null ? [] : [{ name: employerName }]),
                  };
                },
              };
            },
          };
        },
      },
      eq: (column: unknown, value: unknown) => ({ column, value }),
      process: { env: { PUBLIC_APP_URL: "https://pilot.example.invalid" } },
      session: { id: "test-session" },
      bound,
      planRow: { estimatedDurationMinutes: 12 },
      questionCount: 3,
      plainToHtml: (text: string) => text,
      sendEmail: async (payload: { text: string; to: string }) => {
        sent.push(payload);
        return { ok: true, simulated: true };
      },
      logger: { info() {}, error() {} },
      require: (path: string) => {
        assert.equal(path, "../interview-link-url");
        return {
          interviewRoomUrl: (id: string) =>
            `https://controlled.example.invalid/interviews/${id}/room`,
        };
      },
    },
  );
  assert.equal(await send(), 0, "simulated delivery must not count as a real invitation");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]?.to, "pilot@example.invalid");
  return sent[0]!.text;
}

test("invitation uses only the job-owning employer tenant's name", async () => {
  const text = await invitationCase("  Test Employer  ");
  assert.match(text, /role at Test Employer,/);
  assert.match(text, /The Test Employer Team/);
  assert.match(text, /https:\/\/pilot\.example\.invalid\/interviews\/test-session\/room/);
});

test("missing employer name keeps honest fallback and controlled link routing", async () => {
  const text = await invitationCase(null, true);
  assert.match(text, /role at our company,/);
  assert.match(text, /The Hiring Team/);
  assert.match(text, /https:\/\/controlled\.example\.invalid\/interviews\/test-session\/room/);
});

test("screening enrichment requires a resolved tenant and preserves job-derived scope", async () => {
  for (const tenant of [undefined, "job-tenant"]) {
    const feeds: unknown[][] = [];
    const enrichments: unknown[][] = [];
    const { Feeder } = load<{
      Feeder: new () => {
        _feedIntelligence: (agent: string, input: unknown, output: unknown) => Promise<void>;
        _enrichSimilarHire: (...args: unknown[]) => Promise<void>;
      };
    }>(`export class Feeder { ${feeder} }`, {
      jobsTable: { id: "job-id", tenantId: "tenant-id" },
      eq: () => undefined,
      db: {
        select: () => ({
          from: () => ({
            where: () => ({ limit: async () => (tenant ? [{ tenantId: tenant }] : []) }),
          }),
        }),
      },
      upsertIntelligence: async (...args: unknown[]) => {
        feeds.push(args);
      },
    });
    const instance = new Feeder();
    instance._enrichSimilarHire = async (...args) => {
      enrichments.push(args);
    };
    await instance._feedIntelligence(
      "screening",
      { jobId: "test-job" },
      { screeningResults: [{ candidateId: "test-candidate", score: 75 }] },
    );
    assert.equal(feeds.length, tenant ? 1 : 0);
    assert.deepEqual(enrichments, tenant ? [["job-tenant", "test-job", "test-candidate"]] : []);
  }
});

test("AI-message scope forwards the full caller identity without widening scope", async () => {
  const routeSource = readFileSync(new URL("../../routes/ai-messages.ts", import.meta.url), "utf8");
  const routeAst = ts.createSourceFile("ai-messages.ts", routeSource, ts.ScriptTarget.Latest, true);
  const declaration = routeAst.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "tenantScope",
  );
  assert.ok(declaration);
  for (const role of ["recruiter_admin", "recruiter", "platform_admin"]) {
    const caller = { id: "caller-id", tenantId: "caller-tenant", role };
    const expected = role === "platform_admin" ? null : ["assigned-client"];
    const { tenantScope }: { tenantScope: (user: unknown) => Promise<unknown> } = load<{
      tenantScope: (user: unknown) => Promise<unknown>;
    }>(`export ${declaration.getText(routeAst)}`, {
      getDataScopeTenantIds: async (user: unknown) => {
        assert.equal(user, caller);
        return expected;
      },
    });
    assert.equal(await tenantScope(caller), expected);
  }
});
