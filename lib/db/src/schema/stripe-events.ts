/**
 * schema/stripe-events.ts — stripe_processed_events (Migration 0017)
 *
 * Single ledger of Stripe webhook deliveries we have already
 * processed. The webhook handler INSERTs at the top; ON CONFLICT
 * (event_id) DO NOTHING → no rows affected → handler short-circuits
 * with 200 and skips every downstream side effect. This is the
 * platform's exact-once guarantee for billing webhooks.
 */
import { pgTable, text, timestamp, boolean, jsonb } from "drizzle-orm/pg-core";

/* Two-phase processing flag (Migration 0018):
 *   processed_at IS NULL      → claim in flight or failed mid-handler.
 *                               Stripe retries must re-attempt — the
 *                               handler DELETEs the row on its own
 *                               failure so the next delivery can
 *                               re-claim.
 *   processed_at IS NOT NULL  → fully handled; retries 200 short-circuit.
 */
export const stripeProcessedEventsTable = pgTable("stripe_processed_events", {
  eventId: text("event_id").primaryKey(),
  eventType: text("event_type").notNull(),
  livemode: boolean("livemode"),
  apiVersion: text("api_version"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  claimedAt: timestamp("claimed_at", { withTimezone: true }).notNull().defaultNow(),
  processedAt: timestamp("processed_at", { withTimezone: true }),
  payloadDigest: text("payload_digest"),
  payload: jsonb("payload").notNull().default({}),
});

export type StripeProcessedEvent = typeof stripeProcessedEventsTable.$inferSelect;
