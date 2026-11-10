import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import { auditLogsTable as audits, dbAdmin } from "@workspace/db";
import { CalendarError } from "../outlook-calendar-core";
import {
  stageWriteSnapshotSchema,
  stageWriteRevision,
  type StageWriteActor,
  type StageWriteScope,
  type StageWriteSnapshot,
  type StageWriteBinding,
  type StageWriteState,
  type StageWriteStore,
} from "./zoho-stage-write-core";
import { fingerprint } from "../recruiting-workflows";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Reader = Pick<typeof dbAdmin, "select">;
const action = "zoho.stage_request";
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const states = z.enum([
  "prepared",
  "approved",
  "withdrawn",
  "claimed",
  "provider_accepted",
  "verified",
  "not_sent",
  "review_required",
  "observed_target",
  "observed_other",
]);
export type StageRequestState = z.infer<typeof states>;
// Do not retain raw external identities in the general-purpose audit ledger.
const persisted = stageWriteSnapshotSchema.omit({ binding: true, proof: true }).extend({
  bindingHash: hash,
  proof: stageWriteSnapshotSchema.shape.proof
    .unwrap()
    .omit({ applicationId: true, candidateId: true, jobId: true })
    .nullable(),
});
const envelope = z.object({
  version: z.literal(1),
  campaignId: z.string(),
  requestId: z.uuid(),
  sequence: z.number().int().positive(),
  state: states,
  revision: hash,
  prepareRequestId: z.uuid(),
  executionRequestId: z.uuid().nullable(),
  snapshot: persisted,
});
export type StageRequestRecord = z.infer<typeof envelope> & {
  createdAt: string;
  updatedAt: string;
  approvedBy: string | null;
};
const conflict = () =>
  new CalendarError(
    409,
    "zoho_stage_request_changed",
    "This request, interview decision or employer connection changed. Refresh and review again.",
  );
const unresolved = new Set<StageRequestState>([
  "claimed",
  "provider_accepted",
  "review_required",
  "observed_target",
  "observed_other",
]);
function pack(snapshot: StageWriteSnapshot) {
  const s = stageWriteSnapshotSchema.parse(snapshot);
  const { binding, proof, ...rest } = s;
  const p = proof
    ? (({ applicationId: _a, candidateId: _c, jobId: _j, ...safe }) => safe)(proof)
    : null;
  return persisted.parse({ ...rest, proof: p, bindingHash: fingerprint(binding) });
}
function unpack(row: StageRequestRecord, binding: StageWriteBinding) {
  if (row.snapshot.bindingHash !== fingerprint(binding)) throw conflict();
  const { bindingHash: _hash, proof, ...rest } = row.snapshot;
  return stageWriteSnapshotSchema.parse({
    ...rest,
    binding,
    proof: proof ? { ...proof, ...binding } : null,
  });
}
export function zohoStageRequestStore(database = dbAdmin) {
  async function list(actor: StageWriteActor, scope: StageWriteScope, handle: Reader = database) {
    const rows = await handle
      .select()
      .from(audits)
      .where(
        and(
          eq(audits.tenantId, actor.tenantId),
          eq(audits.subjectId, scope.recipientId),
          eq(audits.action, action),
          sql`${audits.metadata}->>'campaignId'=${scope.campaignId}`,
        ),
      )
      .limit(1001);
    if (rows.length > 1000)
      throw new CalendarError(
        409,
        "zoho_stage_history_limit",
        "Stage history needs administrator review; no partial history was accepted.",
      );
    const parsed = rows
      .map((r) => ({ row: r, value: envelope.parse(r.metadata) }))
      .sort((a, b) => a.value.sequence - b.value.sequence);
    const requests = new Map<string, StageRequestRecord>();
    const sequences = new Set<number>();
    for (const { row, value } of parsed) {
      if (
        sequences.has(value.sequence) ||
        value.snapshot.actor.tenantId !== actor.tenantId ||
        value.snapshot.scope.campaignId !== scope.campaignId ||
        value.snapshot.scope.recipientId !== scope.recipientId
      )
        throw conflict();
      sequences.add(value.sequence);
      const prior = requests.get(value.requestId);
      requests.set(value.requestId, {
        ...value,
        createdAt: prior?.createdAt ?? row.createdAt.toISOString(),
        updatedAt: row.createdAt.toISOString(),
        approvedBy: value.state === "approved" ? row.actorId : (prior?.approvedBy ?? null),
      });
    }
    return [...requests.values()].sort((a, b) => b.sequence - a.sequence);
  }
  async function locked<T>(
    actor: StageWriteActor,
    scope: StageWriteScope,
    work: (tx: Tx, rows: StageRequestRecord[]) => Promise<T>,
    handle?: Tx,
  ) {
    const run = async (tx: Tx) => {
      await tx.execute(sql`SET LOCAL lock_timeout = '5s'`);
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(
        ${JSON.stringify([actor.tenantId, "zoho-stage", scope.campaignId, scope.recipientId])},0))`);
      return work(tx, await list(actor, scope, tx));
    };
    return handle ? run(handle) : database.transaction(run);
  }
  async function append(
    tx: Tx,
    actor: StageWriteActor,
    scope: StageWriteScope,
    rows: StageRequestRecord[],
    values: Omit<z.infer<typeof envelope>, "sequence">,
  ) {
    const metadata = envelope.parse({
      ...values,
      sequence: Math.max(0, ...rows.map((r) => r.sequence)) + 1,
    });
    await tx.insert(audits).values({
      id: randomUUID(),
      tenantId: actor.tenantId,
      actorId: actor.id,
      actorType: "user",
      subjectType: "external",
      subjectId: scope.recipientId,
      action,
      channel: "system",
      direction: "internal",
      title: "Controlled Zoho stage request: " + metadata.state,
      metadata,
    });
    return (await list(actor, scope, tx)).find((r) => r.requestId === values.requestId)!;
  }
  return {
    list,
    async prepare(snapshot: StageWriteSnapshot, requestId: string, handle?: Tx) {
      z.uuid().parse(requestId);
      const s = stageWriteSnapshotSchema.parse(snapshot);
      return locked(
        s.actor,
        s.scope,
        async (tx, rows) => {
          const revision = stageWriteRevision(s);
          const sameId = rows.find((r) => r.prepareRequestId === requestId);
          if (sameId && sameId.revision !== revision) throw conflict();
          if (sameId) return sameId;
          const same = rows.find((r) => r.revision === revision && r.state !== "withdrawn");
          if (same) return same;
          if (rows.some((r) => unresolved.has(r.state)))
            throw new CalendarError(
              409,
              "zoho_stage_outcome_unresolved",
              "An earlier stage update is unresolved. Inspect it before preparing another request.",
            );
          return append(tx, s.actor, s.scope, rows, {
            version: 1,
            campaignId: s.scope.campaignId,
            requestId: randomUUID(),
            state: "prepared",
            revision,
            prepareRequestId: requestId,
            executionRequestId: null,
            snapshot: pack(s),
          });
        },
        handle,
      );
    },
    async act(
      actor: StageWriteActor,
      scope: StageWriteScope,
      requestId: string,
      revision: string,
      state: "approved" | "withdrawn",
      handle?: Tx,
    ) {
      return locked(
        actor,
        scope,
        async (tx, rows) => {
          const row = rows.find((r) => r.requestId === requestId);
          if (!row || row.revision !== revision) throw conflict();
          if (row.state === state) return row;
          if (!["prepared", "approved"].includes(row.state)) throw conflict();
          return append(tx, actor, scope, rows, { ...row, state });
        },
        handle,
      );
    },
    asWriterStore(binding: StageWriteBinding, recordingActor?: StageWriteActor): StageWriteStore {
      return {
        claim: async (snapshot, input) =>
          locked(snapshot.actor, snapshot.scope, async (tx, rows) => {
            const reused = rows.find((r) => r.executionRequestId === input.requestId);
            if (reused && reused.revision !== input.expectedRevision) throw conflict();
            const row = reused ?? rows.find((r) => r.revision === input.expectedRevision);
            if (
              !row ||
              stageWriteRevision(snapshot) !== row.revision ||
              fingerprint(pack(snapshot)) !== fingerprint(row.snapshot)
            )
              throw conflict();
            if (row.state !== "approved") {
              if (!row.executionRequestId) throw conflict();
              return {
                acquired: false,
                attempt: {
                  id: row.requestId,
                  revision: row.revision,
                  requestId: row.executionRequestId,
                  snapshot: unpack(row, binding),
                  state: row.state as StageWriteState,
                },
              };
            }
            if (rows.some((r) => r.requestId !== row.requestId && unresolved.has(r.state)))
              throw conflict();
            const claimed = await append(tx, snapshot.actor, snapshot.scope, rows, {
              ...row,
              state: "claimed",
              executionRequestId: input.requestId,
            });
            return {
              acquired: true,
              attempt: {
                id: claimed.requestId,
                revision: claimed.revision,
                requestId: input.requestId,
                snapshot: unpack(claimed, binding),
                state: "claimed",
              },
            };
          }),
        get: async (actor, scope, attemptId) => {
          const row = (await list(actor, scope)).find((r) => r.requestId === attemptId);
          return row?.executionRequestId
            ? {
                id: row.requestId,
                revision: row.revision,
                requestId: row.executionRequestId,
                snapshot: unpack(row, binding),
                state: row.state as StageWriteState,
              }
            : null;
        },
        record: async (attempt, state) => {
          const actor = recordingActor ?? attempt.snapshot.actor;
          if (actor.tenantId !== attempt.snapshot.actor.tenantId) throw conflict();
          return locked(actor, attempt.snapshot.scope, async (tx, rows) => {
            const row = rows.find((r) => r.requestId === attempt.id);
            if (!row || row.revision !== attempt.revision || !row.executionRequestId)
              throw conflict();
            const terminal = ["verified", "not_sent"].includes(row.state);
            if (!terminal) {
              const allowed =
                row.state === "claimed"
                  ? [
                      "provider_accepted",
                      "not_sent",
                      "review_required",
                      "observed_target",
                      "observed_other",
                    ]
                  : row.state === "provider_accepted"
                    ? ["verified", "review_required", "observed_target", "observed_other"]
                    : ["review_required", "observed_target", "observed_other"];
              if (!allowed.includes(state)) throw conflict();
            }
            const next =
              terminal || row.state === state
                ? row
                : await append(tx, actor, attempt.snapshot.scope, rows, { ...row, state });
            return { ...attempt, state: next.state as StageWriteState };
          });
        },
      };
    },
  };
}
