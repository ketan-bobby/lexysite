import assert from "node:assert/strict";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { dbAdmin } from "@workspace/db";
import { zohoStageConnection } from "./zoho-stage-connection";
import { ZOHO_DATA_CENTERS, zohoDigest, type ZohoOAuthConfig } from "./zoho-oauth-provider";
import type { StageAuthorityContext } from "./zoho-stage-authority";
import { stageWriteRevision, type StageWriteSnapshot } from "./zoho-stage-write-core";
import { zohoStageExecution, type StageExecutionSource } from "./zoho-stage-execution";
import { zohoStageRequestStore } from "./zoho-stage-request-store";

function fixture(
  region: "us" | "in" = "us",
  transaction?: unknown,
  mode: "write" | "read_only" = "write",
) {
  const actor = { id: randomUUID(), tenantId: randomUUID() };
  const config: ZohoOAuthConfig = {
    clientId: "1000.SyntheticClient",
    clientSecret: "synthetic-client-secret",
    redirectUri: "https://fixture.invalid/api/zoho-recruit/callback",
    settingsUrl: "https://fixture.invalid/settings/ats",
    fingerprint: "a".repeat(64),
    region: ZOHO_DATA_CENTERS[region],
  };
  const accountRef = zohoDigest(`${config.region.api}|999`);
  const row = {
    tenantId: actor.tenantId,
    userId: "owner",
    approvedAt: new Date(500),
    refreshTokenEnc: "synthetic-ciphertext",
    accountRef,
    revision: "connection",
    fingerprint: config.fingerprint,
  };
  const context: StageAuthorityContext = {
    accountRef,
    connectionRevision: row.revision,
    externalCandidateId: "123",
    externalJobId: "456",
    applicationId: "789",
    candidateId: "local-candidate",
    campaignId: randomUUID(),
    recipientId: randomUUID(),
    tenantId: actor.tenantId,
    sourceEvidenceHash: "b".repeat(64),
    latestReviewId: "review",
    sourceConnectionRevision: "import-connection",
    mappingRevision: "mapping",
    custodyRevision: zohoDigest(row.refreshTokenEnc),
    configFingerprint: config.fingerprint,
  };
  const state = {
    consent: true,
    active: true,
    authority: true,
    held: false,
    clock: 1000,
    remoteCandidate: "123",
    remoteStatus: "New",
    primaryUser: "999",
    writeResult: "accepted",
    rotateDuringRefresh: false,
    beforeWrite: undefined as (() => Promise<void>) | undefined,
  };
  const calls: { url: string; init: RequestInit }[] = [];
  let storeReads = 0,
    fences = 0;
  const request: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal);
    if (url.startsWith(`${config.region.accounts}/oauth/v2/token`)) {
      assert(!state.held);
      if (state.rotateDuringRefresh) row.refreshTokenEnc = "rotated-synthetic-ciphertext";
      return Response.json({
        access_token: "synthetic-access",
        token_type: "Bearer",
        api_domain: config.region.api,
        expires_in: 3600,
      });
    }
    if (url === `${config.region.organization}/recruit/v2/org`) {
      assert(!state.held);
      return Response.json({
        org: [{ primary_userid: state.primaryUser, company_name: "Fixture" }],
      });
    }
    assert(state.held, "Application reads/writes must occur inside the authority fence");
    assert.equal(
      init.headers && (init.headers as Record<string, string>).Authorization,
      "Zoho-oauthtoken synthetic-access",
    );
    if (url.startsWith(`${config.region.organization}/recruit/v2/Applications/789?`))
      return Response.json({
        data: [
          {
            id: "789",
            $Job_Opening_Id: "456",
            $Candidate_Id: state.remoteCandidate,
            Application_Status: state.remoteStatus,
          },
        ],
      });
    assert.equal(url, `${config.region.organization}/recruit/v2/Candidates/status`);
    assert.equal(init.method, "PUT");
    await state.beforeWrite?.();
    state.remoteStatus = "Qualified";
    if (state.writeResult === "lost") throw Error("Synthetic lost response");
    return Response.json({
      data: [
        [
          {
            code: "SUCCESS",
            status: "success",
            details: { id: "123" },
          },
        ],
      ],
    });
  };
  type Deps = NonNullable<Parameters<typeof zohoStageConnection>[0]>;
  const service = zohoStageConnection({
    mode,
    config,
    store: {
      get: async () => {
        assert(!state.held, "No second-pool reads while the authority locks are held");
        storeReads++;
        return { ...row };
      },
    },
    actorLookup: async (id: string) => {
      if (!state.active) throw Error("Synthetic revoked staff");
      return { id, tenantId: actor.tenantId };
    },
    unseal: () =>
      JSON.stringify({
        purpose: "zoho-recruit",
        tenantId: actor.tenantId,
        userId: row.userId,
        accountRef,
        fingerprint: config.fingerprint,
        token: "synthetic-refresh",
        stageWrites: state.consent,
      }),
    authority: {
      fence: async <T>(
        _actor: unknown,
        c: StageAuthorityContext,
        work: (tx: unknown) => Promise<T>,
      ) => {
        assert.deepEqual(c, context);
        if (!state.authority) throw Error("Synthetic source/privacy authority loss");
        fences++;
        state.held = true;
        try {
          return await work(transaction ?? { synthetic: true });
        } finally {
          state.held = false;
        }
      },
    },
    request,
    now: () => state.clock,
  } as unknown as Deps);
  function snapshot(): StageWriteSnapshot {
    return {
      actor,
      scope: { campaignId: context.campaignId, recipientId: context.recipientId },
      binding: { applicationId: "789", candidateId: "123", jobId: "456" },
      accountRef,
      connectionRevision: row.revision,
      sourceRevision: "c".repeat(64),
      currentStatus: "New",
      targetStatus: "Qualified",
      targetStage: "Interview",
      decision: "advance",
      currentHumanDecision: true,
      writePermissionConfirmed: true,
      proof: {
        contract: "recruit-candidate-job-status-v2",
        evidenceReference: "synthetic-reviewed-contract",
        accountRef,
        connectionRevision: row.revision,
        applicationId: "789",
        candidateId: "123",
        jobId: "456",
        fromStatus: "New",
        toStatus: "Qualified",
        verifiedBy: "reviewer",
        verifiedAt: 500,
        expiresAt: 2000,
        employerWriteApproved: true,
        applicationTransitionVerified: true,
        sideEffectsReviewed: true,
      },
    };
  }
  return {
    service,
    actor,
    context,
    row,
    state,
    calls,
    snapshot,
    counts: () => ({
      storeReads,
      fences,
      writes: calls.filter((c) => c.init.method === "PUT").length,
    }),
  };
}

for (const region of ["us", "in"] as const)
  test(`connected stage transport pins ${region} custody, exact application and one write inside the fence`, async () => {
    const f = fixture(region);
    const c = await f.service.connect(f.actor, f.context);
    assert.equal(f.calls.length, 2, "Connect performs OAuth/org checks only, not candidate reads");
    await assert.rejects(c.provider.read(f.snapshot().binding));
    await assert.rejects(c.provider.change(f.snapshot()));
    await c.fence(async () => {
      assert.equal((await c.provider.read(f.snapshot().binding)).currentStatus, "New");
      assert.equal(await c.provider.change(f.snapshot()), "accepted");
      assert.equal((await c.provider.read(f.snapshot().binding)).currentStatus, "Qualified");
      await assert.rejects(c.provider.change(f.snapshot()));
    });
    await assert.rejects(
      c.provider.read(f.snapshot().binding),
      "Leaked provider is unusable after fence closure",
    );
    assert.equal(f.counts().writes, 1);
    const write = f.calls.find((r) => r.init.method === "PUT")!;
    assert.deepEqual(JSON.parse(String(write.init.body)), {
      data: [
        {
          ids: ["123"],
          jobids: ["456"],
          Candidate_Status: "Qualified",
          comments: "Human-approved Lexy application-stage handoff.",
        },
      ],
    });
    assert(!JSON.stringify(c).includes("synthetic-access"));
    assert(!JSON.stringify(c).includes("synthetic-refresh"));
  });

test("read-only or mismatched custody is rejected before OAuth or application I/O", async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.state.consent = false;
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.tenantId = "foreign";
    },
    (f: ReturnType<typeof fixture>) => {
      f.context.custodyRevision = "0".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.revision = "rotated";
    },
    (f: ReturnType<typeof fixture>) => {
      f.row.fingerprint = "d".repeat(64);
    },
    (f: ReturnType<typeof fixture>) => {
      f.state.active = false;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(f.service.connect(f.actor, f.context));
    assert.equal(f.calls.length, 0);
  }
});

test("recovery mode permits scoped reads without write consent and cannot be upgraded by a proof", async () => {
  for (const consent of [false, true]) {
    const f = fixture("us", undefined, "read_only");
    f.state.consent = consent;
    const c = await f.service.connect(f.actor, f.context);
    await c.fence(async () => {
      assert.equal((await c.provider.read(f.snapshot().binding)).currentStatus, "New");
      assert.equal(await c.provider.change(f.snapshot()), "rejected");
      assert.equal(
        await c.provider.change({ ...f.snapshot(), writePermissionConfirmed: true }),
        "rejected",
      );
    });
    assert.equal(f.counts().writes, 0);
    await assert.rejects(c.provider.read(f.snapshot().binding));
  }
});

test("rotation during refresh and foreign provider organization cannot obtain a stage connection", async () => {
  for (const mode of ["rotate", "foreign"]) {
    const f = fixture();
    if (mode === "rotate") f.state.rotateDuringRefresh = true;
    else f.state.primaryUser = "998";
    await assert.rejects(f.service.connect(f.actor, f.context));
    assert.equal(f.counts().writes, 0);
    assert(!f.calls.some((r) => r.url.includes("/Applications/")));
  }
});

test("revoked staff, replaced custody and rejected SQL authority cannot start fenced I/O", async () => {
  for (const mode of ["staff", "custody", "approval", "authority"]) {
    const f = fixture();
    const c = await f.service.connect(f.actor, f.context);
    if (mode === "staff") f.state.active = false;
    if (mode === "custody") f.row.refreshTokenEnc = "rotated";
    if (mode === "approval") f.row.approvedAt = new Date(501);
    if (mode === "authority") f.state.authority = false;
    await assert.rejects(c.fence(() => c.provider.change(f.snapshot())));
    assert.equal(f.calls.length, 2, mode);
  }
});

test("foreign snapshots, absent proof, expired proof and restricted outcomes cannot write", async () => {
  for (const mode of ["actor", "scope", "application", "proof", "expired", "offer"]) {
    const f = fixture();
    const c = await f.service.connect(f.actor, f.context);
    const s = structuredClone(f.snapshot());
    if (mode === "actor") s.actor.id = "foreign";
    if (mode === "scope") s.scope.recipientId = "foreign";
    if (mode === "application") s.binding.applicationId = "790";
    if (mode === "proof") s.proof = null;
    if (mode === "expired") f.state.clock = 2001;
    if (mode === "offer") s.targetStage = "Offer";
    await c.fence(async () => {
      if (["actor", "scope", "application"].includes(mode))
        await assert.rejects(c.provider.change(s));
      else assert.equal(await c.provider.change(s), "rejected");
    });
    assert.equal(f.counts().writes, 0, mode);
  }
});

test("wrong remote identity and lost responses fail closed without a second write", async () => {
  const f = fixture();
  const c = await f.service.connect(f.actor, f.context);
  await c.fence(async () => {
    f.state.remoteCandidate = "124";
    await assert.rejects(c.provider.read(f.snapshot().binding));
    f.state.remoteCandidate = "123";
    f.state.writeResult = "lost";
    assert.equal(await c.provider.change(f.snapshot()), "uncertain");
    await assert.rejects(c.provider.change(f.snapshot()));
  });
  assert.equal(f.counts().writes, 1);
});

test("another connection cannot borrow a fence and nested fences do not reacquire SQL locks", async () => {
  const f = fixture(),
    other = fixture();
  const c = await f.service.connect(f.actor, f.context);
  const second = await other.service.connect(other.actor, other.context);
  await c.fence(async () => {
    await assert.rejects(second.provider.read(other.snapshot().binding));
    await assert.rejects(c.fence(async () => undefined));
  });
  assert.equal(f.counts().fences, 1);
  assert.equal(other.counts().fences, 0);
});

test("connected OAuth transport composes with approval, private SQL claim, replay and read-only recovery", async () => {
  const rollback = Error("rollback-connected-stage-fixture");
  await assert.rejects(
    dbAdmin.transaction(async (tx) => {
      const [identity] = (
        await tx.execute(sql`
      SELECT current_database() AS name, inet_server_addr() AS host
    `)
      ).rows;
      assert.equal(identity.name, "heliumdb");
      assert.equal(identity.host, null, "Only verified local development PostgreSQL is allowed");
      await tx.execute(sql`CREATE TEMP TABLE audit_logs
      (LIKE public.audit_logs INCLUDING ALL) ON COMMIT DROP`);
      await tx.execute(sql`SET LOCAL search_path = pg_temp,pg_catalog`);
      for (const mode of ["accepted", "lost"]) {
        const f = fixture("us", tx);
        f.state.writeResult = mode;
        const c = await f.service.connect(f.actor, f.context);
        const snapshot = f.snapshot();
        const scope = snapshot.scope;
        const ledger = zohoStageRequestStore(tx as unknown as typeof dbAdmin);
        f.state.beforeWrite = async () => {
          const rows = await ledger.list(f.actor, scope, tx);
          assert.equal(rows[0].state, "claimed", "A SQL claim must precede HTTP dispatch");
        };
        const source: StageExecutionSource = {
          current: async () => structuredClone(snapshot),
          fence: async (_actor, _scope, work) =>
            c.fence(async (handle) => work(structuredClone(snapshot), handle)),
        };
        const dependencies = {
          source,
          provider: c.provider,
          ledger,
          now: () => f.state.clock,
        };
        const service = zohoStageExecution(dependencies);
        const command = {
          expectedRevision: stageWriteRevision(snapshot),
          requestId: randomUUID(),
          confirm: true as const,
        };
        const prepared = await service.prepare(f.actor, scope, command);
        await assert.rejects(service.execute(f.actor, scope, prepared.requestId, command));
        assert.equal(f.counts().writes, 0, "Preparation alone cannot dispatch");
        await service.approve(f.actor, scope, prepared.requestId, command);
        assert.equal(f.counts().writes, 0, "Approval alone cannot dispatch");
        const result = await service.execute(f.actor, scope, prepared.requestId, command);
        assert.equal(result.attempt?.state, mode === "accepted" ? "verified" : "review_required");
        const reconstructed = zohoStageExecution(dependencies);
        await reconstructed.execute(f.actor, scope, prepared.requestId, command);
        assert.equal(f.counts().writes, 1, "Replay through a new assembly cannot resend");
        if (mode === "lost") {
          const recovered = await reconstructed.recover(f.actor, scope, prepared.requestId);
          assert.equal(recovered.state, "observed_target");
          assert.equal(f.counts().writes, 1, "Recovery observes only");
        }
      }
      throw rollback;
    }),
    (error: unknown) => error === rollback,
  );
});
