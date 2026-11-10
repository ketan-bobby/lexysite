import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { dbAdmin } from "@workspace/db";
import { zohoStageRequestStore } from "./zoho-stage-request-store";
import { stageWriteRevision, type StageWriteSnapshot } from "./zoho-stage-write-core";

function snapshot(): StageWriteSnapshot {
  const binding = { applicationId: "993001", candidateId: "992001", jobId: "991001" };
  return {
    actor: { id: randomUUID(), tenantId: randomUUID() },
    scope: { campaignId: randomUUID(), recipientId: randomUUID() },
    binding,
    accountRef: "a".repeat(64),
    connectionRevision: randomUUID(),
    sourceRevision: "b".repeat(64),
    currentStatus: "Associated",
    targetStatus: "In Review",
    targetStage: "Screening",
    decision: "advance",
    currentHumanDecision: true,
    writePermissionConfirmed: true,
    proof: {
      ...binding,
      contract: "recruit-candidate-job-status-v2",
      evidenceReference: "synthetic-only",
      accountRef: "a".repeat(64),
      connectionRevision: "",
      fromStatus: "Associated",
      toStatus: "In Review",
      verifiedBy: "synthetic-reviewer",
      verifiedAt: 1000,
      expiresAt: 2000,
      employerWriteApproved: true,
      applicationTransitionVerified: true,
      sideEffectsReviewed: true,
    },
  };
}
test("SQL stage ledger: private rollback-only fixture, reload, dedup, claims, CAS and tenant isolation", async () => {
  const rollback = new Error("rollback-private-stage-ledger-fixture");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      const [identity] = (
        await tx.execute(sql`SELECT current_database() AS name,inet_server_addr() AS host`)
      ).rows;
      assert.equal(identity.name, "heliumdb");
      assert.equal(
        identity.host,
        null,
        "fixture DDL requires verified local development PostgreSQL",
      );
      await tx.execute(
        sql`CREATE TEMP TABLE audit_logs (LIKE public.audit_logs INCLUDING ALL) ON COMMIT DROP`,
      );
      await tx.execute(sql`SET LOCAL search_path = pg_temp,pg_catalog`);
      // Nested repository transactions become savepoints on this ORM transaction.
      // This proves real SQL storage/reconstruction, not a process crash or a commit.
      const handle = tx as unknown as typeof dbAdmin;
      const a = zohoStageRequestStore(handle);
      const b = zohoStageRequestStore(handle);
      const s = snapshot();
      s.proof!.connectionRevision = s.connectionRevision;
      const id = randomUUID();
      const prepared = await a.prepare(s, id);
      assert.equal(prepared.state, "prepared");
      assert.equal((await b.prepare(s, id)).requestId, prepared.requestId);
      assert.equal((await b.prepare(s, randomUUID())).requestId, prepared.requestId);
      await assert.rejects(b.prepare({ ...s, sourceRevision: "c".repeat(64) }, id));
      const revision = stageWriteRevision(s);
      await assert.rejects(b.act(s.actor, s.scope, prepared.requestId, "d".repeat(64), "approved"));
      const writer = b.asWriterStore(s.binding);
      const approval = {
        expectedRevision: revision,
        requestId: randomUUID(),
        confirm: true as const,
      };
      await assert.rejects(writer.claim(s, approval), "unapproved requests cannot be claimed");
      const approved = await a.act(s.actor, s.scope, prepared.requestId, revision, "approved");
      assert.equal(approved.approvedBy, s.actor.id);
      assert.equal(
        (await b.act(s.actor, s.scope, prepared.requestId, revision, "approved")).state,
        "approved",
      );
      const claim = await writer.claim(s, approval);
      assert.equal(claim.acquired, true);
      assert.deepEqual(claim.attempt.snapshot, s);
      const reconstructed = a.asWriterStore(s.binding);
      assert.equal((await reconstructed.claim(s, approval)).acquired, false);
      assert.equal(
        (await reconstructed.claim(s, { ...approval, requestId: randomUUID() })).acquired,
        false,
      );
      await assert.rejects(a.act(s.actor, s.scope, prepared.requestId, revision, "withdrawn"));
      await assert.rejects(a.prepare({ ...s, sourceRevision: "e".repeat(64) }, randomUUID()));
      const held = await reconstructed.record(claim.attempt, "review_required");
      const observed = await reconstructed.record(held, "observed_target");
      assert.equal(observed.state, "observed_target");
      await assert.rejects(
        reconstructed.record(observed, "verified"),
        "observation cannot become attributable delivery",
      );
      assert.equal(
        (await writer.claim(s, approval)).acquired,
        false,
        "observation never enables resend",
      );
      assert.equal(
        await writer.get({ ...s.actor, tenantId: randomUUID() }, s.scope, prepared.requestId),
        null,
      );
      assert.equal(
        await writer.get(s.actor, { ...s.scope, campaignId: randomUUID() }, prepared.requestId),
        null,
      );
      await assert.rejects(
        a
          .asWriterStore({ ...s.binding, candidateId: "992999" })
          .get(s.actor, s.scope, prepared.requestId),
      );
      const metadata = (await tx.execute(sql`SELECT metadata FROM audit_logs`)).rows;
      for (const row of metadata) {
        const text = JSON.stringify(row.metadata);
        for (const key of ['"applicationId"', '"candidateId"', '"jobId"', '"binding"'])
          assert.equal(
            text.includes(key),
            false,
            "raw provider identities are not retained in general audit metadata",
          );
      }
      const other = snapshot();
      other.proof!.connectionRevision = other.connectionRevision;
      const p2 = await a.prepare(other, randomUUID());
      await a.act(other.actor, other.scope, p2.requestId, p2.revision, "approved");
      const w2 = a.asWriterStore(other.binding);
      const c2 = await w2.claim(other, {
        expectedRevision: p2.revision,
        requestId: randomUUID(),
        confirm: true,
      });
      const accepted = await w2.record(c2.attempt, "provider_accepted");
      const verified = await w2.record(accepted, "verified");
      assert.equal(
        (await w2.record(verified, "review_required")).state,
        "verified",
        "terminal receipts never regress",
      );
      const p3s = snapshot();
      p3s.proof!.connectionRevision = p3s.connectionRevision;
      const p3 = await a.prepare(p3s, randomUUID());
      const withdrew = await a.act(p3s.actor, p3s.scope, p3.requestId, p3.revision, "withdrawn");
      assert.equal(withdrew.state, "withdrawn");
      await assert.rejects(a.act(p3s.actor, p3s.scope, p3.requestId, p3.revision, "approved"));
      throw rollback;
    }),
    (error) => error === rollback,
  );
});
