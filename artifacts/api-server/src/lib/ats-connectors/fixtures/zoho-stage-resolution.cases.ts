import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { sql } from "drizzle-orm";
import type { zohoStageDispatch } from "../zoho-stage-dispatch";
import type { zohoStageRequestStore } from "../zoho-stage-request-store";
import type { StageWriteActor, StageWriteScope } from "../zoho-stage-write-core";
import type { CampaignTx } from "../zoho-interview-campaigns";

type Workspace = Awaited<ReturnType<ReturnType<typeof zohoStageDispatch>["view"]>>;
type Harness = {
  f: {
    a: StageWriteActor;
    b: StageWriteActor;
    c: StageWriteActor;
    scope: StageWriteScope;
    at: number;
    permission: { writeConsentSaved: boolean; connectionRevision: string };
    h: { revision: string };
  };
  service: ReturnType<typeof zohoStageDispatch>;
  ledger: ReturnType<typeof zohoStageRequestStore>;
  ready(): Promise<void>;
  approve(): Promise<Workspace>;
  command(
    w: Workspace,
    action?: "approve" | "execute" | "withdraw" | "recover",
  ): {
    expectedRevision: string;
    expectedRuleRevision: string | null;
    requestId: string;
    confirm: true;
    action: "approve" | "execute" | "withdraw" | "recover";
  };
  enable(): void;
  disable(): void;
  lost(): void;
  foreign(): void;
  remote(status: string): void;
  counts(): { writes: number; reads: number; connections: number };
};
export async function registerStageResolutionCases(
  t: TestContext,
  create: () => Promise<Harness>,
  tx: CampaignTx,
) {
  const input = (w: Workspace, action: "propose" | "approve" | "reject" = "propose") => ({
    expectedRevision: w.requests[0].revision,
    expectedSequence: w.requests[0].sequence,
    expectedSourceRevision: w.handoffRevision,
    commandId: randomUUID(),
    action,
    reason: "Reviewed the synthetic provider evidence independently.",
    evidenceReference: `synthetic-${action}-report-2026`,
    confirm: true as const,
    acknowledgeUnknown: true as const,
    acknowledgeNoRetry: true as const,
  });
  const resolve = (h: Harness, actor: StageWriteActor, w: Workspace, command = input(w)) =>
    h.service.resolve(actor, h.f.scope, w.requests[0].id, command);
  async function uncertain() {
    const h = await create();
    await h.ready();
    let w = await h.approve();
    h.enable();
    h.lost();
    await h.service.act(h.f.c, h.f.scope, w.requests[0].id, h.command(w));
    h.disable();
    w = await h.service.view(h.f.a, h.f.scope);
    w = await h.service.act(h.f.a, h.f.scope, w.requests[0].id, h.command(w, "recover"));
    assert.equal(w.requests[0].state, "observed_target");
    assert.equal(w.requests[0].canProposeResolution, true);
    return { h, w };
  }
  await t.test(
    "independent closure retains unknown attribution and never authorizes replay",
    async () => {
      const { h, w } = await uncertain();
      const proposed = await resolve(h, h.f.a, w);
      assert.equal(proposed.canPrepare, false);
      assert.equal(proposed.requests[0].resolution?.review, null);
      assert.equal(proposed.requests[0].canReviewResolution, false);
      const review = await h.service.view(h.f.b, h.f.scope);
      assert.equal(review.requests[0].canReviewResolution, true);
      const closed = await resolve(h, h.f.b, review, input(review, "approve"));
      const row = closed.requests[0];
      assert.equal(row.state, "observed_target", "closure is not a verified delivery receipt");
      assert.equal(row.resolution?.review?.action, "approve");
      assert.equal(row.canRecover, false);
      assert.equal(row.canProposeResolution, false);
      assert.equal(row.canExecute, false);
      assert.equal(closed.canPrepare, false, "old evidence cannot prepare a replacement");
      const saved = (await h.ledger.list(h.f.c, h.f.scope, tx))[0];
      await h.service.act(h.f.c, h.f.scope, row.id, {
        ...h.command(closed),
        requestId: saved.executionRequestId!,
      });
      assert.equal(h.counts().writes, 1);
      await assert.rejects(resolve(h, h.f.a, closed));
      const audit = await tx.execute(sql`SELECT metadata FROM audit_logs
      WHERE subject_id=${h.f.scope.recipientId} AND action='zoho.stage_request'`);
      assert(audit.rows.some((r) => (r.metadata as { state: string }).state === "claimed"));
      assert(
        audit.rows.some(
          (r) => (r.metadata as { resolution?: { review: unknown } }).resolution?.review,
        ),
      );
    },
  );
  await t.test(
    "closure cannot self-approve, skip acknowledgement, reuse evidence or use a stale sequence",
    async () => {
      const { h, w } = await uncertain();
      await assert.rejects(
        resolve(h, h.f.a, w, { ...input(w), acknowledgeUnknown: false as true }),
      );
      const proposed = await resolve(h, h.f.a, w);
      await assert.rejects(resolve(h, h.f.a, proposed, input(proposed, "approve")));
      const review = await h.service.view(h.f.b, h.f.scope);
      await assert.rejects(
        resolve(h, h.f.b, review, {
          ...input(review, "approve"),
          evidenceReference: input(w).evidenceReference,
        }),
      );
      await assert.rejects(
        resolve(h, h.f.b, review, {
          ...input(review, "approve"),
          expectedSequence: w.requests[0].sequence,
        }),
      );
      assert.equal((await h.service.view(h.f.b, h.f.scope)).canPrepare, false);
      assert.equal(h.counts().writes, 1);
    },
  );
  await t.test(
    "independent rejection preserves the hold and permits a new explicit proposal",
    async () => {
      const { h, w } = await uncertain();
      await resolve(h, h.f.a, w);
      const review = await h.service.view(h.f.b, h.f.scope);
      const rejected = await resolve(h, h.f.b, review, input(review, "reject"));
      assert.equal(rejected.requests[0].resolution?.review?.action, "reject");
      assert.equal(rejected.canPrepare, false);
      const next = await resolve(h, h.f.a, rejected);
      assert.equal(next.requests[0].resolution?.review, null);
      assert.equal(next.canPrepare, false);
      assert.equal(h.counts().writes, 1);
    },
  );
  await t.test(
    "proposal and review use read-only custody even with expired evidence and no write consent",
    async () => {
      const { h, w } = await uncertain();
      h.f.at += 1_000_000;
      h.f.permission.writeConsentSaved = false;
      const current = await h.service.view(h.f.a, h.f.scope);
      assert.equal(current.transitionVerified, false);
      await resolve(h, h.f.a, current);
      const review = await h.service.view(h.f.b, h.f.scope);
      await resolve(h, h.f.b, review, input(review, "approve"));
      assert.equal(h.counts().writes, 1);
      assert(w.requests[0].executionRequestId);
    },
  );
  await t.test(
    "revoked proposer, changed source, expired proposal or foreign application cannot close a hold",
    async () => {
      for (const kind of ["revoked", "source", "expired", "foreign", "status"]) {
        const { h, w } = await uncertain();
        const proposer = kind === "revoked" ? h.f.c : h.f.a;
        await resolve(h, proposer, w);
        if (kind === "revoked")
          await tx.execute(sql`UPDATE users SET status='suspended' WHERE id=${proposer.id}`);
        if (kind === "source") h.f.h.revision = "c".repeat(64);
        if (kind === "expired") h.f.at += 16 * 60_000;
        if (kind === "foreign") h.foreign();
        if (kind === "status") h.remote("Associated");
        const review = await h.service.view(h.f.b, h.f.scope);
        await assert.rejects(resolve(h, h.f.b, review, input(review, "approve")));
        const row = (await h.ledger.list(h.f.b, h.f.scope, tx))[0];
        assert.equal(row.resolution?.review, null);
        assert.equal(h.counts().writes, 1);
      }
    },
  );
  await t.test(
    "ambiguous resolution command is idempotent but conflicting reuse is rejected",
    async () => {
      const { h, w } = await uncertain();
      const command = input(w);
      const first = await resolve(h, h.f.a, w, command);
      const second = await resolve(h, h.f.a, w, command);
      assert.equal(first.requests[0].sequence, second.requests[0].sequence);
      await assert.rejects(
        resolve(h, h.f.a, w, {
          ...command,
          reason: "This is conflicting command content which must be rejected.",
        }),
      );
      const review = await h.service.view(h.f.b, h.f.scope);
      const approval = input(review, "approve");
      const closed = await resolve(h, h.f.b, review, approval);
      const replay = await resolve(h, h.f.b, review, approval);
      assert.equal(closed.requests[0].sequence, replay.requests[0].sequence);
      assert.equal(h.counts().writes, 1);
    },
  );
  await t.test("late receipts cannot reopen an independently closed attempt", async () => {
    const { h, w } = await uncertain();
    const before = (await h.ledger.list(h.f.c, h.f.scope, tx))[0];
    // Rehydrate the original binding from the real connected fixture.
    const writer = h.ledger.asWriterStore(
      {
        applicationId: "993001",
        candidateId: "992001",
        jobId: "991001",
      },
      h.f.c,
    );
    const late = await writer.get(h.f.c, h.f.scope, before.requestId);
    assert(late);
    await resolve(h, h.f.a, w);
    const review = await h.service.view(h.f.b, h.f.scope);
    await resolve(h, h.f.b, review, input(review, "approve"));
    const result = await writer.record(late, "verified");
    assert.equal(result.closed, true);
    assert.equal(result.state, "observed_target");
    assert.equal((await h.service.view(h.f.b, h.f.scope)).requests[0].canExecute, false);
  });
  await t.test("closure requires newly reviewed proof before any later request", async () => {
    const { h, w } = await uncertain();
    const writer = h.ledger.asWriterStore(
      {
        applicationId: "993001",
        candidateId: "992001",
        jobId: "991001",
      },
      h.f.c,
    );
    const attempt = await writer.get(h.f.c, h.f.scope, w.requests[0].id);
    assert(attempt?.snapshot.proof);
    const later = structuredClone(attempt.snapshot);
    later.sourceRevision = "d".repeat(64);
    later.proof!.evidenceReference = "synthetic-different-reviewed-proof";
    await assert.rejects(h.ledger.prepare(later, randomUUID(), tx));
    await resolve(h, h.f.a, w);
    const review = await h.service.view(h.f.b, h.f.scope);
    await resolve(h, h.f.b, review, input(review, "approve"));
    await assert.rejects(
      h.ledger.prepare(later, randomUUID(), tx),
      "a different proof reviewed before closure is still insufficient",
    );
    later.proof!.verifiedAt = h.f.at + 1;
    const prepared = await h.ledger.prepare(later, randomUUID(), tx);
    assert.equal(prepared.state, "prepared");
    assert.equal(prepared.approvedBy, null);
    assert.equal(h.counts().writes, 1);
  });
  await t.test(
    "an old proposal command cannot be reused with new content after replacement",
    async () => {
      const { h, w } = await uncertain();
      const original = input(w);
      const first = await resolve(h, h.f.a, w, original);
      const next = await resolve(h, h.f.a, first);
      await assert.rejects(
        resolve(h, h.f.a, next, {
          ...input(next),
          commandId: original.commandId,
          reason: "A different intent must never borrow an old proposal command identifier.",
        }),
      );
      assert.equal(h.counts().writes, 1);
    },
  );
}
