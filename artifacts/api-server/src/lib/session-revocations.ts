import { createHash } from "node:crypto";
import { and, eq, gt, lt } from "drizzle-orm";
import { controlDb, usersTable, sessionRevocationsTable as revocations } from "@workspace/db";
import { verifyToken, hasCurrentCredentialVersion } from "./auth-token";

export const sessionTokenHash = (raw: string) =>
  createHash("sha256")
    .update(raw.replace(/^Bearer\s+/i, "").trim())
    .digest("hex");

/** No positive cache: a completed logout fences every subsequent HTTP request
 * across processes. Requests already authorized/in flight are not cancelled. */
export async function sessionIsRevoked(raw: string): Promise<boolean> {
  const verified = verifyToken(raw);
  if (!verified.ok || verified.legacy) return true;
  // One indexed shared-store read: no cached validity and no clock cutoffs.
  const [row] = await controlDb
    .select({ version: usersTable.credentialVersion, tokenHash: revocations.tokenHash })
    .from(usersTable)
    .leftJoin(
      revocations,
      and(eq(revocations.tokenHash, sessionTokenHash(raw)), gt(revocations.expiresAt, new Date())),
    )
    .where(eq(usersTable.id, verified.payload.sub))
    .limit(1);
  return !row || !hasCurrentCredentialVersion(verified.payload, row.version) || !!row.tokenHash;
}
export async function revokeSession(raw: string | null): Promise<void> {
  const verified = verifyToken(raw);
  if (!raw || !verified.ok) return; // Absent/invalid/expired is already unusable.
  // Legacy development fallback is not a production session.
  if (verified.legacy)
    throw new Error("Legacy development credentials cannot be revoked; sign in normally");
  const expiresAt = new Date(verified.payload.exp * 1000);
  if (!Number.isFinite(expiresAt.getTime())) throw new Error("Invalid session expiry");
  await controlDb.transaction(async (tx) => {
    await tx
      .insert(revocations)
      .values({ tokenHash: sessionTokenHash(raw), expiresAt })
      .onConflictDoNothing();
    await tx.delete(revocations).where(lt(revocations.expiresAt, new Date()));
  });
}
/** Explicit maintenance operation, never a schema mutation or startup DDL. */
export async function pruneExpiredRevocations(): Promise<void> {
  await controlDb.delete(revocations).where(lt(revocations.expiresAt, new Date()));
}
