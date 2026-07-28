/**
 * account-lockout.ts — Failed-login lockout for staff & candidate accounts
 *
 * Pairs with the per-IP / per-email rate limits in routes/auth.ts to defend
 * against credential stuffing. The rate limits throttle the request rate;
 * this module additionally locks the *account* after a sustained burst of
 * wrong passwords so that an attacker who rotates IPs (defeating the per-IP
 * limit) and rate-limits themselves below the 5-per-15-min email cap is
 * still stopped after N total failed attempts.
 *
 * Policy:
 *   - MAX_FAILED_ATTEMPTS (default 10): on the Nth consecutive failure the
 *     account is locked (lockedAt set to now()).
 *   - Locked accounts cannot log in. Login returns 423 with code
 *     ACCOUNT_LOCKED. Note: we DELIBERATELY do not auto-expire — a B2B
 *     account-takeover attempt should require admin attention rather than
 *     resolve itself after a timer.
 *   - Successful login (or admin unlock) atomically resets the counter and
 *     clears lockedAt.
 *
 * Concurrency:
 *   - All state changes are done as single SQL UPDATEs so multiple parallel
 *     failed-login attempts cannot lose updates. The lock decision is based
 *     on the *post-increment* value RETURNING from the UPDATE.
 *
 * Notes:
 *   - Self-service password reset (POST /public/auth/reset-password) does
 *     NOT unlock — that would let an attacker who has compromised a victim's
 *     inbox bypass the lock. Reset only succeeds for unlocked accounts; for
 *     locked ones, the lock survives the password change and only an admin
 *     can clear it.
 *   - The lock is observable to the legitimate user via the 423 response
 *     ("Your account is temporarily locked. Please contact your administrator.")
 *     so they know to escalate rather than retry forever.
 */
import { db, usersTable } from "@workspace/db";
import { eq, sql } from "drizzle-orm";
import { logger } from "./logger";

export const MAX_FAILED_ATTEMPTS = 10;

export interface LockoutSnapshot {
  failedLoginAttempts: number;
  lockedAt: Date | null;
}

/** Returns true if the user record indicates the account is locked. */
export function isUserLocked(u: { lockedAt?: Date | null }): boolean {
  return u.lockedAt != null;
}

/**
 * Atomically increment failed-login counter. If the post-increment value
 * reaches MAX_FAILED_ATTEMPTS, set lockedAt = now() in the SAME statement so
 * concurrent attempts cannot double-lock or race past the threshold.
 *
 * Returns the post-update snapshot so the caller can log "just locked" vs
 * "still in count-up phase".
 */
export async function recordFailedLogin(userId: string): Promise<LockoutSnapshot> {
  const result = await db
    .update(usersTable)
    .set({
      failedLoginAttempts: sql`${usersTable.failedLoginAttempts} + 1`,
      // Set lockedAt to now() iff the post-increment value crosses threshold
      // AND we aren't already locked. Idempotent.
      lockedAt: sql`
        CASE
          WHEN ${usersTable.lockedAt} IS NOT NULL THEN ${usersTable.lockedAt}
          WHEN ${usersTable.failedLoginAttempts} + 1 >= ${MAX_FAILED_ATTEMPTS} THEN now()
          ELSE NULL
        END
      `,
    })
    .where(eq(usersTable.id, userId))
    .returning({
      failedLoginAttempts: usersTable.failedLoginAttempts,
      lockedAt: usersTable.lockedAt,
    });

  const snap = result[0] ?? { failedLoginAttempts: 0, lockedAt: null };
  if (snap.lockedAt && snap.failedLoginAttempts >= MAX_FAILED_ATTEMPTS) {
    logger.warn(
      { userId, attempts: snap.failedLoginAttempts },
      "[account-lockout] account locked after repeated failed logins — admin unlock required",
    );
  }
  return snap;
}

/**
 * Reset the failed-login counter and clear any lock. Called on successful
 * login and on admin unlock. Cheap to call even when nothing needs changing.
 */
export async function recordSuccessfulLogin(userId: string): Promise<void> {
  await db
    .update(usersTable)
    .set({ failedLoginAttempts: 0, lockedAt: null })
    .where(eq(usersTable.id, userId));
}

/** Admin-initiated unlock. Same effect as a successful login. */
export async function unlockAccount(userId: string): Promise<void> {
  await db
    .update(usersTable)
    .set({ failedLoginAttempts: 0, lockedAt: null })
    .where(eq(usersTable.id, userId));
  logger.info({ userId }, "[account-lockout] admin unlocked account");
}
