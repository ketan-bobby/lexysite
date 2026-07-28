/**
 * schema/trial-signups.ts — Pending Email-Verification Rows for Self-Serve Trials
 *
 * One row is inserted by POST /api/plans/start-trial when a prospect requests a
 * demo trial. The row holds the verification token + the form fields they
 * supplied. No tenant or user is created until they click the magic link in
 * their email (GET /api/plans/start-trial/verify?token=...). This prevents:
 *   - Tenant spam from forged email addresses
 *   - Bot-driven enumeration of which emails already have an account
 *   - Stale orphan tenants when prospects abandon mid-flow
 *
 * Tokens are 32-byte base64url, expire in 24 hours. Once consumed, the row
 * stays for audit but cannot be re-used (consumedAt set).
 */
import { pgTable, text, timestamp } from "drizzle-orm/pg-core";

export const pendingTrialSignupsTable = pgTable("pending_trial_signups", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  /** URL-safe verification token (32 bytes base64url). Looked up by exact match. */
  token: text("token").notNull().unique(),
  email: text("email").notNull(),
  name: text("name").notNull(),
  company: text("company").notNull(),
  /** Source IP at request time — used by the rate limiter and for abuse audits. */
  requestIp: text("request_ip"),
  expiresAt: timestamp("expires_at").notNull(),
  /** Set when the verify endpoint successfully consumed this token. NULL = unused. */
  consumedAt: timestamp("consumed_at"),
  /** Tenant created on consumption. NULL until verified. */
  createdTenantId: text("created_tenant_id"),
  /** Short-lived (≤5 min) one-time login token minted at verify time. The
   *  trial-exchange page on the lexy app POSTs this back to /api/auth/exchange
   *  -trial-token, which atomically claims it and returns a session token.
   *  This avoids ever using URL-based ?autologin=<email> shortcuts that would
   *  let anyone who knows a trial email log in. */
  loginToken: text("login_token").unique(),
  loginTokenExpiresAt: timestamp("login_token_expires_at"),
  loginTokenConsumedAt: timestamp("login_token_consumed_at"),
  /** Set when the prospect signed up through the paid /signup page rather than
   *  the email-verification trial flow. Null = legacy/free trial flow. */
  passwordHash: text("password_hash"),
  /** Selected paid plan ('starter' | 'growth') from the /signup page. Null for
   *  the legacy demo-trial flow. The webhook reads this to set tenant.plan
   *  when checkout.session.completed fires. */
  planCode: text("plan_code"),
  /** Stripe Checkout Session id, captured at session creation. Lets the
   *  client poll signup status without exposing the raw token. */
  stripeCheckoutSessionId: text("stripe_checkout_session_id"),
  /** Stripe Customer id created during checkout. Persisted on the tenant
   *  row when the webhook provisions it. */
  stripeCustomerId: text("stripe_customer_id"),
  /** Selected pricing region (lowercase ISO-3166-1 alpha-2 or 'eu'/'row'
   *  bucket). Drives Stripe Price ID lookup at checkout and is copied to
   *  tenants.region on provisioning. Null = legacy/free trial flow. */
  region: text("region"),
  /** Optional context captured by the public /start-trial form (lexy-site).
   *  All nullable — the legacy /plans/demo alias and older rows do not have
   *  these fields. Used by the platform_admin Trial Requests inbox to help
   *  triage and prioritize incoming prospects. */
  role: text("role"),
  teamSize: text("team_size"),
  hiringFocus: text("hiring_focus"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
});

export type PendingTrialSignup = typeof pendingTrialSignupsTable.$inferSelect;
