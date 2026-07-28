/**
 * schema/newsletter.ts — Newsletter Subscriber Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   newsletter_subscribers   — Email addresses of people who signed up for
 *                              the Lexy marketing newsletter from the public
 *                              website. Tracks subscription status and opt-out.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   routes/newsletter.ts   — public subscription and unsubscribe endpoints
 */
import { pgTable, text, timestamp, boolean } from "drizzle-orm/pg-core";

export const newsletterSubscribersTable = pgTable("newsletter_subscribers", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  subscribedAt: timestamp("subscribed_at").notNull().defaultNow(),
  unsubscribedAt: timestamp("unsubscribed_at"),
  active: boolean("active").notNull().default(true),
  source: text("source").notNull().default("lexy-site"),
});

export type NewsletterSubscriber = typeof newsletterSubscribersTable.$inferSelect;
