/**
 * recruiter-mail.ts — Data access for per-recruiter connected mailboxes
 *
 * Thin accessors over the recruiter_mail_accounts table. These run in contexts
 * that have NO request-scoped RLS connection (the OAuth callback is pre-auth /
 * bypassed, and the outreach scheduler runs outside any request), so they use
 * the admin pool (dbAdmin) and ALWAYS scope by the explicit userId we already
 * trust from the verified session / row lookup.
 */
import { dbAdmin, recruiterMailAccountsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

export type MailAccount = typeof recruiterMailAccountsTable.$inferSelect;

export async function getMailAccount(userId: string): Promise<MailAccount | null> {
  const [row] = await dbAdmin
    .select()
    .from(recruiterMailAccountsTable)
    .where(eq(recruiterMailAccountsTable.userId, userId))
    .limit(1);
  return row ?? null;
}

/** True only when the recruiter has a usable, non-revoked connected mailbox. */
export async function hasHealthyMailbox(userId: string): Promise<boolean> {
  const a = await getMailAccount(userId);
  return Boolean(a && a.status === "connected" && a.refreshTokenEnc);
}

export async function upsertMailAccountTokens(input: {
  userId: string;
  tenantId: string;
  provider?: string;
  email: string;
  homeAccountId?: string | null;
  refreshTokenEnc: string;
  scopes: string;
}): Promise<void> {
  const now = new Date();
  await dbAdmin
    .insert(recruiterMailAccountsTable)
    .values({
      userId: input.userId,
      tenantId: input.tenantId,
      provider: input.provider ?? "microsoft",
      email: input.email,
      homeAccountId: input.homeAccountId ?? null,
      refreshTokenEnc: input.refreshTokenEnc,
      scopes: input.scopes,
      status: "connected",
      lastError: null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: recruiterMailAccountsTable.userId,
      set: {
        tenantId: input.tenantId,
        email: input.email,
        homeAccountId: input.homeAccountId ?? null,
        refreshTokenEnc: input.refreshTokenEnc,
        scopes: input.scopes,
        status: "connected",
        lastError: null,
        updatedAt: now,
      },
    });
}

/**
 * Mark a mailbox unhealthy. `revoked=true` (invalid_grant etc.) means the token
 * is dead and the recruiter must reconnect; otherwise it's a transient error.
 * Either way the send-router falls back to SES.
 */
export async function markMailAccountError(
  userId: string,
  error: string,
  revoked = false,
): Promise<void> {
  await dbAdmin
    .update(recruiterMailAccountsTable)
    .set({ status: revoked ? "revoked" : "error", lastError: error.slice(0, 500), updatedAt: new Date() })
    .where(eq(recruiterMailAccountsTable.userId, userId));
}

export async function deleteMailAccount(userId: string): Promise<void> {
  await dbAdmin.delete(recruiterMailAccountsTable).where(eq(recruiterMailAccountsTable.userId, userId));
}

/**
 * All currently-connected mailboxes (status='connected' with a refresh token).
 * Used by the reply-sync poller to walk each recruiter's Outlook for new
 * candidate replies. Runs on the admin pool (no request RLS context).
 */
export async function getConnectedMailAccounts(): Promise<MailAccount[]> {
  return dbAdmin
    .select()
    .from(recruiterMailAccountsTable)
    .where(eq(recruiterMailAccountsTable.status, "connected"));
}

/** Persist the Graph delta link after a successful reply-sync poll. */
export async function updateMailAccountDelta(userId: string, deltaLink: string | null): Promise<void> {
  await dbAdmin
    .update(recruiterMailAccountsTable)
    .set({ graphDeltaLink: deltaLink, updatedAt: new Date() })
    .where(eq(recruiterMailAccountsTable.userId, userId));
}
