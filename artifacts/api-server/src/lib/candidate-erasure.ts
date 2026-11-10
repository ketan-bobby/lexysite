import { sql } from "drizzle-orm";
import { closeCandidateAccount, collectClosingAccountAvatars } from "./candidate-account-erasure";

// Only call after resolving the candidate owner or authorising the staff caller.
// Keep this inventory checked against the database by check:deletion-cascade-drift.
export const CANDIDATE_LINKED_TABLES = [
  "meeting_attendance",
  "meeting_notes",
  "ai_decision_log",
  "ai_message_generations",
  "appeals_requests",
  "applications",
  "candidate_achievements",
  "candidate_action_events",
  "interview_offered_times",
  "interview_booking_links",
  "interview_time_change_requests",
  "interview_calendar_invitation_attempts",
  "interview_zoom_links",
  "interview_zoom_meetings",
  "ats_mapping_verifications",
  "candidate_activity_streaks",
  "candidate_ai_consent",
  "candidate_career_profiles",
  "candidate_connection_events",
  "candidate_connection_insights",
  "candidate_demographics",
  "candidate_disclosure_acks",
  "candidate_discovery_consent",
  "candidate_embeddings",
  "candidate_evaluations",
  "candidate_events",
  "candidate_external_clicks",
  "candidate_import_records",
  "candidate_introductions",
  "candidate_job_intelligence",
  "candidate_learning_assessment_tasks",
  "candidate_learning_assessments",
  "candidate_learning_course_review_lessons",
  "candidate_learning_course_review_attempts",
  "candidate_learning_lesson_progress",
  "candidate_learning_enrollments",
  "candidate_learning_profiles",
  "candidate_learning_reward_ledger",
  "candidate_learning_voice_turns",
  "candidate_learning_voice_cycles",
  "candidate_market_events_sent",
  "candidate_notifications",
  "candidate_outcomes",
  "ats_candidate_profiles",
  "zoho_campaign_recipients",
  "zoho_campaign_reviews",
  "zoho_stage_handoff_events",
  "candidate_progress_snapshots",
  "candidate_recommendation_progress",
  "candidate_rejections",
  "candidate_skill_scores",
  "communication_events",
  "connection_events",
  "connection_scores",
  "ghosting_alerts",
  "ghosting_risk_flags",
  "hiring_manager_shares",
  "interview_sessions",
  "invite_tokens",
  "nurture_pool",
  "outreach_conversation_drafts",
  "outreach_enrollments",
  "outreach_messages",
  "prep_plans",
  "prep_sessions",
  "recruiter_avatar_video_jobs",
  "recruiter_inbox_items",
  "recruiting_workflows",
  "resume_screens",
  "talent_matches",
  "talent_pool_submissions",
  "trust_events",
  "verification_records",
] as const;

// These records have a separate audit/financial retention basis. In particular,
// decision_events has a database trigger forbidding deletion. Never weaken it.
export const RETAINED_CANDIDATE_TABLES = [
  "deletion_requests",
  "decision_events",
  "fee_line_items",
] as const;

type ErasureTransaction = {
  execute: (query: ReturnType<typeof sql>) => Promise<unknown>;
};

/** Snapshot while holding the candidate lock, before deleting session/profile rows. */
export async function collectCandidateRecordingPaths(tx: ErasureTransaction, candidateId: string) {
  // Only an authorised erasure controller may call this function. Stay on the
  // request's existing database connection (including its data region), while
  // temporarily restoring its service role for this subject-specific cleanup.
  // PostgreSQL restores the request role on COMMIT/ROLLBACK. Do not grant DELETE
  // on the append-only learning ledger to ordinary application requests.
  await tx.execute(sql`SET LOCAL ROLE NONE`);
  const candidates = (await tx.execute(
    sql`SELECT id, resume_url FROM candidates WHERE id = ${candidateId} FOR UPDATE`,
  )) as { rows: { resume_url: string | null }[] };
  const paths = new Set<string>();
  for (const path of await collectClosingAccountAvatars(tx, candidateId)) paths.add(path);
  for (const row of candidates.rows) {
    if (typeof row.resume_url === "string" && row.resume_url) paths.add(row.resume_url);
  }
  const sessions = (await tx.execute(sql`SELECT id, recording_url FROM interview_sessions
    WHERE candidate_id = ${candidateId}`)) as {
    rows: { id: string; recording_url: string | null }[];
  };
  const profiles = (await tx.execute(sql`SELECT recording_url FROM candidate_career_profiles
    WHERE candidate_id = ${candidateId}`)) as { rows: { recording_url: string | null }[] };
  const meetingRecordings = (await tx.execute(sql`SELECT object_path FROM meeting_notes
    WHERE candidate_id = ${candidateId}`)) as { rows: { object_path: string }[] };
  for (const row of meetingRecordings.rows) paths.add(row.object_path);
  for (const row of [...sessions.rows, ...profiles.rows]) {
    if (row.recording_url) paths.add(row.recording_url);
  }
  for (const session of sessions.rows) {
    if (/^[0-9a-f-]{36}$/i.test(session.id))
      paths.add(`/objects/recording-segments/${session.id}/`);
  }
  const shares = (await tx.execute(sql`SELECT resume_object_path AS object_path
    FROM hiring_manager_shares WHERE candidate_id = ${candidateId}`)) as {
    rows: { object_path: string | null }[];
  };
  const avatarVideos = (await tx.execute(sql`SELECT output_video_object_path AS object_path
    FROM recruiter_avatar_video_jobs WHERE candidate_id = ${candidateId}`)) as {
    rows: { object_path: string | null }[];
  };
  for (const row of [...shares.rows, ...avatarVideos.rows]) {
    if (typeof row.object_path === "string" && row.object_path.length > 0)
      paths.add(row.object_path);
  }
  return [...paths];
}

/** Only run after commit. Failure remains visible; never claim bytes were deleted. */
export async function purgeCandidateRecordings(
  candidateId: string,
  paths: string[],
  storageOverride?: {
    deleteObjectByPath: (path: string) => Promise<{ ok: boolean; error?: string }>;
    deleteObjectsUnderPrefix: (prefix: string) => Promise<{ deleted: number; error?: string }>;
  },
) {
  const storage = storageOverride ?? new (await import("./objectStorage")).ObjectStorageService();
  let failed = 0;
  for (const path of paths) {
    if (!path.startsWith("/objects/")) {
      failed++;
      continue;
    }
    try {
      if (path.endsWith("/")) {
        const result = await storage.deleteObjectsUnderPrefix(path.slice("/objects/".length));
        if (result.error) failed++;
      } else if (!(await storage.deleteObjectByPath(path)).ok) failed++;
    } catch {
      failed++;
    }
  }
  try {
    const result = await storage.deleteObjectsUnderPrefix(`interview-recordings/${candidateId}`);
    if (result.error) failed++;
  } catch {
    failed++;
  }
  return { attempted: paths.length, failed, cleanupPending: failed > 0 };
}

/**
 * Purge direct and indirect candidate data in the caller's existing transaction.
 * No storage deletion happens here: bytes must not disappear if the DB rolls back.
 */
export async function purgeCandidateLinkedData(
  tx: ErasureTransaction,
  candidateId: string,
  { retainApplications = false }: { retainApplications?: boolean } = {},
) {
  // This controller already authorized the subject; use its own transaction,
  // restoring service access before reading private provider-cleanup receipts.
  await tx.execute(sql`SET LOCAL ROLE NONE`);
  // A provider create may have succeeded even without a response. Do not erase
  // recovery receipts or claim completion while a remote recording may remain.
  const pending = await tx.execute(sql`SELECT id FROM meeting_attendance
    WHERE candidate_id=${candidateId}
    AND ((dispatch_token IS NOT NULL AND bot_id IS NULL)
      OR (bot_id IS NOT NULL AND media_deleted_at IS NULL)) LIMIT 100`);
  const attendanceRows = (pending as { rows?: Array<{ id: string }> }).rows ?? [];
  if (attendanceRows.length) {
    // Separate service connection, no candidate/attempt FK or locking trigger:
    // the authorized stop intent must survive rollback of this held erasure.
    const { dbAdmin } = await import("@workspace/db");
    for (const row of attendanceRows)
      await dbAdmin.execute(sql`INSERT INTO meeting_assistant_cleanup(attempt_id)
        VALUES (${row.id}) ON CONFLICT DO NOTHING`);
    const error = new Error(
      "Meeting assistant provider cleanup must finish before erasure can complete.",
    );
    Object.assign(error, { statusCode: 409 });
    throw error;
  }
  // Callers must have resolved the owner or authorised staff and gated the
  // candidate first. Every destructive statement below binds that candidate.
  // Private learning policies also require the candidate-owner context. The
  // subject has already been authorised; this setting lasts only for this tx.
  await tx.execute(sql`SELECT set_config('app.current_candidate_id', ${candidateId}, true)`);
  await closeCandidateAccount(tx, candidateId);

  // Minimal identifiers survive hard deletion so stale jobs cannot reinsert
  // the original candidate or an external-source alias. No contact data here.
  await tx.execute(sql`INSERT INTO candidate_erasure_tombstones(subject_id)
    SELECT ${candidateId} UNION SELECT id FROM sourced_candidates WHERE normalized_candidate_id=${candidateId}
    ON CONFLICT DO NOTHING`);
  // Cancel both waiting and running work atomically. Results/payload snapshots
  // must not survive, and late completions are fenced by queue status.
  await tx.execute(sql`UPDATE ai_jobs SET status='failed',last_error='candidate_erased',
    payload=jsonb_build_object('candidateId',${candidateId}::text),result=NULL,
    dedupe_key=NULL,locked_at=NULL,locked_by=NULL,updated_at=now()
    WHERE payload->>'candidateId'=${candidateId} OR
      COALESCE(interview_session_id,payload->>'sessionId') IN
        (SELECT id FROM interview_sessions WHERE candidate_id=${candidateId})`);

  // These tables have no candidate_id; remove them BEFORE their parent rows.
  // Profile intake can associate an ATS person with metadata originally
  // reviewed under a different workflow. Purge those observations too and
  // retain only a scoped, hashed identity fence against later re-import.
  await tx.execute(sql`INSERT INTO candidate_erasure_tombstones(subject_id)
    SELECT 'ats-profile:' || md5(jsonb_build_array(tenant_id,system,account_ref,external_candidate_id)::text)
    FROM ats_candidate_profiles WHERE candidate_id=${candidateId}
    ON CONFLICT DO NOTHING`);
  await tx.execute(sql`DELETE FROM ats_imported_applications r USING ats_candidate_profiles p
    WHERE p.candidate_id=${candidateId} AND r.tenant_id=p.tenant_id AND r.account_ref=p.account_ref
    AND (r.snapshot #>> '{application,candidateId}'=p.external_candidate_id
      OR r.current_snapshot #>> '{application,candidateId}'=p.external_candidate_id)`);
  await tx.execute(sql`DELETE FROM zoho_campaign_recipients r USING ats_candidate_profiles p
    WHERE p.candidate_id=${candidateId} AND p.system='zoho_recruit'
    AND r.tenant_id=p.tenant_id AND r.account_ref=p.account_ref
    AND r.external_candidate_id=p.external_candidate_id`);
  // Imported applicants can belong to a different workflow root. Remove
  // invitation claims/outcomes through their session before session deletion.
  await tx.execute(sql`DELETE FROM recruiting_workflow_receipts r
    USING interview_sessions s
    WHERE s.candidate_id=${candidateId} AND r.tenant_id=s.tenant_id
      AND (r.key='gh-interview-invitation:' || s.id
        OR left(r.key,length('gh-interview-note:' || s.id || ':'))='gh-interview-note:' || s.id || ':')`);
  await tx.execute(sql`DELETE FROM recruiting_workflow_events e
    USING interview_sessions s
    WHERE s.candidate_id=${candidateId} AND e.tenant_id=s.tenant_id
      AND (CASE WHEN e.action IN (
        'ats.interview.invitation.claimed','ats.interview.invitation.provider_accepted',
        'ats.interview.invitation.review_required','ats.interview.invitation.simulated',
        'ats.interview.note.claimed','ats.interview.note.published','ats.interview.note.review_required',
        'ats.interview.note.reconciled',
        'ats.interview.invitation.provider_binding','ats.interview.invitation.provider_event',
        'ats.interview.invitation.reconciled',
        'ats.interview.campaign.member','ats.interview.campaign.member_blocked')
        THEN e.note::jsonb ELSE '{}'::jsonb END)->>'sessionId'=s.id`);
  await tx.execute(sql`DELETE FROM recruiting_workflow_events
    WHERE workflow_id IN (SELECT id FROM recruiting_workflows WHERE candidate_id = ${candidateId})`);
  await tx.execute(sql`DELETE FROM interview_summaries
    WHERE interview_session_id IN (SELECT id FROM interview_sessions WHERE candidate_id = ${candidateId})`);
  await tx.execute(sql`DELETE FROM interview_schedules
    WHERE application_id IN (SELECT id FROM applications WHERE candidate_id = ${candidateId})`);

  // External-source mirrors carry the profile and contact data in raw_data.
  await tx.execute(
    sql`DELETE FROM sourced_candidates WHERE normalized_candidate_id = ${candidateId}`,
  );
  for (const table of CANDIDATE_LINKED_TABLES) {
    if (retainApplications && table === "applications") continue;
    await tx.execute(sql`DELETE FROM ${sql.identifier(table)} WHERE candidate_id = ${candidateId}`);
  }
}
