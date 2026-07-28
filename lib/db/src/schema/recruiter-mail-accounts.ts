/**
 * schema/recruiter-mail-accounts.ts — Per-recruiter connected mailbox (Microsoft 365 / Outlook)
 *
 * ─── What this table does ────────────────────────────────────────────────────
 * Stores the OAuth connection that lets Lexy send email "as the recruiter" from
 * their own Microsoft 365 / Outlook mailbox via Microsoft Graph, instead of from
 * the shared Amazon SES sender. Used for:
 *   • manual 1:1 emails a recruiter sends by hand, and
 *   • the first / approved outreach step for candidates that recruiter owns.
 * Automated follow-ups, drips, digests and system mail continue to go via SES.
 *
 * One row PER recruiter (user_id is unique). The Graph refresh token is stored
 * ENCRYPTED at rest (AES-256-GCM, see lib/crypto-secrets.ts) — never in plaintext.
 *
 * ─── Tenant scoping (RLS) ────────────────────────────────────────────────────
 * `tenantId` is the recruiter's own tenant and exists purely so the standard
 * tenant_isolation RLS policy (app_tenant_in_scope(tenant_id)) applies uniformly.
 *
 * ─── Reply sync (Phase D) ────────────────────────────────────────────────────
 * graphSubscriptionId / graphSubscriptionExpiresAt / graphDeltaLink support
 * pulling candidate replies that land in the recruiter's Outlook back into Lexy
 * (Microsoft Graph change notifications + delta query).
 */
import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recruiterMailAccountsTable = pgTable(
  "recruiter_mail_accounts",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    // RLS scope — the recruiter's own tenant.
    tenantId: text("tenant_id").notNull(),
    // The recruiter (users.id) who owns this mailbox connection. Unique.
    userId: text("user_id").notNull(),
    provider: text("provider").notNull().default("microsoft"),
    // The connected mailbox address (lowercased) — shown in the "sending as" UI.
    email: text("email").notNull().default(""),
    // MSAL home account id — used to disambiguate the cached refresh token.
    homeAccountId: text("home_account_id"),
    // AES-256-GCM ciphertext of the Graph refresh token. NEVER plaintext.
    refreshTokenEnc: text("refresh_token_enc"),
    scopes: text("scopes").notNull().default(""),
    // connected | error | revoked. Only "connected" is eligible to send.
    status: text("status").notNull().default("connected"),
    lastError: text("last_error"),
    // ── Reply sync (Phase D) ──
    graphSubscriptionId: text("graph_subscription_id"),
    graphSubscriptionExpiresAt: timestamp("graph_subscription_expires_at"),
    graphDeltaLink: text("graph_delta_link"),
    connectedAt: timestamp("connected_at").notNull().defaultNow(),
    updatedAt: timestamp("updated_at").notNull().defaultNow(),
  },
  (t) => ({
    uniqUser: uniqueIndex("recruiter_mail_accounts_user_uniq").on(t.userId),
    byTenant: index("recruiter_mail_accounts_tenant_idx").on(t.tenantId),
    bySub: index("recruiter_mail_accounts_sub_idx").on(t.graphSubscriptionId),
  }),
);

export const insertRecruiterMailAccountSchema = createInsertSchema(recruiterMailAccountsTable).omit({
  id: true,
  connectedAt: true,
  updatedAt: true,
});
export const selectRecruiterMailAccountSchema = createSelectSchema(recruiterMailAccountsTable);
export type InsertRecruiterMailAccount = z.infer<typeof insertRecruiterMailAccountSchema>;
export type RecruiterMailAccount = typeof recruiterMailAccountsTable.$inferSelect;
