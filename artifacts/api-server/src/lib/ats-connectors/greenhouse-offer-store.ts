import { and, eq, sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { z } from "zod/v4";
import { dbAdmin, auditLogsTable as audits } from "@workspace/db";
import type { GreenhouseOfferHistoryEntry } from "@workspace/api-zod";
import { CalendarError } from "../outlook-calendar-core";
import {
  offerAttemptSchema,
  type OfferAttempt,
  type OfferControlStore,
} from "./greenhouse-offer-controls";
import type { OfferActor, OfferScope } from "./greenhouse-offer-policy";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
const envelope = z.strictObject({
  version: z.literal(1),
  sequence: z.number().int().positive(),
  attempt: offerAttemptSchema,
});
const action = "greenhouse.offer_control";
const unresolved = new Set([
  "claimed",
  "draft_created",
  "provider_accepted",
  "review_required",
  "observed_match",
  "observed_other",
]);
const conflict = () =>
  new CalendarError(
    409,
    "greenhouse_offer_ledger_conflict",
    "This offer request changed or has an unresolved submission.",
  );

/** Hash-only intent/attempt journal: no terms, candidate IDs, tokens or provider bodies. */
export function greenhouseOfferStore(database = dbAdmin): OfferControlStore & {
  inspect(
    actor: OfferActor,
    scope: OfferScope,
  ): Promise<{ latest: OfferAttempt | null; history: GreenhouseOfferHistoryEntry[] }>;
} {
  async function list(tx: Pick<typeof dbAdmin, "select">, actor: OfferActor, scope: OfferScope) {
    const rows = await tx
      .select()
      .from(audits)
      .where(
        and(
          eq(audits.tenantId, actor.tenantId),
          eq(audits.subjectId, scope.workflowId),
          eq(audits.action, action),
        ),
      )
      .limit(1001);
    if (rows.length > 1000) throw conflict();
    const parsed = rows
      .map((row) => ({
        ...envelope.parse(row.metadata),
        recordedAt: row.createdAt,
        actorId: row.actorType === "user" ? row.actorId : null,
      }))
      .sort((a, b) => a.sequence - b.sequence);
    const seen = new Set<number>();
    const latest = new Map<string, OfferAttempt>();
    for (const row of parsed) {
      if (
        seen.has(row.sequence) ||
        row.attempt.tenantId !== actor.tenantId ||
        row.attempt.scope.workflowId !== scope.workflowId
      )
        throw conflict();
      seen.add(row.sequence);
      latest.set(row.attempt.id, row.attempt);
    }
    // Explicit allowlist: never serialize the private attempt, financial terms,
    // provider response, connection binding or credential hashes to the timeline.
    const history: GreenhouseOfferHistoryEntry[] = parsed.map((row) => ({
      sequence: row.sequence,
      attemptId: row.attempt.id,
      state: row.attempt.state,
      recordedAt: row.recordedAt,
      actorId: row.actorId,
      receiptRecorded: row.attempt.receiptHash !== null,
    }));
    return { latest: [...latest.values()], history, sequence: Math.max(0, ...seen) };
  }
  async function locked<T>(
    actor: OfferActor,
    scope: OfferScope,
    work: (tx: Tx, rows: Awaited<ReturnType<typeof list>>) => Promise<T>,
  ) {
    return database.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout='5s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${JSON.stringify([actor.tenantId, "greenhouse-offer", scope.workflowId])},0))`);
      return work(tx, await list(tx, actor, scope));
    });
  }
  async function append(tx: Tx, actor: OfferActor, sequence: number, raw: OfferAttempt) {
    const row = offerAttemptSchema.parse(raw);
    await tx.insert(audits).values({
      id: randomUUID(),
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorType: "user",
      subjectType: "external",
      subjectId: row.scope.workflowId,
      action,
      channel: "system",
      direction: "internal",
      title: `Greenhouse offer control: ${row.state}`,
      metadata: envelope.parse({ version: 1, sequence: sequence + 1, attempt: row }),
    });
    return row;
  }
  return {
    inspect: async (actor, scope) => {
      const rows = await list(database, actor, scope);
      return { latest: rows.latest.at(-1) ?? null, history: rows.history };
    },
    prepare: async (raw) => {
      const intent = offerAttemptSchema.parse(raw);
      if (
        intent.state !== "prepared" ||
        intent.approvedBy ||
        intent.executionRequestId ||
        intent.receiptHash
      )
        throw conflict();
      const actor = { id: intent.preparedBy, tenantId: intent.tenantId };
      return locked(actor, intent.scope, async (tx, rows) => {
        const reused = rows.latest.find((r) => r.prepareRequestId === intent.prepareRequestId);
        if (reused && reused.revision !== intent.revision) throw conflict();
        const same = reused ?? rows.latest.find((r) => r.revision === intent.revision);
        if (same) return same;
        if (rows.latest.some((r) => r.id === intent.id)) throw conflict();
        if (rows.latest.some((r) => unresolved.has(r.state))) throw conflict();
        return append(tx, actor, rows.sequence, intent);
      });
    },
    approve: (actor, scope, id, revision) =>
      locked(actor, scope, async (tx, rows) => {
        const row = rows.latest.find((r) => r.id === id);
        if (!row || row.revision !== revision || !["prepared", "approved"].includes(row.state))
          throw conflict();
        if (row.state === "approved") {
          if (row.approvedBy !== actor.id) throw conflict();
          return row;
        }
        return append(tx, actor, rows.sequence, {
          ...row,
          approvedBy: actor.id,
          state: "approved",
        });
      }),
    get: async (actor, scope, id) =>
      (await list(database, actor, scope)).latest.find((r) => r.id === id) ?? null,
    latest: async (actor, scope) => (await list(database, actor, scope)).latest.at(-1) ?? null,
    claim: (actor, scope, id, revision, requestId) =>
      locked(actor, scope, async (tx, rows) => {
        z.uuid().parse(requestId);
        const reused = rows.latest.find((r) => r.executionRequestId === requestId);
        if (reused && (reused.id !== id || reused.revision !== revision)) throw conflict();
        const row = rows.latest.find((r) => r.id === id);
        if (!row || row.revision !== revision || !row.approvedBy) throw conflict();
        if (row.state !== "approved") {
          if (!row.executionRequestId) throw conflict();
          return { acquired: false, attempt: row };
        }
        if (rows.latest.some((r) => r.id !== id && unresolved.has(r.state))) throw conflict();
        return {
          acquired: true,
          attempt: await append(tx, actor, rows.sequence, {
            ...row,
            state: "claimed",
            executionRequestId: requestId,
          }),
        };
      }),
    record: (actor, attempt, state, receiptHash) => {
      if (actor.tenantId !== attempt.tenantId) throw conflict();
      return locked(actor, attempt.scope, async (tx, rows) => {
        const row = rows.latest.find((r) => r.id === attempt.id);
        if (
          !row ||
          row.revision !== attempt.revision ||
          !row.executionRequestId ||
          row.executionRequestId !== attempt.executionRequestId
        )
          throw conflict();
        if (["verified_submission", "not_sent"].includes(row.state) || row.state === state)
          return row;
        const allowed =
          row.state === "claimed"
            ? [
                "draft_created",
                "provider_accepted",
                "not_sent",
                "review_required",
                "observed_match",
                "observed_other",
              ]
            : row.state === "draft_created"
              ? ["provider_accepted", "review_required", "observed_match", "observed_other"]
              : row.state === "provider_accepted"
                ? ["verified_submission", "review_required", "observed_match", "observed_other"]
                : ["review_required", "observed_match", "observed_other"];
        if (
          !allowed.includes(state) ||
          (["draft_created", "provider_accepted"].includes(state) && !receiptHash)
        )
          throw conflict();
        return append(tx, actor, rows.sequence, {
          ...row,
          state,
          receiptHash: receiptHash ?? row.receiptHash,
        });
      });
    },
  };
}
