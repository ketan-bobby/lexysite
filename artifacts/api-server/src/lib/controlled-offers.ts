import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  dbAdmin,
  candidatesTable,
  jobsTable,
  auditLogsTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  type ControlledOfferRecord,
  type ControlledOfferTerms,
} from "@workspace/db";
import type {
  ControlledOfferInput,
  ControlledOfferState,
  PublicControlledOffer,
} from "@workspace/api-zod";
import {
  atomic,
  readBrief,
  approvedJob,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { restrictToRealCandidates } from "./synthetic-fixture-scope";
import { offerView } from "./controlled-offer-view";
import { sendEmail, type SendEmailInput, type SendEmailResult } from "./email";
import { vendorUsageScope } from "./vendor-usage";
import { offerAuthority } from "./offer-routing";

type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
type Handle = Tx | typeof dbAdmin;
type Visibility = (handle: Handle, candidateId: string) => Promise<boolean>;
function conflict(message: string, status = 409): never {
  throw new WorkflowConflict(message, status);
}
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const finalStep = (row: typeof workflows.$inferSelect) =>
  row.steps.find((s) => s.key === "hiring_decision");

/** Called only after the application's existing ownership gate. */
export async function hasControlledOffer(jobId: string, candidateId: string) {
  // A structured decision or designated ownership also reserves the offer process:
  // external and unconfigured managed flows must never fall through legacy fee actions.
  const rows = await dbAdmin
    .select({ id: workflows.id })
    .from(workflows)
    .innerJoin(
      jobsTable,
      and(eq(jobsTable.id, workflows.jobId), eq(jobsTable.tenantId, workflows.tenantId)),
    )
    .where(
      and(
        eq(workflows.jobId, jobId),
        eq(workflows.candidateId, candidateId),
        sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${workflows.steps}) s WHERE s ? 'controlledOffer' OR s ? 'offerRouting' OR s ? 'humanDecision')`,
      ),
    )
    .limit(1);
  return rows.length > 0;
}

async function scopedRow(
  handle: Handle,
  scope: WorkflowScope,
  workflowId: string,
  visible: Visibility,
) {
  const [row] = await handle
    .select()
    .from(workflows)
    .where(
      and(
        eq(workflows.tenantId, scope.tenantId),
        eq(workflows.jobId, scope.jobId),
        eq(workflows.id, workflowId),
      ),
    );
  if (!row || !(await visible(handle, row.candidateId))) conflict("Not found", 404);
  return row;
}

export async function eligibility(
  handle: Handle,
  scope: WorkflowScope,
  row: typeof workflows.$inferSelect,
) {
  const brief = await readBrief(handle, scope);
  if (!approvedJob(brief.job.status)) return "The work order must be approved and active.";
  const [journey] = await handle
    .select()
    .from(journeys)
    .where(
      and(
        eq(journeys.id, row.journeyId),
        eq(journeys.tenantId, scope.tenantId),
        eq(journeys.jobId, scope.jobId),
      ),
    );
  if (
    !journey ||
    journey.status !== "approved" ||
    journey.version !== row.journeyVersion ||
    journey.briefHash !== brief.hash
  )
    return "The work order changed. A current human hiring decision is required.";
  if (row.status !== "completed" || finalStep(row)?.humanDecision?.outcome !== "hire")
    return "A completed, structured human Hire decision is required before preparing an offer.";
  return null;
}

export async function readControlledOffer(
  scope: WorkflowScope,
  workflowId: string,
  visible: Visibility,
): Promise<ControlledOfferState> {
  if (scope.canEdit === false)
    conflict("Offer terms are restricted to authorised hiring staff.", 403);
  const row = await scopedRow(dbAdmin, scope, workflowId, visible);
  const step = finalStep(row);
  const reason = await eligibility(dbAdmin, scope, row);
  const authority = await offerAuthority(dbAdmin, scope, row);
  const ownershipReason = !authority.config
    ? "The employer must explicitly assign offer ownership before preparing an offer."
    : authority.config.mode === "external"
      ? `Offers are managed by the employer in ${authority.config.externalSystem}. Native offer actions are disabled.`
      : null;
  return {
    offer: step?.controlledOffer ? offerView(step.controlledOffer) : null,
    history: (step?.controlledOfferHistory ?? []).map(offerView),
    canEdit: authority.canManageTerms,
    canApprove: authority.canApprove,
    canSend: authority.canSend,
    canWithdraw: authority.canWithdraw,
    canReconcile: authority.canManageTerms || authority.canSend,
    eligible: reason === null && ownershipReason === null,
    reason: ownershipReason ?? reason,
    workflowRevision: row.revision,
  };
}

function validTerms(input: ControlledOfferTerms | undefined): ControlledOfferTerms {
  if (!input) conflict("Offer terms are required.", 400);
  const terms = {
    ...input,
    employerName: input.employerName.trim(),
    roleTitle: input.roleTitle.trim(),
    location: input.location.trim(),
    letter: input.letter.trim(),
  };
  if (!Number.isFinite(terms.amount) || terms.amount <= 0 || !/^[A-Z]{3}$/.test(terms.currency))
    conflict("Use a positive compensation amount and a three-letter currency.", 400);
  if (!terms.employerName || !terms.roleTitle || !terms.location || terms.letter.length < 10)
    conflict("Complete the employer-approved offer terms and letter.", 400);
  const date = new Date(`${terms.startDate}T00:00:00Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== terms.startDate)
    conflict("Start date must be a valid calendar date.", 400);
  const expiry = Date.parse(terms.expiresAt);
  if (
    !Number.isFinite(expiry) ||
    expiry <= Date.now() ||
    new Date(expiry).toISOString().slice(0, 19) !== terms.expiresAt.slice(0, 19)
  )
    conflict("Offer expiry must be a valid future date.", 400);
  return terms;
}

/** Human-authored and explicitly approved. No model calls, stage changes or fees. */
export async function controlControlledOffer(
  scope: WorkflowScope,
  workflowId: string,
  input: ControlledOfferInput,
  visible: Visibility,
  delivery: { baseUrl?: string; send?: (input: SendEmailInput) => Promise<SendEmailResult> } = {},
) {
  if (scope.canEdit === false) conflict("Read-only access.", 403);
  if (input.action === "withdraw" && (input.reason?.trim().length ?? 0) < 10)
    conflict("Give a withdrawal reason of at least 10 characters.", 400);
  let plan: { offer: ControlledOfferRecord; token: string; candidateId: string } | undefined;
  await atomic(scope, `offer.${input.action}`, { ...input, workflowId }, async (tx) => {
    const row = await scopedRow(tx, scope, workflowId, visible);
    const authority = await offerAuthority(tx, scope, row);
    if (!authority.config || authority.config.mode !== "native")
      conflict("Native offer actions require explicit native employer ownership.", 403);
    const authorised =
      input.action === "approve"
        ? authority.canApprove
        : input.action === "reconcile_delivery"
          ? authority.canManageTerms || authority.canSend
          : input.action === "send"
            ? authority.canSend
            : input.action === "withdraw"
              ? authority.canWithdraw
              : authority.canManageTerms;
    if (!authorised)
      conflict("This offer action requires the employer's explicitly designated human.", 403);
    if (row.revision !== input.expectedRevision)
      conflict("Workflow changed. Refresh before applying this action.");
    const step = finalStep(row);
    if (!step) conflict("Not found", 404);
    const blocked = await eligibility(tx, scope, row);
    if (blocked && !["withdraw", "reconcile_delivery"].includes(input.action)) conflict(blocked);
    const previous = step.controlledOffer;
    const now = new Date().toISOString();
    let offer: ControlledOfferRecord;
    if (input.action === "save_draft") {
      if (
        previous &&
        !["draft", "review_required", "approved", "withdrawn", "expired"].includes(
          offerView(previous).status,
        )
      )
        conflict(
          "This offer cannot be edited. Withdraw a sent offer before preparing a replacement; uncertain delivery requires investigation.",
        );
      // A live sent offer is excluded above; an expired one is already closed.
      // Its history and token remain unchanged when a new human draft is saved.
      const [candidate] = await tx
        .select({
          email: candidatesTable.email,
          real: sql<boolean>`${restrictToRealCandidates(candidatesTable.id)}`,
        })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, row.candidateId));
      if (!candidate?.email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(candidate.email))
        conflict("A valid canonical recipient email is required.");
      offer = {
        id: randomUUID(),
        version: (previous?.version ?? 0) + 1,
        status: "draft",
        terms: validTerms(input.terms),
        recipientEmail: candidate.email,
        testOnly: candidate.real !== true,
        createdBy: scope.actorName || scope.actorId,
        createdAt: now,
      };
    } else {
      if (!previous) conflict("Save an offer draft first.");
      offer = { ...previous };
      if (
        !["withdraw", "reconcile_delivery"].includes(input.action) &&
        Date.parse(offer.terms.expiresAt) <= Date.now()
      )
        conflict("This offer has expired.");
      if (input.action === "submit_review") {
        if (offer.status !== "draft") conflict("Only a draft may be submitted for review.");
        offer.status = "review_required";
      } else if (input.action === "approve") {
        if (offer.status !== "review_required")
          conflict("Submit this exact version for review before approving.");
        offer.status = "approved";
        offer.approvedBy = scope.actorName || scope.actorId;
        offer.approvedAt = now;
      } else if (input.action === "send") {
        if (offer.status !== "approved")
          conflict("This exact version must be approved before sending.");
        if (!delivery.baseUrl)
          conflict("A trusted application origin is required before sending.", 400);
        const [candidate] = await tx
          .select({ email: candidatesTable.email })
          .from(candidatesTable)
          .where(eq(candidatesTable.id, row.candidateId));
        if (candidate?.email !== offer.recipientEmail)
          conflict("The recipient changed. Save a fresh draft and review it.");
        const token = randomBytes(32).toString("hex");
        offer.status = "sending";
        offer.deliveryAttemptId = randomUUID();
        delete offer.providerDelivery;
        delete offer.deliveryReconciliation;
        offer.deliveryStartedAt = now;
        offer.tokenHash = digest(token);
        plan = { offer, token, candidateId: row.candidateId };
      } else if (input.action === "reconcile_delivery") {
        if (offerView(offer).status !== "send_uncertain")
          conflict("Only an uncertain delivery may be reconciled. Wait for an active send.");
        if (!offer.deliveryAttemptId || input.deliveryAttemptId !== offer.deliveryAttemptId)
          conflict("The original attempt cannot be identified, or changed. Do not resend.");
        if (!input.deliveryResolution) conflict("Choose a delivery review action.", 400);
        // Only server-written, tenant/candidate/workflow/version/attempt-bound acceptance
        // receipts count. An error or absent row is NEVER proof of no delivery.
        const receipts = await tx
          .select({ metadata: auditLogsTable.metadata })
          .from(auditLogsTable)
          .where(
            and(
              eq(auditLogsTable.tenantId, scope.tenantId),
              eq(auditLogsTable.subjectId, row.candidateId),
              eq(auditLogsTable.subjectType, "candidate"),
              eq(auditLogsTable.actorType, "system"),
              eq(auditLogsTable.channel, "email"),
              eq(auditLogsTable.direction, "outbound"),
              eq(auditLogsTable.action, "offer.delivery"),
              sql`${auditLogsTable.metadata}->>'workflowId' = ${row.id}`,
              sql`${auditLogsTable.metadata}->>'offerId' = ${offer.id}`,
              sql`${auditLogsTable.metadata}->>'version' = ${String(offer.version)}`,
              sql`${auditLogsTable.metadata}->>'deliveryAttemptId' = ${offer.deliveryAttemptId}`,
              sql`${auditLogsTable.metadata}->>'to' = ${offer.recipientEmail}`,
              sql`${auditLogsTable.metadata}->>'messageId' IS NOT NULL`,
            ),
          );
        const ids = [
          ...new Set(
            [
              ...receipts.map((r) => (r.metadata as { messageId?: unknown })?.messageId),
              offer.deliveryReceiptId,
              ...(offer.providerDelivery?.deliveryAttemptId === offer.deliveryAttemptId
                ? [offer.providerDelivery.messageId]
                : []),
            ].filter(
              (id): id is string =>
                typeof id === "string" && id.length > 0 && !/^(sim-|demo-)/.test(id),
            ),
          ),
        ];
        if (ids.length > 1)
          conflict("Conflicting provider receipts require investigation. No retry permitted.");
        const receipt = ids[0];
        if (input.deliveryResolution === "confirmed_not_sent") {
          if (previous.status === "sending")
            conflict(
              "The send has not settled. Investigate the original request before declaring no effect.",
            );
          if (receipt || offer.deliveryReceiptId || offer.sentAt || offer.respondedAt)
            conflict("Delivery evidence exists. This attempt cannot be cleared for retry.");
          if (
            input.acknowledgeNoDelivery !== true ||
            (input.reason?.trim().length ?? 0) < 10 ||
            (input.evidenceReference?.trim().length ?? 0) < 10
          )
            conflict(
              "Confirm provider-verified non-delivery with a written reason and evidence reference.",
              400,
            );
          offer.status = "draft";
          delete offer.approvedBy;
          delete offer.approvedAt;
          delete offer.tokenHash;
          offer.deliveryReconciliation = {
            outcome: "confirmed_not_sent",
            checkedAt: now,
            checkedBy: scope.actorId,
            reason: input.reason!.trim(),
            evidenceReference: input.evidenceReference!.trim(),
          };
        } else {
          offer.status = receipt && offer.tokenHash ? "sent" : previous.status;
          if (offer.status === "sent") {
            offer.sentAt = now;
            offer.deliveryReceiptId = receipt;
          }
          offer.deliveryReconciliation = {
            outcome: offer.status === "sent" ? "provider_accepted" : "uncertain",
            checkedAt: now,
            checkedBy: scope.actorId,
            reason:
              receipt && !offer.tokenHash
                ? "Provider acceptance exists but the original response capability is missing. Investigate; do not resend."
                : receipt
                  ? offer.providerDelivery?.status === "delivered"
                    ? "The provider accepted the original attempt and reported receiving-mail-server delivery. Candidate reading is not confirmed."
                    : "The provider accepted the original attempt. Inbox delivery is not independently confirmed."
                  : "No conclusive attempt-bound acceptance receipt. Errors and missing logs do not prove non-delivery.",
          };
        }
      } else if (input.action === "withdraw") {
        if (["accepted", "declined", "withdrawn"].includes(offer.status))
          conflict("A responded or withdrawn offer cannot be withdrawn.");
        if (offer.status === "sending" && offerView(offer).status !== "send_uncertain")
          conflict("Delivery is in progress. Wait for its result before withdrawing.");
        offer.status = "withdrawn";
        offer.responseReason = input.reason!.trim();
        delete offer.tokenHash;
      }
    }
    const history =
      (input.action === "save_draft" ||
        (input.action === "reconcile_delivery" &&
          input.deliveryResolution === "confirmed_not_sent")) &&
      previous
        ? [...(step.controlledOfferHistory ?? []), previous]
        : (step.controlledOfferHistory ?? []);
    await tx
      .update(workflows)
      .set({
        steps: row.steps.map((s) =>
          s.key === step.key
            ? { ...s, controlledOffer: offer, controlledOfferHistory: history }
            : s,
        ),
        revision: row.revision + 1,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(workflows.id, row.id),
          eq(workflows.tenantId, scope.tenantId),
          eq(workflows.jobId, scope.jobId),
        ),
      );
    return {
      id: row.id,
      workflowId: row.id,
      note: `${offer.testOnly ? "[TEST ONLY] " : ""}Offer ${offer.id} v${offer.version}: ${input.action}. ${input.reason?.trim() ?? ""}${input.action === "reconcile_delivery" ? ` ${offer.deliveryReconciliation?.outcome}: ${offer.deliveryReconciliation?.reason} Evidence: ${offer.deliveryReconciliation?.evidenceReference ?? offer.deliveryReceiptId ?? "none"}. Attempt: ${offer.deliveryAttemptId}.` : ""}`,
    };
  });
  if (plan) {
    const sendPlan = plan;
    let result: SendEmailResult;
    try {
      // Recheck visibility immediately before the irreversible effect.
      const currentRow = await scopedRow(dbAdmin, scope, workflowId, visible);
      if (!(await offerAuthority(dbAdmin, scope, currentRow)).canSend)
        throw new Error("The designated sender no longer has employer authority.");
      const current = await readBrief(dbAdmin, scope);
      if (!approvedJob(current.job.status)) throw new Error("Work order no longer active.");
      const link = `${delivery.baseUrl!.replace(/\/$/, "")}/offer/${sendPlan.token}`;
      const t = sendPlan.offer.terms;
      result = await vendorUsageScope.run(
        { tenantId: scope.tenantId, area: `workflow:${workflowId}:engagement` },
        () =>
          (delivery.send ?? sendEmail)({
            to: sendPlan.offer.recipientEmail,
            subject: `${t.employerName}: offer for ${t.roleTitle}`,
            text: `${sendPlan.offer.testOnly ? "TEST ONLY — controlled internal offer\n\n" : ""}${t.employerName}\n${t.roleTitle}\n${t.amount} ${t.currency} / ${t.frequency}\nLocation: ${t.location}\nStart date: ${t.startDate}\n\n${t.letter}\n\nReview and respond: ${link}\nExpires: ${t.expiresAt}\n\nAn acceptance records your offer response; it does not confirm that employment has started. This link is private: do not forward it.`,
            audit: {
              tenantId: scope.tenantId,
              action: "offer.delivery",
              subjectType: "candidate",
              subjectId: sendPlan.candidateId,
              metadata: {
                offerId: sendPlan.offer.id,
                version: sendPlan.offer.version,
                workflowId,
                deliveryAttemptId: sendPlan.offer.deliveryAttemptId,
              },
            },
          }),
      );
    } catch {
      result = { ok: false, error: "Delivery result is uncertain." };
    }
    await atomic(
      scope,
      "offer.delivery_result",
      {
        idempotencyKey: `offer-delivery:${sendPlan.offer.id}:${digest(input.idempotencyKey)}`,
        offerId: sendPlan.offer.id,
      },
      async (tx) => {
        const [row] = await tx
          .select()
          .from(workflows)
          .where(
            and(
              eq(workflows.id, workflowId),
              eq(workflows.jobId, scope.jobId),
              eq(workflows.tenantId, scope.tenantId),
            ),
          );
        const step = row && finalStep(row);
        if (
          !step?.controlledOffer ||
          step.controlledOffer.id !== sendPlan.offer.id ||
          step.controlledOffer.deliveryAttemptId !== sendPlan.offer.deliveryAttemptId ||
          step.controlledOffer.status !== "sending"
        )
          conflict("Offer delivery state changed.");
        const offer = { ...step.controlledOffer };
        offer.status =
          result.ok && !result.simulated && !result.suppressed
            ? "sent"
            : result.simulated || result.suppressed
              ? "approved"
              : "send_uncertain";
        if (offer.status === "sent") {
          offer.sentAt = new Date().toISOString();
          offer.deliveryReceiptId = result.messageId;
          if (offer.providerDelivery && offer.providerDelivery.messageId !== result.messageId)
            offer.status = "send_uncertain"; // conflicting evidence is held, never erased
        } else if (offer.status === "approved") {
          delete offer.tokenHash;
          delete offer.providerDelivery;
        }
        await tx
          .update(workflows)
          .set({
            steps: row.steps.map((s) =>
              s.key === step.key ? { ...s, controlledOffer: offer } : s,
            ),
            revision: row.revision + 1,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(workflows.id, row.id),
              eq(workflows.tenantId, scope.tenantId),
              eq(workflows.jobId, scope.jobId),
            ),
          );
        return {
          id: row.id,
          workflowId: row.id,
          note: `Offer ${offer.id} delivery: ${offer.status}. ${result.simulated ? "No real email was sent." : "No automatic resend permitted."}`,
        };
      },
    );
  }
  const state = await readControlledOffer(scope, workflowId, visible);
  if (input.action === "send" && state.offer?.status === "approved")
    conflict(
      "No real email was sent. Check the email provider configuration before making a new, explicit send attempt.",
      503,
    );
  if (input.action === "send" && state.offer?.status === "send_uncertain")
    conflict(
      "Delivery is uncertain. Do not resend this offer. Investigate the delivery result or explicitly withdraw it.",
      503,
    );
  return state;
}

export async function lookupPublicOffer(token: string) {
  if (!/^[a-f0-9]{64}$/.test(token)) conflict("Offer unavailable.", 404);
  const hash = digest(token);
  const [row] = await dbAdmin
    .select()
    .from(workflows)
    .where(
      sql`EXISTS (SELECT 1 FROM jsonb_array_elements(${workflows.steps}) s WHERE s->'controlledOffer'->>'tokenHash' = ${hash})`,
    );
  const offer = row && finalStep(row)?.controlledOffer;
  if (
    !row ||
    !offer ||
    offer.tokenHash !== hash ||
    !["sent", "accepted", "declined"].includes(offer.status)
  )
    conflict("Offer unavailable.", 404);
  if (Date.parse(offer.terms.expiresAt) <= Date.now())
    conflict("This offer link has expired.", 410);
  return { row, offer };
}

export function publicOfferView(offer: ControlledOfferRecord): PublicControlledOffer {
  const status =
    offer.status === "sent" && Date.parse(offer.terms.expiresAt) <= Date.now()
      ? "expired"
      : offer.status;
  if (!["sent", "accepted", "declined", "expired"].includes(status))
    conflict("Offer unavailable.", 404);
  return {
    version: offer.version,
    status: status as PublicControlledOffer["status"],
    terms: offer.terms,
    testOnly: offer.testOnly,
    canRespond: status === "sent",
    ...(offer.respondedAt ? { respondedAt: offer.respondedAt } : {}),
    ...(offer.responseReason ? { responseReason: offer.responseReason } : {}),
  };
}

export async function respondControlledOffer(
  token: string,
  decision: "accept" | "decline",
  reason: string | undefined,
  visible: Visibility,
) {
  const { row: original, offer: originalOffer } = await lookupPublicOffer(token);
  if (!(await visible(dbAdmin, original.candidateId))) conflict("Offer unavailable.", 404);
  const target = decision === "accept" ? "accepted" : "declined";
  const scope: WorkflowScope = {
    tenantId: original.tenantId,
    jobId: original.jobId,
    actorId: `offer-recipient:${originalOffer.id}`,
    canApprove: false,
  };
  await atomic(
    scope,
    "offer.recipient_response",
    {
      idempotencyKey: `offer-response:${originalOffer.id}`,
      decision,
      reason: reason?.trim() ?? "",
      offerId: originalOffer.id,
    },
    async (tx) => {
      const row = await scopedRow(tx, scope, original.id, visible);
      const step = finalStep(row)!;
      const offer = step.controlledOffer!;
      if (offer.id !== originalOffer.id || offer.tokenHash !== digest(token))
        conflict("Offer unavailable.", 404);
      if (offer.status !== "sent") conflict("This offer already has a response.");
      if (Date.parse(offer.terms.expiresAt) <= Date.now()) conflict("This offer has expired.", 410);
      const updated: ControlledOfferRecord = {
        ...offer,
        status: target,
        respondedAt: new Date().toISOString(),
        responseReason: reason?.trim() ?? "",
      };
      await tx
        .update(workflows)
        .set({
          steps: row.steps.map((s) =>
            s.key === step.key ? { ...s, controlledOffer: updated } : s,
          ),
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(workflows.id, row.id),
            eq(workflows.tenantId, scope.tenantId),
            eq(workflows.jobId, scope.jobId),
          ),
        );
      return {
        id: row.id,
        workflowId: row.id,
        note: `${offer.testOnly ? "[TEST ONLY] " : ""}Offer ${offer.id} v${offer.version}: recipient ${target}. Not confirmed employment or a fee event.`,
      };
    },
  );
  return publicOfferView((await lookupPublicOffer(token)).offer);
}
