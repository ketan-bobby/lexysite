import { boolean, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { tenantsTable } from "./tenants";

export const qorPartnerCredentialsTable = pgTable("qor_partner_credentials", {
  digest: text("digest").primaryKey(),
  tenantId: text("tenant_id")
    .notNull()
    .references(() => tenantsTable.id, { onDelete: "cascade" }),
  canCreate: boolean("can_create").notNull().default(false),
  canRead: boolean("can_read").notNull().default(false),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}).enableRLS();

export const qorInterviewRequestsTable = pgTable(
  "qor_interview_requests",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tenantId: text("tenant_id")
      .notNull()
      .references(() => tenantsTable.id, { onDelete: "cascade" }),
    idempotencyHash: text("idempotency_hash").notNull(),
    applicationHash: text("application_hash").notNull(),
    payloadHash: text("payload_hash").notNull(),
    externalApplicationId: text("external_application_id"),
    externalCandidateId: text("external_candidate_id"),
    contactHash: text("contact_hash"),
    selectionRef: text("selection_ref"),
    externalJobId: text("external_job_id"),
    jobTitle: text("job_title"),
    jobBrief: text("job_brief"),
    jobRevision: text("job_revision"),
    jobApprovalRef: text("job_approval_ref"),
    jobId: text("job_id"),
    candidateId: text("candidate_id"),
    sessionId: text("session_id").unique(),
    preparedBy: text("prepared_by"),
    invitationReleasedAt: timestamp("invitation_released_at", { withTimezone: true }),
    invitationReleasedBy: text("invitation_released_by"),
    invitationReportedAt: timestamp("invitation_reported_at", { withTimezone: true }),
    invitationReportedBy: text("invitation_reported_by"),
    reportHash: text("report_hash"),
    reportVersion: integer("report_version").notNull().default(0),
    reportApprovedAt: timestamp("report_approved_at", { withTimezone: true }),
    reportApprovedBy: text("report_approved_by"),
    erasedAt: timestamp("erased_at", { withTimezone: true }),
  },
  (t) => [
    uniqueIndex("qor_request_idempotency").on(t.tenantId, t.idempotencyHash),
    uniqueIndex("qor_request_application").on(t.tenantId, t.applicationHash),
    uniqueIndex("qor_request_candidate_job").on(t.tenantId, t.jobId, t.candidateId),
  ],
).enableRLS();
