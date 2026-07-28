/**
 * schema/recruiter-admin-clients.ts — Recruiter Admin → Client (sub-tenant) assignments
 *
 * ─── What this table does ────────────────────────────────────────────────────
 * Maps a `recruiter_admin` user to the client sub-tenants they manage. A
 * Tenant Admin owns billing and creates client sub-tenants (tenants.parent_id,
 * client_type='sub_client'), then assigns one or more of those clients to a
 * Recruiter Admin via rows in this table.
 *
 *   • The SAME client may be assigned to MULTIPLE recruiter admins.
 *   • ONE recruiter admin may hold MULTIPLE clients.
 *   • A recruiter admin with NO rows here sees nothing.
 *
 * ─── Tenant scoping (RLS) ────────────────────────────────────────────────────
 * `tenantId` is the AGENCY (parent) tenant that owns both the recruiter admin
 * user and the client sub-tenants. It exists purely so the standard
 * tenant_isolation RLS policy (app_tenant_in_scope(tenant_id), migration 0021)
 * applies uniformly — the row is visible/writable to the owning agency subtree.
 * `clientTenantId` is the assigned sub-tenant; data visibility for the
 * recruiter admin is narrowed at the app layer to exactly this set.
 */
import { pgTable, text, timestamp, uniqueIndex, index } from "drizzle-orm/pg-core";
import { createInsertSchema, createSelectSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const recruiterAdminClientsTable = pgTable(
  "recruiter_admin_clients",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    // Agency (parent) tenant — the RLS scope for this assignment row.
    tenantId: text("tenant_id").notNull(),
    // The recruiter_admin user being granted access.
    recruiterAdminUserId: text("recruiter_admin_user_id").notNull(),
    // The client sub-tenant assigned to that recruiter admin.
    clientTenantId: text("client_tenant_id").notNull(),
    // Who made the assignment (tenant_admin / platform_admin). Best-effort audit.
    assignedByUserId: text("assigned_by_user_id"),
    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    // One row per (recruiter admin, client) — idempotent assignment.
    uniqAssign: uniqueIndex("recruiter_admin_clients_uniq").on(
      t.recruiterAdminUserId,
      t.clientTenantId,
    ),
    byUser: index("recruiter_admin_clients_user_idx").on(t.recruiterAdminUserId),
    byTenant: index("recruiter_admin_clients_tenant_idx").on(t.tenantId),
  }),
);

export const insertRecruiterAdminClientSchema = createInsertSchema(recruiterAdminClientsTable).omit({
  id: true,
  createdAt: true,
});
export const selectRecruiterAdminClientSchema = createSelectSchema(recruiterAdminClientsTable);
export type InsertRecruiterAdminClient = z.infer<typeof insertRecruiterAdminClientSchema>;
export type RecruiterAdminClient = typeof recruiterAdminClientsTable.$inferSelect;
