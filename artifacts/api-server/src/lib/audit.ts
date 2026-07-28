/**
 * audit.ts — Immutable Audit Log Writer
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Provides a single fire-and-forget function (recordAudit) that appends a row
 * to the `audit_logs` table. Every outbound communication, AI decision, stage
 * change, and access event should call recordAudit() so there is a complete,
 * tamper-evident trail for compliance (GDPR / CCPA) and debugging.
 *
 * ─── Design principles ───────────────────────────────────────────────────────
 * • NEVER throws — auditing must never break the action it's recording.
 *   All errors are swallowed and logged via pino.
 * • Callers use `void recordAudit(...)` to make the fire-and-forget intent
 *   explicit. Awaiting it is also fine when ordering matters.
 * • Body is truncated to MAX_BODY (8 000 chars) so a single large email body
 *   cannot bloat the table.
 *
 * ─── Schema ──────────────────────────────────────────────────────────────────
 *   tenantId    — null for platform-level events
 *   actorType   — "system" | "agent" | "user" | "candidate" | "external"
 *   actorLabel  — human-readable actor name (e.g. "Outreach Engine")
 *   subjectType — the entity being acted on
 *   subjectId   — candidateId / userId / etc.
 *   channel     — "email" | "in_app" | "sms" | "webhook" | "system"
 *   direction   — "outbound" | "inbound" | "internal"
 *   action      — dot-separated verb, e.g. "outreach.send", "candidate.stage_change"
 *   body        — truncated content / summary (8 000 char max)
 *   metadata    — arbitrary JSONB for extra context
 */
import { db, auditLogsTable, type InsertAuditLog } from "@workspace/db";
import { logger } from "./logger.js";

const MAX_BODY = 8000; // truncate very large bodies so a single message can't bloat the log table

export type AuditChannel = "email" | "in_app" | "sms" | "webhook" | "system";
export type AuditDirection = "outbound" | "inbound" | "internal";
export type AuditActorType = "system" | "agent" | "user" | "candidate" | "external";
export type AuditSubjectType = "user" | "candidate" | "system" | "external";

export interface RecordAuditInput {
  tenantId?: string | null;
  actorType: AuditActorType;
  actorId?: string | null;
  actorLabel?: string | null;
  subjectType?: AuditSubjectType | null;
  subjectId?: string | null;
  subjectLabel?: string | null;
  channel: AuditChannel;
  direction: AuditDirection;
  action: string;
  title?: string | null;
  body?: string | null;
  metadata?: Record<string, any> | null;
}

/**
 * Append an audit log row. Never throws — auditing must never break the
 * underlying business action. Failures are logged via pino.
 */
export async function recordAudit(input: RecordAuditInput): Promise<void> {
  try {
    const row: InsertAuditLog = {
      tenantId: input.tenantId ?? null,
      actorType: input.actorType,
      actorId: input.actorId ?? null,
      actorLabel: input.actorLabel ?? null,
      subjectType: input.subjectType ?? null,
      subjectId: input.subjectId ?? null,
      subjectLabel: input.subjectLabel ?? null,
      channel: input.channel,
      direction: input.direction,
      action: input.action,
      title: input.title ?? null,
      body: input.body ? input.body.slice(0, MAX_BODY) : null,
      metadata: input.metadata ?? null,
    };
    await db.insert(auditLogsTable).values(row);
  } catch (err: any) {
    logger.error({ err: err?.message, action: input.action }, "[audit] insert failed");
  }
}
