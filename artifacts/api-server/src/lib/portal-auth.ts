/**
 * portal-auth.ts — Single source of truth for resolving a candidate session.
 *
 * Every /portal/* handler that touches candidate PII MUST call
 * resolveCandidateId(req) — never join candidates.email against users.email,
 * never accept a non-candidate role, never fall back to a demo candidate in
 * production. The single resolver below enforces the contract uniformly so
 * we cannot regress in one corner of the codebase.
 *
 * Threat model addressed:
 *   - A recruiter / admin / platform_admin whose email happens to match a
 *     candidate's email previously resolved into that candidate's session
 *     via an email-join, reading and writing their PII (the "auth shadowing"
 *     vector flagged in the 2026-05-16 architect review). We close it by
 *     requiring the token's role === "candidate" AND resolving the candidate
 *     row via candidates.user_id (FK, migration 0012).
 */
import { db } from "@workspace/db";
import { usersTable, candidatesTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { getAuthUserId } from "./auth-token";

export interface CandidateSession {
  /** users.id from the HMAC-verified bearer token. */
  userId: string;
  /** candidates.id linked via candidates.user_id (FK). */
  candidateId: string;
  /** users.tenantId — recorded for downstream tenant-scoping. */
  tenantId: string;
}

/**
 * Resolve the candidate session for an authenticated request.
 *
 * Returns `null` if any of the following is true (caller MUST treat as 401):
 *   - no/invalid/expired bearer token
 *   - the token's user row does not exist
 *   - the user's role is anything other than "candidate"
 *   - no candidate row is linked to this user via candidates.user_id
 *
 * NEVER returns a candidate ID derived from email or a userId fallback.
 */
export async function resolveCandidateSession(req: { headers: { authorization?: string | string[] } }): Promise<CandidateSession | null> {
  const userId = getAuthUserId(req);
  if (!userId) return null;
  const [u] = await db.select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
    .from(usersTable)
    .where(eq(usersTable.id, userId))
    .limit(1);
  if (!u || u.role !== "candidate") return null;
  const [cand] = await db.select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.userId, u.id))
    .limit(1);
  if (!cand) return null;
  return { userId: u.id, candidateId: cand.id, tenantId: u.tenantId };
}

/** Convenience: returns just the candidate id, or null. */
export async function resolveCandidateId(req: { headers: { authorization?: string | string[] } }): Promise<string | null> {
  const s = await resolveCandidateSession(req);
  return s?.candidateId ?? null;
}
