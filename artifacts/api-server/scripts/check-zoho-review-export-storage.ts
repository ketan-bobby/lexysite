/**
 * Explicitly verified development-only SQL fixture. No committed fixture data,
 * public-table writes, provider calls, tokens, messages or storage operations.
 * Canonical review/handoff reads are injected; persistence and erasure use
 * unchanged production implementations on a real, rollback-only transaction.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  pool,
  auditLogsTable,
  candidatesTable,
  usersTable,
  interviewSessionsTable,
  zohoCampaignRecipientsTable,
  zohoCampaignReviewsTable,
} from "@workspace/db";
import { zohoReviewExport } from "../src/lib/ats-connectors/zoho-review-export";
import type { zohoCampaignReviews } from "../src/lib/ats-connectors/zoho-campaign-reviews";
import type { zohoStageHandoff } from "../src/lib/ats-connectors/zoho-stage-handoff";
import { CANDIDATE_LINKED_TABLES, purgeCandidateLinkedData } from "../src/lib/candidate-erasure";

const fingerprint = process.argv[2];
const rollback = new Error("successful_private_fixture_rollback");
type Store = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Review = Awaited<ReturnType<ReturnType<typeof zohoCampaignReviews>["detail"]>>;
type Handoff = Awaited<ReturnType<ReturnType<typeof zohoStageHandoff>["detail"]>>;
const tables = [
  ...new Set([
    ...CANDIDATE_LINKED_TABLES,
    "candidates",
    "users",
    "audit_logs",
    "candidate_erasure_tombstones",
    "deletion_requests",
    "sourced_candidates",
    "ai_jobs",
    "ats_imported_applications",
    "interview_summaries",
    "interview_schedules",
    "recruiting_workflow_events",
  ]),
];

test("real export audit storage, failure refusal and erasure fence in a verified private development schema", async (t) => {
  assert.match(
    fingerprint ?? "",
    /^[a-f0-9]{32}$/,
    "Supply an independently verified development fingerprint.",
  );
  const namespace = `lexy_export_${randomUUID().replaceAll("-", "")}`;
  let verified = false;
  try {
    await dbAdmin.transaction(async (tx) => {
      const identity = await tx.execute(sql`SELECT md5(
        current_database() || '|' || COALESCE(inet_server_addr()::text,'local') || '|' ||
        COALESCE(inet_server_port()::text,'0') || '|' ||
        EXTRACT(EPOCH FROM pg_postmaster_start_time())::text
      ) AS fingerprint`);
      assert.equal(
        identity.rows[0]?.fingerprint,
        fingerprint,
        "Database target differs from the independently verified development connection; no DDL permitted.",
      );
      verified = true;
      await tx.execute(sql`CREATE SCHEMA ${sql.identifier(namespace)}`);
      for (const table of tables)
        await tx.execute(sql`CREATE TABLE ${sql.identifier(namespace)}.${sql.identifier(table)}
          (LIKE public.${sql.identifier(table)} INCLUDING ALL)`);
      // No public fallback: an incomplete fixture must fail, not mutate real rows.
      await tx.execute(sql`SELECT set_config('search_path', ${`${namespace},pg_catalog`}, true)`);
      assert.equal(
        (await tx.execute(sql`SELECT current_schema() AS schema`)).rows[0]?.schema,
        namespace,
      );
      const fk =
        await tx.execute(sql`SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid='public.zoho_campaign_reviews'::regclass
          AND confrelid='public.zoho_campaign_recipients'::regclass AND contype='f'`);
      assert.equal(fk.rows.length, 1);
      assert.match(
        String(fk.rows[0].definition),
        /^FOREIGN KEY \(recipient_id\) REFERENCES (?:public\.)?zoho_campaign_recipients\(id\) ON DELETE CASCADE$/,
      );
      await tx.execute(sql`ALTER TABLE ${sql.identifier(namespace)}.zoho_campaign_reviews
        ADD FOREIGN KEY (recipient_id) REFERENCES ${sql.identifier(namespace)}.zoho_campaign_recipients(id)
        ON DELETE CASCADE`);

      const actor = { id: randomUUID(), tenantId: randomUUID() };
      await tx.insert(usersTable).values({
        ...actor,
        name: "Fixture staff",
        email: `${actor.id}@example.invalid`,
        passwordHash: "!fixture-not-a-login",
        role: "tenant_admin",
        status: "active",
      });
      async function seed(handle: Store = tx) {
        const candidateId = randomUUID(),
          recipientId = randomUUID(),
          campaignId = randomUUID();
        const sessionId = randomUUID(),
          reviewId = randomUUID();
        await handle.insert(candidatesTable).values({
          id: candidateId,
          tenantId: actor.tenantId,
          firstName: "PRIVATE_NAME",
          lastName: "PRIVATE_SURNAME",
          email: `${candidateId}@example.invalid`,
          pool: "tenant",
        });
        await handle.insert(interviewSessionsTable).values({
          id: sessionId,
          tenantId: actor.tenantId,
          candidateId,
          planId: randomUUID(),
          applicationId: randomUUID(),
          status: "completed",
          completedAt: new Date(),
          score: 0,
        });
        await handle.insert(zohoCampaignRecipientsTable).values({
          id: recipientId,
          tenantId: actor.tenantId,
          campaignId,
          candidateId,
          sessionId,
          accountRef: `isolated-${campaignId}`,
          externalJobId: "123",
          externalApplicationId: "124",
          externalCandidateId: "125",
          state: "sent",
        });
        await handle.insert(zohoCampaignReviewsTable).values({
          id: reviewId,
          tenantId: actor.tenantId,
          campaignId,
          candidateId,
          recipientId,
          sessionId,
          decision: "hold",
          reason: "PRIVATE_REASON",
          evidenceHash: "a".repeat(64),
          reviewedBy: actor.id,
          requestId: randomUUID(),
          requestHash: "b".repeat(64),
        });
        const review: Review = {
          campaignId,
          recipientId,
          candidateName: "PRIVATE_NAME",
          sessionId,
          sessionStatus: "completed",
          completedAt: new Date(),
          revision: "c".repeat(64),
          assessment: {
            score: 0,
            summary: "PRIVATE_ASSESSMENT",
            recommendation: null,
            strengths: [],
            developmentAreas: [],
            concerns: [],
          },
          answers: [{ question: "Question", answer: "PRIVATE_TRANSCRIPT", score: 0 }],
          answersTruncated: false,
          reviewable: true,
          decisionStale: false,
          history: [
            {
              id: reviewId,
              evidenceCurrent: true,
              decision: "hold",
              reason: "PRIVATE_REASON",
              reviewedBy: actor.id,
              createdAt: new Date(),
            },
          ],
        };
        const handoff = {
          campaignId,
          recipientId,
          applicationId: "124",
          externalJobId: "123",
          externalCandidateId: "125",
          revision: "d".repeat(64),
          decision: "hold",
        } as Handoff;
        const input = {
          expectedRevision: review.revision,
          expectedHandoffRevision: handoff.revision,
          confirm: true as const,
        };
        const service = zohoReviewExport({
          store: handle,
          readReview: async () => structuredClone(review),
          readHandoff: async () => structuredClone(handoff),
        });
        const prepare = (caller = actor) => service.prepare(caller, campaignId, recipientId, input);
        return {
          candidateId,
          recipientId,
          campaignId,
          sessionId,
          reviewId,
          review,
          handoff,
          input,
          service,
          prepare,
        };
      }
      const auditCount = async () => (await tx.select().from(auditLogsTable)).length;
      const current = await seed(),
        peer = await seed();
      await t.test(
        "returned receipt refers to a real minimal audit row and a separate savepoint can read it",
        async () => {
          const receipt = await current.prepare();
          const rows = await tx.transaction((view) =>
            view.select().from(auditLogsTable).where(eq(auditLogsTable.id, receipt.id)),
          );
          assert.equal(rows.length, 1);
          const row = rows[0];
          assert.equal(row.actorId, actor.id);
          assert.equal(row.tenantId, actor.tenantId);
          assert.equal(row.subjectId, current.recipientId);
          assert.equal(row.action, "zoho.review_export.prepared");
          assert.equal(row.body, null);
          assert.equal(row.subjectLabel, null);
          assert.equal(row.createdAt.toISOString(), receipt.preparedAt.toISOString());
          assert.deepEqual(row.metadata, {
            provider: "zoho_recruit",
            campaignId: current.campaignId,
            recipientId: current.recipientId,
            reviewId: current.reviewId,
            reviewRevision: current.review.revision,
            handoffRevision: current.handoff.revision,
            state: "prepared",
            delivery: "unverified",
          });
          assert.doesNotMatch(
            JSON.stringify(row),
            /PRIVATE_|@example|externalCandidate|externalJob|applicationId/,
          );
        },
      );
      await peer.prepare();
      for (const change of [
        "erased",
        "tombstoned",
        "ats-tombstoned",
        "removed",
        "session",
        "review",
        "foreign",
        "inactive",
      ]) {
        await t.test(
          `actual storage refuses ${change} binding even if earlier reads succeeded`,
          async () => {
            const f = await seed();
            if (change === "erased")
              await tx
                .update(candidatesTable)
                .set({ dataErasedAt: new Date() })
                .where(eq(candidatesTable.id, f.candidateId));
            if (change === "tombstoned")
              await tx.execute(sql`INSERT INTO candidate_erasure_tombstones(subject_id)
            VALUES (${f.candidateId})`);
            if (change === "ats-tombstoned")
              await tx.execute(sql`INSERT INTO candidate_erasure_tombstones(subject_id)
            SELECT 'ats-profile:' || md5(jsonb_build_array(tenant_id,'zoho_recruit',account_ref,external_candidate_id)::text)
            FROM zoho_campaign_recipients WHERE id=${f.recipientId}`);
            if (change === "removed")
              await tx
                .delete(zohoCampaignRecipientsTable)
                .where(eq(zohoCampaignRecipientsTable.id, f.recipientId));
            if (change === "session")
              await tx
                .update(interviewSessionsTable)
                .set({ status: "in_progress" })
                .where(eq(interviewSessionsTable.id, f.sessionId));
            if (change === "review")
              await tx
                .update(zohoCampaignReviewsTable)
                .set({ candidateId: peer.candidateId })
                .where(eq(zohoCampaignReviewsTable.id, f.reviewId));
            if (change === "inactive")
              await tx
                .update(usersTable)
                .set({ status: "suspended" })
                .where(eq(usersTable.id, actor.id));
            const count = await auditCount();
            await assert.rejects(
              f.prepare(change === "foreign" ? { ...actor, tenantId: randomUUID() } : actor),
              { status: 409 },
            );
            assert.equal(await auditCount(), count);
            if (change === "inactive")
              await tx
                .update(usersTable)
                .set({ status: "active" })
                .where(eq(usersTable.id, actor.id));
          },
        );
      }
      await t.test(
        "a genuine SQL insertion error returns no receipt and rolls back only its preparation",
        async () => {
          await tx.execute(sql`CREATE FUNCTION ${sql.identifier(namespace)}.reject_fixture_audit()
          RETURNS trigger LANGUAGE plpgsql AS $body$
          BEGIN RAISE EXCEPTION 'fixture_audit_write_rejected'; END; $body$`);
          await tx.execute(sql`CREATE TRIGGER reject_fixture_audit BEFORE INSERT ON audit_logs
          FOR EACH ROW EXECUTE FUNCTION ${sql.identifier(namespace)}.reject_fixture_audit()`);
          const count = await auditCount();
          await assert.rejects(current.prepare(), (error: unknown) => {
            const fault = error as { message?: string; cause?: { message?: string } };
            return [fault.message, fault.cause?.message].includes("fixture_audit_write_rejected");
          });
          assert.equal(await auditCount(), count);
          await tx.execute(sql`DROP TRIGGER reject_fixture_audit ON audit_logs`);
        },
      );
      await t.test(
        "production erasure removes source links, retains the minimal legal audit and blocks a late writer",
        async () => {
          await purgeCandidateLinkedData(tx, current.candidateId);
          for (const table of [zohoCampaignRecipientsTable, zohoCampaignReviewsTable])
            assert.equal(
              (await tx.select().from(table).where(eq(table.candidateId, current.candidateId)))
                .length,
              0,
            );
          const retained = await tx
            .select()
            .from(auditLogsTable)
            .where(eq(auditLogsTable.subjectId, current.recipientId));
          assert.equal(
            retained.length,
            1,
            "Existing compliance retention policy must not be silently weakened",
          );
          assert.doesNotMatch(
            JSON.stringify(retained),
            /PRIVATE_|@example|externalCandidate|externalJob|applicationId/,
          );
          assert.equal(
            (
              await tx
                .select()
                .from(zohoCampaignRecipientsTable)
                .where(
                  and(
                    eq(zohoCampaignRecipientsTable.id, peer.recipientId),
                    eq(zohoCampaignRecipientsTable.candidateId, peer.candidateId),
                  ),
                )
            ).length,
            1,
          );
          const before = await auditCount();
          await assert.rejects(current.prepare(), { status: 409 });
          assert.equal(await auditCount(), before);
        },
      );
      await t.test(
        "erasure after the last review read is still refused by the real insert guard",
        async () => {
          const f = await seed();
          let reads = 0;
          const late = zohoReviewExport({
            store: tx,
            readReview: async () => {
              if (++reads === 2) await purgeCandidateLinkedData(tx, f.candidateId);
              return structuredClone(f.review);
            },
            readHandoff: async () => structuredClone(f.handoff),
          });
          const before = await auditCount();
          await assert.rejects(late.prepare(actor, f.campaignId, f.recipientId, f.input), {
            status: 409,
          });
          assert.equal(await auditCount(), before);
        },
      );
      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) throw error;
  } finally {
    try {
      if (verified) {
        const left = await dbAdmin.execute(
          sql`SELECT 1 FROM pg_namespace WHERE nspname=${namespace}`,
        );
        assert.equal(left.rows.length, 0, "Private fixture schema escaped rollback");
      }
    } finally {
      await pool.end();
    }
  }
});
