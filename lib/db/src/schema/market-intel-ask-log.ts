/**
 * schema/market-intel-ask-log.ts — Market Intelligence Q&A audit log
 *
 * ─── What this table holds ───────────────────────────────────────────────────
 * One row per POST /market-intelligence/ask invocation: the recruiter's
 * question, the final answer + confidence line served, and the FULL list of
 * tool calls actually executed (tool, sanitized params, status, sample size,
 * summary, asOf) plus coverage stats. This is the grounding audit trail — a
 * human can spot-check whether answers stayed grounded in tool data or drifted
 * into confident-sounding invention.
 *
 * ─── Fire-and-forget insert ──────────────────────────────────────────────────
 * routes/market-intelligence.ts inserts via dbAdmin and never awaits the write
 * on the request path — failures are swallowed so audit logging can never slow
 * down or break a live answer.
 *
 * ─── Access ──────────────────────────────────────────────────────────────────
 * Not RLS-protected (Class B). Rows contain the caller's free-text question,
 * which may mention candidate names — reads are therefore restricted to
 * platform_admin ONLY (rollout spot-check surface, not a tenant feature).
 */
import { pgTable, text, timestamp, integer, boolean, jsonb, index } from "drizzle-orm/pg-core";

export const marketIntelAskEventsTable = pgTable(
  "market_intel_ask_events",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    /* Who asked (audit provenance — not a visibility scope). */
    userId: text("user_id").notNull(),
    tenantId: text("tenant_id"),
    question: text("question").notNull(),
    answer: text("answer").notNull(),
    confidence: text("confidence").notNull(),
    /* Array of executed tool calls: [{tool, params, status, sampleSize?, summary, asOf}] */
    sources: jsonb("sources").notNull(),
    /* {toolsCalled, okCount, noDataCount, sufficient} */
    coverage: jsonb("coverage").notNull(),
    /* True when the deterministic insufficient-data answer replaced the model narrative. */
    insufficient: boolean("insufficient").notNull(),
    latencyMs: integer("latency_ms").notNull(),
  },
  (t) => ({
    createdAtIdx: index("market_intel_ask_events_created_at_idx").on(t.createdAt),
  }),
);

export type MarketIntelAskEvent = typeof marketIntelAskEventsTable.$inferSelect;
