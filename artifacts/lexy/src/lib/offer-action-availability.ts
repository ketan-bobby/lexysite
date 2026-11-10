import type { ControlledOfferInput, ControlledOfferState } from "@workspace/api-client-react";

/** Mirror current server-owned authority/eligibility, not lifecycle or approval. */
export function canControlOffer(
  action: ControlledOfferInput["action"],
  state: Pick<
    ControlledOfferState,
    "eligible" | "canEdit" | "canApprove" | "canSend" | "canWithdraw" | "canReconcile"
  >,
): boolean {
  switch (action) {
    case "save_draft":
    case "submit_review":
      return state.eligible && state.canEdit;
    case "approve":
      return state.eligible && state.canApprove;
    case "send":
      return state.eligible && state.canSend;
    case "withdraw":
      return state.canWithdraw;
    case "reconcile_delivery":
      return state.canReconcile === true;
  }
}
