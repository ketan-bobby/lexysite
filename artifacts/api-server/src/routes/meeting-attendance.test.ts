import assert from "node:assert/strict";
import { once } from "node:events";
import { mock, test } from "node:test";
import express from "express";
import type { AddressInfo } from "node:net";

let role = "platform_admin",
  active = true,
  caller = true;
const sideEffects: string[] = [];
mock.module("../middlewares/resolveUser", {
  namedExports: {
    resolveUser: (req: express.Request, res: express.Response, next: express.NextFunction) => {
      if (!caller || !active) {
        res.status(401).end();
        return;
      }
      req.resolvedUser = {
        id: "staff",
        role,
        tenantId: "tenant",
        email: "",
        name: "",
        region: "us",
        lastReportSeenAt: null,
      };
      next();
    },
  },
});
mock.module("../lib/meeting-notes-service", {
  namedExports: {
    meetingScope: async (_actor: string, jobId: string, candidateId: string) => {
      if (
        ![
          "platform_admin",
          "tenant_admin",
          "recruiter_admin",
          "recruiter",
          "hiring_manager",
        ].includes(role)
      )
        throw Object.assign(new Error("Staff required."), { statusCode: 403 });
      if (jobId !== "job" || candidateId !== "candidate")
        throw Object.assign(new Error("Interview context not found."), { statusCode: 404 });
      return { actorId: "staff", jobId, candidateId, tenantId: "tenant" };
    },
  },
});
const names = [
  "attendanceView",
  "authorizeAttendanceWorkspace",
  "revokeAttendanceWorkspace",
  "approveAttendance",
  "dispatchAttendance",
  "stopAttendance",
  "recoverAttendance",
  "importAttendanceAudio",
];
mock.module("../lib/meeting-attendance-service", {
  namedExports: Object.fromEntries(
    names.map((name) => [
      name,
      async () => {
        sideEffects.push(name);
        return { state: "fixture" };
      },
    ]),
  ),
});
const { default: router } = await import("./meeting-attendance");

test("attendance HTTP authenticates, scopes before effects, validates explicit consent, and never dispatches on approval", async () => {
  const app = express();
  app.use(express.json(), router);
  app.use(((error, _req, res, _next) => {
    res
      .status(error.statusCode ?? (error.name === "ZodError" ? 400 : 500))
      .json({ error: "Request rejected." });
  }) as express.ErrorRequestHandler);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const path = "/jobs/job/candidates/candidate/meeting-assistant";
  const body = {
    scheduleId: "00000000-0000-4000-8000-000000000001",
    consent: true,
    consentStatement: "All participants explicitly approved capture.",
  };
  const post = (p: string, value: unknown) =>
    fetch(base + p, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  try {
    caller = false;
    assert.equal((await post(path, body)).status, 401);
    caller = true;
    active = false;
    assert.equal((await post(path, body)).status, 401);
    active = true;
    for (role of ["candidate", "interviewer", "unknown"])
      assert.equal((await post(path, body)).status, 403);
    role = "platform_admin";
    assert.equal((await post(path.replace("/job/", "/foreign/"), body)).status, 404);
    assert.equal((await post(path.replace("/candidate/", "/foreign/"), body)).status, 404);
    for (const consent of [false, "true", undefined])
      assert.equal((await post(path, { ...body, consent })).status, 400);
    assert.equal((await post(path, { ...body, extra: "ignored consent bypass" })).status, 400);
    assert.equal(sideEffects.length, 0);
    const response = await post(path, body);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(sideEffects, ["approveAttendance"]);
    const id = body.scheduleId;
    assert.equal((await post(`${path}/attempts/${id}/unknown`, {})).status, 404);
    assert.equal((await post(`${path}/attempts/${id}/dispatch`, {})).status, 200);
    assert.deepEqual(sideEffects, ["approveAttendance", "dispatchAttendance"]);
    assert.equal((await post(`${path}/attempts/not-a-uuid/dispatch`, {})).status, 400);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
