import type { ApprovedCandidateIntroduction } from "./candidate-introduction";

/**
 * A submission is a relationship, not a permanent copy of candidate consent.
 * Rebuild its narrative from today's approved introduction on every read.
 * Never return historical bio/note or arbitrary snapshot properties.
 */
export function approvedShortlistPresentation(
  row: Record<string, any>,
  introduction: ApprovedCandidateIntroduction | undefined,
) {
  if (!row.candidateId || !introduction || introduction.candidateId !== row.candidateId) {
    return null;
  }
  return {
    id: row.id,
    fullName: row.fullName,
    email: row.email ?? null,
    phone: row.phone ?? null,
    currentTitle: row.currentTitle ?? null,
    location: row.location ?? null,
    experienceLevel: row.experienceLevel ?? null,
    workStyle: row.workStyle ?? null,
    languages: row.languages ?? [],
    linkedinUrl: row.linkedinUrl ?? null,
    resumeObjectPath: row.resumeObjectPath ?? null,
    status: row.status,
    candidateId: row.candidateId,
    clientTenantId: row.clientTenantId,
    jobPostingId: row.jobPostingId ?? null,
    pushedAt: row.pushedAt,
    bio: introduction.summary,
    note: null,
    introduction,
  };
}