/**
 * Real PostgreSQL/HTTP application-boundary checks in an owned private schema.
 * Uses real request middleware with cloned development RLS policies. This is
 * not proof of production RLS/triggers, external booking or email delivery.
 */
import assert from "node:assert/strict";
import { after, before, mock, test } from "node:test";
import express from "express";
import type { Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import * as schema from "@workspace/db";
import { createTransactionalDb } from "../test-fixtures/transactional-db";
import { candidateTimeVersion } from "../lib/candidate-schedule-confirmation";
import { scheduleVersion } from "../lib/coordinator-schedule-version";
import { readFileSync } from "node:fs";
import { CalendarError } from "../lib/outlook-calendar-core";
import type { SavedSchedulePanel } from "@workspace/api-zod";
import type { PanelTx } from "../lib/calendar-panel-access";
import { createHash, randomUUID } from "node:crypto";

let fixture: Awaited<ReturnType<typeof createTransactionalDb>> | undefined;
let database: NonNullable<typeof fixture>["db"];
let server: Server | undefined;
let base: string;
let issueToken: (typeof import("../lib/auth-token"))["issueToken"];
const remoteEvents = new Map<string, Record<string, unknown>>();
let graphWrites = 0;
let loseGraphReply = false;
let failGraphBeforeWrite = false;
let graphMailboxId = "synthetic-mailbox";
const invitationMailboxes = new Map<string, { id: string; mail: string }>();
const panelBusy = new Map<string, unknown[]>();
const panelFailed = new Set<string>();
let panelProviderReads = 0;
let googleConfigured = true;
let googleBusy = false;
let googleFailure = false;
let googleRotates = false;
let googleReads = 0;
const nativeZoomCalls: string[] = [];
type NativeZoomEvent = {
  meetingId: string;
  joinUrl: string;
  hostZoomId: string;
  topic: string;
  startTime: string;
  durationMinutes: number;
  agenda: string;
};
const nativeZoomEvents = new Map<string, NativeZoomEvent>();
let nativeZoomLoseCreate = false;
let nativeZoomLoseUpdate = false;
let nativeZoomLoseCancel = false;
let nativeZoomReads = 0;
let nativeZoomAuthorizations = 0;
const nativeZoomConfig = {
  clientId: "synthetic-zoom-client",
  clientSecret: "synthetic-not-a-credential",
  redirectUri: "https://example.invalid/api/zoom-account/callback",
  settingsUrl: "https://example.invalid/settings/calendar",
};
const proposedAt = new Date("2035-11-01T10:00:00Z");
const fingerprintQuery = `
  SELECT md5(current_database() || ':' ||
    (SELECT oid::text FROM pg_database WHERE datname = current_database()) ||
    ':' || extract(epoch FROM pg_postmaster_start_time())::text) AS fingerprint
`;

before(async () => {
  // Obtain this non-secret fingerprint from the explicit development database
  // tool first. Fail before DDL when an app pool points at another instance.
  const expected = process.env.TEST_DEVELOPMENT_DATABASE_FINGERPRINT;
  assert.match(expected ?? "", /^[a-f0-9]{32}$/, "Verified development fingerprint required");
  const result = await schema.pool.query(fingerprintQuery);
  assert.equal(result.rows[0]?.fingerprint, expected, "Unverified database target: no DDL allowed");
  const policies = await schema.pool.query<{
    tablename: string;
    policyname: string;
    cmd: string;
    qual: string | null;
    with_check: string | null;
    permissive: string;
  }>(`SELECT tablename, policyname, cmd, qual, with_check, permissive
      FROM pg_catalog.pg_policies WHERE schemaname = 'public'
      AND tablename IN ('users','tenants','candidates','jobs','applications',
        'interview_schedules','candidate_action_events','user_notifications','job_recruiters')`);
  const scopeFunction = await schema.pool.query<{ definition: string }>(`
    SELECT pg_get_functiondef(p.oid) AS definition
    FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname='app_tenant_in_scope'
      AND pg_get_function_identity_arguments(p.oid)='row_tenant text'
  `);
  assert.equal(scopeFunction.rows.length, 1);
  fixture = await createTransactionalDb(
    [
      schema.tenantsTable,
      schema.usersTable,
      schema.candidatesTable,
      schema.jobsTable,
      schema.applicationsTable,
      schema.interviewSchedulesTable,
      schema.candidateActionEventsTable,
      schema.userNotificationsTable,
      schema.jobRecruitersTable,
      schema.interviewOfferedTimesTable,
      schema.interviewBookingLinksTable,
      schema.interviewTimeChangeRequestsTable,
      schema.interviewCalendarInvitationAttemptsTable,
      schema.candidateErasureTombstonesTable,
      schema.staffGoogleCalendarsTable,
      schema.googlePanelConsentsTable,
      schema.interviewZoomLinksTable,
      schema.auditLogsTable,
    ],
    { requestContext: true },
  );
  database = fixture.db;
  assert.match(fixture.schemaName, /^fixture_pilot_[a-f0-9]{32}$/);
  // Actual reviewed barrier functions, rebound only to this owned namespace.
  // No shared function, public row or production object is modified.
  const barrierSource = readFileSync(
    "../../scripts/sql/2026-10-11-candidate-erasure-write-barrier.sql",
    "utf8",
  );
  const functions = [
    ...barrierSource.matchAll(/CREATE OR REPLACE FUNCTION public\.[\s\S]*?\$\$;/g),
  ];
  assert.equal(functions.length, 3);
  for (const [definition] of functions)
    await database.execute(sql.raw(definition.replaceAll("public.", `"${fixture.schemaName}".`)));
  const linkDdl = readFileSync("../../lib/db/drizzle/0078_interview_booking_links.sql", "utf8");
  await database.execute(sql.raw(linkDdl.replaceAll("public.", `"${fixture.schemaName}".`)));
  const invitationDdl = readFileSync(
    "../../lib/db/drizzle/0079_interview_calendar_invitation_attempts.sql",
    "utf8",
  );
  await database.execute(sql.raw(invitationDdl.replaceAll("public.", `"${fixture.schemaName}".`)));
  await database.execute(
    sql.raw(readFileSync("../../lib/db/drizzle/0090_interview_zoom_links.sql", "utf8")),
  );
  await database.execute(
    sql.raw(readFileSync("../../lib/db/drizzle/0098_staff_zoom_meetings.sql", "utf8")),
  );
  const changeDdl = readFileSync(
    "../../lib/db/drizzle/0080_interview_time_change_requests.sql",
    "utf8",
  );
  await database.execute(sql.raw(changeDdl.replaceAll("public.", `"${fixture.schemaName}".`)));
  const withdrawalDdl = readFileSync(
    "../../lib/db/drizzle/0081_interview_time_change_withdrawal.sql",
    "utf8",
  );
  await database.execute(sql.raw(withdrawalDdl.replaceAll("public.", `"${fixture.schemaName}".`)));
  const invitationChangeDdl = readFileSync(
    "../../lib/db/drizzle/0082_interview_calendar_invitation_changes.sql",
    "utf8",
  );
  await database.execute(sql.raw(invitationChangeDdl));
  await database.execute(
    sql.raw(readFileSync("../../lib/db/drizzle/0083_calendar_panel_consents.sql", "utf8")),
  );
  await database.execute(
    sql.raw(readFileSync("../../lib/db/drizzle/0084_interview_schedule_panels.sql", "utf8")),
  );
  await database.execute(
    sql.raw(readFileSync("../../lib/db/drizzle/0085_calendar_working_hours.sql", "utf8")),
  );
  await database.execute(
    sql.raw(readFileSync("../../lib/db/drizzle/0086_panel_invitation_snapshot.sql", "utf8")),
  );
  await database.execute(
    sql.raw(
      scopeFunction.rows[0].definition.replace(
        "FUNCTION public.app_tenant_in_scope",
        `FUNCTION "${fixture.schemaName}".app_tenant_in_scope`,
      ),
    ),
  );
  for (const policy of policies.rows) {
    for (const identifier of [policy.tablename, policy.policyname])
      assert.match(identifier, /^[a-z_]+$/);
    assert.ok(["ALL", "SELECT", "INSERT", "UPDATE", "DELETE"].includes(policy.cmd));
    assert.equal(policy.permissive, "PERMISSIVE");
    await database.execute(sql.raw(`ALTER TABLE "${policy.tablename}" ENABLE ROW LEVEL SECURITY`));
    await database.execute(sql.raw(`ALTER TABLE "${policy.tablename}" FORCE ROW LEVEL SECURITY`));
    await database.execute(
      sql.raw(
        `CREATE POLICY "${policy.policyname}" ON "${policy.tablename}" FOR ${policy.cmd} TO lexy_app` +
          (policy.qual ? ` USING (${policy.qual})` : "") +
          (policy.with_check ? ` WITH CHECK (${policy.with_check})` : ""),
      ),
    );
  }
  await database.execute(sql.raw(`GRANT USAGE ON SCHEMA "${fixture.schemaName}" TO lexy_app`));
  await database.execute(
    sql.raw(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "${fixture.schemaName}" TO lexy_app`,
    ),
  );
  await database.execute(sql.raw("ALTER TABLE interview_offered_times ENABLE ROW LEVEL SECURITY"));
  await database.execute(sql.raw("ALTER TABLE interview_offered_times FORCE ROW LEVEL SECURITY"));
  await database.execute(sql.raw("REVOKE ALL ON interview_offered_times FROM PUBLIC, lexy_app"));
  await database.execute(sql.raw("REVOKE ALL ON interview_booking_links FROM PUBLIC, lexy_app"));
  await database.execute(
    sql.raw("REVOKE ALL ON interview_time_change_requests FROM PUBLIC, lexy_app"),
  );
  await database.execute(
    sql.raw("REVOKE ALL ON interview_calendar_invitation_attempts FROM PUBLIC, lexy_app"),
  );
  await database.execute(sql.raw("REVOKE ALL ON calendar_panel_consents FROM PUBLIC, lexy_app"));
  await database.execute(sql.raw("REVOKE ALL ON interview_schedule_panels FROM PUBLIC, lexy_app"));
  await database.execute(sql.raw("REVOKE ALL ON interview_zoom_links FROM PUBLIC, lexy_app"));
  await database.execute(sql.raw("REVOKE ALL ON staff_zoom_accounts FROM PUBLIC, lexy_app"));
  await database.execute(sql.raw("REVOKE ALL ON interview_zoom_meetings FROM PUBLIC, lexy_app"));
  await database.execute(sql.raw("REVOKE ALL ON calendar_working_hours FROM PUBLIC, lexy_app"));
  for (const name of ["staff_google_calendars", "google_panel_consents"]) {
    await database.execute(sql.raw(`ALTER TABLE "${name}" ENABLE ROW LEVEL SECURITY`));
    await database.execute(sql.raw(`ALTER TABLE "${name}" FORCE ROW LEVEL SECURITY`));
    await database.execute(sql.raw(`REVOKE ALL ON "${name}" FROM PUBLIC, lexy_app`));
  }
  const actualConfig = await import("../lib/google-staff-config");
  mock.module("../lib/zoom-provider", {
    namedExports: {
      zoomProviderError: (code = "zoom_provider_unavailable", status = 503) =>
        new CalendarError(status, code, "Synthetic Zoom failure"),
      zoomOperationMarker: (id: string) => `Lexy operation: ${id}`,
      zoomAppConfig: () => nativeZoomConfig,
      zoomProvider: () => ({
        authorizeUrl: (state: string) => `https://zoom.us/oauth/authorize?state=${state}`,
        authorize: async () => {
          nativeZoomAuthorizations++;
          return {
            zoomUserId: "synthetic-zoom-host",
            email: "host@example.invalid",
            refreshToken: "synthetic-zoom-refresh",
          };
        },
        refresh: async () => ({
          access_token: "synthetic-zoom-access",
          refresh_token: "synthetic-zoom-rotated",
        }),
        create: async (
          _token: string,
          topic: string,
          startTime: string,
          durationMinutes: number,
          operationId?: string,
        ) => {
          nativeZoomCalls.push("create");
          const meetingId = String(12345678000 + nativeZoomCalls.length);
          const receipt = {
            meetingId,
            joinUrl: `https://zoom.us/j/${meetingId}`,
            hostZoomId: "synthetic-zoom-host",
            topic,
            startTime,
            durationMinutes,
            agenda: `Lexy operation: ${operationId}`,
          };
          nativeZoomEvents.set(meetingId, receipt);
          if (nativeZoomLoseCreate) {
            nativeZoomLoseCreate = false;
            throw new CalendarError(503, "zoom_provider_unavailable", "Synthetic lost response");
          }
          return receipt;
        },
        read: async (_token: string, id: string) => {
          const receipt = nativeZoomEvents.get(id);
          if (!receipt) throw new Error("Synthetic meeting missing");
          return receipt;
        },
        inspect: async (_token: string, id: string) => {
          nativeZoomReads++;
          return nativeZoomEvents.get(id) ?? null;
        },
        update: async (
          _token: string,
          id: string,
          startTime: string,
          durationMinutes: number,
          operationId?: string,
        ) => {
          nativeZoomCalls.push(`update:${id}`);
          const receipt = nativeZoomEvents.get(id);
          if (!receipt) throw new Error("Synthetic update targeted the wrong meeting");
          Object.assign(receipt, {
            startTime,
            durationMinutes,
            agenda: `Lexy operation: ${operationId}`,
          });
          if (nativeZoomLoseUpdate) {
            nativeZoomLoseUpdate = false;
            throw new Error("Synthetic lost update response");
          }
          return receipt;
        },
        remove: async (_token: string, id: string) => {
          nativeZoomCalls.push(`cancel:${id}`);
          assert.ok(nativeZoomEvents.delete(id), "Cancel must target the original meeting");
          if (nativeZoomLoseCancel) {
            nativeZoomLoseCancel = false;
            throw new Error("Synthetic lost cancellation response");
          }
        },
      }),
    },
  });
  mock.module("../lib/google-staff-config", {
    namedExports: {
      ...actualConfig,
      googleStaffConfig: () =>
        googleConfigured
          ? {
              fingerprint: "synthetic-google-config",
              clientId: "synthetic",
              clientSecret: "not-a-secret",
              redirectUri: "https://example.invalid/callback",
              settingsUrl: "https://example.invalid/settings",
            }
          : null,
    },
  });
  const actualService = await import("../lib/google-staff-service");
  mock.module("../lib/google-staff-service", {
    namedExports: {
      ...actualService,
      openGoogleCredential: (_actor: unknown, _purpose: unknown, cipher: string) => cipher,
      sealGoogleCredential: (_actor: unknown, _purpose: unknown, token: string) => token,
    },
  });
  const actualProvider = await import("../lib/google-staff-provider");
  mock.module("../lib/google-staff-provider", {
    namedExports: {
      ...actualProvider,
      googleStaffProvider: () => ({
        refresh: async (token: string) => ({
          accessToken: token,
          ...(googleRotates ? { refreshToken: token + "-rotated" } : {}),
        }),
      }),
    },
  });
  mock.module("../lib/google-panel-freebusy", {
    namedExports: {
      readGooglePanelCalendar: async (_token: string, start: string, end: string) => {
        googleReads++;
        if (googleFailure) throw new Error("Synthetic private provider failure");
        return googleBusy
          ? [
              {
                showAs: "busy",
                start: { dateTime: start, timeZone: "UTC" },
                end: { dateTime: end, timeZone: "UTC" },
              },
            ]
          : [];
      },
    },
  });
  mock.module("../lib/outlook-calendar", {
    namedExports: {
      outlookCalendarRequest:
        async (_userId: string) => async (path: string, init?: RequestInit) => {
          const url = new URL(path, "https://graph.microsoft.com/v1.0");
          if (url.pathname === "/me")
            return (
              invitationMailboxes.get(_userId) ?? {
                id: graphMailboxId,
                mail: "organizer@example.invalid",
              }
            );
          if (url.pathname.endsWith("/calendarView")) {
            panelProviderReads++;
            if (panelFailed.has(_userId))
              throw new CalendarError(503, "panel_unknown", "Fixture calendar unavailable");
            return { value: panelBusy.get(_userId) ?? [] };
          }
          if (init?.method === "PATCH") {
            const eventId = decodeURIComponent(url.pathname.split("/").at(-1)!);
            const event = [...remoteEvents.values()].find((e) => e.id === eventId);
            assert.ok(event, "Update must target the original meeting");
            assert.equal(new Headers(init.headers).get("If-Match"), event["@odata.etag"]);
            const body = JSON.parse(String(init.body));
            assert.deepEqual(Object.keys(body).sort(), ["end", "start"]);
            graphWrites++;
            if (failGraphBeforeWrite) {
              failGraphBeforeWrite = false;
              throw new CalendarError(503, "calendar_request_uncertain", "Unknown update result");
            }
            Object.assign(event, body, { "@odata.etag": `etag-update-${graphWrites}` });
            if (loseGraphReply) {
              loseGraphReply = false;
              throw new CalendarError(503, "calendar_request_uncertain", "Lost update response");
            }
            return event;
          }
          if (init?.method === "POST") {
            graphWrites++;
            if (failGraphBeforeWrite) {
              failGraphBeforeWrite = false;
              throw new CalendarError(
                503,
                "calendar_request_uncertain",
                "Outlook status is unknown.",
              );
            }
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            const binding = (body.singleValueExtendedProperties as Array<{ value: string }>)[0]
              .value;
            const event = {
              id: `synthetic-graph-${graphWrites}`,
              "@odata.etag": "etag-synthetic",
              start: body.start,
              end: body.end,
              attendees: body.attendees,
              hideAttendees: body.hideAttendees,
              isOrganizer: true,
              type: "singleInstance",
              isCancelled: false,
            };
            remoteEvents.set(binding, event);
            if (loseGraphReply) {
              loseGraphReply = false;
              throw new CalendarError(
                503,
                "calendar_request_uncertain",
                "Outlook status is unknown.",
              );
            }
            return event;
          }
          if (url.pathname.endsWith("/events")) {
            const filter = url.searchParams.get("$filter") ?? "";
            const binding = /value eq '([a-f0-9]{64})'/.exec(filter)?.[1];
            return {
              value: binding && remoteEvents.has(binding) ? [remoteEvents.get(binding)] : [],
            };
          }
          throw new Error("Unexpected Graph request in synthetic fixture");
        },
    },
  });
  ({ issueToken } = await import("../lib/auth-token"));
  const { default: router } = await import("./candidate-schedule-confirmation");
  const { default: calendarRouter } = await import("./outlook-calendar");
  const { default: offeredTimesRouter } = await import("./interview-offered-times");
  const { withTenantContext } = await import("../middlewares/withTenantContext");
  const { resolveCandidateId } = await import("../lib/portal-auth");
  const { listCandidateNativeSchedules } = await import("../lib/candidate-native-schedules");
  await database.insert(schema.tenantsTable).values(
    ["portal-home", "agency", "employer"].map((id) => ({
      id,
      name: "Synthetic fixture",
      slug: id,
      plan: "enterprise" as const,
    })),
  );
  await database.insert(schema.usersTable).values(
    ["owner", "other", "staff", "admin"].map((id) => ({
      id,
      tenantId: "portal-home",
      email: `${id}@example.invalid`,
      name: "Synthetic fixture",
      passwordHash: "not-a-real-password",
      role:
        id === "admin"
          ? ("platform_admin" as const)
          : id === "staff"
            ? ("recruiter" as const)
            : ("candidate" as const),
    })),
  );
  await database.insert(schema.candidatesTable).values(
    ["owner", "other"].map((id) => ({
      id: `${id}-candidate`,
      userId: id,
      tenantId: "portal-home",
      firstName: "Synthetic",
      lastName: "Fixture",
      email: `${id}@example.invalid`,
    })),
  );
  await database.insert(schema.usersTable).values([
    {
      id: "outside-admin",
      tenantId: "portal-home",
      email: "outside@example.invalid",
      name: "Synthetic outsider",
      passwordHash: "not-a-real-password",
      role: "tenant_admin",
    },
    {
      id: "employer-admin",
      tenantId: "employer",
      email: "employer@example.invalid",
      name: "Synthetic employer",
      passwordHash: "not-a-real-password",
      role: "tenant_admin",
    },
    {
      id: "unassigned-hm",
      tenantId: "employer",
      email: "hm@example.invalid",
      name: "Synthetic manager",
      passwordHash: "not-a-real-password",
      role: "hiring_manager",
    },
    {
      id: "unassigned-interviewer",
      tenantId: "employer",
      email: "interviewer@example.invalid",
      name: "Synthetic interviewer",
      passwordHash: "not-a-real-password",
      role: "interviewer",
    },
  ]);
  await database.insert(schema.jobsTable).values({
    id: "job",
    tenantId: "employer",
    title: "Synthetic interview",
    description: "Isolated database validation only",
    status: "active",
  });
  await database.insert(schema.applicationsTable).values([
    { id: "application", tenantId: "agency", candidateId: "owner-candidate", jobId: "job" },
    { id: "other-application", tenantId: "agency", candidateId: "other-candidate", jobId: "job" },
  ]);
  await database.execute(sql`
    CREATE FUNCTION reject_confirmation_fixture() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.payload->>'scheduleId' IN ('rollback', 'rollback-offered', 'rollback-booking') THEN
        RAISE EXCEPTION 'isolated confirmation event failure';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  await database.execute(sql`
    CREATE TRIGGER reject_confirmation_fixture
    BEFORE INSERT ON candidate_action_events
    FOR EACH ROW EXECUTE FUNCTION reject_confirmation_fixture()
  `);
  const app = express();
  app.use(express.json());
  app.use(withTenantContext);
  app.get("/fixture-native-schedules", async (req, res) => {
    const candidateId = await resolveCandidateId(req);
    if (!candidateId) return res.status(401).json({ error: "Unauthorized" });
    return res.json(await listCandidateNativeSchedules(candidateId));
  });
  app.get("/fixture-request-context", async (_req, res) => {
    const context = await schema.db.execute(sql`
      SELECT current_user AS role,
        current_setting('app.current_candidate_id', true) AS candidate_id
    `);
    const jobs = await schema.db.select().from(schema.jobsTable);
    res.json({ ...context.rows[0], visibleJobs: jobs.length });
  });
  app.use(router);
  app.use(calendarRouter);
  app.use(offeredTimesRouter);
  app.use((await import("./interview-booking-links")).default);
  app.use((await import("./interview-time-change-requests")).default);
  app.use((await import("./outlook-candidate-invitations")).default);
  app.use((await import("./outlook-panel-invitations")).default);
  app.use((await import("./outlook-invitation-changes")).default);
  app.use((await import("./panel-calendar")).default);
  app.use((await import("./calendar-working-hours")).default);
  app.use((await import("./schedule-panel")).default);
  app.use((await import("./google-panel-calendar")).default);
  app.use((await import("./staff-zoom-links")).default);
  app.use((await import("cookie-parser")).default());
  app.use((await import("./zoom-staff-account")).default);
  app.use((await import("./notifications")).default);
  app.use((await import("./notifications")).default);
  app.use(
    (
      _error: unknown,
      _req: express.Request,
      res: express.Response,
      _next: express.NextFunction,
    ) => {
      res.status(500).json({ error: "Test operation failed" });
    },
  );
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => {
      const address = server!.address();
      assert.ok(address && typeof address !== "string");
      base = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test("ordinary request runs as lexy_app and cannot see an unrelated employer's jobs", async () => {
  const token = issueToken({ userId: "owner", role: "candidate", tenantId: "portal-home" });
  const response = await fetch(`${base}/fixture-request-context`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    role: "lexy_app",
    candidate_id: "owner-candidate",
    visibleJobs: 0,
  });
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  if (fixture) await fixture.close();
  else await schema.pool.end();
});

type ChangeView = Awaited<
  ReturnType<typeof import("./interview-time-change-requests").timeChangeView>
>;
type ChangeResponse = Omit<Response, "json"> & { json(): Promise<ChangeView> };
async function timeChangeHttp(
  id: string,
  body?: unknown,
  user = "owner",
  staff = false,
): Promise<ChangeResponse> {
  return fetch(
    `${base}/${staff ? "coordinator/schedules" : "portal/interview-schedules"}/${id}/time-change-request`,
    {
      method: body === undefined ? "GET" : "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${issueToken({ userId: user, role: staff ? "tenant_admin" : "candidate", tenantId: staff ? "agency" : "portal-home" })}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  ) as Promise<ChangeResponse>;
}
const requestBody = (row: Record<string, unknown>) => ({
  confirm: true,
  expectedVersion: candidateTimeVersion(row),
});
test("time-change requests are durable and concurrent retries save one request/action without moving the appointment", async () => {
  const row = await seedSchedule("change-idempotent");
  const beforeGraph = graphWrites;
  const results = await Promise.all(
    Array.from({ length: 5 }, () => timeChangeHttp(row.id, requestBody(row))),
  );
  for (const response of results) assert.equal(response.status, 200);
  const views = await Promise.all(results.map((r) => r.json()));
  for (const v of views) assert.ok(v.request);
  assert.equal(new Set(views.map((v) => v.request?.id)).size, 1);
  assert.equal(views[0].canRequest, false);
  assert.equal(views[0].appointmentChanged, false);
  assert.equal(views[0].invitationSent, false);
  assert.deepEqual(await saved(row.id), row);
  const actions = await database.execute(sql`SELECT * FROM candidate_action_events
    WHERE event_type='interview_time_change_requested' AND payload->>'scheduleId'=${row.id}`);
  assert.equal(actions.rows.length, 1);
  assert.equal(graphWrites, beforeGraph);
  assert.equal((await (await timeChangeHttp(row.id)).json()).request?.id, views[0].request?.id);
});
test("time-change reads/writes reject other candidates, forged identity fields and unscoped staff", async () => {
  const row = await seedSchedule("change-scope");
  assert.equal((await timeChangeHttp(row.id, undefined, "other")).status, 404);
  assert.equal((await timeChangeHttp(row.id, requestBody(row), "other")).status, 404);
  assert.equal(
    (await timeChangeHttp(row.id, { ...requestBody(row), candidateId: "other-candidate" })).status,
    400,
  );
  assert.equal((await timeChangeHttp(row.id, undefined, "outside-admin", true)).status, 404);
  assert.equal((await timeChangeHttp(row.id, undefined, "owner", true)).status, 403);
  assert.equal(
    (await fetch(`${base}/portal/interview-schedules/${row.id}/time-change-request`)).status,
    401,
  );
});
test("time-change storage denies direct reads by the ordinary application role", async () => {
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.interviewTimeChangeRequestsTable);
    }),
    (error: unknown) => {
      let cause = error;
      for (let i = 0; i < 6 && cause && typeof cause === "object"; i++) {
        const current = cause as { code?: string; cause?: unknown };
        if (current.code === "42501") return true;
        cause = current.cause;
      }
      return false;
    },
  );
});
test("stale, cancelled and past proposals cannot create time-change requests", async () => {
  const row = await seedSchedule("change-stale");
  await database
    .update(schema.interviewSchedulesTable)
    .set({ durationMinutes: 30 })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  assert.equal((await timeChangeHttp(row.id, requestBody(row))).status, 409);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "cancelled" })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  assert.equal((await (await timeChangeHttp(row.id)).json()).canRequest, false);
  assert.equal((await timeChangeHttp(row.id, requestBody(await saved(row.id)))).status, 409);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "pending", scheduledAt: new Date("2020-01-01") })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  assert.equal((await timeChangeHttp(row.id, requestBody(await saved(row.id)))).status, 409);
});
test("staff acknowledgement is idempotent, visible to the owner, and never reschedules", async () => {
  const row = await seedSchedule("change-reviewed");
  const first = await (await timeChangeHttp(row.id, requestBody(row))).json();
  const seen = await timeChangeHttp(row.id, undefined, "admin", true);
  assert.equal(seen.status, 200);
  assert.ok(first.request);
  assert.equal((await seen.json()).request?.id, first.request.id);
  const body = { requestId: first.request.id };
  assert.equal((await timeChangeHttp(row.id, body, "outside-admin", true)).status, 404);
  const reviewed = await (await timeChangeHttp(row.id, body, "admin", true)).json();
  assert.ok(reviewed.request?.reviewedAt);
  const again = await (await timeChangeHttp(row.id, body, "admin", true)).json();
  assert.equal(again.request?.reviewedAt, reviewed.request.reviewedAt);
  const own = await (await timeChangeHttp(row.id)).json();
  assert.equal(own.request?.reviewedAt, reviewed.request.reviewedAt);
  assert.equal(own.canRequest, false);
  assert.deepEqual(await saved(row.id), row);
});
test("a new proposal permits a new request without reusing or overwriting earlier requests", async () => {
  const row = await seedSchedule("change-new-proposal");
  const initial = await (await timeChangeHttp(row.id, requestBody(row))).json();
  await database
    .update(schema.interviewSchedulesTable)
    .set({ durationMinutes: 45 })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  const current = await saved(row.id);
  const empty = await (await timeChangeHttp(row.id)).json();
  assert.equal(empty.request, null);
  assert.equal(empty.canRequest, true);
  const second = await (await timeChangeHttp(row.id, requestBody(current))).json();
  assert.ok(second.request);
  assert.ok(initial.request);
  assert.notEqual(second.request.id, initial.request.id);
  const records = await database
    .select()
    .from(schema.interviewTimeChangeRequestsTable)
    .where(eq(schema.interviewTimeChangeRequestsTable.scheduleId, row.id));
  assert.equal(records.length, 2);
});
test("valid public booking capabilities can request another time but cannot choose an arbitrary schedule", async () => {
  const row = await seedSchedule("change-public");
  const minted = await mintBooking(row);
  assert.equal(minted.status, 200);
  const { token } = await minted.json();
  const send = (body: unknown) =>
    fetch(`${base}/public/interview-booking/time-change`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  const body = { token, ...requestBody(row) };
  assert.equal((await send({ ...body, scheduleId: "foreign" })).status, 400);
  assert.equal((await send({ ...body, token: "a".repeat(43) })).status, 404);
  const response = await send(body);
  assert.equal(response.status, 200);
  const receipt = (await response.json()) as ChangeView;
  assert.ok(receipt.request?.id);
  assert.deepEqual(await saved(row.id), row);
  const read = await fetch(`${base}/public/interview-booking/time-change/read`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token }),
  });
  assert.equal(((await read.json()) as ChangeView).request?.id, receipt.request.id);
});
test("confirmed appointments can receive a request without losing confirmation", async () => {
  const row = await seedSchedule("change-confirmed");
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "confirmed" })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  const current = await saved(row.id);
  assert.equal((await timeChangeHttp(row.id, requestBody(current))).status, 200);
  assert.deepEqual(await saved(row.id), current);
});
test("time-change action and alerts roll back together when notification persistence fails", async () => {
  const row = await seedSchedule("change-rollback");
  await database.execute(sql`ALTER TABLE user_notifications ADD CONSTRAINT fixture_reject_time_change
    CHECK(title <> 'Interview time-change requested') NOT VALID`);
  try {
    assert.equal((await timeChangeHttp(row.id, requestBody(row))).status, 500);
    const stored = await database
      .select()
      .from(schema.interviewTimeChangeRequestsTable)
      .where(eq(schema.interviewTimeChangeRequestsTable.scheduleId, row.id));
    assert.equal(stored.length, 0);
    const actions = await database.execute(sql`SELECT * FROM candidate_action_events
      WHERE event_type='interview_time_change_requested' AND payload->>'scheduleId'=${row.id}`);
    assert.equal(actions.rows.length, 0);
  } finally {
    await database.execute(
      sql`ALTER TABLE user_notifications DROP CONSTRAINT fixture_reject_time_change`,
    );
  }
  assert.equal((await timeChangeHttp(row.id, requestBody(row))).status, 200);
});

async function withdrawHttp(scheduleId: string, body: unknown, user = "owner") {
  return fetch(`${base}/portal/interview-schedules/${scheduleId}/time-change-request/withdraw`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId: user, role: "candidate", tenantId: "portal-home" })}`,
    },
    body: JSON.stringify(body),
  }) as Promise<ChangeResponse>;
}
async function pendingChange(id: string) {
  const row = await seedSchedule(id);
  const response = await timeChangeHttp(row.id, requestBody(row));
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.ok(receipt.request);
  return { row, body: { ...requestBody(row), requestId: receipt.request.id } };
}
test("concurrent withdrawals preserve history and emit one durable action and scoped notice set", async () => {
  const { row, body } = await pendingChange("withdraw-idempotent");
  const graphBefore = graphWrites;
  const responses = await Promise.all(Array.from({ length: 5 }, () => withdrawHttp(row.id, body)));
  for (const response of responses) assert.equal(response.status, 200);
  const receipts = await Promise.all(responses.map((r) => r.json()));
  assert.equal(new Set(receipts.map((v) => v.request?.withdrawnAt)).size, 1);
  assert.ok(receipts[0].request?.withdrawnAt);
  assert.equal(receipts[0].request?.reviewedAt, null);
  assert.equal(receipts[0].canWithdraw, false);
  assert.equal(receipts[0].appointmentChanged, false);
  assert.equal(receipts[0].invitationSent, false);
  assert.equal(receipts[0].canRequest, false);
  const actions = await database.execute(sql`SELECT * FROM candidate_action_events
    WHERE event_type='interview_time_change_withdrawn' AND payload->>'scheduleId'=${row.id}`);
  assert.equal(actions.rows.length, 1);
  const notices = await database.execute(sql`SELECT id FROM user_notifications
    WHERE type='interview_time_change_withdrawn' AND action_url=${`/coordinator?schedule=${row.id}`}`);
  assert.ok(notices.rows.length > 0);
  const again = await withdrawHttp(row.id, body);
  assert.equal(again.status, 200);
  const noticesAfter = await database.execute(sql`SELECT id FROM user_notifications
    WHERE type='interview_time_change_withdrawn' AND action_url=${`/coordinator?schedule=${row.id}`}`);
  assert.deepEqual(noticesAfter.rows, notices.rows);
  const stored = await database
    .select()
    .from(schema.interviewTimeChangeRequestsTable)
    .where(eq(schema.interviewTimeChangeRequestsTable.scheduleId, row.id));
  assert.equal(stored.length, 1);
  assert.equal(stored[0].proposalVersion, body.expectedVersion);
  assert.deepEqual(await saved(row.id), row);
  assert.equal(graphWrites, graphBefore);
});
test("withdrawals enforce candidate ownership, authentication and strict server-owned fields", async () => {
  const { row, body } = await pendingChange("withdraw-ownership");
  assert.equal((await withdrawHttp(row.id, body, "other")).status, 404);
  assert.equal(
    (await withdrawHttp(row.id, { ...body, candidateId: "other-candidate" })).status,
    400,
  );
  assert.equal((await withdrawHttp(row.id, { ...body, requestId: "foreign" })).status, 404);
  assert.equal((await withdrawHttp(row.id, { ...body, confirm: false })).status, 400);
  assert.equal((await withdrawHttp(row.id, body, "admin")).status, 401);
  assert.equal(
    (
      await fetch(`${base}/portal/interview-schedules/${row.id}/time-change-request/withdraw`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
    ).status,
    401,
  );
  assert.equal((await (await timeChangeHttp(row.id)).json()).request?.withdrawnAt, null);
});
test("a reviewed request cannot be withdrawn or have its review overwritten", async () => {
  const { row, body } = await pendingChange("withdraw-reviewed");
  const reviewed = await (
    await timeChangeHttp(row.id, { requestId: body.requestId }, "admin", true)
  ).json();
  assert.ok(reviewed.request?.reviewedAt);
  assert.equal(reviewed.canWithdraw, false);
  assert.equal((await withdrawHttp(row.id, body)).status, 409);
  const current = await (await timeChangeHttp(row.id)).json();
  assert.equal(current.request?.reviewedAt, reviewed.request.reviewedAt);
  assert.equal(current.request?.withdrawnAt, null);
  assert.deepEqual(await saved(row.id), row);
});
test("a withdrawn request is visible after reload and staff cannot acknowledge it", async () => {
  const { row, body } = await pendingChange("withdraw-staff-review");
  const withdrawn = await (await withdrawHttp(row.id, body)).json();
  assert.ok(withdrawn.request?.withdrawnAt);
  assert.equal(
    (await timeChangeHttp(row.id, { requestId: body.requestId }, "admin", true)).status,
    409,
  );
  for (const response of [
    await timeChangeHttp(row.id),
    await timeChangeHttp(row.id, undefined, "admin", true),
  ]) {
    const current = await response.json();
    assert.equal(current.request?.withdrawnAt, withdrawn.request.withdrawnAt);
    assert.equal(current.request?.reviewedAt, null);
    assert.equal(current.canWithdraw, false);
  }
  assert.deepEqual(await saved(row.id), row);
});
test("staff review racing withdrawal has exactly one winner and preserves the appointment", async () => {
  const { row, body } = await pendingChange("withdraw-review-race");
  const graphBefore = graphWrites;
  const responses = await Promise.all([
    withdrawHttp(row.id, body),
    timeChangeHttp(row.id, { requestId: body.requestId }, "admin", true),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const current = await (await timeChangeHttp(row.id)).json();
  assert.notEqual(!!current.request?.reviewedAt, !!current.request?.withdrawnAt);
  assert.equal(current.canWithdraw, false);
  assert.deepEqual(await saved(row.id), row);
  assert.equal(graphWrites, graphBefore);
});
test("stale and unavailable proposals cannot withdraw requests from earlier proposals", async () => {
  const { row, body } = await pendingChange("withdraw-stale");
  await database
    .update(schema.interviewSchedulesTable)
    .set({ durationMinutes: 45 })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  assert.equal((await withdrawHttp(row.id, body)).status, 409);
  const newer = await saved(row.id);
  assert.equal(
    (await withdrawHttp(row.id, { ...body, expectedVersion: candidateTimeVersion(newer) })).status,
    409,
  );
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "cancelled" })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  assert.equal((await withdrawHttp(row.id, body)).status, 409);
  const [record] = await database
    .select()
    .from(schema.interviewTimeChangeRequestsTable)
    .where(eq(schema.interviewTimeChangeRequestsTable.id, body.requestId));
  assert.equal(record.withdrawnAt, null);
});
test("public withdrawal uses the existing bound capability and rejects revoked or forged bindings", async () => {
  const { row, body } = await pendingChange("withdraw-public");
  const minted = await (await mintBooking(row)).json();
  const send = (data: unknown) =>
    fetch(`${base}/public/interview-booking/time-change/withdraw`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    }) as Promise<ChangeResponse>;
  const data = { ...body, token: minted.token };
  assert.equal((await send({ ...data, scheduleId: "foreign" })).status, 400);
  assert.equal((await send({ ...data, requestId: "foreign" })).status, 404);
  assert.equal((await send({ ...data, token: "a".repeat(43) })).status, 404);
  assert.equal(
    (
      await bookingStaff(row.id, "DELETE", {
        expectedVersion: scheduleVersion(row),
        expectedOfferVersion: null,
        expectedLinkVersion: minted.version,
      })
    ).status,
    200,
  );
  assert.equal((await send(data)).status, 404);
  assert.equal((await (await timeChangeHttp(row.id)).json()).request?.withdrawnAt, null);
  const fresh = await (await mintBooking(row)).json();
  await database
    .update(schema.interviewBookingLinksTable)
    .set({ expiresAt: new Date(0) })
    .where(eq(schema.interviewBookingLinksTable.scheduleId, row.id));
  assert.equal((await send({ ...data, token: fresh.token })).status, 404);
  assert.equal(
    (
      await bookingStaff(row.id, "DELETE", {
        expectedVersion: scheduleVersion(row),
        expectedOfferVersion: null,
        expectedLinkVersion: fresh.version,
      })
    ).status,
    200,
  );
  const current = await (await mintBooking(row)).json();
  const response = await send({ ...data, token: current.token });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).request?.withdrawnAt);
  assert.equal((await send({ ...data, token: current.token })).status, 200);
  assert.deepEqual(await saved(row.id), row);
});
test("withdrawal and its action roll back when the scoped notice cannot persist", async () => {
  const { row, body } = await pendingChange("withdraw-rollback");
  await database.execute(sql`ALTER TABLE user_notifications ADD CONSTRAINT fixture_reject_withdrawal
    CHECK(title <> 'Interview time-change request withdrawn') NOT VALID`);
  try {
    assert.equal((await withdrawHttp(row.id, body)).status, 500);
    const current = await (await timeChangeHttp(row.id)).json();
    assert.equal(current.request?.withdrawnAt, null);
    assert.equal(current.canWithdraw, true);
    const actions = await database.execute(sql`SELECT id FROM candidate_action_events
      WHERE event_type='interview_time_change_withdrawn' AND payload->>'scheduleId'=${row.id}`);
    assert.equal(actions.rows.length, 0);
  } finally {
    await database.execute(
      sql`ALTER TABLE user_notifications DROP CONSTRAINT fixture_reject_withdrawal`,
    );
  }
  assert.equal((await withdrawHttp(row.id, body)).status, 200);
});
test("database constraint prevents a request from being both reviewed and withdrawn", async () => {
  const { row, body } = await pendingChange("withdraw-constraint");
  await assert.rejects(
    database.execute(sql`UPDATE interview_time_change_requests
    SET reviewed_at=now(),reviewed_by='admin',withdrawn_at=now() WHERE id=${body.requestId}`),
    (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "23514",
  );
  assert.equal((await (await timeChangeHttp(row.id)).json()).canWithdraw, true);
});
test("withdrawing a request preserves a confirmed appointment and emits no provider write", async () => {
  const row = await seedSchedule("withdraw-confirmed");
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "confirmed" })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  const confirmed = await saved(row.id);
  const request = await (await timeChangeHttp(row.id, requestBody(confirmed))).json();
  assert.ok(request.request);
  const graphBefore = graphWrites;
  const response = await withdrawHttp(row.id, {
    ...requestBody(confirmed),
    requestId: request.request.id,
  });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).request?.withdrawnAt);
  assert.deepEqual(await saved(row.id), confirmed);
  assert.equal(graphWrites, graphBefore);
});

async function seedSchedule(id: string, tenantId = "agency", applicationId = "application") {
  const [row] = await database
    .insert(schema.interviewSchedulesTable)
    .values({
      id,
      tenantId,
      applicationId,
      scheduledAt: proposedAt,
      type: "technical",
      durationMinutes: 60,
      status: "pending",
    })
    .returning();
  return row;
}

test("normal candidate request lists only owned native proposals without staff feedback", async () => {
  const own = await seedSchedule("native-list-owned");
  await database
    .update(schema.interviewSchedulesTable)
    .set({
      notes: "Private reviewer note",
      feedbackRating: 1,
      feedbackNotes: "Private feedback",
    })
    .where(eq(schema.interviewSchedulesTable.id, own.id));
  const foreign = await seedSchedule("native-list-foreign", "agency", "other-application");
  const invalid = await seedSchedule("native-list-unrelated", "unrelated-tenant");
  const token = issueToken({ userId: "owner", role: "candidate", tenantId: "portal-home" });
  const response = await fetch(`${base}/fixture-native-schedules`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  const rows = (await response.json()) as Array<Record<string, unknown>>;
  const row = rows.find((entry) => entry.id === own.id);
  assert.ok(row);
  assert.equal(
    rows.some((entry) => entry.id === foreign.id || entry.id === invalid.id),
    false,
  );
  assert.equal("notes" in row || "feedbackNotes" in row || "feedbackRating" in row, false);
  assert.equal(row.score, null);
  assert.equal(row.feedback, null);
  assert.equal(row.confirmationVersion, candidateTimeVersion(own));
  assert.deepEqual(
    Object.keys(row).sort(),
    [
      "confirmationVersion",
      "department",
      "duration",
      "feedback",
      "id",
      "jobTitle",
      "location",
      "scheduledAt",
      "score",
      "source",
      "status",
      "type",
    ].sort(),
  );
});

test("candidates cannot read free/busy or manage calendars, even with a forged staff-role claim", async () => {
  const schedule = await seedSchedule("calendar-private");
  const path = `/outlook-calendar/schedules/${schedule.id}`;
  const availability =
    "/outlook-calendar/availability?start=2035-11-01T00:00:00Z&end=2035-11-02T00:00:00Z";
  for (const claimedRole of ["candidate", "recruiter", "hiring_manager", "platform_admin"]) {
    const token = issueToken({ userId: "owner", role: claimedRole, tenantId: "portal-home" });
    for (const url of [availability, path]) {
      const response = await fetch(`${base}${url}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(response.status, 403);
      assert.deepEqual(await response.json(), {
        error: "Calendar coordination requires a recruiter or administrator account.",
        code: "staff_required",
      });
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    for (const action of ["create", "update", "pull", "cancel"]) {
      const response = await fetch(`${base}${path}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          action,
          confirm: true,
          expectedScheduledAt: proposedAt.toISOString(),
        }),
      });
      assert.equal(response.status, 403);
      await response.arrayBuffer();
    }
  }
  assert.equal((await fetch(`${base}${availability}`)).status, 401);
  assert.equal((await saved(schedule.id)).status, "pending");
  assert.equal((await events(schedule.id)).length, 0);
});

async function confirm(
  schedule: Awaited<ReturnType<typeof seedSchedule>>,
  userId = "owner",
  tokenRole = "candidate",
) {
  const token = issueToken({ userId, role: tokenRole, tenantId: "portal-home" });
  return fetch(`${base}/portal/interview-schedules/${schedule.id}/confirmation`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ confirm: true, expectedVersion: candidateTimeVersion(schedule) }),
  });
}

async function saved(id: string) {
  const [row] = await database
    .select()
    .from(schema.interviewSchedulesTable)
    .where(eq(schema.interviewSchedulesTable.id, id));
  return row;
}

async function events(id: string) {
  return database
    .select()
    .from(schema.candidateActionEventsTable)
    .where(
      and(
        eq(schema.candidateActionEventsTable.candidateId, "owner-candidate"),
        sql`${schema.candidateActionEventsTable.payload}->>'scheduleId' = ${id}`,
      ),
    );
}

test("real candidate identity confirms application-tenant and job-tenant schedules", async () => {
  for (const tenant of ["agency", "employer"]) {
    const schedule = await seedSchedule(`positive-${tenant}`, tenant);
    const response = await confirm(schedule);
    assert.equal(response.status, 200);
    const receipt = await response.json();
    assert.ok(receipt && typeof receipt === "object");
    assert.ok("calendarReserved" in receipt && "invitationSent" in receipt);
    assert.equal(receipt.calendarReserved, false);
    assert.equal(receipt.invitationSent, false);
    assert.equal((await saved(schedule.id)).status, "confirmed");
    assert.equal((await events(schedule.id)).length, 1);
  }
});

test("foreign candidates, forged staff role and unrelated schedule tenants cannot write", async () => {
  const schedule = await seedSchedule("protected");
  assert.equal((await confirm(schedule, "other")).status, 404);
  assert.equal((await confirm(schedule, "staff")).status, 401);
  const invalidTenant = await seedSchedule("unrelated", "unrelated-tenant");
  assert.equal((await confirm(invalidTenant)).status, 404);
  assert.equal((await saved(schedule.id)).status, "pending");
  assert.equal((await events(schedule.id)).length, 0);
});

test("concurrent confirmations produce one transition and one durable event", async () => {
  const schedule = await seedSchedule("concurrent");
  const responses = await Promise.all([confirm(schedule), confirm(schedule)]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await saved(schedule.id)).status, "confirmed");
  assert.equal((await events(schedule.id)).length, 1);
});

async function candidateProposals(userId = "owner") {
  const token = issueToken({ userId, role: "candidate", tenantId: "portal-home" });
  const response = await fetch(`${base}/fixture-native-schedules`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  assert.equal(response.status, 200);
  return (await response.json()) as Array<{ id: string; confirmationVersion: string | null }>;
}

test("cancelled proposals disappear and a previously displayed confirmation cannot revive them", async () => {
  const schedule = await seedSchedule("cancel-after-display");
  assert.ok((await candidateProposals()).some((row) => row.id === schedule.id));
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "cancelled" })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));

  assert.ok(!(await candidateProposals()).some((row) => row.id === schedule.id));
  assert.equal((await confirm(schedule)).status, 409);
  assert.equal((await saved(schedule.id)).status, "cancelled");
  assert.equal((await events(schedule.id)).length, 0);
});

test("a changed proposed time rejects the old version and accepts only the refreshed proposal", async () => {
  const original = await seedSchedule("time-after-display");
  await database
    .update(schema.interviewSchedulesTable)
    .set({ scheduledAt: new Date("2035-11-02T14:00:00Z"), durationMinutes: 45 })
    .where(eq(schema.interviewSchedulesTable.id, original.id));

  assert.equal((await confirm(original)).status, 409);
  assert.equal((await events(original.id)).length, 0);
  const current = await saved(original.id);
  const displayed = (await candidateProposals()).find((row) => row.id === original.id);
  assert.ok(displayed);
  assert.equal(displayed.confirmationVersion, candidateTimeVersion(current));
  assert.notEqual(displayed.confirmationVersion, candidateTimeVersion(original));
  const response = await confirm(current);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.ok(receipt && typeof receipt === "object");
  assert.ok("scheduledAt" in receipt && "durationMinutes" in receipt);
  assert.equal(receipt.scheduledAt, current.scheduledAt.toISOString());
  assert.equal(receipt.durationMinutes, 45);
  assert.equal((await events(original.id)).length, 1);
});

test("reassigned proposals revoke the old candidate's reads and writes immediately", async () => {
  const schedule = await seedSchedule("owner-after-display");
  assert.ok((await candidateProposals()).some((row) => row.id === schedule.id));
  await database
    .update(schema.interviewSchedulesTable)
    .set({ applicationId: "other-application" })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));

  assert.ok(!(await candidateProposals()).some((row) => row.id === schedule.id));
  assert.equal((await confirm(schedule)).status, 404);
  assert.equal((await saved(schedule.id)).status, "pending");
  assert.equal((await events(schedule.id)).length, 0);
  assert.ok((await candidateProposals("other")).some((row) => row.id === schedule.id));
});

test("event persistence failure rolls back the real native status update", async () => {
  const schedule = await seedSchedule("rollback");
  assert.equal((await confirm(schedule)).status, 500);
  assert.equal((await saved(schedule.id)).status, "pending");
  assert.equal((await events(schedule.id)).length, 0);
});

async function offerRequest(
  id: string,
  method: "GET" | "PUT" | "POST",
  userId: string,
  body?: unknown,
  staff = false,
) {
  const token = issueToken({
    userId,
    role: userId === "admin" ? "platform_admin" : "candidate",
    tenantId: "portal-home",
  });
  return fetch(
    `${base}/${staff ? "coordinator/schedules" : "portal/interview-schedules"}/${id}/offered-times`,
    {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      ...(body ? { body: JSON.stringify(body) } : {}),
    },
  );
}

async function publishAlternatives(
  schedule: Awaited<ReturnType<typeof seedSchedule>>,
  alternatives: string[],
  expectedOfferVersion: string | null = null,
) {
  return offerRequest(
    schedule.id,
    "PUT",
    "admin",
    {
      expectedVersion: scheduleVersion(schedule),
      expectedOfferVersion,
      alternatives,
    },
    true,
  );
}

test("only explicit candidate-bound alternatives are returned; staff endpoints reject candidate identities", async () => {
  const schedule = await seedSchedule("offered-private");
  const alternative = "2035-11-02T11:00:00.000Z";
  assert.equal((await publishAlternatives(schedule, [alternative])).status, 200);
  assert.equal((await offerRequest(schedule.id, "GET", "owner", undefined, true)).status, 403);
  assert.equal((await offerRequest(schedule.id, "GET", "other")).status, 404);
  const response = await offerRequest(schedule.id, "GET", "owner");
  assert.equal(response.status, 200);
  const view = (await response.json()) as Record<string, unknown>;
  assert.deepEqual(
    Object.keys(view).sort(),
    [
      "scheduleId",
      "version",
      "offerVersion",
      "scheduledAt",
      "durationMinutes",
      "startsAt",
      "expiresAt",
    ].sort(),
  );
  assert.deepEqual(view.startsAt, [schedule.scheduledAt.toISOString(), alternative]);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const selected = await offerRequest(schedule.id, "POST", "owner", {
    confirm: true,
    expectedVersion: view.version,
    expectedOfferVersion: view.offerVersion,
    scheduledAt: alternative,
  });
  assert.equal(selected.status, 200);
  const receipt = (await selected.json()) as Record<string, unknown>;
  assert.equal(receipt.scheduledAt, alternative);
  assert.equal(receipt.calendarReserved, false);
  assert.equal(receipt.invitationSent, false);
  assert.equal((await saved(schedule.id)).status, "confirmed");
  assert.equal((await events(schedule.id)).length, 1);
});

test("unoffered times, stale alternative revisions and revoked alternatives cannot be chosen", async () => {
  const schedule = await seedSchedule("offered-revoked");
  const first = "2035-11-02T11:00:00.000Z";
  assert.equal((await publishAlternatives(schedule, [first])).status, 200);
  const original = (await (await offerRequest(schedule.id, "GET", "owner")).json()) as Record<
    string,
    unknown
  >;
  const choice = {
    confirm: true,
    expectedVersion: original.version,
    expectedOfferVersion: original.offerVersion,
    scheduledAt: first,
  };
  assert.equal(
    (
      await offerRequest(schedule.id, "POST", "owner", {
        ...choice,
        scheduledAt: "2035-11-03T11:00:00Z",
      })
    ).status,
    409,
  );
  assert.equal(
    (await publishAlternatives(schedule, [], original.offerVersion as string)).status,
    200,
  );
  assert.equal((await offerRequest(schedule.id, "POST", "owner", choice)).status, 409);
  const refreshed = (await (await offerRequest(schedule.id, "GET", "owner")).json()) as Record<
    string,
    unknown
  >;
  assert.deepEqual(refreshed.startsAt, [schedule.scheduledAt.toISOString()]);
  assert.equal(refreshed.offerVersion, null);
  assert.equal((await events(schedule.id)).length, 0);
});

test("offered-time races confirm one choice only, including against the original confirmation path", async () => {
  const schedule = await seedSchedule("offered-race");
  const alternative = "2035-11-02T11:00:00.000Z";
  assert.equal((await publishAlternatives(schedule, [alternative])).status, 200);
  const view = (await (await offerRequest(schedule.id, "GET", "owner")).json()) as Record<
    string,
    unknown
  >;
  const responses = await Promise.all([
    confirm(schedule),
    offerRequest(schedule.id, "POST", "owner", {
      confirm: true,
      expectedVersion: view.version,
      expectedOfferVersion: view.offerVersion,
      scheduledAt: alternative,
    }),
  ]);
  assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
  assert.equal((await events(schedule.id)).length, 1);
});

test("offered-time event failure rolls back the choice and preserves published alternatives", async () => {
  const schedule = await seedSchedule("rollback-offered");
  const alternative = "2035-11-02T11:00:00.000Z";
  assert.equal((await publishAlternatives(schedule, [alternative])).status, 200);
  const view = (await (await offerRequest(schedule.id, "GET", "owner")).json()) as Record<
    string,
    unknown
  >;
  const response = await offerRequest(schedule.id, "POST", "owner", {
    confirm: true,
    expectedVersion: view.version,
    expectedOfferVersion: view.offerVersion,
    scheduledAt: alternative,
  });
  assert.equal(response.status, 500);
  assert.equal((await saved(schedule.id)).status, "pending");
  assert.equal(
    (await saved(schedule.id)).scheduledAt.toISOString(),
    schedule.scheduledAt.toISOString(),
  );
  const reloaded = (await (await offerRequest(schedule.id, "GET", "owner")).json()) as Record<
    string,
    unknown
  >;
  assert.equal(reloaded.offerVersion, view.offerVersion);
  assert.equal((await events(schedule.id)).length, 0);
});

test("the ordinary database role cannot read server-private offered-time rows directly", async () => {
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.interviewOfferedTimesTable);
    }),
    (error: unknown) => {
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      return (
        cause?.code === "42501" &&
        cause.message === "permission denied for table interview_offered_times"
      );
    },
  );
});

test("staff offered-time reads and writes enforce tenant and assignment boundaries", async () => {
  const schedule = await seedSchedule("offered-staff-scope");
  const body = {
    expectedVersion: scheduleVersion(schedule),
    expectedOfferVersion: null,
    alternatives: ["2035-11-02T11:00:00.000Z"],
  };
  for (const userId of ["outside-admin", "unassigned-hm", "unassigned-interviewer"]) {
    assert.equal((await offerRequest(schedule.id, "GET", userId, undefined, true)).status, 404);
    assert.equal((await offerRequest(schedule.id, "PUT", userId, body, true)).status, 404);
  }
  assert.equal(
    (await offerRequest(schedule.id, "GET", "employer-admin", undefined, true)).status,
    200,
  );
  assert.equal((await offerRequest(schedule.id, "PUT", "employer-admin", body, true)).status, 200);
  assert.equal((await saved(schedule.id)).status, "pending");
});

test("a missing feature migration returns a private-safe 503 and never confirms or publishes", async () => {
  const schedule = await seedSchedule("offered-no-migration");
  // Only this test's owned schema is affected, never shared/public tables.
  await database.execute(
    sql`ALTER TABLE interview_offered_times RENAME TO fixture_hidden_offered_times`,
  );
  try {
    for (const request of [
      () => offerRequest(schedule.id, "GET", "owner"),
      () => offerRequest(schedule.id, "GET", "admin", undefined, true),
      () => publishAlternatives(schedule, ["2035-11-02T11:00:00.000Z"]),
      () =>
        offerRequest(schedule.id, "POST", "owner", {
          confirm: true,
          expectedVersion: candidateTimeVersion(schedule),
          expectedOfferVersion: null,
          scheduledAt: schedule.scheduledAt.toISOString(),
        }),
    ]) {
      const response = await request();
      assert.equal(response.status, 503);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), {
        code: "offered_times_unavailable",
        error:
          "Interview time choices are temporarily unavailable. Please try again later or contact your recruiter.",
      });
    }
    assert.equal((await offerRequest(schedule.id, "GET", "other")).status, 404);
    assert.equal((await saved(schedule.id)).status, "pending");
    assert.equal((await events(schedule.id)).length, 0);
  } finally {
    await database.execute(
      sql`ALTER TABLE fixture_hidden_offered_times RENAME TO interview_offered_times`,
    );
  }
  assert.equal((await offerRequest(schedule.id, "GET", "owner")).status, 200);
});

test("alternatives expire and cannot survive schedule changes or candidate reassignment", async () => {
  const schedule = await seedSchedule("offered-expired");
  const alternative = "2035-11-02T11:00:00.000Z";
  assert.equal((await publishAlternatives(schedule, [alternative])).status, 200);
  const view = (await (await offerRequest(schedule.id, "GET", "owner")).json()) as Record<
    string,
    unknown
  >;
  await database
    .update(schema.interviewOfferedTimesTable)
    .set({ expiresAt: new Date("2020-01-01") })
    .where(eq(schema.interviewOfferedTimesTable.scheduleId, schedule.id));
  assert.equal(
    (
      await offerRequest(schedule.id, "POST", "owner", {
        confirm: true,
        expectedVersion: view.version,
        expectedOfferVersion: view.offerVersion,
        scheduledAt: alternative,
      })
    ).status,
    409,
  );
  const expired = (await (await offerRequest(schedule.id, "GET", "owner")).json()) as Record<
    string,
    unknown
  >;
  assert.deepEqual(expired.startsAt, [schedule.scheduledAt.toISOString()]);
  assert.equal((await publishAlternatives(schedule, [alternative])).status, 200);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ applicationId: "other-application" })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  assert.equal((await offerRequest(schedule.id, "GET", "owner")).status, 404);
  const reassigned = (await (await offerRequest(schedule.id, "GET", "other")).json()) as Record<
    string,
    unknown
  >;
  assert.deepEqual(reassigned.startsAt, [schedule.scheduledAt.toISOString()]);
  assert.equal(reassigned.offerVersion, null);
  assert.equal((await events(schedule.id)).length, 0);
});

type BookingTestPayload = {
  token: string;
  version: string;
  active: boolean;
  state: string;
  scheduledAt: string;
  calendarReserved: boolean;
  invitationSent: boolean;
  proposal: { offerVersion: string | null; startsAt: string[] };
  receipt: unknown;
};
type BookingTestResponse = Omit<Response, "json"> & { json(): Promise<BookingTestPayload> };
async function bookingStaff(scheduleId: string, method = "GET", body?: unknown, user = "admin") {
  return fetch(`${base}/coordinator/schedules/${scheduleId}/booking-link`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId: user, role: "platform_admin", tenantId: "portal-home" })}`,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }) as Promise<BookingTestResponse>;
}
async function mintBooking(
  schedule: Awaited<ReturnType<typeof seedSchedule>>,
  offerVersion: string | null = null,
  linkVersion: string | null = null,
) {
  return bookingStaff(schedule.id, "POST", {
    expectedVersion: scheduleVersion(schedule),
    expectedOfferVersion: offerVersion,
    expectedLinkVersion: linkVersion,
  });
}
async function publicBooking(token: string, choice?: Record<string, unknown>) {
  return fetch(`${base}/public/interview-booking/${choice ? "choose" : "read"}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token, ...choice }),
  }) as Promise<BookingTestResponse>;
}

test("booking capabilities expose only published times, store a hash, and enforce staff scope", async () => {
  const schedule = await seedSchedule("booking-private");
  assert.equal((await bookingStaff(schedule.id, "GET", undefined, "owner")).status, 403);
  assert.equal((await bookingStaff(schedule.id, "GET", undefined, "outside-admin")).status, 404);
  const minted = await mintBooking(schedule);
  assert.equal(minted.status, 200);
  const grant = await minted.json();
  assert.match(grant.token, /^[A-Za-z0-9_-]{43}$/);
  const [stored] = await database
    .select()
    .from(schema.interviewBookingLinksTable)
    .where(eq(schema.interviewBookingLinksTable.scheduleId, schedule.id));
  assert.match(stored.tokenHash, /^[a-f0-9]{64}$/);
  assert.notEqual(stored.tokenHash, grant.token);
  assert.ok(stored.expiresAt.getTime() <= Date.now() + 7 * 86400000);
  const response = await publicBooking(grant.token);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  const view = await response.json();
  assert.equal(view.state, "offered");
  assert.deepEqual(view.proposal.startsAt, [schedule.scheduledAt.toISOString()]);
  assert.deepEqual(Object.keys(view).sort(), ["expiresAt", "proposal", "receipt", "state"]);
  assert.ok(!JSON.stringify(view).includes("owner-candidate"));
  const statusBody = await (await bookingStaff(schedule.id)).json();
  assert.equal(statusBody.active, true);
  assert.equal("token" in statusBody, false);
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.interviewBookingLinksTable);
    }),
  );
});

test("a public choice confirms once, supports receipt recovery and rejects a different replay", async () => {
  const schedule = await seedSchedule("booking-choice");
  const alternative = "2035-11-02T11:00:00.000Z";
  const published = (await (await publishAlternatives(schedule, [alternative])).json()) as {
    proposal: { offerVersion: string };
  };
  const grant = await (await mintBooking(schedule, published.proposal.offerVersion)).json();
  const choice = {
    confirm: true,
    expectedVersion: candidateTimeVersion(schedule),
    expectedOfferVersion: published.proposal.offerVersion,
    scheduledAt: alternative,
  };
  const response = await publicBooking(grant.token, choice);
  assert.equal(response.status, 200);
  const receipt = await response.json();
  assert.equal(receipt.scheduledAt, alternative);
  assert.equal(receipt.calendarReserved, false);
  assert.equal(receipt.invitationSent, false);
  assert.deepEqual(await (await publicBooking(grant.token, choice)).json(), receipt);
  const recovered = await (await publicBooking(grant.token)).json();
  assert.equal(recovered.state, "confirmed");
  assert.deepEqual(recovered.receipt, receipt);
  assert.equal(recovered.proposal, null);
  assert.equal(
    (
      await publicBooking(grant.token, {
        ...choice,
        scheduledAt: schedule.scheduledAt.toISOString(),
      })
    ).status,
    409,
  );
  assert.equal((await events(schedule.id)).length, 1);
});

test("different concurrent public choices cannot both succeed", async () => {
  const schedule = await seedSchedule("booking-race");
  const alternative = "2035-11-02T11:00:00.000Z";
  const published = (await (await publishAlternatives(schedule, [alternative])).json()) as {
    proposal: { offerVersion: string };
  };
  const grant = await (await mintBooking(schedule, published.proposal.offerVersion)).json();
  const choices = [schedule.scheduledAt.toISOString(), alternative].map((scheduledAt) =>
    publicBooking(grant.token, {
      confirm: true,
      expectedVersion: candidateTimeVersion(schedule),
      expectedOfferVersion: published.proposal.offerVersion,
      scheduledAt,
    }),
  );
  assert.deepEqual((await Promise.all(choices)).map((r) => r.status).sort(), [200, 409]);
  assert.equal((await events(schedule.id)).length, 1);
});

test("replacement, revocation and expiry reject old capabilities without leaking why", async () => {
  const schedule = await seedSchedule("booking-revoke");
  const first = await (await mintBooking(schedule)).json();
  const second = await (await mintBooking(schedule, null, first.version)).json();
  assert.equal((await publicBooking(first.token)).status, 404);
  assert.equal((await mintBooking(schedule, null, first.version)).status, 409);
  assert.equal((await publicBooking(second.token)).status, 200);
  assert.equal(
    (
      await bookingStaff(schedule.id, "DELETE", {
        expectedVersion: scheduleVersion(schedule),
        expectedOfferVersion: null,
        expectedLinkVersion: second.version,
      })
    ).status,
    200,
  );
  const revoked = await publicBooking(second.token);
  const bogus = await publicBooking("x".repeat(43));
  assert.equal(revoked.status, 404);
  assert.deepEqual(await revoked.json(), await bogus.json());
  const third = await (await mintBooking(schedule)).json();
  await database
    .update(schema.interviewBookingLinksTable)
    .set({ expiresAt: new Date(0) })
    .where(eq(schema.interviewBookingLinksTable.scheduleId, schedule.id));
  assert.equal((await publicBooking(third.token)).status, 404);
});

test("proposal edits and application reassignment revoke links even after content is restored", async () => {
  const schedule = await seedSchedule("booking-edit");
  const grant = await (await mintBooking(schedule)).json();
  await database
    .update(schema.interviewSchedulesTable)
    .set({ scheduledAt: new Date("2035-11-03T10:00:00Z") })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  await database
    .update(schema.interviewSchedulesTable)
    .set({ scheduledAt: schedule.scheduledAt })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  assert.equal((await publicBooking(grant.token)).status, 404);
  const second = await (await mintBooking(schedule)).json();
  await database
    .update(schema.applicationsTable)
    .set({ candidateId: "other-candidate" })
    .where(eq(schema.applicationsTable.id, schedule.applicationId));
  await database
    .update(schema.applicationsTable)
    .set({ candidateId: "owner-candidate" })
    .where(eq(schema.applicationsTable.id, schedule.applicationId));
  assert.equal((await publicBooking(second.token)).status, 404);
  const third = await (await mintBooking(schedule)).json();
  assert.equal((await publishAlternatives(schedule, ["2035-11-02T11:00:00.000Z"])).status, 200);
  assert.equal((await publicBooking(third.token)).status, 404);
});

test("event failure rolls back the public choice and capability consumption", async () => {
  const schedule = await seedSchedule("rollback-booking");
  const grant = await (await mintBooking(schedule)).json();
  assert.equal(
    (
      await publicBooking(grant.token, {
        confirm: true,
        expectedVersion: candidateTimeVersion(schedule),
        expectedOfferVersion: null,
        scheduledAt: schedule.scheduledAt.toISOString(),
      })
    ).status,
    500,
  );
  assert.equal((await saved(schedule.id)).status, "pending");
  assert.equal((await events(schedule.id)).length, 0);
  const view = await (await publicBooking(grant.token)).json();
  assert.equal(view.state, "offered");
});

test("partial rollout without invalidation guards cannot mint or read a capability", async () => {
  const schedule = await seedSchedule("booking-no-guard");
  const grant = await (await mintBooking(schedule)).json();
  await database.execute(
    sql`ALTER TABLE interview_schedules DISABLE TRIGGER lexy_booking_schedule_invalidation`,
  );
  try {
    assert.equal((await publicBooking(grant.token)).status, 503);
    assert.equal((await mintBooking(schedule, null, grant.version)).status, 503);
  } finally {
    await database.execute(
      sql`ALTER TABLE interview_schedules ENABLE TRIGGER lexy_booking_schedule_invalidation`,
    );
  }
  assert.equal((await publicBooking(grant.token)).status, 200);
});

test("public links reject unoffered times, unapproved jobs and erased candidates", async () => {
  const schedule = await seedSchedule("booking-ineligible");
  const grant = await (await mintBooking(schedule)).json();
  const unoffered = await publicBooking(grant.token, {
    confirm: true,
    expectedVersion: candidateTimeVersion(schedule),
    expectedOfferVersion: null,
    scheduledAt: "2035-11-05T10:00:00.000Z",
  });
  assert.equal(unoffered.status, 409);
  assert.equal((await saved(schedule.id)).status, "pending");
  await database
    .update(schema.jobsTable)
    .set({ status: "pending_approval" })
    .where(eq(schema.jobsTable.id, "job"));
  try {
    assert.equal((await publicBooking(grant.token)).status, 404);
  } finally {
    await database
      .update(schema.jobsTable)
      .set({ status: "active" })
      .where(eq(schema.jobsTable.id, "job"));
  }
  await database.insert(schema.candidatesTable).values({
    id: "booking-erased-candidate",
    tenantId: "portal-home",
    firstName: "Synthetic",
    lastName: "Erased",
    email: "booking-erased@example.invalid",
  });
  await database.insert(schema.applicationsTable).values({
    id: "booking-erased-application",
    tenantId: "agency",
    candidateId: "booking-erased-candidate",
    jobId: "job",
  });
  const erasedSchedule = await seedSchedule(
    "booking-erased",
    "agency",
    "booking-erased-application",
  );
  const erasedGrant = await (await mintBooking(erasedSchedule)).json();
  await database
    .update(schema.candidatesTable)
    .set({ dataErasedAt: new Date() })
    .where(eq(schema.candidatesTable.id, "booking-erased-candidate"));
  assert.equal((await publicBooking(erasedGrant.token)).status, 404);
  assert.equal((await mintBooking(erasedSchedule, null, erasedGrant.version)).status, 404);
  await assert.rejects(
    database
      .insert(schema.interviewBookingLinksTable)
      .values({
        scheduleId: erasedSchedule.id,
        candidateId: "booking-erased-candidate",
        applicationId: erasedSchedule.applicationId,
        proposalVersion: candidateTimeVersion(erasedSchedule),
        offerVersion: null,
        version: "barrier-test",
        tokenHash: "not-a-token",
        expiresAt: new Date("2035-11-01T09:00:00Z"),
      })
      .onConflictDoUpdate({
        target: schema.interviewBookingLinksTable.scheduleId,
        set: { version: "barrier-test" },
      }),
  );
});

test("public and signed-in confirmation share the same atomic choice boundary", async () => {
  const schedule = await seedSchedule("booking-portal-race");
  const alternative = "2035-11-02T11:00:00.000Z";
  const published = (await (await publishAlternatives(schedule, [alternative])).json()) as {
    proposal: { offerVersion: string };
  };
  const grant = await (await mintBooking(schedule, published.proposal.offerVersion)).json();
  const responses = await Promise.all([
    publicBooking(grant.token, {
      confirm: true,
      expectedVersion: candidateTimeVersion(schedule),
      expectedOfferVersion: published.proposal.offerVersion,
      scheduledAt: alternative,
    }),
    confirm(schedule),
  ]);
  assert.equal(responses.filter((r) => r.status === 200).length, 1);
  assert.equal((await events(schedule.id)).length, 1);
});

test("effective column grants fail the booking-link runtime guard closed", async () => {
  const schedule = await seedSchedule("booking-column-grant");
  const grant = await (await mintBooking(schedule)).json();
  await database.execute(sql`GRANT SELECT(token_hash) ON interview_booking_links TO lexy_app`);
  try {
    assert.equal((await publicBooking(grant.token)).status, 503);
  } finally {
    await database.execute(sql`REVOKE SELECT(token_hash) ON interview_booking_links FROM lexy_app`);
  }
  assert.equal((await publicBooking(grant.token)).status, 200);
});

async function confirmationNotices(scheduleId: string) {
  return database
    .select()
    .from(schema.userNotificationsTable)
    .where(
      eq(
        schema.userNotificationsTable.actionUrl,
        `/coordinator?schedule=${encodeURIComponent(scheduleId)}`,
      ),
    );
}
async function noticeHistory(userId: string, tenantId: string) {
  return fetch(`${base}/user-notifications`, {
    headers: {
      Authorization: `Bearer ${issueToken({ userId, tenantId, role: "recruiter" })}`,
    },
  });
}

test("confirmed times notify the employer admin fallback inside the normal caller-only inbox", async () => {
  const schedule = await seedSchedule("notification-fallback");
  assert.equal((await confirm(schedule)).status, 200);
  const notices = await confirmationNotices(schedule.id);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].userId, "employer-admin");
  assert.equal(notices[0].tenantId, "employer");
  assert.equal(notices[0].type, "interview_time_confirmed");
  assert.ok(!JSON.stringify(notices).includes("owner@example.invalid"));
  assert.ok(!JSON.stringify(notices).includes("2035-11"));
  const recipient = await noticeHistory("employer-admin", "employer");
  assert.equal(recipient.status, 200);
  assert.ok(
    ((await recipient.json()) as Array<{ id: string }>).some((row) => row.id === notices[0].id),
  );
  const outsider = await noticeHistory("outside-admin", "portal-home");
  assert.equal(outsider.status, 200);
  assert.ok(
    !((await outsider.json()) as Array<{ id: string }>).some((row) => row.id === notices[0].id),
  );
  const candidate = await noticeHistory("owner", "portal-home");
  assert.equal(candidate.status, 200);
  assert.ok(
    !((await candidate.json()) as Array<{ id: string }>).some((row) => row.id === notices[0].id),
  );
});

test("only active, currently staffed recipients in the job subtree receive confirmation notices", async () => {
  await database.insert(schema.tenantsTable).values({
    id: "notification-client",
    slug: "notification-client",
    name: "Synthetic child employer",
    parentId: "agency",
    plan: "enterprise",
  });
  const people = [
    { id: "notification-lead", tenantId: "agency", role: "recruiter" },
    { id: "notification-roster", tenantId: "agency", role: "recruiter_admin" },
    { id: "notification-interviewer", tenantId: "notification-client", role: "interviewer" },
    { id: "notification-admin", tenantId: "notification-client", role: "tenant_admin" },
    { id: "notification-suspended", tenantId: "agency", role: "recruiter" },
    { id: "notification-candidate", tenantId: "agency", role: "candidate" },
    { id: "notification-foreign", tenantId: "portal-home", role: "recruiter" },
  ] as const;
  await database.insert(schema.usersTable).values(
    people.map((person) => ({
      ...person,
      email: `${person.id}@example.invalid`,
      name: "Synthetic staff fixture",
      passwordHash: "not-a-real-password",
      status: person.id === "notification-suspended" ? ("suspended" as const) : ("active" as const),
    })),
  );
  await database.insert(schema.jobsTable).values({
    id: "notification-job",
    tenantId: "notification-client",
    title: "Synthetic child role",
    description: "No real candidate or provider",
    status: "active",
    assignedRecruiterId: "notification-lead",
  });
  await database.insert(schema.jobRecruitersTable).values(
    [
      "notification-lead",
      "notification-roster",
      "notification-suspended",
      "notification-candidate",
      "notification-foreign",
    ].map((recruiterUserId) => ({
      tenantId: "notification-client",
      jobId: "notification-job",
      recruiterUserId,
    })),
  );
  await database.insert(schema.applicationsTable).values({
    id: "notification-application",
    tenantId: "agency",
    jobId: "notification-job",
    candidateId: "owner-candidate",
  });
  const schedule = await seedSchedule(
    "notification-recipients",
    "agency",
    "notification-application",
  );
  await database
    .update(schema.interviewSchedulesTable)
    .set({ interviewerId: "notification-interviewer" })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  const current = await saved(schedule.id);
  assert.equal((await confirm(current)).status, 200);
  const notices = await confirmationNotices(schedule.id);
  assert.deepEqual(notices.map((row) => row.userId).sort(), [
    "notification-interviewer",
    "notification-lead",
    "notification-roster",
  ]);
  assert.equal(new Set(notices.map((row) => row.id)).size, 3);
  assert.equal(notices.find((row) => row.userId === "notification-lead")?.tenantId, "agency");
  const recipient = await noticeHistory("notification-lead", "agency");
  assert.equal(recipient.status, 200);
  const history = (await recipient.json()) as Array<{ userId: string; id: string }>;
  assert.ok(
    history.some(
      (row) => row.id === notices.find((notice) => notice.userId === "notification-lead")?.id,
    ),
  );
  assert.ok(history.every((row) => row.userId === "notification-lead"));
  // An assigned interviewer is not a substitute for a recruiting owner.
  await database
    .update(schema.jobsTable)
    .set({ assignedRecruiterId: null })
    .where(eq(schema.jobsTable.id, "notification-job"));
  await database
    .delete(schema.jobRecruitersTable)
    .where(eq(schema.jobRecruitersTable.jobId, "notification-job"));
  const withoutRecruiter = await seedSchedule(
    "notification-interviewer-fallback",
    "agency",
    "notification-application",
  );
  await database
    .update(schema.interviewSchedulesTable)
    .set({ interviewerId: "notification-interviewer" })
    .where(eq(schema.interviewSchedulesTable.id, withoutRecruiter.id));
  assert.equal((await confirm(await saved(withoutRecruiter.id))).status, 200);
  assert.deepEqual(
    (await confirmationNotices(withoutRecruiter.id)).map((row) => row.userId).sort(),
    ["notification-admin", "notification-interviewer"],
  );
});

test("concurrent confirmation retries commit only one event and one recipient notice", async () => {
  const schedule = await seedSchedule("notification-race");
  const results = await Promise.all([confirm(schedule), confirm(schedule)]);
  assert.deepEqual(results.map((result) => result.status).sort(), [200, 409]);
  assert.equal((await events(schedule.id)).length, 1);
  assert.equal((await confirmationNotices(schedule.id)).length, 1);
});

test("notification persistence failure rolls back the native confirmation and its event", async () => {
  const schedule = await seedSchedule("notification-rollback");
  await database.execute(sql`
    CREATE FUNCTION reject_notification_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.action_url='/coordinator?schedule=notification-rollback' THEN
        RAISE EXCEPTION 'synthetic notification insert failed';
      END IF;
      RETURN NEW;
    END $$`);
  await database.execute(sql`
    CREATE TRIGGER reject_notification_fixture BEFORE INSERT ON user_notifications
    FOR EACH ROW EXECUTE FUNCTION reject_notification_fixture()`);
  try {
    assert.equal((await confirm(schedule)).status, 500);
    assert.equal((await saved(schedule.id)).status, "pending");
    assert.equal((await events(schedule.id)).length, 0);
    assert.equal((await confirmationNotices(schedule.id)).length, 0);
  } finally {
    await database.execute(sql`DROP TRIGGER reject_notification_fixture ON user_notifications`);
    await database.execute(sql`DROP FUNCTION reject_notification_fixture()`);
  }
  assert.equal((await confirm(schedule)).status, 200);
  assert.equal((await confirmationNotices(schedule.id)).length, 1);
});

async function candidateCalendarRequest(
  id: string,
  method: "GET" | "POST" = "GET",
  input?: unknown,
  userId = "admin",
) {
  return fetch(`${base}/outlook-calendar/schedules/${id}/invitation`, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}

async function invitationChangeRequest(id: string, input?: unknown, userId = "admin") {
  return fetch(`${base}/outlook-calendar/schedules/${id}/invitation/change`, {
    method: input ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
    },
    ...(input ? { body: JSON.stringify(input) } : {}),
  });
}
async function invitationChangeView(id: string) {
  return (await (await invitationChangeRequest(id)).json()) as Record<string, unknown>;
}
async function changeFixture(name: string) {
  const schedule = await seedSchedule(name);
  assert.equal((await confirm(schedule)).status, 200);
  assert.equal(
    (
      await candidateCalendarRequest(schedule.id, "POST", {
        confirm: true,
        expectedVersion: scheduleVersion(await saved(schedule.id)),
        expectedRecipientEmail: "owner@example.invalid",
      })
    ).status,
    200,
  );
  const [original] = await database
    .select()
    .from(schema.interviewCalendarInvitationAttemptsTable)
    .where(eq(schema.interviewCalendarInvitationAttemptsTable.scheduleId, schedule.id));
  await database
    .update(schema.interviewSchedulesTable)
    .set({
      scheduledAt: new Date(schedule.scheduledAt.getTime() + 3600000),
    })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  const response = await invitationChangeRequest(schedule.id);
  assert.equal(response.status, 200);
  const preview = (await response.json()) as Record<string, unknown>;
  assert.equal(preview.status, "ready");
  const input = {
    confirm: true,
    expectedVersion: preview.version,
    approvalVersion: preview.approvalVersion,
  };
  return { schedule, original, preview, input };
}

test("human-approved Outlook time update keeps the original event and original invitation receipt", async () => {
  const { schedule, original, input } = await changeFixture("outlook-change-once");
  const before = graphWrites;
  const replies = await Promise.all(
    Array.from({ length: 4 }, () => invitationChangeRequest(schedule.id, input)),
  );
  assert.equal(replies.filter((r) => r.status === 200).length, 1);
  assert.equal(replies.filter((r) => r.status === 409).length, 3);
  assert.equal(graphWrites, before + 1);
  const [stored] = await database
    .select()
    .from(schema.interviewCalendarInvitationAttemptsTable)
    .where(eq(schema.interviewCalendarInvitationAttemptsTable.scheduleId, schedule.id));
  assert.equal(stored.eventId, original.eventId);
  assert.equal(stored.transactionId, original.transactionId);
  assert.equal(stored.scheduleVersion, original.scheduleVersion);
  assert.equal(stored.changes.length, 1);
  assert.ok(stored.changes[0].acceptedAt);
  assert.equal((await invitationChangeView(schedule.id)).status, "current");
  assert.equal(
    ((await (await candidateCalendarRequest(schedule.id)).json()) as Record<string, unknown>)
      .status,
    "accepted",
  );
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  assert.equal(graphWrites, before + 1);
});

test("Outlook change approval binds the exact provider revision and saved native proposal", async () => {
  const { schedule, input, original } = await changeFixture("outlook-change-stale");
  const before = graphWrites;
  const event = [...remoteEvents.values()].find((e) => e.id === original.eventId)!;
  event["@odata.etag"] = "externally-changed";
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  const fresh = await invitationChangeView(schedule.id);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ durationMinutes: 65 })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  assert.equal(
    (
      await invitationChangeRequest(schedule.id, {
        ...input,
        approvalVersion: fresh.approvalVersion,
      })
    ).status,
    409,
  );
  assert.equal(graphWrites, before);
});

test("lost Outlook update response reconciles by reads without a second PATCH", async () => {
  const { schedule, input } = await changeFixture("outlook-change-lost");
  const before = graphWrites;
  loseGraphReply = true;
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 503);
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  assert.equal((await invitationChangeView(schedule.id)).status, "current");
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  assert.equal(graphWrites, before + 1);
});

test("an unobserved Outlook change remains blocked for human review", async () => {
  const { schedule, input } = await changeFixture("outlook-change-unobserved");
  const before = graphWrites;
  failGraphBeforeWrite = true;
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 503);
  const status = await invitationChangeView(schedule.id);
  assert.equal(status.status, "needs_review");
  assert.equal(status.approvalVersion, null);
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  assert.equal(graphWrites, before + 1);
});

test("another saved native proposal appends a separate approved change without overwriting history", async () => {
  const { schedule, input } = await changeFixture("outlook-change-history");
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 200);
  const [first] = await database
    .select()
    .from(schema.interviewCalendarInvitationAttemptsTable)
    .where(eq(schema.interviewCalendarInvitationAttemptsTable.scheduleId, schedule.id));
  await database
    .update(schema.interviewSchedulesTable)
    .set({
      scheduledAt: new Date(schedule.scheduledAt.getTime() + 7200000),
    })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  const fresh = await invitationChangeView(schedule.id);
  assert.equal(fresh.status, "ready");
  assert.equal(
    (
      await invitationChangeRequest(schedule.id, {
        confirm: true,
        expectedVersion: fresh.version,
        approvalVersion: fresh.approvalVersion,
      })
    ).status,
    200,
  );
  const [second] = await database
    .select()
    .from(schema.interviewCalendarInvitationAttemptsTable)
    .where(eq(schema.interviewCalendarInvitationAttemptsTable.scheduleId, schedule.id));
  assert.equal(second.changes.length, 2);
  assert.deepEqual(second.changes[0], first.changes[0]);
});

test("candidate access, changed recipients and unexpected guests cannot authorize Outlook updates", async () => {
  const { schedule, input, original } = await changeFixture("outlook-change-privacy");
  const before = graphWrites;
  assert.equal((await invitationChangeRequest(schedule.id, undefined, "owner")).status, 403);
  assert.equal((await invitationChangeRequest(schedule.id, input, "owner")).status, 403);
  assert.equal((await invitationChangeRequest("nonexistent", input)).status, 404);
  const event = [...remoteEvents.values()].find((e) => e.id === original.eventId)!;
  const attendees = event.attendees;
  event.attendees = [
    ...(attendees as unknown[]),
    { emailAddress: { address: "unexpected@example.invalid" } },
  ];
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  assert.equal((await invitationChangeView(schedule.id)).status, "needs_review");
  event.attendees = attendees;
  await database
    .update(schema.candidatesTable)
    .set({ email: "changed@example.invalid" })
    .where(eq(schema.candidatesTable.id, original.candidateId));
  try {
    assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
    assert.equal((await invitationChangeView(schedule.id)).status, "unavailable");
  } finally {
    await database
      .update(schema.candidatesTable)
      .set({ email: "owner@example.invalid" })
      .where(eq(schema.candidatesTable.id, original.candidateId));
  }
  assert.equal(graphWrites, before);
});

test("Outlook update requires explicit approval and valid protected storage", async () => {
  const { schedule, input } = await changeFixture("outlook-change-storage");
  const before = graphWrites;
  assert.equal(
    (await invitationChangeRequest(schedule.id, { ...input, confirm: false })).status,
    400,
  );
  assert.equal(
    (await invitationChangeRequest(schedule.id, { ...input, surprise: true })).status,
    400,
  );
  await database.execute(
    sql`ALTER TABLE interview_calendar_invitation_attempts DISABLE TRIGGER lexy_erasure_write_barrier`,
  );
  try {
    assert.equal((await invitationChangeRequest(schedule.id, input)).status, 503);
  } finally {
    await database.execute(
      sql`ALTER TABLE interview_calendar_invitation_attempts ENABLE TRIGGER lexy_erasure_write_barrier`,
    );
  }
  assert.equal(graphWrites, before);
});

test("approval cannot be reused after a connected mailbox switch or linked event replacement", async () => {
  const { schedule, original, input } = await changeFixture("outlook-change-mailbox");
  const before = graphWrites;
  graphMailboxId = "different-mailbox";
  try {
    assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  } finally {
    graphMailboxId = "synthetic-mailbox";
  }
  const event = [...remoteEvents.values()].find((e) => e.id === original.eventId)!;
  const originalId = event.id;
  event.id = "replacement-meeting";
  try {
    assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
    assert.equal((await invitationChangeView(schedule.id)).status, "needs_review");
  } finally {
    event.id = originalId;
  }
  assert.equal(graphWrites, before);
});

test("cancelled, recurring and non-organizer Outlook events cannot be changed from Lexy", async () => {
  const { schedule, original, input } = await changeFixture("outlook-change-event-gates");
  const event = [...remoteEvents.values()].find((e) => e.id === original.eventId)!;
  const before = graphWrites;
  for (const mutation of [
    { isCancelled: true },
    { type: "seriesMaster" },
    { isOrganizer: false },
  ]) {
    const previous = { ...event };
    Object.assign(event, mutation);
    try {
      assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
    } finally {
      Object.assign(event, previous);
    }
  }
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "cancelled" })
    .where(eq(schema.interviewSchedulesTable.id, schedule.id));
  assert.equal((await invitationChangeRequest(schedule.id, input)).status, 409);
  assert.equal(graphWrites, before);
});

async function panelApi(path: string, input?: unknown, userId = "admin") {
  return fetch(`${base}/outlook-calendar/${path}`, {
    method: input === undefined ? "GET" : "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function optIn(userId = "admin") {
  const response = await panelApi("panel-consent", { enabled: true }, userId);
  assert.equal(response.status, 200);
}
async function hoursApi(input?: unknown, userId = "admin", suffix = "") {
  return fetch(`${base}/outlook-calendar/working-hours${suffix}`, {
    method: input === undefined ? "GET" : "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function setHours(
  userId: string,
  timeZone: string | null,
  windows: Array<{ day: number; start: string; end: string }>,
) {
  const read = await hoursApi(undefined, userId);
  assert.equal(read.status, 200);
  const previous = (await read.json()) as { version: string | null };
  const response = await hoursApi({ expectedVersion: previous.version, timeZone, windows }, userId);
  assert.equal(response.status, 200);
  return (await response.json()) as {
    version: string;
    timeZone: string | null;
    windows: unknown[];
  };
}
async function cleanHours(...userIds: string[]) {
  for (const id of userIds)
    await database
      .delete(schema.calendarWorkingHoursTable)
      .where(eq(schema.calendarWorkingHoursTable.userId, id));
}
test("working hours are own-staff only, private and independent of calendar connection", async () => {
  const writes = graphWrites;
  panelFailed.add("admin");
  try {
    assert.equal((await fetch(`${base}/outlook-calendar/working-hours`)).status, 401);
    assert.equal((await hoursApi(undefined, "owner")).status, 403);
    assert.equal(
      (await hoursApi({ expectedVersion: null, timeZone: null, windows: [] }, "owner")).status,
      403,
    );
    assert.deepEqual(await (await hoursApi()).json(), {
      version: null,
      timeZone: null,
      windows: [],
    });
    const result = await setHours("admin", "Asia/Kolkata", [
      { day: 4, start: "09:00", end: "17:00" },
    ]);
    assert.equal(result.timeZone, "Asia/Kolkata");
    assert.deepEqual(await (await hoursApi()).json(), result);
    assert.deepEqual(await (await hoursApi(undefined, "employer-admin", "?userId=admin")).json(), {
      version: null,
      timeZone: null,
      windows: [],
    });
    assert.equal(
      (
        await hoursApi({
          expectedVersion: result.version,
          timeZone: null,
          windows: [],
          userId: "employer-admin",
        })
      ).status,
      400,
    );
    await assert.rejects(
      database.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE lexy_app`);
        await tx.select().from(schema.calendarWorkingHoursTable);
      }),
    );
    assert.equal(graphWrites, writes);
  } finally {
    panelFailed.clear();
    await cleanHours("admin", "employer-admin");
  }
});
test("working-hour CAS serializes first saves and clearing retains a fresh revision", async () => {
  try {
    const input = {
      expectedVersion: null,
      timeZone: "UTC",
      windows: [{ day: 4, start: "09:00", end: "17:00" }],
    };
    const outcomes = await Promise.all([hoursApi(input), hoursApi(input)]);
    assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
    const initial = (await (await hoursApi()).json()) as { version: string };
    const cleared = await setHours("admin", null, []);
    assert.notEqual(cleared.version, initial.version);
    assert.deepEqual(cleared.windows, []);
    assert.equal((await hoursApi(input)).status, 409);
    assert.equal((await hoursApi({ ...input, expectedVersion: initial.version })).status, 409);
    assert.deepEqual(await (await hoursApi()).json(), cleared);
  } finally {
    await cleanHours("admin");
  }
});
test("invalid working-hour policies fail without changing a saved preference", async () => {
  try {
    const current = await setHours("admin", "UTC", [{ day: 4, start: "09:00", end: "17:00" }]);
    const input = {
      expectedVersion: current.version,
      timeZone: "UTC",
      windows: [{ day: 4, start: "09:00", end: "17:00" }],
    };
    const invalid = [
      { ...input, timeZone: "Invalid/Zone" },
      { ...input, timeZone: "+05:30" },
      { ...input, timeZone: null },
      { ...input, windows: [{ day: 7, start: "09:00", end: "17:00" }] },
      { ...input, windows: [{ day: 4, start: "17:00", end: "09:00" }] },
      { ...input, windows: [{ day: 4, start: "24:00", end: "24:00" }] },
      {
        ...input,
        windows: [
          { day: 4, start: "09:00", end: "12:00" },
          { day: 4, start: "11:00", end: "13:00" },
        ],
      },
      {
        ...input,
        windows: Array.from({ length: 15 }, () => ({ day: 4, start: "09:00", end: "10:00" })),
      },
    ];
    for (const body of invalid) assert.equal((await hoursApi(body)).status, 400);
    assert.deepEqual(await (await hoursApi()).json(), current);
  } finally {
    await cleanHours("admin");
  }
});
test("panel discovery intersects private local hours for every member including buffers", async () => {
  const row = await seedSchedule("working-hours-intersection");
  await optIn();
  await optIn("employer-admin");
  try {
    await setHours("admin", "UTC", [{ day: 4, start: "09:00", end: "12:00" }]);
    await setHours("employer-admin", "Asia/Kolkata", [{ day: 4, start: "15:30", end: "16:30" }]);
    const input = panelInput(row, ["admin", "employer-admin"]);
    const response = await panelApi(`schedules/${row.id}/panel-times`, input);
    assert.equal(response.status, 200);
    const found = (await response.json()) as { slots: Array<{ start: string; end: string }> };
    assert.deepEqual(found.slots, [
      { start: "2035-11-01T10:00:00.000Z", end: "2035-11-01T11:00:00.000Z" },
    ]);
    assert.doesNotMatch(JSON.stringify(found), /timeZone|windows|Kolkata|mailboxHash/);
    const buffered = await panelApi(`schedules/${row.id}/panel-times`, {
      ...input,
      bufferMinutes: 15,
    });
    assert.equal(buffered.status, 200);
    assert.deepEqual(((await buffered.json()) as { slots: unknown[] }).slots, []);
    assert.equal(
      (await savePanel(row, ["admin", "employer-admin"], "2035-11-01T09:30:00Z")).status,
      409,
    );
    assert.deepEqual(await saved(row.id), row);
  } finally {
    await cleanHours("admin", "employer-admin");
    await panelApi("panel-consent", { enabled: false });
    await panelApi("panel-consent", { enabled: false }, "employer-admin");
  }
});
test("changed hours block confirmation of a saved panel without leaking preferences", async () => {
  const row = await seedSchedule("working-hours-confirm");
  await optIn();
  try {
    await setHours("admin", "UTC", [{ day: 4, start: "09:00", end: "12:00" }]);
    assert.equal((await savePanel(row)).status, 200);
    const current = await saved(row.id);
    await setHours("admin", "UTC", [{ day: 4, start: "11:00", end: "12:00" }]);
    const response = await confirm(current);
    assert.equal(response.status, 409);
    assert.doesNotMatch(await response.text(), /timeZone|windows|mailboxHash|grantedAt/);
    assert.deepEqual(await saved(row.id), current);
    await setHours("admin", null, []);
    assert.equal((await confirm(current)).status, 200);
  } finally {
    await cleanHours("admin");
    await panelApi("panel-consent", { enabled: false });
  }
});
test("configured all-closed hours yield no slots and cannot save a panel", async () => {
  const row = await seedSchedule("working-hours-closed");
  await optIn();
  try {
    await setHours("admin", "UTC", []);
    const response = await panelApi(`schedules/${row.id}/panel-times`, panelInput(row));
    assert.equal(response.status, 200);
    assert.deepEqual(((await response.json()) as { slots: unknown[] }).slots, []);
    assert.equal((await savePanel(row)).status, 409);
    assert.deepEqual(await saved(row.id), row);
  } finally {
    await cleanHours("admin");
    await panelApi("panel-consent", { enabled: false });
  }
});
test("corrupt or unprotected private hours fail closed for reads and panel checks", async () => {
  const row = await seedSchedule("working-hours-private");
  await optIn();
  try {
    await setHours("admin", "UTC", [{ day: 4, start: "09:00", end: "17:00" }]);
    await database
      .update(schema.calendarWorkingHoursTable)
      .set({ timeZone: "Invalid/Zone" })
      .where(eq(schema.calendarWorkingHoursTable.userId, "admin"));
    assert.equal((await hoursApi()).status, 503);
    assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 503);
    await database
      .update(schema.calendarWorkingHoursTable)
      .set({ timeZone: "UTC" })
      .where(eq(schema.calendarWorkingHoursTable.userId, "admin"));
    await database.execute(sql`ALTER TABLE calendar_working_hours DISABLE ROW LEVEL SECURITY`);
    assert.equal((await hoursApi()).status, 503);
    assert.equal(
      (await hoursApi({ expectedVersion: null, timeZone: null, windows: [] })).status,
      503,
    );
    assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 503);
  } finally {
    await database.execute(sql`ALTER TABLE calendar_working_hours ENABLE ROW LEVEL SECURITY`);
    await cleanHours("admin");
    await panelApi("panel-consent", { enabled: false });
  }
});
function panelInput(row: Awaited<ReturnType<typeof seedSchedule>>, userIds = ["admin"]) {
  return {
    expectedVersion: scheduleVersion(row),
    userIds,
    start: "2035-11-01T09:00:00Z",
    end: "2035-11-01T12:00:00Z",
    bufferMinutes: 0,
  };
}
async function savePanel(
  row: Awaited<ReturnType<typeof seedSchedule>>,
  ids = ["admin"],
  start = row.scheduledAt.toISOString(),
  user = "admin",
) {
  return fetch(`${base}/outlook-calendar/schedules/${row.id}/panel`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId: user, role: "platform_admin", tenantId: "portal-home" })}`,
    },
    body: JSON.stringify({
      expectedVersion: scheduleVersion(row),
      userIds: ids,
      scheduledAt: start,
      bufferMinutes: 0,
    }),
  });
}

async function panelInviteFixture(id: string, ids = ["admin", "employer-admin"]) {
  await cleanHours(...ids);
  panelBusy.clear();
  panelFailed.clear();
  invitationMailboxes.set("admin", {
    id: "panel-organizer-mailbox",
    mail: "organizer@example.invalid",
  });
  invitationMailboxes.set("employer-admin", {
    id: "panel-member-mailbox",
    mail: "panel@example.invalid",
  });
  for (const user of ids) await optIn(user);
  const row = await seedSchedule(id);
  const save = await savePanel(row, ids);
  assert.equal(save.status, 200);
  const confirmed = await confirm(await saved(id));
  assert.equal(confirmed.status, 200);
  return await saved(id);
}
async function panelInviteView(id: string) {
  const response = await panelApi(`schedules/${id}/panel-invitation`);
  assert.equal(response.status, 200, await response.clone().text());
  return (await response.json()) as {
    version: string;
    approvalToken: string;
    status: string;
    panelRecipients: unknown[];
    organizerEmail: string;
  };
}
function panelInviteInput(review: Awaited<ReturnType<typeof panelInviteView>>) {
  return {
    confirm: true,
    expectedVersion: review.version,
    expectedApprovalToken: review.approvalToken,
  };
}

test("panel invitation review is private, read-only and explicitly includes the organizer and entire panel", async () => {
  try {
    const row = await panelInviteFixture("panel-invite-review");
    const writes = graphWrites;
    const review = await panelInviteView(row.id);
    assert.equal(review.status, "not_sent");
    for (const invalid of [
      { ...panelInviteInput(review), confirm: false },
      { expectedVersion: review.version, expectedApprovalToken: review.approvalToken },
      { ...panelInviteInput(review), recipients: ["unreviewed@example.invalid"] },
    ]) {
      assert.equal((await panelApi(`schedules/${row.id}/panel-invitation`, invalid)).status, 400);
    }
    assert.equal(review.organizerEmail, "organizer@example.invalid");
    assert.equal(review.panelRecipients.length, 2);
    assert.equal((await readAttemptForTest(row.id)).length, 0);
    assert.equal(graphWrites, writes);
    assert.notEqual(
      (await panelApi(`schedules/${row.id}/panel-invitation`, undefined, "owner")).status,
      200,
    );
    assert.notEqual(
      (await panelApi(`schedules/${row.id}/panel-invitation`, undefined, "outside-admin")).status,
      200,
    );
    const candidateOnly = await panelApi(`schedules/${row.id}/invitation`, {
      confirm: true,
      expectedVersion: scheduleVersion(row),
      expectedRecipientEmail: "owner@example.invalid",
    });
    assert.equal(candidateOnly.status, 409);
    assert.equal(graphWrites, writes);
  } finally {
    invitationMailboxes.clear();
  }
});
async function readAttemptForTest(id: string) {
  return database
    .select()
    .from(schema.interviewCalendarInvitationAttemptsTable)
    .where(eq(schema.interviewCalendarInvitationAttemptsTable.scheduleId, id));
}

test("panel approval sends exactly once with hidden guests; accepted retries and reads never send", async () => {
  try {
    const row = await panelInviteFixture("panel-invite-send");
    const review = await panelInviteView(row.id);
    const writes = graphWrites;
    const replies = await Promise.all(
      [1, 2].map(() => panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))),
    );
    assert.ok(replies.some((r) => r.status === 200));
    assert.ok(replies.every((r) => r.status === 200 || r.status === 409));
    assert.equal(graphWrites, writes + 1);
    const attempt = (await readAttemptForTest(row.id))[0];
    assert.equal(attempt.status, "accepted");
    assert.ok(attempt.panelSnapshot?.approvalToken);
    const event = [...remoteEvents.values()].find((e) => e.id === attempt.eventId)!;
    assert.equal(event.hideAttendees, true);
    assert.deepEqual(
      (event.attendees as Array<{ emailAddress: { address: string } }>)
        .map((a) => a.emailAddress.address)
        .sort(),
      ["owner@example.invalid", "panel@example.invalid"],
    );
    assert.equal((await panelInviteView(row.id)).status, "accepted");
    assert.equal(
      (await panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))).status,
      200,
    );
    // Candidate-only updater must not edit a panel guest meeting.
    assert.equal((await invitationChangeView(row.id)).status, "unavailable");
    assert.equal(graphWrites, writes + 1);
  } finally {
    invitationMailboxes.clear();
  }
});

test("a lost panel invitation response is reconciled by reads, never by sending again", async () => {
  try {
    const row = await panelInviteFixture("panel-invite-lost");
    const review = await panelInviteView(row.id);
    const writes = graphWrites;
    loseGraphReply = true;
    assert.equal(
      (await panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))).status,
      503,
    );
    assert.equal((await readAttemptForTest(row.id))[0].status, "attempted");
    assert.equal(
      (await panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))).status,
      409,
    );
    assert.equal((await panelInviteView(row.id)).status, "accepted");
    assert.equal(graphWrites, writes + 1);
  } finally {
    loseGraphReply = false;
    invitationMailboxes.clear();
  }
});

test("an uncertain panel attempt without a provider event never becomes retryable", async () => {
  try {
    const row = await panelInviteFixture("panel-invite-no-receipt");
    const review = await panelInviteView(row.id);
    const writes = graphWrites;
    failGraphBeforeWrite = true;
    assert.equal(
      (await panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))).status,
      503,
    );
    assert.equal((await panelInviteView(row.id)).status, "needs_review");
    assert.equal(
      (await panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))).status,
      409,
    );
    assert.equal(graphWrites, writes + 1);
  } finally {
    failGraphBeforeWrite = false;
    invitationMailboxes.clear();
  }
});

test("panel send rechecks hours, calendars, consent, recipient and mailbox against human approval", async () => {
  try {
    const row = await panelInviteFixture("panel-invite-stale");
    const review = await panelInviteView(row.id);
    const writes = graphWrites;
    const post = () => panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review));
    invitationMailboxes.set("employer-admin", {
      id: "replacement-mailbox",
      mail: "panel@example.invalid",
    });
    assert.equal((await post()).status, 409);
    invitationMailboxes.set("employer-admin", {
      id: "panel-member-mailbox",
      mail: "different@example.invalid",
    });
    assert.equal((await post()).status, 409);
    invitationMailboxes.set("employer-admin", {
      id: "panel-member-mailbox",
      mail: "panel@example.invalid",
    });
    await setHours("employer-admin", "UTC", []);
    assert.equal((await post()).status, 409);
    await cleanHours("employer-admin");
    panelFailed.add("employer-admin");
    assert.equal((await post()).status, 503);
    panelFailed.clear();
    await database
      .update(schema.candidatesTable)
      .set({ email: "changed@example.invalid" })
      .where(eq(schema.candidatesTable.id, "owner-candidate"));
    assert.equal((await post()).status, 409);
    await database
      .update(schema.candidatesTable)
      .set({ email: "owner@example.invalid" })
      .where(eq(schema.candidatesTable.id, "owner-candidate"));
    await panelApi("panel-consent", { enabled: false }, "employer-admin");
    assert.equal((await post()).status, 409);
    assert.equal(graphWrites, writes);
    assert.equal((await readAttemptForTest(row.id)).length, 0);
  } finally {
    panelFailed.clear();
    invitationMailboxes.clear();
    await cleanHours("employer-admin");
    await database
      .update(schema.candidatesTable)
      .set({ email: "owner@example.invalid" })
      .where(eq(schema.candidatesTable.id, "owner-candidate"));
  }
});

test("panel invite refuses pre-existing candidate invitations and fails closed on missing private storage", async () => {
  try {
    const row = await panelInviteFixture("panel-invite-existing");
    const review = await panelInviteView(row.id);
    const writes = graphWrites;
    await database.insert(schema.interviewCalendarInvitationAttemptsTable).values({
      scheduleId: row.id,
      applicationId: row.applicationId,
      candidateId: "owner-candidate",
      organizerId: "admin",
      recipientHash: "0".repeat(64),
      scheduleVersion: scheduleVersion(row),
      transactionId: "prior-candidate-only",
      status: "attempted",
      attemptedAt: new Date(),
    });
    assert.equal(
      (await panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))).status,
      409,
    );
    assert.equal((await panelInviteView(row.id)).status, "needs_review");
    await database.execute(
      sql.raw("GRANT SELECT ON interview_calendar_invitation_attempts TO lexy_app"),
    );
    try {
      assert.equal(
        (await panelApi(`schedules/${row.id}/panel-invitation`, panelInviteInput(review))).status,
        503,
      );
    } finally {
      await database.execute(
        sql.raw("REVOKE SELECT ON interview_calendar_invitation_attempts FROM lexy_app"),
      );
    }
    assert.equal(graphWrites, writes);
  } finally {
    invitationMailboxes.clear();
  }
});
test("saved panels persist atomically with a proposed time, private grants and no provider writes", async () => {
  const row = await seedSchedule("saved-panel-persist");
  await optIn();
  await optIn("employer-admin");
  const writes = graphWrites;
  const response = await savePanel(row, ["admin", "employer-admin"], "2035-11-01T11:00:00.000Z");
  assert.equal(response.status, 200);
  const result = (await response.json()) as Record<string, unknown>;
  const current = await saved(row.id);
  assert.equal(current.status, "pending");
  assert.equal(current.scheduledAt.toISOString(), "2035-11-01T11:00:00.000Z");
  assert.notEqual(current.panelRevision, null);
  assert.notEqual(candidateTimeVersion(current), candidateTimeVersion(row));
  assert.notEqual(scheduleVersion(current), scheduleVersion(row));
  const reread = await panelApi(`schedules/${row.id}/panel`);
  assert.deepEqual(await reread.json(), result);
  assert.equal(result.calendarReserved, false);
  assert.equal(result.invitationSent, false);
  assert.doesNotMatch(JSON.stringify(result), /mailboxHash|grantedAt|coordinatorId/);
  assert.equal(graphWrites, writes);
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.interviewSchedulePanelsTable);
    }),
  );
  assert.equal((await panelApi(`schedules/${row.id}/panel`, undefined, "owner")).status, 403);
});
test("failed panel saves preserve the old panel/time and stale concurrent saves have one winner", async () => {
  const row = await seedSchedule("saved-panel-conflict");
  await optIn();
  const first = await savePanel(row);
  assert.equal(first.status, 200);
  const current = await saved(row.id);
  const [panel] = await database
    .select()
    .from(schema.interviewSchedulePanelsTable)
    .where(eq(schema.interviewSchedulePanelsTable.scheduleId, row.id));
  panelBusy.set("admin", [
    {
      showAs: "busy",
      start: { dateTime: "2035-11-01T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2035-11-01T11:00:00", timeZone: "UTC" },
    },
  ]);
  try {
    assert.equal((await savePanel(current)).status, 409);
    assert.deepEqual(await saved(row.id), current);
    const [still] = await database
      .select()
      .from(schema.interviewSchedulePanelsTable)
      .where(eq(schema.interviewSchedulePanelsTable.scheduleId, row.id));
    assert.deepEqual(still, panel);
  } finally {
    panelBusy.clear();
  }
  const results = await Promise.all([savePanel(current), savePanel(current)]);
  assert.deepEqual(
    results.map((r) => r.status).sort(),
    [200, 409],
    JSON.stringify(await Promise.all(results.map((r) => r.clone().text()))),
  );
  assert.equal((await savePanel(await saved(row.id), ["outside-admin"])).status, 409);
  assert.equal((await savePanel(await saved(row.id), ["admin"], undefined, "owner")).status, 403);
});
test("candidate confirmation rechecks panel calendars and consent without exposing staff identities", async () => {
  const row = await seedSchedule("saved-panel-confirm");
  await optIn();
  assert.equal((await savePanel(row)).status, 200);
  const current = await saved(row.id);
  panelFailed.add("admin");
  try {
    const failed = await confirm(current);
    assert.equal(failed.status, 503);
    assert.doesNotMatch(
      JSON.stringify(await failed.json()),
      /admin|mailboxHash|grantedAt|@example/,
    );
    assert.deepEqual(await saved(row.id), current);
  } finally {
    panelFailed.clear();
  }
  await panelApi("panel-consent", { enabled: false });
  assert.equal((await confirm(current)).status, 409);
  await optIn();
  // Re-enabling sharing is not permission to revive an earlier saved grant.
  await database
    .update(schema.calendarPanelConsentsTable)
    .set({ grantedAt: new Date("2030-01-01T00:00:00Z") })
    .where(eq(schema.calendarPanelConsentsTable.userId, "admin"));
  assert.equal((await confirm(current)).status, 409);
  assert.equal((await savePanel(current)).status, 200);
  const fresh = await saved(row.id);
  const success = await confirm(fresh);
  assert.equal(success.status, 200);
  assert.equal((await saved(row.id)).status, "confirmed");
  const result = await success.json();
  assert.doesNotMatch(JSON.stringify(result), /members|mailbox|coordinatorId|admin/);
});
test("public booking cannot bypass a saved panel's current availability", async () => {
  const row = await seedSchedule("saved-panel-public");
  await optIn();
  assert.equal((await savePanel(row)).status, 200);
  const current = await saved(row.id);
  const minted = await mintBooking(current);
  assert.equal(minted.status, 200);
  const grant = await minted.json();
  const read = await publicBooking(grant.token);
  const proposal = (await read.json()).proposal;
  panelBusy.set("admin", [
    {
      showAs: "busy",
      start: { dateTime: "2035-11-01T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2035-11-01T11:00:00", timeZone: "UTC" },
    },
  ]);
  try {
    const response = await publicBooking(grant.token, {
      confirm: true,
      expectedVersion: candidateTimeVersion(current),
      expectedOfferVersion: proposal.offerVersion,
      scheduledAt: current.scheduledAt.toISOString(),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await saved(row.id), current);
  } finally {
    panelBusy.clear();
  }
});
test("panel removal retains a revision tombstone and cannot revive an old proposal", async () => {
  const row = await seedSchedule("saved-panel-removal");
  await optIn();
  assert.equal((await savePanel(row)).status, 200);
  const attached = await saved(row.id);
  await panelApi("panel-consent", { enabled: false });
  assert.equal((await savePanel(attached, [])).status, 200);
  const removed = await saved(row.id);
  assert.equal(removed.scheduledAt.getTime(), row.scheduledAt.getTime());
  assert.notEqual(removed.panelRevision, attached.panelRevision);
  assert.notEqual(candidateTimeVersion(removed), candidateTimeVersion(row));
  assert.equal((await confirm(row)).status, 409);
  assert.equal((await confirm(removed)).status, 200);
  await database
    .delete(schema.interviewSchedulesTable)
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  assert.deepEqual(
    await database
      .select()
      .from(schema.interviewSchedulePanelsTable)
      .where(eq(schema.interviewSchedulePanelsTable.scheduleId, row.id)),
    [],
  );
});
test("the shared staff-edit guard rechecks changed time and duration before any native write", async () => {
  const row = await seedSchedule("saved-panel-staff-edit");
  await optIn();
  assert.equal((await savePanel(row)).status, 200);
  const current = await saved(row.id);
  const { assertSavedPanel } = await import("../lib/interview-schedule-panel");
  panelBusy.set("admin", [
    {
      showAs: "busy",
      start: { dateTime: "2035-11-01T12:30:00", timeZone: "UTC" },
      end: { dateTime: "2035-11-01T13:30:00", timeZone: "UTC" },
    },
  ]);
  try {
    await assert.rejects(
      database.transaction(async (tx) => {
        // The isolated Drizzle fixture has no relational metadata; these helpers
        // use the real table objects and SQL, not relational query metadata.
        await assertSavedPanel(
          tx as unknown as Parameters<typeof assertSavedPanel>[0],
          current,
          "2035-11-01T12:00:00.000Z",
          60,
        );
        await tx
          .update(schema.interviewSchedulesTable)
          .set({ scheduledAt: new Date("2035-11-01T12:00:00Z") })
          .where(eq(schema.interviewSchedulesTable.id, row.id));
      }),
    );
    assert.deepEqual(await saved(row.id), current);
    await database.transaction(async (tx) => {
      await assertSavedPanel(
        tx as unknown as Parameters<typeof assertSavedPanel>[0],
        current,
        "2035-11-01T12:00:00.000Z",
        30,
      );
      await tx
        .update(schema.interviewSchedulesTable)
        .set({
          scheduledAt: new Date("2035-11-01T12:00:00Z"),
          durationMinutes: 30,
          status: "pending",
        })
        .where(eq(schema.interviewSchedulesTable.id, row.id));
    });
    const updated = await saved(row.id);
    assert.equal(updated.durationMinutes, 30);
    assert.equal(updated.panelRevision, current.panelRevision);
  } finally {
    panelBusy.clear();
    await panelApi("panel-consent", { enabled: false });
  }
});
test("missing saved-panel privacy protections cannot silently remove or save a panel", async () => {
  const row = await seedSchedule("saved-panel-private");
  await optIn();
  assert.equal((await savePanel(row)).status, 200);
  const current = await saved(row.id);
  await database.execute(sql`ALTER TABLE interview_schedule_panels DISABLE ROW LEVEL SECURITY`);
  try {
    assert.equal((await savePanel(current, [])).status, 503);
    assert.equal((await confirm(current)).status, 503);
    assert.deepEqual(await saved(row.id), current);
  } finally {
    await database.execute(sql`ALTER TABLE interview_schedule_panels ENABLE ROW LEVEL SECURITY`);
    await panelApi("panel-consent", { enabled: false });
  }
});

test("panel sharing is explicit, self-only, private and revocable without calendar access", async () => {
  const initial = await panelApi("panel-consent");
  assert.equal(initial.status, 200);
  assert.deepEqual(await initial.json(), { enabled: false, grantedAt: null });
  assert.equal((await panelApi("panel-consent", { enabled: true }, "owner")).status, 403);
  assert.equal((await panelApi("panel-consent", { enabled: true, userId: "owner" })).status, 400);
  await optIn();
  const stored = (await (await panelApi("panel-consent")).json()) as Record<string, unknown>;
  assert.equal(stored.enabled, true);
  assert.equal(typeof stored.grantedAt, "string");
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.calendarPanelConsentsTable);
    }),
  );
  // A broken/different connection cannot prevent an own-consent revocation.
  graphMailboxId = "";
  try {
    assert.equal((await panelApi("panel-consent", { enabled: false })).status, 200);
    assert.equal(
      ((await (await panelApi("panel-consent")).json()) as Record<string, unknown>).enabled,
      false,
    );
  } finally {
    graphMailboxId = "synthetic-mailbox";
  }
});
test("panel directory contains only active consenting organisational staff in work-order scope", async () => {
  const row = await seedSchedule("panel-directory");
  for (const user of [
    "admin",
    "employer-admin",
    "outside-admin",
    "unassigned-hm",
    "unassigned-interviewer",
  ])
    await optIn(user);
  const response = await panelApi(`schedules/${row.id}/panel-members`);
  assert.equal(response.status, 200);
  const result = (await response.json()) as { members: Array<{ id: string }> };
  const ids = result.members.map((m) => m.id);
  assert.ok(ids.includes("admin"));
  assert.ok(ids.includes("employer-admin"));
  assert.ok(ids.includes("unassigned-interviewer"));
  assert.ok(!ids.includes("outside-admin"));
  assert.ok(!ids.includes("unassigned-hm"));
  for (const member of result.members) assert.deepEqual(Object.keys(member).sort(), ["id", "name"]);
  assert.equal(
    (await panelApi(`schedules/${row.id}/panel-members`, undefined, "owner")).status,
    403,
  );
  assert.equal(
    (await panelApi(`schedules/${row.id}/panel-members`, undefined, "outside-admin")).status,
    404,
  );
  assert.equal(
    (await panelApi(`schedules/${row.id}/panel-members`, undefined, "unassigned-interviewer"))
      .status,
    403,
  );
});
test("panel search intersects all selected calendars without private event data or scheduling effects", async () => {
  const row = await seedSchedule("panel-common");
  await optIn();
  await optIn("employer-admin");
  panelBusy.set("admin", [
    {
      id: "private-secret",
      subject: "DO_NOT_EXPOSE_THIS_EVENT",
      showAs: "busy",
      start: { dateTime: "2035-11-01T09:00:00", timeZone: "UTC" },
      end: { dateTime: "2035-11-01T10:00:00", timeZone: "UTC" },
    },
  ]);
  panelBusy.set("employer-admin", [
    {
      id: "private-other",
      showAs: "tentative",
      start: { dateTime: "2035-11-01T10:00:00", timeZone: "UTC" },
      end: { dateTime: "2035-11-01T11:00:00", timeZone: "UTC" },
    },
  ]);
  const writes = graphWrites;
  try {
    const response = await panelApi(
      `schedules/${row.id}/panel-times`,
      panelInput(row, ["admin", "employer-admin"]),
    );
    assert.equal(response.status, 200);
    const result = (await response.json()) as {
      slots: Array<{ start: string; end: string }>;
      panelSize: number;
    };
    assert.equal(result.panelSize, 2);
    assert.deepEqual(result.slots, [
      { start: "2035-11-01T11:00:00.000Z", end: "2035-11-01T12:00:00.000Z" },
    ]);
    assert.doesNotMatch(
      JSON.stringify(result),
      /DO_NOT_EXPOSE|private-secret|busy|attendees|mailbox|subject/,
    );
    assert.deepEqual(await saved(row.id), row);
    assert.equal(graphWrites, writes);
  } finally {
    panelBusy.clear();
  }
});
test("failed or malformed member calendars never produce partial-panel free suggestions", async () => {
  const row = await seedSchedule("panel-failed-member");
  await optIn();
  await optIn("employer-admin");
  panelFailed.add("employer-admin");
  try {
    const response = await panelApi(
      `schedules/${row.id}/panel-times`,
      panelInput(row, ["admin", "employer-admin"]),
    );
    assert.equal(response.status, 503);
    assert.ok(!("slots" in ((await response.json()) as Record<string, unknown>)));
  } finally {
    panelFailed.clear();
  }
  panelBusy.set("admin", [{ showAs: "busy" }]);
  try {
    assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 503);
  } finally {
    panelBusy.clear();
  }
});
test("revoked sharing, foreign staff and stale native revisions fail before calendar availability reads", async () => {
  const row = await seedSchedule("panel-revoked");
  const reads = panelProviderReads;
  await panelApi("panel-consent", { enabled: false });
  assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 409);
  await optIn();
  assert.equal(
    (await panelApi(`schedules/${row.id}/panel-times`, panelInput(row, ["outside-admin"]))).status,
    409,
  );
  await database
    .update(schema.interviewSchedulesTable)
    .set({ durationMinutes: 45 })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 409);
  assert.equal(panelProviderReads, reads);
});
test("a switched Outlook mailbox needs fresh consent before panel availability is read", async () => {
  const row = await seedSchedule("panel-mailbox-switch");
  await optIn();
  const reads = panelProviderReads;
  graphMailboxId = "different-panel-mailbox";
  try {
    assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 409);
    assert.equal(panelProviderReads, reads);
    await optIn();
    assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 200);
  } finally {
    graphMailboxId = "synthetic-mailbox";
    await optIn();
  }
});
test("panel selection, range, staff role and protected storage fail closed", async () => {
  const row = await seedSchedule("panel-validation");
  const reads = panelProviderReads;
  for (const patch of [
    { userIds: [] },
    { userIds: ["admin", "admin"] },
    { userIds: Array.from({ length: 6 }, (_, i) => `staff-${i}`) },
    { end: "2035-11-03T11:00:00Z" },
    { bufferMinutes: 61 },
    { start: "not-an-instant" },
    { surprise: true },
  ])
    assert.equal(
      (await panelApi(`schedules/${row.id}/panel-times`, { ...panelInput(row), ...patch })).status,
      400,
    );
  assert.equal(
    (await panelApi(`schedules/${row.id}/panel-times`, panelInput(row), "owner")).status,
    403,
  );
  await database.execute(sql`ALTER TABLE calendar_panel_consents DISABLE ROW LEVEL SECURITY`);
  try {
    assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 503);
    assert.equal((await panelApi("panel-consent", { enabled: true })).status, 503);
  } finally {
    await database.execute(sql`ALTER TABLE calendar_panel_consents ENABLE ROW LEVEL SECURITY`);
  }
  assert.equal(panelProviderReads, reads);
});
test("unapproved or closed schedules cannot expose panel times", async () => {
  const row = await seedSchedule("panel-closed");
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "cancelled" })
    .where(eq(schema.interviewSchedulesTable.id, row.id));
  const reads = panelProviderReads;
  assert.equal((await panelApi(`schedules/${row.id}/panel-times`, panelInput(row))).status, 404);
  assert.equal((await panelApi(`schedules/${row.id}/panel-members`)).status, 404);
  assert.equal(panelProviderReads, reads);
});

test("a staff-only explicit POST invites the candidate once and retains a private receipt", async () => {
  const schedule = await seedSchedule("invitation-accepted");
  assert.equal((await confirm(schedule)).status, 200);
  const current = await saved(schedule.id);
  assert.equal(
    (await candidateCalendarRequest(schedule.id, "GET", undefined, "owner")).status,
    403,
  );
  const initial = await candidateCalendarRequest(schedule.id);
  assert.equal(initial.status, 200);
  const proposal = (await initial.json()) as Record<string, unknown>;
  assert.deepEqual(Object.keys(proposal).sort(), [
    "acceptedAt",
    "durationMinutes",
    "recipientEmail",
    "scheduleId",
    "scheduledAt",
    "status",
    "version",
  ]);
  assert.equal(proposal.status, "not_sent");
  assert.equal(proposal.recipientEmail, "owner@example.invalid");
  assert.equal(proposal.version, scheduleVersion(current));
  const before = graphWrites;
  const input = {
    confirm: true,
    expectedVersion: scheduleVersion(current),
    expectedRecipientEmail: "owner@example.invalid",
  };
  const sent = await candidateCalendarRequest(schedule.id, "POST", input);
  assert.equal(sent.status, 200);
  const receipt = (await sent.json()) as Record<string, unknown>;
  assert.equal(receipt.status, "accepted");
  assert.equal(graphWrites, before + 1);
  assert.equal((await candidateCalendarRequest(schedule.id, "POST", input)).status, 409);
  assert.equal(graphWrites, before + 1);
  assert.equal(
    ((await (await candidateCalendarRequest(schedule.id)).json()) as Record<string, unknown>)
      .status,
    "accepted",
  );
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.interviewCalendarInvitationAttemptsTable);
    }),
  );
});

test("wrong recipient, stale confirmation and unfinished native schedules cannot send", async () => {
  const schedule = await seedSchedule("invitation-stale");
  const before = graphWrites;
  assert.equal(
    (
      await candidateCalendarRequest(schedule.id, "POST", {
        confirm: true,
        expectedVersion: scheduleVersion(schedule),
        expectedRecipientEmail: "owner@example.invalid",
      })
    ).status,
    409,
  );
  assert.equal((await confirm(schedule)).status, 200);
  const current = await saved(schedule.id);
  assert.equal(
    (
      await candidateCalendarRequest(schedule.id, "POST", {
        confirm: true,
        expectedVersion: scheduleVersion(schedule),
        expectedRecipientEmail: "owner@example.invalid",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await candidateCalendarRequest(schedule.id, "POST", {
        confirm: true,
        expectedVersion: scheduleVersion(current),
        expectedRecipientEmail: "another@example.invalid",
      })
    ).status,
    409,
  );
  assert.equal(graphWrites, before);
  const [attempt] = await database
    .select()
    .from(schema.interviewCalendarInvitationAttemptsTable)
    .where(eq(schema.interviewCalendarInvitationAttemptsTable.scheduleId, schedule.id));
  assert.equal(attempt, undefined);
});

test("a lost provider response is reconciled by read only, never by retrying POST", async () => {
  const schedule = await seedSchedule("invitation-lost-response");
  assert.equal((await confirm(schedule)).status, 200);
  const current = await saved(schedule.id);
  loseGraphReply = true;
  const before = graphWrites;
  const input = {
    confirm: true,
    expectedVersion: scheduleVersion(current),
    expectedRecipientEmail: "owner@example.invalid",
  };
  const response = await candidateCalendarRequest(schedule.id, "POST", input);
  assert.equal(response.status, 503);
  assert.equal(graphWrites, before + 1);
  const recovered = await candidateCalendarRequest(schedule.id);
  assert.equal(recovered.status, 200);
  assert.equal(((await recovered.json()) as Record<string, unknown>).status, "accepted");
  assert.equal(graphWrites, before + 1);
  assert.equal((await candidateCalendarRequest(schedule.id, "POST", input)).status, 409);
  assert.equal(graphWrites, before + 1);
});

test("an unconfirmed provider attempt stays under human review and cannot auto-resend", async () => {
  const schedule = await seedSchedule("invitation-review");
  assert.equal((await confirm(schedule)).status, 200);
  failGraphBeforeWrite = true;
  const before = graphWrites;
  const input = {
    confirm: true,
    expectedVersion: scheduleVersion(await saved(schedule.id)),
    expectedRecipientEmail: "owner@example.invalid",
  };
  assert.equal((await candidateCalendarRequest(schedule.id, "POST", input)).status, 503);
  assert.equal(graphWrites, before + 1);
  assert.equal(
    ((await (await candidateCalendarRequest(schedule.id)).json()) as Record<string, unknown>)
      .status,
    "needs_review",
  );
  assert.equal((await candidateCalendarRequest(schedule.id, "POST", input)).status, 409);
  assert.equal(graphWrites, before + 1);
});

test("missing invitation migration or privacy barrier fails closed before Graph writes", async () => {
  const schedule = await seedSchedule("invitation-missing-guard");
  assert.equal((await confirm(schedule)).status, 200);
  const before = graphWrites;
  await database.execute(sql`ALTER TABLE interview_calendar_invitation_attempts
    DISABLE TRIGGER lexy_erasure_write_barrier`);
  try {
    assert.equal((await candidateCalendarRequest(schedule.id)).status, 503);
    assert.equal(
      (
        await candidateCalendarRequest(schedule.id, "POST", {
          confirm: true,
          expectedVersion: scheduleVersion(await saved(schedule.id)),
          expectedRecipientEmail: "owner@example.invalid",
        })
      ).status,
      503,
    );
  } finally {
    await database.execute(sql`ALTER TABLE interview_calendar_invitation_attempts
      ENABLE TRIGGER lexy_erasure_write_barrier`);
  }
  assert.equal(graphWrites, before);
  assert.equal((await candidateCalendarRequest(schedule.id)).status, 200);
});

test("a real row-lock race preserves the concurrent staff edit and rejects confirmation", async () => {
  const schedule = await seedSchedule("staff-race");
  let request: Promise<Response> | undefined;
  await database.transaction(async (tx) => {
    const result = await tx.execute(sql`SELECT pg_backend_pid() AS pid`);
    const blocker = result.rows[0].pid as number;
    await tx
      .update(schema.interviewSchedulesTable)
      .set({ notes: "Concurrent private edit" })
      .where(eq(schema.interviewSchedulesTable.id, schedule.id));
    request = confirm(schedule);
    const deadline = Date.now() + 8000;
    let blocked = false;
    while (Date.now() < deadline) {
      const result = await database.execute(sql`
        SELECT EXISTS (
          SELECT 1 FROM pg_catalog.pg_stat_activity
          WHERE ${blocker} = ANY(pg_catalog.pg_blocking_pids(pid))
        ) AS blocked
      `);
      if (result.rows[0].blocked === true) {
        blocked = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    assert.equal(blocked, true, "Candidate write never reached the held row lock");
  });
  assert.ok(request);
  assert.equal((await request).status, 409);
  const row = await saved(schedule.id);
  assert.equal(row.status, "pending");
  assert.equal(row.notes, "Concurrent private edit");
  assert.equal((await events(schedule.id)).length, 0);
});

async function googleApi(id: string, input?: unknown, userId = "admin") {
  return fetch(`${base}/google-calendar/schedules/${id}/panel`, {
    method: input === undefined ? "GET" : "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
    },
    ...(input === undefined ? {} : { body: JSON.stringify(input) }),
  });
}
async function googleFixture(id: string) {
  const row = await seedSchedule(id);
  const time = new Date(Date.now() + 86400_000);
  time.setUTCHours(12, 0, 0, 0);
  await database
    .update(schema.interviewSchedulesTable)
    .set({
      scheduledAt: time,
      interviewerId: "admin",
    })
    .where(eq(schema.interviewSchedulesTable.id, id));
  for (const [userId, tenantId] of [
    ["admin", "portal-home"],
    ["employer-admin", "employer"],
  ]) {
    const revision = "11111111-1111-4111-8111-111111111111";
    const grant = {
      userId,
      tenantId,
      revision,
      clientFingerprint: "synthetic-google-config",
      subject: `private-subject-${userId}`,
      accountEmail: `${userId}@example.invalid`,
      refreshTokenEnc: `synthetic-cipher-${userId}`,
      connectedAt: new Date(),
      needsReconnect: false,
    };
    await database.insert(schema.staffGoogleCalendarsTable).values(grant).onConflictDoUpdate({
      target: schema.staffGoogleCalendarsTable.userId,
      set: grant,
    });
    const consent = { userId, tenantId, connectionRevision: revision, grantedAt: new Date() };
    await database.insert(schema.googlePanelConsentsTable).values(consent).onConflictDoUpdate({
      target: schema.googlePanelConsentsTable.userId,
      set: consent,
    });
    await setHours(
      userId,
      "UTC",
      Array.from({ length: 7 }, (_, day) => ({
        day,
        start: "00:00",
        end: "23:59",
      })),
    );
  }
  return saved(row.id);
}
function googleInput(
  row: Awaited<ReturnType<typeof saved>>,
  userIds = ["admin", "employer-admin"],
) {
  return {
    expectedVersion: scheduleVersion(row),
    userIds,
    scheduledAt: row.scheduledAt.toISOString(),
    bufferMinutes: 15,
  };
}
test("Google panel save survives reread, stays private and rechecks real native candidate confirmation", async () => {
  const row = await googleFixture("google-native-save");
  const writes = graphWrites;
  const response = await googleApi(row.id, googleInput(row));
  assert.equal(response.status, 200, await response.clone().text());
  const view = (await response.json()) as SavedSchedulePanel;
  assert.equal(view.provider, "google");
  assert.deepEqual(
    view.members.map((m: { id: string }) => m.id),
    ["admin", "employer-admin"],
  );
  assert.equal(view.calendarReserved, false);
  assert.equal(view.invitationSent, false);
  assert.doesNotMatch(
    JSON.stringify(view),
    /subject|connectionRevision|grantedAt|cipher|mailboxHash/,
  );
  assert.deepEqual(await (await googleApi(row.id)).json(), view);
  const current = await saved(row.id);
  assert.equal(current.status, "pending");
  assert.notEqual(scheduleVersion(current), scheduleVersion(row));
  assert.equal(view.version, scheduleVersion(current));
  assert.notEqual(candidateTimeVersion(current), candidateTimeVersion(row));
  const [privatePanel] = await database
    .select()
    .from(schema.interviewSchedulePanelsTable)
    .where(eq(schema.interviewSchedulePanelsTable.scheduleId, row.id));
  assert.equal(privatePanel.members.length, 2);
  assert.ok(privatePanel.members.every((m) => "provider" in m && m.provider === "google"));
  assert.doesNotMatch(JSON.stringify(privatePanel.members), /mailboxHash|private-subject|cipher/);
  const beforeReads = googleReads;
  assert.equal((await confirm(current)).status, 200);
  assert.ok(googleReads > beforeReads);
  assert.equal(graphWrites, writes);
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.interviewSchedulePanelsTable);
    }),
  );
});
test("Google saves reject stale and busy panels; token rotation survives provider failure and removal needs no Google config", async () => {
  const row = await googleFixture("google-native-race");
  const responses = await Promise.all([
    googleApi(row.id, googleInput(row)),
    googleApi(row.id, googleInput(row)),
  ]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
  const attached = await saved(row.id);
  googleBusy = true;
  try {
    assert.equal((await googleApi(row.id, googleInput(attached))).status, 409);
    assert.deepEqual(await saved(row.id), attached);
  } finally {
    googleBusy = false;
  }
  googleRotates = true;
  googleFailure = true;
  try {
    assert.equal((await googleApi(row.id, googleInput(attached))).status, 503);
    const [grant] = await database
      .select()
      .from(schema.staffGoogleCalendarsTable)
      .where(eq(schema.staffGoogleCalendarsTable.userId, "admin"));
    assert.match(grant.refreshTokenEnc!, /-rotated$/);
    assert.deepEqual(await saved(row.id), attached);
  } finally {
    googleRotates = false;
    googleFailure = false;
  }
  googleConfigured = false;
  try {
    const result = await googleApi(row.id, { ...googleInput(attached, []), bufferMinutes: 0 });
    assert.equal(result.status, 200, await result.clone().text());
    const view = (await result.json()) as SavedSchedulePanel;
    assert.equal(view.provider, null);
    assert.deepEqual(view.members, []);
    assert.equal(view.scheduledAt, attached.scheduledAt.toISOString());
    assert.notEqual(view.version, scheduleVersion(attached));
    assert.equal((await googleApi(row.id)).status, 200);
    const [tombstone] = await database
      .select()
      .from(schema.interviewSchedulePanelsTable)
      .where(eq(schema.interviewSchedulePanelsTable.scheduleId, row.id));
    assert.ok(tombstone.revision);
    assert.deepEqual(tombstone.members, []);
  } finally {
    googleConfigured = true;
  }
});
test("Google panel confirmation rejects changed identity, withdrawn sharing and lost calendar availability", async () => {
  const row = await googleFixture("google-native-recheck");
  assert.equal((await googleApi(row.id, googleInput(row))).status, 200);
  const attached = await saved(row.id);
  await database
    .update(schema.staffGoogleCalendarsTable)
    .set({ subject: "different-private-subject" })
    .where(eq(schema.staffGoogleCalendarsTable.userId, "admin"));
  const reads = googleReads;
  assert.equal((await confirm(attached)).status, 409);
  assert.equal(googleReads, reads, "Changed saved identity must fail before provider reads");
  await database
    .update(schema.staffGoogleCalendarsTable)
    .set({ subject: "private-subject-admin" })
    .where(eq(schema.staffGoogleCalendarsTable.userId, "admin"));
  googleBusy = true;
  try {
    assert.equal((await confirm(attached)).status, 409);
  } finally {
    googleBusy = false;
  }
  await database
    .delete(schema.googlePanelConsentsTable)
    .where(eq(schema.googlePanelConsentsTable.userId, "admin"));
  assert.equal((await confirm(attached)).status, 409);
  assert.deepEqual(await saved(row.id), attached);
});
test("Google and Outlook controls cannot overwrite each other's panels and staff scope is enforced", async () => {
  const row = await googleFixture("google-native-provider");
  assert.equal((await googleApi(row.id, googleInput(row, ["employer-admin"]))).status, 409);
  assert.equal((await googleApi(row.id, googleInput(row), "owner")).status, 403);
  assert.equal((await googleApi(row.id, undefined, "outside-admin")).status, 404);
  assert.equal((await googleApi("missing", undefined, "outside-admin")).status, 404);
  assert.equal((await googleApi(row.id, googleInput(row))).status, 200);
  const attached = await saved(row.id);
  assert.equal((await savePanel(attached)).status, 409);
  assert.deepEqual(await saved(row.id), attached);
  const other = await googleFixture("google-native-outlook");
  await optIn();
  assert.equal((await savePanel(other)).status, 200);
  const outlook = await saved(other.id);
  const reads = googleReads;
  assert.equal((await googleApi(other.id, googleInput(outlook))).status, 409);
  assert.equal(
    (await googleApi(other.id, { ...googleInput(outlook, []), bufferMinutes: 0 })).status,
    409,
  );
  assert.equal(googleReads, reads);
  assert.deepEqual(await saved(other.id), outlook);
});
test("Google panel insert failure rolls the native time/revision back atomically", async () => {
  const row = await googleFixture("google-native-rollback");
  await database.execute(
    sql.raw(`
    CREATE FUNCTION reject_google_panel_fixture() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.schedule_id='google-native-rollback' THEN RAISE EXCEPTION 'synthetic panel failure'; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER reject_google_panel_fixture BEFORE INSERT OR UPDATE ON interview_schedule_panels
      FOR EACH ROW EXECUTE FUNCTION reject_google_panel_fixture();
  `),
  );
  try {
    const response = await googleApi(row.id, googleInput(row));
    assert.equal(response.status, 503);
    assert.doesNotMatch(await response.text(), /synthetic panel failure|cipher|subject/);
    assert.deepEqual(await saved(row.id), row);
    const panels = await database
      .select()
      .from(schema.interviewSchedulePanelsTable)
      .where(eq(schema.interviewSchedulePanelsTable.scheduleId, row.id));
    assert.equal(panels.length, 0);
  } finally {
    await database.execute(
      sql.raw(
        "DROP TRIGGER reject_google_panel_fixture ON interview_schedule_panels; DROP FUNCTION reject_google_panel_fixture()",
      ),
    );
  }
});

test("Google saved panels guard public booking without exposing roster or account bindings", async () => {
  const row = await googleFixture("google-native-public");
  assert.equal((await googleApi(row.id, googleInput(row))).status, 200);
  const current = await saved(row.id);
  const minted = await mintBooking(current);
  assert.equal(minted.status, 200, await minted.clone().text());
  const grant = await minted.json();
  const read = await publicBooking(grant.token);
  assert.equal(read.status, 200);
  const body = await read.json();
  assert.ok(body.proposal);
  assert.doesNotMatch(
    JSON.stringify(body),
    /employer-admin|connectionRevision|subjectHash|grantedAt|cipher/,
  );
  const input = {
    confirm: true,
    expectedVersion: candidateTimeVersion(current),
    expectedOfferVersion: body.proposal.offerVersion,
    scheduledAt: current.scheduledAt.toISOString(),
  };
  googleBusy = true;
  try {
    assert.equal((await publicBooking(grant.token, input)).status, 409);
    assert.deepEqual(await saved(row.id), current);
  } finally {
    googleBusy = false;
  }
  const confirmed = await publicBooking(grant.token, input);
  assert.equal(confirmed.status, 200, await confirmed.clone().text());
});

test("Google saved-panel staff edit guard checks the proposed duration and fails closed on unknown calendars", async () => {
  const row = await googleFixture("google-native-duration");
  assert.equal((await googleApi(row.id, googleInput(row))).status, 200);
  const current = await saved(row.id);
  const { assertSavedPanel } = await import("../lib/interview-schedule-panel");
  const check = () =>
    database.transaction((tx) =>
      assertSavedPanel(
        tx as unknown as Parameters<typeof assertSavedPanel>[0],
        current,
        current.scheduledAt.toISOString(),
        90,
      ),
    );
  await check();
  googleFailure = true;
  try {
    await assert.rejects(check());
  } finally {
    googleFailure = false;
  }
  assert.deepEqual(await saved(row.id), current);
});

test("Google candidate confirmation honors a normal recruiter's current assignment without widening candidate RLS", async () => {
  const row = await googleFixture("google-native-recruiter");
  const [job] = await database
    .select()
    .from(schema.jobsTable)
    .where(eq(schema.jobsTable.id, "job"));
  const [tenant] = await database
    .select()
    .from(schema.tenantsTable)
    .where(eq(schema.tenantsTable.id, "employer"));
  const [candidate] = await database
    .select()
    .from(schema.candidatesTable)
    .where(eq(schema.candidatesTable.id, "owner-candidate"));
  const [owner] = await database
    .select()
    .from(schema.usersTable)
    .where(eq(schema.usersTable.id, "owner"));
  const id = "google-assigned-recruiter";
  await database.insert(schema.usersTable).values({
    id,
    tenantId: "agency",
    email: "google-fixture@example.invalid",
    name: "Fixture recruiter",
    passwordHash: "not-a-real-password",
    role: "recruiter",
  });
  try {
    // A normal agency recruiter can read its own talent row, not a portal-home
    // tenant-pool row belonging to another organisation.
    await database
      .update(schema.candidatesTable)
      .set({ tenantId: "agency" })
      .where(eq(schema.candidatesTable.id, "owner-candidate"));
    // Canonical portal identity requires profile and account home to agree.
    await database
      .update(schema.usersTable)
      .set({ tenantId: "agency" })
      .where(eq(schema.usersTable.id, "owner"));
    await database
      .update(schema.tenantsTable)
      .set({ parentId: "agency" })
      .where(eq(schema.tenantsTable.id, "employer"));
    await database
      .update(schema.jobsTable)
      .set({ assignedRecruiterId: id })
      .where(eq(schema.jobsTable.id, "job"));
    // Existing calendar coordination also requires the caller to be the
    // assigned interviewer. Preserve that ceiling rather than weakening it.
    await database
      .update(schema.interviewSchedulesTable)
      .set({ interviewerId: id })
      .where(eq(schema.interviewSchedulesTable.id, row.id));
    const [grant] = await database
      .select()
      .from(schema.staffGoogleCalendarsTable)
      .where(eq(schema.staffGoogleCalendarsTable.userId, "admin"));
    await database.insert(schema.staffGoogleCalendarsTable).values({
      ...grant,
      userId: id,
      tenantId: "agency",
      subject: `private-subject-${id}`,
      accountEmail: "google-fixture@example.invalid",
      refreshTokenEnc: "synthetic-recruiter-cipher",
    });
    await database.insert(schema.googlePanelConsentsTable).values({
      userId: id,
      tenantId: "agency",
      connectionRevision: grant.revision,
      grantedAt: new Date(),
    });
    await setHours(
      id,
      "UTC",
      Array.from({ length: 7 }, (_, day) => ({
        day,
        start: "00:00",
        end: "23:59",
      })),
    );
    const initial = await saved(row.id);
    const response = await googleApi(row.id, googleInput(initial, [id, "employer-admin"]), id);
    assert.equal(response.status, 200, await response.clone().text());
    const attached = await saved(row.id);
    const readContext = async () => {
      const response = await fetch(`${base}/fixture-request-context`, {
        headers: {
          Authorization: `Bearer ${issueToken({ userId: "owner", role: "candidate", tenantId: "agency" })}`,
        },
      });
      assert.equal(response.status, 200);
      return response.json() as Promise<{
        role: string;
        candidate_id: string;
        visibleJobs: number;
      }>;
    };
    const beforeContext = await readContext();
    const confirmed = await confirm(attached);
    assert.equal(confirmed.status, 200, await confirmed.clone().text());
    assert.deepEqual(await readContext(), beforeContext);
    assert.equal(beforeContext.role, "lexy_app");
    assert.equal(beforeContext.candidate_id, "owner-candidate");
    await database
      .update(schema.jobsTable)
      .set({ assignedRecruiterId: null })
      .where(eq(schema.jobsTable.id, "job"));
    await database
      .update(schema.interviewSchedulesTable)
      .set({ status: "pending" })
      .where(eq(schema.interviewSchedulesTable.id, row.id));
    assert.equal((await confirm(await saved(row.id))).status, 409);
  } finally {
    await database
      .update(schema.candidatesTable)
      .set({ tenantId: candidate.tenantId })
      .where(eq(schema.candidatesTable.id, "owner-candidate"));
    await database
      .update(schema.usersTable)
      .set({ tenantId: owner.tenantId })
      .where(eq(schema.usersTable.id, "owner"));
    await database
      .update(schema.jobsTable)
      .set({ assignedRecruiterId: job.assignedRecruiterId })
      .where(eq(schema.jobsTable.id, "job"));
    await database
      .update(schema.tenantsTable)
      .set({ parentId: tenant.parentId })
      .where(eq(schema.tenantsTable.id, "employer"));
  }
});

async function zoomApi(
  id: string,
  method = "GET",
  body?: unknown,
  userId = "admin",
  review = false,
) {
  return fetch(`${base}/zoom/schedules/${id}/${review ? "link-review" : "link"}`, {
    method,
    headers: {
      Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function zoomCandidate(id: string, userId = "owner") {
  return fetch(`${base}/portal/interview-schedules/${id}/zoom-link`, {
    headers: {
      Authorization: `Bearer ${issueToken({ userId, role: "candidate", tenantId: "portal-home" })}`,
    },
  });
}
async function zoomPrepared(id: string) {
  // Independent requisitions prevent unrelated roster changes in earlier scenarios
  // from altering the recipients or expected counts in a Zoom assertion.
  const jobId = `zoom-job:${id}`,
    applicationId = `zoom-application:${id}`;
  await database.insert(schema.jobsTable).values({
    id: jobId,
    tenantId: "employer",
    title: "Synthetic Zoom appointment",
    description: "Private scheduling fixture",
    status: "active",
  });
  await database.insert(schema.applicationsTable).values({
    id: applicationId,
    tenantId: "agency",
    candidateId: "owner-candidate",
    jobId,
  });
  await seedSchedule(id, "agency", applicationId);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "confirmed" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  const draft = {
    expectedVersion: scheduleVersion(await saved(id)),
    expectedPublicationId: null,
    joinUrl: "https://us02web.zoom.us/j/12345678901?pwd=synthetic",
  };
  const response = await zoomApi(id, "POST", draft, "admin", true);
  assert.equal(response.status, 200, await response.clone().text());
  const review = (await response.json()) as {
    approvalToken: string;
    reviewExpiresAt: string;
    version: string;
    publicationId: string | null;
  };
  return {
    draft,
    approval: {
      ...draft,
      confirm: true,
      approvalToken: review.approvalToken,
      reviewExpiresAt: review.reviewExpiresAt,
    },
  };
}

test("Zoom staff publication persists and only the canonical candidate sees the participant link", async () => {
  const id = "zoom-publication",
    { approval, draft } = await zoomPrepared(id);
  const writes = graphWrites;
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  const reread = (await (await zoomApi(id)).json()) as { state: string; publicationId: string };
  assert.equal(reread.state, "published");
  assert.ok(reread.publicationId);
  const candidate = await zoomCandidate(id);
  assert.equal(candidate.status, 200);
  assert.deepEqual(await candidate.json(), {
    scheduleId: id,
    status: "available",
    joinUrl: draft.joinUrl,
    source: "staff_provided",
    providerVerified: false,
  });
  assert.equal((await zoomCandidate(id, "other")).status, 404);
  assert.equal((await zoomApi(id, "GET", undefined, "owner")).status, 403);
  assert.equal((await zoomApi(id, "GET", undefined, "outside-admin")).status, 404);
  assert.equal(graphWrites, writes);
  await assert.rejects(
    database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE lexy_app`);
      await tx.select().from(schema.interviewZoomLinksTable);
    }),
  );
});

test("Zoom review binds staff, exact URL, publication, native version and explicit confirmation", async () => {
  const id = "zoom-binding",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", { ...approval, confirm: false })).status, 400);
  assert.equal(
    (await zoomApi(id, "PUT", { ...approval, joinUrl: "https://zoom.us/j/999999999" })).status,
    409,
  );
  assert.equal(
    (await zoomApi(id, "PUT", { ...approval, approvalToken: `zl_${"0".repeat(64)}` })).status,
    409,
  );
  const outcomes = await Promise.all([zoomApi(id, "PUT", approval), zoomApi(id, "PUT", approval)]);
  assert.deepEqual(outcomes.map((r) => r.status).sort(), [200, 409]);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 409);
});

test("Zoom removal retains a tombstone, works after cancellation and never cancels an external meeting", async () => {
  const id = "zoom-removal",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  const before = (await (await zoomApi(id)).json()) as { publicationId: string; version: string };
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "cancelled" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  assert.equal(((await (await zoomCandidate(id)).json()) as { joinUrl: unknown }).joinUrl, null);
  const current = (await (await zoomApi(id)).json()) as { publicationId: string; version: string };
  assert.equal(
    (
      await zoomApi(id, "DELETE", {
        confirm: true,
        expectedVersion: before.version,
        expectedPublicationId: before.publicationId,
      })
    ).status,
    409,
  );
  const removed = await zoomApi(id, "DELETE", {
    confirm: true,
    expectedVersion: current.version,
    expectedPublicationId: current.publicationId,
  });
  assert.equal(removed.status, 200);
  const body = (await removed.json()) as { state: string; joinUrl: unknown; publicationId: string };
  assert.equal(body.state, "none");
  assert.equal(body.joinUrl, null);
  assert.notEqual(body.publicationId, current.publicationId);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "confirmed" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  // Restoring identical native time/status cannot revive a removed publication.
  assert.equal((await zoomApi(id, "PUT", approval)).status, 409);
  assert.equal(((await (await zoomCandidate(id)).json()) as { joinUrl: unknown }).joinUrl, null);
});

test("Zoom publication hides changed times but not private feedback and suppresses conflicting calendar invitations", async () => {
  const id = "zoom-staleness",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ feedbackNotes: "Private staff note" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "available",
  );
  const row = await saved(id);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ scheduledAt: new Date(row.scheduledAt.getTime() + 60_000) })
    .where(eq(schema.interviewSchedulesTable.id, id));
  assert.equal(((await (await zoomCandidate(id)).json()) as { joinUrl: unknown }).joinUrl, null);
  assert.equal(((await (await zoomApi(id)).json()) as { state: string }).state, "stale");
  const other = "zoom-conflict",
    fresh = await zoomPrepared(other);
  assert.equal((await zoomApi(other, "PUT", fresh.approval)).status, 200);
  // Existing actual invitation endpoint creates the receipt; no synthetic bypass.
  const invitation = await candidateCalendarRequest(other, "POST", {
    confirm: true,
    expectedVersion: scheduleVersion(await saved(other)),
    expectedRecipientEmail: "owner@example.invalid",
  });
  assert.equal(invitation.status, 200, await invitation.clone().text());
  assert.equal(((await (await zoomCandidate(other)).json()) as { joinUrl: unknown }).joinUrl, null);
  const status = (await (await zoomApi(other)).json()) as { reason: string; canPublish: boolean };
  assert.equal(status.reason, "calendar_invitation_exists");
  assert.equal(status.canPublish, false);
});

test("Zoom erasure barrier rejects late private-link persistence without logging or exposing its URL", async () => {
  const id = "zoom-erasure",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  await database.transaction(async (tx) => {
    await tx.execute(sql`SAVEPOINT zoom_erasure_fixture`);
    await tx
      .update(schema.candidatesTable)
      .set({ dataErasedAt: new Date() })
      .where(eq(schema.candidatesTable.id, "owner-candidate"));
    await assert.rejects(
      tx
        .update(schema.interviewZoomLinksTable)
        .set({ joinUrl: "https://zoom.us/j/999999999" })
        .where(eq(schema.interviewZoomLinksTable.scheduleId, id)),
    );
    await tx.execute(sql`ROLLBACK TO SAVEPOINT zoom_erasure_fixture`);
  });
  const { CANDIDATE_LINKED_TABLES } = await import("../lib/candidate-erasure");
  assert.ok(CANDIDATE_LINKED_TABLES.includes("interview_zoom_links"));
});

async function zoomNotices(id: string) {
  const { createHash } = await import("node:crypto");
  const start = `zoom-stale:${createHash("sha256").update(id).digest("hex")}:`;
  return database
    .select()
    .from(schema.userNotificationsTable)
    .where(
      and(
        eq(schema.userNotificationsTable.type, "zoom_link_stale"),
        sql`${schema.userNotificationsTable.id} LIKE ${`${start}%`}`,
      ),
    );
}
async function reconcileZoom(id: string) {
  const { reconcileZoomLinkAlerts } = await import("../lib/zoom-link-alerts");
  // The owned fixture clones table SQL without Drizzle's relational metadata.
  return database.transaction((tx) => reconcileZoomLinkAlerts(tx as unknown as PanelTx, id));
}
async function changeZoomTime(id: string, minutes = 1) {
  await database
    .update(schema.interviewSchedulesTable)
    .set({ scheduledAt: new Date(proposedAt.getTime() + minutes * 60_000) })
    .where(eq(schema.interviewSchedulesTable.id, id));
}

test("Zoom stale alerts are recipient-owned, private, durable and deduped across concurrent sweeps", async () => {
  const id = "zoom-alert-dedupe",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  assert.equal(await reconcileZoom(id), 0);
  await changeZoomTime(id);
  assert.deepEqual((await Promise.all([reconcileZoom(id), reconcileZoom(id)])).sort(), [0, 1]);
  let rows = await zoomNotices(id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.userId, "admin");
  assert.equal(rows[0]!.tenantId, "portal-home");
  assert.equal(rows[0]!.actionUrl, "/coordinator");
  const visible = `${rows[0]!.title} ${rows[0]!.message} ${rows[0]!.actionUrl}`;
  for (const secret of ["synthetic", "owner@example.invalid", "12345678901", "?pwd=", "https:", id])
    assert.equal(visible.includes(secret), false);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ feedbackNotes: "Private revision" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  assert.equal(await reconcileZoom(id), 0);
  await database
    .update(schema.userNotificationsTable)
    .set({ isRead: true })
    .where(eq(schema.userNotificationsTable.id, rows[0]!.id));
  assert.equal(await reconcileZoom(id), 0);
  rows = await zoomNotices(id);
  assert.equal(rows[0]!.isRead, true, "a repeated scan must not unread a receipt");
  await changeZoomTime(id, 2);
  assert.equal(await reconcileZoom(id), 1);
  rows = await zoomNotices(id);
  assert.equal(rows.length, 2);
  assert.equal(rows.filter((row) => !row.isRead).length, 1);

  const inbox = (userId: string) =>
    fetch(`${base}/user-notifications?limit=100`, {
      headers: {
        Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
      },
    });
  const ownerResponse = await inbox("admin");
  assert.equal(ownerResponse.status, 200);
  assert.ok(
    ((await ownerResponse.json()) as { id: string }[]).some((row) => row.id === rows[1]!.id),
  );
  const foreignResponse = await inbox("outside-admin");
  assert.equal(foreignResponse.status, 200);
  assert.equal(
    ((await foreignResponse.json()) as { id: string }[]).some((row) =>
      rows.some((r) => r.id === row.id),
    ),
    false,
  );
  // The existing generic history API permits canonical users to read their own
  // rows. Forging a staff JWT role must not expose another recipient's alerts.
  const candidateResponse = await inbox("owner");
  assert.equal(candidateResponse.status, 200);
  assert.equal(
    ((await candidateResponse.json()) as { id: string }[]).some((row) =>
      rows.some((r) => r.id === row.id),
    ),
    false,
  );
});

test("Zoom reapproval/removal resolve alerts without deleting replay-dedupe receipts", async () => {
  const id = "zoom-alert-resolve",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  await changeZoomTime(id);
  assert.equal(await reconcileZoom(id), 1);
  const current = (await (await zoomApi(id)).json()) as { version: string; publicationId: string };
  const draft = {
    expectedVersion: current.version,
    expectedPublicationId: current.publicationId,
    joinUrl: "https://zoom.us/j/12345678901?pwd=replacement",
  };
  const review = (await (await zoomApi(id, "POST", draft, "admin", true)).json()) as {
    approvalToken: string;
    reviewExpiresAt: string;
  };
  assert.equal(
    (
      await zoomApi(id, "PUT", {
        ...draft,
        confirm: true,
        approvalToken: review.approvalToken,
        reviewExpiresAt: review.reviewExpiresAt,
      })
    ).status,
    200,
  );
  assert.ok((await zoomNotices(id)).every((row) => row.isRead));
  assert.equal(await reconcileZoom(id), 0);
  await changeZoomTime(id, 2);
  assert.equal(await reconcileZoom(id), 1);
  const latest = (await (await zoomApi(id)).json()) as { version: string; publicationId: string };
  assert.equal(
    (
      await zoomApi(id, "DELETE", {
        confirm: true,
        expectedVersion: latest.version,
        expectedPublicationId: latest.publicationId,
      })
    ).status,
    200,
  );
  assert.equal((await zoomNotices(id)).length, 2);
  assert.ok((await zoomNotices(id)).every((row) => row.isRead));
});

test("Zoom alerts follow current coordinator assignment instead of a former publisher or another tenant", async () => {
  const id = "zoom-alert-reassigned",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ interviewerId: "employer-admin" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  assert.equal(await reconcileZoom(id), 1);
  const rows = await zoomNotices(id);
  assert.deepEqual(
    rows.map((row) => [row.userId, row.tenantId]),
    [["employer-admin", "employer"]],
  );
});

test("Zoom alerts retire on compliance loss and never notify suspended or erased publishers", async () => {
  const id = "zoom-alert-compliance",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  await changeZoomTime(id);
  assert.equal(await reconcileZoom(id), 1);
  const noticeId = (await zoomNotices(id))[0]!.id;
  await database.transaction(async (tx) => {
    await tx.execute(sql`SAVEPOINT zoom_alert_compliance`);
    await tx
      .update(schema.candidatesTable)
      .set({ doNotContact: true })
      .where(eq(schema.candidatesTable.id, "owner-candidate"));
    const { reconcileZoomLinkAlerts } = await import("../lib/zoom-link-alerts");
    assert.equal(await reconcileZoomLinkAlerts(tx as unknown as PanelTx, id), 0);
    const unread = await tx
      .select()
      .from(schema.userNotificationsTable)
      .where(
        and(
          eq(schema.userNotificationsTable.type, "zoom_link_stale"),
          eq(schema.userNotificationsTable.isRead, false),
          eq(schema.userNotificationsTable.userId, "admin"),
          eq(schema.userNotificationsTable.id, noticeId),
        ),
      );
    assert.equal(unread.length, 0);
    await tx.execute(sql`ROLLBACK TO SAVEPOINT zoom_alert_compliance`);
  });
  const { reconcileZoomLinkAlerts } = await import("../lib/zoom-link-alerts");
  for (const changes of [{ status: "suspended" as const }, { accountErasedAt: new Date() }]) {
    await database.transaction(async (tx) => {
      await tx.execute(sql`SAVEPOINT zoom_alert_user`);
      await tx.update(schema.usersTable).set(changes).where(eq(schema.usersTable.id, "admin"));
      assert.equal(await reconcileZoomLinkAlerts(tx as unknown as PanelTx, id), 0);
      await tx.execute(sql`ROLLBACK TO SAVEPOINT zoom_alert_user`);
    });
  }
});

test("Zoom cancellation and invitation conflicts alert but completed appointments retire the notice", async () => {
  const id = "zoom-alert-cancel",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "cancelled" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  assert.equal(await reconcileZoom(id), 1);
  await database
    .update(schema.interviewSchedulesTable)
    .set({ status: "completed" })
    .where(eq(schema.interviewSchedulesTable.id, id));
  assert.equal(await reconcileZoom(id), 0);
  assert.ok((await zoomNotices(id)).every((row) => row.isRead));
  const other = "zoom-alert-invitation",
    fresh = await zoomPrepared(other);
  assert.equal((await zoomApi(other, "PUT", fresh.approval)).status, 200);
  assert.equal(
    (
      await candidateCalendarRequest(other, "POST", {
        confirm: true,
        expectedVersion: scheduleVersion(await saved(other)),
        expectedRecipientEmail: "owner@example.invalid",
      })
    ).status,
    200,
  );
  assert.equal(await reconcileZoom(other), 1);
});

test("Zoom alert sweep uses the real private store and fails closed when its RLS proof is lost", async () => {
  const { sweepZoomLinkAlerts } = await import("../lib/zoom-link-alerts");
  const reader = database as unknown as Pick<typeof schema.dbAdmin, "transaction">;
  assert.equal(await sweepZoomLinkAlerts(reader), "");
  const before = await database
    .select({ id: schema.userNotificationsTable.id })
    .from(schema.userNotificationsTable)
    .where(eq(schema.userNotificationsTable.type, "zoom_link_stale"));
  await database.execute(sql`ALTER TABLE interview_zoom_links DISABLE ROW LEVEL SECURITY`);
  try {
    await assert.rejects(sweepZoomLinkAlerts(reader));
  } finally {
    await database.execute(sql`ALTER TABLE interview_zoom_links ENABLE ROW LEVEL SECURITY`);
  }
  const after = await database
    .select({ id: schema.userNotificationsTable.id })
    .from(schema.userNotificationsTable)
    .where(eq(schema.userNotificationsTable.type, "zoom_link_stale"));
  assert.deepEqual(after, before);
});

test("Zoom alerts include current additional recruiters but not foreign-tenant roster entries", async () => {
  const id = "zoom-alert-roster",
    { approval } = await zoomPrepared(id);
  assert.equal((await zoomApi(id, "PUT", approval)).status, 200);
  await database.insert(schema.usersTable).values({
    id: "zoom-roster-staff",
    tenantId: "employer",
    role: "recruiter",
    name: "Synthetic recruiter",
    email: "roster@example.invalid",
    passwordHash: "not-a-password",
  });
  await database.insert(schema.jobRecruitersTable).values([
    { jobId: `zoom-job:${id}`, tenantId: "employer", recruiterUserId: "zoom-roster-staff" },
    { jobId: `zoom-job:${id}`, tenantId: "portal-home", recruiterUserId: "outside-admin" },
  ]);
  await changeZoomTime(id);
  assert.equal(await reconcileZoom(id), 2);
  assert.deepEqual((await zoomNotices(id)).map((row) => row.userId).sort(), [
    "admin",
    "zoom-roster-staff",
  ]);
});

async function nativeZoomApi(
  id: string,
  suffix = "meeting",
  method = "GET",
  body?: unknown,
  userId = "admin",
) {
  return fetch(`${base}/zoom/schedules/${id}/${suffix}`, {
    method,
    headers: {
      Authorization: `Bearer ${issueToken({ userId, role: "platform_admin", tenantId: "portal-home" })}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function nativeZoomHost() {
  const { encryptSecret } = await import("../lib/crypto-secrets");
  const revision = randomUUID();
  const values = {
    tenantId: "portal-home",
    revision,
    clientFingerprint: createHash("sha256")
      .update(`${nativeZoomConfig.clientId}|${nativeZoomConfig.redirectUri}`)
      .digest("hex"),
    zoomUserId: "synthetic-zoom-host",
    email: "host@example.invalid",
    refreshTokenEnc: encryptSecret(
      JSON.stringify({
        purpose: "zoom-staff",
        userId: "admin",
        tenantId: "portal-home",
        token: "synthetic-zoom-refresh",
      }),
    ),
    connectedAt: new Date(),
    needsReconnect: false,
  };
  await database
    .insert(schema.staffZoomAccountsTable)
    .values({ userId: "admin", ...values })
    .onConflictDoUpdate({ target: schema.staffZoomAccountsTable.userId, set: values });
  return revision;
}
async function nativeZoomApproval(
  id: string,
  revision: string,
  action: "create" | "update" | "cancel",
) {
  const read = await nativeZoomApi(id);
  assert.equal(read.status, 200);
  const view = (await read.json()) as { version: string; operationId: string | null };
  const input = {
    action,
    expectedVersion: view.version,
    accountRevision: revision,
    expectedOperationId: view.operationId,
  };
  const result = await nativeZoomApi(id, "meeting-review", "POST", input);
  assert.equal(result.status, 200, await result.clone().text());
  const review = (await result.json()) as { approvalToken: string; expiresAt: string };
  return {
    ...input,
    confirm: true,
    approvalToken: review.approvalToken,
    expiresAt: review.expiresAt,
  };
}
async function uncertainZoom(id: string, action: "create" | "update" | "cancel" = "create") {
  await zoomPrepared(id);
  const revision = await nativeZoomHost();
  if (action !== "create") {
    const initial = await nativeZoomApproval(id, revision, "create");
    assert.equal((await nativeZoomApi(id, "meeting", "POST", initial)).status, 200);
    if (action === "update") await changeZoomTime(id);
  }
  const original = await nativeZoomApproval(id, revision, action);
  if (action === "create") nativeZoomLoseCreate = true;
  if (action === "update") nativeZoomLoseUpdate = true;
  if (action === "cancel") nativeZoomLoseCancel = true;
  assert.equal((await nativeZoomApi(id, "meeting", "POST", original)).status, 409);
  const view = (await (await nativeZoomApi(id)).json()) as { version: string; operationId: string };
  const [saved] = await database
    .select()
    .from(schema.interviewZoomMeetingsTable)
    .where(eq(schema.interviewZoomMeetingsTable.scheduleId, id));
  const event = [...nativeZoomEvents.values()].find(
    (item) => item.agenda === `Lexy operation: ${view.operationId}`,
  );
  return {
    revision,
    saved,
    input: {
      expectedVersion: view.version,
      accountRevision: revision,
      expectedOperationId: view.operationId,
      ...(action === "create" ? { meetingId: event!.meetingId } : {}),
    },
  };
}
async function recoveryApproval(
  id: string,
  input: Awaited<ReturnType<typeof uncertainZoom>>["input"],
) {
  const response = await nativeZoomApi(id, "meeting-recovery-review", "POST", input);
  assert.equal(response.status, 200, await response.clone().text());
  const proof = (await response.json()) as { approvalToken: string; expiresAt: string };
  return {
    ...input,
    confirm: true,
    reason: "provider_evidence_checked",
    approvalToken: proof.approvalToken,
    expiresAt: proof.expiresAt,
  };
}
test("Zoom recovery of a lost create is host-only, explicitly approved, audited once and never repeats the provider write", async () => {
  const id = "zoom-recovery-create";
  const { input, saved } = await uncertainZoom(id);
  const writes = nativeZoomCalls.length;
  const reads = nativeZoomReads;
  assert.equal(
    (await nativeZoomApi(id, "meeting-recovery-review", "POST", input, "owner")).status,
    403,
  );
  assert.equal(
    (await nativeZoomApi(id, "meeting-recovery-review", "POST", input, "outside-admin")).status,
    404,
  );
  assert.equal(nativeZoomReads, reads);
  const approval = await recoveryApproval(id, input);
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "unavailable",
  );
  assert.equal(
    (await nativeZoomApi(id, "meeting-recovery", "POST", { ...approval, confirm: false })).status,
    400,
  );
  assert.equal(
    (await nativeZoomApi(id, "meeting-recovery", "POST", { ...approval, reason: "skip_checks" }))
      .status,
    400,
  );
  assert.deepEqual(
    (
      await Promise.all([
        nativeZoomApi(id, "meeting-recovery", "POST", approval),
        nativeZoomApi(id, "meeting-recovery", "POST", approval),
      ])
    )
      .map((res) => res.status)
      .sort(),
    [200, 409],
  );
  assert.equal(nativeZoomCalls.length, writes);
  assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 409);
  const audits = await database
    .select()
    .from(schema.auditLogsTable)
    .where(eq(schema.auditLogsTable.subjectId, id));
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "zoom.operation_reconciled");
  assert.equal(audits[0].tenantId, saved.tenantId);
  assert.equal(JSON.stringify(audits).includes("synthetic-zoom-access"), false);
  const candidate = (await (await zoomCandidate(id)).json()) as {
    status: string;
    providerVerified: boolean;
  };
  assert.equal(candidate.status, "available");
  assert.equal(candidate.providerVerified, true);
  assert.equal((await zoomCandidate(id, "other")).status, 404);
});
test("Zoom recovery rejects foreign hosts, old meetings without operation markers, changed times and changed provider evidence", async () => {
  const id = "zoom-recovery-proof";
  const { input } = await uncertainZoom(id);
  const event = nativeZoomEvents.get(input.meetingId!)!;
  const original = { ...event };
  for (const changes of [
    { hostZoomId: "foreign-host" },
    { agenda: "" },
    { agenda: "Lexy operation: old-operation" },
    { startTime: "2027-01-01T00:00:00Z" },
    { durationMinutes: 1 },
    { topic: "Unrelated meeting" },
  ]) {
    Object.assign(event, original, changes);
    assert.equal((await nativeZoomApi(id, "meeting-recovery-review", "POST", input)).status, 409);
  }
  Object.assign(event, original);
  const approval = await recoveryApproval(id, input);
  event.joinUrl = `${event.joinUrl}?pwd=changed`;
  assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 409);
  Object.assign(event, original);
  assert.equal(
    (
      await nativeZoomApi(id, "meeting-recovery", "POST", {
        ...approval,
        expiresAt: "2020-01-01T00:00:00Z",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await nativeZoomApi(id, "meeting-recovery", "POST", {
        ...approval,
        accountRevision: randomUUID(),
      })
    ).status,
    409,
  );
  await changeZoomTime(id);
  assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 409);
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "unavailable",
  );
});
test("Zoom recovery confirms a provider-applied lost update without another PATCH", async () => {
  const id = "zoom-recovery-update";
  const { input } = await uncertainZoom(id, "update");
  // Also cover the durable pending intent left when receipt persistence, rather
  // than the provider response itself, was lost.
  await database
    .update(schema.interviewZoomMeetingsTable)
    .set({ status: "pending" })
    .where(eq(schema.interviewZoomMeetingsTable.scheduleId, id));
  const writes = nativeZoomCalls.length;
  const approval = await recoveryApproval(id, input);
  assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 200);
  assert.equal(nativeZoomCalls.length, writes);
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "available",
  );
});
test("Zoom recovery rechecks current staff status and candidate compliance before publishing", async () => {
  const id = "zoom-recovery-current-authority";
  const { input, saved } = await uncertainZoom(id);
  const approval = await recoveryApproval(id, input);
  const reads = nativeZoomReads;
  await database
    .update(schema.usersTable)
    .set({ status: "suspended" })
    .where(eq(schema.usersTable.id, "admin"));
  try {
    assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 403);
    assert.equal(nativeZoomReads, reads);
  } finally {
    await database
      .update(schema.usersTable)
      .set({ status: "active" })
      .where(eq(schema.usersTable.id, "admin"));
  }
  await database
    .update(schema.candidatesTable)
    .set({ doNotContact: true })
    .where(eq(schema.candidatesTable.id, saved.candidateId));
  try {
    assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 409);
    assert.equal(nativeZoomReads, reads);
  } finally {
    await database
      .update(schema.candidatesTable)
      .set({ doNotContact: false })
      .where(eq(schema.candidatesTable.id, saved.candidateId));
  }
});
test("Zoom recovery confirms a provider-applied lost cancellation without another DELETE", async () => {
  const id = "zoom-recovery-cancel";
  const { input } = await uncertainZoom(id, "cancel");
  const writes = nativeZoomCalls.length;
  const approval = await recoveryApproval(id, input);
  assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 200);
  assert.equal(nativeZoomCalls.length, writes);
  const saved = (await (await nativeZoomApi(id)).json()) as {
    status: string;
    joinUrl: string | null;
  };
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.joinUrl, null);
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "unavailable",
  );
});
test("Zoom recovery rolls back local resolution when the audit insert fails", async () => {
  const id = "zoom-recovery-audit";
  const { input } = await uncertainZoom(id);
  const approval = await recoveryApproval(id, input);
  await database.execute(sql`ALTER TABLE audit_logs ADD CONSTRAINT fixture_zoom_audit_failure
    CHECK (action <> 'zoom.operation_reconciled') NOT VALID`);
  try {
    assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 503);
    const saved = (await (await nativeZoomApi(id)).json()) as { status: string };
    assert.equal(saved.status, "uncertain");
    assert.equal(
      ((await (await zoomCandidate(id)).json()) as { status: string }).status,
      "unavailable",
    );
  } finally {
    await database.execute(sql`ALTER TABLE audit_logs DROP CONSTRAINT fixture_zoom_audit_failure`);
  }
  assert.equal((await nativeZoomApi(id, "meeting-recovery", "POST", approval)).status, 200);
});
test("Native Zoom approvals create once, preserve the meeting on reschedule, cancel it and isolate candidate links", async () => {
  const id = "zoom-native-lifecycle";
  const { approval: manualApproval } = await zoomPrepared(id);
  const revision = await nativeZoomHost();
  const before = nativeZoomCalls.length;
  const approval = await nativeZoomApproval(id, revision, "create");
  assert.equal(
    (await nativeZoomApi(id, "meeting", "POST", { ...approval, confirm: false })).status,
    400,
  );
  assert.equal((await nativeZoomApi(id, "meeting", "POST", approval, "owner")).status, 403);
  assert.equal((await nativeZoomApi(id, "meeting", "POST", approval, "outside-admin")).status, 404);
  assert.equal(nativeZoomCalls.length, before);
  const results = await Promise.all([
    nativeZoomApi(id, "meeting", "POST", approval),
    nativeZoomApi(id, "meeting", "POST", approval),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  assert.equal(nativeZoomCalls.length, before + 1);
  const [record] = await database
    .select()
    .from(schema.interviewZoomMeetingsTable)
    .where(eq(schema.interviewZoomMeetingsTable.scheduleId, id));
  assert.equal(record.status, "confirmed");
  assert.equal((await zoomApi(id, "PUT", manualApproval)).status, 409);
  const own = await zoomCandidate(id);
  assert.deepEqual(await own.json(), {
    scheduleId: id,
    status: "available",
    joinUrl: record.joinUrl,
    providerVerified: true,
    source: "zoom_api",
  });
  assert.equal((await zoomCandidate(id, "other")).status, 404);
  await changeZoomTime(id);
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "unavailable",
  );
  const update = await nativeZoomApproval(id, revision, "update");
  assert.equal((await nativeZoomApi(id, "meeting", "POST", update)).status, 200);
  assert.equal(nativeZoomCalls.at(-1), `update:${record.meetingId}`);
  const cancellation = await nativeZoomApproval(id, revision, "cancel");
  assert.equal((await nativeZoomApi(id, "meeting", "POST", cancellation)).status, 200);
  assert.equal(nativeZoomCalls.at(-1), `cancel:${record.meetingId}`);
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "unavailable",
  );
  assert.equal((await nativeZoomApi(id, "meeting", "POST", cancellation)).status, 409);
});
test("Native Zoom lost create responses block retries, candidate publication and host disconnection across child tenants", async () => {
  const id = "zoom-native-uncertain";
  await zoomPrepared(id);
  const revision = await nativeZoomHost();
  const approval = await nativeZoomApproval(id, revision, "create");
  const before = nativeZoomCalls.length;
  nativeZoomLoseCreate = true;
  const lost = await nativeZoomApi(id, "meeting", "POST", approval);
  assert.equal(lost.status, 409, await lost.clone().text());
  const [saved] = await database
    .select()
    .from(schema.interviewZoomMeetingsTable)
    .where(eq(schema.interviewZoomMeetingsTable.scheduleId, id));
  assert.equal(saved.status, "uncertain");
  assert.equal(saved.meetingId, null);
  assert.equal(nativeZoomCalls.length, before + 1);
  assert.equal((await nativeZoomApi(id, "meeting", "POST", approval)).status, 409);
  assert.equal(nativeZoomCalls.length, before + 1);
  assert.equal(
    ((await (await zoomCandidate(id)).json()) as { status: string }).status,
    "unavailable",
  );
  const disconnect = await fetch(`${base}/zoom-account/me/disconnect`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${issueToken({ userId: "admin", role: "platform_admin", tenantId: "portal-home" })}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ revision, confirmDisconnect: true }),
  });
  assert.equal(disconnect.status, 409);
  assert.equal(((await disconnect.json()) as { code: string }).code, "zoom_meetings_active");
});
test("Native Zoom host OAuth is staff-only, browser-bound, single-use and never exposes refresh credentials", async () => {
  const headers = {
    Authorization: `Bearer ${issueToken({ userId: "admin", role: "platform_admin", tenantId: "portal-home" })}`,
    "Content-Type": "application/json",
  };
  assert.equal((await fetch(`${base}/zoom-account/me`)).status, 401);
  const denied = await fetch(`${base}/zoom-account/me/connect`, {
    method: "POST",
    headers: {
      ...headers,
      Authorization: `Bearer ${issueToken({ userId: "owner", role: "candidate", tenantId: "portal-home" })}`,
    },
    body: JSON.stringify({ confirmOwnZoom: true }),
  });
  assert.equal(denied.status, 403);
  const consent = await fetch(`${base}/zoom-account/me/connect`, {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmOwnZoom: false }),
  });
  assert.equal(consent.status, 400);
  const start = await fetch(`${base}/zoom-account/me/connect`, {
    method: "POST",
    headers,
    body: JSON.stringify({ confirmOwnZoom: true }),
  });
  assert.equal(start.status, 200);
  const body = (await start.json()) as { authorizationUrl: string; expiresAt: string };
  assert.deepEqual(Object.keys(body).sort(), ["authorizationUrl", "expiresAt"]);
  const cookie = start.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  const state = new URL(body.authorizationUrl).searchParams.get("state");
  assert.match(state ?? "", /^[A-Za-z0-9_-]{43}$/);
  const callback = `${base}/zoom-account/callback?state=${state}&code=synthetic-code`;
  const before = nativeZoomAuthorizations;
  const wrongBrowser = await fetch(callback, { headers, redirect: "manual" });
  assert.equal(wrongBrowser.status, 303);
  assert.equal(new URL(wrongBrowser.headers.get("location")!).searchParams.get("zoom"), "error");
  assert.equal(nativeZoomAuthorizations, before);
  const boundHeaders = { ...headers, Cookie: cookie.split(";")[0] };
  const accepted = await fetch(callback, { headers: boundHeaders, redirect: "manual" });
  assert.equal(accepted.status, 303);
  assert.equal(new URL(accepted.headers.get("location")!).searchParams.get("zoom"), "connected");
  assert.equal(nativeZoomAuthorizations, before + 1);
  const replay = await fetch(callback, { headers: boundHeaders, redirect: "manual" });
  assert.equal(new URL(replay.headers.get("location")!).searchParams.get("zoom"), "error");
  assert.equal(nativeZoomAuthorizations, before + 1);
  const status = await fetch(`${base}/zoom-account/me`, { headers });
  const view = (await status.json()) as { connected: boolean };
  assert.deepEqual(Object.keys(view).sort(), [
    "configured",
    "connected",
    "email",
    "needsReconnect",
    "revision",
  ]);
  assert.equal(view.connected, true);
  const [stored] = await database
    .select()
    .from(schema.staffZoomAccountsTable)
    .where(eq(schema.staffZoomAccountsTable.userId, "admin"));
  assert.match(stored.refreshTokenEnc ?? "", /^v1:/);
  assert.ok(!stored.refreshTokenEnc?.includes("synthetic-zoom-refresh"));
  assert.equal(stored.flowHash, null);
  assert.equal(stored.browserHash, null);
});
