import type { PublicControlledOffer } from "@workspace/api-client-react";

/** A local expiry check supplements, never overrides, server-owned authority. */
export function publicOfferAvailability(
  offer: Pick<PublicControlledOffer, "status" | "canRespond" | "terms"> | undefined,
  now: number,
) {
  const expiry = offer ? Date.parse(offer.terms.expiresAt) : NaN;
  const validTime = Number.isFinite(now) && Number.isFinite(expiry);
  const expired =
    offer?.status === "expired" || (offer?.status === "sent" && validTime && expiry <= now);
  return {
    expired,
    canRespond: Boolean(offer?.status === "sent" && offer.canRespond && validTime && expiry > now),
  };
}
