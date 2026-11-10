import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import express from "express";
import { CalendarError } from "../outlook-calendar-core";
import { fingerprint } from "../recruiting-workflows";
import { stageWriteRevision, type StageWriteSnapshot } from "./zoho-stage-write-core";
import { zohoStageRequests } from "./zoho-stage-requests";
import { zohoStagePermission } from "./zoho-stage-permission";
import { zohoConsent, zohoOAuthConfig } from "./zoho-oauth-provider";
import { zohoRecruitAccountRouter } from "../../routes/zoho-recruit-account";
import type { StageRequestRecord } from "./zoho-stage-request-store";

const actor = { id: randomUUID(), tenantId: randomUUID() };
const scope = { campaignId: randomUUID(), recipientId: randomUUID() };
function fixture() {
  const h = {
    revision: "b".repeat(64),
    ready: true,
    decision: "advance",
    targetStatus: "In Review",
    applicationId: "300",
    externalCandidateId: "200",
    externalJobId: "100",
    mapping: { revision: randomUUID() },
  };
  let connectionRevision: string | null = "connection";
  let writeConsentSaved = false;
  let currentStatus = "Associated";
  let metadataResult = "matched";
  let reads = 0,
    writes = 0,
    fences = 0;
  let afterRead: (() => void) | null = null;
  let fenceAllowed = true;
  let insideFence = false;
  const readLocks: boolean[] = [];
  const rows: StageRequestRecord[] = [];
  const deps = {
    handoff: { detail: async () => structuredClone(h) },
    reviews: {
      noteContext: async () => ({
        tenantId: actor.tenantId,
        ...scope,
        candidateId: "local-candidate",
        accountRef: "a".repeat(64),
        connectionRevision: "connection",
        externalJobId: h.externalJobId,
        externalCandidateId: h.externalCandidateId,
        applicationId: h.applicationId,
        sourceEvidenceHash: "c".repeat(64),
        latestReviewId: "review",
      }),
    },
    permissions: {
      check: async () => ({
        connectionRevision,
        writeConsentSaved,
        custodyRevision: "d".repeat(64),
        configFingerprint: "e".repeat(64),
      }),
    },
    assertSourceCurrent: async () => {},
    validation: {
      check: async () => {
        reads++;
        readLocks.push(insideFence);
        const result = {
          currentApplicationStatus: currentStatus,
          mappings: [{ decision: "advance", targetStatus: h.targetStatus, result: metadataResult }],
        };
        afterRead?.();
        return result;
      },
    },
    authority: {
      fence: async (_a: unknown, _c: unknown, work: (tx: unknown) => unknown) => {
        fences++;
        insideFence = true;
        try {
          return await work({
            execute: async () => ({ rows: fenceAllowed ? [{ id: "local-candidate" }] : [] }),
            select: () => ({
              from: () => ({
                where: () => ({ for: async () => [{ revision: h.mapping.revision }] }),
              }),
            }),
          });
        } finally {
          insideFence = false;
        }
      },
    },
    ledger: {
      list: async () => structuredClone(rows),
      prepare: async (s: StageWriteSnapshot, prepareRequestId: string) => {
        writes++;
        const { binding, proof: _proof, ...rest } = s;
        const row: StageRequestRecord = {
          version: 1,
          campaignId: scope.campaignId,
          requestId: randomUUID(),
          sequence: 1,
          state: "prepared",
          revision: stageWriteRevision(s),
          prepareRequestId,
          executionRequestId: null,
          snapshot: { ...rest, proof: null, bindingHash: fingerprint(binding) },
          approvedBy: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        rows.unshift(row);
        return row;
      },
      act: async (
        _a: unknown,
        _s: unknown,
        id: string,
        _r: string,
        state: "approved" | "withdrawn",
      ) => {
        writes++;
        const row = rows.find((r) => r.requestId === id)!;
        row.state = state;
        row.approvedBy = state === "approved" ? actor.id : row.approvedBy;
        return row;
      },
      asWriterStore: () => {
        return {
          get: async (_a: unknown, _s: unknown, id: string) => {
            const row = rows.find((r) => r.requestId === id);
            if (!row?.executionRequestId) return null;
            const { bindingHash: _hash, ...snapshot } = row.snapshot;
            return {
              id,
              revision: row.revision,
              requestId: row.executionRequestId,
              state: row.state,
              snapshot: {
                ...snapshot,
                binding: {
                  applicationId: h.applicationId,
                  candidateId: h.externalCandidateId,
                  jobId: h.externalJobId,
                },
              },
            };
          },
          record: async (attempt: { id: string }, state: StageRequestRecord["state"]) => {
            assert.equal(insideFence, true);
            writes++;
            rows.find((r) => r.requestId === attempt.id)!.state = state;
            return { ...attempt, state };
          },
        };
      },
    },
  } as unknown as NonNullable<Parameters<typeof zohoStageRequests>[0]>;
  return {
    service: zohoStageRequests(deps),
    h,
    rows,
    readLocks,
    stats: () => ({ reads, writes, fences }),
    change: (values: {
      connection?: string | null;
      consent?: boolean;
      status?: string;
      match?: string;
      after?: () => void;
      fenceAllowed?: boolean;
    }) => {
      if ("connection" in values) connectionRevision = values.connection!;
      if ("consent" in values) writeConsentSaved = values.consent!;
      if ("status" in values) currentStatus = values.status!;
      if ("match" in values) metadataResult = values.match!;
      if ("after" in values) afterRead = values.after!;
      if ("fenceAllowed" in values) fenceAllowed = values.fenceAllowed!;
    },
  };
}
test("stage request GET is local, explicit prepare/approve save records, approval never dispatches", async () => {
  const f = fixture();
  const view = await f.service.view(actor, scope);
  assert.equal(view.canPrepare, true);
  assert.equal(view.writeConsentSaved, false);
  assert.equal(view.liveEnabled, false);
  assert.equal(view.blocker, "employer_write_consent_required");
  assert.deepEqual(f.stats(), { reads: 0, writes: 0, fences: 0 });
  const prepared = await f.service.prepare(actor, scope, {
    expectedRevision: f.h.revision,
    requestId: randomUUID(),
    confirm: true,
  });
  const row = prepared.requests[0];
  assert.equal(row.state, "prepared");
  const approved = await f.service.act(actor, scope, row.id, {
    expectedRevision: row.revision,
    action: "approve",
    confirm: true,
  });
  assert.equal(approved.requests[0].state, "approved");
  assert.equal(approved.liveEnabled, false);
  assert.equal(approved.transitionVerified, false);
  assert.deepEqual(f.stats(), { reads: 2, writes: 2, fences: 2 });
  await f.service.act(actor, scope, row.id, {
    expectedRevision: row.revision,
    action: "withdraw",
    confirm: true,
  });
  assert.equal(f.stats().reads, 2, "withdrawal does not contact Zoho");
});
for (const failure of [
  "stale",
  "not-ready",
  "disconnected",
  "restricted",
  "missing",
  "changed-during-read",
] as const) {
  test(`stage preparation rejects ${failure} without saving`, async () => {
    const f = fixture();
    const expectedRevision = f.h.revision;
    if (failure === "stale") f.h.revision = "e".repeat(64);
    if (failure === "not-ready") f.h.ready = false;
    if (failure === "disconnected") f.change({ connection: null });
    if (failure === "restricted" || failure === "missing") f.change({ match: failure });
    if (failure === "changed-during-read")
      f.change({
        after: () => {
          f.h.revision = "f".repeat(64);
        },
      });
    await assert.rejects(
      f.service.prepare(actor, scope, { expectedRevision, requestId: randomUUID(), confirm: true }),
    );
    assert.equal(f.stats().writes, 0);
  });
}
test("stale decision or changed remote status cannot be approved; stale requests can be withdrawn", async () => {
  const f = fixture();
  const p = await f.service.prepare(actor, scope, {
    expectedRevision: f.h.revision,
    requestId: randomUUID(),
    confirm: true,
  });
  const row = p.requests[0];
  f.change({ status: "Withdrawn" });
  await assert.rejects(
    f.service.act(actor, scope, row.id, {
      expectedRevision: row.revision,
      action: "approve",
      confirm: true,
    }),
  );
  f.h.revision = "d".repeat(64);
  const changed = await f.service.view(actor, scope);
  assert.equal(changed.requests[0].stale, true);
  assert.equal(changed.requests[0].canApprove, false);
  assert.equal(changed.requests[0].canWithdraw, true);
  await f.service.act(actor, scope, row.id, {
    expectedRevision: row.revision,
    action: "withdraw",
    confirm: true,
  });
  assert.equal(f.rows[0].state, "withdrawn");
});
test("connection replacement or grant change invalidates an existing approval", async () => {
  const f = fixture();
  await f.service.prepare(actor, scope, {
    expectedRevision: f.h.revision,
    requestId: randomUUID(),
    confirm: true,
  });
  f.change({ consent: true });
  assert.equal((await f.service.view(actor, scope)).requests[0].stale, true);
  assert.equal(
    (await f.service.view(actor, scope)).liveEnabled,
    false,
    "write grant alone never enables a transition",
  );
  f.change({ consent: false, connection: "replacement" });
  assert.equal((await f.service.view(actor, scope)).requests[0].canApprove, false);
});
test("recovery refuses prepared requests and never creates attributable delivery evidence", async () => {
  const f = fixture();
  const view = await f.service.prepare(actor, scope, {
    expectedRevision: f.h.revision,
    requestId: randomUUID(),
    confirm: true,
  });
  const row = view.requests[0],
    prior = f.stats();
  await assert.rejects(
    f.service.act(actor, scope, row.id, {
      expectedRevision: row.revision,
      action: "recover",
      confirm: true,
    }),
  );
  assert.deepEqual(f.stats(), prior);
});
test("OAuth write scope is explicit opt-in, and custody stage permission cannot be borrowed", async () => {
  const cfg = zohoOAuthConfig({
    ZOHO_CLIENT_ID: "1000.SyntheticStageClient",
    ZOHO_CLIENT_SECRET: "synthetic-secret",
    ZOHO_REDIRECT_URI: "https://example.test/api/zoho-recruit/callback",
    ZOHO_SETTINGS_URL: "https://example.test/settings/ats",
    ZOHO_DATA_CENTER: "us",
    SESSION_SECRET: "synthetic-session-secret",
  });
  assert.ok(cfg);
  assert.equal(
    new URL(zohoConsent(cfg, "state")).searchParams.get("scope")!.includes("candidate.UPDATE"),
    false,
  );
  assert.equal(
    new URL(zohoConsent(cfg, "state", false, false, true)).searchParams
      .get("scope")!
      .includes("candidate.UPDATE"),
    true,
  );
  const row = {
    tenantId: actor.tenantId,
    userId: actor.id,
    accountRef: "a".repeat(64),
    approvedAt: new Date(),
    refreshTokenEnc: "synthetic-ciphertext",
    fingerprint: cfg.fingerprint,
    revision: "connection",
  };
  let marked = false;
  const permission = zohoStagePermission({
    config: cfg,
    store: { get: async () => row } as never,
    actorLookup: async (id) => {
      assert.ok(id);
      return { ...actor, id };
    },
    unseal: () =>
      JSON.stringify({
        purpose: "zoho-recruit",
        tenantId: actor.tenantId,
        userId: actor.id,
        accountRef: row.accountRef,
        fingerprint: cfg.fingerprint,
        token: "synthetic-token",
        stageWrites: marked,
      }),
  });
  const before = await permission.check(actor, row.accountRef);
  assert.equal(before.writeConsentSaved, false);
  assert.match(before.custodyRevision!, /^[a-f0-9]{64}$/);
  assert.equal(before.configFingerprint, cfg.fingerprint);
  assert.equal(JSON.stringify(before).includes(row.refreshTokenEnc), false);
  row.refreshTokenEnc = "synthetic-replaced-ciphertext";
  assert.notEqual(
    (await permission.check(actor, row.accountRef)).custodyRevision,
    before.custodyRevision,
  );
  marked = true;
  assert.equal((await permission.check(actor, row.accountRef)).writeConsentSaved, true);
  assert.equal((await permission.check(actor, "b".repeat(64))).writeConsentSaved, false);
});
test("claimed recovery reads under authority locks and saves observation only", async () => {
  const f = fixture();
  await f.service.prepare(actor, scope, {
    expectedRevision: f.h.revision,
    requestId: randomUUID(),
    confirm: true,
  });
  const row = f.rows[0];
  row.state = "claimed";
  row.executionRequestId = randomUUID();
  f.change({ status: row.snapshot.targetStatus });
  const response = await f.service.act(actor, scope, row.requestId, {
    expectedRevision: row.revision,
    action: "recover",
    confirm: true,
  });
  assert.equal(response.requests[0].state, "observed_target");
  assert.equal(response.liveEnabled, false);
  assert.deepEqual(f.readLocks, [false, true]);
});
test("authority lost before recovery blocks provider reads and leaves the claim unresolved", async () => {
  const f = fixture();
  await f.service.prepare(actor, scope, {
    expectedRevision: f.h.revision,
    requestId: randomUUID(),
    confirm: true,
  });
  const row = f.rows[0];
  row.state = "claimed";
  row.executionRequestId = randomUUID();
  const before = f.stats();
  f.change({ fenceAllowed: false });
  await assert.rejects(
    f.service.act(actor, scope, row.requestId, {
      expectedRevision: row.revision,
      action: "recover",
      confirm: true,
    }),
  );
  assert.equal(f.stats().reads, before.reads);
  assert.equal(f.stats().writes, before.writes);
  assert.equal(row.state, "claimed");
});
test("source changes during recovery cannot create a saved observation", async () => {
  const f = fixture();
  await f.service.prepare(actor, scope, {
    expectedRevision: f.h.revision,
    requestId: randomUUID(),
    confirm: true,
  });
  const row = f.rows[0];
  row.state = "claimed";
  row.executionRequestId = randomUUID();
  const before = f.stats().writes;
  f.change({
    after: () => {
      f.h.revision = "f".repeat(64);
    },
  });
  await assert.rejects(
    f.service.act(actor, scope, row.requestId, {
      expectedRevision: row.revision,
      action: "recover",
      confirm: true,
    }),
  );
  assert.equal(f.stats().writes, before);
  assert.equal(row.state, "claimed");
});
test("stage-request routes authenticate, reject forged authority/proof and disallow execution actions", async () => {
  let allowed = true,
    calls = 0;
  const app = express();
  app.use(express.json());
  app.use(
    "/api",
    zohoRecruitAccountRouter(
      {
        actor: async () => {
          if (!allowed) throw new CalendarError(403, "denied", "Denied");
          return actor;
        },
        service: () => {
          throw Error("Unexpected OAuth");
        },
        config: () => null,
      },
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      () => ({
        gateCandidateAccess: async () => ({
          view: async () => {
            calls++;
            throw new CalendarError(409, "synthetic", "Synthetic");
          },
          prepare: async () => {
            calls++;
            throw new CalendarError(409, "synthetic", "Synthetic");
          },
          act: async () => {
            calls++;
            throw new CalendarError(409, "synthetic", "Synthetic");
          },
        }),
        view: async () => {
          calls++;
          throw new CalendarError(409, "synthetic", "Synthetic");
        },
        prepare: async () => {
          calls++;
          throw new CalendarError(409, "synthetic", "Synthetic");
        },
        act: async () => {
          calls++;
          throw new CalendarError(409, "synthetic", "Synthetic");
        },
      }),
    ),
  );
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}/api/zoho-recruit/campaigns/${scope.campaignId}/recipients/${scope.recipientId}/stage-requests`;
  const send = (path: string, body: unknown) =>
    fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  try {
    const input = { expectedRevision: "a".repeat(64), requestId: randomUUID(), confirm: true };
    for (const change of [
      { actor },
      { tenantId: actor.tenantId },
      { proof: {} },
      { mode: "live" },
      { confirm: false },
    ])
      assert.equal((await send(url, { ...input, ...change })).status, 400);
    assert.equal(calls, 0);
    const actions = `${url}/${randomUUID()}/actions`;
    for (const action of ["execute", "send", "retry"])
      assert.equal(
        (await send(actions, { expectedRevision: input.expectedRevision, action, confirm: true }))
          .status,
        400,
      );
    assert.equal(calls, 0);
    assert.equal((await send(url, input)).status, 409);
    allowed = false;
    assert.equal((await fetch(url)).status, 403);
    assert.equal((await send(url, input)).status, 403);
    assert.equal(calls, 1);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
  }
});
