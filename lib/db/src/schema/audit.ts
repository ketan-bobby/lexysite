/**
 * schema/audit.ts — Immutable Audit Log Table
 *
 * ─── Tables ──────────────────────────────────────────────────────────────────
 *   audit_logs   — Append-only log of every significant action in the system.
 *                  Captures actor, subject, channel, direction, action, and
 *                  truncated body for compliance (GDPR/CCPA) and debugging.
 *                  Never updated or deleted — rows are permanent.
 *
 * ─── Used by ─────────────────────────────────────────────────────────────────
 *   lib/audit.ts         — recordAudit() writes every row
 *   routes/audit.ts      — exposes read-only audit log API
 */
import { pgTable, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

/**
 * audit_logs — every conversation/message between the system and a user.
 *
 * One row is inserted whenever:
 *   • the system sends an email (outreach, interview invite, status update, …)
 *   • the system creates an in-app notification for a staff user or candidate
 *   • the system receives an inbound message (email reply, webhook)
 *   • a staff user performs a notable action (override, stage advance, …)
 *
 * Designed to be append-only — never UPDATE / DELETE rows here.
 */
export const auditLogsTable = pgTable(
  "audit_logs",
  {
    id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
    tenantId: text("tenant_id"),

    // Who/what produced the event.
    //   "system" | "agent" | "user" | "candidate" | "external"
    actorType: text("actor_type").notNull(),
    actorId: text("actor_id"),
    actorLabel: text("actor_label"), // e.g. "Outreach Engine", "Sara Mansour"

    // Who/what received the event.
    //   "user" | "candidate" | "system" | "external"
    subjectType: text("subject_type"),
    subjectId: text("subject_id"),
    subjectLabel: text("subject_label"), // e.g. candidate name, recruiter name

    // How the message was delivered.
    //   "email" | "in_app" | "sms" | "webhook" | "system"
    channel: text("channel").notNull(),

    // Direction of the message — "outbound" (system→user) or "inbound" (user→system) or "internal".
    direction: text("direction").notNull(),

    // What happened — short slug used for filtering, e.g.
    //   "email.sent", "email.simulated", "email.failed",
    //   "notification.user", "notification.candidate",
    //   "inbound.reply.classified", "inbound.webhook.received",
    //   "stage.changed", "candidate.advanced", …
    action: text("action").notNull(),

    // Human-readable summary (subject line / notification title / etc).
    title: text("title"),
    // Full body / payload snippet (truncated for very large bodies).
    body: text("body"),

    // Free-form context: jobId, sessionId, classification, error message, IP, etc.
    metadata: jsonb("metadata"),

    createdAt: timestamp("created_at").notNull().defaultNow(),
  },
  (t) => ({
    tenantIdx: index("audit_logs_tenant_idx").on(t.tenantId, t.createdAt),
    subjectIdx: index("audit_logs_subject_idx").on(t.subjectType, t.subjectId),
    actionIdx: index("audit_logs_action_idx").on(t.action, t.createdAt),
  }),
);

export type AuditLog = typeof auditLogsTable.$inferSelect;
export type InsertAuditLog = typeof auditLogsTable.$inferInsert;
