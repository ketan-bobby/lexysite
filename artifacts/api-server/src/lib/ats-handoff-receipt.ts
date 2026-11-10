import { WorkflowConflict } from "./recruiting-workflows";

/** A local human statement, never a remote receipt or an approved offer. */
export function handoffReceipt(
  packet: {
    approvedBy?: string;
    approvedAt?: string;
    exportedBy?: string;
    exportedAt?: string;
    handoffReceipt?: unknown;
  },
  input: { acknowledgeReview?: boolean; evidenceReference?: string },
  actorId: string,
) {
  if (!packet.approvedBy || !packet.approvedAt || !packet.exportedBy || !packet.exportedAt)
    throw new WorkflowConflict(
      "Approve and export this exact packet before recording a manual handoff.",
    );
  if (packet.handoffReceipt)
    throw new WorkflowConflict("This packet already has a manual handoff record.");
  if (
    input.acknowledgeReview !== true ||
    !/^[A-Za-z0-9_.:-]{3,120}$/.test(input.evidenceReference ?? "")
  )
    throw new WorkflowConflict(
      "Confirm the manual handoff and supply a non-sensitive case reference, not a URL or message.",
      400,
    );
  return {
    recordedBy: actorId,
    recordedAt: new Date().toISOString(),
    evidenceReference: input.evidenceReference!,
    verification: "human_reported_only" as const,
  };
}
