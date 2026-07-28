/**
 * schema/invite_tokens.ts — Candidate Portal Magic-Link Token Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   invite_tokens   — Short-lived, single-use tokens that let a candidate log
 *                     into the portal without a password. Generated when a recruiter
 *                     sends an invite or when the candidate requests a login link.
 *                     Expires after 48 hours; marked used after first redemption.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/invites.ts      — token generation and validation
 *   routes/auth.ts         — portal login via magic link
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const inviteTokensTable = pgTable("invite_tokens", {
  id:          text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  token:       text("token").notNull().unique(),
  candidateId: text("candidate_id").notNull(),
  userId:      text("user_id"),
  tenantId:    text("tenant_id").notNull(),
  expiresAt:   timestamp("expires_at").notNull(),
  usedAt:      timestamp("used_at"),
  createdAt:   timestamp("created_at").notNull().defaultNow(),
});

export type InviteToken = typeof inviteTokensTable.$inferSelect;
