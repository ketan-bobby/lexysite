import { pgTable, text, integer, timestamp, uniqueIndex, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { recruitingWorkflowsTable } from "./recruiting-workflows";
import { candidatesTable } from "./candidates";

/** Private server-only allocation. Neither credentials nor remote connection health. */
export const employerAtsBindingsTable = pgTable(
  "employer_ats_bindings",
  {
    tenantId: text("tenant_id").primaryKey(),
    connectionId: text("connection_id").notNull(),
    accountRef: text("account_ref").notNull(),
    revision: integer("revision").notNull(),
    status: text("status").$type<"pending_employer" | "active" | "disconnected">().notNull(),
    allocatedBy: text("allocated_by").notNull(),
    confirmedBy: text("confirmed_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("employer_ats_connection_owner_unique").on(t.connectionId)],
);

export const atsMappingVerificationsTable = pgTable(
  "ats_mapping_verifications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => recruitingWorkflowsTable.id, { onDelete: "cascade" }),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidatesTable.id, { onDelete: "cascade" }),
    actorId: text("actor_id").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    mappingHash: text("mapping_hash").notNull(),
    mapping: jsonb("mapping")
      .$type<{
        system: string;
        accountRef: string;
        externalJobId: string;
        externalCandidateId: string;
        externalApplicationId: string;
      }>()
      .notNull(),
    workflowRevision: integer("workflow_revision").notNull(),
    bindingRevision: integer("binding_revision").notNull(),
    status: text("status").$type<"checking" | "verified" | "failed" | "discarded">().notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("ats_verification_request_unique").on(t.tenantId, t.workflowId, t.key)],
);
export const insertEmployerAtsBindingSchema = createInsertSchema(employerAtsBindingsTable);
export const insertAtsMappingVerificationSchema = createInsertSchema(atsMappingVerificationsTable);
