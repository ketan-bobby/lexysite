import assert from "node:assert/strict";
import { once } from "node:events";
import { mock, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";

let callerId: string | null = null;
let role = "platform_admin";
let active = true;
mock.module("../middlewares/resolveUser", {
  namedExports: {
    resolveUser: (_req: unknown, _res: unknown, next: () => void) => next(),
  },
});
mock.module("../lib/calendar-staff", {
  namedExports: {
    calendarStaff: async (id: string | null) => {
      if (!id || !active) throw Object.assign(new Error("Please sign in."), { status: 401 });
      return { id, role };
    },
  },
});
const { recallReadinessHandler } = await import("./meeting-assistant-readiness");

test("real HTTP readiness response is admin-only, no-store, ISO serialized and never enables joining", async () => {
  let checks = 0;
  const app = express();
  app.use((req, _res, next) => {
    if (callerId)
      req.resolvedUser = {
        id: callerId,
        role,
        tenantId: null,
        email: "",
        name: "",
        region: "us",
        lastReportSeenAt: null,
      };
    next();
  });
  app.get(
    "/readiness",
    recallReadinessHandler(undefined, async () => {
      checks++;
      return {
        state: "connected",
        checkedAt: "2026-11-05T00:00:00.000Z",
        attendanceEnabled: false,
        message: "Read-only check succeeded.",
      };
    }),
  );
  app.use(((error, _req, res, _next) => {
    res.status(error.status ?? 500).json({ error: "Access denied." });
  }) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/readiness`;
  try {
    assert.equal((await fetch(url)).status, 401);
    callerId = "staff";
    for (role of [
      "candidate",
      "tenant_admin",
      "recruiter_admin",
      "recruiter",
      "hiring_manager",
      "interviewer",
    ]) {
      assert.equal((await fetch(url)).status, 403);
    }
    role = "platform_admin";
    active = false;
    assert.equal((await fetch(url)).status, 401);
    assert.equal(checks, 0);
    active = true;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const body = (await response.json()) as { checkedAt: string; attendanceEnabled: boolean };
    assert.equal(body.checkedAt, "2026-11-05T00:00:00.000Z");
    assert.equal(body.attendanceEnabled, false);
    assert.equal(checks, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
