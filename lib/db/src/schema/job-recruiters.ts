/**
 * schema/job-recruiters.ts — Additional recruiters assigned to a work order
 *
 * ─── What this table does ────────────────────────────────────────────────────
 * A work order (jobs.id) keeps ONE primary/lead recruiter in
 * jobs.assigned_recruiter_id (unchanged). This table holds any ADDITIONAL
 * recruiters who also work the requisition, so a work order can be staffed by
 * several recruiters.
 *
 *   • The full assigned set for a job = jobs.assigned_recruiter_id ∪ these rows.
 *   • A plain `recruiter` may see/act on a requisition (and its candidates) when
 *     they are the primary recruiter OR appear here for that job. The recruiter
 *     ownership ceiling (getRecruiterAssignedJobIds) unions this table.
 *
 * ─── Tenant scoping (RLS) ────────────────────────────────────────────────────
 * `tenantId` is the work order's tenant and is the RLS scope, so the standard
 * tenant_isolation policy (app_tenant_in_scope(tenant_id)) applies uniformly —
 * mirroring recruiter_managers (migration 0036).
 */
import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const jobRecruitersTable = pgTable(
  "job_recruiters",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    // Work order's tenant — the RLS scope for this assignment row.
    tenantId: text("tenant_id").notNull(),
    // The work order (jobs.id) this recruiter is assigned to.
    jobId: text("job_id").notNull(),
    // The recruiter user assigned to the work order.
    recruiterUserId: text("recruiter_user_id").notNull(),
    // Who created the assignment. Best-effort audit.
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // One row per (job, recruiter) — idempotent link.
    uniqLink: uniqueIndex("job_recruiters_uniq").on(t.jobId, t.recruiterUserId),
    byJob: index("job_recruiters_job_idx").on(t.jobId),
    byRecruiter: index("job_recruiters_recruiter_idx").on(t.recruiterUserId),
    byTenant: index("job_recruiters_tenant_idx").on(t.tenantId),
  }),
);

export const insertJobRecruiterSchema = createInsertSchema(jobRecruitersTable).omit({
  id: true,
  createdAt: true,
});
export const selectJobRecruiterSchema = createSelectSchema(jobRecruitersTable);
export type InsertJobRecruiter = z.infer<typeof insertJobRecruiterSchema>;
export type JobRecruiter = typeof jobRecruitersTable.$inferSelect;
