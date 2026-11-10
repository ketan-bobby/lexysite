import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { dbAdmin } from "@workspace/db";
import {
  assertStageAuthorityLocked,
  zohoStageAuthority,
  type StageAuthorityContext,
} from "./zoho-stage-authority";
import type { CampaignTx } from "./zoho-interview-campaigns";

const actor = { id: "stage-admin", tenantId: "stage-tenant" };
const context: StageAuthorityContext = {
  tenantId: actor.tenantId,
  candidateId: "stage-candidate",
  campaignId: "stage-campaign",
  recipientId: "stage-recipient",
  applicationId: "300",
  externalJobId: "100",
  externalCandidateId: "200",
  accountRef: "account",
  connectionRevision: "connection",
  sourceConnectionRevision: "campaign-revision",
  sourceEvidenceHash: "evidence",
  latestReviewId: "review",
  mappingRevision: "mapping",
  custodyRevision: createHash("sha256").update("synthetic-sealed-custody").digest("hex"),
  configFingerprint: "synthetic-config",
};

test("installed development schema accepts the stage authority query without matching application data", async () => {
  const rollback = new Error("rollback-stage-schema-check");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      const identity = (
        await tx.execute(sql`SELECT current_database() AS name, inet_server_addr() AS host`)
      ).rows[0];
      assert.equal(identity.name, "heliumdb");
      assert.equal(identity.host, null);
      await tx.execute(sql`SET LOCAL statement_timeout='3s'`);
      await tx.execute(sql`SET LOCAL lock_timeout='1s'`);
      const absent = { id: randomUUID(), tenantId: randomUUID() };
      await assert.rejects(
        assertStageAuthorityLocked(tx, absent, { ...context, tenantId: absent.tenantId }),
        (error: unknown) => (error as { code?: string }).code === "zoho_stage_authority_changed",
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );
});

test("SQL stage authority: current scope passes; changed privacy, staff, account and source fail", async () => {
  const rollback = new Error("rollback-stage-authority-fixture");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      const identity = (
        await tx.execute(sql`SELECT current_database() AS name, inet_server_addr() AS host`)
      ).rows[0];
      assert.equal(identity.name, "heliumdb");
      assert.equal(identity.host, null, "DDL requires verified local development PostgreSQL");
      // Never read or mutate shared rows. Each relation is private and rollback-only.
      await tx.execute(sql`
      CREATE TEMP TABLE users(id text, tenant_id text, role text, status text, account_erased_at timestamp);
      CREATE TEMP TABLE candidates(id text, tenant_id text, pool text, do_not_contact boolean, data_erased_at timestamp);
      CREATE TEMP TABLE zoho_campaign_recipients(id text, tenant_id text, candidate_id text,
        campaign_id text, account_ref text, external_job_id text, external_candidate_id text, external_application_id text);
      CREATE TEMP TABLE zoho_interview_campaigns(id text, tenant_id text, account_ref text,
        external_job_id text, revision text, job_id text, frozen_plan_id text);
      CREATE TEMP TABLE zoho_stage_mappings(campaign_id text, tenant_id text, revision text);
      CREATE TEMP TABLE jobs(id text, tenant_id text);
      CREATE TEMP TABLE interview_plans(id text, tenant_id text, job_id text);
      CREATE TEMP TABLE zoho_recruit_accounts(tenant_id text, account_ref text, user_id text,
        revision text, approved_at timestamp, fingerprint text, refresh_token_enc text);
      CREATE TEMP TABLE candidate_erasure_tombstones(subject_id text);
      SET LOCAL search_path=pg_temp,pg_catalog;
      INSERT INTO users VALUES
        ('stage-admin','stage-tenant','tenant_admin','active',NULL),
        ('stage-owner','stage-tenant','tenant_admin','active',NULL);
      INSERT INTO candidates VALUES ('stage-candidate','stage-tenant','tenant',false,NULL);
      INSERT INTO zoho_campaign_recipients VALUES
        ('stage-recipient','stage-tenant','stage-candidate','stage-campaign','account','100','200','300');
      INSERT INTO zoho_interview_campaigns VALUES
        ('stage-campaign','stage-tenant','account','100','campaign-revision','stage-job','stage-plan');
      INSERT INTO zoho_stage_mappings VALUES ('stage-campaign','stage-tenant','mapping');
      INSERT INTO jobs VALUES ('stage-job','stage-tenant');
      INSERT INTO interview_plans VALUES ('stage-plan','stage-tenant','stage-job');
      INSERT INTO zoho_recruit_accounts VALUES
        ('stage-tenant','account','stage-owner','connection',now(),'synthetic-config','synthetic-sealed-custody');
    `);
      await assertStageAuthorityLocked(tx, actor, context);
      const changes = [
        sql`UPDATE candidates SET do_not_contact=true`,
        sql`UPDATE candidates SET pool='platform'`,
        sql`UPDATE candidates SET pool='pending_profile'`,
        sql`UPDATE candidates SET data_erased_at=now()`,
        sql`UPDATE users SET status='suspended' WHERE id='stage-admin'`,
        sql`UPDATE users SET role='candidate' WHERE id='stage-admin'`,
        sql`UPDATE users SET account_erased_at=now() WHERE id='stage-owner'`,
        sql`UPDATE users SET status='suspended' WHERE id='stage-owner'`,
        sql`UPDATE zoho_recruit_accounts SET revision='replaced'`,
        sql`UPDATE zoho_recruit_accounts SET approved_at=NULL`,
        sql`UPDATE zoho_recruit_accounts SET fingerprint='replaced'`,
        sql`UPDATE zoho_recruit_accounts SET refresh_token_enc='replaced-grant-same-revision'`,
        sql`UPDATE zoho_recruit_accounts SET user_id='other-owner'`,
        sql`UPDATE zoho_interview_campaigns SET revision='replaced'`,
        sql`UPDATE zoho_stage_mappings SET revision='replaced'`,
        sql`UPDATE interview_plans SET job_id='other-job'`,
        sql`UPDATE jobs SET tenant_id='other-tenant'`,
        sql`UPDATE zoho_campaign_recipients SET external_application_id='301'`,
        sql`UPDATE zoho_campaign_recipients SET external_candidate_id='201'`,
        sql`UPDATE zoho_campaign_recipients SET external_job_id='101'`,
        sql`INSERT INTO candidate_erasure_tombstones VALUES ('stage-candidate')`,
        sql`INSERT INTO candidate_erasure_tombstones
        SELECT 'ats-profile:' || md5(jsonb_build_array('stage-tenant','zoho_recruit','account','200')::text)`,
      ];
      for (const change of changes) {
        const reset = new Error(randomUUID());
        await assert.rejects(
          tx.transaction(async (savepoint) => {
            await savepoint.execute(change);
            await assert.rejects(
              assertStageAuthorityLocked(savepoint, actor, context),
              (error: unknown) =>
                (error as { code?: string }).code === "zoho_stage_authority_changed",
            );
            throw reset;
          }),
          (error) => error === reset,
        );
        await assertStageAuthorityLocked(tx, actor, context);
      }
      await assert.rejects(
        assertStageAuthorityLocked(tx, { ...actor, tenantId: "foreign" }, context),
      );
      await assert.rejects(
        assertStageAuthorityLocked(tx, actor, { ...context, tenantId: "foreign" }),
      );
      await assert.rejects(
        assertStageAuthorityLocked(tx, actor, { ...context, custodyRevision: "" }),
      );
      throw rollback;
    }),
    (error) => error === rollback,
  );
});

test("stage fence holds authority through callback and rechecks source after extra locks", async () => {
  const calls: string[] = [];
  const tx = {
    execute: async () => {
      calls.push("sql-locks");
      return { rows: [{ id: context.candidateId }] };
    },
  } as unknown as CampaignTx;
  let valid = true;
  const fence = zohoStageAuthority({
    authority: {
      fence: async (_a: unknown, _c: unknown, work: (tx: CampaignTx) => Promise<unknown>) => {
        calls.push("note-locks");
        try {
          return await work(tx);
        } finally {
          calls.push("release");
        }
      },
    } as never,
    assertCurrent: async (_a, _c, _r, _h, _v, handle) => {
      assert.equal(handle, tx);
      calls.push("source-check");
      if (!valid) throw Error("Source changed while waiting");
    },
  });
  const value = await fence.fence(actor, context, async (handle) => {
    assert.equal(handle, tx);
    calls.push("provider-read");
    await Promise.resolve();
    assert.equal(calls.includes("release"), false);
    return 7;
  });
  assert.equal(value, 7);
  assert.deepEqual(calls, [
    "note-locks",
    "sql-locks",
    "sql-locks",
    "source-check",
    "provider-read",
    "release",
  ]);
  calls.length = 0;
  valid = false;
  await assert.rejects(
    fence.fence(actor, context, async () => {
      calls.push("must-not-run");
    }),
  );
  assert.deepEqual(calls, ["note-locks", "sql-locks", "sql-locks", "source-check", "release"]);
});
