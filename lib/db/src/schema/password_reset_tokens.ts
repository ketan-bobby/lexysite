/**
 * schema/password_reset_tokens.ts — Password Reset Token Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   password_reset_tokens — One-time tokens issued by POST /api/public/forgot-password
 *                           and redeemed by POST /api/public/reset-password.
 *                           Single-use: marking used_at on redeem prevents replay
 *                           even within the 1-hour TTL.
 *
 * ─── Storage model ───────────────────────────────────────────────────────────
 *   We store only the SHA-256 hash of the token (never the raw token), so a
 *   read-only DB compromise can't be used to reset any user's password — the
 *   attacker would still need the raw token from the email.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/public.ts  (forgot-password, reset-password)
 */
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const passwordResetTokensTable = pgTable(
  "password_reset_tokens",
  {
    id:         text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    userId:     text("user_id").notNull(),
    tokenHash:  text("token_hash").notNull().unique(),
    expiresAt:  timestamp("expires_at", { withTimezone: true }).notNull(),
    usedAt:     timestamp("used_at", { withTimezone: true }),
    createdAt:  timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    requestIp:  text("request_ip"),
  },
  (t) => ({
    userIdx: index("password_reset_tokens_user_idx").on(t.userId),
  }),
);

export type PasswordResetToken = typeof passwordResetTokensTable.$inferSelect;
