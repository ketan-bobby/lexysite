/**
 * Bound workflow identity checks are AI advice, not corroborated identity.
 * Keep the unchanged agent prompt/model; persist a pending, owner-scoped record
 * atomically so a model's "clear" cannot become verified hiring evidence.
 */
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { db, candidatesTable, verificationRecordsTable } from "@workspace/db";
import { WorkflowConflict } from "./recruiting-workflows";

const adviceSchema = z.object({
  linkedinMatch: z.enum(["verified", "partial", "unverified", "mismatch"]),
  resumeConsistency: z.enum(["consistent", "minor_discrepancies", "major_discrepancies"]),
  emailValidity: z.enum(["valid", "suspicious", "disposable"]),
  profileCompleteness: z.number().finite().min(0).max(100),
  overallScore: z.number().finite().min(0).max(100),
  riskFlags: z.array(z.string()),
  verdict: z.enum(["clear", "review", "flag"]),
  notes: z.string().trim().min(1),
});

export async function assertNoWorkflowIdentityRecord(candidateId: string, ownerTenantId: string) {
  const [existing] = await db
    .select({ id: verificationRecordsTable.id })
    .from(verificationRecordsTable)
    .where(
      and(
        eq(verificationRecordsTable.candidateId, candidateId),
        eq(verificationRecordsTable.tenantId, ownerTenantId),
      ),
    );
  if (existing)
    throw new WorkflowConflict(
      "Identity activity already exists. Review or resolve it instead of repeating the AI check.",
      409,
    );
}

export async function persistWorkflowIdentityAdvice(
  candidateId: string,
  ownerTenantId: string,
  advice: unknown,
) {
  const parsed = adviceSchema.parse(advice);
  const note =
    "AI profile-consistency advice only. No independent identity source was queried. " +
    "Identity remains unverified and requires human resolution; this is not a job-fit assessment.";
  return db.transaction(async (tx) => {
    const [candidate] = await tx
      .select()
      .from(candidatesTable)
      .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, ownerTenantId)))
      .for("update");
    if (!candidate) throw new WorkflowConflict("Candidate ownership changed.", 409);
    // No upsert: never overwrite existing verified, flagged or unresolved evidence.
    const [record] = await tx
      .insert(verificationRecordsTable)
      .values({
        tenantId: ownerTenantId,
        candidateId,
        status: "pending",
        riskScore: 50, // neutral internal placeholder, not a measured fraud score
        identityVerified: false,
        flags: ["Uncorroborated AI advice — human resolution required"],
        reviewNotes: `${note}\nModel advice: ${parsed.notes}`,
      })
      .onConflictDoNothing({ target: verificationRecordsTable.candidateId })
      .returning({ id: verificationRecordsTable.id });
    if (!record)
      throw new WorkflowConflict("Existing identity evidence must not be replaced.", 409);
    await tx
      .update(candidatesTable)
      .set({
        verificationStatus: "pending",
        verificationResult: {
          ...(candidate.verificationResult &&
          typeof candidate.verificationResult === "object" &&
          "syntheticFixture" in candidate.verificationResult
            ? { syntheticFixture: candidate.verificationResult.syntheticFixture }
            : {}),
          verdict: "review",
          linkedinMatch: "unverified",
          notes: note,
          riskFlags: ["Identity is not independently corroborated"],
          advisory: parsed,
          overallScore: null,
        },
        updatedAt: new Date(),
      })
      .where(and(eq(candidatesTable.id, candidateId), eq(candidatesTable.tenantId, ownerTenantId)));
    return {
      checked: 1,
      identityVerified: false,
      requiresHumanResolution: true,
      results: [{ candidateId, verificationRecordId: record.id, status: "pending" }],
    };
  });
}
