import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";
import type { CampaignTx } from "./zoho-interview-campaigns";
import type { zohoStageRequestStore } from "./zoho-stage-request-store";
import {
  stageWriteActorSchema,
  stageWriteScopeSchema,
  stageWriteApprovalSchema,
  stageWriteSnapshotSchema,
  stageWriteRevision,
  stageWriteBlocker,
  zohoStageWriter,
  type StageWriteActor,
  type StageWriteScope,
  type StageWriteSnapshot,
  type StageWriteProvider,
} from "./zoho-stage-write-core";

/** Server-owned authority, including verified transition evidence and SQL locks. */
export interface StageExecutionSource {
  current(actor: StageWriteActor, scope: StageWriteScope): Promise<StageWriteSnapshot>;
  fence<T>(
    actor: StageWriteActor,
    scope: StageWriteScope,
    work: (snapshot: StageWriteSnapshot, tx: CampaignTx) => Promise<T>,
  ): Promise<T>;
}

/**
 * Internal assembly, not a public execution endpoint or a scheduler.
 * All dependencies are mandatory: no default token, fetch, proof or live source.
 * Current public stage requests remain simulation/local-approval only.
 */
export function zohoStageExecution({
  source,
  ledger,
  provider,
  now = Date.now,
}: {
  source: StageExecutionSource;
  ledger: ReturnType<typeof zohoStageRequestStore>;
  provider: StageWriteProvider;
  now?: () => number;
}) {
  const changed = () =>
    new CalendarError(
      409,
      "zoho_stage_execution_changed",
      "The approved request or application changed. Reload and review again.",
    );
  function checked(
    raw: StageWriteSnapshot,
    actor: StageWriteActor,
    scope: StageWriteScope,
    revision?: string,
  ) {
    const s = stageWriteSnapshotSchema.parse(raw);
    if (
      s.actor.id !== actor.id ||
      s.actor.tenantId !== actor.tenantId ||
      s.scope.campaignId !== scope.campaignId ||
      s.scope.recipientId !== scope.recipientId
    )
      throw new CalendarError(404, "not_found", "This stage request is unavailable.");
    if (revision && stageWriteRevision(s) !== revision) throw changed();
    return s;
  }
  function ready(s: StageWriteSnapshot) {
    const blocker = stageWriteBlocker(s, now());
    if (blocker)
      throw new CalendarError(
        409,
        blocker,
        "Verified application transition evidence is required.",
      );
  }
  function inputs(actor: StageWriteActor, scope: StageWriteScope) {
    return { actor: stageWriteActorSchema.parse(actor), scope: stageWriteScopeSchema.parse(scope) };
  }
  return {
    async prepare(
      rawActor: StageWriteActor,
      rawScope: StageWriteScope,
      raw: z.infer<typeof stageWriteApprovalSchema>,
    ) {
      const { actor, scope } = inputs(rawActor, rawScope);
      const input = stageWriteApprovalSchema.parse(raw);
      return source.fence(actor, scope, async (locked, tx) => {
        const s = checked(locked, actor, scope, input.expectedRevision);
        ready(s);
        return ledger.prepare(s, input.requestId, tx);
      });
    },
    async approve(
      rawActor: StageWriteActor,
      rawScope: StageWriteScope,
      requestId: string,
      raw: z.infer<typeof stageWriteApprovalSchema>,
    ) {
      const { actor, scope } = inputs(rawActor, rawScope);
      z.uuid().parse(requestId);
      const input = stageWriteApprovalSchema.parse(raw);
      return source.fence(actor, scope, async (locked, tx) => {
        const s = checked(locked, actor, scope, input.expectedRevision);
        ready(s);
        const row = (await ledger.list(actor, scope, tx)).find((r) => r.requestId === requestId);
        if (!row || row.revision !== input.expectedRevision) throw changed();
        return ledger.act(actor, scope, requestId, row.revision, "approved", tx);
      });
    },
    async execute(
      rawActor: StageWriteActor,
      rawScope: StageWriteScope,
      requestId: string,
      raw: z.infer<typeof stageWriteApprovalSchema>,
    ) {
      const { actor, scope } = inputs(rawActor, rawScope);
      z.uuid().parse(requestId);
      const input = stageWriteApprovalSchema.parse(raw);
      const snapshot = checked(
        await source.current(actor, scope),
        actor,
        scope,
        input.expectedRevision,
      );
      ready(snapshot);
      const row = (await ledger.list(actor, scope)).find((r) => r.requestId === requestId);
      if (
        !row ||
        row.revision !== input.expectedRevision ||
        !row.approvedBy ||
        (row.state !== "approved" && !row.executionRequestId)
      )
        throw changed();
      const store = ledger.asWriterStore(snapshot.binding, actor);
      return zohoStageWriter({
        source,
        now,
        provider,
        store: {
          ...store,
          claim: async (s, approval) => {
            const claim = await store.claim(s, approval);
            if (claim.attempt.id !== requestId) throw changed();
            return claim;
          },
        },
      }).execute(actor, scope, input);
    },
    async recover(rawActor: StageWriteActor, rawScope: StageWriteScope, requestId: string) {
      const { actor, scope } = inputs(rawActor, rawScope);
      z.uuid().parse(requestId);
      const snapshot = checked(await source.current(actor, scope), actor, scope);
      // Recovery may inspect an expired proof, but cannot execute another write.
      return zohoStageWriter({
        source,
        now,
        provider,
        store: ledger.asWriterStore(snapshot.binding, actor),
      }).recover(actor, scope, requestId);
    },
  };
}
