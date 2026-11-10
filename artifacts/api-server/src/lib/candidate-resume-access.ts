import { and, eq, isNull } from "drizzle-orm";
import { db, controlDb, candidatesTable, usersTable } from "@workspace/db";
import { ObjectStorageService, type S3ObjectRef } from "./objectStorage";
import { getObjectAclPolicy, setObjectAclPolicy } from "./objectAcl";
import { getDataScopeTenantIds } from "./tenantUtils";

const storage = new ObjectStorageService();
const staff = new Set([
  "platform_admin",
  "tenant_admin",
  "agency_admin",
  "recruiter_admin",
  "recruiter",
  "hiring_manager",
]);
const resumePath = /^\/objects\/resumes\/[0-9a-f-]{36}$/i;
type Caller = { id: string; role: string; tenantId: string | null };

export class ResumeAccessError extends Error {
  status = 403;
}

/** Only a genuine uploader may establish a binding. Other URL writers cannot
 * create read authority by pointing their candidate at someone else's object. */
export async function assertResumeUploadOwned(path: string, caller: Caller, candidateId?: string) {
  if (!resumePath.test(path))
    throw new ResumeAccessError("Upload a new résumé before attaching this file.");
  const [active] = await controlDb
    .select({ id: usersTable.id, role: usersTable.role, tenantId: usersTable.tenantId })
    .from(usersTable)
    .where(and(eq(usersTable.id, caller.id), eq(usersTable.status, "active")));
  if (!active) throw new ResumeAccessError("An active account is required.");
  const file = await storage.getObjectEntityFile(path);
  const policy = await getObjectAclPolicy(file);
  if (
    !policy ||
    policy.visibility !== "private" ||
    (policy.resumeCandidateId && policy.resumeCandidateId !== candidateId)
  ) {
    throw new ResumeAccessError("This résumé is not available for attachment.");
  }
  if (
    policy.owner === caller.id &&
    active.role !== "platform_admin" &&
    (!policy.resumeUploadTenantId || policy.resumeUploadTenantId !== active.tenantId)
  ) {
    throw new ResumeAccessError("This upload belongs to another account scope.");
  }
  if (
    policy.owner !== caller.id &&
    !(
      policy.resumeCandidateId === candidateId &&
      (await readBoundCandidateResume(caller.id, path, file))
    )
  ) {
    throw new ResumeAccessError("This résumé is not available for attachment.");
  }
}

export async function bindCandidateResume(path: string, caller: Caller, candidateId: string) {
  await assertResumeUploadOwned(path, caller, candidateId);
  const file = await storage.getObjectEntityFile(path);
  const policy = await getObjectAclPolicy(file);
  if (!policy) throw new ResumeAccessError("Upload ownership is unavailable.");
  await setObjectAclPolicy(file, {
    ...policy,
    visibility: "private",
    resumeCandidateId: candidateId,
  });
}

/** Called only with a file uploaded inside the authenticated importer request. */
export async function bindImportedResume(path: string, tenantId: string, candidateId: string) {
  if (!resumePath.test(path)) throw new ResumeAccessError("Invalid import résumé path.");
  await setObjectAclPolicy(await storage.getObjectEntityFile(path), {
    owner: `import:${tenantId}`,
    visibility: "private",
    resumeCandidateId: candidateId,
    resumeUploadTenantId: tenantId,
  });
}

/** null means ordinary ACL handling (unbound upload or another namespace).
 * A bound résumé never falls back to a stale uploader ACL. */
export async function readBoundCandidateResume(
  callerId: string,
  path: string,
  file: S3ObjectRef,
): Promise<boolean | null> {
  if (!resumePath.test(path)) return null;
  const [caller] = await controlDb
    .select({
      id: usersTable.id,
      role: usersTable.role,
      tenantId: usersTable.tenantId,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, callerId), eq(usersTable.status, "active")));
  if (!caller) return false;
  const policy = await getObjectAclPolicy(file);
  if (!policy?.resumeCandidateId) {
    if (
      policy?.owner === callerId &&
      caller.role !== "platform_admin" &&
      (!policy.resumeUploadTenantId || policy.resumeUploadTenantId !== caller.tenantId)
    )
      return false;
    return null;
  }
  if (policy.visibility !== "private") return false;
  const [candidate] = await db
    .select({
      id: candidatesTable.id,
      tenantId: candidatesTable.tenantId,
      userId: candidatesTable.userId,
      pool: candidatesTable.pool,
      doNotContact: candidatesTable.doNotContact,
    })
    .from(candidatesTable)
    .where(
      and(
        eq(candidatesTable.id, policy.resumeCandidateId),
        eq(candidatesTable.resumeUrl, path),
        isNull(candidatesTable.dataErasedAt),
      ),
    );
  if (!candidate) return false;
  if (caller.role === "candidate") return candidate.userId === caller.id;
  if (!staff.has(caller.role) || candidate.doNotContact || candidate.pool === "pending_profile")
    return false;
  // Employer platform-pool discovery does not confer private document access.
  if (candidate.pool !== "tenant" && caller.role !== "platform_admin") return false;
  const allowed = await getDataScopeTenantIds(caller);
  if (allowed && !allowed.includes(candidate.tenantId ?? "")) return false;
  if (caller.role === "recruiter") {
    const { recruiterCanAccessCandidate } = await import("../routes/candidates");
    return recruiterCanAccessCandidate(caller, candidate.id);
  }
  return true;
}
