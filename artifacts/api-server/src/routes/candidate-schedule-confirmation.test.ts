import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { z } from "zod/v4";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, eq, exists, gt, isNull, notInArray, or, sql } from "drizzle-orm";
import {
  db,
  applicationsTable,
  candidatesTable,
  interviewSchedulesTable,
  jobsTable,
} from "@workspace/db";
import { scheduleSnapshotPredicate } from "../lib/coordinator-schedule-version";
import { UNAPPROVED_JOB_STATUSES } from "../lib/job-approval";
import {
  assertCandidateTimeConfirmation,
  candidateTimeVersion,
  CandidateConfirmationError,
} from "../lib/candidate-schedule-confirmation";

const source = ts.createSourceFile(
  "route.ts",
  readFileSync(new URL("./candidate-schedule-confirmation.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const printer = ts.createPrinter();
const compiled = ts.transpileModule(
  source.statements
    .filter((s) => !ts.isImportDeclaration(s))
    .map((s) => printer.printNode(ts.EmitHint.Unspecified, s, source))
    .join("\n"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS } },
).outputText;
const original = {
  id: "fixture-schedule",
  tenantId: "fixture-employer",
  applicationId: "fixture-app",
  scheduledAt: new Date("2030-11-01T10:00:00Z"),
  durationMinutes: 60,
  type: "technical",
  status: "pending",
  interviewerId: null,
  interviewerName: null,
  location: null,
  notes: null,
  feedbackNotes: null,
  feedbackRating: null,
  createdAt: new Date(),
};
const body = { confirm: true, expectedVersion: candidateTimeVersion(original) };

async function invoke(
  options: {
    candidateId?: string | null;
    missing?: boolean;
    changed?: boolean;
    lostRace?: boolean;
    panelErrorStatus?: 409 | 503;
    schedule?: typeof original;
    body?: unknown;
  } = {},
) {
  let handler: (req: unknown, res: unknown, next: (error: unknown) => void) => Promise<unknown>;
  const queries: string[] = [],
    writes: unknown[] = [],
    confirmations: unknown[] = [],
    panelChecks: unknown[] = [];
  const schedule = options.schedule ?? original;
  const initial = {
    from() {
      return this;
    },
    innerJoin() {
      return this;
    },
    where(predicate: Parameters<PgDialect["sqlToQuery"]>[0]) {
      queries.push(new PgDialect().sqlToQuery(predicate).sql);
      return this;
    },
    limit: async () =>
      options.missing
        ? []
        : [
            {
              schedule: options.changed ? { ...schedule, durationMinutes: 30 } : schedule,
              jobStatus: "active",
            },
          ],
  };
  let reads = 0,
    transactions = 0;
  const tx = {
    select: (...args: Parameters<typeof db.select>) =>
      reads++ === 0 ? initial : db.select(...args),
    update: () => ({
      set: (value: unknown) => ({
        where: (predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
          queries.push(new PgDialect().sqlToQuery(predicate).sql);
          return {
            returning: async () => {
              writes.push(value);
              return options.lostRace ? [] : [{ ...schedule, status: "confirmed" }];
            },
          };
        },
      }),
    }),
  };
  runInNewContext(compiled, {
    exports: {},
    z,
    and,
    eq,
    exists,
    gt,
    isNull,
    notInArray,
    or,
    sql,
    Router: () => ({
      post: (_path: string, fn: typeof handler) => {
        handler = fn;
      },
    }),
    dbAdmin: {
      transaction: async (fn: (value: typeof tx) => unknown) => {
        transactions++;
        return fn(tx);
      },
    },
    resolveCandidateId: async () =>
      options.candidateId === undefined ? "fixture-self" : options.candidateId,
    applicationsTable,
    candidatesTable,
    interviewSchedulesTable,
    jobsTable,
    scheduleSnapshotPredicate,
    candidateTimeVersion,
    UNAPPROVED_JOB_STATUSES,
    assertCandidateTimeConfirmation,
    CandidateConfirmationError,
    // This harness isolates route delegation. Real panel consent, availability
    // and transaction rollback are exercised in the PostgreSQL integration suite.
    assertPanelConfirmation: async (transaction: unknown, snapshot: typeof original) => {
      assert.equal(transaction, tx);
      assert.equal(snapshot, schedule);
      assert.equal(writes.length, 0);
      panelChecks.push(snapshot.id);
      if (options.panelErrorStatus)
        throw new CandidateConfirmationError(
          options.panelErrorStatus,
          "The interview time could not be confirmed with the panel.",
        );
    },
    // Route-level delegation only; the PostgreSQL suite exercises the real
    // writer's event/notification persistence, isolation and atomic rollback.
    recordInterviewTimeConfirmation: async (
      transaction: unknown,
      saved: typeof original,
      candidateId: string,
    ) => {
      assert.equal(transaction, tx);
      confirmations.push({
        candidateId,
        scheduleId: saved.id,
        applicationId: saved.applicationId,
        status: saved.status,
        scheduledAt: saved.scheduledAt.toISOString(),
      });
    },
  });
  let status = 200,
    result: unknown,
    error: unknown;
  const res = {
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      result = value;
      return this;
    },
  };
  await handler!(
    { params: { scheduleId: original.id }, body: options.body ?? body },
    res,
    (value) => {
      error = value;
    },
  );
  return { status, result, error, queries, writes, confirmations, panelChecks, transactions };
}

test("candidate authentication and explicit immutable confirmation input precede every transaction", async () => {
  for (const options of [
    { candidateId: null },
    { body: { ...body, confirm: false } },
    { body: { ...body, status: "confirmed" } },
    { body: { confirm: true } },
  ]) {
    const h = await invoke(options);
    assert.ok([400, 401].includes(h.status));
    assert.equal(h.transactions, 0);
  }
});
test("foreign or missing schedule is a non-disclosing 404 with candidate ownership in SQL", async () => {
  const h = await invoke({ missing: true });
  assert.equal(h.status, 404);
  assert.equal(h.writes.length, 0);
  assert.match(h.queries[0], /"applications"\."candidate_id"/);
});
test("changed proposal and lost native write race never return confirmation or delegate evidence", async () => {
  for (const options of [{ changed: true }, { lostRace: true }]) {
    const h = await invoke(options);
    assert.equal(h.error, undefined);
    assert.equal(h.status, 409);
    assert.equal(h.confirmations.length, 0);
  }
});
test("successful confirmation delegates self-owned evidence on the same transaction", async () => {
  const h = await invoke();
  assert.equal(h.error, undefined);
  assert.equal(h.status, 200);
  assert.deepEqual(JSON.parse(JSON.stringify(h.writes)), [{ status: "confirmed" }]);
  assert.deepEqual(h.panelChecks, [original.id]);
  assert.deepEqual(h.confirmations, [
    {
      candidateId: "fixture-self",
      scheduleId: original.id,
      applicationId: original.applicationId,
      status: "confirmed",
      scheduledAt: original.scheduledAt.toISOString(),
    },
  ]);
  assert.match(h.queries[1], /exists/i);
  assert.match(h.queries[1], /"applications"\."candidate_id"/);
  assert.match(h.queries[1], /"jobs"\."tenant_id"/);
  assert.match(h.queries[1], /"applications"\."tenant_id"/);
  assert.match(h.queries[1], /clock_timestamp\(\)/);
  const receipt = h.result as {
    calendarReserved: boolean;
    invitationSent: boolean;
    version: string;
  };
  assert.equal(receipt.calendarReserved, false);
  assert.equal(receipt.invitationSent, false);
  assert.equal(receipt.version, candidateTimeVersion({ ...original, status: "confirmed" }));
});
test("panel rejection or unavailability prevents confirmation writes and notifications", async () => {
  for (const panelErrorStatus of [409, 503] as const) {
    const h = await invoke({ panelErrorStatus });
    assert.equal(h.error, undefined);
    assert.equal(h.status, panelErrorStatus);
    assert.deepEqual(h.panelChecks, [original.id]);
    assert.equal(h.writes.length, 0);
    assert.equal(h.confirmations.length, 0);
  }
});
test("past, closed, AI, unapproved and stale proposals cannot be confirmed", () => {
  for (const change of [
    { status: "confirmed" },
    { status: "cancelled" },
    { status: "completed" },
    { scheduledAt: new Date("2000-01-01") },
    { type: "ai_interview" },
    { durationMinutes: 30 },
  ])
    assert.throws(() =>
      assertCandidateTimeConfirmation({ ...original, ...change }, body.expectedVersion, "active"),
    );
  assert.throws(() =>
    assertCandidateTimeConfirmation(original, body.expectedVersion, "pending_approval"),
  );
  assert.doesNotThrow(() =>
    assertCandidateTimeConfirmation(original, body.expectedVersion, "active"),
  );
});
test("candidate revision never exposes a digest of withheld reviewer feedback", () => {
  assert.equal(
    candidateTimeVersion({
      ...original,
      notes: "private",
      feedbackRating: 1,
      feedbackNotes: "private",
    }),
    candidateTimeVersion(original),
  );
});
