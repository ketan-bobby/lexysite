/**
 * demo-email.ts — Synthetic demo-domain email helpers
 *
 * Demo / simulated candidates (source "agent_simulated") are seeded with
 * addresses on a reserved synthetic domain so a sales demo can walk the FULL
 * enroll → draft → approve → "send" outreach flow WITHOUT any real email ever
 * leaving the building. These addresses:
 *   • PASS isRealEmail() (they are not @unknown.local / @import.local
 *     placeholders) so enrollment + drafting + approval all work end to end;
 *   • are HARD-REFUSED at the send layer (email.ts) by domain match — the
 *     SES / Graph transport never runs for them, so nothing is dispatched and
 *     no bounce is ever generated;
 *   • are EXCLUDED from outreach reply-rate / failure-rate denominators so a
 *     by-design demo suppression never makes a tenant's real stats look broken
 *     (same low-volume-honesty rule applied everywhere else).
 *
 * `.example` is an IANA-reserved TLD (RFC 2606) that can never resolve or accept
 * mail, so even a misconfiguration cannot deliver to this domain.
 */
export const DEMO_EMAIL_DOMAIN = "demo.lexy.example";

/** True when an address is on the reserved synthetic demo domain. */
export function isDemoEmail(email: unknown): boolean {
  if (typeof email !== "string") return false;
  return email.trim().toLowerCase().endsWith(`@${DEMO_EMAIL_DOMAIN}`);
}

/** A SQL fragment (as a string) matching the demo domain for use in raw filters. */
export const DEMO_EMAIL_LIKE = `%@${DEMO_EMAIL_DOMAIN}`;
