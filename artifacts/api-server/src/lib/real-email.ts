/**
 * real-email.ts — Placeholder-aware candidate email helpers
 *
 * Candidates added without a real address (manual add, CSV/CV import, sourced
 * rows with no contact info) get a synthetic placeholder email minted on the
 * `@unknown.local` / `@import.local` domains so the NOT NULL `candidates.email`
 * column and the (tenant, lower(email)) unique index still hold. Those
 * placeholders are NOT deliverable and must never be treated as a real address
 * — emailing one bounces. Use these helpers anywhere outreach/dispatch needs to
 * decide whether a candidate actually has an email to send to.
 */
export const PLACEHOLDER_DOMAINS = ["@unknown.local", "@import.local"];

/** True only for a non-empty, non-placeholder email address. */
export function isRealEmail(email: unknown): email is string {
  if (typeof email !== "string") return false;
  const e = email.trim().toLowerCase();
  return e.length > 0 && !PLACEHOLDER_DOMAINS.some((d) => e.endsWith(d));
}

/** Return the trimmed real email, or "" when missing/placeholder. */
export function realEmailOrEmpty(email: unknown): string {
  return isRealEmail(email) ? (email as string).trim() : "";
}
