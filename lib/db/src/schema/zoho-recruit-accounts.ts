import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { usersTable } from "./users";

/** Admin-only OAuth custody. No request-role grants; all access is explicitly scoped. */
export const zohoRecruitAccountsTable = pgTable(
  "zoho_recruit_accounts",
  {
    tenantId: text("tenant_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => usersTable.id, { onDelete: "cascade" }),
    revision: text("revision").notNull(),
    fingerprint: text("fingerprint").notNull(),
    flowHash: text("flow_hash"),
    browserHash: text("browser_hash"),
    flowExpiresAt: timestamp("flow_expires_at", { withTimezone: true }),
    accountRef: text("account_ref"),
    companyName: text("company_name"),
    refreshTokenEnc: text("refresh_token_enc"),
    approvedAt: timestamp("approved_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zoho_recruit_account_ref_unique").on(t.accountRef)],
);
