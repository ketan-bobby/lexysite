import { pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { jobsTable } from "./jobs";

/** Identity provenance only; no remote job contents or OAuth credentials. */
export const zohoImportedJobsTable = pgTable(
  "zoho_imported_jobs",
  {
    id: text("id").primaryKey(),
    tenantId: text("tenant_id").notNull(),
    accountRef: text("account_ref").notNull(),
    externalJobId: text("external_job_id").notNull(),
    jobId: text("job_id")
      .notNull()
      .references(() => jobsTable.id, { onDelete: "cascade" }),
    importedBy: text("imported_by").notNull(),
    importedAt: timestamp("imported_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("zoho_imported_job_identity").on(t.tenantId, t.accountRef, t.externalJobId)],
);
