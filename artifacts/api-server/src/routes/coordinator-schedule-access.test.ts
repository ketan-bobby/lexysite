import assert from "node:assert/strict";
import { after, before, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { Server } from "node:http";
import express from "express";
import ts from "typescript";
import { PgDialect } from "drizzle-orm/pg-core";
import { and, desc, eq, inArray, type SQL } from "drizzle-orm";
import * as tables from "@workspace/db";
import { validate } from "../middlewares/validate";
import {
  CreateScheduleBody,
  UpdateScheduleBody,
  assertFutureSchedule,
  ScheduleFeedbackBody,
} from "../lib/coordinator-schedule-input";
import {
  scheduleVersion,
  scheduleSnapshotPredicate,
  SCHEDULE_CHANGED_MESSAGE,
} from "../lib/coordinator-schedule-version";
import { CalendarError } from "../lib/outlook-calendar-core";
import {
  createScheduleOnce,
  sameScheduleInput,
  scheduleRequestId,
  ScheduleSaveConflict,
} from "../lib/coordinator-schedule-save";
import { compliantCandidatePredicate } from "../lib/compliance-scope";
import { isJobApprovedForInterview, JOB_NOT_APPROVED_MESSAGE } from "../lib/job-approval";

// Exercise the current middleware and controllers without importing the interview
// runtime or using real candidate records, providers, email or database writes.
const source = ts.createSourceFile(
  "interviews.ts",
  readFileSync(new URL("./interviews.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const staffSource = ts.createSourceFile(
  "calendar-staff.ts",
  readFileSync(new URL("../lib/calendar-staff.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const nodes: string[] = [];
for (const node of source.statements) {
  if (
    ts.isFunctionDeclaration(node) &&
    [
      "coordinatorJobScope",
      "coordinatorInterviewerAllowed",
      "findCoordinatorScheduleRequest",
      "coordinatorScheduleStaff",
      "updateCoordinatorSchedule",
    ].includes(node.name?.text ?? "")
  )
    nodes.push(node.getText(source));
  if (ts.isExpressionStatement(node) && ts.isCallExpression(node.expression)) {
    const call = node.expression;
    if (
      ts.isStringLiteral(call.arguments[0]!) &&
      (call.arguments[0].text.startsWith("/coordinator/schedules") ||
        call.arguments[0].text === "/interviews/:scheduleId/feedback")
    )
      nodes.push(node.getText(source));
  }
}
assert.equal(
  nodes.length,
  12,
  "both write paths, all reads, shared staff middleware and current scope/update helpers must be exercised",
);
const staff = staffSource.statements.find(
  (node) => ts.isFunctionDeclaration(node) && node.name?.text === "calendarStaff",
);
assert.ok(staff);
const dialect = new PgDialect();
const caller = (role = "recruiter", status = "active") => ({
  id: "staff-fixture",
  role,
  status,
  tenantId: "agency-fixture",
});
const now = new Date("2030-11-01T10:00:00Z");
const job = {
  id: "job-fixture",
  tenantId: "client-fixture",
  status: "active",
  assignedHiringManagerId: "staff-fixture",
};
const application = { id: "application-fixture", tenantId: "agency-fixture", jobId: job.id };
const schedule = {
  id: "schedule-fixture",
  tenantId: application.tenantId,
  applicationId: application.id,
  interviewerId: "staff-fixture",
  status: "pending",
  type: "technical",
  interviewerName: null as string | null,
  location: null as string | null,
  notes: null as string | null,
  feedbackRating: null as number | null,
  feedbackNotes: null as string | null,
  durationMinutes: 60,
  scheduledAt: now,
  createdAt: now,
};
const fresh = () => ({
  caller: caller() as ReturnType<typeof caller> | null,
  allowed: ["client-fixture"] as string[] | null,
  owned: true,
  job: { ...job },
  missing: false,
  stale: false,
  writes: [] as Record<string, unknown>[],
  reads: [] as { table: unknown; sql: string; params: unknown[] }[],
  schedule: { ...schedule },
  saved: new Map<
    string,
    Omit<typeof schedule, "interviewerId"> & { interviewerId: string | null } & Record<
        string,
        unknown
      >
  >(),
});
let state = fresh();
const fakeDb = {
  select(fields?: unknown) {
    let table: unknown;
    let predicate: SQL | undefined;
    const chain = {
      from(value: unknown) {
        table = value;
        return chain;
      },
      innerJoin() {
        return chain;
      },
      limit() {
        return chain;
      },
      orderBy() {
        return chain;
      },
      where(value: SQL | undefined) {
        predicate = value;
        return chain;
      },
      then(resolve: (value: unknown[]) => unknown, reject: (error: unknown) => unknown) {
        return Promise.resolve()
          .then(() => {
            const query = predicate ? dialect.sqlToQuery(predicate) : { sql: "", params: [] };
            state.reads.push({ table, ...query });
            if (table === tables.usersTable) return state.caller ? [state.caller] : [];
            if (state.missing) return [];
            if (table === tables.applicationsTable) return [{ application, job: state.job }];
            if (table === tables.jobsTable) return [state.job];
            const savedId = query.params.find(
              (value) =>
                typeof value === "string" &&
                /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value),
            );
            if (savedId) {
              const saved = state.saved.get(savedId as string);
              return saved ? [fields ? { schedule: saved } : saved] : [];
            }
            return [
              {
                schedule: state.schedule,
                job: state.job,
                firstName: "Fixture",
                lastName: "Only",
                candidateEmail: null,
                jobTitle: "Test role",
              },
            ];
          })
          .then(resolve, reject);
      },
    };
    return chain;
  },
  insert() {
    return {
      values(values: Record<string, unknown>) {
        const chain = {
          onConflictDoNothing: () => chain,
          returning: async () => {
            if (values.id && state.saved.has(values.id as string)) return [];
            state.writes.push(values);
            const row = { ...state.schedule, ...values };
            if (values.id) state.saved.set(values.id as string, row);
            return [row];
          },
        };
        return chain;
      },
    };
  },
  update() {
    return {
      set(values: Record<string, unknown>) {
        state.writes.push(values);
        return {
          where(predicate: SQL) {
            const query = dialect.sqlToQuery(predicate);
            state.reads.push({ table: "update", ...query });
            return {
              returning: async () => (state.stale ? [] : [{ ...state.schedule, ...values }]),
            };
          },
        };
      },
    };
  },
};
const app = express();
app.use(express.json());
const router = express.Router();
const code = `const calendarStaff = ${staff.getText(staffSource).replace(/^export\s+/, "")};\n${nodes.join("\n")}`;
runInNewContext(
  ts.transpileModule(code, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
  }).outputText,
  {
    router,
    ...tables,
    db: fakeDb,
    controlDb: fakeDb,
    and,
    desc,
    eq,
    inArray,
    CalendarError,
    createScheduleOnce,
    sameScheduleInput,
    scheduleRequestId,
    ScheduleSaveConflict,
    scheduleVersion,
    scheduleSnapshotPredicate,
    SCHEDULE_CHANGED_MESSAGE,
    ScheduleFeedbackBody,
    compliantCandidatePredicate,
    CreateScheduleBody,
    UpdateScheduleBody,
    assertFutureSchedule,
    validate,
    isJobApprovedForInterview,
    JOB_NOT_APPROVED_MESSAGE,
    getAuthUserId: (req: express.Request) => (req.headers.authorization ? "staff-fixture" : null),
    getDataScopeTenantIds: async () => state.allowed,
    getRecruiterAssignedJobIds: async () => ["job-fixture"],
    recruiterOwnsResource: async () => state.owned,
  },
);
app.use(router);
let server: Server;
let base = "";
before(async () => {
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => new Promise<void>((resolve) => server.close(() => resolve())));
beforeEach(() => {
  state = fresh();
});
async function request(method = "GET", body?: unknown, auth = true) {
  return fetch(`${base}/coordinator/schedules${method === "PUT" ? "/schedule-fixture" : ""}`, {
    method,
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "fixture" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
const create = {
  applicationId: application.id,
  scheduledAt: now.toISOString(),
  type: "technical",
  durationMinutes: 60,
};
const requestId = "9d5d8dd9-91b7-4d22-80b4-42bf190454e6";
async function feedbackRequest(body: unknown, auth = true) {
  return fetch(`${base}/interviews/schedule-fixture/feedback`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(auth ? { Authorization: "fixture" } : {}) },
    body: JSON.stringify(body),
  });
}

test("content revisions cover every editable field and normalize missing nullable values", () => {
  const original = scheduleVersion(state.schedule);
  assert.equal(original, scheduleVersion({ ...state.schedule }));
  for (const change of [
    { notes: "new" },
    { feedbackNotes: "new" },
    { feedbackRating: 4 },
    { location: "new" },
    { interviewerName: "new" },
    { interviewerId: "new" },
    { durationMinutes: 45 },
    { status: "confirmed" },
    { type: "final" },
    { scheduledAt: new Date("2030-11-02T10:00:00Z") },
  ])
    assert.notEqual(scheduleVersion({ ...state.schedule, ...change }), original);
  assert.equal(scheduleVersion({ ...state.schedule, notes: undefined }), original);
});

test("stale draft revisions cannot overwrite intervening feedback or timing changes", async () => {
  const version = scheduleVersion(state.schedule);
  state.schedule.feedbackNotes = "Another reviewer changed this";
  assert.equal(
    (await request("PUT", { notes: "stale draft", expectedVersion: version })).status,
    409,
  );
  assert.equal(
    (await feedbackRequest({ rating: 4, notes: "stale", expectedVersion: version })).status,
    409,
  );
  assert.equal(state.writes.length, 0);
});

test("legacy feedback route rejects anonymous, nonstaff and unowned requests", async () => {
  assert.equal((await feedbackRequest({ rating: 4 }, false)).status, 401);
  for (const user of [caller("candidate"), caller("unknown"), caller("interviewer", "suspended")]) {
    state = fresh();
    state.caller = user;
    assert.equal(
      (await feedbackRequest({ rating: 4 })).status,
      user.status === "active" ? 403 : 401,
    );
    assert.equal(state.writes.length, 0);
  }
  state = fresh();
  state.owned = false;
  assert.equal((await feedbackRequest({ rating: 4 })).status, 404);
  assert.equal(state.writes.length, 0);
  state.owned = true;
  state.missing = true;
  assert.equal((await feedbackRequest({ rating: 4 })).status, 404);
});

test("assigned interviewer feedback is scoped, bounded and returns the authoritative new revision", async () => {
  state.caller = caller("interviewer");
  const version = scheduleVersion(state.schedule);
  const response = await feedbackRequest({
    rating: 4,
    notes: "Reviewed fixture",
    expectedVersion: version,
  });
  assert.equal(response.status, 200);
  const body = (await response.json()) as { version: string; feedbackRating: number };
  assert.equal(body.feedbackRating, 4);
  assert.notEqual(body.version, version);
  assert.equal("expectedVersion" in state.writes[0]!, false);
  const read = state.reads.find((entry) => entry.table === tables.interviewSchedulesTable);
  assert.ok(read?.sql.includes('"jobs"."tenant_id"'));
  assert.ok(read?.sql.includes('"interview_schedules"."interviewer_id"'));
  const update = state.reads.find((entry) => entry.table === "update");
  for (const column of [
    "feedback_rating",
    "feedback_notes",
    "notes",
    "interviewer_id",
    "interviewer_name",
    "location",
    "type",
  ])
    assert.ok(update?.sql.includes(`"${column}"`));
  assert.ok(update?.sql.includes("IS NOT DISTINCT FROM"));
});

test("feedback racing another write conflicts without a falsely successful receipt", async () => {
  state.stale = true;
  assert.equal(
    (
      await feedbackRequest({
        rating: 4,
        notes: "My draft",
        expectedVersion: scheduleVersion(state.schedule),
      })
    ).status,
    409,
  );
  assert.equal((await feedbackRequest({ rating: 1.5 })).status, 400);
  assert.equal((await feedbackRequest({ rating: 4, notes: "x".repeat(10001) })).status, 400);
});

test("a revision alone is not an update and malformed revisions are rejected", async () => {
  assert.equal(
    (await request("PUT", { expectedVersion: scheduleVersion(state.schedule) })).status,
    400,
  );
  assert.equal((await request("PUT", { notes: "new", expectedVersion: "old" })).status, 400);
  assert.equal(state.writes.length, 0);
});

test("UUID operation identity is stable, normalized and creator-bound", () => {
  assert.equal(
    scheduleRequestId("one", requestId),
    scheduleRequestId("one", requestId.toUpperCase()),
  );
  assert.notEqual(scheduleRequestId("one", requestId), scheduleRequestId("two", requestId));
  assert.match(scheduleRequestId("one", requestId), /^[a-f0-9]{8}-[a-f0-9]{4}-8/);
});

test("keyed save and recovery return one durable schedule without a second write", async () => {
  const body = { ...create, requestId };
  const first = await request("POST", body);
  assert.equal(first.status, 201);
  const saved = (await first.json()) as { id: string };
  const retry = await request("POST", body);
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as { id: string }).id, saved.id);
  const recovered = await fetch(`${base}/coordinator/schedules/requests/${requestId}`, {
    headers: { Authorization: "fixture" },
  });
  assert.equal(recovered.status, 200);
  assert.equal(((await recovered.json()) as { replayed: boolean }).replayed, true);
  assert.equal(state.writes.length, 1);
  const lookup = state.reads.find((read) => read.params.includes(saved.id));
  assert.ok(lookup?.sql.includes('"jobs"."tenant_id"'));
  assert.ok(lookup?.sql.includes('"interview_schedules"."tenant_id" = "applications"."tenant_id"'));
  assert.ok(lookup?.params.includes("client-fixture"));
});

test("parallel keyed requests use the primary-key arbiter and create only once", async () => {
  const replies = await Promise.all([
    request("POST", { ...create, requestId }),
    request("POST", { ...create, requestId }),
  ]);
  assert.deepEqual(replies.map((reply) => reply.status).sort(), [200, 201]);
  assert.equal(state.writes.length, 1);
});

test("changed saved payload conflicts and never overwrites or creates another row", async () => {
  assert.equal((await request("POST", { ...create, requestId })).status, 201);
  assert.equal((await request("POST", { ...create, requestId, notes: "changed" })).status, 409);
  assert.equal(state.writes.length, 1);
});

test("recovering a closed schedule never reopens it or requires a future slot", async () => {
  const oldDate = "2020-11-01T10:00:00.000Z";
  const id = scheduleRequestId("staff-fixture", requestId);
  state.saved.set(id, {
    ...state.schedule,
    ...create,
    id,
    scheduledAt: new Date(oldDate),
    interviewerId: null,
    status: "cancelled",
  });
  const retry = await request("POST", { ...create, scheduledAt: oldDate, requestId });
  assert.equal(retry.status, 200);
  assert.equal(((await retry.json()) as { status: string }).status, "cancelled");
  assert.equal(state.writes.length, 0);
});

test("request lookup validates UUID and reapplies active staff and current scope predicates", async () => {
  const get = (key: string, auth = true) =>
    fetch(`${base}/coordinator/schedules/requests/${key}`, {
      headers: auth ? { Authorization: "fixture" } : {},
    });
  assert.equal((await get("bad")).status, 400);
  assert.equal((await get(requestId)).status, 404);
  assert.equal((await get(requestId, false)).status, 401);
  assert.equal((await request("POST", { ...create, requestId: "bad" })).status, 400);
  state.caller = caller("candidate");
  assert.equal((await get(requestId)).status, 403);
  state.caller = caller("interviewer");
  await get(requestId);
  assert.ok(
    state.reads.some((read) => read.sql.includes('"interview_schedules"."interviewer_id"')),
  );
});

test("anonymous, inactive, unknown-role and candidate callers stop before schedule reads or writes", async () => {
  assert.equal((await request("GET", undefined, false)).status, 401);
  for (const user of [caller("candidate"), caller("unknown"), caller("recruiter", "suspended")]) {
    state = fresh();
    state.caller = user;
    for (const method of ["GET", "POST", "PUT"])
      assert.equal(
        (await request(method, method === "GET" ? undefined : create)).status,
        user.status === "active" ? 403 : 401,
      );
    assert.equal(
      state.reads.some((read) => read.table !== tables.usersTable),
      false,
    );
    assert.equal(state.writes.length, 0);
  }
});
test("list SQL scopes by job tenant, recruiter assignments, compliance and consistent child tenancy", async () => {
  assert.equal((await request()).status, 200);
  const query = state.reads.find((read) => read.table === tables.interviewSchedulesTable)!;
  assert.ok(query.params.includes("client-fixture"));
  assert.ok(query.params.includes("job-fixture"));
  assert.match(query.sql, /"interview_schedules"\."tenant_id"\s*=\s*"applications"\."tenant_id"/);
  assert.match(query.sql, /data_erased_at/);
  assert.match(query.sql, /do_not_contact/);
});
test("hiring-manager and interviewer list scopes are explicit", async () => {
  for (const role of ["hiring_manager", "interviewer"]) {
    state = fresh();
    state.caller = caller(role);
    assert.equal((await request()).status, 200);
    const query = state.reads.find((read) => read.table === tables.interviewSchedulesTable)!;
    assert.match(
      query.sql,
      role === "hiring_manager" ? /assigned_hiring_manager_id/ : /interviewer_id/,
    );
    assert.ok(query.params.includes("staff-fixture"));
  }
});
test("unowned or missing applications cannot create schedules", async () => {
  for (const missing of [false, true]) {
    state = fresh();
    state.owned = false;
    state.missing = missing;
    assert.equal((await request("POST", create)).status, 404);
    assert.equal(state.writes.length, 0);
  }
});
test("unapproved work orders block create even for platform admins", async () => {
  for (const status of ["draft", "pending_approval", "rejected"]) {
    state = fresh();
    state.caller = caller("platform_admin");
    state.job.status = status;
    assert.equal((await request("POST", create)).status, 403);
    assert.equal(state.writes.length, 0);
  }
});
test("dual-tenant create derives tenant from the authorized application, not the request", async () => {
  assert.equal((await request("POST", { ...create, tenantId: "foreign" })).status, 201);
  assert.equal(state.writes[0].tenantId, application.tenantId);
  assert.equal(state.writes[0].status, "pending");
});
test("past times and interviewer self-assignment violations do not write", async () => {
  assert.equal(
    (await request("POST", { ...create, scheduledAt: "2000-01-01T10:00:00Z" })).status,
    400,
  );
  state.caller = caller("interviewer");
  assert.equal((await request("POST", create)).status, 404);
  assert.equal(state.writes.length, 0);
});
test("unapproved rescheduling is blocked but cancellation remains available", async () => {
  state.job.status = "draft";
  assert.equal((await request("PUT", { scheduledAt: "2030-11-02T10:00:00Z" })).status, 403);
  assert.equal(state.writes.length, 0);
  assert.equal((await request("PUT", { status: "cancelled" })).status, 200);
});
test("closed schedules cannot be reopened and concurrent changes return conflict", async () => {
  state.schedule.status = "completed";
  assert.equal((await request("PUT", { status: "confirmed" })).status, 409);
  assert.equal((await request("PUT", { status: "cancelled" })).status, 409);
  state.schedule.status = "cancelled";
  assert.equal((await request("PUT", { status: "completed" })).status, 409);
  state = fresh();
  state.stale = true;
  assert.equal((await request("PUT", { notes: "reviewed" })).status, 409);
  const query = state.reads.find((read) => read.table === "update")!;
  for (const column of ["tenant_id", "scheduled_at", "status", "duration_minutes"])
    assert.ok(query.sql.includes(column));
});
test("update strips immutable identifiers and keeps valid feedback changes", async () => {
  assert.equal(
    (await request("PUT", { notes: "reviewed", tenantId: "foreign", applicationId: "foreign" }))
      .status,
    200,
  );
  assert.deepEqual(Object.keys(state.writes[0]), ["notes"]);
});
