import { Router, type Response, type NextFunction } from "express";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  dbAdmin,
  interviewSchedulesTable,
  applicationsTable,
  jobsTable,
  candidatesTable,
  interviewSchedulePanelsTable,
  interviewCalendarInvitationAttemptsTable as attempts,
} from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { isJobApproved } from "../lib/job-approval-gate";
import { scheduleVersion } from "../lib/coordinator-schedule-version";
import { CalendarError, linkedCalendarEvent, scheduleBinding } from "../lib/outlook-calendar-core";
import { outlookCalendarRequest } from "../lib/outlook-calendar";
import {
  invitationRecipientHash,
  invitedCandidate,
  sendCandidateCalendarInvitation,
} from "../lib/outlook-candidate-invitation";
import { visibleSchedule } from "./outlook-calendar";
import { storage as panelStorage } from "../lib/calendar-panel-access";

type Staff = Awaited<ReturnType<typeof calendarStaff>>;
type Visible = Awaited<ReturnType<typeof visibleSchedule>>;
type Attempt = typeof attempts.$inferSelect;
type Tx = Parameters<Parameters<typeof dbAdmin.transaction>[0]>[0];
const router = Router();
const requestSchema = z.strictObject({
  confirm: z.literal(true),
  expectedVersion: z.string().regex(/^v1_[0-9a-f]{64}$/),
  expectedRecipientEmail: z.email(),
});

function noSend(message: string, code = "invitation_needs_review") {
  return new CalendarError(409, code, message);
}
export function eligible(row: Visible) {
  const { schedule, job, candidate } = row;
  if (
    schedule.status !== "confirmed" ||
    schedule.type === "ai_interview" ||
    schedule.scheduledAt.getTime() <= Date.now() ||
    schedule.durationMinutes < 5 ||
    schedule.durationMinutes > 480 ||
    !isJobApproved(job.status) ||
    candidate.dataErasedAt ||
    candidate.doNotContact
  )
    throw noSend(
      "This confirmed interview is no longer eligible for a candidate calendar invitation.",
    );
  if (!z.email().safeParse(candidate.email).success)
    throw noSend("The candidate needs a valid contact email before an invitation can be sent.");
}
function matches(row: Visible, attempt: Attempt) {
  return (
    row.schedule.id === attempt.scheduleId &&
    row.application.id === attempt.applicationId &&
    row.candidate.id === attempt.candidateId &&
    invitationRecipientHash(row.candidate.email) === attempt.recipientHash &&
    scheduleVersion(row.schedule) === attempt.scheduleVersion &&
    row.schedule.status === "confirmed" &&
    isJobApproved(row.job.status) &&
    !row.candidate.dataErasedAt &&
    !row.candidate.doNotContact
  );
}
function view(row: Visible, attempt: Attempt | undefined) {
  const latest = attempt?.changes?.at(-1);
  const effective =
    attempt && latest?.acceptedAt ? { ...attempt, scheduleVersion: latest.version } : attempt;
  return {
    scheduleId: row.schedule.id,
    version: scheduleVersion(row.schedule),
    scheduledAt: row.schedule.scheduledAt.toISOString(),
    durationMinutes: row.schedule.durationMinutes,
    recipientEmail: row.candidate.email,
    status: !attempt
      ? "not_sent"
      : !attempt.panelSnapshot &&
          attempt.status === "accepted" &&
          (!latest || !!latest.acceptedAt) &&
          matches(row, effective!)
        ? "accepted"
        : "needs_review",
    acceptedAt: attempt?.acceptedAt?.toISOString() ?? null,
  };
}
export async function requireAttemptStorage(tx: Tx) {
  const result = await tx.execute(sql`
    SELECT c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname='changes' AND NOT a.attisdropped AND a.attnotnull
        AND a.atttypid='jsonb'::regtype) AS change_storage,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname='provider' AND NOT a.attisdropped AND a.attnotnull
        AND a.atttypid='text'::regtype) AS provider_storage,
      EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid
        AND a.attname='google_snapshot' AND NOT a.attisdropped
        AND a.atttypid='jsonb'::regtype) AS google_storage,
      NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=c.oid) AS no_policies,
      NOT has_table_privilege('lexy_app',c.oid,'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER') AS no_grants,
      NOT has_any_column_privilege('lexy_app',c.oid,'SELECT,INSERT,UPDATE,REFERENCES') AS no_column_grants,
      EXISTS(SELECT 1 FROM pg_trigger t JOIN pg_proc p ON p.oid=t.tgfoid
        WHERE t.tgrelid=c.oid AND t.tgname='lexy_erasure_write_barrier'
          AND t.tgtype=23 AND t.tgenabled IN ('O','A') AND p.prosecdef
          AND t.tgqual IS NULL AND t.tgnargs=1
          AND t.tgargs=convert_to('candidate_id','UTF8') || decode('00','hex')
          AND p.pronamespace=c.relnamespace
          AND p.proname='lexy_erasure_write_barrier') AS barrier
    FROM pg_class c WHERE c.oid=to_regclass('interview_calendar_invitation_attempts')
  `);
  const proof = result.rows[0];
  if (!proof || Object.values(proof).some((pass) => pass !== true))
    throw new CalendarError(
      503,
      "invitation_unavailable",
      "Calendar invitations are temporarily unavailable. No Outlook invitation was sent.",
    );
}
export async function readAttempt(tx: Tx, scheduleId: string) {
  const [attempt] = await tx.select().from(attempts).where(eq(attempts.scheduleId, scheduleId));
  if (attempt?.provider === "google")
    throw noSend(
      "A Google invitation attempt already exists. Review it in the Google invitation controls; no Outlook invitation was sent.",
      "invitation_other_provider",
    );
  return attempt;
}

// Revalidation runs after acquiring all parent locks, including the candidate
// privacy row. The caller's previously authorized scope is checked again.
export async function lockCurrent(tx: Tx, caller: Staff, row: Visible, allowCancelled = false) {
  const [locked] = await tx
    .select()
    .from(interviewSchedulesTable)
    .where(eq(interviewSchedulesTable.id, row.schedule.id))
    .for("update");
  if (!locked) throw noSend("This interview schedule changed. Reload before sending.");
  const [app] = await tx
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, locked.applicationId))
    .for("share");
  if (!app) throw noSend("The interview application changed. Reload before sending.");
  const [job] = await tx.select().from(jobsTable).where(eq(jobsTable.id, app.jobId)).for("share");
  const [candidate] = await tx
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, app.candidateId))
    .for("share");
  if (!job || !candidate) throw noSend("The interview owner changed. Reload before sending.");
  const current = await visibleSchedule(caller, row.schedule.id);
  // Google cancellation may follow a native cancellation; every other safety
  // check is unchanged. Existing callers retain the confirmed-only default.
  eligible(
    allowCancelled && current.schedule.status === "cancelled"
      ? { ...current, schedule: { ...current.schedule, status: "confirmed" } }
      : current,
  );
  if (
    scheduleVersion(current.schedule) !== scheduleVersion(row.schedule) ||
    current.candidate.id !== row.candidate.id ||
    current.candidate.email.toLowerCase() !== row.candidate.email.toLowerCase() ||
    current.application.id !== row.application.id
  )
    throw noSend("The interview or recipient changed. Reload before sending.");
  return current;
}

router.get("/outlook-calendar/schedules/:scheduleId/invitation", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    const row = await visibleSchedule(caller, String(req.params.scheduleId));
    const attempt = await dbAdmin.transaction(async (tx) => {
      await requireAttemptStorage(tx);
      return readAttempt(tx, row.schedule.id);
    });
    if (
      !attempt ||
      attempt.panelSnapshot ||
      attempt.status === "accepted" ||
      !matches(row, attempt) ||
      attempt.organizerId !== caller.id
    ) {
      res.json(view(row, attempt));
      return;
    }
    // An earlier Graph write may have succeeded after its response was lost.
    // This read is reconciliation only. Never send again from a status request.
    try {
      const graph = await outlookCalendarRequest(caller.id);
      const event = await linkedCalendarEvent(
        graph,
        scheduleBinding(row.schedule.tenantId, row.schedule.id),
      );
      const start = row.schedule.scheduledAt.toISOString();
      const end = new Date(
        row.schedule.scheduledAt.getTime() + row.schedule.durationMinutes * 60000,
      ).toISOString();
      if (invitedCandidate(event, row.candidate.email, start, end)) {
        const updated = await dbAdmin.transaction(async (tx) => {
          const current = await lockCurrent(tx, caller, row);
          const stored = await readAttempt(tx, row.schedule.id);
          if (
            !stored ||
            stored.transactionId !== attempt.transactionId ||
            !matches(current, stored)
          )
            throw noSend("The invitation record changed. Review it in Outlook.");
          if (stored.status === "accepted") return stored;
          const [saved] = await tx
            .update(attempts)
            .set({
              status: "accepted",
              acceptedAt: new Date(),
              eventId: event!.id,
            })
            .where(
              and(
                eq(attempts.scheduleId, row.schedule.id),
                eq(attempts.transactionId, stored.transactionId),
              ),
            )
            .returning();
          if (!saved) throw noSend("The invitation receipt changed. Review it in Outlook.");
          return saved;
        });
        res.json(view(row, updated));
        return;
      }
    } catch {
      // A missing connection or delayed Graph index is not evidence that
      // nothing was sent. The durable attempt remains needs_review.
    }
    res.json(view(row, attempt));
  } catch (error) {
    inviteError(error, res, next);
  }
});

router.post("/outlook-calendar/schedules/:scheduleId/invitation", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const input = requestSchema.parse(req.body);
    const caller = await calendarStaff(getAuthUserId(req));
    const row = await visibleSchedule(caller, String(req.params.scheduleId));
    eligible(row);
    if (row.schedule.panelRevision) {
      await dbAdmin.transaction(async (tx) => {
        await panelStorage(tx, "interview_schedule_panels");
        const [panel] = await tx
          .select()
          .from(interviewSchedulePanelsTable)
          .where(eq(interviewSchedulePanelsTable.scheduleId, row.schedule.id));
        if (
          !panel ||
          panel.revision !== row.schedule.panelRevision ||
          !Array.isArray(panel.members) ||
          panel.members.length
        )
          throw noSend(
            "This interview has a saved panel. Use Review panel invitation instead of the candidate-only invitation.",
          );
      });
    }
    if (
      scheduleVersion(row.schedule) !== input.expectedVersion ||
      row.candidate.email.trim().toLowerCase() !== input.expectedRecipientEmail.trim().toLowerCase()
    )
      throw noSend(
        "The interview time or recipient changed. Reload before sending.",
        "invitation_changed",
      );
    await dbAdmin.transaction((tx) => requireAttemptStorage(tx));
    // Calendar consent and a read-only Graph preflight happen before recording
    // the send intent. Once an intent exists, never create another automatically.
    const graph = await outlookCalendarRequest(caller.id);
    const binding = scheduleBinding(row.schedule.tenantId, row.schedule.id);
    const existing = await linkedCalendarEvent(graph, binding);
    if (existing?.attendees?.length)
      throw noSend(
        "An Outlook meeting already has guests. Review it before sending another invitation.",
      );
    const intent = await dbAdmin.transaction(async (tx) => {
      const current = await lockCurrent(tx, caller, row);
      const prior = await readAttempt(tx, current.schedule.id);
      if (prior) {
        if (prior.status === "accepted" && matches(current, prior)) return prior;
        throw noSend("A previous Outlook invitation attempt needs review. Do not send again.");
      }
      const [saved] = await tx
        .insert(attempts)
        .values({
          scheduleId: current.schedule.id,
          applicationId: current.application.id,
          candidateId: current.candidate.id,
          organizerId: caller.id,
          recipientHash: invitationRecipientHash(current.candidate.email),
          scheduleVersion: scheduleVersion(current.schedule),
          transactionId: randomUUID(),
          status: "attempted",
          attemptedAt: new Date(),
        })
        .returning();
      return saved;
    });
    if (intent.status === "accepted") {
      res.json(view(row, intent));
      return;
    }
    // Hold the schedule and privacy rows across the bounded external request.
    // A crash or uncertain provider response leaves the committed intent for
    // human reconciliation; it never creates a retryable pending send.
    const accepted = await dbAdmin.transaction(async (tx) => {
      const current = await lockCurrent(tx, caller, row);
      const stored = await readAttempt(tx, row.schedule.id);
      if (
        !stored ||
        stored.transactionId !== intent.transactionId ||
        stored.status !== "attempted" ||
        !matches(current, stored)
      )
        throw noSend("The invitation changed before Outlook could be contacted.");
      const remote = await linkedCalendarEvent(graph, binding);
      const start = current.schedule.scheduledAt.toISOString();
      const end = new Date(
        current.schedule.scheduledAt.getTime() + current.schedule.durationMinutes * 60000,
      ).toISOString();
      const event = await sendCandidateCalendarInvitation(
        graph,
        {
          scheduleId: current.schedule.id,
          tenantId: current.schedule.tenantId,
          jobTitle: current.job.title,
          candidateEmail: current.candidate.email,
          start,
          end,
          transactionId: stored.transactionId,
        },
        remote,
      );
      const [saved] = await tx
        .update(attempts)
        .set({
          status: "accepted",
          acceptedAt: new Date(),
          eventId: event.id,
        })
        .where(
          and(
            eq(attempts.scheduleId, row.schedule.id),
            eq(attempts.transactionId, stored.transactionId),
          ),
        )
        .returning();
      if (!saved)
        throw noSend(
          "Outlook may have accepted the invitation. Review it before doing anything else.",
        );
      return saved;
    });
    res.json(view(row, accepted));
  } catch (error) {
    inviteError(error, res, next);
  }
});

export function inviteError(error: unknown, res: Response, next: NextFunction) {
  if (error instanceof z.ZodError) {
    res.status(400).json({ code: "invalid_input", error: "Provide a valid invitation request." });
    return;
  }
  let cause = error;
  for (let depth = 0; depth < 6 && cause && typeof cause === "object"; depth++) {
    const value = cause as { code?: string; message?: string; cause?: unknown };
    if (
      value.code === "42P01" &&
      value.message?.includes("interview_calendar_invitation_attempts")
    ) {
      res.status(503).json({
        code: "invitation_unavailable",
        error: "Calendar invitations are temporarily unavailable. No Outlook invitation was sent.",
      });
      return;
    }
    cause = value.cause;
  }
  if (error instanceof CalendarError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  next(error);
}
export default router;
