/**
 * candidate-dedup — single source of truth for "have we already seen this
 * person?" across every candidate-creation path.
 *
 * Before this helper existed, each entry point deduped on a different subset of
 * identity signals:
 *   • sourcing (external scan)  → LinkedIn URL, then email
 *   • candidate-import (API)    → email, then phone, then name+location
 * The two never agreed, so the SAME person sourced via one path and imported via
 * the other produced duplicate candidate rows. This module reconciles them into
 * one ordered match strategy used by both:
 *
 *   1. LinkedIn URL (exact, case-insensitive) — strongest signal
 *   2. Email        (exact, case-insensitive, real addresses only)
 *   3. Phone        (last 7+ digits match)     — survives formatting differences
 *   4. First + last name + location            — weakest; last-resort soft match
 *
 * All lookups are tenant-scoped. The first signal that resolves wins, so callers
 * get deterministic, consistent dedup regardless of which path created the row.
 */
import { db } from "@workspace/db";
import { candidatesTable } from "@workspace/db";
import { and, eq, ilike, sql, type SQL } from "drizzle-orm";

export interface DedupSignals {
  /** Tenant the candidate must belong to (or "platform" for the shared pool). */
  tenantId: string;
  email?: string | null;
  phone?: string | null;
  linkedinUrl?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  location?: string | null;
}

/** Email is "real" only when present and not a synthetic placeholder. */
function realEmail(email?: string | null): string {
  if (typeof email !== "string") return "";
  const e = email.trim().toLowerCase();
  if (!e || e.endsWith("@unknown.local") || e.endsWith("@import.local")) return "";
  return e;
}

/** Normalise a phone to its trailing 7+ digits for tolerant matching. */
function phoneTail(phone?: string | null): string {
  if (typeof phone !== "string") return "";
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 7 ? digits.slice(-10) : "";
}

/**
 * Resolve an existing candidate row for the given identity signals within a
 * tenant, or null when this is a genuinely new person. Returns the FULL row so
 * callers can merge missing fields.
 */
export async function findExistingCandidate(signals: DedupSignals): Promise<any | null> {
  const tenantScope: SQL = eq(candidatesTable.tenantId, signals.tenantId);

  // 1. LinkedIn URL — strongest identity signal. Case-insensitive: LinkedIn
  //    URLs are case-insensitive in practice and casing varies by source
  //    (sourcing scan vs import vs manual entry), so a case-sensitive eq()
  //    would silently miss the same person.
  if (signals.linkedinUrl && signals.linkedinUrl.trim()) {
    const linkedin = signals.linkedinUrl.trim().toLowerCase();
    const r = await db.select().from(candidatesTable)
      .where(and(tenantScope, sql`lower(${candidatesTable.linkedinUrl}) = ${linkedin}`))
      .limit(1);
    if (r[0]) return r[0];
  }

  // 2. Email — exact, case-insensitive, real addresses only.
  const email = realEmail(signals.email);
  if (email) {
    const r = await db.select().from(candidatesTable)
      .where(and(tenantScope, sql`lower(${candidatesTable.email}) = ${email}`))
      .limit(1);
    if (r[0]) return r[0];
  }

  // 3. Phone — match on the trailing digits so "+1 (415) 555-1234" and
  //    "4155551234" resolve to the same person.
  const tail = phoneTail(signals.phone);
  if (tail) {
    const r = await db.select().from(candidatesTable)
      .where(and(tenantScope, ilike(candidatesTable.phone, `%${tail}%`)))
      .limit(1);
    if (r[0]) return r[0];
  }

  // 4. Name + location — weakest soft match, last resort only.
  if (signals.firstName?.trim() && signals.lastName?.trim() && signals.location?.trim()) {
    const r = await db.select().from(candidatesTable)
      .where(and(
        tenantScope,
        ilike(candidatesTable.firstName, signals.firstName.trim()),
        ilike(candidatesTable.lastName, signals.lastName.trim()),
        ilike(candidatesTable.location, `%${signals.location.trim()}%`),
      ))
      .limit(1);
    if (r[0]) return r[0];
  }

  return null;
}
