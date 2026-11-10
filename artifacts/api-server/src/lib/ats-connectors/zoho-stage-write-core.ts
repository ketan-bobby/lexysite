import { createHash } from "node:crypto";
import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";

/**
 * Pre-integration execution protocol. There is deliberately no default provider,
 * database store or route: the existing public handoff remains simulation-only.
 * Production wiring requires a verified Recruit contract, a durable store, and
 * the same staff/privacy/source locks as interview-note publication.
 */
const id = z.string().min(1).max(200);
const externalId = z.string().regex(/^[1-9]\d{0,39}$/);
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const status = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((s) => !/[\u0000-\u001f\u007f]/u.test(s));
export const stageWriteActorSchema = z.strictObject({ id, tenantId: id });
export const stageWriteScopeSchema = z.strictObject({ campaignId: id, recipientId: id });
export const stageWriteBindingSchema = z.strictObject({
  applicationId: externalId,
  candidateId: externalId,
  jobId: externalId,
});
const proofSchema = z.strictObject({
  // A default stage catalogue or transition history cannot supply this proof.
  contract: z.literal("recruit-candidate-job-status-v2"),
  evidenceReference: id,
  accountRef: hash,
  connectionRevision: id,
  applicationId: externalId,
  candidateId: externalId,
  jobId: externalId,
  fromStatus: status,
  toStatus: status,
  verifiedBy: id,
  verifiedAt: z.number().int().nonnegative(),
  expiresAt: z.number().int().nonnegative(),
  employerWriteApproved: z.literal(true),
  applicationTransitionVerified: z.literal(true),
  sideEffectsReviewed: z.literal(true),
});
export const stageWriteSnapshotSchema = z.strictObject({
  actor: stageWriteActorSchema,
  scope: stageWriteScopeSchema,
  binding: stageWriteBindingSchema,
  accountRef: hash,
  connectionRevision: id,
  sourceRevision: hash,
  currentStatus: status,
  targetStatus: status,
  targetStage: status,
  decision: z.enum(["advance", "hold", "decline"]),
  currentHumanDecision: z.boolean(),
  writePermissionConfirmed: z.boolean(),
  proof: proofSchema.nullable(),
});
export const stageWriteApprovalSchema = z.strictObject({
  expectedRevision: hash,
  requestId: z.uuid(),
  confirm: z.literal(true),
});

export type StageWriteActor = z.infer<typeof stageWriteActorSchema>;
export type StageWriteScope = z.infer<typeof stageWriteScopeSchema>;
export type StageWriteBinding = z.infer<typeof stageWriteBindingSchema>;
export type StageWriteSnapshot = z.infer<typeof stageWriteSnapshotSchema>;
export type StageWriteApproval = z.infer<typeof stageWriteApprovalSchema>;
export type StageWriteState =
  | "claimed"
  | "provider_accepted"
  | "verified"
  | "not_sent"
  | "review_required"
  | "observed_target"
  | "observed_other";
export type StageWriteAttempt = {
  id: string;
  revision: string;
  requestId: string;
  snapshot: StageWriteSnapshot;
  state: StageWriteState;
};
export type StageApplication = StageWriteBinding & { currentStatus: string };
export type StageWriteAcknowledgment = "accepted" | "rejected" | "uncertain";

export interface StageWriteStore {
  /**
   * MUST commit an atomic durable claim before returning acquired:true.
   * Scope by tenant + campaign + recipient; dedupe both requestId and revision.
   * Reject reused request IDs with different revisions and block new claims while
   * an earlier attempt is unresolved. Never expire a claim into an automatic retry.
   */
  claim(
    snapshot: StageWriteSnapshot,
    input: StageWriteApproval,
  ): Promise<{ acquired: boolean; attempt: StageWriteAttempt }>;
  get(
    actor: StageWriteActor,
    scope: StageWriteScope,
    attemptId: string,
  ): Promise<StageWriteAttempt | null>;
  /** Append/CAS state changes; preserve the committed claim on any storage error. */
  record(attempt: StageWriteAttempt, state: StageWriteState): Promise<StageWriteAttempt>;
}
export interface StageWriteSource {
  /** Resolve current staff, exact employer, privacy, job, review and mapping authority. */
  current(actor: StageWriteActor, scope: StageWriteScope): Promise<StageWriteSnapshot>;
  /**
   * Revalidate and hold source/permission/erasure locks across provider I/O.
   * Supply the current locked snapshot; do not reacquire the same DB locks from
   * another pooled connection while the fence is held.
   */
  fence<T>(
    actor: StageWriteActor,
    scope: StageWriteScope,
    work: (locked: StageWriteSnapshot) => Promise<T>,
  ): Promise<T>;
}
export interface StageWriteProvider {
  read(binding: StageWriteBinding): Promise<StageApplication>;
  change(snapshot: StageWriteSnapshot): Promise<StageWriteAcknowledgment>;
}
const fail = (code: string, message: string, httpStatus = 409) =>
  new CalendarError(httpStatus, code, message);
const changed = () =>
  fail("zoho_stage_write_changed", "Stage approval is stale. Reload and review again.");
export function stageWriteRevision(raw: StageWriteSnapshot) {
  // Parsing fixes property order and rejects unknown/caller-injected authority.
  const snapshot = stageWriteSnapshotSchema.parse(raw);
  return createHash("sha256").update(JSON.stringify(snapshot)).digest("hex");
}
function authorized(raw: StageWriteSnapshot, actor: StageWriteActor, scope: StageWriteScope) {
  const snapshot = stageWriteSnapshotSchema.parse(raw);
  if (
    snapshot.actor.id !== actor.id ||
    snapshot.actor.tenantId !== actor.tenantId ||
    snapshot.scope.campaignId !== scope.campaignId ||
    snapshot.scope.recipientId !== scope.recipientId
  )
    throw fail("not_found", "This stage update is unavailable.", 404);
  return snapshot;
}
function bindingMatches(a: StageWriteBinding, b: StageWriteBinding) {
  return (
    a.applicationId === b.applicationId && a.candidateId === b.candidateId && a.jobId === b.jobId
  );
}
function observation(snapshot: StageWriteSnapshot, application: StageApplication) {
  const checked = stageWriteBindingSchema.extend({ currentStatus: status }).parse(application);
  if (!bindingMatches(snapshot.binding, checked))
    throw fail("zoho_stage_readback_mismatch", "Zoho returned a different application.");
  return checked.currentStatus;
}
export function stageWriteBlocker(snapshot: StageWriteSnapshot, now: number): string | null {
  if (!snapshot.currentHumanDecision) return "current_human_decision_required";
  // Independent of mapping labels: this executor never issues offers/establishes employment.
  if (
    /offer|hired|joined|onboarding|converted|employee|archived/i.test(
      `${snapshot.targetStage} ${snapshot.targetStatus}`,
    )
  )
    return "separate_human_process";
  if (!snapshot.writePermissionConfirmed) return "employer_write_permission_required";
  const p = snapshot.proof;
  if (
    !p ||
    p.accountRef !== snapshot.accountRef ||
    p.connectionRevision !== snapshot.connectionRevision ||
    !bindingMatches(p, snapshot.binding) ||
    p.fromStatus !== snapshot.currentStatus ||
    p.toStatus !== snapshot.targetStatus
  )
    return "application_transition_contract_required";
  if (
    !Number.isFinite(now) ||
    p.verifiedAt > now ||
    p.expiresAt <= now ||
    p.expiresAt <= p.verifiedAt ||
    p.expiresAt - p.verifiedAt > 15 * 60_000
  )
    return "transition_proof_expired";
  return null;
}

export function zohoStageWriter({
  source,
  store,
  provider,
  now = Date.now,
}: {
  source: StageWriteSource;
  store: StageWriteStore;
  provider: StageWriteProvider;
  now?: () => number;
}) {
  async function current(rawActor: StageWriteActor, rawScope: StageWriteScope) {
    const actor = stageWriteActorSchema.parse(rawActor);
    const scope = stageWriteScopeSchema.parse(rawScope);
    return authorized(await source.current(actor, scope), actor, scope);
  }
  return {
    async preview(actor: StageWriteActor, scope: StageWriteScope) {
      const snapshot = await current(actor, scope);
      const blocker = stageWriteBlocker(snapshot, now());
      return {
        revision: stageWriteRevision(snapshot),
        binding: snapshot.binding,
        currentStatus: snapshot.currentStatus,
        targetStatus: snapshot.targetStatus,
        decision: snapshot.decision,
        ready: blocker === null,
        blocker,
        alreadyAtTarget: snapshot.currentStatus === snapshot.targetStatus,
      };
    },
    async execute(
      actor: StageWriteActor,
      scope: StageWriteScope,
      raw: StageWriteApproval,
    ): Promise<{ attempt: StageWriteAttempt | null; noUpdateNeeded: boolean }> {
      const input = stageWriteApprovalSchema.parse(raw);
      const snapshot = await current(actor, scope);
      if (stageWriteRevision(snapshot) !== input.expectedRevision) throw changed();
      const blocker = stageWriteBlocker(snapshot, now());
      if (blocker) throw fail(blocker, "This stage update is not authorized for live execution.");
      if (snapshot.currentStatus === snapshot.targetStatus)
        return { attempt: null, noUpdateNeeded: true };
      const claim = await store.claim(snapshot, input);
      authorized(claim.attempt.snapshot, actor, scope);
      if (
        claim.attempt.revision !== input.expectedRevision ||
        stageWriteRevision(claim.attempt.snapshot) !== input.expectedRevision
      )
        throw changed();
      if (!claim.acquired) return { attempt: claim.attempt, noUpdateNeeded: false };
      let attempt = claim.attempt;
      // Mark invocation BEFORE calling change: a thrown response/timeout is never retry-safe.
      let invoked = false;
      try {
        attempt = await source.fence(actor, scope, async (rawLocked) => {
          const locked = authorized(rawLocked, actor, scope);
          if (
            stageWriteRevision(locked) !== input.expectedRevision ||
            stageWriteBlocker(locked, now())
          )
            throw changed();
          const before = observation(locked, await provider.read(locked.binding));
          if (before !== locked.currentStatus) throw changed();
          // Proof can expire while waiting for provider reads.
          if (stageWriteBlocker(locked, now())) throw changed();
          invoked = true;
          const result = await provider.change(locked);
          if (result !== "accepted") return store.record(attempt, "review_required");
          attempt = await store.record(attempt, "provider_accepted");
          const after = observation(locked, await provider.read(locked.binding));
          return store.record(
            attempt,
            after === locked.targetStatus ? "verified" : "review_required",
          );
        });
      } catch {
        // Do not expose raw provider/transport/DB errors or assume an unsuccessful
        // response means the provider did not execute. A failed record leaves the
        // earlier durable claim unresolved, which MUST prevent resending.
        attempt = await store.record(attempt, invoked ? "review_required" : "not_sent");
      }
      return { attempt, noUpdateNeeded: false };
    },
    async recover(actor: StageWriteActor, scope: StageWriteScope, attemptId: string) {
      id.parse(attemptId);
      const snapshot = await current(actor, scope);
      const prior = await store.get(actor, scope, attemptId);
      if (!prior) throw fail("not_found", "This stage update is unavailable.", 404);
      const original = authorized(prior.snapshot, actor, scope);
      // An old employer connection cannot authorize reads on its replacement.
      if (
        original.accountRef !== snapshot.accountRef ||
        original.connectionRevision !== snapshot.connectionRevision ||
        !bindingMatches(original.binding, snapshot.binding)
      )
        throw changed();
      if (prior.state === "verified" || prior.state === "not_sent") return prior;
      return source.fence(actor, scope, async (rawLocked) => {
        const locked = authorized(rawLocked, actor, scope);
        if (
          locked.accountRef !== original.accountRef ||
          locked.connectionRevision !== original.connectionRevision ||
          !bindingMatches(locked.binding, original.binding)
        )
          throw changed();
        const value = observation(original, await provider.read(original.binding));
        // Read-back after an uncertain/crashed write is observation, NOT attribution.
        // Recovery never calls change(), even when the old status is still present.
        return store.record(
          prior,
          value === original.targetStatus ? "observed_target" : "observed_other",
        );
      });
    },
  };
}
