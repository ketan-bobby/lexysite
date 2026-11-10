import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  candidatesTable,
  interviewPlansTable as plans,
  interviewSessionsTable as sessions,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
  zohoCampaignReviewsTable as reviews,
  zohoStageHandoffEventsTable as events,
  zohoStageMappingsTable as mappings,
} from "@workspace/db";
import {
  stageMappingInput,
  stageHandoffInput,
  handoffReadiness,
} from "./zoho-stage-handoff-policy";
import { zohoStageHandoff } from "./zoho-stage-handoff";
import { zohoCampaignReviews } from "./zoho-campaign-reviews";
import { zohoInterviewCampaigns } from "./zoho-interview-campaigns";
import express from "express";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import { zohoFailure } from "./zoho-oauth-provider";
import { emptyMapping } from "./zoho-stage-handoff-policy";

test("handoff HTTP routes reject live mode, forged fields, missing consent and unauthorized staff", async () => {
  const campaignId = randomUUID(),
    recipientId = randomUUID();
  let authorized = true,
    writes = 0;
  const view = {
    campaignId,
    recipientId,
    applicationId: "101",
    externalJobId: "999",
    externalCandidateId: "201",
    revision: "a".repeat(64),
    mapping: emptyMapping(campaignId),
    decision: null,
    targetStatus: null,
    ready: false,
    liveEnabled: false,
    reason: "Simulation only.",
    history: [],
  };
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          if (!authorized) throw zohoFailure("zoho_employer_admin_required", 403);
          return { id: "synthetic", tenantId: "synthetic" };
        },
        service: () => {
          throw Error("unused");
        },
        config: () => null,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        ...zohoStageHandoff(),
        detail: async () => view,
        saveMapping: async () => {
          writes++;
          return view.mapping;
        },
        simulate: async () => {
          writes++;
          return view;
        },
      }),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}/api/zoho-recruit/campaigns/${campaignId}`;
  const input = {
    expectedRevision: view.revision,
    requestId: randomUUID(),
    confirm: true,
    mode: "simulation",
  };
  const post = (body: unknown) =>
    fetch(`${base}/recipients/${recipientId}/handoff`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    for (const change of [
      { mode: "live" },
      { confirm: false },
      { targetStatus: "Hired" },
      { expectedRevision: "old" },
    ])
      assert.equal((await post({ ...input, ...change })).status, 400);
    assert.equal(writes, 0);
    assert.equal((await post(input)).status, 200);
    authorized = false;
    assert.equal((await post(input)).status, 403);
    assert.equal((await fetch(`${base}/recipients/${recipientId}/handoff`)).status, 403);
    assert.equal(writes, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("handoff storage is private, simulation-only, immutable, deduplicated and erasure-linked", async () => {
  const source = readFileSync(
    new URL("../../../../../scripts/sql/check-zoho-handoff-storage.sql", import.meta.url),
    "utf8",
  );
  const query = source
    .replace(/^.*BEGIN READ ONLY;/s, "")
    .replace(/ROLLBACK;\s*$/, "")
    .trim();
  const result = await dbAdmin.execute(sql.raw(query));
  assert.equal(result.rows.length, 12);
  assert.deepEqual(
    result.rows.filter((r) => r.passed !== true),
    [],
  );
});

test("stage handoff requires explicit simulation, exact revision and proposed statuses", () => {
  const body = {
    expectedRevision: "a".repeat(64),
    requestId: randomUUID(),
    confirm: true,
    mode: "simulation",
  };
  assert.equal(stageHandoffInput.safeParse(body).success, true);
  for (const extra of [
    { mode: "live" },
    { confirm: false },
    { expectedRevision: "old" },
    { status: "Hired" },
    { candidateId: "foreign" },
  ])
    assert.equal(stageHandoffInput.safeParse({ ...body, ...extra }).success, false);
  const mapping = {
    expectedRevision: body.expectedRevision,
    advance: "Next interview",
    hold: null,
    decline: "Not selected",
    confirm: true,
  };
  assert.equal(stageMappingInput.safeParse(mapping).success, true);
  for (const extra of [
    { confirm: false },
    { advance: "" },
    { advance: "bad\nstatus" },
    { advance: "x".repeat(101) },
    { liveEnabled: true },
  ])
    assert.equal(stageMappingInput.safeParse({ ...mapping, ...extra }).success, false);
  const review = { reviewable: true, decisionStale: false, history: [{ decision: "advance" }] };
  assert.equal(handoffReadiness(review, mapping).ready, true);
  assert.equal(handoffReadiness({ ...review, decisionStale: true }, mapping).ready, false);
  assert.equal(handoffReadiness({ ...review, reviewable: false }, mapping).ready, false);
  assert.equal(handoffReadiness({ ...review, history: [] }, mapping).ready, false);
  assert.equal(handoffReadiness(review, { ...mapping, advance: null }).ready, false);
  const corrected = handoffReadiness(
    {
      ...review,
      history: [{ decision: "hold" }, { decision: "advance" }],
    },
    { ...mapping, hold: "On-Hold" },
  );
  assert.equal(corrected.decision, "hold");
  assert.equal(corrected.targetStatus, "On-Hold");
  assert.equal(corrected.ready, true);
  assert.equal(
    handoffReadiness(
      {
        ...review,
        history: [{ decision: "decline" }, { decision: "hold" }, { decision: "advance" }],
      },
      { ...mapping, decline: null },
    ).ready,
    false,
    "an old mapped decision must not make an unmapped correction ready",
  );
});

test("isolated handoff persists proposed mappings and immutable deduplicated simulation history without provider contact", async () => {
  const token = randomUUID(),
    tenantId = `zh_${token}`;
  const actor = { id: randomUUID(), tenantId };
  const jobId = randomUUID(),
    planId = randomUUID(),
    campaignId = randomUUID();
  const candidateId = randomUUID(),
    recipientId = randomUUID(),
    sessionId = randomUUID();
  const service = zohoStageHandoff(),
    reviewService = zohoCampaignReviews();
  const fails = (status: number) => (e: unknown) => (e as { status?: number }).status === status;
  try {
    const [identity] = (
      await dbAdmin.execute(sql`SELECT current_database() AS name,inet_server_addr() AS host`)
    ).rows;
    assert.equal(identity?.name, "heliumdb");
    assert.equal(identity?.host, null, "fixture writes require local development");
    await dbAdmin
      .insert(tenantsTable)
      .values({ id: tenantId, name: "Synthetic handoff employer", slug: tenantId });
    await dbAdmin.insert(usersTable).values({
      id: actor.id,
      tenantId,
      name: "Synthetic admin",
      email: `${token}@example.test`,
      passwordHash: "not-a-login",
      role: "tenant_admin",
      status: "active",
    });
    await dbAdmin.insert(jobsTable).values({
      id: jobId,
      tenantId,
      title: "Synthetic role",
      description: "Synthetic",
      status: "active",
    });
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
      jobId,
      tenantId,
      title: "Synthetic plan",
      questions: [{ id: "q1", question: "Explain a task.", category: "technical" }],
    });
    await dbAdmin.insert(campaigns).values({
      id: campaignId,
      tenantId,
      createdBy: actor.id,
      accountRef: `synthetic_${token}`,
      revision: randomUUID(),
      jobId,
      externalJobId: "999",
      planId,
      frozenPlanId: planId,
      state: "approved",
      snapshotHash: "a".repeat(64),
      briefHash: "b".repeat(64),
      requestId: randomUUID(),
      applicationCount: 1,
      approvedBy: actor.id,
      approvedAt: new Date(),
      dispatchLane: "isolated_test",
    });
    await dbAdmin.insert(sessions).values({
      id: sessionId,
      tenantId,
      candidateId,
      planId,
      applicationId: `ats-campaign:${recipientId}`,
      status: "completed",
      completedAt: new Date(),
      totalQuestions: 1,
      answers: [{ questionId: "q1", questionText: "Explain a task.", answer: "Synthetic answer." }],
    });
    await dbAdmin.insert(recipients).values({
      id: recipientId,
      tenantId,
      campaignId,
      accountRef: `synthetic_${token}`,
      externalJobId: "999",
      externalApplicationId: "101",
      externalCandidateId: "201",
      candidateId,
      sessionId,
      state: "simulated",
    });
    let view = await service.detail(actor, campaignId, recipientId);
    assert.equal(view.liveEnabled, false);
    assert.equal(view.ready, false);
    assert.equal(view.applicationId, "101");
    const mapInput = stageMappingInput.parse({
      expectedRevision: view.mapping.revision,
      advance: "Technical round",
      hold: null,
      decline: "Not selected",
      confirm: true,
    });
    const firstMapping = await service.saveMapping(actor, campaignId, mapInput);
    await assert.rejects(service.saveMapping(actor, campaignId, mapInput), fails(409));
    const initialReview = await reviewService.detail(actor, campaignId, recipientId);
    await reviewService.record(actor, campaignId, recipientId, {
      decision: "advance",
      reason: "Demonstrated the required job skills.",
      expectedRevision: initialReview.revision,
      requestId: randomUUID(),
      confirm: true,
    });
    view = await service.detail(actor, campaignId, recipientId);
    assert.equal(view.ready, true);
    assert.equal(view.targetStatus, "Technical round");
    const input = stageHandoffInput.parse({
      expectedRevision: view.revision,
      requestId: randomUUID(),
      mode: "simulation",
      confirm: true,
    });
    const reviewedEvidence = await reviewService.detail(actor, campaignId, recipientId);
    const campaignService = zohoInterviewCampaigns();
    // A same-tenant child is not proof of the campaign's external account/job binding.
    for (const mismatch of [
      { accountRef: `different_${token}` },
      { externalJobId: "different-job" },
    ]) {
      await dbAdmin.update(recipients).set(mismatch).where(eq(recipients.id, recipientId));
      try {
        const campaignView = await campaignService.detail(actor, campaignId);
        assert.equal(campaignView.recipients.length, 0);
        assert.equal(campaignView.campaign.recipientCount, 0);
        assert.equal((await reviewService.queue(actor, campaignId)).rows.length, 0);
        await assert.rejects(reviewService.detail(actor, campaignId, recipientId), fails(404));
        await assert.rejects(service.detail(actor, campaignId, recipientId), fails(404));
        await assert.rejects(service.simulate(actor, campaignId, recipientId, input), fails(404));
        await assert.rejects(
          reviewService.record(actor, campaignId, recipientId, {
            decision: "hold",
            reason: "This mismatched applicant must not receive a decision.",
            expectedRevision: reviewedEvidence.revision,
            requestId: randomUUID(),
            confirm: true,
          }),
          fails(404),
        );
        assert.equal(
          (await dbAdmin.select().from(events).where(eq(events.recipientId, recipientId))).length,
          0,
        );
        assert.equal(
          (await dbAdmin.select().from(reviews).where(eq(reviews.recipientId, recipientId))).length,
          1,
        );
      } finally {
        await dbAdmin
          .update(recipients)
          .set({ accountRef: `synthetic_${token}`, externalJobId: "999" })
          .where(eq(recipients.id, recipientId));
      }
    }
    const results = await Promise.all([
      service.simulate(actor, campaignId, recipientId, input),
      service.simulate(actor, campaignId, recipientId, input),
    ]);
    assert.equal(results[0].history.length, 1);
    assert.equal(results[1].history.length, 1);
    assert.equal(results[0].history[0].state, "simulated");
    assert.equal(
      (
        await service.simulate(actor, campaignId, recipientId, {
          ...input,
          requestId: randomUUID(),
        })
      ).history.length,
      1,
    );
    await assert.rejects(
      service.simulate(actor, campaignId, recipientId, { ...input, mode: "live" } as never),
    );
    await assert.rejects(
      service.simulate(actor, campaignId, recipientId, {
        ...input,
        expectedRevision: "f".repeat(64),
      }),
      fails(409),
    );
    await assert.rejects(
      service.detail({ ...actor, tenantId: "foreign" }, campaignId, recipientId),
      fails(404),
    );
    await assert.rejects(service.detail(actor, randomUUID(), recipientId), fails(404));
    await assert.rejects(service.detail(actor, campaignId, randomUUID()), fails(404));
    await assert.rejects(
      dbAdmin
        .update(events)
        .set({ targetStatus: "Hired" })
        .where(eq(events.recipientId, recipientId)),
    );
    // Saving a revised mapping invalidates old simulation approval.
    await service.saveMapping(actor, campaignId, {
      ...mapInput,
      expectedRevision: firstMapping.revision,
      advance: "Panel interview",
    });
    await assert.rejects(
      service.simulate(actor, campaignId, recipientId, { ...input, requestId: randomUUID() }),
      fails(409),
    );
    await dbAdmin
      .update(sessions)
      .set({ answers: [{ questionId: "q1", answer: "Changed evidence." }] })
      .where(eq(sessions.id, sessionId));
    assert.equal((await service.detail(actor, campaignId, recipientId)).ready, false);
    await dbAdmin
      .update(candidatesTable)
      .set({ doNotContact: true })
      .where(eq(candidatesTable.id, candidateId));
    await assert.rejects(service.detail(actor, campaignId, recipientId), fails(404));
    await dbAdmin
      .update(candidatesTable)
      .set({ doNotContact: false })
      .where(eq(candidatesTable.id, candidateId));
    await dbAdmin
      .update(usersTable)
      .set({ status: "suspended" })
      .where(eq(usersTable.id, actor.id));
    await assert.rejects(service.detail(actor, campaignId, recipientId));
    const rows = await dbAdmin
      .select()
      .from(events)
      .where(and(eq(events.tenantId, tenantId), eq(events.recipientId, recipientId)));
    assert.equal(rows.length, 1);
    assert.equal(rows[0].targetStatus, "Technical round");
  } finally {
    await dbAdmin.delete(events).where(eq(events.tenantId, tenantId));
    await dbAdmin.delete(mappings).where(eq(mappings.tenantId, tenantId));
    await dbAdmin.delete(reviews).where(eq(reviews.tenantId, tenantId));
    await dbAdmin.delete(recipients).where(eq(recipients.tenantId, tenantId));
    await dbAdmin.delete(campaigns).where(eq(campaigns.tenantId, tenantId));
    await dbAdmin.delete(sessions).where(eq(sessions.tenantId, tenantId));
    await dbAdmin.delete(plans).where(eq(plans.tenantId, tenantId));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, tenantId));
    await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, tenantId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.tenantId, tenantId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  }
});
