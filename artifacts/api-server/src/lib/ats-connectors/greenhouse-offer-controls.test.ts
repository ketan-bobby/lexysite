import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { dbAdmin } from "@workspace/db";
import type { CampaignTx } from "./zoho-interview-campaigns";
import {
  offerBlocker,
  offerDigest,
  offerRevision,
  offerSnapshotSchema,
  offerTermsHash,
  type OfferSnapshot,
} from "./greenhouse-offer-policy";
import {
  greenhouseOfferControls,
  offerObservationSchema,
  type OfferControlSource,
} from "./greenhouse-offer-controls";
import { greenhouseOfferStore } from "./greenhouse-offer-store";

function snapshot(): OfferSnapshot {
  const binding = { applicationId: "300", candidateId: "200", jobId: "100" };
  const connectionRevision = randomUUID();
  return {
    actor: { id: randomUUID(), tenantId: randomUUID() },
    scope: { workflowId: randomUUID() },
    accountRef: "a".repeat(64),
    connectionRevision,
    binding,
    sourceRevision: "b".repeat(64),
    termsOwnerId: randomUUID(),
    approverId: randomUUID(),
    submitterId: randomUUID(),
    currentHumanDecision: true,
    writePermissionConfirmed: true,
    canReadRemote: true,
    existingChain: null,
    existingApprovalState: "none",
    openingId: "101",
    startDate: "2026-12-01",
    values: { salary: { amountMinor: 12000000, currency: "USD" }, employment_type: "Full time" },
    contract: {
      accountRef: "a".repeat(64),
      connectionRevision,
      bindingHash: offerDigest(binding),
      chainHash: offerDigest(null),
      revision: "c".repeat(64),
      evidenceReference: "synthetic-employer-contract-not-live-verification",
      verifiedAt: 1000,
      expiresAt: 2000,
      applicationBound: true,
      sideEffectsReviewed: true,
      approvalFlowConfirmed: true,
      candidateDeliveryDisabled: true,
      startDateRequired: true,
      openingRequired: true,
      allowedOpeningIds: ["101"],
      fields: [
        {
          key: "salary",
          type: "currency",
          required: true,
          choices: [],
          currencies: ["USD"],
          min: 100,
          max: 50000000,
        },
        {
          key: "employment_type",
          type: "choice",
          required: true,
          choices: ["Full time", "Part time"],
          currencies: [],
          min: null,
          max: null,
        },
      ],
    },
  };
}
for (const [name, mutate, expected] of [
  ["required field", (s: OfferSnapshot) => delete s.values.salary, "required_offer_field_missing"],
  ["unknown field", (s: OfferSnapshot) => (s.values.secret = "unapproved"), "unknown_offer_field"],
  [
    "currency",
    (s: OfferSnapshot) => (s.values.salary = { amountMinor: 1000, currency: "EUR" }),
    "offer_field_invalid",
  ],
  [
    "amount bound",
    (s: OfferSnapshot) => (s.values.salary = { amountMinor: 1, currency: "USD" }),
    "offer_field_out_of_range",
  ],
  [
    "picklist",
    (s: OfferSnapshot) => (s.values.employment_type = "Invented"),
    "offer_field_invalid",
  ],
  ["start date", (s: OfferSnapshot) => (s.startDate = null), "start_date_required"],
  ["opening", (s: OfferSnapshot) => (s.openingId = "999"), "opening_invalid"],
  [
    "duplicate fields",
    (s: OfferSnapshot) => s.contract.fields.push(s.contract.fields[0]),
    "employer_fields_invalid",
  ],
  [
    "different employer",
    (s: OfferSnapshot) => (s.contract.accountRef = "d".repeat(64)),
    "verified_employer_contract_required",
  ],
  [
    "different offer chain",
    (s: OfferSnapshot) => (s.contract.chainHash = "d".repeat(64)),
    "verified_employer_contract_required",
  ],
  [
    "candidate delivery",
    (s: OfferSnapshot) => (s.contract.candidateDeliveryDisabled = false),
    "verified_employer_contract_required",
  ],
  [
    "stale human decision",
    (s: OfferSnapshot) => (s.currentHumanDecision = false),
    "current_human_decision_required",
  ],
  [
    "missing permission",
    (s: OfferSnapshot) => (s.writePermissionConfirmed = false),
    "employer_permission_required",
  ],
] as const) {
  test(`employer offer policy rejects ${name}`, () => {
    const s = snapshot();
    mutate(s);
    assert.equal(offerBlocker(offerSnapshotSchema.parse(s), 1500), expected);
  });
}
test("offer hashes bind terms and authority without depending on the viewer", () => {
  const s = snapshot();
  const original = offerRevision(s);
  s.actor.id = s.approverId;
  assert.equal(offerRevision(s), original);
  const reordered = { ...s, values: Object.fromEntries(Object.entries(s.values).reverse()) };
  assert.equal(offerRevision(reordered), original);
  s.values.salary = { amountMinor: 13000000, currency: "USD" };
  assert.notEqual(offerRevision(s), original);
  assert(!offerSnapshotSchema.safeParse({ ...s, startDate: "2026-02-30" }).success);
  assert(
    !offerSnapshotSchema.safeParse({
      ...s,
      values: { salary: { amountMinor: 1.2, currency: "USD" } },
    }).success,
  );
  assert(
    !offerSnapshotSchema.safeParse({ ...s, binding: { ...s.binding, jobId: "9007199254740993" } })
      .success,
  );
});

test("Greenhouse offer controls use private SQL and a simulated provider only", async (t) => {
  const rollback = Error("rollback-private-greenhouse-offer-fixture");
  const run = async (tx: CampaignTx) => {
    const [identity] = (
      await tx.execute(sql`SELECT current_database() AS name, inet_server_addr() AS host`)
    ).rows;
    assert.equal(identity.name, "heliumdb");
    assert.equal(identity.host, null, "Only verified local development PostgreSQL is allowed");
    await tx.execute(
      sql`CREATE TEMP TABLE audit_logs (LIKE public.audit_logs INCLUDING ALL) ON COMMIT DROP`,
    );
    await tx.execute(sql`SET LOCAL search_path = pg_temp,pg_catalog`);
    const ledger = greenhouseOfferStore(tx as unknown as typeof dbAdmin);
    function fixture() {
      const s = snapshot();
      let reads = 0,
        submits = 0,
        clock = 1500;
      let mode = "accepted",
        lockedChange = false,
        failRecord = false;
      let remote: z.infer<typeof offerObservationSchema> = {
        accountRef: s.accountRef,
        binding: structuredClone(s.binding),
        chain: null,
        termsHash: null,
        approvalState: "none",
      };
      const actor = (role: "termsOwnerId" | "approverId" | "submitterId") => ({
        id: s[role],
        tenantId: s.actor.tenantId,
      });
      const source: OfferControlSource = {
        current: async (who) => ({
          ...structuredClone(s),
          actor: { id: who.id, tenantId: s.actor.tenantId },
        }),
        fence: async (who, _scope, work) => {
          const locked = {
            ...structuredClone(s),
            actor: { id: who.id, tenantId: s.actor.tenantId },
          };
          if (lockedChange) locked.sourceRevision = "e".repeat(64);
          return work(locked);
        },
      };
      const store = {
        ...ledger,
        record: async (...args: Parameters<typeof ledger.record>) => {
          if (failRecord) throw Error("Synthetic storage failure");
          return ledger.record(...args);
        },
      };
      const provider = {
        read: async () => {
          reads++;
          if (mode === "expire") clock = 2100;
          if (mode === "readback_failure" && submits) throw Error("Synthetic readback failure");
          return structuredClone(remote);
        },
        submitForApproval: async () => {
          submits++;
          const row = await ledger.get(actor("submitterId"), s.scope, preparedId);
          assert.equal(row?.state, "claimed", "SQL claim must exist before the simulated write");
          if (mode === "rejected") return { status: "rejected" as const };
          remote = {
            ...remote,
            chain: { id: "400", version: 1, revision: "f".repeat(64) },
            termsHash: offerTermsHash(s),
            approvalState: "pending",
          };
          if (mode === "uncertain") throw Error("Synthetic response lost after remote acceptance");
          if (mode === "wrong_terms") remote.termsHash = "0".repeat(64);
          return { status: "accepted" as const, chain: remote.chain! };
        },
      };
      const dependencies = { source, store, provider, now: () => clock, newId: randomUUID };
      const service = greenhouseOfferControls(dependencies);
      const command = () => ({
        expectedRevision: offerRevision(s),
        requestId: randomUUID(),
        confirm: true as const,
      });
      let preparedId = "";
      const prepare = async () => {
        const row = await service.prepare(actor("termsOwnerId"), s.scope, command());
        preparedId = row.id;
        return row;
      };
      const approve = async () => {
        const row = await prepare();
        await service.approve(actor("approverId"), s.scope, row.id, command());
        return row;
      };
      return {
        s,
        actor,
        service,
        command,
        prepare,
        approve,
        provider,
        reconstruct: () =>
          greenhouseOfferControls({
            ...dependencies,
            store: { ...store, get: greenhouseOfferStore(tx as unknown as typeof dbAdmin).get },
          }),
        counters: () => ({ reads, submits }),
        mode: (value: string) => (mode = value),
        clock: (value: number) => (clock = value),
        lockChange: () => (lockedChange = true),
        failRecord: (value: boolean) => (failRecord = value),
        remote: () => remote,
      };
    }
    await t.test("three humans approve then submit without candidate delivery", async () => {
      const h = fixture();
      const row = await h.prepare();
      await assert.rejects(
        h.service.submit(h.actor("submitterId"), h.s.scope, row.id, h.command()),
      );
      await h.service.approve(h.actor("approverId"), h.s.scope, row.id, h.command());
      assert.deepEqual(h.counters(), { reads: 0, submits: 0 });
      const input = h.command();
      const sent = await h.service.submit(h.actor("submitterId"), h.s.scope, row.id, input);
      assert.equal(sent.state, "verified_submission");
      assert.equal(
        h.remote().approvalState,
        "pending",
        "Local financial approval is not Greenhouse approval",
      );
      const replay = await h.reconstruct().submit(h.actor("submitterId"), h.s.scope, row.id, input);
      assert.equal(replay.id, sent.id);
      assert.equal(h.counters().submits, 1);
      const [audit] = (
        await tx.execute(
          sql`SELECT actor_id FROM audit_logs WHERE metadata->'attempt'->>'id'=${row.id} ORDER BY (metadata->>'sequence')::int DESC LIMIT 1`,
        )
      ).rows;
      assert.equal(audit.actor_id, h.s.submitterId, "Audit records the actual operator");
    });
    await t.test("roles, forged approval input and foreign scope fail closed", async () => {
      const h = fixture();
      const row = await h.prepare();
      await assert.rejects(
        h.service.approve(h.actor("termsOwnerId"), h.s.scope, row.id, h.command()),
      );
      await assert.rejects(
        h.service.approve(h.actor("approverId"), h.s.scope, row.id, {
          ...h.command(),
          confirm: false,
        } as unknown as ReturnType<typeof h.command>),
      );
      await assert.rejects(
        h.service.approve(h.actor("approverId"), h.s.scope, row.id, {
          ...h.command(),
          approvedBy: h.s.approverId,
        } as ReturnType<typeof h.command>),
      );
      await assert.rejects(
        h.service.submit(
          { ...h.actor("submitterId"), tenantId: randomUUID() },
          h.s.scope,
          row.id,
          h.command(),
        ),
      );
      assert.deepEqual(h.counters(), { reads: 0, submits: 0 });
    });
    await t.test(
      "history retains attempts in committed order with minimal actual-staff metadata",
      async () => {
        const h = fixture();
        const first = await h.approve();
        await h.service.submit(h.actor("submitterId"), h.s.scope, first.id, h.command());
        h.s.sourceRevision = "8".repeat(64);
        const second = await h.prepare();
        assert.notEqual(second.id, first.id);
        // Deliberately reverse wall-clock ordering. Sequence, not timestamps, is authoritative.
        await tx.execute(sql`
        UPDATE audit_logs SET created_at=TIMESTAMP '2026-01-01' -
          ((metadata->>'sequence')::int * INTERVAL '1 second')
        WHERE tenant_id=${h.s.actor.tenantId} AND subject_id=${h.s.scope.workflowId}
      `);
        const view = await ledger.inspect(h.actor("termsOwnerId"), h.s.scope);
        assert.equal(view.latest?.id, second.id);
        assert.deepEqual(
          view.history.map((r) => r.sequence),
          [1, 2, 3, 4, 5, 6],
        );
        assert.deepEqual(
          view.history.map((r) => r.state),
          [
            "prepared",
            "approved",
            "claimed",
            "provider_accepted",
            "verified_submission",
            "prepared",
          ],
        );
        assert.deepEqual(
          view.history.map((r) => r.actorId),
          [
            h.s.termsOwnerId,
            h.s.approverId,
            h.s.submitterId,
            h.s.submitterId,
            h.s.submitterId,
            h.s.termsOwnerId,
          ],
        );
        assert(view.history[0].recordedAt > view.history[1].recordedAt);
        for (const entry of view.history)
          assert.deepEqual(Object.keys(entry).sort(), [
            "actorId",
            "attemptId",
            "receiptRecorded",
            "recordedAt",
            "sequence",
            "state",
          ]);
        assert.equal(view.history[0].receiptRecorded, false);
        assert.equal(view.history[4].receiptRecorded, true);
        assert.deepEqual(
          await ledger.inspect({ ...h.actor("termsOwnerId"), tenantId: randomUUID() }, h.s.scope),
          { latest: null, history: [] },
        );
        assert.deepEqual(
          await ledger.inspect(h.actor("termsOwnerId"), { workflowId: randomUUID() }),
          { latest: null, history: [] },
        );
      },
    );
    await t.test("term edits and lock-time changes cannot reuse approval", async () => {
      const h = fixture();
      const row = await h.approve();
      const old = h.command();
      h.s.values.salary = { amountMinor: 14000000, currency: "USD" };
      await assert.rejects(h.service.submit(h.actor("submitterId"), h.s.scope, row.id, old));
      const race = fixture();
      const r = await race.approve();
      race.lockChange();
      assert.equal(
        (await race.service.submit(race.actor("submitterId"), race.s.scope, r.id, race.command()))
          .state,
        "not_sent",
      );
      assert.equal(h.counters().submits + race.counters().submits, 0);
    });
    await t.test("a changed remote offer chain prevents overwrite", async () => {
      const h = fixture();
      const row = await h.approve();
      h.remote().chain = { id: "999", version: 2, revision: "d".repeat(64) };
      const result = await h.service.submit(h.actor("submitterId"), h.s.scope, row.id, h.command());
      assert.equal(result.state, "not_sent");
      assert.equal(h.counters().submits, 0);
    });
    await t.test("changed remote approval and already-matching terms never submit", async () => {
      for (const mode of ["approval_changed", "already_matches"]) {
        const h = fixture();
        const existing = { id: "399", version: 1, revision: "d".repeat(64) };
        h.s.existingChain = existing;
        h.s.existingApprovalState = "pending";
        h.s.contract.chainHash = offerDigest(existing);
        h.remote().chain = existing;
        h.remote().approvalState = mode === "approval_changed" ? "approved" : "pending";
        if (mode === "already_matches") h.remote().termsHash = offerTermsHash(h.s);
        const row = await h.approve();
        const result = await h.service.submit(
          h.actor("submitterId"),
          h.s.scope,
          row.id,
          h.command(),
        );
        assert.equal(result.state, "not_sent");
        assert.equal(h.counters().submits, 0);
      }
    });
    await t.test("uncertainty allows observation, never resend or attribution", async () => {
      const h = fixture();
      const row = await h.approve();
      h.mode("uncertain");
      const input = h.command();
      const result = await h.service.submit(h.actor("submitterId"), h.s.scope, row.id, input);
      assert.equal(result.state, "review_required");
      await h.reconstruct().submit(h.actor("submitterId"), h.s.scope, row.id, input);
      h.clock(2100);
      const recovered = await h.reconstruct().recover(h.actor("submitterId"), h.s.scope, row.id);
      assert.equal(recovered.state, "observed_match");
      assert.equal(h.counters().submits, 1);
      await assert.rejects(ledger.record(h.actor("submitterId"), recovered, "verified_submission"));
      h.s.connectionRevision = randomUUID();
      const before = h.counters();
      await assert.rejects(h.reconstruct().recover(h.actor("submitterId"), h.s.scope, row.id));
      assert.deepEqual(h.counters(), before);
    });
    await t.test("failure to save receipt retains the attempt claim", async () => {
      const h = fixture();
      const row = await h.approve();
      const input = h.command();
      h.failRecord(true);
      await assert.rejects(h.service.submit(h.actor("submitterId"), h.s.scope, row.id, input));
      h.failRecord(false);
      const replay = await h.reconstruct().submit(h.actor("submitterId"), h.s.scope, row.id, input);
      assert.equal(replay.state, "claimed");
      assert.equal(h.counters().submits, 1);
      h.s.sourceRevision = "9".repeat(64);
      await assert.rejects(h.prepare(), "Unresolved attempts block replacement intents");
    });
    await t.test("expiry and mismatched receipts cannot verify a submission", async () => {
      for (const mode of ["expire", "wrong_terms", "readback_failure", "rejected"]) {
        const h = fixture();
        const row = await h.approve();
        h.mode(mode);
        const result = await h.service.submit(
          h.actor("submitterId"),
          h.s.scope,
          row.id,
          h.command(),
        );
        assert.equal(result.state, mode === "expire" ? "not_sent" : "review_required");
        assert.equal(h.counters().submits, mode === "expire" ? 0 : 1);
      }
    });
    await t.test("audit metadata excludes financial payloads and external identities", async () => {
      const rows = (await tx.execute(sql`SELECT metadata FROM audit_logs`)).rows;
      const text = JSON.stringify(rows);
      for (const forbidden of [
        "12000000",
        "14000000",
        "Full time",
        '"salary"',
        '"applicationId"',
        '"candidateId"',
        '"jobId"',
        "synthetic-employer-contract",
      ])
        assert(!text.includes(forbidden), forbidden);
      assert(rows.length > 10, "Positive control: the journal was actually exercised");
    });
    throw rollback;
  };
  await assert.rejects(dbAdmin.transaction(run), (error) => error === rollback);
});
