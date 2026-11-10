import type { ControlledOffer } from "@workspace/api-client-react";

/** Mirror the server's human-owned draft lifecycle, not delivery authority. */
export function offerDraftAvailability(
  status: ControlledOffer["status"] | undefined,
  canEdit: boolean,
  eligible: boolean,
): "edit" | "replace" | "none" {
  if (!canEdit || !eligible) return "none";
  if (!status || ["draft", "review_required", "approved"].includes(status)) return "edit";
  if (status === "expired" || status === "withdrawn") return "replace";
  return "none";
}
