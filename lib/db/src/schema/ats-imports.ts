import { pgTable, text, timestamp, jsonb, uniqueIndex, integer } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { recruitingWorkflowsTable } from "./recruiting-workflows";
import { candidatesTable } from "./candidates";

/** Private provenance only. Never stores contact payloads, stages or consent. */
export const atsCandidateProfilesTable = pgTable(
  "ats_candidate_profiles",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    system: text("system").notNull(),
    accountRef: text("account_ref").notNull(),
    externalCandidateId: text("external_candidate_id").notNull(),
    candidateId: text("candidate_id")
      .notNull()
      .references(() => candidatesTable.id, { onDelete: "cascade" }),
    importedBy: text("imported_by").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    fields: text("fields").array().notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    requestHash: text("request_hash").notNull(),
  },
  (t) => [
    uniqueIndex("ats_profile_external_person_unique").on(
      t.tenantId,
      t.system,
      t.accountRef,
      t.externalCandidateId,
    ),
    uniqueIndex("ats_profile_request_unique").on(t.tenantId, t.idempotencyKey),
  ],
);

/** External metadata intake only; not native candidates, stages or offer authority. */
export const atsImportedApplicationsTable = pgTable(
  "ats_imported_applications",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    workflowId: text("workflow_id")
      .notNull()
      .references(() => recruitingWorkflowsTable.id, { onDelete: "cascade" }),
    accountRef: text("account_ref").notNull(),
    externalJobId: text("external_job_id").notNull(),
    externalApplicationId: text("external_application_id").notNull(),
    snapshot: jsonb("snapshot")
      .$type<{
        job: { id: string; name: string; status: string };
        application: { id: string; candidateId: string; status: string; stageName: string | null };
      }>()
      .notNull(),
    importedBy: text("imported_by").notNull(),
    observedAt: timestamp("observed_at", { withTimezone: true }).notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
    refreshRevision: integer("refresh_revision").notNull().default(0),
    currentSnapshot: jsonb("current_snapshot").$type<{
      job: { id: string; name: string; status: string };
      application: { id: string; candidateId: string; status: string; stageName: string | null };
    }>(),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    availability: text("availability")
      .$type<"unchecked" | "available" | "unavailable">()
      .notNull()
      .default("unchecked"),
  },
  (t) => [
    uniqueIndex("ats_import_external_application_unique").on(
      t.tenantId,
      t.accountRef,
      t.externalApplicationId,
    ),
  ],
);
export const insertAtsImportedApplicationSchema = createInsertSchema(atsImportedApplicationsTable);

export const atsImportObservationsTable = pgTable(
  "ats_import_observations",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    recordId: text("record_id")
      .notNull()
      .references(() => atsImportedApplicationsTable.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    key: text("key").notNull(),
    requestHash: text("request_hash").notNull(),
    actorId: text("actor_id").notNull(),
    availability: text("availability").$type<"available" | "unavailable">().notNull(),
    snapshot: jsonb("snapshot")
      .$type<{
        job: { id: string; name: string; status: string };
        application: {
          id: string;
          candidateId: string;
          status: string;
          stageName: string | null;
        } | null;
      }>()
      .notNull(),
    checkedAt: timestamp("checked_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("ats_import_observation_key_unique").on(t.recordId, t.key),
    uniqueIndex("ats_import_observation_revision_unique").on(t.recordId, t.revision),
  ],
);
export const insertAtsImportObservationSchema = createInsertSchema(atsImportObservationsTable);
