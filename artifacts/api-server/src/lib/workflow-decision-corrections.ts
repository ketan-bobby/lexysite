import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import {
  candidatesTable,
  recruitingJourneysTable as journeys,
  recruitingWorkflowsTable as workflows,
  type WorkflowHumanDecision,
  type ControlledOfferRecord,
} from "@workspace/db";
import type { WorkflowDecisionCorrectionInput } from "@workspace/api-zod";
import {
  atomic,
  approvedJob,
  readBrief,
  WorkflowConflict,
  type WorkflowScope,
} from "./recruiting-workflows";
import { restrictToRealCandidates } from "./synthetic-fixture-scope";

type Transaction = Parameters<Parameters<typeof import("@workspace/db").dbAdmin.transaction>[0]>[0];
function fail(message: string, status = 409): never {
  throw new WorkflowConflict(message, status);
}

export async function correctWorkflowDecision(
  scope: WorkflowScope,
  workflowId: string,
  input: WorkflowDecisionCorrectionInput,
  candidateAllowed: (tx: Transaction, id: string) => Promise<boolean>,
) {
  if (!scope.canApprove || scope.canEdit === false)
    fail("A human approver must correct the final decision.", 403);
  if (input.decisionReason.trim().length < 10 || input.correctionReason.trim().length < 10)
    fail("Both decision and correction reasons require at least 10 characters.", 400);
  return atomic(
    scope,
    input.acknowledgeLegacyCompletion
      ? "workflow.legacy_decision_recorded"
      : "workflow.decision_corrected",
    { ...input, workflowId },
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
        )
        .for("update");
      if (!row || !(await candidateAllowed(tx, row.candidateId))) fail("Not found", 404);
      if (row.revision !== input.expectedRevision)
        fail("Workflow changed. Refresh before correcting the decision.");
      if (!["ready", "completed"].includes(row.status))
        fail("Paused or cancelled workflows cannot be corrected.");
      const [journey] = await tx
        .select()
        .from(journeys)
        .where(
          and(
            eq(journeys.id, row.journeyId),
            eq(journeys.jobId, scope.jobId),
            eq(journeys.tenantId, scope.tenantId),
          ),
        );
      const brief = await readBrief(tx, scope);
      if (
        !approvedJob(brief.job.status) ||
        !journey ||
        journey.status !== "approved" ||
        journey.version !== row.journeyVersion ||
        journey.briefHash !== brief.hash
      )
        fail("The job and original journey must be approved and current before a correction.");
      const final = row.steps.find((s) => s.key === "hiring_decision");
      if (!final) fail("No final decision step exists.");
      const legacy = !final.humanDecision;
      if (
        legacy &&
        (input.acknowledgeLegacyCompletion !== true ||
          final.status !== "completed" ||
          row.status !== "completed" ||
          (final.humanDecisionHistory?.length ?? 0) > 0 ||
          final.controlledOffer)
      )
        fail(
          "No structured human decision exists. Explicitly acknowledge an intact completed legacy note; never infer or overwrite it.",
        );
      if (!legacy && input.acknowledgeLegacyCompletion === true)
        fail("A structured decision already exists. Refresh and use the correction review.", 400);
      if (row.steps.some((s) => s.key !== "hiring_decision" && s.status !== "completed"))
        fail("All preceding evidence reviews must be complete.");
      const previous = final.humanDecision;
      const oldOffer = final.controlledOffer;
      if (oldOffer?.status === "sending")
        fail(
          "Offer delivery is in progress. Resolve delivery before correcting the decision; do not resend.",
        );
      const retained =
        oldOffer &&
        ["sent", "accepted", "declined", "send_uncertain", "expired"].includes(oldOffer.status);
      if (retained && input.acknowledgeDeliveredOffer !== true)
        fail(
          "Acknowledge that the existing sent or uncertain offer remains unchanged. Withdrawal is a separate explicit action.",
        );
      const [candidate] = await tx
        .select({
          testOnly: sql<boolean>`NOT (${restrictToRealCandidates(candidatesTable.id)})`,
        })
        .from(candidatesTable)
        .where(eq(candidatesTable.id, row.candidateId));
      if (!candidate) fail("Not found", 404);
      const now = new Date().toISOString();
      const reset = oldOffer && ["draft", "review_required", "approved"].includes(oldOffer.status);
      const decision: WorkflowHumanDecision = {
        outcome: input.outcome,
        actorId: scope.actorId,
        actorName: scope.actorName?.trim() || scope.actorId,
        decidedAt: now,
        reason: input.decisionReason.trim(),
        testOnly: candidate.testOnly !== false,
        correctionReason: input.correctionReason.trim(),
        ...(previous ? { supersedesDecidedAt: previous.decidedAt } : {}),
        offerEffect: reset ? "approval_reset" : retained ? "sent_retained" : "none",
      };
      const offer: ControlledOfferRecord | undefined = reset
        ? {
            id: randomUUID(),
            version: oldOffer.version + 1,
            status: "draft",
            terms: oldOffer.terms,
            recipientEmail: oldOffer.recipientEmail,
            testOnly: decision.testOnly,
            createdBy: scope.actorId,
            createdAt: now,
          }
        : oldOffer;
      const steps = row.steps.map((s) =>
        s.key !== "hiring_decision"
          ? s
          : {
              ...s, // Original reviewed evidence is deliberately retained.
              status:
                input.outcome === "hold" ? ("review_required" as const) : ("completed" as const),
              humanDecision: decision,
              humanDecisionHistory: [
                ...(s.humanDecisionHistory ?? []),
                ...(previous ? [previous] : []),
              ],
              ...(reset
                ? {
                    controlledOffer: offer,
                    controlledOfferHistory: [...(s.controlledOfferHistory ?? []), oldOffer!],
                  }
                : {}),
            },
      );
      await tx
        .update(workflows)
        .set({
          steps,
          revision: row.revision + 1,
          updatedAt: new Date(),
          status: input.outcome === "hold" ? "ready" : "completed",
        })
        .where(
          and(
            eq(workflows.id, row.id),
            eq(workflows.jobId, scope.jobId),
            eq(workflows.tenantId, scope.tenantId),
          ),
        );
      return {
        id: row.id,
        workflowId: row.id,
        journeyId: row.journeyId,
        note: `${previous ? `Human correction ${previous.outcome} → ${decision.outcome}. Original decision ${previous.decidedAt} retained.` : `First structured human decision: ${decision.outcome}. Legacy note and earlier evidence retained; no prior hiring intent inferred.`}${decision.testOnly ? " [TEST ONLY]" : ""} ${decision.actorName} (${decision.actorId}): ${decision.correctionReason}. New reason: ${decision.reason}. Offer: ${decision.offerEffect}. No employment or fee change.`,
      };
    },
  );
}
