import { pgTable, text, integer, bigint, jsonb, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const sourcingExecutionLeasesTable = pgTable("sourcing_execution_leases", {
  reservationId: text("reservation_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  jobId: text("job_id").notNull(),
  actorId: text("actor_id").notNull(),
  generation: integer("generation").notNull(),
  owner: text("owner").notNull(),
  leaseUntil: timestamp("lease_until", { withTimezone: true }).notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  deadline: timestamp("deadline", { withTimezone: true }).notNull(),
  candidateIds: jsonb("candidate_ids").$type<string[]>().notNull().default([]),
});

export const sourcingCostOperationsTable = pgTable(
  "sourcing_cost_operations",
  {
    id: text("id")
      .primaryKey()
      .$defaultFn(() => crypto.randomUUID()),
    reservationId: text("reservation_id").notNull(),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    operationKey: text("operation_key").notNull(),
    requestHash: text("request_hash").notNull(),
    provider: text("provider").notNull(),
    pricingVersion: text("pricing_version").notNull(),
    quoteExpiresAt: timestamp("quote_expires_at", { withTimezone: true }).notNull(),
    evidence: text("evidence").notNull(),
    billingEvidence: text("billing_evidence"),
    upperMicros: bigint("upper_micros", { mode: "number" }).notNull(),
    actualMicros: bigint("actual_micros", { mode: "number" }),
    reportedMicros: bigint("reported_micros", { mode: "number" }),
    status: text("status")
      .$type<"prepared" | "dispatching" | "uncertain" | "settled" | "void">()
      .notNull(),
    generation: integer("generation").notNull(),
    attemptToken: text("attempt_token").notNull(),
    dispatchedAt: timestamp("dispatched_at", { withTimezone: true }),
    settledAt: timestamp("settled_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("sourcing_cost_operation_identity").on(t.reservationId, t.operationKey)],
);
