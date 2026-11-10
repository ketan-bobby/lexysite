import { createHash, randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

type Transaction = { execute: (query: ReturnType<typeof sql>) => Promise<unknown> };
export type AccountErasureState =
  | "closed"
  | "staff_identity_preserved"
  | "other_profiles_remaining"
  | "no_linked_identity"
  | "multi_region_review_required";

export async function collectClosingAccountAvatars(
  tx: Transaction,
  candidateId: string,
): Promise<string[]> {
  if (process.env.LEXY_LOCAL_SINGLE_CELL === "false") return [];
  const result = (await tx.execute(sql`SELECT u.avatar_url FROM users u
    JOIN candidates c ON c.user_id=u.id
    WHERE c.id=${candidateId} AND u.role='candidate' AND u.avatar_url IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM candidates peer
      WHERE peer.user_id=u.id AND peer.id<>c.id AND peer.data_erased_at IS NULL)`)) as {
    rows: { avatar_url: string }[];
  };
  return result.rows.map((row) => row.avatar_url).filter(Boolean);
}

/** Inside an already-authorised erasure transaction; never find identities by email. */
export async function closeCandidateAccount(
  tx: Transaction,
  candidateId: string,
): Promise<AccountErasureState> {
  const result = (await tx.execute(
    sql`SELECT user_id FROM candidates WHERE id=${candidateId} FOR UPDATE`,
  )) as { rows: { user_id: string | null }[] };
  const userId = result.rows[0]?.user_id;
  let state: AccountErasureState = "no_linked_identity";
  if (userId) {
    const users = (await tx.execute(
      sql`SELECT id,role FROM users WHERE id=${userId} FOR UPDATE`,
    )) as { rows: { id: string; role: string }[] };
    const user = users.rows[0];
    if (user) {
      if (user.role !== "candidate") state = "staff_identity_preserved";
      else if (process.env.LEXY_LOCAL_SINGLE_CELL === "false")
        state = "multi_region_review_required";
      else {
        const peers = (await tx.execute(sql`SELECT id FROM candidates
          WHERE user_id=${userId} AND id<>${candidateId} AND data_erased_at IS NULL LIMIT 1`)) as {
          rows: unknown[];
        };
        if (peers.rows.length) state = "other_profiles_remaining";
        else {
          const email = `erased+${createHash("sha256").update(userId).digest("hex").slice(0, 40)}@deleted.invalid`;
          await tx.execute(sql`UPDATE users SET
            account_erased_at=COALESCE(account_erased_at,now()),status='suspended',
            email=${email},name='Deleted candidate',password_hash=${`!erased:${randomUUID()}`},
            avatar_url=NULL,notification_frequency='off',timezone='UTC',
            last_digest_sent_at=NULL,last_report_seen_at=NULL,
            failed_login_attempts=0,locked_at=NULL,updated_at=now()
            WHERE id=${userId} AND role='candidate'`);
          await tx.execute(sql`DELETE FROM password_reset_tokens WHERE user_id=${userId}`);
          await tx.execute(sql`DELETE FROM invite_tokens WHERE user_id=${userId}`);
          state = "closed";
        }
      }
    }
    // An erased profile must never become the portal resolver's live identity.
    await tx.execute(sql`UPDATE candidates SET user_id=NULL WHERE id=${candidateId}`);
  }
  await tx.execute(sql`UPDATE deletion_requests SET
    storage_cleanup=storage_cleanup || jsonb_build_object('account',${state}::text)
    WHERE candidate_id=${candidateId} AND status='in_progress' AND storage_cleanup IS NOT NULL`);
  return state;
}
