import { z } from "zod/v4";
import { CalendarError } from "../outlook-calendar-core";
import { fingerprint } from "../recruiting-workflows";
import { zohoStageHandoff } from "./zoho-stage-handoff";
import { zohoStageValidation } from "./zoho-stage-validation";
import { zohoCampaignReviews, assertZohoNoteSourceCurrent } from "./zoho-campaign-reviews";
import { zohoInterviewNoteStore } from "./zoho-interview-note-store";
import { zohoStageAuthority } from "./zoho-stage-authority";
import { zohoStagePermission } from "./zoho-stage-permission";
import { zohoStageRequestStore, type StageRequestRecord } from "./zoho-stage-request-store";
import {
  type StageWriteSnapshot,
  type StageWriteActor,
  type StageWriteScope,
} from "./zoho-stage-write-core";

const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const stageRequestInput = z.strictObject({
  expectedRevision: hash,
  requestId: z.uuid(),
  confirm: z.literal(true),
});
export const stageRequestAction = z.strictObject({
  expectedRevision: hash,
  action: z.enum(["approve", "withdraw", "recover"]),
  confirm: z.literal(true),
});
const conflict = () =>
  new CalendarError(
    409,
    "zoho_stage_request_changed",
    "The application, mapping, decision or connection changed. Refresh and prepare a new request.",
  );
export function zohoStageRequests({
  handoff = zohoStageHandoff(),
  validation = zohoStageValidation(),
  reviews = zohoCampaignReviews(),
  permissions = zohoStagePermission(),
  ledger = zohoStageRequestStore(),
  authority = zohoInterviewNoteStore(),
  assertSourceCurrent = assertZohoNoteSourceCurrent,
} = {}) {
  const stageAuthority = zohoStageAuthority({ authority, assertCurrent: assertSourceCurrent });
  async function context(actor: StageWriteActor, scope: StageWriteScope) {
    const h = await handoff.detail(actor, scope.campaignId, scope.recipientId);
    const c = await reviews.noteContext(actor, scope.campaignId, scope.recipientId);
    const permission = await permissions.check(actor, c.accountRef);
    const binding = {
      applicationId: h.applicationId,
      candidateId: h.externalCandidateId,
      jobId: h.externalJobId,
    };
    return { h, c, permission, binding };
  }
  function stale(row: StageRequestRecord, c: Awaited<ReturnType<typeof context>>) {
    return (
      row.snapshot.sourceRevision !== c.h.revision ||
      row.snapshot.connectionRevision !== c.permission.connectionRevision ||
      row.snapshot.writePermissionConfirmed !== c.permission.writeConsentSaved ||
      row.snapshot.accountRef !== c.c.accountRef ||
      row.snapshot.bindingHash !== fingerprint(c.binding)
    );
  }
  const publicRow = (row: StageRequestRecord, c: Awaited<ReturnType<typeof context>>) => ({
    id: row.requestId,
    revision: row.revision,
    state: row.state,
    currentStatus: row.snapshot.currentStatus,
    targetStatus: row.snapshot.targetStatus,
    decision: row.snapshot.decision,
    preparedBy: row.snapshot.actor.id,
    approvedBy: row.approvedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    stale: stale(row, c),
    // Local approval explicitly does not authorize a dispatch or waive provider rules.
    canApprove: row.state === "prepared" && !stale(row, c) && c.h.ready,
    canWithdraw: ["prepared", "approved"].includes(row.state),
    canRecover:
      [
        "claimed",
        "provider_accepted",
        "review_required",
        "observed_target",
        "observed_other",
      ].includes(row.state) &&
      row.snapshot.accountRef === c.c.accountRef &&
      row.snapshot.connectionRevision === c.permission.connectionRevision &&
      row.snapshot.bindingHash === fingerprint(c.binding),
  });
  async function view(actor: StageWriteActor, scope: StageWriteScope) {
    const c = await context(actor, scope);
    const rows = await ledger.list(actor, scope);
    return {
      campaignId: scope.campaignId,
      recipientId: scope.recipientId,
      handoffRevision: c.h.revision,
      writeConsentSaved: c.permission.writeConsentSaved,
      transitionVerified: false as const,
      liveEnabled: false as const,
      canPrepare: c.h.ready && !!c.permission.connectionRevision,
      blocker: !c.permission.connectionRevision
        ? "employer_connection_required"
        : !c.h.ready
          ? "current_decision_and_mapping_required"
          : !c.permission.writeConsentSaved
            ? "employer_write_consent_required"
            : "application_transition_contract_required",
      reason:
        "Requests and approvals are saved locally. Live dispatch is unavailable until the employer's application-specific transition contract is verified. Approval never sends automatically.",
      requests: rows.map((r) => publicRow(r, c)),
    };
  }
  async function checkRemote(
    actor: StageWriteActor,
    scope: StageWriteScope,
    c: Awaited<ReturnType<typeof context>>,
  ) {
    const m = await validation.check(actor, scope.campaignId, scope.recipientId, {
      expectedRevision: c.h.revision,
      confirm: true,
    });
    const after = await context(actor, scope);
    if (
      after.h.revision !== c.h.revision ||
      after.permission.connectionRevision !== c.permission.connectionRevision ||
      after.permission.writeConsentSaved !== c.permission.writeConsentSaved
    )
      throw conflict();
    return m;
  }
  async function fenced<T>(
    actor: StageWriteActor,
    scope: StageWriteScope,
    c: Awaited<ReturnType<typeof context>>,
    work: Parameters<typeof authority.fence<T>>[2],
  ) {
    if (!c.permission.connectionRevision) throw conflict();
    if (!c.permission.custodyRevision || !c.permission.configFingerprint) throw conflict();
    return stageAuthority.fence(
      actor,
      {
        ...c.c,
        sourceConnectionRevision: c.c.connectionRevision,
        connectionRevision: c.permission.connectionRevision,
        custodyRevision: c.permission.custodyRevision,
        configFingerprint: c.permission.configFingerprint,
        mappingRevision: c.h.mapping.revision,
      },
      work,
    );
  }
  const service = {
    view,
    async prepare(
      actor: StageWriteActor,
      scope: StageWriteScope,
      raw: z.infer<typeof stageRequestInput>,
    ) {
      const input = stageRequestInput.parse(raw);
      const c = await context(actor, scope);
      if (
        !c.h.ready ||
        !c.h.decision ||
        !c.h.targetStatus ||
        c.h.revision !== input.expectedRevision ||
        !c.permission.connectionRevision
      )
        throw conflict();
      const m = await checkRemote(actor, scope, c);
      const target = m.mappings.find((r) => r.decision === c.h.decision);
      if (!target || target.result !== "matched" || target.targetStatus !== c.h.targetStatus)
        throw conflict();
      const snapshot: StageWriteSnapshot = {
        actor,
        scope,
        binding: c.binding,
        accountRef: c.c.accountRef,
        connectionRevision: c.permission.connectionRevision,
        sourceRevision: c.h.revision,
        currentStatus: m.currentApplicationStatus,
        targetStatus: c.h.targetStatus,
        targetStage: "Application transition unverified",
        decision: c.h.decision,
        currentHumanDecision: true,
        writePermissionConfirmed: c.permission.writeConsentSaved,
        proof: null,
      };
      await fenced(actor, scope, c, (tx) => ledger.prepare(snapshot, input.requestId, tx));
      return view(actor, scope);
    },
    async act(
      actor: StageWriteActor,
      scope: StageWriteScope,
      requestId: string,
      raw: z.infer<typeof stageRequestAction>,
    ) {
      const input = stageRequestAction.parse(raw);
      z.uuid().parse(requestId);
      const c = await context(actor, scope);
      const row = (await ledger.list(actor, scope)).find((r) => r.requestId === requestId);
      if (!row || row.revision !== input.expectedRevision) throw conflict();
      if (input.action === "withdraw") {
        // Withdrawal is local and remains available when a connection/decision goes stale.
        await ledger.act(actor, scope, requestId, row.revision, "withdrawn");
      } else if (input.action === "approve") {
        if (stale(row, c) || !c.h.ready) throw conflict();
        const remote = await checkRemote(actor, scope, c);
        if (remote.currentApplicationStatus !== row.snapshot.currentStatus) throw conflict();
        await fenced(actor, scope, c, (tx) =>
          ledger.act(actor, scope, requestId, row.revision, "approved", tx),
        );
      } else {
        // Only an actual claimed write can be reconciled. Reading a prepared plan
        // must never manufacture a successful delivery receipt.
        if (!publicRow(row, c).canRecover) throw conflict();
        const binding = c.binding;
        const store = ledger.asWriterStore(binding, actor);
        const attempt = await store.get(actor, scope, requestId);
        if (!attempt) throw conflict();
        await fenced(actor, scope, c, async () => {
          // Read only after locking privacy, staff, source and account authority.
          const remote = await checkRemote(actor, scope, c);
          return store.record(
            attempt,
            remote.currentApplicationStatus === attempt.snapshot.targetStatus
              ? "observed_target"
              : "observed_other",
          );
        });
      }
      return view(actor, scope);
    },
  };
  return {
    ...service,
    /** Explicit route gate: staff + exact campaign/recipient + candidate privacy.
     * Return only operations bound to that authorized scope, never a generic proxy.
     */
    async gateCandidateAccess(actor: StageWriteActor, scope: StageWriteScope) {
      await context(actor, scope);
      return {
        view: () => service.view(actor, scope),
        prepare: (input: z.infer<typeof stageRequestInput>) => service.prepare(actor, scope, input),
        act: (requestId: string, input: z.infer<typeof stageRequestAction>) =>
          service.act(actor, scope, requestId, input),
      };
    },
  };
}
