import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readJsonObject } from "../test-utils/json-response";
import express from "express";
import cookieParser from "cookie-parser";
import type { Server } from "node:http";
import { randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  jobsTable,
  candidatesTable,
  interviewPlansTable,
  interviewSessionsTable,
  trustEventsTable,
} from "@workspace/db";
import interviewsRouter from "./interviews";
import { withTenantContext } from "../middlewares/withTenantContext";
import {
  cookieNameFor,
  signCookie,
  fingerprintFor,
  newSecret,
} from "../lib/interview-session-cookie";
import { candidateInterviewConfiguration } from "../lib/candidate-interview-configuration";

const prefix = `cfg_${randomUUID().slice(0, 8)}_`;
const id = (value: string) => prefix + value;
const ua = "candidate-configuration-regression";
const nonce = randomUUID();
let server: Server;
let baseUrl: string;
const sessions = ["valid", "foreign", "expired"].map(id);

before(async () => {
  await dbAdmin.insert(tenantsTable).values(
    ["a", "b"].map((t) => ({
      id: id(t),
      name: "Isolated configuration regression",
      slug: id(t),
    })),
  );
  await dbAdmin.insert(jobsTable).values(
    ["a", "b"].map((t): typeof jobsTable.$inferInsert => ({
      id: id(`job_${t}`),
      tenantId: id(t),
      title: "Configuration regression",
      description: "Synthetic test only",
      status: "active",
    })),
  );
  await dbAdmin.insert(candidatesTable).values({
    id: id("candidate"),
    tenantId: id("a"),
    firstName: "Synthetic",
    lastName: "Candidate",
    email: `${prefix}@example.test`,
    pool: "tenant",
    source: "linkedin",
  });
  await dbAdmin.insert(interviewPlansTable).values(
    ["a", "b"].map((t) => ({
      id: id(`plan_${t}`),
      tenantId: id(t),
      jobId: id(`job_${t}`),
      title: `Configuration ${t}`,
      interviewType: "general" as const,
      language: "en-US",
      questions: [{ id: "q1", text: "PRIVATE SPOKEN QUESTION", idealAnswer: "PRIVATE ANSWER" }],
      culturalConfig: { culturalDoc: "PRIVATE RECRUITER DOCUMENT" },
    })),
  );
  const fp = fingerprintFor({
    headers: { "user-agent": ua, "accept-language": "en" },
    ip: "127.0.0.1",
  } as any);
  await dbAdmin.insert(interviewSessionsTable).values(
    ["valid", "foreign", "expired"].map((s) => ({
      id: id(s),
      tenantId: id("a"),
      applicationId: "direct",
      candidateId: id("candidate"),
      planId: id(s === "foreign" ? "plan_b" : "plan_a"),
      status: "verified" as const,
      language: "hi-IN",
      totalQuestions: 1,
      cookieNonce: nonce,
      bindSecret: newSecret(),
      bindFingerprint: fp.fp,
      bindUserAgent: ua,
      bindIpPrefix: fp.ipPrefix,
      claimedAt: new Date(),
      verifiedAt: new Date(),
      expiresAt: new Date(Date.now() + (s === "expired" ? -60000 : 3600000)),
    })),
  );
  const app = express();
  app.use(express.json(), cookieParser());
  app.use("/api", withTenantContext, interviewsRouter);
  server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.on("listening", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as any).port}/api`;
});

after(async () => {
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  await dbAdmin.delete(trustEventsTable).where(inArray(trustEventsTable.sessionId, sessions));
  await dbAdmin.delete(interviewSessionsTable).where(inArray(interviewSessionsTable.id, sessions));
  await dbAdmin
    .delete(interviewPlansTable)
    .where(inArray(interviewPlansTable.id, [id("plan_a"), id("plan_b")]));
  await dbAdmin.delete(candidatesTable).where(inArray(candidatesTable.id, [id("candidate")]));
  await dbAdmin.delete(jobsTable).where(inArray(jobsTable.id, [id("job_a"), id("job_b")]));
  await dbAdmin.delete(tenantsTable).where(inArray(tenantsTable.id, [id("a"), id("b")]));
});

async function get(path: string, cookieSession?: string) {
  return fetch(baseUrl + path, {
    headers: {
      "user-agent": ua,
      "accept-language": "en",
      ...(cookieSession
        ? { Cookie: `${cookieNameFor(cookieSession)}=${signCookie(cookieSession, nonce)}` }
        : {}),
    },
  });
}

test("candidate cookie loads own configuration with no bearer and session language wins", async () => {
  const r = await get(
    `/interviews/${id("valid")}/configuration?planId=${id("plan_b")}`,
    id("valid"),
  );
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("cache-control"), "no-store");
  const body = await readJsonObject(r);
  assert.equal(body.id, id("plan_a"));
  assert.equal(body.language, "hi-IN");
  assert.deepEqual(body.questions, []);
  assert.equal(JSON.stringify(body).includes("PRIVATE"), false);
  assert.equal("tenantId" in body, false);
});

test("missing cookie cannot read configuration", async () => {
  const r = await get(`/interviews/${id("valid")}/configuration`);
  assert.equal(r.status, 401);
});

test("another session's cookie cannot read this configuration", async () => {
  const r = await get(`/interviews/${id("valid")}/configuration`, id("foreign"));
  assert.equal(r.status, 401);
});

test("session linked to another tenant's plan fails closed", async () => {
  const r = await get(`/interviews/${id("foreign")}/configuration`, id("foreign"));
  assert.equal(r.status, 404);
});

test("expired verified session cannot load configuration", async () => {
  const r = await get(`/interviews/${id("expired")}/configuration`, id("expired"));
  assert.equal(r.status, 410);
});

test("staff plan endpoint rejects anonymous requests before the RLS DB", async () => {
  const r = await get(`/interviews/plans/${id("plan_a")}`);
  assert.equal(r.status, 401);
});

test("coding configuration retains public UI fields but excludes grading secrets", () => {
  const config = candidateInterviewConfiguration(
    {
      id: "coding",
      title: "Coding",
      interviewType: "programming",
      language: "en",
      estimatedDurationMinutes: 20,
      questions: [
        {
          id: "q1",
          title: "Sum",
          description: "Add inputs",
          difficulty: "easy",
          estimatedMinutes: 10,
          starterCode: { javascript: "function sum() {}", privateSolution: "SECRET" },
          examples: [{ input: "1,2", output: "3", explanation: "Sum", rubric: "SECRET" }],
          constraints: ["positive numbers"],
          idealAnswer: "SECRET",
          testCases: ["SECRET"],
          rubric: "SECRET",
        },
      ],
    },
    "ta-IN",
  );
  assert.equal(config.language, "ta-IN");
  assert.equal(config.questions[0].starterCode.javascript, "function sum() {}");
  assert.equal(config.questions[0].examples[0].output, "3");
  assert.equal(JSON.stringify(config).includes("SECRET"), false);
});
