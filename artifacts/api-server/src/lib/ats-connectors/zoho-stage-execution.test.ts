import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { dbAdmin } from "@workspace/db";
import { zohoStageExecution, type StageExecutionSource } from "./zoho-stage-execution";
import { zohoStageRequestStore } from "./zoho-stage-request-store";
import { zohoStageWriteHttp } from "./zoho-stage-write-http";
import {
  stageWriteRevision,
  stageWriteSnapshotSchema,
  type StageWriteSnapshot,
} from "./zoho-stage-write-core";

test("assembled stage execution uses real private SQL ledger and simulated HTTP only", async (t) => {
  const rollback = Error("rollback-stage-execution-fixture");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      const [identity] = (
        await tx.execute(sql`SELECT current_database() AS name, inet_server_addr() AS host`)
      ).rows;
      assert.equal(identity.name, "heliumdb");
      assert.equal(identity.host, null, "Only verified local development PostgreSQL is allowed");
      await tx.execute(
        sql`CREATE TEMP TABLE audit_logs (LIKE public.audit_logs INCLUDING ALL) ON COMMIT DROP`,
      );
      await tx.execute(sql`SET LOCAL search_path = pg_temp,pg_catalog`);
      const ledger = zohoStageRequestStore(tx as unknown as typeof dbAdmin);
      function fixture() {
        let clock = 1500;
        const actor = { id: randomUUID(), tenantId: randomUUID() };
        const scope = { campaignId: randomUUID(), recipientId: randomUUID() };
        const binding = { applicationId: "993001", candidateId: "992001", jobId: "991001" };
        const connectionRevision = randomUUID();
        const snapshot: StageWriteSnapshot = {
          actor,
          scope,
          binding,
          accountRef: "a".repeat(64),
          connectionRevision,
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
            evidenceReference: "synthetic-only-not-employer-verification",
            accountRef: "a".repeat(64),
            connectionRevision,
            fromStatus: "Associated",
            toStatus: "In Review",
            verifiedBy: actor.id,
            verifiedAt: 1000,
            expiresAt: 2000,
            employerWriteApproved: true,
            applicationTransitionVerified: true,
            sideEffectsReviewed: true,
          },
        };
        let writes = 0;
        let reads = 0;
        let remote = "Associated";
        let mode = "accepted";
        let lockedChange = false;
        let failRecording = false;
        let wrongLockedCaller = false;
        const delegated = new Set<string>();
        const executionActors: string[] = [];
        function currentFor(requester: StageWriteSnapshot["actor"]) {
          const resolved = structuredClone(snapshot);
          if (requester.tenantId === actor.tenantId && delegated.has(requester.id))
            resolved.actor = { ...requester };
          return resolved;
        }
        const source: StageExecutionSource = {
          current: async (requester) => currentFor(requester),
          fence: async (requester, _scope, work) => {
            const locked = wrongLockedCaller ? structuredClone(snapshot) : currentFor(requester);
            if (lockedChange) locked.sourceRevision = "c".repeat(64);
            return work(locked, tx);
          },
        };
        const http = zohoStageWriteHttp({
          region: "us",
          token: "synthetic-not-a-real-credential",
          now: () => clock,
          request: async (url, init) => {
            assert.equal(url, "https://recruit.zoho.com/recruit/v2/Candidates/status");
            assert.equal(init?.method, "PUT");
            assert.deepEqual(JSON.parse(String(init?.body)).data[0], {
              ids: [binding.candidateId],
              jobids: [binding.jobId],
              Candidate_Status: "In Review",
              comments: "Human-approved Lexy application-stage handoff.",
            });
            const rows = await ledger.list(actor, scope, tx);
            assert.equal(rows[0].state, "claimed", "SQL claim precedes simulated side effect");
            writes++;
            remote = "In Review";
            if (mode === "uncertain") throw Error("Synthetic accepted write with lost response");
            return Response.json({
              data: [
                [{ code: "SUCCESS", status: "success", details: { id: binding.candidateId } }],
              ],
            });
          },
        });
        const dependencies = {
          source,
          ledger: {
            ...ledger,
            asWriterStore: (...args: Parameters<typeof ledger.asWriterStore>) => {
              const store = ledger.asWriterStore(...args);
              return {
                ...store,
                record: async (...recordArgs: Parameters<typeof store.record>) => {
                  if (failRecording) throw Error("Synthetic receipt persistence failure");
                  return store.record(...recordArgs);
                },
              };
            },
          },
          now: () => clock,
          provider: {
            read: async () => {
              reads++;
              if (mode === "expire") clock = 2100;
              return { ...binding, currentStatus: remote };
            },
            change: async (current: StageWriteSnapshot) => {
              executionActors.push(current.actor.id);
              return http.change(current);
            },
          },
        };
        const service = zohoStageExecution(dependencies);
        const input = () => ({
          expectedRevision: stageWriteRevision(snapshot),
          requestId: randomUUID(),
          confirm: true as const,
        });
        const prepare = () => service.prepare(actor, scope, input());
        const approve = async () => {
          const row = await prepare();
          await service.approve(actor, scope, row.requestId, input());
          return row;
        };
        return {
          actor,
          scope,
          snapshot,
          service,
          input,
          prepare,
          approve,
          reconstruct: () => zohoStageExecution(dependencies),
          counters: () => ({ reads, writes }),
          rows: () => ledger.list(actor, scope, tx),
          mode: (value: string) => (mode = value),
          clock: (value: number) => (clock = value),
          lockChange: () => (lockedChange = true),
          failRecording: (value: boolean) => (failRecording = value),
          authorize: (staffId: string) => delegated.add(staffId),
          revoke: (staffId: string) => delegated.delete(staffId),
          wrongLockedCaller: () => (wrongLockedCaller = true),
          executionActors,
        };
      }
      await t.test("approval precedes execution; replay never resends", async () => {
        const h = fixture();
        const row = await h.prepare();
        assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
        await assert.rejects(h.service.execute(h.actor, h.scope, row.requestId, h.input()));
        await h.service.approve(h.actor, h.scope, row.requestId, h.input());
        assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
        const input = h.input();
        const result = await h.service.execute(h.actor, h.scope, row.requestId, input);
        assert.equal(result.attempt?.state, "verified");
        const replay = await h.reconstruct().execute(h.actor, h.scope, row.requestId, input);
        assert.equal(replay.attempt?.id, result.attempt?.id);
        assert.equal(h.counters().writes, 1);
      });
      await t.test(
        "separate preparer, approver and executor preserve content and real audit authorship",
        async () => {
          const h = fixture(),
            approver = { ...h.actor, id: randomUUID() },
            executor = { ...h.actor, id: randomUUID() };
          h.authorize(approver.id);
          h.authorize(executor.id);
          const row = await h.prepare();
          await h.service.approve(approver, h.scope, row.requestId, h.input());
          assert.deepEqual(h.counters(), { reads: 0, writes: 0 }, "approval alone cannot dispatch");
          const input = h.input();
          const result = await h.service.execute(executor, h.scope, row.requestId, input);
          assert.equal(result.attempt?.state, "verified");
          assert.equal(
            result.attempt.snapshot.actor.id,
            h.actor.id,
            "frozen preparer must not be relabelled",
          );
          assert.deepEqual(
            h.executionActors,
            [executor.id],
            "provider receives the current executing staff identity",
          );
          const [stored] = await h.rows();
          assert.equal(stored.snapshot.actor.id, h.actor.id);
          assert.equal(stored.approvedBy, approver.id);
          const events = (
            await tx.execute(sql`SELECT actor_id,metadata->>'state' AS state,
          metadata->'snapshot'->'actor'->>'id' AS preparer FROM audit_logs
          WHERE subject_id=${h.scope.recipientId} AND action='zoho.stage_request'`)
          ).rows;
          for (const event of events) {
            assert.equal(event.preparer, h.actor.id);
            assert.equal(
              event.actor_id,
              event.state === "prepared"
                ? h.actor.id
                : event.state === "approved"
                  ? approver.id
                  : executor.id,
            );
          }
          await h.reconstruct().execute(approver, h.scope, row.requestId, input);
          assert.equal(
            h.counters().writes,
            1,
            "another authorized staff member cannot resend the claimed request",
          );
        },
      );
      await t.test(
        "another authorized staff member can observe an uncertain result without impersonating its preparer",
        async () => {
          const h = fixture(),
            executor = { ...h.actor, id: randomUUID() },
            observer = { ...h.actor, id: randomUUID() };
          h.authorize(executor.id);
          h.authorize(observer.id);
          const row = await h.approve();
          h.mode("uncertain");
          const result = await h.service.execute(executor, h.scope, row.requestId, h.input());
          assert.equal(result.attempt?.state, "review_required");
          h.clock(2100);
          const observed = await h.reconstruct().recover(observer, h.scope, row.requestId);
          assert.equal(observed.state, "observed_target");
          assert.equal(observed.snapshot.actor.id, h.actor.id);
          const [event] = (
            await tx.execute(sql`SELECT actor_id FROM audit_logs WHERE subject_id=${h.scope.recipientId}
          AND metadata->>'state'='observed_target'`)
          ).rows;
          assert.equal(event.actor_id, observer.id);
          assert.equal(h.counters().writes, 1);
        },
      );
      await t.test(
        "sharing a content revision does not authorize an unknown, revoked or foreign caller",
        async () => {
          const h = fixture(),
            staff = { ...h.actor, id: randomUUID() };
          const row = await h.prepare();
          await assert.rejects(h.service.approve(staff, h.scope, row.requestId, h.input()));
          h.authorize(staff.id);
          await h.service.approve(staff, h.scope, row.requestId, h.input());
          h.revoke(staff.id);
          await assert.rejects(h.service.execute(staff, h.scope, row.requestId, h.input()));
          h.authorize(staff.id);
          await assert.rejects(
            h.service.execute(
              { ...staff, tenantId: randomUUID() },
              h.scope,
              row.requestId,
              h.input(),
            ),
          );
          assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
        },
      );
      await t.test(
        "the locked source must still identify the actual executor, not the saved preparer",
        async () => {
          const h = fixture(),
            executor = { ...h.actor, id: randomUUID() };
          h.authorize(executor.id);
          const row = await h.approve();
          h.wrongLockedCaller();
          const result = await h.service.execute(executor, h.scope, row.requestId, h.input());
          assert.equal(result.attempt?.state, "not_sent");
          assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
        },
      );
      await t.test("cross-staff claims require an explicitly bound receipt actor", async () => {
        const h = fixture(),
          executor = { ...h.actor, id: randomUUID() };
        h.authorize(executor.id);
        await h.approve();
        const fresh = { ...structuredClone(h.snapshot), actor: executor };
        await assert.rejects(ledger.asWriterStore(h.snapshot.binding).claim(fresh, h.input()));
        await assert.rejects(
          ledger.asWriterStore(h.snapshot.binding, h.actor).claim(fresh, h.input()),
        );
        assert.equal((await h.rows())[0].state, "approved");
        assert.equal(h.counters().writes, 0);
      });
      await t.test(
        "old actor-bound approvals cannot be silently reused after the revision protocol changes",
        async () => {
          const h = fixture(),
            row = await h.approve();
          const legacy = createHash("sha256")
            .update(JSON.stringify(stageWriteSnapshotSchema.parse(h.snapshot)))
            .digest("hex");
          assert.notEqual(legacy, row.revision);
          await tx.execute(sql`UPDATE audit_logs SET metadata=jsonb_set(metadata,'{revision}',to_jsonb(${legacy}::text))
          WHERE subject_id=${h.scope.recipientId} AND action='zoho.stage_request'`);
          await assert.rejects(
            h.service.execute(h.actor, h.scope, row.requestId, {
              ...h.input(),
              expectedRevision: legacy,
            }),
          );
          await assert.rejects(h.service.execute(h.actor, h.scope, row.requestId, h.input()));
          const replacement = await h.prepare();
          assert.notEqual(replacement.requestId, row.requestId);
          assert.equal(replacement.state, "prepared");
          assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
        },
      );
      await t.test(
        "legacy uncertain attempts remain held and permit observation, never a new revision retry",
        async () => {
          const h = fixture(),
            observer = { ...h.actor, id: randomUUID() };
          h.authorize(observer.id);
          const row = await h.approve();
          h.mode("uncertain");
          await h.service.execute(h.actor, h.scope, row.requestId, h.input());
          const legacy = createHash("sha256")
            .update(JSON.stringify(stageWriteSnapshotSchema.parse(h.snapshot)))
            .digest("hex");
          await tx.execute(sql`UPDATE audit_logs SET metadata=jsonb_set(metadata,'{revision}',to_jsonb(${legacy}::text))
          WHERE subject_id=${h.scope.recipientId} AND action='zoho.stage_request'`);
          await assert.rejects(h.prepare());
          const observed = await h.reconstruct().recover(observer, h.scope, row.requestId);
          assert.equal(observed.state, "observed_target");
          await assert.rejects(h.prepare());
          assert.equal(h.counters().writes, 1);
        },
      );
      await t.test("missing proof, permission or human decision blocks", async () => {
        for (const field of [
          "proof",
          "writePermissionConfirmed",
          "currentHumanDecision",
        ] as const) {
          const h = fixture();
          if (field === "proof") h.snapshot.proof = null;
          else h.snapshot[field] = false;
          await assert.rejects(h.prepare());
          assert.equal((await h.rows()).length, 0);
          assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
        }
      });
      await t.test("forged input and foreign scope cannot execute", async () => {
        const h = fixture();
        const row = await h.approve();
        for (const input of [
          { ...h.input(), proof: h.snapshot.proof },
          { ...h.input(), confirm: false },
        ])
          await assert.rejects(
            h.service.execute(h.actor, h.scope, row.requestId, input as ReturnType<typeof h.input>),
          );
        await assert.rejects(h.service.execute(h.actor, h.scope, randomUUID(), h.input()));
        await assert.rejects(
          h.service.execute(
            { ...h.actor, tenantId: randomUUID() },
            h.scope,
            row.requestId,
            h.input(),
          ),
        );
        assert.deepEqual(h.counters(), { reads: 0, writes: 0 });
      });
      await t.test("stale revisions and expired proofs block writes", async () => {
        for (const mutation of ["revision", "expiry"]) {
          const h = fixture();
          const row = await h.approve();
          const input = h.input();
          if (mutation === "revision") h.snapshot.sourceRevision = "d".repeat(64);
          else h.clock(2100);
          await assert.rejects(h.service.execute(h.actor, h.scope, row.requestId, input));
          assert.equal(h.counters().writes, 0);
        }
      });
      await t.test("lock-time changes or expiry prevent writes", async () => {
        for (const mutation of ["lock", "read"]) {
          const h = fixture();
          const row = await h.approve();
          if (mutation === "lock") h.lockChange();
          else h.mode("expire");
          const result = await h.service.execute(h.actor, h.scope, row.requestId, h.input());
          assert.equal(result.attempt?.state, "not_sent");
          assert.equal(h.counters().writes, 0);
        }
      });
      await t.test("uncertain recovery observes without resending", async () => {
        const h = fixture();
        const row = await h.approve();
        const input = h.input();
        h.mode("uncertain");
        const result = await h.service.execute(h.actor, h.scope, row.requestId, input);
        assert.equal(result.attempt?.state, "review_required");
        await h.reconstruct().execute(h.actor, h.scope, row.requestId, input);
        assert.equal(h.counters().writes, 1);
        h.clock(2100);
        const observed = await h.reconstruct().recover(h.actor, h.scope, row.requestId);
        assert.equal(observed.state, "observed_target");
        assert.equal(h.counters().writes, 1);
        h.snapshot.connectionRevision = randomUUID();
        const before = h.counters();
        await assert.rejects(h.reconstruct().recover(h.actor, h.scope, row.requestId));
        assert.deepEqual(h.counters(), before);
      });
      await t.test("receipt failure retains claim across reconstruction", async () => {
        const h = fixture();
        const row = await h.approve();
        const input = h.input();
        h.failRecording(true);
        await assert.rejects(h.service.execute(h.actor, h.scope, row.requestId, input));
        assert.equal((await h.rows())[0].state, "claimed");
        h.failRecording(false);
        const retry = await h.reconstruct().execute(h.actor, h.scope, row.requestId, input);
        assert.equal(retry.attempt?.state, "claimed");
        assert.equal(h.counters().writes, 1);
      });
      await t.test("withdrawn approval and offers cannot execute", async () => {
        const h = fixture();
        const row = await h.approve();
        await ledger.act(h.actor, h.scope, row.requestId, row.revision, "withdrawn", tx);
        await assert.rejects(h.service.execute(h.actor, h.scope, row.requestId, h.input()));
        const offer = fixture();
        offer.snapshot.targetStage = "Offer";
        await assert.rejects(offer.prepare());
        assert.equal(h.counters().writes + offer.counters().writes, 0);
      });
      throw rollback;
    }),
    (error) => error === rollback,
  );
});
