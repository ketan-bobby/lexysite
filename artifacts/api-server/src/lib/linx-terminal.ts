/**
 * lib/linx-terminal.ts — Step 4 of the LINX engagement loop.
 *
 * When a LINX-side requisition (a job whose id is pointed at by
 * linx_requests.linx_req_id) reaches a terminal state, reflect it back onto
 * the originating request row so the CLIENT's work order shows the outcome:
 *
 *   hired anywhere on the requisition      → status 'filled'
 *   requisition closed without a hire      → status 'closed'
 *   requisition reopened                   → back to 'accepted' (undo)
 *
 * STATUS FIELD ONLY — no billing, no invoicing, no fee calculation.
 * Agreements and fees live entirely outside the system by design.
 *
 * All entry points are best-effort and never throw: a failure here must not
 * break a hire or a job close. Uses dbAdmin because the linx_requests row
 * spans two tenants (client origin + LINX) and the caller's request GUC may
 * only cover one side; the write is a fixed status transition keyed by
 * linx_req_id, so scoping is inherent to the pointer.
 */
import { eq, and, inArray } from "drizzle-orm";
import { dbAdmin, linxRequestsTable } from "@workspace/db";
import { logger } from "./logger.js";

/** requisition terminal → request status */
export type LinxTerminalOutcome = "filled" | "closed";

/**
 * Mark the request that materialized requisition `jobId` as filled/closed.
 * Guarded transitions only:
 *   filled: from accepted OR closed (a hire trumps a premature close)
 *   closed: from accepted only (never downgrade filled)
 * No-op when the job is not a LINX requisition or already in that state.
 */
export async function resolveLinxRequisitionTerminal(
  jobId: string,
  outcome: LinxTerminalOutcome,
): Promise<void> {
  try {
    const fromStatuses = outcome === "filled" ? ["accepted", "closed"] : ["accepted"];
    const updated = await dbAdmin
      .update(linxRequestsTable)
      .set({ status: outcome, resolvedAt: new Date() })
      .where(and(
        eq(linxRequestsTable.linxReqId, jobId),
        inArray(linxRequestsTable.status, fromStatuses as any),
      ))
      .returning({ id: linxRequestsTable.id });
    if (updated.length > 0) {
      logger.info({ jobId, outcome, requestIds: updated.map(u => u.id) },
        "[linx-terminal] LINX requisition terminal reflected onto request");
    }
  } catch (err) {
    logger.error({ err, jobId, outcome }, "[linx-terminal] failed to reflect terminal status (non-fatal)");
  }
}

/**
 * Reopening a closed LINX requisition undoes a terminal 'filled'/'closed'
 * back to 'accepted' so the loop can complete again later.
 */
export async function revertLinxRequisitionTerminal(jobId: string): Promise<void> {
  try {
    const updated = await dbAdmin
      .update(linxRequestsTable)
      .set({ status: "accepted", resolvedAt: null })
      .where(and(
        eq(linxRequestsTable.linxReqId, jobId),
        inArray(linxRequestsTable.status, ["filled", "closed"] as any),
      ))
      .returning({ id: linxRequestsTable.id });
    if (updated.length > 0) {
      logger.info({ jobId, requestIds: updated.map(u => u.id) },
        "[linx-terminal] requisition reopened — request reverted to accepted");
    }
  } catch (err) {
    logger.error({ err, jobId }, "[linx-terminal] failed to revert terminal status (non-fatal)");
  }
}
