import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { CalendarError } from "../outlook-calendar-core";
import { fingerprint } from "../recruiting-workflows";
import { zohoStageHandoff } from "./zoho-stage-handoff";
import { zohoStageValidation } from "./zoho-stage-validation";
import { zohoCampaignReviews, assertZohoNoteSourceCurrent } from "./zoho-campaign-reviews";
import { zohoInterviewNoteStore } from "./zoho-interview-note-store";
import { zohoStageAuthority } from "./zoho-stage-authority";
import { zohoStagePermission } from "./zoho-stage-permission";
import { zohoStageRuleStore } from "./zoho-stage-rule-store";
import {
  ruleInput,
  ruleAction,
  ruleBaseSchema,
  ruleConflict,
  RULE_TTL,
  sameRuleBase,
  evidenceReferences,
  type StageRuleEntry,
  type StageRuleRecord,
} from "./zoho-stage-rule-policy";
import {
  stageWriteActorSchema,
  stageWriteScopeSchema,
  stageWriteSnapshotSchema,
  type StageWriteActor,
  type StageWriteScope,
  type StageWriteSnapshot,
} from "./zoho-stage-write-core";
import type { CampaignTx } from "./zoho-interview-campaigns";
import type { z } from "zod/v4";

type Actor = StageWriteActor;
type Scope = StageWriteScope;
/** Employer-human evidence workflow. Never constructs a provider or sends an update. */
export function zohoStageRules({
  handoff = zohoStageHandoff(),
  validation = zohoStageValidation(),
  reviews = zohoCampaignReviews(),
  permissions = zohoStagePermission(),
  store = zohoStageRuleStore(),
  authority = zohoInterviewNoteStore(),
  assertSourceCurrent = assertZohoNoteSourceCurrent,
  now = Date.now,
} = {}) {
  const barrier = zohoStageAuthority({ authority, assertCurrent: assertSourceCurrent });
  async function context(actor: Actor, scope: Scope) {
    stageWriteActorSchema.parse(actor);
    stageWriteScopeSchema.parse(scope);
    const h = await handoff.detail(actor, scope.campaignId, scope.recipientId);
    const c = await reviews.noteContext(actor, scope.campaignId, scope.recipientId);
    if (
      c.tenantId !== actor.tenantId ||
      c.campaignId !== scope.campaignId ||
      c.recipientId !== scope.recipientId ||
      c.externalCandidateId !== h.externalCandidateId ||
      c.externalJobId !== h.externalJobId ||
      c.applicationId !== h.applicationId
    )
      throw ruleConflict();
    const permission = await permissions.check(actor, c.accountRef);
    const binding = {
      applicationId: h.applicationId,
      candidateId: h.externalCandidateId,
      jobId: h.externalJobId,
    };
    return { h, c, permission, binding };
  }
  type Context = Awaited<ReturnType<typeof context>>;
  const connected = (c: Context) =>
    !!(
      c.permission.connectionRevision &&
      c.permission.custodyRevision &&
      c.permission.configFingerprint
    );
  const ready = (c: Context) =>
    connected(c) &&
    c.permission.writeConsentSaved &&
    c.h.ready &&
    !!c.h.decision &&
    !!c.h.targetStatus;
  function local(c: Context) {
    return {
      tenantId: c.c.tenantId,
      campaignId: c.c.campaignId,
      recipientId: c.c.recipientId,
      bindingHash: fingerprint(c.binding),
      accountRef: c.c.accountRef,
      sourceRevision: c.h.revision,
      sourceEvidenceHash: c.c.sourceEvidenceHash,
      latestReviewId: c.c.latestReviewId,
      sourceConnectionRevision: c.c.connectionRevision,
      connectionRevision: c.permission.connectionRevision,
      custodyRevision: c.permission.custodyRevision,
      configFingerprint: c.permission.configFingerprint,
      mappingRevision: c.h.mapping.revision,
      targetStatus: c.h.targetStatus,
      decision: c.h.decision,
    };
  }
  function localMatches(row: StageRuleEntry, c: Context) {
    const { currentStatus: _status, catalogRevision: _catalog, ...rest } = row.record.base;
    return fingerprint(rest) === fingerprint(local(c));
  }
  function authorityContext(c: Context) {
    if (
      !c.permission.connectionRevision ||
      !c.permission.custodyRevision ||
      !c.permission.configFingerprint
    )
      throw ruleConflict();
    return {
      ...c.c,
      sourceConnectionRevision: c.c.connectionRevision,
      connectionRevision: c.permission.connectionRevision,
      custodyRevision: c.permission.custodyRevision,
      configFingerprint: c.permission.configFingerprint,
      mappingRevision: c.h.mapping.revision,
    };
  }
  async function remote(actor: Actor, scope: Scope, c: Context) {
    if (!ready(c)) throw ruleConflict();
    const m = await validation.check(actor, scope.campaignId, scope.recipientId, {
      expectedRevision: c.h.revision,
      confirm: true,
    });
    const after = await context(actor, scope);
    const target = m.mappings.find((item) => item.decision === c.h.decision);
    if (
      fingerprint(local(after)) !== fingerprint(local(c)) ||
      !ready(after) ||
      !m.identityVerified ||
      m.handoffRevision !== c.h.revision ||
      m.mappingRevision !== c.h.mapping.revision ||
      m.connectionRevision !== c.c.connectionRevision ||
      m.applicationId !== c.binding.applicationId ||
      m.externalCandidateId !== c.binding.candidateId ||
      m.externalJobId !== c.binding.jobId ||
      target?.result !== "matched" ||
      target.targetStatus !== c.h.targetStatus
    )
      throw ruleConflict();
    return ruleBaseSchema.parse({
      ...local(c),
      currentStatus: m.currentApplicationStatus,
      catalogRevision: m.catalogRevision,
    });
  }
  async function reviewers(tx: CampaignTx, actor: Actor, ids: string[]) {
    for (const id of [...new Set(ids)].sort()) {
      const result = await tx.execute(sql`SELECT id FROM users WHERE id=${id}
        AND tenant_id=${actor.tenantId} AND role='tenant_admin' AND status='active'
        AND account_erased_at IS NULL FOR SHARE`);
      if (result.rows.length !== 1) throw ruleConflict();
    }
  }
  const publicRecord = ({ record: r, revision }: StageRuleEntry) => ({
    id: r.id,
    revision,
    state: r.state,
    currentStatus: r.base.currentStatus,
    targetStatus: r.base.targetStatus,
    decision: r.base.decision,
    evidence: r.evidence,
    submittedBy: r.submittedBy,
    submittedAt: r.submittedAt,
    verifiedBy: r.verifiedBy,
    verifiedAt: r.verifiedAt,
    expiresAt: r.expiresAt,
    reviewReference: r.reviewReference,
    revokedBy: r.revokedBy,
  });
  function status(latest: StageRuleEntry | undefined, c: Context) {
    if (latest?.record.state === "revoked") return "revoked" as const;
    if (!ready(c)) return "unavailable" as const;
    if (!latest) return "proposal_required" as const;
    if (!localMatches(latest, c) || latest.record.submittedAt > now()) return "stale" as const;
    if (latest.record.state === "verified")
      return latest.record.expiresAt! <= now() || latest.record.verifiedAt! > now()
        ? ("expired" as const)
        : ("verified" as const);
    return now() - latest.record.submittedAt > 24 * 60 * 60_000
      ? ("expired" as const)
      : ("pending_review" as const);
  }
  async function view(actor: Actor, scope: Scope) {
    const c = await context(actor, scope),
      rows = await store.list(actor, scope),
      latest = rows.at(-1);
    const currentStatus = status(latest, c);
    return {
      ...scope,
      sourceRevision: c.h.revision,
      currentApplication: c.binding,
      status: currentStatus,
      canPropose: ready(c),
      canVerify: currentStatus === "pending_review" && latest!.record.submittedBy !== actor.id,
      canRevoke: !!latest && latest.record.state !== "revoked" && connected(c),
      liveEnabled: false as const,
      reason:
        (currentStatus === "unavailable"
          ? "An approved human decision, target mapping, current authorized employer connection and saved stage-write consent are required to propose or verify evidence. "
          : currentStatus === "pending_review"
            ? "A separate authorized employer administrator must independently review the specific evidence references. "
            : currentStatus === "stale"
              ? "The saved source, mapping or connection changed. Submit a new evidence proposal for the current source. "
              : currentStatus === "expired"
                ? "This evidence review expired. A new proposal and independent review are required; it will not renew automatically. "
                : currentStatus === "revoked"
                  ? "This rule was revoked locally and cannot be used. "
                  : "") +
        "This records employer-human review of supporting evidence, not provider-certified allowed next actions. Verification lasts 15 minutes and is rechecked before use. This evidence workflow never executes changes; the separate execution workflow checks server activation and current authority. Unsupported Blueprint actions, extra mandatory fields, automatic messages or cross-application changes must not be approved.",
      currentRule: latest ? publicRecord(latest) : null,
      history: rows.map(publicRecord),
    };
  }
  async function replay(actor: Actor, scope: Scope, requestId: string, commandHash: string) {
    const row = (await store.list(actor, scope)).find((entry) => entry.requestId === requestId);
    if (row && row.commandHash !== commandHash) throw ruleConflict();
    return !!row;
  }
  const service = {
    view,
    async propose(actor: Actor, scope: Scope, raw: z.infer<typeof ruleInput>) {
      const input = ruleInput.parse(raw),
        c = await context(actor, scope);
      const commandHash = fingerprint({ actor, scope, input, operation: "propose" });
      if (await replay(actor, scope, input.requestId, commandHash)) return view(actor, scope);
      if (!ready(c) || c.h.revision !== input.expectedRevision) throw ruleConflict();
      const base = await remote(actor, scope, c);
      await barrier.fence(actor, authorityContext(c), async (tx) => {
        const latest = (await store.list(actor, scope, tx)).at(-1);
        if ((latest?.revision ?? null) !== input.expectedRuleRevision) throw ruleConflict();
        const record: StageRuleRecord = {
          id: randomUUID(),
          state: "proposed",
          base,
          evidence: input.evidence,
          submittedBy: actor.id,
          submittedAt: now(),
          verifiedBy: null,
          verifiedAt: null,
          expiresAt: null,
          reviewReference: null,
          revokedBy: null,
          revokedAt: null,
        };
        await store.append(
          actor,
          scope,
          input.expectedRuleRevision,
          input.requestId,
          commandHash,
          record,
          tx,
        );
      });
      return view(actor, scope);
    },
    async act(actor: Actor, scope: Scope, ruleId: string, raw: z.infer<typeof ruleAction>) {
      const input = ruleAction.parse(raw),
        c = await context(actor, scope);
      const commandHash = fingerprint({ actor, scope, ruleId, input, operation: "act" });
      if (await replay(actor, scope, input.requestId, commandHash)) return view(actor, scope);
      const current = (await store.list(actor, scope)).at(-1);
      if (
        !current ||
        current.record.id !== ruleId ||
        current.revision !== input.expectedRevision ||
        current.record.state === "revoked"
      )
        throw ruleConflict();
      let verifiedBase: Awaited<ReturnType<typeof remote>> | undefined;
      if (input.action === "verify") {
        if (current.record.submittedBy === actor.id)
          throw new CalendarError(
            403,
            "zoho_rule_independent_reviewer_required",
            "A different authorized employer administrator must independently review this evidence.",
          );
        if (
          status(current, c) !== "pending_review" ||
          !input.reviewReference ||
          evidenceReferences(current.record.evidence).some(
            (ref) => ref.toLowerCase() === input.reviewReference!.toLowerCase(),
          )
        )
          throw ruleConflict();
        verifiedBase = await remote(actor, scope, c);
        if (!sameRuleBase(current.record.base, verifiedBase)) throw ruleConflict();
      }
      await barrier.fence(actor, authorityContext(c), async (tx) => {
        const fresh = (await store.list(actor, scope, tx)).at(-1);
        if (!fresh || fresh.revision !== input.expectedRevision || fresh.record.id !== ruleId)
          throw ruleConflict();
        await reviewers(
          tx,
          actor,
          input.action === "verify" ? [fresh.record.submittedBy, actor.id] : [actor.id],
        );
        const at = now();
        if (
          input.action === "verify" &&
          (!verifiedBase ||
            !sameRuleBase(fresh.record.base, verifiedBase) ||
            at < fresh.record.submittedAt ||
            at - fresh.record.submittedAt > 24 * 60 * 60_000)
        )
          throw ruleConflict();
        const record: StageRuleRecord =
          input.action === "verify"
            ? {
                ...fresh.record,
                state: "verified",
                verifiedBy: actor.id,
                verifiedAt: at,
                expiresAt: at + RULE_TTL,
                reviewReference: input.reviewReference!,
              }
            : { ...fresh.record, state: "revoked", revokedBy: actor.id, revokedAt: at };
        await store.append(actor, scope, fresh.revision, input.requestId, commandHash, record, tx);
      });
      return view(actor, scope);
    },
    /**
     * Server-only loader: never returns a lock-free reusable authority token.
     * Future execution must use the same locked transaction and recheck expiry
     * immediately before provider invocation. This does not dispatch anything.
     */
    async withVerifiedRule<T>(
      actor: Actor,
      scope: Scope,
      expectedRevision: string,
      work: (
        evidence: {
          proof: NonNullable<StageWriteSnapshot["proof"]>;
          ruleRevision: string;
          snapshot: StageWriteSnapshot;
          context: ReturnType<typeof authorityContext>;
        },
        tx: CampaignTx,
      ) => Promise<T>,
    ) {
      const c = await context(actor, scope),
        base = await remote(actor, scope, c);
      return barrier.fence(actor, authorityContext(c), async (tx) => {
        const latest = (await store.list(actor, scope, tx)).at(-1);
        if (
          !latest ||
          latest.revision !== expectedRevision ||
          latest.record.state !== "verified" ||
          !sameRuleBase(latest.record.base, base) ||
          status(latest, c) !== "verified"
        )
          throw ruleConflict();
        const r = latest.record;
        await reviewers(tx, actor, [r.submittedBy, r.verifiedBy!]);
        if (status(latest, c) !== "verified") throw ruleConflict();
        const proof = stageWriteSnapshotSchema.shape.proof.unwrap().parse({
          contract: "recruit-candidate-job-status-v2",
          evidenceReference: `zoho-rule:${r.id}:${latest.revision}`,
          accountRef: base.accountRef,
          connectionRevision: base.connectionRevision,
          ...c.binding,
          fromStatus: base.currentStatus,
          toStatus: base.targetStatus,
          verifiedBy: r.verifiedBy,
          verifiedAt: r.verifiedAt,
          expiresAt: r.expiresAt,
          employerWriteApproved: true,
          applicationTransitionVerified: true,
          sideEffectsReviewed: true,
        });
        const snapshot = stageWriteSnapshotSchema.parse({
          actor,
          scope,
          binding: c.binding,
          accountRef: base.accountRef,
          connectionRevision: base.connectionRevision,
          sourceRevision: base.sourceRevision,
          currentStatus: base.currentStatus,
          targetStatus: base.targetStatus,
          targetStage: base.targetStatus,
          decision: base.decision,
          currentHumanDecision: true,
          writePermissionConfirmed: true,
          proof,
        });
        return work(
          {
            proof,
            ruleRevision: latest.revision,
            snapshot,
            context: authorityContext(c),
          },
          tx,
        );
      });
    },
    async gateCandidateAccess(actor: Actor, scope: Scope) {
      await context(actor, scope);
      return {
        view: () => service.view(actor, scope),
        propose: (input: z.infer<typeof ruleInput>) => service.propose(actor, scope, input),
        act: (ruleId: string, input: z.infer<typeof ruleAction>) =>
          service.act(actor, scope, ruleId, input),
      };
    },
  };
  return service;
}
