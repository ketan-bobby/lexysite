/**
 * lib/candidate-event-logger.ts — Shared candidate event writer
 *
 * Call logCandidateEvent() from any route to write an immutable event row.
 * Errors are caught and logged; they MUST NOT block the caller's response.
 *
 * actor_type values: candidate | recruiter | hiring_manager | admin | system | integration
 * source values:     lexy_app | email | sms | calendar | interview_agent |
 *                    recruiter_action | admin_action | future_integration
 */
import { db } from "@workspace/db";
import { candidateEventsTable, type CandidateEventType } from "@workspace/db";
import { logger } from "./logger.js";

export interface LogEventParams {
  candidateId:   string;
  jobId:         string | null;
  tenantId:      string;
  eventType:     CandidateEventType;
  applicationId?: string | null;
  actorType?:    string;
  actorId?:      string | null;
  source?:       string;
  metadata?:     Record<string, unknown>;
}

/**
 * Write an immutable candidate lifecycle event.
 * Best-effort: errors are logged but never thrown — callers must never await this
 * in a way that could block or roll back their own writes.
 */
export async function logCandidateEvent(params: LogEventParams): Promise<void> {
  if (!params.jobId) {
    logger.debug({ eventType: params.eventType, candidateId: params.candidateId },
      "[candidate-event-logger] Skipped event: no jobId resolvable");
    return;
  }
  try {
    await db.insert(candidateEventsTable).values({
      eventId:       crypto.randomUUID(),
      candidateId:   params.candidateId,
      jobId:         params.jobId,
      tenantId:      params.tenantId,
      applicationId: params.applicationId ?? null,
      eventType:     params.eventType,
      eventTimestamp: new Date(),
      actorType:     params.actorType ?? null,
      actorId:       params.actorId ?? null,
      source:        params.source ?? "lexy_app",
      metadataJson:  params.metadata ?? null,
    });
  } catch (err) {
    logger.error({ err, eventType: params.eventType, candidateId: params.candidateId },
      "[candidate-event-logger] Failed to write event (non-fatal)");
  }
}

/** Derive actor_type from a user's role string */
export function actorTypeFromRole(role: string | null | undefined): string {
  if (!role) return "system";
  if (role === "platform_admin" || role === "admin") return "admin";
  if (role === "hiring_manager") return "hiring_manager";
  if (role === "candidate") return "candidate";
  return "recruiter";
}
