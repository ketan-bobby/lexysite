import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  tenantsTable,
  usersTable,
  jobsTable,
  interviewPlansTable as plans,
  interviewSessionsTable as sessions,
  candidatesTable,
  atsCandidateProfilesTable as profiles,
  zohoImportedJobsTable as importedJobs,
  zohoInterviewCampaignsTable as campaigns,
  zohoCampaignRecipientsTable as recipients,
} from "@workspace/db";
import { zohoInterviewCampaigns } from "./zoho-interview-campaigns";
import { zohoCampaignDispatcher } from "./zoho-campaign-dispatch";
import { zohoReviewedImport } from "./zoho-reviewed-import";
import {
  campaignDelivery,
  campaignRecipients,
  campaignAction,
  campaignJobIsOpen,
  campaignApplicationIsEligible,
} from "./zoho-campaign-policy";
import type { SendEmailInput } from "../email";
import express from "express";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import { zohoFailure } from "./zoho-oauth-provider";
import { sendReEngagement } from "../agents/interview-reply";
import { zohoCampaignReviews } from "./zoho-campaign-reviews";
import { zohoStageHandoff } from "./zoho-stage-handoff";

test("campaign policy refuses implicit approval and never treats simulation or uncertain sends as delivery", () => {
  assert.throws(
    () => zohoCampaignDispatcher({ tenantId: "fixture", dispatchLane: "isolated_test" }),
    /requires a tenant and injected source and delivery/,
  );
  assert.throws(
    () =>
      zohoCampaignDispatcher({
        dispatchLane: "isolated_test",
        source: () => zohoReviewedImport(),
        send: async () => ({ ok: true }),
      }),
    /requires a tenant and injected source and delivery/,
  );
  assert.equal(campaignJobIsOpen({ data: [{ Job_Opening_Status: "In-progress" }] }), true);
  assert.equal(campaignJobIsOpen({ data: [{ Job_Opening_Status: "Filled" }] }), false);
  assert.equal(campaignJobIsOpen({ data: [{}] }), false);
  assert.equal(campaignApplicationIsEligible({ Application_Status: "New" }), true);
  assert.equal(campaignApplicationIsEligible({ Application_Status: "Withdrawn" }), false);
  assert.equal(
    campaignApplicationIsEligible({ Application_Status: "Unknown custom state" }),
    false,
  );
  assert.equal(
    campaignAction.safeParse({ action: "approve", snapshotHash: "a".repeat(64), confirm: false })
      .success,
    false,
  );
  assert.equal(
    campaignAction.safeParse({
      action: "approve",
      snapshotHash: "a".repeat(64),
      confirm: true,
      email: "injected@example.test",
    }).success,
    false,
  );
  assert.deepEqual(
    campaignRecipients([
      { applicationId: "2", candidateId: "9" },
      { applicationId: "1", candidateId: "9" },
    ]),
    [{ applicationId: "1", candidateId: "9" }],
  );
  assert.equal(
    campaignDelivery({ ok: true, simulated: true, messageId: "mock" }).state,
    "simulated",
  );
  assert.equal(campaignDelivery({ ok: true, suppressed: true }).state, "simulated");
  assert.equal(campaignDelivery({ ok: false }).state, "review_required");
  assert.equal(campaignDelivery({ ok: true }).state, "review_required");
  assert.equal(campaignDelivery({ ok: true, messageId: "provider-receipt" }).state, "sent");
});

test("campaign HTTP gates reject missing consent, extra fields, invalid IDs and unauthorized callers before side effects", async () => {
  let authorized = true;
  let actions = 0;
  const id = randomUUID();
  const campaign = {
    id,
    jobId: "job",
    externalJobId: "999",
    planId: "plan",
    state: "draft",
    snapshotHash: "a".repeat(64),
    applicationCount: 1,
    recipientCount: 1,
    createdAt: new Date(),
    counts: [{ state: "draft", count: 1 }],
  };
  const detail = {
    campaign,
    recipients: [
      {
        id: randomUUID(),
        applicationId: "1",
        candidateId: "2",
        state: "draft",
        reason: null,
        sessionId: null,
        interviewStatus: null,
        deliveryEvidence: {
          acceptance: "unknown",
          providerMessageId: null,
          lastStateChangeAt: new Date(),
          needsReview: false,
          delivery: "unverified" as const,
        },
      },
    ],
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
        config: () => null,
        service: () => {
          throw Error("not used");
        },
      },
      undefined,
      undefined,
      () => ({
        ...zohoInterviewCampaigns(),
        workspace: async () => ({ jobs: [], campaigns: [campaign] }),
        detail: async () => detail,
        create: async () => {
          actions++;
          return detail;
        },
        act: async () => {
          actions++;
          return detail;
        },
      }),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/zoho-recruit/campaigns`;
  const post = (path: string, body: unknown) =>
    fetch(url + path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    assert.equal((await fetch(url)).status, 200);
    const body = {
      revision: randomUUID(),
      jobId: "job",
      planId: "plan",
      requestId: randomUUID(),
      confirm: true,
    };
    assert.equal((await post("", { ...body, confirm: false })).status, 400);
    assert.equal((await post("", { ...body, to: "cannot-inject@example.test" })).status, 400);
    assert.equal(
      (await post("", { ...body, dispatchLane: "isolated_test" })).status,
      400,
      "dispatch isolation is internal, never caller-controlled",
    );
    assert.equal(
      (
        await post("/bad-id/action", {
          action: "approve",
          snapshotHash: "a".repeat(64),
          confirm: true,
        })
      ).status,
      400,
    );
    assert.equal(actions, 0);
    const valid = await post("", body);
    assert.equal(valid.status, 200);
    const wire = (await valid.json()) as { campaign: { createdAt: string } };
    assert.equal(wire.campaign.createdAt, campaign.createdAt.toISOString());
    authorized = false;
    assert.equal(
      (
        await post(`/${id}/action`, {
          action: "approve",
          snapshotHash: "a".repeat(64),
          confirm: true,
        })
      ).status,
      403,
    );
    assert.equal(actions, 1);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("synthetic DB campaign journey: approved dispatch, completed evidence, corrected human reviews, handoff and delivery holds", async () => {
  const token = randomUUID();
  const tenantId = `zc_${token}`;
  const jobId = randomUUID();
  const planId = randomUUID();
  const actor = { id: `admin_${token}`, tenantId };
  const revision = randomUUID();
  let apps = [
    { applicationId: "101", candidateId: "201" },
    { applicationId: "102", candidateId: "201" },
    { applicationId: "103", candidateId: "202" },
  ];
  let active = true;
  let mode = "sent";
  const sent: SendEmailInput[] = [];
  const actorLookup = async () => {
    if (!active) throw Error("suspended");
    return actor;
  };
  const source = () => ({
    ...zohoReviewedImport(),
    campaignSource: async () => ({
      accountRef: `account_${token}`,
      assertCurrent: async () => undefined,
      lockCurrent: async () => undefined,
      snapshot: async () => ({
        job: {
          title: "Synthetic test role",
          description: "Synthetic description",
          location: null,
          firstName: null,
          lastName: null,
          email: null,
        },
        applications: apps,
      }),
      candidate: async (_job: string, _app: string, candidateId: string) => ({
        title: null,
        description: null,
        location: null,
        firstName: "Synthetic",
        lastName: candidateId,
        email: `${token}.${candidateId}@example.test`,
      }),
    }),
  });
  const service = zohoInterviewCampaigns({ source, actorLookup, dispatchLane: "isolated_test" });
  // Uses the same tenant and fake providers, but the production-default lane.
  // It must neither claim nor recover this test's isolated recipients.
  const liveWorker = zohoCampaignDispatcher({
    source,
    actorLookup,
    tenantId,
    send: async () => {
      throw new Error("Live dispatcher touched an isolated fixture");
    },
  });
  const worker = zohoCampaignDispatcher({
    source,
    actorLookup,
    tenantId,
    dispatchLane: "isolated_test",
    context: async () => ({
      companyName: "Synthetic employer",
      aiMessagingEnabled: true,
      brandBrief: "",
      roleContextBrief: "",
      docsBrief: "",
      contextSummary: "Synthetic fixture",
      sourceContext: {
        brandProfile: false,
        tenantDocs: 0,
        workorderContext: false,
        workorderDocs: 0,
      },
    }),
    send: async (input) => {
      sent.push(input);
      if (mode === "uncertain") return { ok: false };
      if (mode === "simulated") return { ok: true, simulated: true };
      return { ok: true, messageId: `synthetic-${sent.length}` };
    },
  });
  const draft = () =>
    service.create(actor, { revision, jobId, planId, requestId: randomUUID(), confirm: true });
  try {
    const [dbIdentity] = (
      await dbAdmin.execute(sql`SELECT current_database() AS name, inet_server_addr() AS host`)
    ).rows;
    assert.equal(dbIdentity?.name, "heliumdb");
    assert.equal(
      dbIdentity?.host,
      null,
      "fixtures run only on verified local development database",
    );
    await dbAdmin
      .insert(tenantsTable)
      .values({ id: tenantId, name: "Synthetic campaign", slug: tenantId });
    await dbAdmin.insert(usersTable).values({
      id: actor.id,
      tenantId,
      name: "Synthetic campaign reviewer",
      email: `${token}.reviewer@example.test`,
      passwordHash: "not-a-login-credential",
      role: "tenant_admin",
      status: "active",
    });
    await dbAdmin.insert(jobsTable).values({
      id: jobId,
      tenantId,
      title: "Synthetic test role",
      description: "Synthetic description",
      status: "active",
    });
    await dbAdmin.insert(plans).values({
      id: planId,
      tenantId,
      jobId,
      title: "Existing test plan",
      questions: [{ id: "q1", text: "Describe a synthetic task.", order: 1 }],
      language: "en-US",
    });
    await dbAdmin.insert(importedJobs).values({
      id: randomUUID(),
      tenantId,
      accountRef: `account_${token}`,
      externalJobId: "999",
      jobId,
      importedBy: actor.id,
    });
    await assert.rejects(
      dbAdmin.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE lexy_app`);
        await tx.select().from(campaigns).where(eq(campaigns.tenantId, tenantId));
      }),
      (error: unknown) => (error as { cause?: { code?: string } }).cause?.code === "42501",
    );
    const input = { revision, jobId, planId, requestId: randomUUID(), confirm: true as const };
    const a = await service.create(actor, input);
    await assert.rejects(
      zohoInterviewCampaigns({ source, actorLookup }).create(actor, input),
      /different campaign selection/,
      "a live request must not reuse an isolated campaign's idempotency key",
    );
    await assert.rejects(
      dbAdmin.transaction(async (tx) => {
        await tx.execute(sql`INSERT INTO candidate_erasure_tombstones(subject_id)
        VALUES('ats-profile:' || md5(jsonb_build_array(${tenantId}::text,'zoho_recruit'::text,
          ${`account_${token}`}::text,'299'::text)::text))`);
        await tx.insert(recipients).values({
          id: randomUUID(),
          tenantId,
          campaignId: a.campaign.id,
          accountRef: `account_${token}`,
          externalJobId: "999",
          externalCandidateId: "299",
          externalApplicationId: "199",
        });
      }),
    );
    assert.equal(a.campaign.applicationCount, 3);
    assert.equal(a.recipients.length, 2);
    assert.equal((await service.create(actor, input)).campaign.id, a.campaign.id);
    assert.equal(await worker.tick(), false);
    assert.equal(sent.length, 0);
    await assert.rejects(service.detail({ ...actor, tenantId: "foreign" }, a.campaign.id));
    await assert.rejects(
      service.act(actor, a.campaign.id, {
        action: "approve",
        snapshotHash: "a".repeat(64),
        confirm: true,
      }),
    );
    const approved = await service.act(actor, a.campaign.id, {
      action: "approve",
      snapshotHash: a.campaign.snapshotHash,
      confirm: true,
    });
    assert.ok(approved.recipients.every((r) => r.state === "queued"));
    assert.equal(await liveWorker.tick(), false);
    assert.ok(
      (await service.detail(actor, a.campaign.id)).recipients.every((r) => r.state === "queued"),
    );
    await Promise.all([worker.tick(), worker.tick()]);
    const completed = await service.detail(actor, a.campaign.id);
    assert.ok(
      completed.recipients.every((r) => r.state === "sent"),
      JSON.stringify(completed.recipients.map((r) => ({ state: r.state, reason: r.reason }))),
    );
    assert.equal(sent.length, 2);
    assert.ok(completed.recipients.every((r) => r.deliveryEvidence.acceptance === "recorded"));
    assert.ok(completed.recipients.every((r) => r.deliveryEvidence.delivery === "unverified"));
    // Continue the SAME dispatched recipient through persisted interview evidence,
    // real human-review services and local handoff. Completion is a fixture, not
    // proof of microphone capture, grading, email delivery or provider acceptance.
    const recipient = completed.recipients[0];
    assert.ok(recipient.sessionId);
    const reviewService = zohoCampaignReviews({ actorLookup });
    const handoffService = zohoStageHandoff({ actorLookup });
    const pending = await reviewService.detail(actor, a.campaign.id, recipient.id);
    assert.equal(pending.sessionId, recipient.sessionId);
    assert.equal(pending.reviewable, false);
    await assert.rejects(
      reviewService.record(actor, a.campaign.id, recipient.id, {
        decision: "advance",
        reason: "Cannot decide before the interview has usable completed evidence.",
        expectedRevision: pending.revision,
        requestId: randomUUID(),
        confirm: true,
      }),
    );
    await dbAdmin
      .update(sessions)
      .set({
        status: "completed",
        completedAt: new Date(),
        score: 0,
        answers: [
          {
            questionId: "q1",
            questionText: "Describe a synthetic task.",
            answer: "Synthetic role-specific evidence for the joined journey.",
            score: 0,
          },
        ],
      })
      .where(and(eq(sessions.id, recipient.sessionId), eq(sessions.tenantId, tenantId)));
    const queue = await reviewService.queue(actor, a.campaign.id);
    const queueRow = queue.rows.find((r) => r.recipientId === recipient.id);
    assert.equal(queueRow?.reviewable, true);
    assert.equal(queueRow?.score, 0);
    await assert.rejects(
      reviewService.detail({ ...actor, tenantId: "foreign" }, a.campaign.id, recipient.id),
    );
    const initialHandoff = await handoffService.detail(actor, a.campaign.id, recipient.id);
    await handoffService.saveMapping(actor, a.campaign.id, {
      expectedRevision: initialHandoff.mapping.revision,
      advance: "Qualified",
      hold: "On-Hold",
      decline: "Rejected",
      confirm: true,
    });
    for (const decision of ["advance", "hold", "decline"] as const) {
      const evidence = await reviewService.detail(actor, a.campaign.id, recipient.id);
      const input = {
        decision,
        reason: `Synthetic employer decision: ${decision}, based only on job-specific evidence.`,
        expectedRevision: evidence.revision,
        requestId: randomUUID(),
        confirm: true as const,
      };
      const reviewed = await reviewService.record(actor, a.campaign.id, recipient.id, input);
      assert.equal(reviewed.history[0]?.decision, decision);
      assert.equal(
        (await reviewService.record(actor, a.campaign.id, recipient.id, input)).history.length,
        reviewed.history.length,
      );
      const handoff = await handoffService.detail(actor, a.campaign.id, recipient.id);
      assert.equal(handoff.decision, decision);
      assert.equal(handoff.ready, true);
      assert.equal(handoff.liveEnabled, false);
      const simulation = {
        expectedRevision: handoff.revision,
        requestId: randomUUID(),
        confirm: true as const,
        mode: "simulation" as const,
      };
      const receipt = await handoffService.simulate(actor, a.campaign.id, recipient.id, simulation);
      assert.equal(receipt.history.at(-1)?.decision, decision);
      assert.equal(
        (await handoffService.simulate(actor, a.campaign.id, recipient.id, simulation)).history
          .length,
        receipt.history.length,
      );
    }
    const reviewedQueue = await reviewService.queue(actor, a.campaign.id);
    assert.equal(
      reviewedQueue.rows.find((r) => r.recipientId === recipient.id)?.decision,
      "decline",
    );
    assert.equal(
      (await handoffService.detail(actor, a.campaign.id, recipient.id)).history.length,
      3,
    );
    assert.equal(sent.length, 2, "review decisions and simulations must not send another email");
    await dbAdmin
      .update(sessions)
      .set({ score: 1 })
      .where(and(eq(sessions.id, recipient.sessionId), eq(sessions.tenantId, tenantId)));
    const changedEvidence = await reviewService.detail(actor, a.campaign.id, recipient.id);
    assert.equal(changedEvidence.decisionStale, true);
    assert.equal(changedEvidence.history.length, 3);
    const staleHandoff = await handoffService.detail(actor, a.campaign.id, recipient.id);
    assert.equal(staleHandoff.ready, false);
    await assert.rejects(
      handoffService.simulate(actor, a.campaign.id, recipient.id, {
        expectedRevision: staleHandoff.revision,
        requestId: randomUUID(),
        confirm: true,
        mode: "simulation",
      }),
    );
    assert.deepEqual(await sendReEngagement(completed.recipients[0].sessionId!), {
      ok: false,
      error: "Campaign reminders require separate employer approval.",
    });
    assert.ok(
      sent.every(
        (email) =>
          email.singleAttempt === true &&
          email.text?.includes("/interviews/") &&
          email.audit?.action === "interview.campaign.invite",
      ),
    );
    const [saved] = await dbAdmin.select().from(campaigns).where(eq(campaigns.id, a.campaign.id));
    await assert.rejects(
      dbAdmin
        .update(plans)
        .set({ title: "must not mutate" })
        .where(eq(plans.id, saved.frozenPlanId!)),
    );
    assert.equal(await worker.tick(), false);
    const repeat = await draft();
    const repeated = await service.act(actor, repeat.campaign.id, {
      action: "approve",
      snapshotHash: repeat.campaign.snapshotHash,
      confirm: true,
    });
    assert.ok(repeated.recipients.every((r) => r.state === "skipped"));
    assert.equal(sent.length, 2);
    apps = [{ applicationId: "104", candidateId: "203" }];
    const cancelled = await draft();
    await service.act(actor, cancelled.campaign.id, {
      action: "approve",
      snapshotHash: cancelled.campaign.snapshotHash,
      confirm: true,
    });
    await service.act(actor, cancelled.campaign.id, {
      action: "cancel",
      snapshotHash: cancelled.campaign.snapshotHash,
      confirm: true,
    });
    assert.equal(await worker.tick(), false);
    apps = [{ applicationId: "105", candidateId: "204" }];
    const uncertain = await draft();
    await service.act(actor, uncertain.campaign.id, {
      action: "approve",
      snapshotHash: uncertain.campaign.snapshotHash,
      confirm: true,
    });
    mode = "uncertain";
    await worker.tick();
    const held = await service.detail(actor, uncertain.campaign.id);
    assert.equal(held.recipients[0].state, "review_required");
    assert.equal(held.recipients[0].deliveryEvidence.acceptance, "unknown");
    assert.equal(held.recipients[0].deliveryEvidence.needsReview, true);
    assert.equal(held.recipients[0].deliveryEvidence.providerMessageId, null);
    active = false;
    await assert.rejects(service.detail(actor, uncertain.campaign.id));
    active = true;
    assert.equal(await worker.tick(), false);
    assert.equal(sent.length, 3);
    apps = [{ applicationId: "106", candidateId: "205" }];
    const disabled = await draft();
    await service.act(actor, disabled.campaign.id, {
      action: "approve",
      snapshotHash: disabled.campaign.snapshotHash,
      confirm: true,
    });
    active = false;
    await worker.tick();
    active = true;
    assert.equal(
      (await service.detail(actor, disabled.campaign.id)).recipients[0].state,
      "blocked",
    );
    assert.equal(sent.length, 3);
    apps = [{ applicationId: "107", candidateId: "206" }];
    const simulate = await draft();
    await service.act(actor, simulate.campaign.id, {
      action: "approve",
      snapshotHash: simulate.campaign.snapshotHash,
      confirm: true,
    });
    mode = "simulated";
    await worker.tick();
    assert.equal(
      (await service.detail(actor, simulate.campaign.id)).recipients[0].state,
      "simulated",
    );
    apps = [{ applicationId: "108", candidateId: "207" }];
    await dbAdmin.insert(candidatesTable).values({
      id: randomUUID(),
      tenantId,
      firstName: "Existing",
      lastName: "Must not merge",
      email: `${token}.207@example.test`,
      pool: "tenant",
    });
    const conflict = await draft();
    await service.act(actor, conflict.campaign.id, {
      action: "approve",
      snapshotHash: conflict.campaign.snapshotHash,
      confirm: true,
    });
    await worker.tick();
    assert.equal(
      (await service.detail(actor, conflict.campaign.id)).recipients[0].reason,
      "identity_link_required",
    );
    const stalled = await dbAdmin
      .insert(recipients)
      .values({
        id: randomUUID(),
        campaignId: conflict.campaign.id,
        tenantId,
        accountRef: `account_${token}`,
        externalJobId: "999",
        externalApplicationId: "109",
        externalCandidateId: "208",
        state: "sending",
        updatedAt: new Date(Date.now() - 11 * 60_000),
      })
      .returning();
    assert.equal(await liveWorker.tick(), false);
    const [untouched] = await dbAdmin
      .select()
      .from(recipients)
      .where(eq(recipients.id, stalled[0].id));
    assert.equal(untouched.state, "sending", "live recovery must not change isolated attempts");
    await worker.tick();
    const [lost] = await dbAdmin.select().from(recipients).where(eq(recipients.id, stalled[0].id));
    assert.equal(lost.state, "review_required");
    const recoveryEvidence = (await service.detail(actor, conflict.campaign.id)).recipients.find(
      (r) => r.id === lost.id,
    );
    assert.equal(recoveryEvidence?.reason, "interrupted_attempt");
    assert.equal(recoveryEvidence?.deliveryEvidence.acceptance, "unknown");
    assert.equal(recoveryEvidence?.deliveryEvidence.needsReview, true);
    // A mismatched account child must not expose references through an authorized parent.
    await dbAdmin
      .update(recipients)
      .set({ accountRef: `foreign_${token}` })
      .where(eq(recipients.id, lost.id));
    assert.equal(
      (await service.detail(actor, conflict.campaign.id)).recipients.some((r) => r.id === lost.id),
      false,
    );
    assert.equal((await service.detail(actor, conflict.campaign.id)).campaign.recipientCount, 1);
    // Bounded local contention/recovery exercise. Actual provider/source calls
    // remain injected, and every claim stays inside this isolated test lane.
    active = true;
    mode = "sent";
    await dbAdmin.update(jobsTable).set({ status: "active" }).where(eq(jobsTable.id, jobId));
    apps = Array.from({ length: 16 }, (_, i) => ({
      applicationId: String(1000 + i),
      candidateId: String(2000 + i),
    }));
    const started = performance.now();
    const load = await draft();
    await service.act(actor, load.campaign.id, {
      action: "approve",
      snapshotHash: load.campaign.snapshotHash,
      confirm: true,
    });
    const sentBefore = sent.length;
    let claimed = 0;
    for (let wave = 0; wave < 3; wave++) {
      const results = await Promise.all(Array.from({ length: 8 }, () => worker.tick()));
      claimed += results.filter(Boolean).length;
    }
    const finished = await service.detail(actor, load.campaign.id);
    assert.equal(claimed, 16);
    assert.equal(
      sent.length - sentBefore,
      16,
      "Concurrent workers do not duplicate delivery attempts",
    );
    assert(finished.recipients.every((r) => r.state === "sent"));
    assert.equal(new Set(finished.recipients.map((r) => r.sessionId)).size, 16);
    const replayStarted = performance.now();
    assert((await Promise.all(Array.from({ length: 8 }, () => worker.tick()))).every((r) => !r));
    assert.equal(sent.length - sentBefore, 16, "Empty-queue retries do not resend");
    assert.equal(
      (await dbAdmin.select().from(recipients).where(eq(recipients.id, lost.id)))[0].state,
      "review_required",
      "Contention never reclaims an interrupted/uncertain delivery",
    );
    console.log(
      JSON.stringify({
        kind: "isolated_campaign_contention",
        recipients: 16,
        workers: 8,
        waves: 3,
        elapsedMs: Math.round(performance.now() - started),
        emptyReplayMs: Math.round(performance.now() - replayStarted),
        sends: 16,
        interruptedAttemptRetained: true,
        productionCapacityClaim: false,
      }),
    );
  } finally {
    await dbAdmin.delete(campaigns).where(eq(campaigns.tenantId, tenantId));
    await dbAdmin.delete(sessions).where(eq(sessions.tenantId, tenantId));
    await dbAdmin.delete(profiles).where(eq(profiles.tenantId, tenantId));
    await dbAdmin.delete(candidatesTable).where(eq(candidatesTable.tenantId, tenantId));
    await dbAdmin.delete(plans).where(eq(plans.tenantId, tenantId));
    await dbAdmin.delete(importedJobs).where(eq(importedJobs.tenantId, tenantId));
    await dbAdmin.delete(usersTable).where(eq(usersTable.id, actor.id));
    await dbAdmin.delete(jobsTable).where(eq(jobsTable.tenantId, tenantId));
    await dbAdmin.delete(tenantsTable).where(eq(tenantsTable.id, tenantId));
  }
});
