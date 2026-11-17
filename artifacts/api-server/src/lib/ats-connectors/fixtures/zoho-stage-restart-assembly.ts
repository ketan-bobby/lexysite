/**
 * Disposable-cluster fixture only. Reconstructs the real dispatch, rule journal,
 * SQL stage barrier, OAuth adapter and HTTP routes in each fresh worker.
 * Upstream Zoho, login identity and canonical note-source assembly are fixtures.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import express from "express";
import { sql } from "drizzle-orm";
import { dbAdmin } from "@workspace/db";
import { CalendarError } from "../../outlook-calendar-core";
import { zohoRecruitAccountRouter } from "../../../routes/zoho-recruit-account";
import { zohoStageDispatch } from "../zoho-stage-dispatch";
import { zohoStageRules } from "../zoho-stage-rules";
import { zohoStageRuleStore } from "../zoho-stage-rule-store";
import { zohoStageRequests } from "../zoho-stage-requests";
import { zohoStageRequestStore } from "../zoho-stage-request-store";
import { zohoStageAuthority } from "../zoho-stage-authority";
import { zohoStageConnection } from "../zoho-stage-connection";
import { zohoDigest, zohoOAuthProvider, ZOHO_DATA_CENTERS } from "../zoho-oauth-provider";
import type { StageWriteSnapshot, StageWriteActor } from "../zoho-stage-write-core";
import type { CampaignTx } from "../zoho-interview-campaigns";

export async function runRestartAssembly(
  input: {
    snapshot: StageWriteSnapshot;
    mode: string;
    requestId: string;
    enabled?: boolean;
    expired?: boolean;
    pauseAt?: string;
  },
  pause: (point: string) => Promise<never>,
) {
  const s = input.snapshot;
  const a = s.actor;
  // Distinct, repeatable identities survive worker replacement.
  const b = { ...a, id: `${a.id[0] === "1" ? "2" : "1"}${a.id.slice(1)}` };
  const c = { ...a, id: `${["1", "2"].includes(a.id[0]) ? "3" : "2"}${a.id.slice(1)}` };
  const scope = s.scope;
  const candidateId = scope.recipientId;
  const sealed = "synthetic-restart-custody";
  const config = {
    region: ZOHO_DATA_CENTERS.us,
    clientId: "1000.Synthetic",
    clientSecret: "synthetic-not-a-secret",
    redirectUri: "https://fixture.invalid/callback",
    settingsUrl: "https://fixture.invalid/settings/ats",
    fingerprint: "e".repeat(64),
  };
  const now = () => (input.expired ? 10_000_000 : 10_000);
  let actor = a;
  let connections = 0;
  let requests = 0;
  let inside = false;
  const row = async (handle = dbAdmin) =>
    (
      await handle.execute(sql`SELECT revision FROM fixture_stage_source
      WHERE campaign_id=${scope.campaignId}`)
    ).rows[0];
  async function allowed(caller: StageWriteActor) {
    const found = await dbAdmin.execute(sql`SELECT id FROM users
      WHERE id=${caller.id} AND tenant_id=${caller.tenantId}
      AND role='tenant_admin' AND status='active' AND account_erased_at IS NULL`);
    if (caller.tenantId !== a.tenantId || found.rows.length !== 1)
      throw new CalendarError(403, "fixture_staff_revoked", "Staff access revoked");
  }
  const context = {
    tenantId: a.tenantId,
    ...scope,
    candidateId,
    accountRef: s.accountRef,
    connectionRevision: "source-connection",
    applicationId: s.binding.applicationId,
    externalCandidateId: s.binding.candidateId,
    externalJobId: s.binding.jobId,
    sourceEvidenceHash: s.sourceRevision,
    latestReviewId: "synthetic-human-review",
  };
  const deps = {
    handoff: {
      detail: async (caller: StageWriteActor, campaign: string, recipient: string) => {
        assert(!inside, "no pooled context reads while source fence is held");
        await allowed(caller);
        if (campaign !== scope.campaignId || recipient !== scope.recipientId)
          throw new CalendarError(404, "not_found", "Not found");
        return {
          revision: String((await row())?.revision),
          ready: true,
          decision: s.decision,
          targetStatus: s.targetStatus,
          applicationId: s.binding.applicationId,
          externalCandidateId: s.binding.candidateId,
          externalJobId: s.binding.jobId,
          mapping: { revision: scope.campaignId },
        };
      },
    },
    reviews: { noteContext: async () => context },
    permissions: {
      check: async () => ({
        connectionRevision: s.connectionRevision,
        writeConsentSaved: true,
        custodyRevision: zohoDigest(sealed),
        configFingerprint: config.fingerprint,
      }),
    },
    validation: {
      check: async () => ({
        handoffRevision: String((await row())?.revision),
        mappingRevision: scope.campaignId,
        connectionRevision: context.connectionRevision,
        identityVerified: true,
        applicationId: s.binding.applicationId,
        externalCandidateId: s.binding.candidateId,
        externalJobId: s.binding.jobId,
        currentApplicationStatus: s.currentStatus,
        catalogRevision: "f".repeat(64),
        mappings: [{ decision: s.decision, targetStatus: s.targetStatus, result: "matched" }],
      }),
    },
    authority: {
      // Canonical note-source assembly is simulated, but the stage SQL barrier
      // and reviewer queries run against real committed source rows.
      fence: async <T>(_actor: unknown, _context: unknown, work: (tx: CampaignTx) => Promise<T>) =>
        dbAdmin.transaction(async (tx) => {
          await tx.execute(sql`SELECT campaign_id FROM fixture_stage_source
            WHERE campaign_id=${scope.campaignId} FOR UPDATE`);
          inside = true;
          try {
            return await work(tx);
          } finally {
            inside = false;
          }
        }),
    },
    assertSourceCurrent: async (
      _actor: unknown,
      _campaign: unknown,
      _recipient: unknown,
      expected: string,
      _review: unknown,
      tx: CampaignTx,
    ) => {
      assert(inside);
      if ((await row(tx as unknown as typeof dbAdmin))?.revision !== expected)
        throw new CalendarError(409, "source_changed", "Source changed");
    },
    now,
  };
  const baseLedger = zohoStageRequestStore(undefined, "execution");
  const ledger: typeof baseLedger = {
    ...baseLedger,
    asWriterStore: (...args) => {
      const base = baseLedger.asWriterStore(...args);
      return {
        ...base,
        claim: async (...params) => {
          if (input.pauseAt === "before_claim") await pause("before_claim");
          const result = await base.claim(...params);
          if (result.acquired && input.pauseAt === "claimed") await pause("claimed");
          return result;
        },
        record: async (...params) => {
          const result = await base.record(...params);
          if (params[1] === "provider_accepted" && input.pauseAt === "provider_accepted")
            await pause("provider_accepted");
          return result;
        },
      };
    },
  };
  const connectionFactory: typeof zohoStageConnection = (options = {}) =>
    zohoStageConnection({
      config,
      now,
      store: {
        get: async () => {
          assert(!inside);
          connections++;
          const found = (
            await dbAdmin.execute(sql`SELECT * FROM zoho_recruit_accounts
            WHERE tenant_id=${a.tenantId}`)
          ).rows[0];
          return found
            ? {
                tenantId: a.tenantId,
                userId: String(found.user_id),
                approvedAt: new Date(String(found.approved_at)),
                refreshTokenEnc: String(found.refresh_token_enc),
                accountRef: String(found.account_ref),
                revision: String(found.revision),
                fingerprint: String(found.fingerprint),
              }
            : null;
        },
      } as unknown as NonNullable<Parameters<typeof zohoStageConnection>[0]>["store"],
      actorLookup: async (id) => {
        assert(!inside);
        assert(id);
        const caller = { id, tenantId: a.tenantId };
        await allowed(caller);
        return caller;
      },
      unseal: () =>
        JSON.stringify({
          purpose: "zoho-recruit",
          tenantId: a.tenantId,
          userId: a.id,
          accountRef: s.accountRef,
          fingerprint: config.fingerprint,
          token: "synthetic-refresh",
          stageWrites: true,
        }),
      providerFactory: (cfg, request) => ({
        ...zohoOAuthProvider(cfg, request),
        refresh: async () => "synthetic-access",
        organization: async () => ({ accountRef: s.accountRef, companyName: "Fixture" }),
      }),
      request: async (url, init = {}) => {
        assert(inside);
        requests++;
        if (init.method === "PUT") {
          assert.equal(String(url), "https://recruit.zoho.com/recruit/v2/Candidates/status");
          const body = JSON.parse(String(init.body)).data[0];
          assert.deepEqual(body.ids, [s.binding.candidateId]);
          assert.deepEqual(body.jobids, [s.binding.jobId]);
          assert.equal((await baseLedger.list(c, scope))[0].state, "claimed");
          // Independently committed stand-in for an external provider effect.
          await dbAdmin.execute(sql`INSERT INTO fixture_provider_effects(recipient_id)
            VALUES (${scope.recipientId})`);
          if (input.pauseAt === "effect") await pause("effect");
          return Response.json({
            data: [
              [{ code: "SUCCESS", status: "success", details: { id: s.binding.candidateId } }],
            ],
          });
        }
        assert(String(url).includes(`/Applications/${s.binding.applicationId}?`));
        const count = (
          await dbAdmin.execute(sql`SELECT count(*)::int AS n
          FROM fixture_provider_effects WHERE recipient_id=${scope.recipientId}`)
        ).rows[0];
        return Response.json({
          data: [
            {
              id: s.binding.applicationId,
              $Candidate_Id: s.binding.candidateId,
              $Job_Opening_Id: s.binding.jobId,
              Application_Status: Number(count.n) ? s.targetStatus : s.currentStatus,
            },
          ],
        });
      },
      authority: zohoStageAuthority({
        authority: deps.authority,
        assertCurrent: deps.assertSourceCurrent,
      } as unknown as NonNullable<Parameters<typeof zohoStageAuthority>[0]>),
      ...options,
    });
  const rules = zohoStageRules({
    ...deps,
    store: zohoStageRuleStore(),
  } as unknown as NonNullable<Parameters<typeof zohoStageRules>[0]>);
  const recovery = zohoStageRequests({
    ...deps,
    ledger,
    recoveryConnections: connectionFactory({ mode: "read_only" }),
  } as unknown as NonNullable<Parameters<typeof zohoStageRequests>[0]>);
  const service = zohoStageDispatch({
    rules,
    ledger,
    recovery,
    connectionFactory,
    enabled: () => input.enabled !== false,
    now,
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          await allowed(actor);
          return actor;
        },
      } as unknown as NonNullable<Parameters<typeof zohoRecruitAccountRouter>[0]>,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => service,
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert(address && typeof address !== "string");
  const path = `/api/zoho-recruit/campaigns/${scope.campaignId}/recipients/${scope.recipientId}/stage-execution`;
  const call = async (suffix = "", body?: unknown) => {
    const response = await fetch(`http://127.0.0.1:${address.port}${path}${suffix}`, {
      method: body ? "POST" : "GET",
      headers: { "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    assert.equal(response.headers.get("cache-control"), "no-store");
    return {
      status: response.status,
      body: (await response.json()) as Awaited<ReturnType<typeof service.view>>,
    };
  };
  try {
    if (input.mode === "assembly-bootstrap") {
      await dbAdmin.transaction(async (tx) => {
        for (const user of [a, b, c])
          await tx.execute(sql`INSERT INTO users VALUES
            (${user.id},${a.tenantId},'tenant_admin','active',NULL)`);
        await tx.execute(sql`INSERT INTO candidates VALUES
          (${candidateId},${a.tenantId},'tenant',false,NULL)`);
        await tx.execute(sql`INSERT INTO jobs VALUES(${scope.campaignId},${a.tenantId})`);
        await tx.execute(sql`INSERT INTO interview_plans VALUES
          (${scope.campaignId},${a.tenantId},${scope.campaignId})`);
        await tx.execute(sql`INSERT INTO zoho_interview_campaigns VALUES
          (${scope.campaignId},${a.tenantId},${s.accountRef},${s.binding.jobId},
           ${scope.campaignId},${scope.campaignId},${context.connectionRevision})`);
        await tx.execute(sql`INSERT INTO zoho_campaign_recipients VALUES
          (${scope.recipientId},${a.tenantId},${candidateId},${scope.campaignId},
           ${s.accountRef},${s.binding.jobId},${s.binding.applicationId},${s.binding.candidateId})`);
        await tx.execute(sql`INSERT INTO zoho_stage_mappings VALUES
          (${scope.campaignId},${a.tenantId},${scope.campaignId})`);
        await tx.execute(sql`INSERT INTO zoho_recruit_accounts VALUES
          (${a.tenantId},${s.accountRef},${a.id},${s.connectionRevision},now(),
           ${config.fingerprint},${sealed})`);
        await tx.execute(sql`INSERT INTO fixture_stage_source VALUES
          (${scope.campaignId},${s.sourceRevision})`);
      });
      await rules.propose(a, scope, {
        expectedRevision: s.sourceRevision,
        expectedRuleRevision: null,
        requestId: randomUUID(),
        confirm: true,
        evidence: {
          contractReference: "Synthetic-contract-report",
          isolationReference: "Synthetic-isolation-report",
          requirementsReference: "Synthetic-requirements-report",
          sideEffectsReference: "Synthetic-effects-report",
          requirements: "no_additional_fields_or_blueprint_actions",
          notifications: "no_automatic_messages_or_cross_application_changes",
        },
      });
      const rule = (await rules.view(b, scope)).currentRule!;
      await rules.act(b, scope, rule.id, {
        expectedRevision: rule.revision,
        requestId: randomUUID(),
        confirm: true,
        action: "verify",
        reviewReference: "Synthetic-independent-review",
      });
      const initial = await call();
      assert.equal(initial.status, 200, JSON.stringify(initial.body));
      const prepared = await call("", {
        expectedRevision: initial.body.handoffRevision,
        expectedRuleRevision: initial.body.ruleRevision,
        requestId: randomUUID(),
        confirm: true,
      });
      assert.equal(prepared.status, 200, JSON.stringify(prepared.body));
      actor = b;
      const request = prepared.body.requests[0];
      const approved = await call(`/${request.id}/actions`, {
        expectedRevision: request.revision,
        expectedRuleRevision: prepared.body.ruleRevision,
        requestId: randomUUID(),
        confirm: true,
        action: "approve",
      });
      assert.equal(approved.status, 200, JSON.stringify(approved.body));
      assert.equal(approved.body.requests[0].state, "approved");
    } else if (input.mode === "assembly-revoke") {
      await dbAdmin.execute(sql`UPDATE users SET status='suspended' WHERE id=${b.id}`);
    } else if (input.mode === "assembly-stale") {
      await dbAdmin.execute(sql`UPDATE fixture_stage_source SET revision=${"c".repeat(64)}
        WHERE campaign_id=${scope.campaignId}`);
    } else if (input.mode === "assembly-local") {
      const saved = (await baseLedger.list(a, scope))[0];
      const snapshot = { ...s, actor: a, proof: null };
      const local = zohoStageRequestStore();
      let request = (await local.list(a, scope)).find((r) => r.purpose === "local");
      if (!request) {
        request = await local.prepare(snapshot, randomUUID());
        await local.act(b, scope, request.requestId, request.revision, "approved");
      }
      // Refuse using the legacy request through the execution route.
      actor = c;
      const rejected = await call(`/${request.requestId}/actions`, {
        expectedRevision: request.revision,
        expectedRuleRevision: (await rules.view(c, scope)).currentRule!.revision,
        requestId: input.requestId,
        action: "execute",
        confirm: true,
      });
      assert.equal(rejected.status, 409);
      assert.equal(saved.purpose, "execution");
    } else if (
      ["assembly-propose-resolution", "assembly-approve-resolution"].includes(input.mode)
    ) {
      actor = input.mode === "assembly-propose-resolution" ? a : b;
      const saved = (await baseLedger.list(actor, scope)).find((r) => r.purpose === "execution")!;
      return {
        ...(await call(`/${saved.requestId}/resolution`, {
          expectedRevision: saved.revision,
          expectedSequence: saved.sequence,
          expectedSourceRevision: s.sourceRevision,
          commandId: input.requestId,
          action: input.mode === "assembly-propose-resolution" ? "propose" : "approve",
          reason: "Independently checked synthetic stage evidence before administrative closure.",
          evidenceReference: `synthetic-${input.mode}-reference`,
          confirm: true,
          acknowledgeUnknown: true,
          acknowledgeNoRetry: true,
        })),
        connections,
        requests,
      };
    } else if (["assembly-execute", "assembly-recover"].includes(input.mode)) {
      actor = c;
      const saved = (await baseLedger.list(c, scope)).find((r) => r.purpose === "execution")!;
      const rule = (await rules.view(c, scope)).currentRule!;
      return {
        ...(await call(`/${saved.requestId}/actions`, {
          expectedRevision: saved.revision,
          expectedRuleRevision: rule.revision,
          requestId: input.requestId,
          action: input.mode === "assembly-recover" ? "recover" : "execute",
          confirm: true,
        })),
        connections,
        requests,
      };
    }
    actor = c;
    const result = await call();
    const effects = (
      await dbAdmin.execute(sql`SELECT count(*)::int AS n
      FROM fixture_provider_effects WHERE recipient_id=${scope.recipientId}`)
    ).rows[0];
    return { ...result, effects: Number(effects.n), connections, requests };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
}
