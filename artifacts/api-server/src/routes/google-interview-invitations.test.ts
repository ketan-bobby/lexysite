import test, { mock } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import type { AddressInfo } from "node:net";
import { once } from "node:events";
import { CalendarError } from "../lib/outlook-calendar-core";
import type { GoogleInvitationCaller } from "../lib/google-invitation-store";
mock.module("../lib/auth-token", {
  namedExports: { getAuthUserId: (req: express.Request) => req.headers["x-fixture-actor"] ?? null },
});
const { googleInterviewInvitationsRouter } = await import("./google-interview-invitations");
test("Google invitation HTTP authentication precedes private service construction", async () => {
  let constructed = 0;
  const app = express();
  app.use(express.json());
  app.use(
    googleInterviewInvitationsRouter({
      async caller(id) {
        throw new CalendarError(id ? 403 : 401, "staff_required", "Active staff required.");
      },
      service() {
        constructed++;
        throw Error("should not construct");
      },
    }),
  );
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/google-calendar/schedules/fixture/invitation`;
    for (const method of ["GET", "POST"]) {
      assert.equal((await fetch(url, { method })).status, 401);
      assert.equal(
        (await fetch(url, { method, headers: { "x-fixture-actor": "candidate" } })).status,
        403,
      );
    }
    assert.equal(constructed, 0);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("Staff HTTP requests pass only resolved identity and scoped identifier; foreign schedules stay 404 and uncached", async () => {
  const actor = {
    id: "staff",
    role: "recruiter",
    tenantId: "employer",
  } as unknown as GoogleInvitationCaller;
  let reads = 0,
    writes = 0;
  const service = {
    async review(c: GoogleInvitationCaller, id: string) {
      assert.equal(c, actor);
      reads++;
      assert.equal(id, "foreign");
      throw new CalendarError(404, "schedule_not_found", "Not found.");
    },
    async send(c: GoogleInvitationCaller, id: string) {
      assert.equal(c, actor);
      writes++;
      assert.equal(id, "foreign");
      throw new CalendarError(404, "schedule_not_found", "Not found.");
    },
  };
  const app = express();
  app.use(express.json());
  app.use(googleInterviewInvitationsRouter({ caller: async () => actor, service: () => service }));
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/google-calendar/schedules/foreign/invitation`;
    for (const method of ["GET", "POST"]) {
      const result = await fetch(url, { method });
      assert.equal(result.status, 404);
      assert.equal(result.headers.get("cache-control"), "no-store");
    }
    assert.equal(reads, 1);
    assert.equal(writes, 1);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});
test("The shared Outlook attempt reader refuses Google claims before any Outlook reconciliation or send", async () => {
  const { readAttempt } = await import("./outlook-candidate-invitations");
  const tx = {
    select: () => ({
      from: () => ({ where: async () => [{ provider: "google", status: "attempted" }] }),
    }),
  } as unknown as Parameters<typeof readAttempt>[0];
  await assert.rejects(
    readAttempt(tx, "synthetic-schedule"),
    (e) => e instanceof CalendarError && e.code === "invitation_other_provider",
  );
});
