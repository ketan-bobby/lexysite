/**
 * Safe read helpers for candidate-approved introductions.
 *
 * These helpers intentionally query only candidate_introductions. Callers must
 * perform their own relationship/tenant authorization before exposing a result;
 * the helpers must never reach into career profiles, prep, evaluations, or
 * recordings to construct text.
 */
import { db, candidateIntroductionsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

export interface ApprovedCandidateIntroduction {
  candidateId: string;
  summary: string;
  strengths: Array<{ title: string; evidence: string }>;
  achievements: Array<{ text: string }>;
  careerDirection: string | null;
  preferences: string | null;
  availability: string | null;
  approvedAt: Date | null;
}

function cleanText(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function toApprovedIntroduction(row: typeof candidateIntroductionsTable.$inferSelect): ApprovedCandidateIntroduction {
  const strengths = Array.isArray(row.strengths)
    ? row.strengths.slice(0, 8).map((strength) => ({
        title: cleanText((strength as any)?.title, 100),
        evidence: cleanText((strength as any)?.evidence, 500),
      })).filter((strength) => strength.title && strength.evidence)
    : [];
  const achievements = Array.isArray(row.achievements)
    ? row.achievements.slice(0, 8).map((achievement) => ({
        text: cleanText((achievement as any)?.text, 500),
      })).filter((achievement) => achievement.text)
    : [];

  return {
    candidateId: row.candidateId,
    summary: cleanText(row.summary, 1200),
    strengths,
    achievements,
    careerDirection: cleanText(row.careerDirection, 500) || null,
    preferences: cleanText(row.rolePreferences, 500) || null,
    availability: cleanText(row.availability, 250) || null,
    approvedAt: row.approvedAt ?? null,
  };
}

/** Returns null unless the candidate's current introduction is approved. */
export async function getApprovedCandidateIntroduction(
  candidateId: string,
): Promise<ApprovedCandidateIntroduction | null> {
  const [row] = await db.select()
    .from(candidateIntroductionsTable)
    .where(and(
      eq(candidateIntroductionsTable.candidateId, candidateId),
      eq(candidateIntroductionsTable.status, "approved"),
    ))
    .limit(1);
  return row ? toApprovedIntroduction(row) : null;
}

/**
 * Batch variant for list/snapshot paths. Map keys are candidate ids; absent
 * candidates are not approved (or are out of the current DB/RLS scope).
 */
export async function getApprovedCandidateIntroductions(
  candidateIds: string[],
): Promise<Map<string, ApprovedCandidateIntroduction>> {
  const uniqueIds = [...new Set(candidateIds.filter(Boolean))];
  if (uniqueIds.length === 0) return new Map();
  const rows = await db.select()
    .from(candidateIntroductionsTable)
    .where(and(
      inArray(candidateIntroductionsTable.candidateId, uniqueIds),
      eq(candidateIntroductionsTable.status, "approved"),
    ));
  return new Map(rows.map((row) => [row.candidateId, toApprovedIntroduction(row)]));
}