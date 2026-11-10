import type { OfferInboxEntry } from "@workspace/api-client-react";

// Every server action must explicitly declare its inbox placement.
const NEEDS_ACTION: Record<OfferInboxEntry["nextAction"], boolean> = {
  prepare: true,
  review: true,
  send: true,
  external_handoff: true,
  blocked: true,
  monitor: false,
};

export function offerInboxNeedsAction(action: OfferInboxEntry["nextAction"]): boolean {
  return NEEDS_ACTION[action] === true;
}
