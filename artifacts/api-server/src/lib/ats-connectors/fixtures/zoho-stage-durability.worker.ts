/**
 * IPC-only test worker. The parent supplies a newly initialized, socket-only
 * PostgreSQL cluster and a credential-free environment. Never import in routes.
 */
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { z } from "zod/v4";
import { dbAdmin, pool } from "@workspace/db";
import { zohoStageRequestStore } from "../zoho-stage-request-store";
import {
  stageWriteSnapshotSchema,
  stageWriteRevision,
  zohoStageWriter,
  type StageWriteStore,
} from "../zoho-stage-write-core";
import { runStageAuthorityRaces } from "./zoho-stage-authority-races";
import { runCombinedStageRaces } from "./zoho-stage-combined-races";

const command = z.strictObject({
  directory: z.string().regex(/^\/tmp\/lexy-stage-durability-[A-Za-z0-9]+\/data$/),
  systemIdentifier: z.string().regex(/^\d+$/),
  token: z.uuid(),
  snapshot: stageWriteSnapshotSchema,
  mode: z.enum(["prepare", "uncommitted", "execute", "claim", "recover", "inspect", "authority"]),
  requestId: z.uuid(),
  attemptId: z.uuid().optional(),
  pauseAt: z.enum(["claimed", "effect", "provider_accepted"]).optional(),
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
    // Parent intentionally SIGKILLs this exact worker after the checkpoint.
    setInterval(() => {}, 60_000);
  });
}

process.once("message", async (raw) => {
  try {
    const input = command.parse(raw);
    const [identity] = (
      await dbAdmin.execute(sql`
        SELECT current_setting('data_directory') AS directory,
          system_identifier::text AS identifier,
          inet_server_addr() AS host,
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
    const markers = await dbAdmin.execute(
      sql`SELECT token FROM fixture_owner WHERE token = ${input.token}`,
    );
    assert.equal(markers.rows.length, 1, "exact isolated cluster ownership required");

    const s = input.snapshot;
    const ledger = zohoStageRequestStore();
    const base = ledger.asWriterStore(s.binding);
    const approval = {
      requestId: input.requestId,
      expectedRevision: stageWriteRevision(s),
      confirm: true as const,
    };
    const wrapped: StageWriteStore = {
      ...base,
      async claim(snapshot, request) {
        const result = await base.claim(snapshot, request);
        if (result.acquired && input.pauseAt === "claimed") await pause("claimed");
        return result;
      },
      async record(attempt, state) {
        const result = await base.record(attempt, state);
        if (state === input.pauseAt) await pause(state);
        return result;
      },
    };
    const writer = zohoStageWriter({
      store: wrapped,
      // Synthetic authority only: this does not test real staff/erasure fencing.
      source: {
        current: async () => s,
        fence: async (_actor, _scope, work) => work(s),
      },
      provider: {
        async read(binding) {
          assert.deepEqual(binding, s.binding);
          const effects = await dbAdmin.execute(
            sql`SELECT count(*)::int AS n FROM fixture_provider_effects
                WHERE recipient_id = ${s.scope.recipientId}`,
          );
          return {
            ...s.binding,
            currentStatus: Number(effects.rows[0].n) ? s.targetStatus : s.currentStatus,
          };
        },
        async change(snapshot) {
          assert.deepEqual(snapshot, s);
          // A committed row stands in for an external mutation. No HTTP is used.
          await dbAdmin.execute(
            sql`INSERT INTO fixture_provider_effects(recipient_id)
                VALUES (${s.scope.recipientId})`,
          );
          if (input.pauseAt === "effect") await pause("effect");
          return "accepted";
        },
      },
      now: () => 1500,
    });

    let result: unknown;
    switch (input.mode) {
      case "authority":
        result = {
          barrier: await runStageAuthorityRaces(pool),
          combined: await runCombinedStageRaces(pool),
        };
        break;
      case "prepare": {
        const row = await ledger.prepare(s, input.requestId);
        await ledger.act(s.actor, s.scope, row.requestId, row.revision, "approved");
        result = { id: row.requestId, revision: row.revision };
        break;
      }
      case "uncommitted":
        await dbAdmin.transaction(async (tx) => {
          await ledger.prepare(s, input.requestId, tx);
          await pause("uncommitted");
        });
        break;
      case "execute": {
        const outcome = await writer.execute(s.actor, s.scope, approval);
        result = { state: outcome.attempt?.state };
        break;
      }
      case "claim": {
        const outcome = await base.claim(s, approval);
        result = { acquired: outcome.acquired, state: outcome.attempt.state };
        break;
      }
      case "recover": {
        assert.ok(input.attemptId);
        const outcome = await writer.recover(s.actor, s.scope, input.attemptId);
        result = { state: outcome.state };
        break;
      }
      case "inspect": {
        const rows = await ledger.list(s.actor, s.scope);
        const effects = await dbAdmin.execute(
          sql`SELECT count(*)::int AS n FROM fixture_provider_effects
              WHERE recipient_id = ${s.scope.recipientId}`,
        );
        result = {
          states: rows.map((r) => r.state),
          sequence: rows[0]?.sequence ?? 0,
          effects: Number(effects.rows[0].n),
        };
        break;
      }
    }
    await pool.end();
    await send({ kind: "result", result });
    process.disconnect?.();
  } catch (error) {
    await pool.end().catch(() => {});
    await send({
      kind: "error",
      error: error instanceof Error ? error.message : "Fixture operation failed",
    }).catch(() => {});
    process.exitCode = 1;
    process.disconnect?.();
  }
});
