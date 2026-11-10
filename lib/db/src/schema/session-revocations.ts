import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";

export const sessionRevocationsTable = pgTable(
  "auth_session_revocations",
  {
    tokenHash: text("token_hash").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("auth_session_revocations_expiry").on(table.expiresAt)],
);
export const insertSessionRevocationSchema = createInsertSchema(sessionRevocationsTable);
export type SessionRevocation = typeof sessionRevocationsTable.$inferSelect;
