/**
 * schema/agent-runs.ts — Agent Run Event Model (audit log)
 *
 * ─── Why this table exists ────────────────────────────────────────────────────
 * Every autonomous agent activity (currently "sourcing") is modelled as an
 * AgentRun with an ordered stream of RunEvents. The UI subscribes to a run's
 * events (by polling) and renders live progress WITHOUT caring whether the
 * events came from the real sourcing pipeline or from `simulateSourcingRun`.
 * Both real and simulated runs write to the SAME tables, so the frontend has a
 * single stable contract.
 *
 * Runs + events persist forever — they are the audit log of what agents did.
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   agent_runs        — one row per run: work order, agent type, lifecycle status.
 *   agent_run_events  — ordered (seq) event stream belonging to a run.
 *
 * ─── RLS ─────────────────────────────────────────────────────────────────────
 * Both tables carry tenant_id and are scoped by app_tenant_in_scope() (see the
 * migration). Background writers (the simulate loop) use the BYPASSRLS admin
 * connection and ALWAYS set tenant_id explicitly; UI reads go through the
 * tenant-scoped lexy_app role.
 */
import { pgTable, text, timestamp, integer, jsonb, boolean, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

/** Lifecycle of a run. */
export const AGENT_RUN_STATUSES = [
  "queued",
  "running",
  "completed",
  "failed",
  "cancelled",
] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** Event kinds emitted during a run. */
export const RUN_EVENT_TYPES = [
  "step_started",
  "step_progress",
  "step_completed",
  "run_completed",
  "run_failed",
] as const;
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export const agentRunsTable = pgTable("agent_runs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  /* The work order (job) this run sourced for. */
  workOrderId: text("work_order_id").notNull(),
  /* Which agent produced the run. Currently only "sourcing". */
  agentType: text("agent_type").notNull().default("sourcing"),
  status: text("status").notNull().default("queued"),
  /* True when produced by simulateSourcingRun — the UI shows a "Demo run" badge
     and the candidates it creates carry source "agent_simulated". */
  isSimulated: boolean("is_simulated").notNull().default(false),
  /* Who/what kicked off the run (user id, "system", "schedule"). */
  triggeredBy: text("triggered_by").notNull().default("user"),
  /* Rolling summary counters for quick list rendering (found/screened/shortlisted). */
  summary: jsonb("summary").notNull().default({}),
  error: text("error"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
  updatedAt: timestamp("updated_at").notNull().defaultNow(),
}, (t) => ({
  workOrderIdx: index("agent_runs_work_order_idx").on(t.workOrderId),
  tenantIdx: index("agent_runs_tenant_idx").on(t.tenantId),
}));

export const agentRunEventsTable = pgTable("agent_run_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  tenantId: text("tenant_id").notNull(),
  runId: text("run_id").notNull(),
  /* Monotonic per-run ordering — the polling endpoint returns events with
     seq > `after` so the client fetches only what it hasn't seen. */
  seq: integer("seq").notNull(),
  type: text("type").notNull(),
  /* Machine-friendly stage id: "analyzing" | "searching" | "screening" |
     "ranking" | "shortlist" (free-form so real pipeline stages fit too). */
  stepName: text("step_name"),
  /* Human-readable line, e.g. "Screening 214 profiles against requirements". */
  message: text("message").notNull(),
  /* Optional running count (profiles found, profiles passing, etc.). */
  count: integer("count"),
  /* Optional structured payload (e.g. { candidateIds: [...] }). */
  payload: jsonb("payload"),
  timestamp: timestamp("timestamp", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  runSeqIdx: index("agent_run_events_run_seq_idx").on(t.runId, t.seq),
}));

export const insertAgentRunSchema = createInsertSchema(agentRunsTable).omit({ id: true, createdAt: true, updatedAt: true });
export const insertRunEventSchema = createInsertSchema(agentRunEventsTable).omit({ id: true });
export type InsertAgentRun = z.infer<typeof insertAgentRunSchema>;
export type InsertRunEvent = z.infer<typeof insertRunEventSchema>;
export type AgentRun = typeof agentRunsTable.$inferSelect;
export type RunEvent = typeof agentRunEventsTable.$inferSelect;
