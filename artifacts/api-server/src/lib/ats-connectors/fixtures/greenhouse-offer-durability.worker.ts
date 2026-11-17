/**
 * IPC-only worker for a private, socket-only PostgreSQL cluster. No live provider.
 * Authority and employer configuration below are synthetic, not permission proof.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { dbAdmin, pool } from "@workspace/db";
import { greenhouseOfferStore } from "../greenhouse-offer-store";
import { greenhouseOfferControls, type OfferControlStore } from "../greenhouse-offer-controls";
import {
  offerDigest,
  offerRevision,
  offerTermsHash,
  type OfferSnapshot,
} from "../greenhouse-offer-policy";

const command = z.strictObject({
  directory: z.string().regex(/^\/tmp\/lexy-offer-durability-[A-Za-z0-9]+\/data$/),
  systemIdentifier: z.string().regex(/^\d+$/),
  token: z.uuid(),
  scope: z.strictObject({
    workflowId: z.uuid(),
    tenantId: z.uuid(),
    ownerId: z.uuid(),
    reviewerId: z.uuid(),
    submitterId: z.uuid(),
    connectionRevision: z.uuid(),
  }),
  mode: z.enum(["prepare", "uncommitted", "submit", "claim", "recover", "inspect"]),
  requestId: z.uuid(),
  pauseAt: z.enum(["claimed", "effect", "draft_created", "provider_accepted"]).optional(),
});

async function send(value: object) {
  await new Promise<void>((resolve, reject) => {
    if (!process.send) return reject(new Error("IPC fixture worker required"));
    process.send(value, (error) => (error ? reject(error) : resolve()));
  });
}
async function pause(point: string): Promise<never> {
  await send({ kind: "checkpoint", point });
  return new Promise(() => {
    setInterval(() => {}, 60_000);
  });
}

process.once("message", async (raw) => {
  try {
    const input = command.parse(raw);
    const [identity] = (
      await dbAdmin.execute(sql`
      SELECT current_setting('data_directory') AS directory,
        system_identifier::text AS identifier, inet_server_addr() AS host,
        current_setting('fsync') AS fsync,
        current_setting('synchronous_commit') AS synchronous_commit
      FROM pg_control_system()
    `)
    ).rows;
    assert.equal(identity.directory, input.directory);
    assert.equal(identity.identifier, input.systemIdentifier);
    assert.equal(identity.host, null);
    assert.equal(identity.fsync, "on");
    assert.equal(identity.synchronous_commit, "on");
    assert.equal(
      (await dbAdmin.execute(sql`SELECT token FROM fixture_owner WHERE token=${input.token}`)).rows
        .length,
      1,
      "Exact disposable cluster ownership required before writes",
    );

    const c = input.scope;
    const actor = (id: string) => ({ id, tenantId: c.tenantId });
    const scope = { workflowId: c.workflowId };
    const binding = { applicationId: "300", candidateId: "200", jobId: "100" };
    const s: OfferSnapshot = {
      actor: actor(c.ownerId),
      scope,
      binding,
      accountRef: "a".repeat(64),
      connectionRevision: c.connectionRevision,
      sourceRevision: "b".repeat(64),
      termsOwnerId: c.ownerId,
      approverId: c.reviewerId,
      submitterId: c.submitterId,
      currentHumanDecision: true,
      writePermissionConfirmed: true,
      canReadRemote: true,
      existingChain: null,
      existingApprovalState: "none",
      openingId: "101",
      startDate: "2026-12-01",
      values: { salary: { amountMinor: 12000000, currency: "USD" } },
      contract: {
        accountRef: "a".repeat(64),
        connectionRevision: c.connectionRevision,
        bindingHash: offerDigest(binding),
        chainHash: offerDigest(null),
        revision: "c".repeat(64),
        evidenceReference: "isolated-simulation-only",
        verifiedAt: 1000,
        expiresAt: 2000,
        applicationBound: true,
        sideEffectsReviewed: true,
        approvalFlowConfirmed: true,
        candidateDeliveryDisabled: true,
        openingRequired: true,
        startDateRequired: true,
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
        ],
      },
    };
    const ledger = greenhouseOfferStore();
    const wrapped: OfferControlStore = {
      ...ledger,
      async claim(...args) {
        const outcome = await ledger.claim(...args);
        if (outcome.acquired && input.pauseAt === "claimed") await pause("claimed");
        return outcome;
      },
      async record(...args) {
        const result = await ledger.record(...args);
        if (args[2] === input.pauseAt) await pause(args[2]);
        return result;
      },
    };
    const chain = { id: "400", version: 1, revision: "d".repeat(64) };
    async function effects() {
      return Number(
        (
          await dbAdmin.execute(sql`
        SELECT count(*)::int AS n FROM fixture_provider_effects
        WHERE workflow_id=${scope.workflowId}
      `)
        ).rows[0].n,
      );
    }
    function controls(store: OfferControlStore) {
      return greenhouseOfferControls({
        store,
        now: () => 1500,
        newId: randomUUID,
        source: {
          current: async (who) => ({ ...s, actor: who }),
          fence: async (who, _scope, work) => work({ ...s, actor: who }),
        },
        provider: {
          async read() {
            const submitted = (await effects()) > 0;
            return {
              accountRef: s.accountRef,
              binding,
              chain: submitted ? chain : null,
              termsHash: submitted ? offerTermsHash(s) : null,
              approvalState: submitted ? ("pending" as const) : ("none" as const),
            };
          },
          async submitForApproval(fresh) {
            // A real COMMIT stands in for external acceptance. Never HTTP.
            await dbAdmin.execute(sql`
              INSERT INTO fixture_provider_effects(workflow_id) VALUES (${scope.workflowId})
            `);
            if (input.pauseAt === "effect") await pause("effect");
            const attempt = await ledger.latest(fresh.actor, fresh.scope);
            assert(attempt);
            await store.record(fresh.actor, attempt, "draft_created", offerDigest(chain));
            return { status: "accepted" as const, chain };
          },
        },
      });
    }
    const service = controls(wrapped);
    const intent = {
      requestId: input.requestId,
      expectedRevision: offerRevision(s),
      confirm: true as const,
    };
    let result: unknown;
    if (input.mode === "uncommitted") {
      await dbAdmin.transaction(async (tx) => {
        // Nested store transactions are savepoints; the outer transaction never commits.
        await controls(greenhouseOfferStore(tx as unknown as typeof dbAdmin)).prepare(
          actor(c.ownerId),
          scope,
          intent,
        );
        await pause("uncommitted");
      });
    } else if (input.mode === "prepare") {
      const row = await service.prepare(actor(c.ownerId), scope, intent);
      const approved = await service.approve(actor(c.reviewerId), scope, row.id, intent);
      result = { id: approved.id, state: approved.state };
    } else if (input.mode === "inspect") {
      const row = await ledger.latest(actor(c.ownerId), scope);
      const audits = (
        await dbAdmin.execute(sql`
        SELECT metadata FROM audit_logs WHERE tenant_id=${c.tenantId}
          AND subject_id=${scope.workflowId} ORDER BY (metadata->>'sequence')::int
      `)
      ).rows;
      const serialized = JSON.stringify(audits);
      for (const forbidden of ['"salary"', "12000000", '"applicationId"', '"candidateId"'])
        assert(!serialized.includes(forbidden), "Financial/raw provider payload leaked to journal");
      result = { state: row?.state ?? null, effects: await effects(), sequence: audits.length };
    } else {
      const row = await ledger.latest(actor(c.submitterId), scope);
      assert.ok(row, "Prepared intent required");
      if (input.mode === "claim") {
        const claimed = await ledger.claim(
          actor(c.submitterId),
          scope,
          row.id,
          row.revision,
          input.requestId,
        );
        result = { acquired: claimed.acquired, state: claimed.attempt.state };
      } else {
        const outcome =
          input.mode === "recover"
            ? await service.recover(actor(c.submitterId), scope, row.id)
            : await service.submit(actor(c.submitterId), scope, row.id, intent);
        result = { state: outcome.state };
      }
    }
    await pool.end();
    await send({ kind: "result", result });
    process.disconnect?.();
  } catch (error) {
    await pool.end().catch(() => {});
    await send({
      kind: "error",
      error: error instanceof Error ? error.message : "Fixture failed",
    }).catch(() => {});
    process.exitCode = 1;
    process.disconnect?.();
  }
});
