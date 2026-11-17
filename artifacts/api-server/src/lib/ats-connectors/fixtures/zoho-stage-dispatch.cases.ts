import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import express from "express";
import { sql } from "drizzle-orm";
import { dbAdmin } from "@workspace/db";
import { zohoStageDispatch } from "../zoho-stage-dispatch";
import { zohoStageRules } from "../zoho-stage-rules";
import { zohoStageRequestStore } from "../zoho-stage-request-store";
import { zohoStageRequests } from "../zoho-stage-requests";
import { zohoStageConnection } from "../zoho-stage-connection";
import { zohoStageAuthority } from "../zoho-stage-authority";
import { zohoDigest, zohoOAuthProvider, ZOHO_DATA_CENTERS } from "../zoho-oauth-provider";
import { zohoRecruitAccountRouter } from "../../../routes/zoho-recruit-account";
import type { CampaignTx } from "../zoho-interview-campaigns";
import type { StageWriteActor, StageWriteScope } from "../zoho-stage-write-core";
import { registerStageResolutionCases } from "./zoho-stage-resolution.cases";

type Fixture = {
  a: StageWriteActor;
  b: StageWriteActor;
  c: StageWriteActor;
  scope: StageWriteScope;
  h: {
    revision: string;
    applicationId: string;
    externalCandidateId: string;
    externalJobId: string;
    targetStatus: string;
  };
  permission: {
    custodyRevision: string;
    configFingerprint: string;
    connectionRevision: string;
    writeConsentSaved: boolean;
  };
  service: ReturnType<typeof zohoStageRules>;
  dependencies: unknown;
  inside: boolean;
  at: number;
  visible: boolean;
  sourceAllowed: boolean;
  currentStatus: string;
  propose: () => Promise<unknown>;
  verify: () => Promise<unknown>;
};

/** Runs inside the existing verified-development, private rollback-only fixture.
 * Real rule loader, SQL journal, connected transport, executor and HTTP router;
 * only upstream Zoho and the outer source-row fixture are simulated. */
export async function registerStageDispatchCases(
  t: TestContext,
  create: () => Promise<Fixture>,
  tx: CampaignTx,
) {
  async function setup() {
    const f = await create(),
      sealed = "synthetic-stage-dispatch-custody";
    f.permission.custodyRevision = zohoDigest(sealed);
    const database = {
      select: tx.select.bind(tx),
      insert: tx.insert.bind(tx),
      transaction: async <T>(work: (handle: CampaignTx) => Promise<T>) => work(tx),
    } as unknown as typeof dbAdmin;
    const ledger = zohoStageRequestStore(database, "execution");
    const localLedger = zohoStageRequestStore(database);
    let enabled = false,
      writes = 0,
      reads = 0,
      connections = 0,
      remoteStatus = "Associated",
      lost = false,
      foreign = false;
    let onRead: (() => void) | undefined;
    const dependencies = f.dependencies as NonNullable<Parameters<typeof zohoStageRules>[0]>;
    const config = {
      region: ZOHO_DATA_CENTERS.us,
      clientId: "1000.Synthetic",
      clientSecret: "synthetic-not-a-secret",
      redirectUri: "https://fixture.invalid/callback",
      settingsUrl: "https://fixture.invalid/settings/ats",
      fingerprint: f.permission.configFingerprint,
    };
    const connectionFactory: typeof zohoStageConnection = (options = {}) => {
      connections++;
      return zohoStageConnection({
        config,
        now: () => f.at,
        store: {
          get: async () => {
            assert(!f.inside, "no second-pool custody reads under the SQL source fence");
            return {
              tenantId: f.a.tenantId,
              userId: f.a.id,
              approvedAt: new Date(500),
              refreshTokenEnc: sealed,
              accountRef: "a".repeat(64),
              revision: f.permission.connectionRevision,
              fingerprint: config.fingerprint,
            };
          },
        } as unknown as NonNullable<Parameters<typeof zohoStageConnection>[0]>["store"],
        actorLookup: async (id) => {
          assert(!f.inside);
          assert(id);
          const result = await tx.execute(sql`SELECT id FROM users WHERE id=${id}
            AND tenant_id=${f.a.tenantId} AND status='active' AND role='tenant_admin'
            AND account_erased_at IS NULL`);
          assert.equal(result.rows.length, 1);
          return { id, tenantId: f.a.tenantId };
        },
        unseal: () =>
          JSON.stringify({
            purpose: "zoho-recruit",
            tenantId: f.a.tenantId,
            userId: f.a.id,
            accountRef: "a".repeat(64),
            fingerprint: config.fingerprint,
            token: "synthetic-refresh",
            stageWrites: f.permission.writeConsentSaved,
          }),
        providerFactory: (config, request) => ({
          ...zohoOAuthProvider(config, request),
          refresh: async () => {
            assert(!f.inside);
            return "synthetic-access";
          },
          organization: async () => {
            assert(!f.inside);
            return { accountRef: "a".repeat(64), companyName: "Fixture" };
          },
        }),
        request: async (input, init = {}) => {
          assert(f.inside, "application reads and writes must share the verified-rule SQL fence");
          const url = String(input);
          if (init.method !== "PUT") {
            assert(url.includes(`/Applications/${f.h.applicationId}?`));
            reads++;
            onRead?.();
            return Response.json({
              data: [
                {
                  id: f.h.applicationId,
                  $Job_Opening_Id: f.h.externalJobId,
                  $Candidate_Id: foreign ? "999999" : f.h.externalCandidateId,
                  Application_Status: remoteStatus,
                },
              ],
            });
          }
          assert.equal(url, "https://recruit.zoho.com/recruit/v2/Candidates/status");
          assert.deepEqual(JSON.parse(String(init.body)).data[0].ids, [f.h.externalCandidateId]);
          assert.deepEqual(JSON.parse(String(init.body)).data[0].jobids, [f.h.externalJobId]);
          assert.equal((await ledger.list(f.c, f.scope, tx))[0].state, "claimed");
          writes++;
          remoteStatus = f.h.targetStatus;
          f.currentStatus = remoteStatus;
          if (lost) throw Error("synthetic accepted effect with lost reply");
          return Response.json({
            data: [
              [{ code: "SUCCESS", status: "success", details: { id: f.h.externalCandidateId } }],
            ],
          });
        },
        authority: zohoStageAuthority({
          authority: dependencies.authority,
          assertCurrent: dependencies.assertSourceCurrent,
        }),
        ...options,
      });
    };
    const recovery = zohoStageRequests({
      ...dependencies,
      ledger,
      recoveryConnections: connectionFactory({ mode: "read_only" }),
    } as NonNullable<Parameters<typeof zohoStageRequests>[0]>);
    const service = zohoStageDispatch({
      rules: f.service,
      ledger,
      recovery,
      connectionFactory,
      enabled: () => enabled,
      now: () => f.at,
    });
    const ready = async () => {
      await f.propose();
      await f.verify();
    };
    const prepare = async () => {
      const w = await service.view(f.a, f.scope);
      return service.prepare(f.a, f.scope, {
        expectedRevision: w.handoffRevision,
        expectedRuleRevision: w.ruleRevision!,
        requestId: randomUUID(),
        confirm: true,
      });
    };
    const approve = async () => {
      const w = await prepare(),
        row = w.requests[0];
      return service.act(f.b, f.scope, row.id, {
        action: "approve",
        expectedRevision: row.revision,
        expectedRuleRevision: w.ruleRevision,
        requestId: randomUUID(),
        confirm: true,
      });
    };
    const command = (
      w: Awaited<ReturnType<typeof service.view>>,
      action: "approve" | "execute" | "withdraw" | "recover" = "execute",
    ) => ({
      expectedRevision: w.requests[0].revision,
      expectedRuleRevision: w.ruleRevision,
      requestId: randomUUID(),
      confirm: true as const,
      action,
    });
    return {
      f,
      service,
      ledger,
      localLedger,
      ready,
      prepare,
      approve,
      command,
      enable: () => {
        enabled = true;
      },
      lost: () => {
        lost = true;
      },
      foreign: () => {
        foreign = true;
      },
      remote: (status: string) => {
        remoteStatus = status;
      },
      disable: () => {
        enabled = false;
      },
      onRead: (callback: () => void) => {
        onRead = callback;
      },
      counts: () => ({ writes, reads, connections }),
    };
  }
  await registerStageResolutionCases(t, setup, tx);
  await t.test(
    "preparation replay is local and cannot describe an existing approval as a new request",
    async () => {
      const h = await setup();
      await h.ready();
      const w = await h.service.view(h.f.a, h.f.scope);
      const input = {
        expectedRevision: w.handoffRevision,
        expectedRuleRevision: w.ruleRevision!,
        requestId: randomUUID(),
        confirm: true as const,
      };
      const first = await h.service.prepare(h.f.a, h.f.scope, input),
        before = h.counts();
      assert(!first.canPrepare);
      const repeated = await h.service.prepare(h.f.a, h.f.scope, input);
      assert.equal(repeated.requests[0].id, first.requests[0].id);
      assert.deepEqual(h.counts(), before);
      await assert.rejects(
        h.prepare(),
        "a different command must not present the same approval as new",
      );
      await h.service.act(h.f.b, h.f.scope, first.requests[0].id, h.command(first, "approve"));
      assert(!(await h.service.view(h.f.c, h.f.scope)).canPrepare);
      assert.equal(h.counts().writes, 0);
    },
  );
  await t.test(
    "dispatch GET is local; unverified evidence cannot prepare; preparation and approval never send",
    async () => {
      const h = await setup(),
        before = h.counts();
      const w = await h.service.view(h.f.a, h.f.scope);
      assert(!w.canPrepare);
      assert.deepEqual(h.counts(), before);
      await assert.rejects(h.prepare());
      assert.deepEqual(h.counts(), before);
      await h.ready();
      const approved = await h.approve();
      assert.equal(approved.requests[0].state, "approved");
      assert(!approved.liveEnabled);
      assert.equal(h.counts().writes, 0);
      const count = h.counts();
      await assert.rejects(
        h.service.act(h.f.c, h.f.scope, approved.requests[0].id, h.command(approved)),
      );
      assert.deepEqual(h.counts(), count, "disabled execution makes no provider calls");
    },
  );
  await t.test(
    "assembled dispatch uses one verified SQL fence, real transport and distinct current staff",
    async () => {
      const h = await setup();
      await h.ready();
      const w = await h.approve();
      h.enable();
      const input = h.command(w),
        id = w.requests[0].id;
      const result = await h.service.act(h.f.c, h.f.scope, id, input);
      assert.equal(result.requests[0].state, "verified");
      assert.equal(h.counts().writes, 1);
      assert.equal(result.requests[0].preparedBy, h.f.a.id);
      assert.equal(result.requests[0].approvedBy, h.f.b.id);
      const before = h.counts();
      await h.service.act(h.f.c, h.f.scope, id, input);
      assert.deepEqual(
        h.counts(),
        before,
        "exact replay never refreshes credentials or reads/writes Zoho",
      );
      const attempts = (
        await tx.execute(sql`SELECT actor_id FROM audit_logs WHERE subject_id=${h.f.scope.recipientId}
      AND metadata->>'state' IN ('claimed','provider_accepted','verified')`)
      ).rows;
      assert.equal(attempts.length, 3);
      assert(attempts.every((r) => r.actor_id === h.f.c.id));
    },
  );
  await t.test(
    "local approvals cannot promote execution requests or borrow execution permission",
    async () => {
      const h = await setup();
      await h.ready();
      const w = await h.prepare(),
        row = w.requests[0];
      await assert.rejects(
        h.localLedger.act(h.f.b, h.f.scope, row.id, row.revision, "approved", tx),
      );
      const saved = (await h.ledger.list(h.f.a, h.f.scope, tx))[0];
      assert.equal(saved.state, "prepared");
      assert.equal(saved.purpose, "execution");
      const loaded = await h.f.service.withVerifiedRule(
        h.f.a,
        h.f.scope,
        w.ruleRevision!,
        async (e) => e.snapshot,
      );
      const local = await h.localLedger.prepare({ ...loaded, proof: null }, randomUUID(), tx);
      await h.localLedger.act(h.f.a, h.f.scope, local.requestId, local.revision, "approved", tx);
      h.enable();
      await assert.rejects(
        h.service.act(h.f.c, h.f.scope, local.requestId, {
          ...h.command(w),
          expectedRevision: local.revision,
        }),
      );
      assert.equal(h.counts().writes, 0);
    },
  );
  await t.test(
    "revoked or stale evidence cannot approve or execute a prepared request",
    async () => {
      for (const mutation of ["revoke", "source", "reviewer"]) {
        const h = await setup();
        await h.ready();
        const w = await h.approve();
        h.enable();
        if (mutation === "revoke") {
          const r = await h.f.service.view(h.f.b, h.f.scope);
          await h.f.service.act(h.f.b, h.f.scope, r.currentRule!.id, {
            expectedRevision: r.currentRule!.revision,
            requestId: randomUUID(),
            action: "revoke",
            confirm: true,
          });
        } else if (mutation === "source") h.f.h.revision = "c".repeat(64);
        else await tx.execute(sql`UPDATE users SET status='suspended' WHERE id=${h.f.b.id}`);
        await assert.rejects(h.service.act(h.f.c, h.f.scope, w.requests[0].id, h.command(w)));
        assert.equal(h.counts().writes, 0);
        await h.service.act(h.f.c, h.f.scope, w.requests[0].id, h.command(w, "withdraw"));
        assert.equal((await h.ledger.list(h.f.c, h.f.scope, tx))[0].state, "withdrawn");
      }
    },
  );
  await t.test(
    "expiry during application preflight and wrong provider identity prevent the stage write",
    async () => {
      for (const mutation of ["expiry", "identity"]) {
        const h = await setup();
        await h.ready();
        const w = await h.approve();
        h.enable();
        if (mutation === "expiry")
          h.onRead(() => {
            h.f.at += 16 * 60_000;
          });
        else h.foreign();
        const result = await h.service.act(h.f.c, h.f.scope, w.requests[0].id, h.command(w));
        assert.equal(result.requests[0].state, "not_sent");
        assert.equal(h.counts().writes, 0);
      }
    },
  );
  await t.test(
    "lost replies stay held; read-only recovery works without fresh evidence, write consent or live activation",
    async () => {
      const h = await setup();
      await h.ready();
      const w = await h.approve();
      h.enable();
      h.lost();
      const input = h.command(w),
        id = w.requests[0].id;
      const result = await h.service.act(h.f.c, h.f.scope, id, input);
      assert.equal(result.requests[0].state, "review_required");
      assert(!result.canPrepare);
      h.disable();
      h.f.at += 16 * 60_000;
      h.f.permission.writeConsentSaved = false;
      const recovered = await h.service.act(h.f.c, h.f.scope, id, h.command(result, "recover"));
      assert.equal(recovered.requests[0].state, "observed_target");
      assert.equal(h.counts().writes, 1);
      assert(!recovered.canPrepare);
    },
  );
  await t.test("disabling execution during preflight blocks the provider write", async () => {
    const h = await setup();
    await h.ready();
    const w = await h.approve();
    h.enable();
    h.onRead(() => h.disable());
    const result = await h.service.act(h.f.c, h.f.scope, w.requests[0].id, h.command(w));
    assert.equal(h.counts().writes, 0);
    assert(!result.liveEnabled);
    assert.equal(result.requests[0].state, "review_required");
  });
  await t.test(
    "older local-purpose unresolved claims also hold the execution workflow",
    async () => {
      const h = await setup();
      await h.ready();
      const w = await h.service.view(h.f.a, h.f.scope);
      const snapshot = await h.f.service.withVerifiedRule(
        h.f.a,
        h.f.scope,
        w.ruleRevision!,
        async (e) => e.snapshot,
      );
      const row = await h.localLedger.prepare(snapshot, randomUUID(), tx);
      await h.localLedger.act(h.f.a, h.f.scope, row.requestId, row.revision, "approved", tx);
      const deliberate = await h.ledger.prepare(snapshot, randomUUID(), tx);
      assert.notEqual(
        deliberate.requestId,
        row.requestId,
        "matching content cannot carry over local approval",
      );
      assert.equal(deliberate.state, "prepared");
      await assert.rejects(
        h.ledger.asWriterStore(snapshot.binding, h.f.a).claim(snapshot, {
          expectedRevision: deliberate.revision,
          requestId: randomUUID(),
          confirm: true,
        }),
      );
      await h.ledger.act(
        h.f.b,
        h.f.scope,
        deliberate.requestId,
        deliberate.revision,
        "approved",
        tx,
      );
      await h.localLedger.asWriterStore(snapshot.binding, h.f.a).claim(snapshot, {
        expectedRevision: row.revision,
        requestId: randomUUID(),
        confirm: true,
      });
      await assert.rejects(
        h.ledger.asWriterStore(snapshot.binding, h.f.a).claim(snapshot, {
          expectedRevision: deliberate.revision,
          requestId: randomUUID(),
          confirm: true,
        }),
      );
      assert(!(await h.service.view(h.f.c, h.f.scope)).canPrepare);
      await assert.rejects(h.prepare());
      assert.equal(h.counts().writes, 0);
    },
  );
  await t.test(
    "a journal cannot relabel an earlier local approval as execution purpose",
    async () => {
      const h = await setup();
      await h.ready();
      const w = await h.service.view(h.f.a, h.f.scope);
      const snapshot = await h.f.service.withVerifiedRule(
        h.f.a,
        h.f.scope,
        w.ruleRevision!,
        async (e) => e.snapshot,
      );
      const row = await h.localLedger.prepare(snapshot, randomUUID(), tx);
      await h.localLedger.act(h.f.a, h.f.scope, row.requestId, row.revision, "approved", tx);
      await tx.execute(sql`UPDATE audit_logs SET metadata=jsonb_set(metadata,'{purpose}','"execution"'::jsonb)
      WHERE subject_id=${h.f.scope.recipientId} AND metadata->>'state'='approved'`);
      await assert.rejects(h.ledger.list(h.f.a, h.f.scope, tx));
      assert.equal(h.counts().writes, 0);
    },
  );
  await t.test(
    "offer and employment outcomes cannot be sent through the stage executor",
    async () => {
      for (const status of ["Offer", "Hired", "Onboarding"]) {
        const h = await setup();
        h.f.h.targetStatus = status;
        await h.ready();
        h.enable();
        await assert.rejects(h.prepare());
        assert.equal(h.counts().writes, 0);
      }
    },
  );
  await t.test(
    "execution routes validate strict bodies and scope before any connected operation",
    async () => {
      const h = await setup(),
        app = express();
      app.use(express.json());
      let actor = h.f.a;
      app.use(
        zohoRecruitAccountRouter(
          { actor: async () => actor } as unknown as NonNullable<
            Parameters<typeof zohoRecruitAccountRouter>[0]
          >,
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
          () => h.service,
        ),
      );
      const server = app.listen(0, "127.0.0.1");
      await new Promise<void>((resolve) => server.once("listening", resolve));
      try {
        const address = server.address();
        assert(address && typeof address !== "string");
        const url = `http://127.0.0.1:${address.port}/zoho-recruit/campaigns/${h.f.scope.campaignId}/recipients/${h.f.scope.recipientId}/stage-execution`;
        const initial = await fetch(url);
        assert.equal(initial.status, 200);
        assert.equal(initial.headers.get("cache-control"), "no-store");
        assert.equal(((await initial.json()) as { liveEnabled: boolean }).liveEnabled, false);
        for (const extra of [{ confirm: false }, { proof: {} }, { enabled: true }]) {
          const response = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              expectedRevision: h.f.h.revision,
              expectedRuleRevision: "a".repeat(64),
              requestId: randomUUID(),
              confirm: true,
              ...extra,
            }),
          });
          assert.equal(response.status, 400);
        }
        actor = { ...actor, tenantId: randomUUID() };
        assert.equal((await fetch(url)).status, 404);
        assert.equal(h.counts().writes, 0);
        assert.equal(h.counts().reads, 0);
        actor = h.f.a;
        await h.ready();
        const workspace = await h.service.view(actor, h.f.scope);
        const post = async (path: string, body: unknown) =>
          fetch(path, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          });
        const prepared = await post(url, {
          expectedRevision: workspace.handoffRevision,
          expectedRuleRevision: workspace.ruleRevision,
          requestId: randomUUID(),
          confirm: true,
        });
        assert.equal(prepared.status, 200);
        const p = (await prepared.json()) as Awaited<ReturnType<typeof h.service.view>>;
        assert.equal(p.requests[0].canApprove, true);
        actor = h.f.b;
        const path = `${url}/${p.requests[0].id}/actions`;
        assert.equal((await post(path, h.command(p, "approve"))).status, 200);
        const approved = await h.service.view(actor, h.f.scope),
          input = h.command(approved);
        actor = h.f.c;
        assert.equal((await post(path, input)).status, 409);
        h.enable();
        const completed = await post(path, input);
        assert.equal(completed.status, 200);
        const done = (await completed.json()) as Awaited<ReturnType<typeof h.service.view>>;
        assert.equal(done.requests[0].state, "verified");
        assert.equal(done.requests[0].canExecute, false);
        assert.equal(h.counts().writes, 1);
      } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    },
  );
}
