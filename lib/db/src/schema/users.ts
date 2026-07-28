/**
 * schema/users.ts — Recruiter / Staff User Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   users   — Internal staff accounts: recruiters, tenant admins, hiring managers,
 *             and platform admins. Stores hashed password, role, timezone, and
 *             notification preferences. Separate from candidates, who authenticate
 *             via magic-link invite_tokens.
 *
 * ─── Enums ───────────────────────────────────────────────────────────────────
 *   user_role — recruiter · tenant_admin · hiring_manager · interviewer ·
 *               platform_admin · candidate (legacy alias)
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/users.ts   — user CRUD
 *   routes/auth.ts    — login and session management
 *   lib/tenantUtils.ts — role-based visibility checks
 */
import { pgTable, text, timestamp, pgEnum, integer } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const userRoleEnum = pgEnum("user_role", [
  "platform_admin",
  "tenant_admin",
  "recruiter",
  "hiring_manager",
  "interviewer",
  "candidate",
  // Recruiter Admin — scoped to one or more assigned client sub-tenants.
  // Manages recruiters/hiring managers and assigns requisitions within those
  // clients only. Does NOT own billing or create sub-tenants (tenant_admin
  // only). Appended last to match the ALTER TYPE ADD VALUE ordering in the DB.
  "recruiter_admin",
]);

// Administrative account state, distinct from the `lockedAt` lockout (which
// is the failed-login automated lock). "suspended" is an admin-initiated
// disable: the account cannot log in until an admin sets it back to "active".
export const userStatusEnum = pgEnum("user_status", ["active", "suspended"]);

export const usersTable = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  email: text("email").notNull().unique(),
  name: text("name").notNull(),
  passwordHash: text("password_hash").notNull(),
  role: userRoleEnum("role").notNull().default("recruiter"),
  status: userStatusEnum("status").notNull().default("active"),
  avatarUrl: text("avatar_url"),
  // "realtime" = email on every event, "digest" = roll up automated events
  // into a daily 08:00 digest, "off" = no automated emails (decision events
  // still send real-time).
  notificationFrequency: text("notification_frequency").notNull().default("digest"),
  // IANA timezone string, e.g. "America/New_York", "Asia/Dubai". Used to
  // decide when 08:00 happens locally for the daily digest.
  timezone: text("timezone").notNull().default("UTC"),
  // Timestamp of the last digest email we sent to this user. Used by the
  // digest scheduler to give each recruiter at most one digest per local
  // day and to recover gracefully if the scheduler is down at 08:00.
  lastDigestSentAt: timestamp("last_digest_sent_at"),
  // Morning Report bookkeeping: the moment this user last SAW / DISMISSED their
  // dashboard Morning Report. The report summarizes activity SINCE this
  // timestamp. NULL = the user has never seen a report (first-ever visit →
  // "welcome" variant). Advanced on dismissal via
  // POST /analytics/morning-report/seen. Read-only w.r.t. runs/counts/queues.
  lastReportSeenAt: timestamp("last_report_seen_at"),
  // Account lockout (see api-server/src/lib/account-lockout.ts). Counter is
  // reset on successful login; lockedAt is set when the counter crosses the
  // threshold and is cleared only by a successful login or an admin unlock.
  failedLoginAttempts: integer("failed_login_attempts").notNull().default(0),
  lockedAt: timestamp("locked_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
});

export const insertUserSchema = createInsertSchema(usersTable).omit({ id: true, createdAt: true, updatedAt: true });
export const selectUserSchema = createSelectSchema(usersTable);
export type InsertUser = z.infer<typeof insertUserSchema>;
export type User = typeof usersTable.$inferSelect;
