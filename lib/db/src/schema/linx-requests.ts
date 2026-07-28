/**
 * schema/linx-requests.ts — LINX Engagement Requests (cross-tenant handoff)
 *
 * ─── What this is ────────────────────────────────────────────────────────────
 * A client-side recruiter (any recruiter with access to the job — not
 * admin-gated) asks LINX (a separate tenant in Lexy) for help filling a role.
 * LINX reviews and accepts/declines. On accept, a real requisition is created
 * INSIDE LINX's own tenant, cloned from job METADATA only (`linxReqId` points
 * at it). NO candidate data ever crosses the tenant boundary — this table
 * carries job/contact/workflow-status data exclusively.
 *
 * No billing/payment logic anywhere: agreements and fees live entirely
 * outside the platform. `status` is pure workflow tracking.
 *
 * ─── Visibility (dual-tenant, RLS-enforced) ─────────────────────────────────
 * A row is visible to exactly two parties (migration 0050, Class-A FORCE RLS):
 *   (a) the ORIGINATING tenant  — app_tenant_in_scope(tenant_id)
 *   (b) the LINX tenant         — app_tenant_in_scope(linx_tenant_id)
 * No other tenant can see the row. Dev environments strip most RLS (see
 * memory: dev-rls-stripped), so API routes MUST additionally gate every read/
 * write with an explicit `tenant_id ∈ scope OR linx_tenant_id ∈ scope`
 * predicate — the policy is the prod backstop, not the only seal.
 *
 * ─── Status lifecycle ────────────────────────────────────────────────────────
 *   pending  → accepted (LINX; sets respondedAt + linxReqId)
 *            → declined (LINX; sets respondedAt + declineReason)
 *   accepted → filled | closed (sets resolvedAt)
 * `linxTenantId` is a known config constant server-side — never user-selected.
 */
import { pgTable, text, timestamp, index } from "drizzle-orm/pg-core";

export const LINX_REQUEST_STATUSES = [
  "pending",
  "accepted",
  "declined",
  "filled",
  "closed",
] as const;
export type LinxRequestStatus = (typeof LINX_REQUEST_STATUSES)[number];

export const linxRequestsTable = pgTable(
  "linx_requests",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    /* Originating CLIENT tenant (owner side of the handoff). */
    tenantId: text("tenant_id").notNull(),
    jobId: text("job_id").notNull(),
    requestedByUserId: text("requested_by_user_id").notNull(),
    /* Who LINX coordinates with by email, OUTSIDE the platform — required. */
    contactName: text("contact_name").notNull(),
    contactEmail: text("contact_email").notNull(),
    /* Optional urgency/context free text from the requester. */
    note: text("note"),
    /* Workflow status only — no billing semantics. CHECK-constrained in SQL. */
    status: text("status").$type<LinxRequestStatus>().notNull().default("pending"),
    declineReason: text("decline_reason"),
    /* The LINX tenant this request targets — server config constant. */
    linxTenantId: text("linx_tenant_id").notNull(),
    /* Requisition created inside LINX's tenant on accept (metadata clone). */
    linxReqId: text("linx_req_id"),
    requestedAt: timestamp("requested_at", { withTimezone: true }).notNull().defaultNow(),
    /* When LINX accepted/declined. */
    respondedAt: timestamp("responded_at", { withTimezone: true }),
    /* When the request reached a terminal state (filled/closed). */
    resolvedAt: timestamp("resolved_at", { withTimezone: true }),
  },
  t => ({
    tenantIdx: index("linx_requests_tenant_idx").on(t.tenantId, t.requestedAt),
    linxTenantIdx: index("linx_requests_linx_tenant_idx").on(t.linxTenantId, t.status, t.requestedAt),
    jobIdx: index("linx_requests_job_idx").on(t.jobId),
  }),
);

export type LinxRequest = typeof linxRequestsTable.$inferSelect;
export type NewLinxRequest = typeof linxRequestsTable.$inferInsert;
