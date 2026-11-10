import assert from "node:assert/strict";
import test from "node:test";
import express from "express";
import { googlePanelCalendarRouter } from "./google-panel-calendar";
import { CalendarError } from "../lib/outlook-calendar-core";
import type { calendarStaff } from "../lib/calendar-staff";

test("Google panel HTTP gates roles, validates explicit consent and returns private-safe failures", async () => {
  let role = "anonymous",
    calls = 0,
    broken = false;
  const revision = "123e4567-e89b-42d3-a456-426614174000";
  const caller = {
    id: "own-staff",
    tenantId: "employer",
    role: "recruiter",
    status: "active",
    name: "Reviewer",
    accountErasedAt: null,
  } as Awaited<ReturnType<typeof calendarStaff>>;
  const app = express()
    .use(express.json())
    .use(
      googlePanelCalendarRouter({
        actor: async () => {
          if (role === "anonymous") throw new CalendarError(401, "sign_in_required", "Sign in.");
          if (role === "candidate")
            throw new CalendarError(403, "staff_required", "Staff required.");
          return { ...caller, role: role as typeof caller.role };
        },
        repository: {
          saved: async (_caller, id) => {
            calls++;
            if (id !== "own")
              throw new CalendarError(404, "schedule_not_found", "Interview not found.");
            return {
              provider: null,
              scheduleId: id,
              version: "v1_" + "a".repeat(64),
              scheduledAt: "2035-01-01T10:00:00Z",
              durationMinutes: 30,
              members: [],
              bufferMinutes: 0,
              calendarReserved: false,
              invitationSent: false,
            };
          },
          save: async (_caller, id, input) => {
            calls++;
            if (broken) throw new Error("private credentials and SQL");
            if (id !== "own")
              throw new CalendarError(404, "schedule_not_found", "Interview not found.");
            return {
              provider: input.userIds.length ? ("google" as const) : null,
              scheduleId: id,
              version: "v1_" + "b".repeat(64),
              scheduledAt: input.scheduledAt,
              durationMinutes: 30,
              members: input.userIds.map((id) => ({ id, name: "Reviewer" })),
              bufferMinutes: input.bufferMinutes,
              calendarReserved: false,
              invitationSent: false,
            };
          },
          consent: async (_caller, change) => {
            calls++;
            if (broken) throw new Error("private credentials and SQL");
            return {
              enabled: change?.enabled ?? false,
              canEnable: true,
              revision,
              grantedAt: null,
            };
          },
          members: async (_caller, id) => {
            calls++;
            if (id !== "own")
              throw new CalendarError(404, "schedule_not_found", "Interview not found.");
            return {
              scheduleId: id,
              version: "version",
              members: [{ id: "reviewer", name: "Reviewer" }],
            };
          },
          times: async (_caller, id, _input) => {
            calls++;
            if (broken) throw new Error("private calendar payload");
            if (id !== "own")
              throw new CalendarError(404, "schedule_not_found", "Interview not found.");
            return {
              scheduleId: id,
              version: "version",
              checkedAt: "2035-01-01T08:00:00Z",
              panelSize: 1,
              durationMinutes: 30,
              slots: [],
              calendarReserved: false,
              invitationSent: false,
            };
          },
        },
      }),
    );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/google-calendar`;
  const get = (path: string) => fetch(url + path);
  const post = (path: string, data: unknown) =>
    fetch(url + path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    for (const candidateRole of ["anonymous", "candidate"]) {
      role = candidateRole;
      assert.equal((await get("/panel-consent")).status, role === "anonymous" ? 401 : 403);
      assert.equal(
        (await get("/schedules/own/panel-members")).status,
        role === "anonymous" ? 401 : 403,
      );
      assert.equal((await get("/schedules/own/panel")).status, role === "anonymous" ? 401 : 403);
    }
    assert.equal(calls, 0);
    role = "interviewer";
    assert.equal((await get("/panel-consent")).status, 200);
    assert.equal((await get("/schedules/own/panel-members")).status, 403);
    assert.equal(calls, 1);
    role = "recruiter";
    const before = calls;
    for (const body of [
      { enabled: true, expectedRevision: revision },
      { enabled: true, expectedRevision: revision, confirmShare: false },
      { enabled: true, expectedRevision: null, confirmShare: true },
      { enabled: false, expectedRevision: revision, tenantId: "foreign" },
    ])
      assert.equal((await post("/panel-consent", body)).status, 400);
    assert.equal(calls, before);
    assert.equal(
      (
        await post("/panel-consent", {
          enabled: true,
          expectedRevision: revision,
          confirmShare: true,
        })
      ).status,
      200,
    );
    assert.equal(
      (await post("/panel-consent", { enabled: false, expectedRevision: revision })).status,
      200,
    );
    const directory = await get("/schedules/own/panel-members");
    assert.equal(directory.status, 200);
    assert.equal(directory.headers.get("cache-control"), "no-store");
    assert.deepEqual(await directory.json(), {
      scheduleId: "own",
      version: "version",
      members: [{ id: "reviewer", name: "Reviewer" }],
    });
    const foreign = await get("/schedules/foreign/panel-members"),
      missing = await get("/schedules/missing/panel-members");
    assert.equal(foreign.status, 404);
    assert.deepEqual(await foreign.json(), await missing.json());
    const request = {
      expectedVersion: "version",
      userIds: ["reviewer"],
      start: "2035-01-01T10:00:00Z",
      end: "2035-01-01T11:00:00Z",
      bufferMinutes: 15,
    };
    assert.equal(
      (await post("/schedules/own/panel-times", { ...request, mailbox: "foreign@example.test" }))
        .status,
      400,
    );
    const response = await post("/schedules/own/panel-times", request);
    assert.equal(response.status, 200);
    const result: unknown = await response.json();
    assert.ok(result && typeof result === "object" && "calendarReserved" in result);
    assert.equal(result.calendarReserved, false);
    broken = true;
    for (const response of [
      await get("/panel-consent"),
      await post("/schedules/own/panel-times", request),
    ]) {
      assert.equal(response.status, 503);
      assert.doesNotMatch(JSON.stringify(await response.json()), /credentials|SQL|payload/);
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
