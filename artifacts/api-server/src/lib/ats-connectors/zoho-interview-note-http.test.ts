import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { test } from "node:test";
import express from "express";
import { z } from "zod/v4";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import { CalendarError } from "../outlook-calendar-core";
import { zohoOAuthService } from "./zoho-oauth-service";
import { zohoInterviewNotes } from "./zoho-interview-notes";

test("real JSON note routes validate approval, bind IDs, serialize receipt dates and deny non-admin access", async () => {
  const actor = { id: "fixture", tenantId: "employer" },
    campaign = randomUUID(),
    recipient = randomUUID();
  let permitted = true,
    writes = 0;
  const receipt = {
    id: randomUUID(),
    revision: "a".repeat(64),
    state: "published" as const,
    providerNoteId: "999",
    at: "2026-11-05T01:00:00.000Z",
  };
  const notes = {
    async preview(a: typeof actor, c: string, r: string, input: { includeAssessment: boolean }) {
      assert.deepEqual(a, actor);
      assert.equal(c, campaign);
      assert.equal(r, recipient);
      return {
        revision: receipt.revision,
        title: "title",
        content: "content",
        destination: "Candidates",
        externalCandidateId: "123",
        externalJobId: "456",
        applicationId: "789",
        includeAssessment: input.includeAssessment,
        writeAuthorized: true,
        canPublish: true,
        history: [receipt],
      };
    },
    async publish() {
      writes++;
      return receipt;
    },
  };
  const router = zohoRecruitAccountRouter(
    {
      actor: async () => {
        if (!permitted)
          throw new CalendarError(403, "zoho_admin_required", "Employer administrator required.");
        return actor;
      },
      service: zohoOAuthService,
      config: () => null,
    },
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    (() => notes) as unknown as typeof zohoInterviewNotes,
  );
  const app = express();
  app.use(express.json());
  app.use("/api", router);
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}/api/zoho-recruit/campaigns/${campaign}/recipients/${recipient}`;
  const request = (path: string, body: unknown) =>
    fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const preview = await request("/note-preview", { includeAssessment: false });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("cache-control"), "no-store");
    assert.equal(
      z.object({ history: z.array(z.object({ at: z.string() })) }).parse(await preview.json())
        .history[0].at,
      receipt.at,
    );
    for (const body of [
      { includeAssessment: true, expectedRevision: receipt.revision, confirm: false },
      {
        includeAssessment: false,
        expectedRevision: receipt.revision,
        confirm: true,
        content: "override",
      },
    ])
      assert.equal((await request("/note-publication", body)).status, 400);
    assert.equal(writes, 0);
    const published = await request("/note-publication", {
      includeAssessment: true,
      expectedRevision: receipt.revision,
      confirm: true,
    });
    assert.equal(published.status, 200);
    assert.equal(z.object({ at: z.string() }).parse(await published.json()).at, receipt.at);
    assert.equal(writes, 1);
    permitted = false;
    assert.equal((await request("/note-preview", { includeAssessment: false })).status, 403);
    assert.equal(
      (
        await request("/note-publication", {
          includeAssessment: true,
          expectedRevision: receipt.revision,
          confirm: true,
        })
      ).status,
      403,
    );
    assert.equal(writes, 1);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
