import { z } from "zod/v4";

const identifier = z.string().regex(/^[1-9]\d{0,39}$/);
const application = z.object({
  id: identifier,
  $Job_Opening_Id: identifier.optional(),
  $Candidate_Id: identifier.optional(),
  Job_Opening_Name: z.unknown().optional(),
  Candidate_Name: z.unknown().optional(),
});

function reference(nativeId: string | undefined, lookup: unknown): string | null {
  // Native Recruit applications expose IDs separately from their display names.
  // An object lookup is also accepted, but conflicting identities fail closed.
  if (lookup !== null && typeof lookup === "object") {
    const parsed = z.object({ id: identifier }).safeParse(lookup);
    if (!parsed.success || (nativeId !== undefined && nativeId !== parsed.data.id)) return null;
    return nativeId ?? parsed.data.id;
  }
  if (lookup !== undefined && lookup !== null && typeof lookup !== "string") return null;
  return nativeId ?? null;
}

/** No name/email inference, numeric coercion, or association-position matching. */
export function zohoApplicationIdentity(value: unknown) {
  const parsed = application.safeParse(value);
  if (!parsed.success) return null;
  const row = parsed.data;
  const jobId = reference(row.$Job_Opening_Id, row.Job_Opening_Name);
  const candidateId = reference(row.$Candidate_Id, row.Candidate_Name);
  if (!jobId || !candidateId) return null;
  return { applicationId: row.id, jobId, candidateId };
}
