import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  interviewPlansTable as plans,
  interviewSessionsTable as sessions,
  interviewSummariesTable as summaries,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
  zohoCampaignReviewsTable as reviews,
} from "@workspace/db";
import { zohoCampaignReviews } from "./zoho-campaign-reviews";
import { zohoReviewInput, reviewAnswers, interviewScore } from "./zoho-review-policy";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import express from "express";
import { zohoFailure } from "./zoho-oauth-provider";

test("human review input requires explicit confirmation, lawful-length rationale and exact evidence revision", () => {
  const valid = {
    decision: "advance",
    reason: "Demonstrated the required job skills.",
    expectedRevision: "a".repeat(64),
    requestId: randomUUID(),
    confirm: true,
  };
  assert.equal(zohoReviewInput.safeParse(valid).success, true);
  for (const bad of [
    { ...valid, confirm: false },
    { ...valid, reason: "   " },
    { ...valid, expectedRevision: "old" },
    { ...valid, decision: "hire" },
    { ...valid, role: "platform_admin" },
    { ...valid, reason: "x".repeat(2001) },
  ])
    assert.equal(zohoReviewInput.safeParse(bad).success, false);
  assert.equal(interviewScore(0), 0);
  assert.equal(interviewScore(null), null);
  assert.equal(interviewScore(NaN), null);
  assert.equal(interviewScore("50"), null);
  assert.deepEqual(
    reviewAnswers(
      [
        {
          questionId: "q1",
          answer: "Answer",
          score: null,
          captureClarifications: [{ previousAnswer: "PRIVATE_CAPTURE_DIAGNOSTIC" }],
        },
      ],
      [{ id: "q1", text: "Question" }],
    ),
    { answers: [{ question: "Question", answer: "Answer", score: null }], truncated: false },
  );
  assert.equal(
    reviewAnswers([{ questionText: "Q", answer: "x".repeat(16001) }], []).truncated,
    true,
  );
});

test("review route rejects invalid paths, consent and unauthorized actors without a write", async () => {
  const app = express();
  let authorized = true;
  let writes = 0;
  const id = randomUUID();
  const recipientId = randomUUID();
  const response = {
    campaignId: id,
    recipientId,
    candidateName: "Synthetic Candidate",
    sessionId: randomUUID(),
    sessionStatus: "completed" as const,
    completedAt: new Date(),
    revision: "a".repeat(64),
    assessment: {
      score: null,
      summary: null,
      recommendation: null,
      strengths: [],
      developmentAreas: [],
      concerns: [],
    },
    answers: [],
    answersTruncated: false,
    reviewable: false,
    decisionStale: false,
    history: [],
  };
  app.use(express.json());
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          if (!authorized) throw zohoFailure("zoho_employer_admin_required", 403);
          return { id: "synthetic-admin", tenantId: "synthetic-employer" };
        },
        config: () => null,
        service: () => {
          throw Error("not used");
        },
      },
      undefined,
      undefined,
      undefined,
      () => ({
        ...zohoCampaignReviews(),
        detail: async () => response,
        record: async () => {
          writes++;
          return response;
        },
      }),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/zoho-recruit/campaigns`;
  const body = {
    decision: "hold",
    reason: "More role-specific evidence is needed.",
    expectedRevision: "a".repeat(64),
    requestId: randomUUID(),
    confirm: true,
  };
  const post = (campaign: string, recipient: string, data: unknown) =>
    fetch(`${base}/${campaign}/recipients/${recipient}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(data),
    });
  try {
    assert.equal((await post(id, recipientId, { ...body, confirm: false })).status, 400);
    assert.equal((await post("bad", recipientId, body)).status, 400);
    assert.equal((await post(id, recipientId, { ...body, candidateId: "forged" })).status, 400);
    assert.equal(writes, 0);
    assert.equal((await post(id, recipientId, body)).status, 200);
    authorized = false;
    assert.equal((await post(id, recipientId, body)).status, 403);
    assert.equal(writes, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("local synthetic evidence review preserves history, blocks stale concurrent decisions and never exposes unrelated interviews", async () => {
  const token = randomUUID();
  const tenantId = `zr_${token}`;
  const actor = { id: randomUUID(), tenantId };
  const jobId = randomUUID(),
    planId = randomUUID(),
    campaignId = randomUUID(),
    recipientId = randomUUID();
  const candidateId = randomUUID(),
    sessionId = randomUUID(),
    otherSessionId = randomUUID();
  const service = zohoCampaignReviews();
  const status = (error: unknown, expected: number) =>
    (error as { status?: number }).status === expected;
  try {
    const [db] = (
      await dbAdmin.execute(sql`SELECT current_database() AS name,inet_server_addr() AS host`)
    ).rows;
    assert.equal(db?.name, "heliumdb");
    assert.equal(db?.host, null, "fixture writes require the verified local development database");
    await dbAdmin
      .insert(tenantsTable)
      .values({ id: tenantId, name: "Synthetic review employer", slug: tenantId });
    await dbAdmin.insert(usersTable).values({
      id: actor.id,
      tenantId,
      name: "Synthetic reviewer",
      email: `${token}@example.test`,
      passwordHash: "not-a-login-credential",
      role: "tenant_admin",
      status: "active",
    });
    await dbAdmin
      .insert(jobsTable)
      .values({ id: jobId, tenantId, title: "Synthetic role", description: "Synthetic job" });
    await dbAdmin.insert(candidatesTable).values({
      id: candidateId,
      tenantId,
      firstName: "Synthetic",
      lastName: "Applicant",
      email: `applicant.${token}@example.test`,
      pool: "tenant",
    });
    await dbAdmin.insert(plans).values({
      id: planId,
      tenantId,
      jobId,
      title: "Synthetic job plan",
      questions: [{ id: "q1", text: "Explain a role-specific task." }],
    });
    await dbAdmin.insert(campaigns).values({
      id: campaignId,
      tenantId,
      accountRef: `synthetic_${token}`,
      revision: randomUUID(),
      jobId,
      externalJobId: "999",
      planId,
      frozenPlanId: planId,
      requestId: randomUUID(),
      snapshotHash: "a".repeat(64),
      briefHash: "b".repeat(64),
      applicationCount: 1,
      state: "approved",
      createdBy: actor.id,
      approvedBy: actor.id,
      approvedAt: new Date(),
    });
    await dbAdmin.insert(sessions).values([
      {
        id: sessionId,
        tenantId,
        applicationId: `ats-campaign:${recipientId}`,
        planId,
        candidateId,
        status: "completed",
        completedAt: new Date(),
        score: 55,
        totalQuestions: 1,
        answers: [
          {
            questionId: "q1",
            questionText: "Explain a role-specific task.",
            answer: "My job-related answer.",
            score: null,
          },
        ],
      },
      {
        id: otherSessionId,
        tenantId,
        applicationId: "private-development",
        planId,
        candidateId,
        status: "completed",
        completedAt: new Date(),
        totalQuestions: 1,
        answers: [{ questionText: "Private question", answer: "PRIVATE_COACHING_SENTINEL" }],
      },
    ]);
    await dbAdmin.insert(summaries).values({
      interviewSessionId: sessionId,
      overallScore: 0,
      recruiterSummary: "Role-specific summary only.",
      recommendation: "maybe",
      recruiterComments: "PRIVATE_COMMENT_SENTINEL",
      strengths: ["Job-related evidence"],
    });
    await dbAdmin.insert(recipients).values({
      id: recipientId,
      campaignId,
      tenantId,
      accountRef: `synthetic_${token}`,
      externalJobId: "999",
      externalApplicationId: "101",
      externalCandidateId: "201",
      candidateId,
      sessionId,
      state: "sent",
    });
    const initial = await service.detail(actor, campaignId, recipientId);
    assert.equal(initial.reviewable, true);
    assert.equal(initial.assessment.score, 0);
    assert.equal(initial.answers[0].answer, "My job-related answer.");
    assert.ok(!JSON.stringify(initial).includes("PRIVATE_"));
    await assert.rejects(
      service.detail({ ...actor, tenantId: "foreign" }, campaignId, recipientId),
      (e) => status(e, 404),
    );
    await assert.rejects(service.detail(actor, randomUUID(), recipientId), (e) => status(e, 404));
    const input = zohoReviewInput.parse({
      decision: "advance",
      reason: "Demonstrated the role-specific skills.",
      expectedRevision: initial.revision,
      requestId: randomUUID(),
      confirm: true,
    });
    const saved = await service.record(actor, campaignId, recipientId, input);
    assert.equal(saved.history.length, 1);
    assert.equal(saved.history[0].decision, "advance");
    assert.equal(saved.decisionStale, false);
    assert.equal((await service.record(actor, campaignId, recipientId, input)).history.length, 1);
    await assert.rejects(
      service.record(actor, campaignId, recipientId, {
        ...input,
        reason: "A changed payload must not reuse its key.",
      }),
      (e) => status(e, 409),
    );
    const attempts = await Promise.allSettled(
      ["hold", "decline"].map((decision) =>
        service.record(
          actor,
          campaignId,
          recipientId,
          zohoReviewInput.parse({
            decision,
            reason: "A revised job-related human judgment.",
            expectedRevision: saved.revision,
            requestId: randomUUID(),
            confirm: true,
          }),
        ),
      ),
    );
    assert.equal(attempts.filter((a) => a.status === "fulfilled").length, 1);
    const corrected = await service.detail(actor, campaignId, recipientId);
    assert.equal(corrected.history.length, 2);
    assert.equal(corrected.history[1].decision, "advance");
    await assert.rejects(
      dbAdmin
        .update(reviews)
        .set({ reason: "History must not be overwritten." })
        .where(eq(reviews.id, corrected.history[0].id)),
    );
    await dbAdmin
      .update(summaries)
      .set({ overallScore: 70 })
      .where(eq(summaries.interviewSessionId, sessionId));
    const changed = await service.detail(actor, campaignId, recipientId);
    assert.equal(changed.decisionStale, true);
    assert.ok(changed.history.every((e) => e.evidenceCurrent === false));
    await assert.rejects(
      service.record(actor, campaignId, recipientId, {
        ...input,
        requestId: randomUUID(),
        expectedRevision: corrected.revision,
      }),
      (e) => status(e, 409),
    );
    assert.equal((await service.queue(actor, campaignId)).rows[0].decisionStale, true);
    await dbAdmin
      .update(recipients)
      .set({ sessionId: otherSessionId })
      .where(eq(recipients.id, recipientId));
    await assert.rejects(service.detail(actor, campaignId, recipientId), (e) => status(e, 404));
    await dbAdmin.update(recipients).set({ sessionId }).where(eq(recipients.id, recipientId));
    await dbAdmin
      .update(candidatesTable)
      .set({ doNotContact: true })
      .where(eq(candidatesTable.id, candidateId));
    await assert.rejects(service.detail(actor, campaignId, recipientId), (e) => status(e, 404));
    assert.equal((await service.queue(actor, campaignId)).rows[0].candidateName, null);
    await dbAdmin
      .update(candidatesTable)
      .set({ doNotContact: false })
      .where(eq(candidatesTable.id, candidateId));
    await dbAdmin.delete(summaries).where(eq(summaries.interviewSessionId, sessionId));
    assert.equal((await service.detail(actor, campaignId, recipientId)).assessment.summary, null);
    assert.equal((await service.detail(actor, campaignId, recipientId)).reviewable, true);
    await dbAdmin
      .update(sessions)
      .set({ status: "in_progress", completedAt: null })
      .where(eq(sessions.id, sessionId));
    const incomplete = await service.detail(actor, campaignId, recipientId);
    assert.equal(incomplete.reviewable, false);
    await assert.rejects(
      service.record(actor, campaignId, recipientId, {
        ...input,
        expectedRevision: incomplete.revision,
        requestId: randomUUID(),
      }),
      (e) => status(e, 409),
    );
    await dbAdmin
      .update(usersTable)
      .set({ status: "suspended" })
      .where(eq(usersTable.id, actor.id));
    await assert.rejects(service.detail(actor, campaignId, recipientId));
  } finally {
    await dbAdmin.delete(campaigns).where(eq(campaigns.tenantId, tenantId)); // Cascades recipients and reviews.
    await dbAdmin
      .delete(summaries)
      .where(sql`${summaries.interviewSessionId} IN (${sessionId},${otherSessionId})`);
    await dbAdmin.delete(sessions).where(eq(sessions.tenantId, tenantId));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, tenantId));
    await dbAdmin.delete(plans).where(eq(plans.tenantId, tenantId));
    await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, tenantId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, tenantId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  }
});
