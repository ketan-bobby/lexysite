/**
 * Runs only after cluster identity verification and the stage SQL fixture.
 * Uses the real note fence, stage barrier and canonical evidence/review checker.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import { zohoInterviewNoteStore } from "../zoho-interview-note-store";
import { zohoStageAuthority, type StageAuthorityContext } from "../zoho-stage-authority";
import { readZohoNoteSource } from "../zoho-note-source-current";

const actor = { id: "admin", tenantId: "tenant" };
const cases = [
  ["session answer edited", `UPDATE interview_sessions SET answers='[{"answer":"changed"}]'`],
  ["assessment edited", "UPDATE interview_summaries SET recruiter_summary='changed'"],
  ["plan questions edited", `UPDATE interview_plans SET questions='["changed"]'`],
  ["job context edited", "UPDATE jobs SET title='changed'"],
  [
    "new human review",
    `SELECT id FROM zoho_campaign_recipients WHERE id='recipient' FOR UPDATE;
     INSERT INTO zoho_campaign_reviews VALUES ('review-2','tenant','campaign','recipient','review-1',now())`,
  ],
  ["acting admin suspended", "UPDATE users SET status='suspended' WHERE id='admin'"],
  ["candidate DNC", "UPDATE candidates SET do_not_contact=true"],
  [
    "grant replaced at unchanged revision",
    "UPDATE zoho_recruit_accounts SET refresh_token_enc='changed'",
  ],
  [
    "ATS alias erasure",
    `SELECT id FROM candidates WHERE id='candidate' FOR UPDATE;
     INSERT INTO candidate_erasure_tombstones SELECT 'ats-profile:' ||
       md5(jsonb_build_array('tenant','zoho_recruit','account','200')::text)`,
  ],
] as const;

export async function runCombinedStageRaces(pool: Pool) {
  await pool.query(`
    SET search_path=stage_authority_fixture,pg_catalog;
    ALTER TABLE zoho_campaign_recipients ADD COLUMN session_id text;
    ALTER TABLE interview_plans ADD COLUMN questions jsonb, ADD COLUMN focus_directive text;
    ALTER TABLE jobs ADD COLUMN title text, ADD COLUMN description text, ADD COLUMN status text;
    CREATE TABLE interview_sessions(id text PRIMARY KEY, tenant_id text, candidate_id text,
      plan_id text, application_id text, status text, completed_at timestamp, score integer, answers jsonb);
    CREATE TABLE interview_summaries(id text PRIMARY KEY, interview_session_id text,
      overall_score integer, recruiter_summary text, strengths jsonb, weaknesses jsonb,
      red_flags jsonb, recommendation text);
    CREATE TABLE zoho_campaign_reviews(id text PRIMARY KEY, tenant_id text, campaign_id text,
      recipient_id text, previous_review_id text, created_at timestamp);
  `);
  const client = await pool.connect();
  const revoker = await pool.connect();
  const observer = await pool.connect();
  try {
    for (const session of [client, revoker, observer]) {
      await session.query("SET search_path=stage_authority_fixture,pg_catalog");
      await session.query("SET statement_timeout='8s'");
      await session.query("SET lock_timeout='6s'");
    }
    const db = drizzle(client);
    // Real ORM root/transaction objects: never nest one over a manual BEGIN.
    const combined = zohoStageAuthority({
      authority: zohoInterviewNoteStore({ database: db as never }),
    });
    const pid = (await client.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const revokerPid = (await revoker.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const blockedBy = async (waiter: number, blocker: number) => {
      const deadline = Date.now() + 4000;
      while (Date.now() < deadline) {
        const row = (
          await observer.query("SELECT $2::int=ANY(pg_blocking_pids($1::int)) AS blocked", [
            waiter,
            blocker,
          ])
        ).rows[0];
        if (row.blocked) return;
        await setImmediate();
      }
      assert.fail("Expected combined-fence database lock dependency");
    };
    const reset = async (): Promise<StageAuthorityContext> => {
      await observer.query(`
        TRUNCATE users,candidates,zoho_campaign_recipients,zoho_interview_campaigns,
          zoho_stage_mappings,jobs,interview_plans,zoho_recruit_accounts,
          candidate_erasure_tombstones,interview_sessions,interview_summaries,zoho_campaign_reviews;
        INSERT INTO users VALUES ('admin','tenant','tenant_admin','active',NULL),
          ('owner','tenant','tenant_admin','active',NULL);
        INSERT INTO candidates VALUES ('candidate','tenant','tenant',false,NULL);
        INSERT INTO zoho_campaign_recipients VALUES
          ('recipient','tenant','candidate','campaign','account','100','200','300','session');
        INSERT INTO zoho_interview_campaigns VALUES ('campaign','tenant','account','100','source','job','plan');
        INSERT INTO zoho_stage_mappings VALUES ('campaign','tenant','mapping');
        INSERT INTO jobs VALUES ('job','tenant','Synthetic role','Synthetic description','approved');
        INSERT INTO interview_plans VALUES ('plan','tenant','job','["Synthetic question"]','Synthetic focus');
        INSERT INTO zoho_recruit_accounts VALUES
          ('tenant','account','owner','connection',now(),'synthetic-config','synthetic-custody');
        INSERT INTO interview_sessions VALUES
          ('session','tenant','candidate','plan','ats-campaign:recipient','completed',now(),80,'[{"answer":"synthetic"}]');
        INSERT INTO interview_summaries VALUES
          ('summary','session',80,'Synthetic assessment','[]','[]','[]','review');
        INSERT INTO zoho_campaign_reviews VALUES
          ('review-1','tenant','campaign','recipient',NULL,now());
      `);
      const source = await readZohoNoteSource(actor, "campaign", "recipient", db);
      assert.ok(source.evidenceHash);
      assert.equal(source.latestReviewId, "review-1");
      return {
        tenantId: "tenant",
        candidateId: "candidate",
        campaignId: "campaign",
        recipientId: "recipient",
        applicationId: "300",
        externalCandidateId: "200",
        externalJobId: "100",
        accountRef: "account",
        connectionRevision: "connection",
        sourceConnectionRevision: "source",
        sourceEvidenceHash: source.evidenceHash,
        latestReviewId: source.latestReviewId,
        mappingRevision: "mapping",
        custodyRevision: createHash("sha256").update("synthetic-custody").digest("hex"),
        configFingerprint: "synthetic-config",
      };
    };
    const isConflict = (error: unknown) =>
      ["zoho_note_changed", "zoho_stage_authority_changed", "review_conflict"].includes(
        (error as { code?: string }).code ?? "",
      );
    let callbacks = 0;
    let checks = 0;
    const positive = await reset();
    assert.equal(await combined.fence(actor, positive, async () => "unchanged"), "unchanged");
    for (const [name, mutation] of cases) {
      const before = await reset();
      await revoker.query("BEGIN");
      await revoker.query(mutation);
      const rejected = assert.rejects(
        combined.fence(actor, before, async () => {
          callbacks++;
        }),
        isConflict,
        `${name}: stale source must not reach protected work`,
      );
      await blockedBy(pid, revokerPid);
      await revoker.query("COMMIT");
      await rejected;
      assert.equal(callbacks, 0, name);
      checks++;

      const during = await reset();
      let release!: () => void;
      let entered!: () => void;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const ready = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const operation = combined.fence(actor, during, async () => {
        entered();
        await held;
        return "protected-read-completed";
      });
      // Surface early fence failure rather than waiting forever for its callback.
      await Promise.race([ready, operation.then(() => assert.fail("Callback did not pause"))]);
      try {
        await revoker.query("BEGIN");
        const pending = revoker.query(mutation);
        await blockedBy(revokerPid, pid);
        release();
        assert.equal(await operation, "protected-read-completed");
        await pending;
        await revoker.query("COMMIT");
      } finally {
        release();
        await operation;
      }
      await assert.rejects(
        combined.fence(actor, during, async () => {
          callbacks++;
        }),
        isConflict,
        `${name}: next operation must reject changed evidence/authority`,
      );
      assert.equal(callbacks, 0, name);
      checks++;
    }
    return { cases: cases.length, checks, unchangedControl: true, actualRequestRole: false };
  } finally {
    await revoker.query("ROLLBACK");
    client.release();
    revoker.release();
    observer.release();
  }
}
