import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import ts from "typescript";

// Extract current source expressions; substitute persistence/mail, not logic.
function pick(file: string, predicate: (node: ts.Node, ast: ts.SourceFile) => boolean) {
  const ast = ts.createSourceFile(
    file,
    readFileSync(new URL(file, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  const matches: string[] = [];
  function visit(node: ts.Node) {
    if (predicate(node, ast)) matches.push(node.getText(ast));
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
const campaignRead = pick(
  "./invites.ts",
  (n) => ts.isVariableDeclaration(n) && n.name.getText() === "candidatesRaw",
);
const employerRead = pick(
  "./career-profile.ts",
  (n) => ts.isVariableDeclaration(n) && n.name.getText() === "appliedEmployers",
);
const notification = pick(
  "./hm-share.ts",
  (n, ast) => ts.isIfStatement(n) && n.expression.getText(ast) === "share.createdByUserId",
);
const plain = (value: unknown) => JSON.parse(JSON.stringify(value));

test("campaign projection uses stored fields, retaining response aliases and tenant predicate", async () => {
  const table = {
    id: "id",
    firstName: "firstName",
    lastName: "lastName",
    email: "email",
    currentTitle: "currentTitle",
    currentCompany: "currentCompany",
    tenantId: "tenantId",
  };
  for (const allowed of [null, [], ["allowed-tenant"]]) {
    const { read } = load<{ read: () => Promise<unknown> }>(
      `export async function read() { const ${campaignRead}; return candidatesRaw; }`,
      {
        candidatesTable: table,
        allowedTenantIds: allowed,
        inArray: (column: unknown, values: unknown) => ({ column, values }),
        db: {
          select: (fields: Record<string, unknown>) => {
            assert.ok(Object.values(fields).every((field) => field !== undefined));
            assert.equal(fields.jobTitle, table.currentTitle);
            assert.equal(fields.company, table.currentCompany);
            return {
              from: (selected: unknown) => {
                assert.equal(selected, table);
                return {
                  where: (condition: unknown) => {
                    assert.deepEqual(
                      plain(condition ?? null),
                      allowed === null
                        ? null
                        : {
                            column: "tenantId",
                            values: allowed,
                          },
                    );
                    return {
                      limit: async (limit: number) => {
                        assert.equal(limit, 200);
                        return [{ jobTitle: "Engineer", company: "Employer" }];
                      },
                    };
                  },
                };
              },
            };
          },
        },
      },
    );
    assert.deepEqual(plain(await read()), [{ jobTitle: "Engineer", company: "Employer" }]);
  }
});

test("career research reads employer names through only the candidate's applied job IDs", async () => {
  const jobs = { id: "jobId", tenantId: "jobTenantId" };
  const tenants = { id: "tenantId", name: "employerName" };
  const { read } = load<{ read: () => Promise<unknown> }>(
    `export async function read() { const ${employerRead}; return appliedEmployers; }`,
    {
      jobsTable: jobs,
      tenantsTable: tenants,
      jobIds: ["applied-job"],
      eq: (left: unknown, right: unknown) => ({ left, right }),
      inArray: (column: unknown, values: unknown) => ({ column, values }),
      db: {
        select: (fields: unknown) => {
          assert.deepEqual(plain(fields), { company: "employerName" });
          return {
            from: (table: unknown) => {
              assert.equal(table, jobs);
              return {
                innerJoin: (table: unknown, join: unknown) => {
                  assert.equal(table, tenants);
                  assert.deepEqual(plain(join), { left: "tenantId", right: "jobTenantId" });
                  return {
                    where: async (condition: unknown) => {
                      assert.deepEqual(plain(condition), {
                        column: "jobId",
                        values: ["applied-job"],
                      });
                      return [{ company: "Applied Employer" }];
                    },
                  };
                },
              };
            },
          };
        },
      },
    },
  );
  assert.deepEqual(plain(await read()), [{ company: "Applied Employer" }]);
});

async function notify(name: string | null, failMail = false) {
  const sent: { to: string; text: string; html: string }[] = [];
  const errors: unknown[] = [];
  const usersTable = { id: "userId", name: "userName", email: "userEmail" };
  const { run } = load<{ run: () => Promise<void> }>(
    `export async function run() { ${notification} }`,
    {
      share: {
        id: "test-share",
        createdByUserId: "designated-recruiter",
        tenantId: "test-tenant",
        candidateId: "test-candidate",
        brandSnapshot: {},
      },
      usersTable,
      eq: (column: unknown, value: unknown) => ({ column, value }),
      controlDb: {
        select: (fields: unknown) => {
          assert.deepEqual(plain(fields), { email: "userEmail", name: "userName" });
          return {
            from: (table: unknown) => {
              assert.equal(table, usersTable);
              return {
                where: (condition: unknown) => {
                  assert.deepEqual(plain(condition), {
                    column: "userId",
                    value: "designated-recruiter",
                  });
                  return { limit: async () => [{ name, email: "recruiter@example.invalid" }] };
                },
              };
            },
          };
        },
      },
      escapeHtml: (text: string) => text.replaceAll("<", "&lt;").replaceAll(">", "&gt;"),
      who: "Test Manager",
      candName: "Test Candidate",
      jobTitle: "Test Role",
      label: "Proceed",
      decision: "proceed",
      comment: null,
      subject: "Test decision",
      sendEmail: async (payload: { to: string; text: string; html: string }) => {
        if (failMail) throw new Error("offline test mail failure");
        sent.push(payload);
      },
      logger: { error: (error: unknown) => errors.push(error) },
    },
  );
  await run();
  return { sent, errors };
}

test("HM feedback addresses the creator using the canonical user name, safely escaped", async () => {
  const result = await notify("  <Test> Recruiter  ");
  assert.equal(result.errors.length, 0);
  assert.equal(result.sent[0]?.to, "recruiter@example.invalid");
  assert.match(result.sent[0]!.html, /Hi &lt;Test&gt;,/);
  assert.match(result.sent[0]!.text, /Hi <Test>,/);
});

test("HM feedback keeps missing-name fallback and mail errors non-fatal", async () => {
  for (const name of [null, "   "]) {
    const result = await notify(name);
    assert.match(result.sent[0]!.text, /^Hello,/);
    assert.equal(result.errors.length, 0);
  }
  const failure = await notify("Test Recruiter", true);
  assert.equal(failure.sent.length, 0);
  assert.equal(failure.errors.length, 1);
});
