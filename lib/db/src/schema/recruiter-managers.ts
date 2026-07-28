/**
 * schema/recruiter-managers.ts — Recruiter → Recruiter Admin reporting links
 *
 * ─── What this table does ────────────────────────────────────────────────────
 * Maps a `recruiter` user to the `recruiter_admin` user(s) they report to. A
 * Tenant Admin sets these links on the Team page so the agency's reporting
 * structure is explicit (rather than only inferred from job/client assignments).
 *
 *   • ONE recruiter may report to MULTIPLE recruiter admins.
 *   • The SAME recruiter admin may have MULTIPLE recruiters reporting to them.
 *   • A recruiter with NO rows here reports to no one (shown ungrouped).
 *
 * ─── Default vs per-work-order reporting ─────────────────────────────────────
 *   • `jobId` NULL  → the recruiter's DEFAULT reporting (applies to every work
 *     order they have not customised). This is the original behaviour.
 *   • `jobId` set   → a per-work-order OVERRIDE. Reporting for that single work
 *     order (jobs.id) can differ from the default, because the supervising
 *     recruiter admin often depends on the client / work order.
 *
 * ─── Tenant scoping (RLS) ────────────────────────────────────────────────────
 * `tenantId` is the AGENCY (parent) tenant that owns both the recruiter and the
 * recruiter admin users. It exists purely so the standard tenant_isolation RLS
 * policy (app_tenant_in_scope(tenant_id), migration 0021) applies uniformly —
 * the row is visible/writable to the owning agency subtree. This mirrors
 * recruiter_admin_clients exactly.
 */
import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recruiterManagersTable = pgTable(
  "recruiter_managers",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    // Agency (parent) tenant — the RLS scope for this reporting row.
    tenantId: text("tenant_id").notNull(),
    // The recruiter user who reports.
    recruiterUserId: text("recruiter_user_id").notNull(),
    // The recruiter_admin user they report to.
    recruiterAdminUserId: text("recruiter_admin_user_id").notNull(),
    // Work order (jobs.id) this reporting link is scoped to. NULL = the
    // recruiter's default reporting; a value = a per-work-order override.
    jobId: text("job_id"),
    // Who created the link (tenant_admin / platform_admin). Best-effort audit.
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // One row per (recruiter, recruiter admin, work order) — idempotent link.
    // The real DB index keys on COALESCE(job_id,'') so NULL (default) rows are
    // also de-duplicated; see migration 0037.
    uniqLink: uniqueIndex("recruiter_managers_uniq").on(
      t.recruiterUserId,
      t.recruiterAdminUserId,
      t.jobId,
    ),
    byRecruiter: index("recruiter_managers_recruiter_idx").on(t.recruiterUserId),
    byAdmin: index("recruiter_managers_admin_idx").on(t.recruiterAdminUserId),
    byJob: index("recruiter_managers_job_idx").on(t.jobId),
    byTenant: index("recruiter_managers_tenant_idx").on(t.tenantId),
  }),
);

export const insertRecruiterManagerSchema = createInsertSchema(recruiterManagersTable).omit({
  id: true,
  createdAt: true,
});
export const selectRecruiterManagerSchema = createSelectSchema(recruiterManagersTable);
export type InsertRecruiterManager = z.infer<typeof insertRecruiterManagerSchema>;
export type RecruiterManager = typeof recruiterManagersTable.$inferSelect;
