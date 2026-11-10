import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  dbAdmin,
  candidatesTable as people,
  atsImportedApplicationsTable as imports,
  atsCandidateProfilesTable as profiles,
  recruitingWorkflowEventsTable as events,
} from "@workspace/db";
import type { AtsCampaignIndex, AtsCampaignDetail } from "@workspace/api-zod";
import { purgeCandidateLinkedData } from "../lib/candidate-erasure";

type Actor = "admin" | "candidate" | "foreign" | "platform" | null;
type Request = (
  method: string,
  path: string,
  body?: unknown,
  actor?: Actor,
) => Promise<{ status: number; body: unknown }>;
export async function checkAtsCampaignHttp(p: {
  request: Request;
  tenant: string;
  jobId: string;
  workflowId: string;
  path: string;
  person: typeof people.$inferSelect;
  source: typeof imports.$inferSelect;
  profile: typeof profiles.$inferSelect;
  planId: string;
  providerPeople: Map<number, { applicationId: number; email: string }>;
  sendCount: () => number;
  readCount: () => number;
  readMode: (mode: "success" | "failure") => void;
  deliveryMode: (mode: "success" | "uncertain") => void;
  onRead: (work: (() => Promise<void>) | undefined) => void;
}) {
  const { request } = p;
  const personIds: string[] = [];
  const recordIds: string[] = [];
  const campaigns: string[] = [];
  const initialSends = p.sendCount();
  try {
    for (const [candidateId, applicationId] of [
      [606, 360],
      [607, 361],
    ]) {
      const personId = randomUUID(),
        recordId = randomUUID();
      const email = `${personId}@example.invalid`;
      personIds.push(personId);
      recordIds.push(recordId);
      p.providerPeople.set(candidateId, { applicationId, email });
      await dbAdmin
        .insert(people)
        .values({ ...p.person, id: personId, email, firstName: "Batch fixture" });
      await dbAdmin.insert(imports).values({
        ...p.source,
        id: recordId,
        externalApplicationId: String(applicationId),
        currentSnapshot: null,
        snapshot: {
          ...p.source.snapshot,
          application: {
            ...p.source.snapshot.application,
            id: String(applicationId),
            candidateId: String(candidateId),
          },
        },
      });
      await dbAdmin.insert(profiles).values({
        ...p.profile,
        id: randomUUID(),
        externalCandidateId: String(candidateId),
        candidateId: personId,
        idempotencyKey: randomUUID(),
      });
    }
    const reads = p.readCount();
    const indexResponse = await request("GET", p.path);
    assert.equal(indexResponse.status, 200, JSON.stringify(indexResponse.body));
    const index = indexResponse.body as AtsCampaignIndex;
    const plan = index.plans.find((x) => x.id === p.planId)!;
    assert.ok(plan);
    assert.equal(p.readCount(), reads, "campaign index is local");
    const input = {
      recordIds,
      planId: p.planId,
      planHash: plan.approvalHash,
      sourceHash: index.sourceHash,
      idempotencyKey: randomUUID(),
      acknowledge: true,
    };
    for (const [actor, status] of [
      [null, 401],
      ["candidate", 403],
      ["foreign", 404],
      ["platform", 403],
    ] as const) {
      assert.equal((await request("GET", p.path, undefined, actor)).status, status);
      assert.equal((await request("POST", p.path, input, actor)).status, status);
    }
    for (const body of [
      { ...input, acknowledge: false },
      { ...input, recordIds: [] },
      { ...input, recordIds: [recordIds[0], recordIds[0]] },
      { ...input, email: "forged@example.invalid" },
    ])
      assert.equal((await request("POST", p.path, body)).status, 400);
    assert.equal(
      (await request("POST", p.path, { ...input, planHash: "0".repeat(64) })).status,
      409,
    );
    assert.equal(p.sendCount(), initialSends);
    const prepared = await Promise.all([
      request("POST", p.path, input),
      request("POST", p.path, input),
    ]);
    assert.ok(
      prepared.every((r) => r.status === 200),
      JSON.stringify(prepared),
    );
    let batch = prepared[0].body as AtsCampaignDetail;
    campaigns.push(batch.id);
    assert.equal((prepared[1].body as AtsCampaignDetail).id, batch.id, "preparation is idempotent");
    assert.equal(batch.members.length, 2);
    assert.equal(batch.status, "review");
    assert.ok(batch.canApprove);
    assert.ok(
      batch.members.every(
        (m) => m.recipient?.endsWith("@example.invalid") && m.text?.includes("/room"),
      ),
    );
    assert.equal(p.sendCount(), initialSends, "private preview does not send");
    assert.equal(
      (await request("POST", p.path, { ...input, recordIds: [recordIds[0]] })).status,
      409,
    );
    const get = async (id = batch.id) => {
      const res = await request("GET", `${p.path}/${id}`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      return res.body as AtsCampaignDetail;
    };
    const control = (value: AtsCampaignDetail, action: "approve" | "cancel", extra = {}) =>
      request("POST", `${p.path}/${value.id}/control`, {
        action,
        reviewHash: value.reviewHash,
        acknowledge: true,
        ...extra,
      });
    const dispatch = (value: AtsCampaignDetail, memberId = value.members[0].id, extra = {}) =>
      request("POST", `${p.path}/${value.id}/members/${memberId}/dispatch`, {
        reviewHash: value.reviewHash,
        acknowledge: true,
        ...extra,
      });
    assert.equal((await dispatch(batch)).status, 409, "preview cannot authorize contact");
    assert.equal((await control(batch, "approve", { acknowledge: false })).status, 400);
    assert.equal((await control(batch, "approve", { reviewHash: "0".repeat(64) })).status, 409);
    const [target] = personIds;
    await dbAdmin.update(people).set({ doNotContact: true }).where(eq(people.id, target));
    const quiet = await get();
    assert.equal(quiet.status, "needs_review");
    assert.ok(
      !JSON.stringify(quiet).includes(`${target}@example.invalid`),
      "private unavailable member is not serialized",
    );
    assert.equal((await control(batch, "approve")).status, 409);
    await dbAdmin.update(people).set({ doNotContact: false }).where(eq(people.id, target));
    const stopped = await control(await get(), "cancel");
    assert.equal(stopped.status, 200);
    assert.equal((stopped.body as AtsCampaignDetail).status, "cancelled");
    assert.equal((await dispatch(batch)).status, 409);
    // Cancellation in provider verification must fence the durable send claim.
    const second = await request("POST", p.path, { ...input, idempotencyKey: randomUUID() });
    assert.equal(second.status, 200, JSON.stringify(second.body));
    batch = second.body as AtsCampaignDetail;
    campaigns.push(batch.id);
    const approved = await control(batch, "approve");
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    batch = approved.body as AtsCampaignDetail;
    p.onRead(async () => {
      assert.equal((await control(batch, "cancel")).status, 200);
    });
    const interrupted = await dispatch(batch);
    assert.equal(interrupted.status, 200, JSON.stringify(interrupted.body));
    assert.equal((interrupted.body as AtsCampaignDetail).status, "cancelled");
    assert.equal(
      p.sendCount(),
      initialSends,
      "cancelled batch cannot send after waiting on provider reads",
    );
    const third = await request("POST", p.path, { ...input, idempotencyKey: randomUUID() });
    assert.equal(third.status, 200, JSON.stringify(third.body));
    batch = third.body as AtsCampaignDetail;
    campaigns.push(batch.id);
    const approvals = await Promise.all([control(batch, "approve"), control(batch, "approve")]);
    assert.ok(approvals.every((r) => r.status === 200));
    batch = approvals[0].body as AtsCampaignDetail;
    assert.equal(p.sendCount(), initialSends, "batch approval does not send");
    assert.equal((await dispatch(batch, batch.members[0].id, { acknowledge: false })).status, 400);
    const pair = await Promise.all([dispatch(batch), dispatch(batch)]);
    assert.ok(
      pair.every((r) => r.status === 200),
      JSON.stringify(pair),
    );
    assert.equal(
      p.sendCount(),
      initialSends + 1,
      "concurrent campaign requests use one original session send",
    );
    batch = await get();
    const accepted = batch.members.find((m) => m.invitationStatus === "provider_accepted")!;
    assert.ok(accepted);
    assert.equal((await dispatch(batch, accepted.id)).status, 200);
    assert.equal(p.sendCount(), initialSends + 1, "reopen/replay never resends");
    const pending = batch.members.find((m) => m.invitationStatus === "ready")!;
    p.readMode("failure");
    const blocked = await dispatch(batch, pending.id);
    assert.equal(blocked.status, 200, JSON.stringify(blocked.body));
    assert.equal(
      (blocked.body as AtsCampaignDetail).members.find((m) => m.id === pending.id)
        ?.invitationStatus,
      "blocked",
    );
    assert.ok(!JSON.stringify(blocked.body).includes("PRIVATE"));
    p.readMode("success");
    batch = await get();
    assert.equal(
      batch.members.find((m) => m.id === pending.id)?.invitationStatus,
      "blocked",
      "blocked state survives reload",
    );
    p.deliveryMode("uncertain");
    const held = await dispatch(batch, pending.id);
    assert.equal(held.status, 200, JSON.stringify(held.body));
    assert.equal(
      (held.body as AtsCampaignDetail).members.find((m) => m.id === pending.id)?.invitationStatus,
      "review_required",
    );
    assert.equal(p.sendCount(), initialSends + 2);
    assert.equal((await dispatch(held.body as AtsCampaignDetail, pending.id)).status, 200);
    assert.equal(p.sendCount(), initialSends + 2, "held mail is not retried by campaign");
    p.deliveryMode("success");
    await dbAdmin.transaction(async (tx) => purgeCandidateLinkedData(tx, personIds[0]));
    const erased = await get();
    assert.equal(erased.status, "needs_review");
    assert.ok(!JSON.stringify(erased).includes(`${personIds[0]}@example.invalid`));
    assert.equal(
      (await dispatch(erased, pending.id)).status,
      409,
      "erasure invalidates further batch dispatch",
    );
    const audit = await dbAdmin.select().from(events).where(eq(events.workflowId, p.workflowId));
    assert.ok(
      !audit.some(
        (e) =>
          e.action.startsWith("ats.interview.campaign.member") && e.note?.includes(personIds[0]),
      ),
    );
    assert.equal(p.sendCount(), initialSends + 2);
  } finally {
    p.readMode("success");
    p.deliveryMode("success");
    p.onRead(undefined);
    p.providerPeople.clear();
    for (const id of personIds) {
      await dbAdmin.transaction(async (tx) => purgeCandidateLinkedData(tx, id));
      await dbAdmin.delete(people).where(eq(people.id, id));
    }
    const remaining = await dbAdmin
      .select()
      .from(events)
      .where(eq(events.workflowId, p.workflowId));
    assert.ok(
      !remaining.some(
        (e) =>
          e.action.startsWith("ats.interview.campaign.member") &&
          recordIds.some((id) => e.note?.includes(id)),
      ),
      "erasure removes indirect member snapshots",
    );
  }
}
