/**
 * lib/change-candidate-stage.ts — Canonical pipeline-stage choke-point (ticket 4d)
 *
 * ─── Why this exists ─────────────────────────────────────────────────────────
 * THE single entry point for moving a candidate between pipeline stages. Every
 * transition — human drag/drop, recruiter action, agent/orchestrator move,
 * scheduler, webhook reply — MUST route through here. A CI build-gate bans raw
 * writes to `applications.stage` and sourced `raw_data.stage` outside this file
 * (same doctrine as the route-ownership guard: one enforced gate + a build check
 * that fails loudly on any bypass).
 *
 * ─── What makes it different from the event/audit writers ────────────────────
 * `logCandidateEvent` and `recordAudit` are fire-and-forget: they swallow errors
 * so they never break the business action. Here the audit IS the point, so the
 * full triple is written ATOMICALLY in one transaction:
 *   1. the stage column(s)  — applications.stage and/or sourced rawData.stage
 *   2. a candidate_events STAGE_CHANGED row — truthful from→to + actor
 *   3. a thin-pointer audit_logs row — references the candidate_events eventId
 * If the event or the audit pointer fails, the stage change ROLLS BACK. A move
 * that can't be recorded does not happen.
 *
 * ─── Attribution rules ───────────────────────────────────────────────────────
 * • actorType is NEVER null. Genuine system/scheduler moves record "system"
 *   explicitly — never guessed.
 * • Agent moves thread the triggering pipeline run id (actor.runId), captured in
 *   both the event metadata and the audit pointer.
 * • The authoritative `from` stage is read from the row inside the transaction —
 *   a caller-supplied `from` is only a fallback, so the trail can never lie about
 *   the origin stage (the old stageToEvent map mislabelled it as the target).
 */
import {
  db,
  applicationsTable,
  sourcedCandidatesTable,
  candidateEventsTable,
  auditLogsTable,
} from "@workspace/db";
import { eq } from "drizzle-orm";
import { logger } from "./logger.js";
import { resolveLinxRequisitionTerminal } from "./linx-terminal.js";

/** Normalised actor kinds accepted by the choke-point. Never null. */
export type StageActorType = "user" | "hiring_manager" | "candidate" | "agent" | "system";

export interface StageActor {
  type: StageActorType;
  /** User id / agent identifier that performed the move. */
  id?: string | null;
  /** Human-readable label (recruiter name, "Screening Agent", …). */
  label?: string | null;
  /**
   * Original user role string (recruiter / recruiter_admin / platform_admin /
   * hiring_manager / candidate). Used for a precise candidate_events.actor_type
   * when available; falls back to `type` otherwise.
   */
  role?: string | null;
  /** Triggering pipeline run id for agent-driven moves. */
  runId?: string | null;
}

export interface ChangeCandidateStageParams {
  tenantId: string;
  /** Canonical candidate id — subject of the event + audit rows (NOT NULL). */
  candidateId: string;
  /** Job id — candidate_events.jobId is NOT NULL; sourced callers pass rawData.jobId. */
  jobId: string;
  /** Target stage to move to. */
  to: string;
  actor: StageActor;
  /**
   * Prior stage if the caller already knows it. The service still reads the
   * authoritative current stage from the row and prefers it; this is a fallback
   * for rows whose stage column/rawData can't be read (should be rare).
   */
  from?: string | null;
  /** candidate_events.source (recruiter_action | interview_agent | agent_orchestrator | …). */
  source?: string;
  /** Optional free-text reason (e.g. rejection reason) recorded on the trail. */
  reason?: string | null;
  /** Application row to update (applications.stage). */
  applicationId?: string | null;
  /** Extra application columns to co-update in the same write. */
  applicationPatch?: Record<string, unknown>;
  /** Sourced_candidates row to update (rawData.stage). */
  sourcedId?: string | null;
  /** Extra rawData fields to co-update alongside the stage. */
  sourcedRawDataPatch?: Record<string, unknown>;
  /** Extra sourced_candidates columns to co-update alongside rawData.stage. */
  sourcedColumnPatch?: Record<string, unknown>;
  /** Extra metadata merged into both the event and the audit pointer. */
  metadata?: Record<string, unknown>;
}

export interface ChangeCandidateStageResult {
  /** candidate_events.eventId, or null when the move was a no-op (from === to). */
  eventId: string | null;
  from: string | null;
  to: string;
  /** false when from === to (patches applied, but no transition trail written). */
  changed: boolean;
}

/** Map the actor to the candidate_events.actor_type vocabulary. */
function eventActorType(actor: StageActor): string {
  if (actor.role) {
    const r = actor.role;
    if (r === "platform_admin" || r === "admin") return "admin";
    if (r === "hiring_manager") return "hiring_manager";
    if (r === "candidate") return "candidate";
    if (r === "system") return "system";
    return "recruiter";
  }
  switch (actor.type) {
    case "user": return "recruiter";
    case "hiring_manager": return "hiring_manager";
    case "candidate": return "candidate";
    case "agent": return "agent";
    case "system": return "system";
  }
}

/** Map the actor to the audit_logs.actor_type vocabulary (NOT NULL). */
function auditActorType(actor: StageActor): "system" | "agent" | "user" | "candidate" {
  switch (actor.type) {
    case "agent": return "agent";
    case "candidate": return "candidate";
    case "system": return "system";
    default: return "user"; // user + hiring_manager
  }
}

/**
 * Move a candidate to `to`, writing stage + candidate_events + audit pointer in
 * one transaction. Throws (and rolls back) if any of the three writes fail.
 * A same-stage call applies patches but writes no transition trail.
 */
export async function changeCandidateStage(
  params: ChangeCandidateStageParams,
): Promise<ChangeCandidateStageResult> {
  if (!params.candidateId) throw new Error("changeCandidateStage: candidateId required");
  if (!params.jobId) throw new Error("changeCandidateStage: jobId required (candidate_events.jobId is NOT NULL)");
  if (!params.to) throw new Error("changeCandidateStage: target stage required");
  if (!params.applicationId && !params.sourcedId) {
    throw new Error("changeCandidateStage: at least one of applicationId / sourcedId required");
  }

  const result = await db.transaction(async (tx) => {
    let from: string | null = params.from ?? null;

    // ── 1. Write the stage column(s), reading the authoritative current stage ──
    if (params.applicationId) {
      const [cur] = await tx
        .select({ stage: applicationsTable.stage })
        .from(applicationsTable)
        .where(eq(applicationsTable.id, params.applicationId))
        .for("update")
        .limit(1);
      if (!cur) throw new Error(`changeCandidateStage: application ${params.applicationId} not found`);
      from = cur.stage ?? from;
      await tx
        .update(applicationsTable)
        .set({ ...(params.applicationPatch ?? {}), stage: params.to, updatedAt: new Date() })
        .where(eq(applicationsTable.id, params.applicationId));
    }

    if (params.sourcedId) {
      const [sc] = await tx
        .select({ rawData: sourcedCandidatesTable.rawData })
        .from(sourcedCandidatesTable)
        .where(eq(sourcedCandidatesTable.id, params.sourcedId))
        .for("update")
        .limit(1);
      if (!sc) throw new Error(`changeCandidateStage: sourced ${params.sourcedId} not found`);
      const raw = (sc.rawData ?? {}) as Record<string, unknown>;
      if (from == null && typeof raw.stage === "string") from = raw.stage;
      await tx
        .update(sourcedCandidatesTable)
        .set({ ...(params.sourcedColumnPatch ?? {}), rawData: { ...raw, ...(params.sourcedRawDataPatch ?? {}), stage: params.to } })
        .where(eq(sourcedCandidatesTable.id, params.sourcedId));
    }

    // ── No-op guard: a same-stage write is not a move — patches applied, no trail ──
    if (from === params.to) {
      return { eventId: null, from, to: params.to, changed: false };
    }

    // ── 2. candidate_events STAGE_CHANGED — truthful from→to + actor ──
    const eventId = crypto.randomUUID();
    const trailMeta = {
      from,
      to: params.to,
      ...(params.actor.runId ? { runId: params.actor.runId } : {}),
      ...(params.reason ? { reason: params.reason } : {}),
      ...(params.metadata ?? {}),
    };
    await tx.insert(candidateEventsTable).values({
      eventId,
      candidateId: params.candidateId,
      jobId: params.jobId,
      tenantId: params.tenantId,
      applicationId: params.applicationId ?? null,
      eventType: "STAGE_CHANGED",
      eventTimestamp: new Date(),
      actorType: eventActorType(params.actor),
      actorId: params.actor.id ?? null,
      source: params.source ?? "lexy_app",
      metadataJson: trailMeta,
    });

    // ── 3. Thin-pointer audit_logs row referencing the candidate_events row ──
    await tx.insert(auditLogsTable).values({
      tenantId: params.tenantId,
      actorType: auditActorType(params.actor),
      actorId: params.actor.id ?? null,
      actorLabel: params.actor.label ?? null,
      subjectType: "candidate",
      subjectId: params.candidateId,
      channel: "system",
      direction: "internal",
      action: "stage.changed",
      title: `Stage ${from ?? "—"} → ${params.to}`,
      body: null,
      metadata: {
        candidateEventId: eventId,
        from,
        to: params.to,
        jobId: params.jobId,
        applicationId: params.applicationId ?? null,
        sourcedId: params.sourcedId ?? null,
        ...(params.actor.runId ? { runId: params.actor.runId } : {}),
        ...(params.reason ? { reason: params.reason } : {}),
      },
    });

    logger.debug(
      { candidateId: params.candidateId, jobId: params.jobId, from, to: params.to, actorType: params.actor.type, runId: params.actor.runId },
      "[change-candidate-stage] transition recorded (stage + event + audit pointer)",
    );

    return { eventId, from, to: params.to, changed: true };
  });

  /* ── LINX loop-closure hook (Step 4) ────────────────────────────────────
   * Every hire in the system flows through this choke-point. If the job is
   * a LINX-side requisition (linx_requests.linx_req_id → jobId), reflect
   * the fill back onto the originating request. Fire-and-forget: a status
   * mirror must never break a hire. Status field only — no billing. */
  if (result.changed && params.to === "hired") {
    void resolveLinxRequisitionTerminal(params.jobId, "filled");
  }

  return result;
}
