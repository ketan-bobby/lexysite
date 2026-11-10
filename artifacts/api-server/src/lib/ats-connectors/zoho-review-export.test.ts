import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import express from "express";
import type { InsertAuditLog } from "@workspace/db";
import { CalendarError } from "../outlook-calendar-core";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import { zohoReviewExport, zohoReviewExportInput } from "./zoho-review-export";
import type { zohoStageHandoff } from "./zoho-stage-handoff";
import type { zohoCampaignReviews } from "./zoho-campaign-reviews";

const stamp = "2026-11-03T00:00:00.000Z";
type Handoff = Awaited<ReturnType<ReturnType<typeof zohoStageHandoff>["detail"]>>;
type Review = Awaited<ReturnType<ReturnType<typeof zohoCampaignReviews>["detail"]>>;
function fixture() {
  const actor = { id: randomUUID(), tenantId: randomUUID() };
  const campaignId = randomUUID();
  const recipientId = randomUUID();
  const review: Review = {
    campaignId,
    recipientId,
    sessionId: randomUUID(),
    candidateName: "PRIVATE_CANDIDATE_NAME",
    sessionStatus: "completed",
    completedAt: new Date(stamp),
    revision: "a".repeat(64),
    reviewable: true,
    decisionStale: false,
    answersTruncated: false,
    assessment: {
      score: 0,
      summary: "PRIVATE_ASSESSMENT",
      recommendation: null,
      strengths: [],
      developmentAreas: [],
      concerns: [],
    },
    answers: [{ question: "Question", answer: "PRIVATE_ANSWER", score: null }],
    history: [
      {
        id: randomUUID(),
        evidenceCurrent: true,
        decision: "hold",
        reason: "PRIVATE_HUMAN_REASON",
        reviewedBy: actor.id,
        createdAt: new Date(stamp),
      },
    ],
  };
  const handoff = {
    campaignId,
    recipientId,
    applicationId: "9007199254740993001",
    externalJobId: "9007199254740993002",
    externalCandidateId: "9007199254740993003",
    revision: "b".repeat(64),
    decision: "hold",
  };
  const audits: InsertAuditLog[] = [];
  let reads = 0;
  const service = zohoReviewExport({
    readReview: async (caller, campaign, recipient) => {
      assert.deepEqual(caller, actor);
      assert.equal(campaign, campaignId);
      assert.equal(recipient, recipientId);
      reads++;
      return structuredClone(review);
    },
    // The injected response omits unused mapping/history properties deliberately.
    readHandoff: async () => structuredClone(handoff) as Handoff,
    persist: async (row) => {
      audits.push(row);
      return row.id;
    },
    now: () => new Date(stamp),
  });
  const input = {
    expectedRevision: review.revision,
    expectedHandoffRevision: handoff.revision,
    confirm: true as const,
  };
  return {
    actor,
    campaignId,
    recipientId,
    review,
    handoff,
    audits,
    service,
    input,
    reads: () => reads,
  };
}

test("preparation saves only server-derived scope and review references, never packet content", async () => {
  const f = fixture();
  const receipt = await f.service.prepare(f.actor, f.campaignId, f.recipientId, f.input);
  assert.equal(f.reads(), 2);
  assert.equal(f.audits.length, 1);
  const row = f.audits[0];
  assert.equal(row.id, receipt.id);
  assert.equal(row.tenantId, f.actor.tenantId);
  assert.equal(row.actorId, f.actor.id);
  assert.equal(row.subjectId, f.recipientId);
  assert.equal(row.action, "zoho.review_export.prepared");
  assert.equal(row.body, undefined);
  assert.deepEqual(row.metadata, {
    provider: "zoho_recruit",
    campaignId: f.campaignId,
    recipientId: f.recipientId,
    reviewId: f.review.history[0].id,
    reviewRevision: f.review.revision,
    handoffRevision: f.handoff.revision,
    state: "prepared",
    delivery: "unverified",
  });
  assert.equal(receipt.preparedAt.toISOString(), stamp);
  assert.equal(receipt.delivery, "unverified");
  assert.doesNotMatch(JSON.stringify(f.audits), /PRIVATE|900719925474099300/);
});

for (const state of [
  "unreviewed",
  "stale",
  "incomplete",
  "truncated",
  "foreign",
  "binding",
  "handoff-revision",
  "decision",
]) {
  test(`refuses ${state} preparation without persisting an audit success`, async () => {
    const f = fixture();
    if (state === "unreviewed") f.review.history = [];
    if (state === "stale") f.review.decisionStale = true;
    if (state === "incomplete") f.review.sessionStatus = "in_progress";
    if (state === "truncated") f.review.answersTruncated = true;
    if (state === "foreign") f.review.campaignId = randomUUID();
    if (state === "binding") f.handoff.externalCandidateId = "not-an-id";
    if (state === "handoff-revision") f.handoff.revision = "c".repeat(64);
    if (state === "decision") f.handoff.decision = "advance";
    await assert.rejects(f.service.prepare(f.actor, f.campaignId, f.recipientId, f.input), {
      status: 409,
    });
    assert.equal(f.audits.length, 0);
  });
}

test("refuses corrections or permission loss during preparation before auditing", async () => {
  for (const failure of ["permission", "correction"]) {
    const f = fixture();
    let calls = 0;
    const service = zohoReviewExport({
      readReview: async () => {
        if (++calls === 2) {
          if (failure === "permission") throw new CalendarError(404, "not_found", "Unavailable.");
          f.review.history[0].id = randomUUID();
        }
        return structuredClone(f.review);
      },
      readHandoff: async () => f.handoff as Handoff,
      persist: async (row) => {
        f.audits.push(row);
        return row.id;
      },
    });
    await assert.rejects(service.prepare(f.actor, f.campaignId, f.recipientId, f.input));
    assert.equal(f.audits.length, 0);
  }
});

test("strict preparation input refuses false consent, extra client identity or malformed revisions", () => {
  const f = fixture();
  assert.equal(zohoReviewExportInput.safeParse(f.input).success, true);
  for (const bad of [
    { ...f.input, confirm: false },
    { ...f.input, tenantId: f.actor.tenantId },
    { ...f.input, expectedRevision: "old" },
    { ...f.input, expectedHandoffRevision: "old" },
  ])
    assert.equal(zohoReviewExportInput.safeParse(bad).success, false);
});

test("audit persistence failure never returns a preparation receipt", async () => {
  for (const missing of [false, true]) {
    const f = fixture();
    const service = zohoReviewExport({
      readReview: async () => structuredClone(f.review),
      readHandoff: async () => f.handoff as Handoff,
      persist: async () => {
        if (missing) return undefined;
        throw new Error("Synthetic audit failure");
      },
    });
    await assert.rejects(service.prepare(f.actor, f.campaignId, f.recipientId, f.input));
  }
});

test("default persistence checks the locked binding twice and never inserts after either refusal", async () => {
  for (const deniedAt of [1, 2]) {
    const f = fixture();
    let reads = 0;
    let inserts = 0;
    const store = {
      transaction: async (work: (tx: unknown) => Promise<unknown>) =>
        work({
          execute: async () => ({ rows: ++reads === deniedAt ? [] : [{ id: "candidate" }] }),
          insert: () => {
            inserts++;
            throw new Error("Unexpected insert after refusal");
          },
        }),
    } as unknown as NonNullable<Parameters<typeof zohoReviewExport>[0]>["store"];
    const service = zohoReviewExport({
      store,
      readReview: async () => structuredClone(f.review),
      readHandoff: async () => f.handoff as Handoff,
    });
    await assert.rejects(service.prepare(f.actor, f.campaignId, f.recipientId, f.input), {
      status: 409,
    });
    assert.equal(reads, deniedAt);
    assert.equal(inserts, 0);
  }
});

test("a commit failure cannot become a successful receipt or an automatic second preparation", async () => {
  const f = fixture();
  let transactions = 0;
  let inserts = 0;
  const store = {
    transaction: async (work: (tx: unknown) => Promise<unknown>) => {
      transactions++;
      await work({
        execute: async () => ({ rows: [{ id: "candidate" }] }),
        insert: () => ({
          values: (row: InsertAuditLog) => ({
            returning: async () => {
              inserts++;
              return [{ id: row.id }];
            },
          }),
        }),
      });
      throw new Error("Synthetic commit refusal");
    },
  } as unknown as NonNullable<Parameters<typeof zohoReviewExport>[0]>["store"];
  const service = zohoReviewExport({
    store,
    readReview: async () => structuredClone(f.review),
    readHandoff: async () => f.handoff as Handoff,
  });
  await assert.rejects(
    service.prepare(f.actor, f.campaignId, f.recipientId, f.input),
    /Synthetic commit refusal/,
  );
  assert.equal(transactions, 1);
  assert.equal(inserts, 1);
});

test("HTTP preparation resolves staff authority, validates exact inputs and never falls back after failure", async () => {
  const f = fixture();
  let authorized = true;
  let unavailable = false;
  let prepares = 0;
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          if (!authorized) throw new CalendarError(403, "forbidden", "Employer admin required.");
          return f.actor;
        },
        config: () => null,
        service: () => {
          throw new Error("No OAuth call allowed");
        },
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        prepare: async (...args) => {
          prepares++;
          if (unavailable) throw new Error("PRIVATE_AUDIT_ERROR");
          return f.service.prepare(...args);
        },
      }),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const path = `/api/zoho-recruit/campaigns/${f.campaignId}/recipients/${f.recipientId}/review-export`;
  const send = (body: unknown, target = path) =>
    fetch(origin + target, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const ok = await send(f.input);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("cache-control"), "no-store");
    assert.equal(((await ok.json()) as { delivery: string }).delivery, "unverified");
    for (const body of [
      { ...f.input, confirm: false },
      { ...f.input, actorId: "spoof" },
    ])
      assert.equal((await send(body)).status, 400);
    assert.equal((await send(f.input, path.replace(f.campaignId, "foreign"))).status, 400);
    assert.equal(prepares, 1);
    authorized = false;
    assert.equal((await send(f.input)).status, 403);
    assert.equal(prepares, 1);
    authorized = true;
    unavailable = true;
    const failed = await send(f.input);
    assert.ok(failed.status >= 400);
    assert.doesNotMatch(await failed.text(), /PRIVATE_AUDIT_ERROR/);
    assert.equal(f.audits.length, 1);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
