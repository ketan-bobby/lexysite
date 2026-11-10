/** Rollback-only service regression. Pass the fingerprint obtained independently
 * from the explicit development database. Never uses production or public fixtures.
 * tsx --experimental-test-module-mocks src/lib/meeting-attendance.sql-check.ts --development-fingerprint=<md5>
 */
import assert from "node:assert/strict";
import { mock } from "node:test";
import { randomUUID } from "node:crypto";
import { sql, eq } from "drizzle-orm";
import * as actual from "@workspace/db";

const expected = process.argv
  .find((a) => a.startsWith("--development-fingerprint="))
  ?.split("=")[1];
if (!expected || !/^[a-f0-9]{32}$/.test(expected))
  throw new Error(
    "Obtain an independent development fingerprint before running this rollback-only check.",
  );
const fingerprint = await actual.pool.query(`SELECT md5(current_database() || ':' ||
  (SELECT oid::text FROM pg_database WHERE datname=current_database()) || ':' ||
  (SELECT oid::text FROM pg_namespace WHERE nspname='public')) AS fingerprint`);
assert.equal(fingerprint.rows[0].fingerprint, expected, "wrong database target");
const namespace = `attendance_test_${randomUUID().replaceAll("-", "")}`;
const s = { actorId: "host", tenantId: "employer", jobId: "job", candidateId: "candidate" };
let role = "platform_admin",
  allowed = true,
  revision = "host-account";
let createCount = 0,
  stopCount = 0,
  deleteCount = 0,
  failCreate = false,
  unknownRecovered = false;
let scheduleId = randomUUID();
const rollback = new Error("rollback attendance fixture");
let passed = 0;
try {
  await actual.dbAdmin.transaction(async (tx) => {
    await tx.execute(
      sql.raw(`CREATE SCHEMA "${namespace}";
      SET LOCAL search_path TO "${namespace}", public;
      CREATE TABLE meeting_attendance (LIKE public.meeting_attendance INCLUDING ALL);
      CREATE TABLE meeting_assistant_workspaces (LIKE public.meeting_assistant_workspaces INCLUDING ALL);
      CREATE TABLE meeting_assistant_events (LIKE public.meeting_assistant_events INCLUDING ALL);
      CREATE TABLE meeting_notes (LIKE public.meeting_notes INCLUDING ALL);
      CREATE TABLE jobs (id text PRIMARY KEY, tenant_id text, status text);
      INSERT INTO jobs VALUES ('job','employer','active');`),
    );
    mock.module("@workspace/db", { namedExports: { ...actual, dbAdmin: tx } });
    mock.module("./calendar-staff", {
      namedExports: { calendarStaff: async () => ({ id: s.actorId, role }) },
    });
    mock.module("./meeting-notes-service", {
      namedExports: {
        meetingScope: async (actorId: string, jobId: string, candidateId: string) => {
          if (!allowed || actorId !== "host" || jobId !== s.jobId || candidateId !== s.candidateId)
            throw Object.assign(new Error("not found"), { statusCode: 404 });
          return s;
        },
        saveMeetingNote: async () => {
          throw new Error("No real storage writes in this fixture.");
        },
      },
    });
    mock.module("./native-zoom-recordings", {
      namedExports: {
        nativeZoomAppointments: async () => [],
        nativeZoomAttendanceContext: async () => {
          if (!allowed) throw new Error("authority revoked");
          return {
            accountRevision: revision,
            meeting: {
              operationId: "operation",
              snapshotHash: "snapshot",
              hostZoomId: "zoom-host",
              meetingId: "12345678901",
              joinUrl: "https://zoom.us/j/12345678901",
            },
            schedule: {
              id: scheduleId,
              tenantId: s.tenantId,
              applicationId: "application",
              status: "scheduled",
              scheduledAt: new Date(Date.now() + 3600_000),
              durationMinutes: 30,
            },
          };
        },
      },
    });
    // Keep the schedule timestamp stable across approval and dispatch hashes.
    const fixedAt = new Date(Date.now() + 3600_000);
    mock.module("./coordinator-schedule-version", {
      namedExports: {
        scheduleVersion: () => `schedule:${scheduleId}:${fixedAt.toISOString()}`,
      },
    });
    mock.module("./meeting-notes-media", { namedExports: { withMeetingAudio: async () => {} } });
    mock.module("./vendor-usage-context", {
      namedExports: {
        withUsageActivity: (_tenant: unknown, _area: unknown, fn: () => unknown) => fn(),
      },
    });
    mock.module("./recall-attendance-provider", {
      namedExports: {
        recallAttendanceProvider: () => ({
          connections: async () => [{ id: "connection" }],
          probe: async () => {},
          create: async (_connection: string, c: { id: string; token: string }) => {
            createCount++;
            if (failCreate) throw new Error("ambiguous network interruption");
            return {
              id: randomUUID(),
              metadata: { lexy_attendance: c.id, lexy_dispatch: c.token },
            };
          },
          recover: async (_connection: string, id: string, token: string) => {
            unknownRecovered = true;
            return {
              id: randomUUID(),
              metadata: { lexy_attendance: id, lexy_dispatch: token },
              status_changes: [{ code: "done", created_at: new Date().toISOString() }],
            };
          },
          stop: async () => {
            stopCount++;
            return "pending";
          },
          deleteMedia: async () => {
            deleteCount++;
          },
        }),
      },
    });
    const svc = await import("./meeting-attendance-service");
    await svc.authorizeAttendanceWorkspace(s, { connectionId: "connection", authorized: true });
    role = "recruiter";
    await assert.rejects(
      svc.authorizeAttendanceWorkspace(s, { connectionId: "connection", authorized: true }),
    );
    passed++;
    role = "platform_admin";
    const approved = await svc.approveAttendance(s, {
      scheduleId,
      consent: true,
      consentStatement: "All interview participants explicitly approved audio capture.",
    });
    assert.equal(approved.state, "approved");
    assert.equal(createCount, 0);
    await assert.rejects(
      svc.approveAttendance(s, {
        scheduleId,
        consent: true,
        consentStatement: "All participants approved recording.",
      }),
    );
    passed++;
    // Execute the real durable claim against PostgreSQL. The provider is stubbed.
    // Secret presence is injected only into this fixture process, never the workspace.
    const originalSecret = process.env.RECALL_WEBHOOK_SECRET;
    process.env.RECALL_WEBHOOK_SECRET = "whsec_Zml4dHVyZV9vbmx5";
    try {
      const outcomes = await Promise.allSettled([
        svc.dispatchAttendance(s, approved.id),
        svc.dispatchAttendance(s, approved.id),
      ]);
      assert.equal(createCount, 1, "racing clicks must issue exactly one provider create");
      assert.ok(outcomes.some((r) => r.status === "fulfilled"));
      passed++;
      const [row] = await tx
        .select()
        .from(actual.meetingAttendanceTable)
        .where(eq(actual.meetingAttendanceTable.id, approved.id));
      assert.ok(row?.botId && row.dispatchToken);
      const payload = (code: string, stamp: string) => ({
        event: `bot.${code}`,
        data: {
          data: { code, updated_at: stamp },
          bot: {
            id: row.botId,
            metadata: { lexy_attendance: row.id, lexy_dispatch: row.dispatchToken },
          },
        },
      });
      const t = Date.now();
      await svc.acceptAttendanceEvent("event-1", payload("done", new Date(t).toISOString()));
      await svc.acceptAttendanceEvent(
        "event-1",
        payload("in_call_recording", new Date(t + 1000).toISOString()),
      );
      await svc.acceptAttendanceEvent(
        "event-2",
        payload("in_call_recording", new Date(t - 1000).toISOString()),
      );
      await svc.acceptAttendanceEvent(
        "event-3",
        payload("in_call_recording", new Date(t + 2000).toISOString()),
      );
      const view = await svc.attendanceView(s);
      assert.equal(
        view.attempts[0]!.state,
        "done",
        "replayed or late events cannot reopen finished capture",
      );
      assert.ok(
        !JSON.stringify(view).includes(row.dispatchToken),
        "dispatch credentials stay server-private",
      );
      passed++;
      await svc.stopAttendance(s, approved.id);
      assert.equal(deleteCount, 1);
      assert.equal((await svc.attendanceView(s)).attempts[0]!.mediaDeleted, true);
      passed++;
      scheduleId = randomUUID();
      const uncertain = await svc.approveAttendance(s, {
        scheduleId,
        consent: true,
        consentStatement: "All participants explicitly consented to capture.",
      });
      failCreate = true;
      const held = await svc.dispatchAttendance(s, uncertain.id);
      assert.equal(held.state, "unknown");
      const countBeforeRetry = createCount;
      await svc.dispatchAttendance(s, uncertain.id);
      assert.equal(createCount, countBeforeRetry);
      await svc.recoverAttendance(s, uncertain.id);
      assert.equal(unknownRecovered, true);
      assert.equal(createCount, countBeforeRetry);
      passed++;
      scheduleId = randomUUID();
      const stale = await svc.approveAttendance(s, {
        scheduleId,
        consent: true,
        consentStatement: "All participants explicitly consented to capture.",
      });
      revision = "reconnected-account";
      await assert.rejects(svc.dispatchAttendance(s, stale.id));
      assert.equal(createCount, countBeforeRetry);
      passed++;
      allowed = false;
      await assert.rejects(svc.attendanceView(s));
      await assert.rejects(svc.stopAttendance(s, stale.id));
      assert.equal(stopCount, 0);
      passed++;
    } finally {
      if (originalSecret === undefined) delete process.env.RECALL_WEBHOOK_SECRET;
      else process.env.RECALL_WEBHOOK_SECRET = originalSecret;
    }
    throw rollback;
  });
} catch (e) {
  if (e !== rollback) throw e;
} finally {
  const check = await actual.pool.query("SELECT 1 FROM pg_namespace WHERE nspname=$1", [namespace]);
  assert.equal(check.rowCount, 0, "fixture namespace must roll back");
  await actual.pool.end();
}
process.stdout.write(
  `Passed ${passed} attendance service checks; all private SQL fixtures rolled back.\n`,
);
