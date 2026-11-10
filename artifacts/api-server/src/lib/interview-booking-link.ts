import { createHash, randomBytes } from "node:crypto";

export const BOOKING_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
export function bookingTokenHash(token: string) {
  return createHash("sha256").update(token).digest("hex");
}
export function newBookingToken() {
  return randomBytes(32).toString("base64url");
}
export function bookingLinkExpiry(
  now: number,
  proposal: { startsAt: string[]; expiresAt: string | null },
) {
  return new Date(
    Math.min(
      now + 7 * 86400000,
      ...proposal.startsAt.map((time) => Date.parse(time)),
      proposal.expiresAt ? Date.parse(proposal.expiresAt) : Infinity,
    ),
  );
}
