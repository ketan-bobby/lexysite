import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

function source(name: string) {
  return ts.createSourceFile(
    name,
    readFileSync(new URL(`./${name}.ts`, import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
}
function compile(text: string, bindings: Record<string, unknown>, returnName: string) {
  const js = ts.transpileModule(text.replace(/^export\s+/, ""), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 },
  }).outputText;
  return new Function(...Object.keys(bindings), `${js};return ${returnName};`)(
    ...Object.values(bindings),
  );
}
const logger = {
  info(..._args: unknown[]) {},
  warn(..._args: unknown[]) {},
  error(..._args: unknown[]) {},
};
const noop = () => null;
test("current startup retains default-on status check-ins and the explicit opt-out", () => {
  const file = ts.createSourceFile(
    "index.ts",
    readFileSync(new URL("../index.ts", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let branch: ts.IfStatement | undefined;
  function visit(node: ts.Node) {
    if (ts.isIfStatement(node) && node.expression.getText(file).includes("STATUS_CHECKIN_ENABLED"))
      branch = node;
    else ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(branch);
  for (const [value, expected] of [
    [undefined, 1],
    ["true", 1],
    ["false", 0],
  ] as const) {
    let started = 0;
    const run: () => void = compile(
      `function run(){${branch.getText(file)}}`,
      {
        process: { env: { STATUS_CHECKIN_ENABLED: value } },
        logger,
        startLinkedInProfileMonitor: () => {
          started++;
        },
      },
      "run",
    );
    run();
    assert.equal(started, expected);
  }
});
test("current LinkedIn monitor uses reserved mail and truthful accepted/held counters without provider lookup", async () => {
  const file = source("linkedin-profile-monitor");
  const fn = file.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "runLinkedInProfileMonitor",
  );
  assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.name);
  for (const result of [
    { ok: true },
    { ok: true, simulated: true },
    { ok: true, suppressed: true },
    { ok: false, reason: "cooldown" },
    { ok: false, reason: "review_required", reviewRequired: true },
  ]) {
    const candidates = {},
      events = {},
      tenants = {};
    let sends = 0;
    const candidate = {
      id: "fixture",
      tenantId: "owner",
      pool: "tenant",
      firstName: "Synthetic",
      lastName: "Fixture",
      email: "fixture@example.invalid",
      currentTitle: "Engineer",
      currentCompany: "Fixture",
      updatedAt: new Date(Date.now() - 200 * 86400000),
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            const rows =
              table === candidates
                ? [candidate]
                : table === tenants
                  ? [{ id: "owner", name: "Fixture", primaryColor: "#000" }]
                  : [];
            return {
              groupBy: async () => rows,
              then: (resolve: (value: unknown[]) => unknown) => resolve(rows),
            };
          },
        }),
      }),
    };
    const run: () => Promise<{ emailsSent: number; skipped: number; errors: number }> = compile(
      fn.getText(file),
      {
        db,
        candidatesTable: candidates,
        communicationEventsTable: events,
        tenantsTable: tenants,
        eq: noop,
        and: noop,
        inArray: noop,
        isNotNull: noop,
        sql: noop,
        compliantCandidatePredicate: noop,
        logger,
        STALE_THRESHOLD_DAYS: 180,
        ENGAGEMENT_COOLDOWN_DAYS: 30,
        process: { env: {} },
        _lastResult: null,
        tenantBrand: () => ({ name: "Fixture" }),
        LEXY_BRAND: { name: "Lexy" },
        buildCheckInEmail: () => ({ subject: "Fixture", html: "Fixture" }),
        fetchLinkedInViaEnrichLayer: () => assert.fail("No provider lookup allowed"),
        sendCadencedCommunication: async (input: Record<string, unknown>) => {
          sends++;
          assert.equal(input.kind, "status_checkin");
          assert.equal(input.intervalDays, 30);
          assert.equal(input.ownerTenantId, "owner");
          assert.equal(input.htmlOnly, true);
          return result;
        },
      },
      fn.name.text,
    );
    const output = await run();
    assert.equal(sends, 1);
    assert.equal(output.emailsSent, result.ok && !result.simulated && !result.suppressed ? 1 : 0);
    assert.equal(output.errors, result.reviewRequired ? 1 : 0);
  }
});
test("weekly digest sends only through reservation; simulations/holds do not update cooldown or create bell notifications", async () => {
  const file = source("weekly-digest-scheduler");
  const fn = file.statements.find(
    (n) => ts.isFunctionDeclaration(n) && n.name?.text === "runWeeklyDigest",
  );
  assert.ok(fn && ts.isFunctionDeclaration(fn) && fn.body);
  const recoveryIndex = fn.body.statements.findIndex(
    (n) => ts.isTryStatement(n) && n.getText(file).includes("await recoverWeeklyDigestRecaps()"),
  );
  const selectionIndex = fn.body.statements.findIndex(
    (n) =>
      ts.isVariableStatement(n) &&
      n.declarationList.declarations.some((d) => d.name.getText(file) === "platformCandidates"),
  );
  assert.ok(
    recoveryIndex >= 0 && recoveryIndex < selectionIndex,
    "Recaps must recover even when all candidates are in the email cooldown",
  );
  const loop = fn.body.statements.find(ts.isForOfStatement);
  assert.ok(loop && ts.isBlock(loop.statement));
  const statements = loop.statement.statements;
  const index = statements.findIndex(
    (n) =>
      ts.isVariableStatement(n) &&
      n.declarationList.declarations.some((d) => d.name.getText(file) === "result"),
  );
  assert.ok(index >= 0);
  const text = `async function run(){let sent=0,skipped=0;${statements
    .slice(index)
    .map((n) => n.getText(file))
    .join("\n")};return {sent,skipped};}`;
  for (const stampFailure of [false, true]) {
    for (const result of [
      { ok: true },
      { ok: true, simulated: true },
      { ok: true, suppressed: true },
      { ok: false, reason: "review_required" },
    ]) {
      let stamps = 0,
        notifications = 0,
        sends = 0;
      const db = {
        update: () => ({
          set: () => ({
            where: async () => {
              stamps++;
              if (stampFailure) throw Error("Private SQL payload");
            },
          }),
        }),
        insert: () => ({
          values: async () => {
            notifications++;
          },
        }),
      };
      const run: () => Promise<{ sent: number; skipped: number }> = compile(
        text,
        {
          db,
          candidatesTable: {},
          candidateNotificationsTable: {},
          eq: noop,
          and: noop,
          isNull: noop,
          logger,
          MIN_DAYS_BETWEEN_DIGESTS: 6,
          periodEnd: new Date("2026-11-10T00:00:00Z"),
          persistWeeklyDigestRecap: async () => {
            notifications++;
            return true;
          },
          cand: {
            id: "fixture",
            tenantId: "owner",
            pool: "platform",
            email: "fixture@example.invalid",
          },
          payload: {
            firstName: "Synthetic",
            newAchievements: [],
            mocksCompleted7d: 0,
            recruiterViews7d: 0,
            roleOpens7d: 0,
          },
          recruiterViews7d: 0,
          mocksCompleted7d: 0,
          roleOpens7d: 0,
          subject: "Fixture",
          html: "Fixture",
          sendCadencedCommunication: async (input: Record<string, unknown>) => {
            sends++;
            assert.equal(input.kind, "weekly_digest");
            assert.equal(input.intervalDays, 6);
            assert.equal(input.body, "Candidate-owned weekly digest");
            return { ...result, operationId: "synthetic-operation" };
          },
        },
        "run",
      );
      const output = await run(),
        accepted = result.ok && !result.simulated && !result.suppressed;
      assert.equal(sends, 1);
      assert.equal(output.sent, accepted ? 1 : 0);
      assert.equal(stamps, accepted ? 1 : 0);
      assert.equal(notifications, accepted ? 1 : 0);
      assert.equal(output.skipped, accepted ? 0 : 1);
    }
  }
});
test("post-hire pulses retain their atomic claim and use a single attempt without calling a claim or simulation delivery", async () => {
  const file = source("post-hire-pulse-scheduler");
  const tick = file.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === "tick");
  assert.ok(tick && ts.isFunctionDeclaration(tick));
  const pulses = file.statements.find(
    (n) =>
      ts.isVariableStatement(n) &&
      n.declarationList.declarations.some((d) => d.name.getText(file) === "PULSES_LATEST_FIRST"),
  );
  assert.ok(pulses);
  const specs = compile(`${pulses.getText(file)};const specs=PULSES_LATEST_FIRST`, {}, "specs");
  for (const result of [
    { ok: true },
    { ok: true, simulated: true },
    { ok: true, suppressed: true },
    { ok: false, acceptance: "unknown", reviewRequired: true },
  ]) {
    const outcomes = {},
      jobs = {};
    let claimed = false,
      sends = 0,
      acceptedLogs = 0;
    const row = {
      id: "outcome",
      tenantId: "owner",
      jobId: "job",
      applicationId: "application",
      hireDate: new Date(Date.now() - 35 * 86400000),
    };
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => ({
            then: (resolve: (value: unknown[]) => unknown) =>
              resolve(table === outcomes ? [row] : []),
            limit: async () => [{ title: "Synthetic role" }],
          }),
        }),
      }),
    };
    const run: () => Promise<void> = compile(
      tick.getText(file),
      {
        db,
        candidateOutcomesTable: outcomes,
        jobsTable: jobs,
        eq: noop,
        and: noop,
        isNotNull: noop,
        lte: noop,
        DAY_MS: 86400000,
        PULSES_LATEST_FIRST: specs,
        logger: {
          ...logger,
          info: (_data: unknown, message: string) => {
            if (message?.includes("Provider accepted")) acceptedLogs++;
          },
        },
        claimSendSlot: async () => {
          if (claimed) return false;
          claimed = true;
          return true;
        },
        resolveRecipient: async () => ({ email: "fixture@example.invalid", name: "Synthetic" }),
        pulseBody: () => "Fixture",
        plainToHtml: (s: string) => s,
        sendEmail: async (input: { singleAttempt: boolean; audit: { action: string } }) => {
          sends++;
          assert.equal(claimed, true);
          assert.equal(input.singleAttempt, true);
          assert.equal(input.audit.action, "hire_pulse.30d.attempt");
          return result;
        },
      },
      "tick",
    );
    await Promise.all([run(), run()]);
    await run();
    assert.equal(sends, 1);
    assert.equal(acceptedLogs, result.ok && !result.simulated && !result.suppressed ? 1 : 0);
  }
});
