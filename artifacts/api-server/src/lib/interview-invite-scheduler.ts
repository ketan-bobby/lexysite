/**
 * interview-invite-scheduler.ts — Interview Invite Lifecycle Scheduler
 *
 * ─── What this file does ────────────────────────────────────────────────────
 * Runs three lifecycle checks every hour for interview sessions that have been
 * sent to candidates but not completed. Each tick is independent and catches
 * its own errors so a failure in one check doesn't block the others.
 *
 * ─── Three ticks per hour ────────────────────────────────────────────────────
 *   Tick #1 — Re-engagement (24h after invite sent, invite never opened)
 *     Calls sendReEngagement() (interview-reply.ts) which generates a fresh
 *     token, AI-drafts a reminder email, and sends it. Stamps reEngagementSentAt.
 *
 *   Tick #2 — Abandon (24h after re-engagement sent, invite still never opened)
 *     At this point the candidate has had 48 hours of total silence. Calls
 *     abandonAndNotify() which atomically sets status="abandoned" and notifies
 *     the owning recruiter both in-app and by email.
 *
 *   Tick #3 — In-progress timeout (session started but not completed in > 4h)
 *     Catches candidates who opened the interview room but walked away mid-
 *     session. Marks as "abandoned" and notifies the recruiter.
 *
 * ─── Atomic claims ───────────────────────────────────────────────────────────
 * All state transitions (re-engage, abandon) use conditional UPDATE … WHERE
 * clauses that re-validate guard predicates at write time. This prevents TOCTOU
 * races when two scheduler workers tick concurrently or when the candidate acts
 * (opens the link, completes the interview) in the window between SELECT and UPDATE.
 *
 * ─── Recruiter resolution cascade ────────────────────────────────────────────
 * resolveOwningRecruiter() tries: candidate.createdById → job.assignedRecruiterId
 * → job.assignedHiringManagerId. resolveJob() handles both application-linked
 * sessions and pipeline-created sessions (where applicationId="pipeline").
 *
 * ─── Called by ───────────────────────────────────────────────────────────────
 *   src/index.ts — startInterviewInviteScheduler() on server boot
 */
import { db } from "@workspace/db";
import {
  interviewSessionsTable,
  candidatesTable,
  jobsTable,
  applicationsTable,
  sourcedCandidatesTable,
  usersTable,
  userNotificationsTable,
  interviewSchedulesTable,
} from "@workspace/db";
import { and, eq, isNull, lt, isNotNull, inArray, sql } from "drizzle-orm";
import { sendReEngagement } from "./agents/interview-reply";
import { sendEmail, plainToHtml, isEmailConfigured } from "./email";
import { logger } from "./logger";

const INTERVAL_MS = 60 * 60 * 1000; // hourly
const INVITE_TTL_MS = 24 * 60 * 60 * 1000;
/* Live-session inactivity timeout: a session in a live-answering status
 * (active / in_progress / resumed) whose HEARTBEAT (last_active_at) has been
 * silent this long is declared abandoned. Kept at the historical 4h so a long
 * programming interview + reconnection buffer is never cut off, but now anchored
 * to last activity rather than start time so the clock resets while the
 * candidate is engaged. */
const INACTIVE_ABANDON_MS = 4 * 60 * 60 * 1000; // 4h of heartbeat silence
/* Manual-link expiry: a `scheduled` session created by /interviews/generate-link
 * carries NO invite-send timestamp (recruiter shares the link out-of-band), so
 * the invite re-engage/abandon ticks (which key off invite_sent_at /
 * reEngagementSentAt) never touch it and it lingers as "scheduled" forever.
 * We expire it off created_at after a 7-day grace — longer than the 48h
 * invite-silence window because out-of-band links are legitimately taken days
 * later. Never started, never sent ⇒ expired. */
const SCHEDULED_EXPIRY_MS = 7 * 24 * 60 * 60 * 1000; // 7d after creation
// Grace after a recruiter-scheduled interview's start before we call it a
// no-show. Covers a long interview + buffer so we never flag one in progress.
const NO_SHOW_GRACE_MS = 3 * 60 * 60 * 1000; // 3h after scheduledAt
const APP_BASE_URL = process.env.APP_BASE_URL ?? "https://app.l3xy.ai";

/**
 * Resolve the user that should be notified about a stale interview session
 * for this candidate + job. Resolution chain mirrors the rest of the app:
 *   1. candidate.createdById  (the recruiter who first added them)
 *   2. job.assignedRecruiterId
 *   3. job.assignedHiringManagerId  (last-resort fallback)
 */
async function resolveOwningRecruiter(
  candidateId: string | null,
  jobId: string | null,
): Promise<{ id: string; email: string | null; name: string | null } | null> {
  let candCreatedById: string | null = null;
  if (candidateId) {
    const [c] = await db.select().from(candidatesTable)
      .where(eq(candidatesTable.id, candidateId)).limit(1);
    candCreatedById = (c as any)?.createdById ?? null;
  }

  let assignedRecruiterId: string | null = null;
  let assignedHmId: string | null = null;
  if (jobId) {
    const [j] = await db.select().from(jobsTable)
      .where(eq(jobsTable.id, jobId)).limit(1);
    assignedRecruiterId = (j as any)?.assignedRecruiterId ?? null;
    assignedHmId = (j as any)?.assignedHiringManagerId ?? null;
  }

  const targetId = candCreatedById ?? assignedRecruiterId ?? assignedHmId;
  if (!targetId) return null;

  const [u] = await db.select().from(usersTable)
    .where(eq(usersTable.id, targetId)).limit(1);
  if (!u) return null;
  return { id: u.id, email: (u as any).email ?? null, name: (u as any).name ?? null };
}

/**
 * Resolve the candidate's display details for in-app + email copy.
 * Falls back to sourced_candidates raw_data if we don't have a normalized
 * candidate row.
 */
async function resolveCandidateDisplay(candidateId: string | null): Promise<{ name: string; email: string | null }> {
  if (!candidateId) return { name: "candidate", email: null };
  const [c] = await db.select().from(candidatesTable)
    .where(eq(candidatesTable.id, candidateId)).limit(1);
  if (c) {
    const name = `${c.firstName ?? ""} ${c.lastName ?? ""}`.trim() || c.email || "candidate";
    return { name, email: c.email ?? null };
  }
  const [sc] = await db.select().from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.id, candidateId)).limit(1);
  if (sc) {
    const raw: any = sc.rawData ?? {};
    const name = `${raw.firstName ?? ""} ${raw.lastName ?? ""}`.trim() || raw.name || raw.email || "candidate";
    return { name, email: raw.email ?? null };
  }
  return { name: "candidate", email: null };
}

/**
 * Resolve the job for an interview session via either the stored
 * applicationId (real applications) or the sourced row's raw_data.jobId
 * (pipeline-created sessions where applicationId is the literal "pipeline").
 *
 * IMPORTANT: session.candidateId may equal either candidates.id (normalized
 * path) OR sourced_candidates.id (when no normalized candidate exists — see
 * sendInterviewInviteFromReply: `candidateId: normalizedCandidateId || sourcedId`).
 * The fallback below tries BOTH shapes so pipeline sessions never miss the
 * recruiter resolver chain.
 */
async function resolveJob(session: any): Promise<{ id: string; title: string | null } | null> {
  if (session.applicationId && session.applicationId !== "pipeline" && session.applicationId !== "direct") {
    const [a] = await db.select().from(applicationsTable)
      .where(eq(applicationsTable.id, session.applicationId)).limit(1);
    if (a) {
      const [j] = await db.select().from(jobsTable)
        .where(eq(jobsTable.id, a.jobId)).limit(1);
      return j ? { id: j.id, title: j.title ?? null } : null;
    }
  }
  // Fallback for pipeline sessions — derive jobId from sourced_candidates.rawData.
  // Try both shapes of session.candidateId.
  const [scById] = await db.select().from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.id, session.candidateId)).limit(1);
  const [scByNormalized] = scById ? [null] : await db.select().from(sourcedCandidatesTable)
    .where(eq(sourcedCandidatesTable.normalizedCandidateId, session.candidateId)).limit(1);
  const sc = scById || scByNormalized;
  const rawJobId = (sc?.rawData as any)?.jobId;
  if (rawJobId) {
    const [j] = await db.select().from(jobsTable)
      .where(eq(jobsTable.id, rawJobId)).limit(1);
    return j ? { id: j.id, title: j.title ?? null } : null;
  }
  return null;
}

/**
 * Mark a session as abandoned + notify the owning recruiter (in-app + email).
 * Idempotent: if the session is already non-active we no-op.
 */
async function abandonAndNotify(
  sessionId: string,
  reason: "invite_expired_no_open" | "in_progress_timeout",
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  /* Atomic claim: revalidate ALL guard predicates inside the UPDATE WHERE
   * clause so we never abandon a row whose state changed between SELECT and
   * UPDATE (e.g. candidate opened the link / completed the interview in the
   * window between our scheduler tick's SELECT and this claim). Returns an
   * empty array when guards no longer hold OR a parallel worker beat us. */
  const noOpenCutoff = new Date(Date.now() - INVITE_TTL_MS);
  const inactiveCutoff = new Date(Date.now() - INACTIVE_ABANDON_MS);
  /* in_progress_timeout now covers ALL live-answering statuses (active /
   * in_progress / resumed), not just the legacy `in_progress` — a session stuck
   * in `active` for days was previously matched by NO tick and lingered forever,
   * inflating "agents online". The staleness anchor is the HEARTBEAT
   * (last_active_at, touched on every authenticated interview request), falling
   * back to started_at / created_at — so an actively-answering candidate keeps
   * resetting the clock and is never swept mid-interview. */
  const guard = reason === "in_progress_timeout"
    ? and(
        eq(interviewSessionsTable.id, sessionId),
        inArray(interviewSessionsTable.status, ["active", "in_progress", "resumed"] as any),
        isNull(interviewSessionsTable.completedAt),
        lt(
          sql`COALESCE(${interviewSessionsTable.lastActiveAt}, ${interviewSessionsTable.startedAt}, ${interviewSessionsTable.createdAt})`,
          inactiveCutoff,
        ),
      )
    : and(
        eq(interviewSessionsTable.id, sessionId),
        eq(interviewSessionsTable.status, "scheduled"),
        isNull(interviewSessionsTable.inviteOpenedAt),
        isNotNull(interviewSessionsTable.reEngagementSentAt),
        lt(interviewSessionsTable.reEngagementSentAt, noOpenCutoff),
      );
  const claimed = await db
    .update(interviewSessionsTable)
    .set({ status: "abandoned", abandonedAt: new Date() } as any)
    .where(guard)
    .returning();
  if (claimed.length === 0) return { ok: false, skipped: "guards_no_longer_hold_or_already_handled" };
  const session = claimed[0];

  try {
    const [job, recruiter, candidate] = await Promise.all([
      resolveJob(session),
      resolveOwningRecruiter(session.candidateId, null),
      resolveCandidateDisplay(session.candidateId),
    ]);

    /* If recruiter resolution missed the candidate.createdById path, retry
     * via the resolved jobId — covers pipeline sessions whose candidate
     * has no createdById. */
    const finalRecruiter = recruiter
      ?? (job ? await resolveOwningRecruiter(session.candidateId, job.id) : null);

    if (!finalRecruiter) {
      logger.warn({ sessionId, reason }, "[abandon] No recruiter to notify — session marked abandoned silently");
      return { ok: true, skipped: "no_recruiter" };
    }

    /* Wording is deliberately neutral about whether the re-engagement
     * reminder was actually delivered — `reEngagementSentAt` is stamped
     * during the claim before the email send (in interview-reply.ts) so
     * Tick #2 fires whether or not SES accepted the second message. The
     * recruiter-facing fact ("candidate has gone silent on this invite")
     * is true in both cases. */
    const reasonHuman = reason === "in_progress_timeout"
      ? `Candidate opened the interview but went inactive for over ${Math.round(INACTIVE_ABANDON_MS / 3_600_000)} hours without finishing`
      : `Candidate did not open the interview invite within 48 hours of the original send`;

    const title = "Interview abandoned";
    const message = `${candidate.name}${job?.title ? ` (${job.title})` : ""} — ${reasonHuman}. You can re-invite them or move them out of the pipeline.`;
    const actionUrl = `/interviews/${session.id}`;

    /* In-app notification */
    await db.insert(userNotificationsTable).values({
      tenantId: session.tenantId,
      userId: finalRecruiter.id,
      type: "interview_abandoned",
      title,
      message,
      actionUrl,
    });

    /* Email — best-effort, won't block the abandonment */
    if (isEmailConfigured() && finalRecruiter.email) {
      const fullUrl = `${APP_BASE_URL}${actionUrl}`;
      const body = `Hi${finalRecruiter.name ? ` ${finalRecruiter.name.split(/\s+/)[0]}` : ""},

${message}

Open the interview: ${fullUrl}

— Lexy`;
      await sendEmail({
        to: finalRecruiter.email,
        subject: `Interview abandoned — ${candidate.name}`,
        text: body,
        html: plainToHtml(body),
        audit: {
          tenantId: session.tenantId,
          actorLabel: "Interview Scheduler",
          subjectType: "user",
          subjectId: finalRecruiter.id,
          subjectLabel: finalRecruiter.name ?? finalRecruiter.email,
          action: "interview.abandoned.notified",
          metadata: { sessionId, reason, candidateName: candidate.name, jobId: job?.id, jobTitle: job?.title },
        },
      });
    }

    return { ok: true };
  } catch (err: any) {
    logger.error({ err: err?.message, sessionId, reason }, "[abandon] Notification failed (session still marked abandoned)");
    return { ok: false, error: err?.message };
  }
}

/**
 * Mark a recruiter-scheduled interview as a no-show + notify the owning
 * recruiter (in-app + email). A "no-show" is a scheduled interview whose
 * window has passed (scheduledAt + grace) while the recruiter never moved it
 * to completed/cancelled — i.e. the candidate (or interviewer) missed it.
 *
 * Atomic claim: the status transition is gated inside the UPDATE WHERE so two
 * overlapping scheduler ticks (or a recruiter completing it mid-tick) can
 * never double-flag the same row. Notification failures never roll back the
 * status flip — the recruiter-facing fact (window missed) is true regardless.
 */
async function markNoShowAndNotify(
  scheduleId: string,
): Promise<{ ok: boolean; skipped?: string; error?: string }> {
  const cutoff = new Date(Date.now() - NO_SHOW_GRACE_MS);
  const claimed = await db
    .update(interviewSchedulesTable)
    .set({ status: "no_show" })
    .where(
      and(
        eq(interviewSchedulesTable.id, scheduleId),
        inArray(interviewSchedulesTable.status, ["pending", "confirmed", "rescheduled"]),
        lt(interviewSchedulesTable.scheduledAt, cutoff),
      ),
    )
    .returning();
  if (claimed.length === 0) return { ok: false, skipped: "guards_no_longer_hold_or_already_handled" };
  const schedule = claimed[0];

  try {
    // Resolve the application this schedule hangs off of → candidate + job.
    const [app] = await db.select().from(applicationsTable)
      .where(eq(applicationsTable.id, schedule.applicationId)).limit(1);
    const candidateId = app?.candidateId ?? null;
    const jobId = app?.jobId ?? null;

    const [job, recruiter, candidate] = await Promise.all([
      jobId
        ? db.select().from(jobsTable).where(eq(jobsTable.id, jobId)).limit(1).then(r => r[0] ?? null)
        : Promise.resolve(null),
      resolveOwningRecruiter(candidateId, jobId),
      resolveCandidateDisplay(candidateId),
    ]);

    if (!recruiter) {
      logger.warn({ scheduleId }, "[no-show] No recruiter to notify — schedule marked no_show silently");
      return { ok: true, skipped: "no_recruiter" };
    }

    const jobTitle = (job as any)?.title ?? null;
    const whenHuman = schedule.scheduledAt.toISOString();
    const title = "Interview no-show";
    const message = `${candidate.name}${jobTitle ? ` (${jobTitle})` : ""} missed their scheduled interview (${whenHuman}). Reschedule them or move them out of the pipeline.`;
    const actionUrl = `/applications/${schedule.applicationId}`;

    /* In-app notification */
    await db.insert(userNotificationsTable).values({
      tenantId: schedule.tenantId,
      userId: recruiter.id,
      type: "interview_no_show",
      title,
      message,
      actionUrl,
    });

    /* Email — best-effort, won't block the no-show flag */
    if (isEmailConfigured() && recruiter.email) {
      const fullUrl = `${APP_BASE_URL}${actionUrl}`;
      const body = `Hi${recruiter.name ? ` ${recruiter.name.split(/\s+/)[0]}` : ""},

${message}

Open the application: ${fullUrl}

— Lexy`;
      await sendEmail({
        to: recruiter.email,
        subject: `Interview no-show — ${candidate.name}`,
        text: body,
        html: plainToHtml(body),
        audit: {
          tenantId: schedule.tenantId,
          actorLabel: "Interview Scheduler",
          subjectType: "user",
          subjectId: recruiter.id,
          subjectLabel: recruiter.name ?? recruiter.email,
          action: "interview.no_show.notified",
          metadata: { scheduleId, candidateName: candidate.name, jobId, jobTitle, scheduledAt: whenHuman },
        },
      });
    }

    return { ok: true };
  } catch (err: any) {
    logger.error({ err: err?.message, scheduleId }, "[no-show] Notification failed (schedule still marked no_show)");
    return { ok: false, error: err?.message };
  }
}

/**
 * Sweep live-answering sessions (active / in_progress / resumed) whose heartbeat
 * has been silent past INACTIVE_ABANDON_MS → abandoned (+ notify recruiter).
 * Exported so the lifecycle behaviour is unit-testable without the interval.
 * Returns the number of sessions actually claimed (flipped) this pass.
 */
export async function sweepInactiveLiveSessions(): Promise<number> {
  const inactiveCutoff = new Date(Date.now() - INACTIVE_ABANDON_MS);
  const stuck = await db
    .select()
    .from(interviewSessionsTable)
    .where(
      and(
        inArray(interviewSessionsTable.status, ["active", "in_progress", "resumed"] as any),
        isNull(interviewSessionsTable.completedAt),
        lt(
          sql`COALESCE(${interviewSessionsTable.lastActiveAt}, ${interviewSessionsTable.startedAt}, ${interviewSessionsTable.createdAt})`,
          inactiveCutoff,
        ),
      ),
    );
  let swept = 0;
  for (const s of stuck) {
    const r = await abandonAndNotify(s.id, "in_progress_timeout");
    if (r.skipped !== "guards_no_longer_hold_or_already_handled") swept += 1;
    logger.info(
      { sessionId: s.id, ok: r.ok, skipped: r.skipped, error: r.error },
      "[interview-invite-scheduler] Abandoned (inactive live session)",
    );
  }
  return swept;
}

/**
 * Expire `scheduled` sessions minted by /interviews/generate-link that were
 * never sent (no invite_sent_at) and never started, once older than
 * SCHEDULED_EXPIRY_MS. Single atomic set-based UPDATE…WHERE — no per-row race,
 * no notification (an unused out-of-band link expiring is not recruiter-worthy
 * noise). Guarded so it can never touch invite-tracked sessions (those are the
 * re-engage/abandon ticks' domain). Returns the number expired.
 */
export async function expireStaleScheduledSessions(): Promise<number> {
  const cutoff = new Date(Date.now() - SCHEDULED_EXPIRY_MS);
  const claimed = await db
    .update(interviewSessionsTable)
    .set({ status: "expired", expiredAt: new Date() } as any)
    .where(
      and(
        eq(interviewSessionsTable.status, "scheduled"),
        isNull(interviewSessionsTable.inviteSentAt),
        isNull(interviewSessionsTable.startedAt),
        isNull(interviewSessionsTable.completedAt),
        lt(interviewSessionsTable.createdAt, cutoff),
      ),
    )
    .returning({ id: interviewSessionsTable.id });
  if (claimed.length > 0) {
    logger.info({ count: claimed.length }, "[interview-invite-scheduler] Expired stale scheduled links (never sent/started, > 7d)");
  }
  return claimed.length;
}

export function startInterviewInviteScheduler() {
  logger.info("[interview-invite-scheduler] Started – runs every 60 minutes");

  async function tick() {
    /* Tick #1 — Re-engagement email for unopened invites > 24h old.
     * Original behaviour, untouched. */
    try {
      const cutoff = new Date(Date.now() - INVITE_TTL_MS);
      const stale = await db
        .select()
        .from(interviewSessionsTable)
        .where(
          and(
            eq(interviewSessionsTable.status, "scheduled"),
            isNull(interviewSessionsTable.inviteOpenedAt),
            isNull(interviewSessionsTable.reEngagementSentAt),
            lt(interviewSessionsTable.inviteSentAt, cutoff),
          ),
        );

      if (stale.length > 0) {
        logger.info({ count: stale.length }, "[interview-invite-scheduler] Re-engaging unopened invites > 24h");
        for (const s of stale) {
          try {
            const r = await sendReEngagement(s.id);
            logger.info({ sessionId: s.id, ok: r.ok, error: r.error }, "[interview-invite-scheduler] Re-engagement attempted");
          } catch (err: any) {
            logger.error({ sessionId: s.id, err: err?.message }, "[interview-invite-scheduler] Re-engagement failed");
          }
        }
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, "[interview-invite-scheduler] Re-engagement tick error");
    }

    /* Tick #2 — Abandon sessions whose re-engagement window also closed
     * unread (i.e. 48 hours of total candidate silence). Only sessions
     * that were re-engaged at least 24h ago AND still never opened. */
    try {
      const reEngagementCutoff = new Date(Date.now() - INVITE_TTL_MS);
      const totallySilent = await db
        .select()
        .from(interviewSessionsTable)
        .where(
          and(
            eq(interviewSessionsTable.status, "scheduled"),
            isNull(interviewSessionsTable.inviteOpenedAt),
            isNotNull(interviewSessionsTable.reEngagementSentAt),
            lt(interviewSessionsTable.reEngagementSentAt, reEngagementCutoff),
          ),
        );

      if (totallySilent.length > 0) {
        logger.info({ count: totallySilent.length }, "[interview-invite-scheduler] Abandoning sessions with no opens after 48h");
        for (const s of totallySilent) {
          const r = await abandonAndNotify(s.id, "invite_expired_no_open");
          logger.info({ sessionId: s.id, ok: r.ok, skipped: r.skipped, error: r.error }, "[interview-invite-scheduler] Abandoned (no-open)");
        }
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, "[interview-invite-scheduler] No-open abandon tick error");
    }

    /* Tick #3 — Abandon LIVE sessions (active / in_progress / resumed) whose
     * candidate started but went inactive. Anchored to the heartbeat
     * (last_active_at) so an actively-answering candidate is never swept; after
     * INACTIVE_ABANDON_MS of silence we flip status to "abandoned" so the
     * recruiter sees a clear signal and a stale "active" doesn't inflate the
     * "agents online" count forever. Covers all live-answering statuses — the
     * legacy version only matched `in_progress`, leaving `active` sessions to
     * linger indefinitely. */
    try {
      await sweepInactiveLiveSessions();
    } catch (err: any) {
      logger.error({ err: err?.message }, "[interview-invite-scheduler] In-progress abandon tick error");
    }

    /* Tick #4 — Flag recruiter-scheduled interviews that were missed. A
     * schedule whose scheduledAt window passed (+ NO_SHOW_GRACE_MS) while the
     * recruiter never moved it to completed/cancelled is treated as a no-show:
     * status flips to "no_show" and the owning recruiter is notified so they
     * can reschedule or move the candidate on instead of the interview silently
     * sitting "confirmed" forever. */
    try {
      const noShowCutoff = new Date(Date.now() - NO_SHOW_GRACE_MS);
      const missed = await db
        .select()
        .from(interviewSchedulesTable)
        .where(
          and(
            inArray(interviewSchedulesTable.status, ["pending", "confirmed", "rescheduled"]),
            lt(interviewSchedulesTable.scheduledAt, noShowCutoff),
          ),
        );

      if (missed.length > 0) {
        logger.info({ count: missed.length }, "[interview-invite-scheduler] Flagging missed interviews as no-show");
        for (const m of missed) {
          const r = await markNoShowAndNotify(m.id);
          logger.info({ scheduleId: m.id, ok: r.ok, skipped: r.skipped, error: r.error }, "[interview-invite-scheduler] No-show handled");
        }
      }
    } catch (err: any) {
      logger.error({ err: err?.message }, "[interview-invite-scheduler] No-show tick error");
    }

    /* Tick #5 — Expire stale `scheduled` links that were generated
     * (/interviews/generate-link) but never sent through an invite and never
     * started. These carry no invite_sent_at, so Ticks #1/#2 never touch them
     * and they linger as "scheduled" forever, piling up as phantom rows in the
     * dashboard feed. Set-based atomic UPDATE, quiet (no notification). */
    try {
      await expireStaleScheduledSessions();
    } catch (err: any) {
      logger.error({ err: err?.message }, "[interview-invite-scheduler] Scheduled-expiry tick error");
    }
  }

  // First tick a minute after boot so the rest of the system is warm
  setTimeout(tick, 60_000);
  setInterval(tick, INTERVAL_MS);
}
