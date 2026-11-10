import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { test } from "node:test";
import ts from "typescript";
import { z } from "zod/v4";
import { PgDialect } from "drizzle-orm/pg-core";
import { interviewSchedulesTable } from "@workspace/db";
import { scheduleSnapshotPredicate, scheduleVersion } from "../lib/coordinator-schedule-version";
import {
  applyCalendarAction,
  assertCalendarScheduleCurrent,
} from "../lib/outlook-calendar-operation";
import {
  eventView,
  linkedCalendarEvent,
  scheduleBinding,
  type CalendarRequest,
} from "../lib/outlook-calendar-core";

// Execute the current read/write controllers with isolated authorized context.
// Auth scope itself is unchanged and is not proven by this fixture.
const source = ts.createSourceFile(
  "outlook-calendar.ts",
  readFileSync(new URL("./outlook-calendar.ts", import.meta.url), "utf8"),
  ts.ScriptTarget.Latest,
  true,
);
const nodes = source.statements.filter((node) => {
  if (ts.isVariableStatement(node))
    return node.declarationList.declarations.some(
      (entry) => entry.name.getText(source) === "actionInput",
    );
  if (!ts.isExpressionStatement(node) || !ts.isCallExpression(node.expression)) return false;
  return (
    node.expression.arguments[0]?.getText(source) === '"/outlook-calendar/schedules/:scheduleId"'
  );
});
assert.equal(nodes.length, 3, "exercise the current input schema and both schedule controllers");
const compiled = ts.transpileModule(nodes.map((node) => node.getText(source)).join("\n"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const original = {
  id: "fixture-schedule",
  tenantId: "fixture-tenant",
  applicationId: "fixture-app",
  scheduledAt: new Date("2030-11-01T10:00:00Z"),
  durationMinutes: 60,
  status: "confirmed",
  type: "technical",
  interviewerId: "fixture-staff",
  interviewerName: null,
  location: null,
  notes: null,
  feedbackNotes: null,
  feedbackRating: null,
  createdAt: new Date("2030-01-01T00:00:00Z"),
};

function harness(overrides = {}, wins = true) {
  const schedule = { ...original, ...overrides };
  let factories = 0;
  const provider: string[] = [];
  const writes: string[] = [];
  const handlers: Record<
    string,
    (req: unknown, res: unknown, next: (error: unknown) => void) => Promise<void>
  > = {};
  const request: CalendarRequest = async <T>(path: string, init?: RequestInit) => {
    provider.push(init?.method ?? "GET");
    if (init?.method === "DELETE") return undefined as T;
    assert.ok(new URL(path, "https://graph.microsoft.com").pathname.endsWith("/me/events"));
    return {
      value: [
        {
          id: "fixture-event",
          "@odata.etag": 'W/"one"',
          type: "singleInstance",
          isOrganizer: true,
          attendees: [],
          start: { dateTime: original.scheduledAt.toISOString(), timeZone: "UTC" },
          end: { dateTime: "2030-11-01T11:00:00Z", timeZone: "UTC" },
        },
      ],
    } as T;
  };
  runInNewContext(compiled, {
    z,
    interviewSchedulesTable,
    scheduleVersion,
    scheduleSnapshotPredicate,
    applyCalendarAction,
    assertCalendarScheduleCurrent,
    eventView,
    linkedCalendarEvent,
    scheduleBinding,
    isJobApproved: () => true,
    logger: { info() {} },
    visibleSchedule: async () => ({ schedule, job: { title: "Fixture role", status: "active" } }),
    outlookCalendarRequest: async () => {
      factories++;
      return request;
    },
    router: {
      get: (_path: string, handler: (typeof handlers)[string]) => {
        handlers.GET = handler;
      },
      post: (_path: string, handler: (typeof handlers)[string]) => {
        handlers.POST = handler;
      },
    },
    db: {
      update: () => ({
        set: () => ({
          where: (predicate: Parameters<PgDialect["sqlToQuery"]>[0]) => {
            writes.push(new PgDialect().sqlToQuery(predicate).sql);
            return { returning: async () => (wins ? [{ id: schedule.id }] : []) };
          },
        }),
      }),
    },
  });
  return {
    provider,
    writes,
    get factories() {
      return factories;
    },
    async invoke(method: string, body?: unknown) {
      let result: unknown, error: unknown;
      await handlers[method](
        { body, params: { scheduleId: schedule.id } },
        {
          locals: { calendarCaller: { id: "fixture-staff" } },
          json: (value: unknown) => {
            result = value;
          },
        },
        (value) => {
          error = value;
        },
      );
      return { result, error };
    },
  };
}
const body = {
  action: "cancel",
  confirm: true,
  expectedScheduledAt: original.scheduledAt.toISOString(),
  expectedVersion: scheduleVersion(original),
};

test("read receipt is bound to the full authorized native schedule", async () => {
  const h = harness({ notes: "Latest notes" });
  const { result, error } = await h.invoke("GET");
  assert.equal(error, undefined);
  assert.equal(
    (result as { scheduleVersion: string }).scheduleVersion,
    scheduleVersion({ ...original, notes: "Latest notes" }),
  );
});

test("stale or malformed revisions reject before token resolution, Graph or native updates", async () => {
  const stale = harness({ interviewerId: "another-staff" });
  assert.ok((await stale.invoke("POST", body)).error);
  assert.equal(stale.factories, 0);
  assert.equal(stale.provider.length, 0);
  assert.equal(stale.writes.length, 0);
  const malformed = harness();
  assert.ok((await malformed.invoke("POST", { ...body, expectedVersion: "bad" })).error);
  assert.equal(malformed.factories, 0);
});

test("native calendar updates atomically compare all editable fields, not just timing", async () => {
  const h = harness();
  const { result, error } = await h.invoke("POST", body);
  assert.equal(error, undefined);
  assert.equal((result as { nativeChanged: boolean }).nativeChanged, true);
  assert.deepEqual(h.provider, ["GET", "DELETE"]);
  assert.equal(h.writes.length, 1);
  for (const column of [
    "application_id",
    "scheduled_at",
    "duration_minutes",
    "type",
    "status",
    "interviewer_id",
    "interviewer_name",
    "notes",
    "location",
    "feedback_rating",
    "feedback_notes",
  ])
    assert.ok(h.writes[0].includes(`"${column}"`), `missing snapshot predicate: ${column}`);
});

test("a lost native race after provider deletion returns reconciliation, not a successful receipt", async () => {
  const h = harness({}, false);
  const { result, error } = await h.invoke("POST", body);
  assert.equal(result, undefined);
  assert.equal((error as { code: string }).code, "reconciliation_required");
  assert.deepEqual(h.provider, ["GET", "DELETE"]);
});
