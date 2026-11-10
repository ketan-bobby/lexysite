import { and, eq, isNull } from "drizzle-orm";
import {
  db,
  candidatesTable,
  candidateCareerProfilesTable,
  jobsTable,
  tenantsTable,
} from "@workspace/db";

/** Candidate-owned subscriptions are notification inputs, never hiring evidence. */
export function matchesTargetCompany(targets: unknown, companyName: string): boolean {
  const company = companyName.toLowerCase().trim();
  return (
    !!company &&
    Array.isArray(targets) &&
    targets.some((target: unknown) => {
      if (typeof target !== "string") return false;
      const value = target.toLowerCase().trim();
      return !!value && (value === company || value.includes(company) || company.includes(value));
    })
  );
}

/** Read current authority, not the caller's stale company/title snapshot.
 * Only explicitly published, non-confidential jobs are eligible. Active means
 * approved internally, NOT published to candidates.
 *
 * In the feed transaction the share locks serialize with subscription,
 * erasure and job-visibility updates until the private event is persisted.
 */
export async function loadRoleAlertContext(
  candidateId: string,
  jobId: string,
  reader: Pick<typeof db, "select"> = db,
) {
  const [row] = await reader
    .select({
      candidateId: candidatesTable.id,
      firstName: candidatesTable.firstName,
      email: candidatesTable.email,
      doNotContact: candidatesTable.doNotContact,
      discoveryPaused: candidatesTable.discoveryPaused,
      targets: candidateCareerProfilesTable.targetCompanies,
      companyName: tenantsTable.name,
      roleTitle: jobsTable.title,
    })
    .from(candidateCareerProfilesTable)
    .innerJoin(candidatesTable, eq(candidatesTable.id, candidateCareerProfilesTable.candidateId))
    .innerJoin(jobsTable, eq(jobsTable.id, jobId))
    .innerJoin(tenantsTable, eq(tenantsTable.id, jobsTable.tenantId))
    .where(
      and(
        eq(candidateCareerProfilesTable.candidateId, candidateId),
        eq(jobsTable.status, "published"),
        eq(jobsTable.isConfidential, false),
        isNull(candidatesTable.dataErasedAt),
      ),
    )
    .limit(1)
    .for("share");
  if (!row || !matchesTargetCompany(row.targets, row.companyName)) return null;
  return {
    candidateId: row.candidateId,
    firstName: row.firstName,
    email: row.email,
    companyName: row.companyName,
    roleTitle: row.roleTitle,
    emailAllowed:
      !row.doNotContact &&
      !row.discoveryPaused &&
      !!row.email.trim() &&
      !/@(unknown|import)\.local$/i.test(row.email.trim()),
  };
}
