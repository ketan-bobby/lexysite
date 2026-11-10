/**
 * Only called by the ownership-verified disposable-cluster worker.
 * Real SQL barrier and competing PostgreSQL sessions; no provider or app data.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { drizzle } from "drizzle-orm/node-postgres";
import type { Pool } from "pg";
import {
  assertStageAuthorityLocked,
  type StageAuthorityContext,
} from "../zoho-stage-authority-sql";
import type { CampaignTx } from "../zoho-interview-campaigns";

const actor = { id: "admin", tenantId: "tenant" };
const context: StageAuthorityContext = {
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
  sourceEvidenceHash: "synthetic-evidence",
  latestReviewId: null,
  mappingRevision: "mapping",
  custodyRevision: createHash("sha256").update("synthetic-custody").digest("hex"),
  configFingerprint: "synthetic-config",
};

const cases = [
  ["acting admin suspended", "UPDATE users SET status='suspended' WHERE id='admin'"],
  ["connection owner suspended", "UPDATE users SET status='suspended' WHERE id='owner'"],
  ["candidate DNC", "UPDATE candidates SET do_not_contact=true"],
  // platform-pool-write-exempt: negative fixture in ownership-verified disposable cluster only; never app data.
  ["candidate pool changed", "UPDATE candidates SET pool='platform'"],
  [
    "canonical erasure",
    "UPDATE candidates SET data_erased_at=now(); INSERT INTO candidate_erasure_tombstones VALUES ('candidate')",
  ],
  [
    "ATS alias erasure with candidate lock",
    `SELECT id FROM candidates WHERE id='candidate' FOR UPDATE;
     INSERT INTO candidate_erasure_tombstones SELECT 'ats-profile:' ||
       md5(jsonb_build_array('tenant','zoho_recruit','account','200')::text)`,
  ],
  [
    "grant replaced at unchanged revision",
    "UPDATE zoho_recruit_accounts SET refresh_token_enc='replacement'",
  ],
  ["employer approval revoked", "UPDATE zoho_recruit_accounts SET approved_at=NULL"],
  ["mapping replaced", "UPDATE zoho_stage_mappings SET revision='replacement'"],
  ["campaign source replaced", "UPDATE zoho_interview_campaigns SET revision='replacement'"],
  ["plan moved to another job", "UPDATE interview_plans SET job_id='other-job'"],
] as const;

export async function runStageAuthorityRaces(pool: Pool) {
  // Namespace and roles exist only in the freshly initialized cluster. No
  // fallback to public relations and no changes to shared database privileges.
  await pool.query(`
    CREATE SCHEMA stage_authority_fixture;
    SET search_path=stage_authority_fixture,pg_catalog;
    CREATE TABLE users(id text PRIMARY KEY, tenant_id text, role text, status text, account_erased_at timestamp);
    CREATE TABLE candidates(id text PRIMARY KEY, tenant_id text, pool text, do_not_contact boolean, data_erased_at timestamp);
    CREATE TABLE zoho_campaign_recipients(id text PRIMARY KEY, tenant_id text, candidate_id text,
      campaign_id text, account_ref text, external_job_id text, external_candidate_id text, external_application_id text);
    CREATE TABLE zoho_interview_campaigns(id text PRIMARY KEY, tenant_id text, account_ref text,
      external_job_id text, revision text, job_id text, frozen_plan_id text);
    CREATE TABLE zoho_stage_mappings(campaign_id text PRIMARY KEY, tenant_id text, revision text);
    CREATE TABLE jobs(id text PRIMARY KEY, tenant_id text);
    CREATE TABLE interview_plans(id text PRIMARY KEY, tenant_id text, job_id text);
    CREATE TABLE zoho_recruit_accounts(tenant_id text PRIMARY KEY, account_ref text, user_id text,
      revision text, approved_at timestamp, fingerprint text, refresh_token_enc text);
    CREATE TABLE candidate_erasure_tombstones(subject_id text PRIMARY KEY);
  `);
  // Separate sessions are essential: savepoints cannot demonstrate blocking.
  const fence = await pool.connect();
  const revoker = await pool.connect();
  const observer = await pool.connect();
  let checks = 0;
  try {
    for (const client of [fence, revoker, observer]) {
      await client.query("SET search_path=stage_authority_fixture,pg_catalog");
      await client.query("SET statement_timeout='8s'");
      await client.query("SET lock_timeout='6s'");
    }
    const fencePid = (await fence.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const revokerPid = (await revoker.query("SELECT pg_backend_pid() AS id")).rows[0].id;
    const handle = drizzle(fence) as unknown as CampaignTx;
    const reset = async () => {
      await observer.query(`
        TRUNCATE users,candidates,zoho_campaign_recipients,zoho_interview_campaigns,
          zoho_stage_mappings,jobs,interview_plans,zoho_recruit_accounts,candidate_erasure_tombstones;
        INSERT INTO users VALUES ('admin','tenant','tenant_admin','active',NULL),
          ('owner','tenant','tenant_admin','active',NULL);
        INSERT INTO candidates VALUES ('candidate','tenant','tenant',false,NULL);
        INSERT INTO zoho_campaign_recipients VALUES
          ('recipient','tenant','candidate','campaign','account','100','200','300');
        INSERT INTO zoho_interview_campaigns VALUES ('campaign','tenant','account','100','source','job','plan');
        INSERT INTO zoho_stage_mappings VALUES ('campaign','tenant','mapping');
        INSERT INTO jobs VALUES ('job','tenant');
        INSERT INTO interview_plans VALUES ('plan','tenant','job');
        INSERT INTO zoho_recruit_accounts VALUES
          ('tenant','account','owner','connection',now(),'synthetic-config','synthetic-custody');
      `);
    };
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
      assert.fail(`Expected PostgreSQL lock dependency ${waiter} -> ${blocker}`);
    };
    for (const [name, mutation] of cases) {
      await reset();
      // Revocation takes its lock first. The authority query must wait and
      // reject the newly committed state rather than pass its old snapshot.
      await revoker.query("BEGIN");
      await revoker.query(mutation);
      await fence.query("BEGIN");
      const rejected = assert.rejects(
        assertStageAuthorityLocked(handle, actor, context),
        (error: unknown) => (error as { code?: string }).code === "zoho_stage_authority_changed",
        `${name}: committed revocation must prevent the protected callback`,
      );
      await blockedBy(fencePid, revokerPid);
      await revoker.query("COMMIT");
      await rejected;
      await fence.query("ROLLBACK");
      checks++;

      await reset();
      // A protected operation takes its locks first. Competing revocation
      // cannot commit until the operation finishes (or aborts).
      await fence.query("BEGIN");
      await assertStageAuthorityLocked(handle, actor, context);
      await revoker.query("BEGIN");
      let finished = false;
      const pending = revoker.query(mutation).then(
        () => {
          finished = true;
        },
        (error: unknown) => {
          throw new Error(`${name}: competing update failed`, { cause: error });
        },
      );
      // Observe real lock wait, not a sleep-based "probably blocked" assertion.
      await blockedBy(revokerPid, fencePid);
      assert.equal(finished, false, name);
      await assertStageAuthorityLocked(handle, actor, context);
      // Emulates completing the protected read. No live provider exists here.
      await fence.query("COMMIT");
      await pending;
      await revoker.query("COMMIT");
      await fence.query("BEGIN");
      await assert.rejects(
        assertStageAuthorityLocked(handle, actor, context),
        (error: unknown) => (error as { code?: string }).code === "zoho_stage_authority_changed",
        `${name}: subsequent operation must reject`,
      );
      await fence.query("ROLLBACK");
      checks++;
    }
    return { cases: cases.length, checks, actualRequestRole: false, liveProvider: false };
  } finally {
    await Promise.all([fence.query("ROLLBACK"), revoker.query("ROLLBACK")]);
    fence.release();
    revoker.release();
    observer.release();
  }
}
