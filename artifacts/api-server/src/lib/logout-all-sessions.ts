import bcrypt from "bcryptjs";
import { and, eq, sql } from "drizzle-orm";
import { controlDb, usersTable, auditLogsTable } from "@workspace/db";
import { verifyToken, hasCurrentCredentialVersion } from "./auth-token";

export class LogoutAllError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

/** Self-only, password-confirmed, atomic epoch rotation plus mandatory audit. */
export async function logoutAllSessions(
  raw: string | null,
  password: string,
  acknowledge: unknown,
  database: typeof controlDb = controlDb,
): Promise<void> {
  const token = verifyToken(raw);
  if (!token.ok || token.legacy)
    throw new LogoutAllError(401, "UNAUTHORIZED", "Please sign in again.");
  if (acknowledge !== true || !password || password.length > 1024)
    throw new LogoutAllError(
      400,
      "CONFIRMATION_REQUIRED",
      "Confirm your password and all-device sign-out.",
    );
  await database.transaction(async (tx) => {
    const [user] = await tx
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, token.payload.sub))
      .limit(1)
      .for("update");
    if (
      !user ||
      user.accountErasedAt ||
      user.status !== "active" ||
      !hasCurrentCredentialVersion(token.payload, user.credentialVersion)
    )
      throw new LogoutAllError(401, "UNAUTHORIZED", "Please sign in again.");
    if (user.lockedAt)
      throw new LogoutAllError(
        423,
        "ACCOUNT_LOCKED",
        "This account is locked. Contact your administrator.",
      );
    if (!/^\$2[aby]\$/.test(user.passwordHash))
      throw new LogoutAllError(
        409,
        "PASSWORD_CONFIRMATION_UNAVAILABLE",
        "This account uses organization sign-in or has no local password. Password confirmation is unavailable.",
      );
    if (!(await bcrypt.compare(password, user.passwordHash)))
      throw new LogoutAllError(
        403,
        "PASSWORD_CONFIRMATION_FAILED",
        "The password could not be confirmed.",
      );
    const [rotated] = await tx
      .update(usersTable)
      .set({ credentialVersion: sql`NULL` })
      .where(
        and(eq(usersTable.id, user.id), eq(usersTable.credentialVersion, user.credentialVersion)),
      )
      .returning({ version: usersTable.credentialVersion });
    if (!rotated || rotated.version === user.credentialVersion)
      throw new Error("Session invalidation not confirmed");
    await tx.insert(auditLogsTable).values({
      // Authentication activity is control-plane evidence, not employer-visible
      // recruiting activity (particularly for candidate-owned accounts).
      tenantId: null,
      actorType: user.role === "candidate" ? "candidate" : "user",
      actorId: user.id,
      actorLabel: "Account owner",
      subjectType: "user",
      subjectId: user.id,
      channel: "system",
      direction: "internal",
      action: "auth.sessions_revoked",
      title: "Signed out all devices",
      body: "The account owner confirmed a password and invalidated all account sessions.",
      metadata: { method: "password", scope: "all_account_sessions" },
    });
  });
}
