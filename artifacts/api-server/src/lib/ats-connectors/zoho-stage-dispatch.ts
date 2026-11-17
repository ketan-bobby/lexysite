import { AsyncLocalStorage } from "node:async_hooks";
import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";
import { fingerprint } from "../recruiting-workflows";
import { zohoStageRules } from "./zoho-stage-rules";
import { zohoStageConnection } from "./zoho-stage-connection";
import { zohoStageExecution } from "./zoho-stage-execution";
import { zohoStageRequestStore } from "./zoho-stage-request-store";
import { zohoStageRequests } from "./zoho-stage-requests";
import {
  stageWriteRevision,
  stageWriteBlocker,
  type StageWriteActor,
  type StageWriteScope,
  type StageWriteSnapshot,
} from "./zoho-stage-write-core";
import type { CampaignTx } from "./zoho-interview-campaigns";
import type { StageAuthorityContext } from "./zoho-stage-authority";
import {
  stageResolutionInput,
  stageRequestHeld,
  stageRequestClosed,
  stageResolutionPublic,
} from "./zoho-stage-resolution-policy";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const stageDispatchInput = z.strictObject({
  expectedRevision: hash,
  expectedRuleRevision: hash,
  requestId: z.uuid(),
  confirm: z.literal(true),
});
export const stageDispatchAction = z.strictObject({
  expectedRevision: hash,
  expectedRuleRevision: hash.nullable(),
  requestId: z.uuid(),
  action: z.enum(["approve", "execute", "withdraw", "recover"]),
  confirm: z.literal(true),
});
const changed = () =>
  new CalendarError(
    409,
    "zoho_stage_dispatch_changed",
    "The request, evidence or employer authority changed. Reload and review again.",
  );

/** Explicit staff-only dispatch. No scheduler or default activation. Never contact a
 * provider from GET; all remote reads/writes require deliberate POST commands. */
export function zohoStageDispatch({
  rules = zohoStageRules(),
  ledger = zohoStageRequestStore(undefined, "execution"),
  recovery = zohoStageRequests(),
  connectionFactory = zohoStageConnection,
  enabled = () => process.env.ZOHO_STAGE_EXECUTION_ENABLED === "true",
  now = Date.now,
} = {}) {
  async function view(actor: StageWriteActor, scope: StageWriteScope) {
    const w = await rules.view(actor, scope);
    const recoverable = await recovery.view(actor, scope);
    const rows = await ledger.list(actor, scope);
    const rule = w.currentRule;
    const verified = w.status === "verified" && !!rule;
    const held = rows.some(stageRequestHeld);
    const liveEnabled = enabled();
    const closed = rows.filter(stageRequestClosed);
    const closedAt = Math.max(-1, ...closed.map((r) => r.resolution!.review!.at));
    const closedSequence = Math.max(0, ...closed.map((r) => r.sequence));
    const freshAfterClosure = !closed.length || (!!rule?.verifiedAt && rule.verifiedAt > closedAt);
    const alreadyTarget = rule?.currentStatus === rule?.targetStatus && !!rule;
    const existingForEvidence =
      !!rule &&
      rows.some(
        (r) =>
          r.purpose === "execution" &&
          r.state !== "withdrawn" &&
          r.snapshot.sourceRevision === w.sourceRevision &&
          r.snapshot.bindingHash === fingerprint(w.currentApplication) &&
          r.snapshot.proof?.evidenceReference.endsWith(`:${rule.revision}`),
      );
    return {
      ...scope,
      handoffRevision: w.sourceRevision,
      ruleRevision: rule?.revision ?? null,
      transitionVerified: verified,
      liveEnabled,
      canPrepare: verified && !held && !alreadyTarget && !existingForEvidence && freshAfterClosure,
      reason: held
        ? "An earlier attempt remains held. Use read-only recovery, then a separate independently reviewed closure. Nothing retries automatically."
        : !freshAfterClosure
          ? "An earlier uncertainty was closed administratively. Obtain a new independent transition-evidence review before preparing and approving any later stage change."
          : alreadyTarget
            ? "The evidence already observed the target status. No change is needed; this is not proof of Lexy delivery."
            : existingForEvidence
              ? "A request for this exact evidence already exists. Use its remaining actions. A finished request needs a new evidence review before another preparation."
              : !verified
                ? "Current application-specific evidence and independent employer review are required."
                : !liveEnabled
                  ? "Execution is disabled on this server. Preparation and approval never send."
                  : "Execution requires a separate deliberate action on the exact approved request. No automatic retries.",
      requests: rows
        .filter((r) => r.purpose === "execution")
        .map((r) => {
          const evidenceMatches =
            verified &&
            r.snapshot.proof?.evidenceReference.endsWith(`:${rule!.revision}`) === true &&
            r.snapshot.bindingHash === fingerprint(w.currentApplication) &&
            r.snapshot.sourceRevision === w.sourceRevision;
          const { bindingHash: _bindingHash, proof, ...frozen } = r.snapshot;
          const stale =
            !evidenceMatches ||
            !freshAfterClosure ||
            (r.preparedSequence ?? r.sequence) <= closedSequence ||
            !r.snapshot.proof ||
            !!stageWriteBlocker(
              {
                ...frozen,
                binding: w.currentApplication,
                proof: proof ? { ...proof, ...w.currentApplication } : null,
              },
              now(),
            );
          return {
            id: r.requestId,
            revision: r.revision,
            state: r.state,
            currentStatus: r.snapshot.currentStatus,
            targetStatus: r.snapshot.targetStatus,
            decision: r.snapshot.decision,
            preparedBy: r.snapshot.actor.id,
            approvedBy: r.approvedBy,
            createdAt: r.createdAt,
            updatedAt: r.updatedAt,
            stale,
            canApprove: r.state === "prepared" && !stale && !held,
            canWithdraw: ["prepared", "approved"].includes(r.state),
            canRecover:
              stageRequestHeld(r) &&
              recoverable.requests.some((saved) => saved.id === r.requestId && saved.canRecover),
            canExecute: liveEnabled && r.state === "approved" && !stale && !held,
            executionRequestId: r.executionRequestId,
            sequence: r.sequence,
            resolution: stageResolutionPublic(r.resolution),
            canProposeResolution:
              ["observed_target", "observed_other"].includes(r.state) &&
              !stageRequestClosed(r) &&
              recoverable.requests.some((saved) => saved.id === r.requestId && saved.canRecover),
            canReviewResolution:
              !!r.resolution &&
              !r.resolution.review &&
              r.resolution.proposedBy !== actor.id &&
              r.resolution.sourceHash === recoverable.resolutionSourceHash &&
              now() >= r.resolution.proposedAt &&
              now() - r.resolution.proposedAt <= 15 * 60_000 &&
              recoverable.requests.some((saved) => saved.id === r.requestId && saved.canRecover),
          };
        }),
    };
  }

  async function executor(actor: StageWriteActor, scope: StageWriteScope, ruleRevision: string) {
    // All context and provider metadata reads happen before taking the SQL fence.
    const load = () => rules.withVerifiedRule(actor, scope, ruleRevision, async (e) => e);
    const initial = await load();
    const active = new AsyncLocalStorage<{ snapshot: StageWriteSnapshot; tx: CampaignTx }>();
    const connection = await connectionFactory({
      // Replace, rather than nest, the connection's fence. The verified-rule
      // loader owns the same complete source/custody/staff SQL authority barrier.
      authority: {
        async fence<T>(
          caller: StageWriteActor,
          context: StageAuthorityContext,
          work: (tx: CampaignTx) => Promise<T>,
        ) {
          if (caller.id !== actor.id || caller.tenantId !== actor.tenantId) throw changed();
          return rules.withVerifiedRule(actor, scope, ruleRevision, async (e, tx) => {
            if (fingerprint(e.context) !== fingerprint(context)) throw changed();
            return active.run({ snapshot: e.snapshot, tx }, () => work(tx));
          });
        },
      },
    }).connect(actor, initial.context);
    return zohoStageExecution({
      ledger,
      provider: {
        read: connection.provider.read,
        change: async (snapshot) => {
          // Repeat activation immediately before invocation, including after a
          // slow provider preflight. A disabled server must not issue a write.
          if (!enabled()) return "rejected" as const;
          return connection.provider.change(snapshot);
        },
      },
      now,
      source: {
        current: async (caller, requested) => {
          if (
            fingerprint(caller) !== fingerprint(actor) ||
            fingerprint(requested) !== fingerprint(scope)
          )
            throw changed();
          return (await load()).snapshot;
        },
        fence: async (caller, requested, work) => {
          if (
            fingerprint(caller) !== fingerprint(actor) ||
            fingerprint(requested) !== fingerprint(scope)
          )
            throw changed();
          return connection.fence(async (tx) => {
            const held = active.getStore();
            if (!held || held.tx !== tx) throw changed();
            return work(held.snapshot, tx);
          });
        },
      },
    });
  }
  const service = {
    view,
    async resolve(
      actor: StageWriteActor,
      scope: StageWriteScope,
      id: string,
      raw: z.infer<typeof stageResolutionInput>,
    ) {
      const input = stageResolutionInput.parse(raw);
      z.uuid().parse(id);
      await rules.view(actor, scope);
      await recovery.resolve(actor, scope, id, input);
      return view(actor, scope);
    },
    async prepare(
      actor: StageWriteActor,
      scope: StageWriteScope,
      raw: z.infer<typeof stageDispatchInput>,
    ) {
      const input = stageDispatchInput.parse(raw);
      const w = await view(actor, scope);
      const replay = (await ledger.list(actor, scope)).find(
        (r) => r.purpose === "execution" && r.prepareRequestId === input.requestId,
      );
      if (replay) {
        if (
          replay.snapshot.sourceRevision !== input.expectedRevision ||
          !replay.snapshot.proof?.evidenceReference.endsWith(`:${input.expectedRuleRevision}`)
        )
          throw changed();
        return w; // Exact preparation replay returns history without another provider read.
      }
      if (
        !w.canPrepare ||
        w.handoffRevision !== input.expectedRevision ||
        w.ruleRevision !== input.expectedRuleRevision
      )
        throw changed();
      const service = await executor(actor, scope, input.expectedRuleRevision);
      // Derive the content revision only on the server; never accept browser proof.
      const revision = await rules.withVerifiedRule(
        actor,
        scope,
        input.expectedRuleRevision,
        async (e) => stageWriteRevision(e.snapshot),
      );
      await service.prepare(actor, scope, {
        expectedRevision: revision,
        requestId: input.requestId,
        confirm: true,
      });
      return view(actor, scope);
    },
    async act(
      actor: StageWriteActor,
      scope: StageWriteScope,
      id: string,
      raw: z.infer<typeof stageDispatchAction>,
    ) {
      const input = stageDispatchAction.parse(raw);
      z.uuid().parse(id);
      await rules.view(actor, scope); // Fresh access/privacy gate, including local-only commands.
      const row = (await ledger.list(actor, scope)).find(
        (r) => r.requestId === id && r.purpose === "execution",
      );
      if (!row || row.revision !== input.expectedRevision) throw changed();
      if (input.action === "withdraw") {
        await ledger.act(actor, scope, id, input.expectedRevision, "withdrawn");
      } else if (input.action === "recover") {
        // Existing recovery is read-only and does not need current write consent,
        // a new proof, or an enabled dispatch switch.
        await recovery.act(actor, scope, id, {
          expectedRevision: input.expectedRevision,
          action: "recover",
          confirm: true,
        });
      } else {
        if (
          !input.expectedRuleRevision ||
          !row.snapshot.proof?.evidenceReference.endsWith(`:${input.expectedRuleRevision}`)
        )
          throw changed();
        if (input.action === "execute" && row.executionRequestId) {
          if (row.executionRequestId !== input.requestId) throw changed();
          return view(actor, scope); // Exact replay returns history, never recontacts Zoho.
        }
        if (input.action === "execute" && !enabled())
          throw new CalendarError(
            409,
            "zoho_stage_execution_disabled",
            "Live Zoho execution is disabled on this server.",
          );
        const service = await executor(actor, scope, input.expectedRuleRevision);
        const approval = {
          expectedRevision: input.expectedRevision,
          requestId: input.requestId,
          confirm: true as const,
        };
        if (input.action === "approve") await service.approve(actor, scope, id, approval);
        else await service.execute(actor, scope, id, approval);
      }
      return view(actor, scope);
    },
    async gateCandidateAccess(actor: StageWriteActor, scope: StageWriteScope) {
      await rules.view(actor, scope);
      return {
        view: () => service.view(actor, scope),
        prepare: (input: z.infer<typeof stageDispatchInput>) =>
          service.prepare(actor, scope, input),
        act: (id: string, input: z.infer<typeof stageDispatchAction>) =>
          service.act(actor, scope, id, input),
        resolve: (id: string, input: z.infer<typeof stageResolutionInput>) =>
          service.resolve(actor, scope, id, input),
      };
    },
  };
  return service;
}
