/**
 * Candidate-development privacy firewall.
 *
 * Career intake, mock/prep sessions, their recordings, transcripts, and
 * developmental feedback are private to the candidate who created them. This
 * is deliberately stricter than tenant access: platform and tenant staff can
 * operate job-specific assessments, but cannot read a candidate's private
 * developmental material through ordinary product routes.
 */
import { db, candidatesTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

export type DevelopmentalCaller = {
  id: string;
  role: string;
};

/** All candidate records owned by this actual candidate user, never by email
 * or tenant. A user may legitimately be linked to more than one candidate row.
 */
export async function ownedCandidateDevelopmentIds(
  caller: DevelopmentalCaller,
): Promise<string[]> {
  if (caller.role !== "candidate") return [];
  const rows = await db
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(eq(candidatesTable.userId, caller.id));
  return rows.map((row) => row.id);
}

/** True only when the caller is a candidate and owns this exact candidate row. */
export async function callerOwnsCandidateDevelopmentData(
  caller: DevelopmentalCaller,
  candidateId: string,
): Promise<boolean> {
  if (caller.role !== "candidate") return false;
  const [row] = await db
    .select({ id: candidatesTable.id })
    .from(candidatesTable)
    .where(and(
      eq(candidatesTable.id, candidateId),
      eq(candidatesTable.userId, caller.id),
    ))
    .limit(1);
  /* Keep the predicate user-FK based. Do not substitute a caller-supplied
   * tenant or an email match: either permits an administrator/peer shadowing
   * the candidate's private developmental record. */
  return !!row;
}