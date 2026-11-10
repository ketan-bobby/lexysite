import { pgTable, text, integer, jsonb, timestamp } from "drizzle-orm/pg-core";

export type SourcingLimits = {
  allowExternal: boolean;
  providers: ("github" | "pdl" | "serp" | "enrichlayer")[];
  maxCandidates: number;
  maxDurationSeconds: number;
  maxRuns: number;
  runBudgetCents: number;
  totalBudgetCents: number;
  accountRates?: Partial<
    Record<
      "pdl" | "serp" | "enrichlayer",
      {
        microsPerCredit: number;
        basis: "prepaid_allocation" | "payg";
        source: string;
        expiresAt: string;
      }
    >
  >;
};

export const sourcingPoliciesTable = pgTable("sourcing_policies", {
  jobId: text("job_id").primaryKey(),
  tenantId: text("tenant_id").notNull(),
  revision: integer("revision").notNull(),
  limits: jsonb("limits").$type<SourcingLimits>().notNull(),
  status: text("status").$type<"draft" | "approved" | "paused">().notNull(),
  briefHash: text("brief_hash").notNull(),
  journeyId: text("journey_id"),
  approvedById: text("approved_by_id"),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sourcingReservationsTable = pgTable("sourcing_reservations", {
  id: text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID()),
  jobId: text("job_id").notNull(),
  tenantId: text("tenant_id").notNull(),
  policyRevision: integer("policy_revision").notNull(),
  policyHash: text("policy_hash").notNull(),
  briefHash: text("brief_hash").notNull(),
  journeyId: text("journey_id").notNull(),
  limits: jsonb("limits").$type<SourcingLimits>().notNull(),
  reservedCents: integer("reserved_cents").notNull(),
  status: text("status").$type<"reserved" | "paused" | "cancelled">().notNull(),
  revision: integer("revision").notNull().default(1),
  createdById: text("created_by_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
