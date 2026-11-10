import { pgTable, text, integer, timestamp, jsonb, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { recruitingWorkflowsTable } from "./recruiting-workflows";

export type AtsScheduledItem = {
  recordId: string;
  expectedRevision: number;
  status: "pending" | "checking" | "available" | "unavailable" | "unconfirmed" | "not_started";
  checkedAt: string | null;
};

export const atsRefreshSchedulesTable = pgTable(
  "ats_refresh_schedules",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => recruitingWorkflowsTable.id, { onDelete: "cascade" }),
    ownerUserId: text("owner_user_id").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").$type<"enabled" | "paused">().notNull(),
    recordIds: jsonb("record_ids").$type<string[]>().notNull(),
    intervalMinutes: integer("interval_minutes").notNull(),
    bindingRevision: integer("binding_revision").notNull(),
    workflowRevision: integer("workflow_revision").notNull(),
    authorityHash: text("authority_hash").notNull(),
    nextRunAt: timestamp("next_run_at", { withTimezone: true }),
    blockedReason: text("blocked_reason"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ats_refresh_schedule_workflow_unique").on(t.workflowId),
    index("ats_refresh_schedule_due").on(t.status, t.nextRunAt),
  ],
);

export const atsRefreshRunsTable = pgTable(
  "ats_refresh_runs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => recruitingWorkflowsTable.id, { onDelete: "cascade" }),
    scheduleId: text("schedule_id")
      .notNull()
      .references(() => atsRefreshSchedulesTable.id, { onDelete: "cascade" }),
    scheduleRevision: integer("schedule_revision").notNull(),
    status: text("status").$type<"running" | "completed" | "stopped" | "interrupted">().notNull(),
    items: jsonb("items").$type<AtsScheduledItem[]>().notNull(),
    message: text("message"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (t) => [
    index("ats_refresh_run_history").on(t.tenantId, t.workflowId, t.startedAt),
    uniqueIndex("ats_refresh_one_running")
      .on(t.scheduleId)
      .where(sql`${t.status} = 'running'`),
  ],
);
