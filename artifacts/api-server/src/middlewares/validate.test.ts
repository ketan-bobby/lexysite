import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Server } from "node:http";
import express, { Router } from "express";
import { z } from "zod";
import { z as z4 } from "zod/v4";
import { validate } from "./validate";

let server: Server;
let origin: string;
let handlerCalls = 0;

before(async () => {
  const app = express();
  app.use(express.json());
  const router = Router();
  router.post(
    "/v4/:id",
    validate({ body: z4.object({ note: z4.string().min(1) }).strict() }),
    (req, res) => {
      const id: string = req.params.id;
      res.json({ id, body: req.body, validated: res.locals.validated });
    },
  );
  router.post(
    "/jobs/:jobId/candidates/:candidateId",
    validate({ body: z.object({ note: z.string().min(1) }) }),
    (req, res) => {
      const jobId: string = req.params.jobId;
      const candidateId: string = req.params.candidateId;
      // These are compile-time regressions, not runtime coercions.
      // @ts-expect-error A named parameter is not a wildcard array.
      const arrayId: string[] = req.params.jobId;
      void arrayId;
      handlerCalls++;
      res.json({ jobId, candidateId, body: req.body, validated: res.locals.validated });
    },
  );
  router.get(
    "/files/*parts",
    validate({ params: z.object({ parts: z.array(z.string()).min(1) }) }),
    (req, res) => {
      const parts: string[] = req.params.parts;
      // @ts-expect-error A wildcard is an array, not a scalar identifier.
      const scalarId: string = req.params.parts;
      void scalarId;
      res.json({ parts, validated: res.locals.validated });
    },
  );
  router.get(
    /^\/legacy\/([^/]+)$/,
    validate({ query: z.object({ page: z.coerce.number().int().min(1) }) }),
    (req, res) => {
      const id: string = req.params[0];
      res.json({ id, validated: res.locals.validated });
    },
  );
  app.use(router);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  origin = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server)
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
});

async function request(path: string, body?: unknown) {
  const response = await fetch(`${origin}${path}`, {
    method: body === undefined ? "GET" : "POST",
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  return { status: response.status, body: (await response.json()) as unknown };
}

test("Zod v4 schemas preserve parsed locals and the structured validation failures", async () => {
  const good = await request("/v4/fixture", { note: "Reviewed" });
  assert.equal(good.status, 200);
  assert.deepEqual(good.body, {
    id: "fixture",
    body: { note: "Reviewed" },
    validated: { body: { note: "Reviewed" } },
  });
  for (const input of [{ note: 12 }, { note: "Reviewed", extra: true }]) {
    const bad = await request("/v4/fixture", input);
    assert.equal(bad.status, 400);
    const parsed = z
      .object({
        error: z.literal("VALIDATION_FAILED"),
        issues: z
          .array(
            z.object({
              part: z.literal("body"),
              path: z.string(),
              code: z.string(),
              message: z.string(),
            }),
          )
          .min(1),
      })
      .parse(bad.body);
    assert.equal(parsed.issues[0].part, "body");
  }
});

test("named IDs remain literal scalars while parsed bodies strip unknown fields", async () => {
  const result = await request(
    "/jobs/legacy-job/candidates/candidate%2Fone?jobId=foreign&jobId=other",
    { note: "Reviewed", ignored: "not forwarded" },
  );
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    jobId: "legacy-job",
    candidateId: "candidate/one",
    body: { note: "Reviewed" },
    validated: { body: { note: "Reviewed" } },
  });
});

test("invalid bodies retain the structured 400 and never enter the handler", async () => {
  const callsBefore = handlerCalls;
  const result = await request("/jobs/legacy-job/candidates/one", { note: 12 });
  assert.equal(result.status, 400);
  const parsed = z
    .object({
      error: z.literal("VALIDATION_FAILED"),
      issues: z.array(z.object({ part: z.literal("body"), path: z.literal("body.note") })).min(1),
    })
    .parse(result.body);
  assert.equal(parsed.issues.length, 1);
  assert.equal(handlerCalls, callsBefore);
});

test("wildcard parameters remain arrays of decoded segments", async () => {
  const result = await request("/files/one/two%20words");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    parts: ["one", "two words"],
    validated: { params: { parts: ["one", "two words"] } },
  });
});

test("regular-expression routes retain scalar captures and parsed query locals", async () => {
  const result = await request("/legacy/older-id?page=2");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, { id: "older-id", validated: { query: { page: 2 } } });
  assert.equal((await request("/legacy/older-id?page=not-a-number")).status, 400);
});
