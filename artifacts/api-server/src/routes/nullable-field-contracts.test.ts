import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import express, { type RequestHandler } from "express";
import ts from "typescript";
import { eq, inArray, sql, type SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  candidatesTable,
  jobsTable,
  tenantsTable,
  jobPipelinesTable,
  candidateCareerProfilesTable,
  applicationsTable,
  sourcedCandidatesTable,
  sourceEnum,
  communicationEventsTable,
  communicationTypeEnum,
} from "@workspace/db";

// Run the current controller/helper source with disposable in-memory query
// doubles. No live database, provider, email, billing or candidate writes.
test("client snapshot leaves unsupported structured fields null and excludes private fallback values", () => {
  const text = readFileSync(new URL("./candidates.ts", import.meta.url), "utf8");
  const tree = ts.createSourceFile("candidates.ts", text, ts.ScriptTarget.Latest, true);
  let statement: string | undefined;
  function visit(node: ts.Node) {
    if (
      ts.isTaggedTemplateExpression(node) &&
      node.tag.getText(tree) === "sql" &&
      node.getText(tree).includes("INSERT INTO talent_pool_submissions")
    )
      statement = node.getText(tree);
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(statement, "the current client snapshot INSERT must be exercised");
  const output = ts.transpileModule(`const snapshot = ${statement};`, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const candidate = {
    firstName: "Fixture",
    lastName: "Only",
    email: "fixture@example.test",
    location: "Fixture location",
    resumeUrl: "fixture-resume",
    linkedinUrl: "fixture-link",
    // Deliberately present unexpected private values to prove the INSERT
    // never adopts them as an implicit fallback if a future join adds fields.
    experienceLevel: "PRIVATE_EXPERIENCE",
    workStyle: "PRIVATE_WORK_STYLE",
    languages: ["PRIVATE_LANGUAGE"],
  };
  const snapshot = new Function(
    "sql",
    "candidate",
    "candidateId",
    "clientTenantId",
    "caller",
    "jobPostingId",
    "crypto",
    `${output}; return snapshot;`,
  )(sql, candidate, "fixture-candidate", "fixture-client", { id: "fixture-staff" }, null, {
    randomUUID: () => "fixture-submission",
  });
  const query = new PgDialect().sqlToQuery(snapshot);
  assert.match(query.sql, /experience_level,\s*work_style,\s*languages/);
  assert.match(query.sql, /\$\d+,\s*NULL,\s*NULL,\s*NULL,/);
  assert.ok(query.params.includes(candidate.resumeUrl));
  assert.ok(query.params.includes(candidate.linkedinUrl));
  for (const value of [
    candidate.experienceLevel,
    candidate.workStyle,
    JSON.stringify(candidate.languages),
  ])
    assert.ok(
      !query.params.includes(value),
      "private fallback values must not enter a client snapshot",
    );
});

function load<T>(file: string, name: string, bindings: Record<string, unknown>, route?: string): T {
  const text = readFileSync(new URL(file, import.meta.url), "utf8");
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  let source: string | undefined;
  function visit(node: ts.Node) {
    if (!route && ts.isFunctionDeclaration(node) && node.name?.text === name)
      source = node.getText(tree);
    if (
      route &&
      ts.isCallExpression(node) &&
      node.expression.getText(tree) === "router.post" &&
      ts.isStringLiteral(node.arguments[0]!) &&
      node.arguments[0].text === route
    ) {
      source = `const ${name} = ${node.arguments.at(-1)!.getText(tree)};`;
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  assert.ok(source, `${name} must exist in the current source`);
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${output}; return ${name};`)(
    ...Object.values(bindings),
  ) as T;
}

type Row = Record<string, unknown>;
test("candidate links normalize only the provider enum and retain original source and fee attribution input", async () => {
  for (const source of ["cv_upload", "resume_import", ...sourceEnum.enumValues, null]) {
    const writes: Array<{ table: unknown; values: Row }> = [];
    let via: string | undefined;
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            limit: async () => (table === jobsTable ? [{ tenantId: "fixture-job-tenant" }] : []),
          }),
        }),
      }),
      insert: (table: unknown) => ({
        values: (values: Row) => {
          writes.push({ table, values });
          return { returning: async () => [{ id: "fixture-app" }] };
        },
      }),
    };
    const link = load<
      (candidate: Row, job: string, tenant: string, source: string | null) => Promise<number | null>
    >("./candidates.ts", "linkCandidateToJob", {
      db,
      eq,
      candidatesTable,
      jobsTable,
      applicationsTable,
      sourcedCandidatesTable,
      sourceEnum,
      and: (...conditions: SQL[]) => sql.join(conditions, sql` AND `),
      scoreCandidateForJob: async (_job: string, _candidate: Row, tenant: string) => {
        assert.equal(tenant, "fixture-job-tenant");
        return { score: 72, reason: "fixture-only" };
      },
      recruiterLinkOrigin: async (input: { via: string }) => {
        via = input.via;
        return {};
      },
      logCandidateEvent: async () => undefined,
    });
    assert.equal(
      await link(
        { id: "fixture-candidate", firstName: "Fixture" },
        "fixture-job",
        "fixture-tenant",
        source,
      ),
      72,
    );
    const stored = writes.find((write) => write.table === sourcedCandidatesTable)?.values;
    assert.ok(stored);
    assert.equal(
      stored.source,
      sourceEnum.enumValues.find((value) => value === source) ?? "manual",
    );
    assert.equal((stored.rawData as Row).source, source ?? "manual");
    assert.equal(via, source === "cv_upload" ? "cv_upload" : "manual_link");
    assert.equal(writes.filter((write) => write.table === applicationsTable).length, 1);
  }
});

test("successful manual candidate email uses a supported sent communication type without another dispatch", async () => {
  const writes: Row[] = [];
  let sends = 0;
  const candidate = {
    id: "fixture-candidate",
    tenantId: "fixture-tenant",
    email: "fixture@example.test",
    firstName: "Fixture",
  };
  const handler = load<RequestHandler>(
    "./candidates.ts",
    "manualMessage",
    {
      db: {
        select: () => ({ from: () => ({ where: () => ({ limit: async () => [candidate] }) }) }),
        insert: (table: unknown) => ({
          values: async (values: Row) => {
            assert.equal(table, communicationEventsTable);
            writes.push(values);
          },
        }),
      },
      candidatesTable,
      communicationEventsTable,
      eq,
      getCallerUser: async () => ({
        id: "fixture-user",
        name: "Fixture staff",
        role: "platform_admin",
      }),
      sendEmail: async (input: Row) => {
        sends++;
        assert.equal(input.senderUserId, "fixture-user");
        assert.equal(input.useRecruiterMailbox, true);
        return { ok: true };
      },
      plainToHtml: (text: string) => text,
      logger: {
        error: () => assert.fail("valid enum must not fail the event write"),
        warn: () => undefined,
      },
    },
    "/candidates/:candidateId/message",
  );
  const app = express();
  app.use(express.json());
  app.post("/candidates/:candidateId/message", handler);
  const server = app.listen(0, "127.0.0.1");
  try {
    await new Promise<void>((resolve) => server.on("listening", resolve));
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const response = await fetch(
      `http://127.0.0.1:${address.port}/candidates/fixture-candidate/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subject: "Fixture subject", body: "Fixture body" }),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(sends, 1);
    assert.equal(writes.length, 1);
    assert.ok(communicationTypeEnum.enumValues.some((value) => value === writes[0]?.type));
    assert.equal(writes[0]?.status, "sent");
    assert.equal(writes[0]?.body, "Fixture body");
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

function database(rows: Map<unknown, Row[]>) {
  const reads: Array<{ table: unknown; params: unknown[] }> = [];
  const writes: Array<{ table: unknown; values: Row; kind: string }> = [];
  const dialect = new PgDialect();
  const db = {
    select() {
      return {
        from(table: unknown) {
          return {
            where(condition: SQL) {
              reads.push({ table, params: dialect.sqlToQuery(condition).params });
              const result = rows.get(table) ?? [];
              return {
                limit: async () => result,
                then: Promise.resolve(result).then.bind(Promise.resolve(result)),
              };
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values: async (values: Row) => {
          writes.push({ table, values, kind: "insert" });
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Row) {
          writes.push({ table, values, kind: "update" });
          return {
            where: (_condition: SQL) => ({
              returning: async () => [{ ...rows.get(table)?.[0], ...values }],
            }),
          };
        },
      };
    },
  };
  return { db, reads, writes };
}

test("first pipeline save retains its stage and selected interview settings", async () => {
  const fixture = database(new Map());
  const save = load<(jobId: string, tenantId: string, patch: Row) => Promise<void>>(
    "./agents.ts",
    "upsertPipelineRow",
    { db: fixture.db, eq, jobPipelinesTable },
  );
  await save("isolated-job", "isolated-tenant", {
    status: "running",
    currentStage: "sourcing",
    interviewTypes: ["technical"],
    interviewDirection: { technical: { focusDirective: "fixture" } },
  });
  assert.equal(fixture.writes[0]?.values.currentStage, "sourcing");
  assert.equal(fixture.writes[0]?.values.status, "running");
  assert.equal(fixture.writes[0]?.values.tenantId, "isolated-tenant");
  assert.deepEqual(fixture.writes[0]?.values.interviewTypes, ["technical"]);
  assert.deepEqual(fixture.writes[0]?.values.interviewDirection, {
    technical: { focusDirective: "fixture" },
  });
});

test("pipeline creation defaults to idle/null and existing stages can be cleared", async () => {
  const empty = database(new Map());
  const save = load<(jobId: string, tenantId: string, patch: Row) => Promise<void>>(
    "./agents.ts",
    "upsertPipelineRow",
    { db: empty.db, eq, jobPipelinesTable },
  );
  await save("job", "tenant", {});
  assert.equal(empty.writes[0]?.values.currentStage, null);
  assert.equal(empty.writes[0]?.values.status, "idle");
  const existing = database(new Map([[jobPipelinesTable, [{ id: "existing" }]]]));
  const update = load<typeof save>("./agents.ts", "upsertPipelineRow", {
    db: existing.db,
    eq,
    jobPipelinesTable,
  });
  await update("job", "tenant", { status: "completed", currentStage: null });
  assert.equal(existing.writes[0]?.kind, "update");
  assert.equal(existing.writes[0]?.values.currentStage, null);
});

type Fee = { candidateId: string | null; jobId: string | null; tenantId: string; amount: number };
function feeLookup() {
  const fixture = database(
    new Map<unknown, Row[]>([
      [candidatesTable, [{ id: "candidate", firstName: "Fixture", lastName: "Candidate" }]],
      [jobsTable, [{ id: "job", title: "Fixture Role" }]],
      [tenantsTable, [{ id: "tenant", name: "Fixture Employer" }]],
    ]),
  );
  const enrich = load<
    (
      items: Fee[],
    ) => Promise<Array<Fee & { candidateName: string; jobTitle: string; tenantName: string }>>
  >("./fee-ledger.ts", "enrich", {
    db: fixture.db,
    inArray,
    candidatesTable,
    jobsTable,
    tenantsTable,
  });
  return { fixture, enrich };
}

test("non-hire fee entries skip candidate/job queries and retain their values", async () => {
  const { fixture, enrich } = feeLookup();
  const items = [{ candidateId: null, jobId: null, tenantId: "tenant", amount: -25 }];
  assert.deepEqual(await enrich(items), [
    { ...items[0], candidateName: "Unknown", jobTitle: "Unknown", tenantName: "Fixture Employer" },
  ]);
  assert.deepEqual(
    fixture.reads.map((r) => r.table),
    [tenantsTable],
  );
});

test("mixed fee entries query only real IDs and preserve missing-reference fallbacks", async () => {
  const { fixture, enrich } = feeLookup();
  const result = await enrich([
    { candidateId: null, jobId: null, tenantId: "tenant", amount: 0 },
    { candidateId: "candidate", jobId: "job", tenantId: "tenant", amount: 10 },
    { candidateId: "gone", jobId: "gone", tenantId: "tenant", amount: 20 },
  ]);
  assert.equal(result[1]?.candidateName, "Fixture Candidate");
  assert.equal(result[1]?.jobTitle, "Fixture Role");
  assert.equal(result[2]?.candidateName, "Unknown");
  assert.equal(result[2]?.jobTitle, "Unknown");
  assert.ok(fixture.reads.every((r) => r.params.every((p) => p !== null)));
  assert.deepEqual(
    result.map((r) => r.amount),
    [0, 10, 20],
  );
});

test("empty fee lists require no queries", async () => {
  const { fixture, enrich } = feeLookup();
  assert.deepEqual(await enrich([]), []);
  assert.equal(fixture.reads.length, 0);
});

for (const resumeUrl of ["/fixture-resume", null]) {
  test(`career recomputation checks résumé presence on the canonical candidate (${resumeUrl ? "present" : "absent"})`, async () => {
    const profile = {
      baselineInterviewCompleted: true,
      currentTitle: "Fixture Role",
      careerGoal3yr: "Fixture goal",
      careerGoal5yr: "Fixture vision",
      preferredRoles: ["Fixture Role"],
      strengthAreas: ["Fixture skill"],
      yearsExperience: null,
    };
    const fixture = database(
      new Map<unknown, Row[]>([
        [candidateCareerProfilesTable, [profile]],
        [candidatesTable, [{ resumeUrl }]],
      ]),
    );
    const logger = { warn() {}, info() {}, error() {} };
    const validateMergedProfile = load<(merged: Row, id: string, hasResume: boolean) => string[]>(
      "./career-profile.ts",
      "validateMergedProfile",
      { logger },
    );
    const handler = load<RequestHandler>(
      "./career-profile.ts",
      "handler",
      {
        db: fixture.db,
        eq,
        candidateCareerProfilesTable,
        candidatesTable,
        logger,
        getCandidateId: async () => "self-only-fixture",
        mergeProfileData: (current: Row) => current,
        validateMergedProfile,
        computeProfileCompleteness: () => 50,
      },
      "/portal/career-profile/recompute",
    );
    const app = express();
    app.post("/recompute", handler);
    const server = app.listen(0, "127.0.0.1");
    try {
      await new Promise<void>((resolve) => server.once("listening", resolve));
      const address = server.address();
      assert.ok(address && typeof address !== "string");
      const response = await fetch(`http://127.0.0.1:${address.port}/recompute`, {
        method: "POST",
      });
      assert.equal(response.status, 200);
      const body: unknown = await response.json();
      assert.ok(body && typeof body === "object" && "missingFields" in body);
      assert.deepEqual(body.missingFields, resumeUrl ? ["yearsExperience"] : []);
      assert.deepEqual(
        fixture.reads.filter((r) => r.table === candidatesTable).map((r) => r.params),
        [["self-only-fixture"]],
      );
      assert.equal(fixture.writes.length, 1);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((err) => (err ? reject(err) : resolve())),
      );
    }
  });
}
