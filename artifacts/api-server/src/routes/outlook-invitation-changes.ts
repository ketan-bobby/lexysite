import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { dbAdmin, interviewCalendarInvitationAttemptsTable as attempts } from "@workspace/db";
import { UpdateOutlookInvitationBody } from "@workspace/api-zod";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { scheduleVersion } from "../lib/coordinator-schedule-version";
import {
  CalendarError,
  linkedCalendarEvent,
  scheduleBinding,
  utcInstant,
  assertCalendarAvailable,
  type CalendarRequest,
  type GraphEvent,
} from "../lib/outlook-calendar-core";
import { outlookCalendarRequest } from "../lib/outlook-calendar";
import { invitationRecipientHash, invitedCandidate } from "../lib/outlook-candidate-invitation";
import { visibleSchedule } from "./outlook-calendar";
import {
  eligible,
  inviteError,
  lockCurrent,
  readAttempt,
  requireAttemptStorage,
} from "./outlook-candidate-invitations";

type Visible = Awaited<ReturnType<typeof visibleSchedule>>;
type Attempt = typeof attempts.$inferSelect;
type Staff = Awaited<ReturnType<typeof calendarStaff>>;
type ChangeView = {
  scheduleId: string;
  version: string;
  scheduledAt: string;
  durationMinutes: number;
  recipientEmail: string;
  status: "unavailable" | "ready" | "current" | "needs_review";
  approvalVersion: string | null;
  organizerEmail: string | null;
  previousScheduledAt: string | null;
  previousEndAt: string | null;
};
const router = Router();
function conflict() {
  return new CalendarError(
    409,
    "invitation_change_review",
    "The meeting, recipient or approval changed. Reload status and review Outlook. No automatic retry will occur.",
  );
}
function target(row: Visible) {
  return {
    start: row.schedule.scheduledAt.toISOString(),
    end: new Date(
      row.schedule.scheduledAt.getTime() + row.schedule.durationMinutes * 60000,
    ).toISOString(),
  };
}
function base(row: Visible): ChangeView {
  return {
    scheduleId: row.schedule.id,
    version: scheduleVersion(row.schedule),
    scheduledAt: row.schedule.scheduledAt.toISOString(),
    durationMinutes: row.schedule.durationMinutes,
    recipientEmail: row.candidate.email,
    status: "unavailable",
    approvalVersion: null,
    organizerEmail: null,
    previousScheduledAt: null,
    previousEndAt: null,
  };
}
function owns(row: Visible, attempt: Attempt | undefined, caller: Staff): attempt is Attempt {
  return (
    !!attempt &&
    !attempt.panelSnapshot &&
    attempt.status === "accepted" &&
    !!attempt.eventId &&
    attempt.organizerId === caller.id &&
    attempt.candidateId === row.candidate.id &&
    attempt.applicationId === row.application.id &&
    attempt.recipientHash === invitationRecipientHash(row.candidate.email)
  );
}
async function remoteSnapshot(graph: CalendarRequest, row: Visible, attempt: Attempt) {
  // The request closure pins the delegated token. Bind approval to that mailbox,
  // not merely the Lexy user whose Outlook connection can be replaced.
  const mailbox = await graph<{ id: string; mail?: string; userPrincipalName?: string }>(
    "/me?$select=id,mail,userPrincipalName",
  );
  const event = await linkedCalendarEvent(
    graph,
    scheduleBinding(row.schedule.tenantId, row.schedule.id),
  );
  if (
    !mailbox?.id ||
    !(mailbox.mail || mailbox.userPrincipalName) ||
    !event ||
    event.id !== attempt.eventId ||
    !event["@odata.etag"] ||
    !invitedCandidate(event, row.candidate.email, utcInstant(event.start), utcInstant(event.end))
  )
    throw conflict();
  const start = utcInstant(event.start),
    end = utcInstant(event.end);
  if (!Number.isFinite(Date.parse(start)) || Date.parse(end) <= Date.parse(start)) throw conflict();
  const approvalVersion =
    "change_" +
    createHash("sha256")
      .update(
        JSON.stringify([
          row.schedule.id,
          scheduleVersion(row.schedule),
          row.candidate.id,
          invitationRecipientHash(row.candidate.email),
          callerIdentity(attempt),
          mailbox.id,
          mailbox.mail || mailbox.userPrincipalName,
          event.id,
          event["@odata.etag"],
          start,
          end,
          target(row),
        ]),
      )
      .digest("hex");
  return {
    event,
    mailboxId: mailbox.id,
    organizerEmail: (mailbox.mail || mailbox.userPrincipalName)!,
    start,
    end,
    approvalVersion,
  };
}
function callerIdentity(attempt: Attempt) {
  return attempt.organizerId;
}
async function receipt(
  row: Visible,
  caller: Staff,
  graph: CalendarRequest,
  allowReconcile: boolean,
): Promise<ChangeView> {
  let attempt = await dbAdmin.transaction(async (tx) => {
    await requireAttemptStorage(tx);
    return readAttempt(tx, row.schedule.id);
  });
  const result = base(row);
  if (!owns(row, attempt, caller)) return result;
  try {
    eligible(row);
  } catch {
    return result;
  }
  const latest = attempt.changes.at(-1);
  let remote: Awaited<ReturnType<typeof remoteSnapshot>>;
  try {
    remote = await remoteSnapshot(graph, row, attempt);
  } catch {
    return { ...result, status: "needs_review" };
  }
  const details = {
    ...result,
    organizerEmail: remote.organizerEmail,
    previousScheduledAt: remote.start,
    previousEndAt: remote.end,
  };
  if (latest && !latest.acceptedAt) {
    if (
      !allowReconcile ||
      latest.version !== result.version ||
      latest.mailboxId !== remote.mailboxId ||
      latest.start !== remote.start ||
      latest.end !== remote.end
    )
      return { ...details, status: "needs_review" };
    // Reads only against Graph. A saved target observed after a lost reply is
    // not permission to PATCH again and is not evidence of email delivery.
    attempt = await dbAdmin.transaction(async (tx) => {
      await lockCurrent(tx, caller, row);
      const stored = await readAttempt(tx, row.schedule.id);
      if (!stored || stored.changes.at(-1)?.id !== latest.id) throw conflict();
      const changes = stored.changes.map((c) =>
        c.id === latest.id ? { ...c, acceptedAt: c.acceptedAt ?? new Date().toISOString() } : c,
      );
      const [saved] = await tx
        .update(attempts)
        .set({ changes })
        .where(eq(attempts.scheduleId, row.schedule.id))
        .returning();
      return saved;
    });
  }
  const times = target(row);
  if (remote.start === times.start && remote.end === times.end)
    return { ...details, status: "current" };
  // Never repeat a completed or uncertain change for the same native revision.
  if (attempt.changes.some((c) => c.version === result.version))
    return { ...details, status: "needs_review" };
  return { ...details, status: "ready", approvalVersion: remote.approvalVersion };
}

router.get("/outlook-calendar/schedules/:scheduleId/invitation/change", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    const row = await visibleSchedule(caller, String(req.params.scheduleId));
    // Read storage and scope before any provider request.
    const attempt = await dbAdmin.transaction(async (tx) => {
      await requireAttemptStorage(tx);
      return readAttempt(tx, row.schedule.id);
    });
    if (!owns(row, attempt, caller)) {
      res.json(base(row));
      return;
    }
    const graph = await outlookCalendarRequest(caller.id);
    res.json(await receipt(row, caller, graph, true));
  } catch (error) {
    inviteError(error, res, next);
  }
});

router.post("/outlook-calendar/schedules/:scheduleId/invitation/change", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const parsed = UpdateOutlookInvitationBody.strict().safeParse(req.body);
    // Orval currently emits boolean() for an OpenAPI `const: true`. Enforce
    // deliberate approval here as well, without mixing Zod generations.
    if (!parsed.success || parsed.data.confirm !== true)
      throw new CalendarError(
        400,
        "invalid_input",
        "Provide explicit approval and valid reviewed meeting details.",
      );
    const input = parsed.data;
    const caller = await calendarStaff(getAuthUserId(req));
    const row = await visibleSchedule(caller, String(req.params.scheduleId));
    eligible(row);
    if (scheduleVersion(row.schedule) !== input.expectedVersion) throw conflict();
    await dbAdmin.transaction((tx) => requireAttemptStorage(tx));
    const graph = await outlookCalendarRequest(caller.id);
    const proposal = await receipt(row, caller, graph, false);
    if (proposal.status !== "ready" || proposal.approvalVersion !== input.approvalVersion)
      throw conflict();
    const id = randomUUID();
    // Commit the immutable intent BEFORE contacting Graph with a mutation.
    await dbAdmin.transaction(async (tx) => {
      const current = await lockCurrent(tx, caller, row);
      const attempt = await readAttempt(tx, current.schedule.id);
      if (
        !owns(current, attempt, caller) ||
        attempt.changes.some((c) => !c.acceptedAt || c.version === input.expectedVersion)
      )
        throw conflict();
      const remote = await remoteSnapshot(graph, current, attempt);
      if (remote.approvalVersion !== input.approvalVersion) throw conflict();
      await tx
        .update(attempts)
        .set({
          changes: [
            ...attempt.changes,
            {
              id,
              version: input.expectedVersion,
              approvalVersion: input.approvalVersion,
              eventId: remote.event.id,
              sourceEtag: remote.event["@odata.etag"]!,
              mailboxId: remote.mailboxId,
              ...target(current),
              previousStart: remote.start,
              previousEnd: remote.end,
              attemptedAt: new Date().toISOString(),
              acceptedAt: null,
            },
          ],
        })
        .where(eq(attempts.scheduleId, current.schedule.id));
    });
    await dbAdmin.transaction(async (tx) => {
      const current = await lockCurrent(tx, caller, row);
      const attempt = await readAttempt(tx, current.schedule.id);
      const change = attempt?.changes.at(-1);
      if (!owns(current, attempt, caller) || !change || change.id !== id || change.acceptedAt)
        throw conflict();
      const remote = await remoteSnapshot(graph, current, attempt);
      if (
        remote.approvalVersion !== change.approvalVersion ||
        remote.mailboxId !== change.mailboxId
      )
        throw conflict();
      await assertCalendarAvailable(graph, change.start, change.end, change.eventId);
      // Time-only PATCH to the SAME immutable ID. Do not recreate the event,
      // rewrite attendees/body, add panelists, or use email fallback.
      const event = await graph<GraphEvent>(`/me/events/${encodeURIComponent(change.eventId)}`, {
        method: "PATCH",
        headers: { "If-Match": change.sourceEtag },
        body: JSON.stringify({
          start: { dateTime: change.start, timeZone: "UTC" },
          end: { dateTime: change.end, timeZone: "UTC" },
        }),
      });
      if (
        event?.id !== change.eventId ||
        !invitedCandidate(event, current.candidate.email, change.start, change.end)
      )
        throw new CalendarError(
          503,
          "invitation_change_uncertain",
          "Outlook may have updated the invitation. Reload status; do not send again.",
        );
      await tx
        .update(attempts)
        .set({
          changes: attempt.changes.map((c) =>
            c.id === id ? { ...c, acceptedAt: new Date().toISOString() } : c,
          ),
        })
        .where(eq(attempts.scheduleId, current.schedule.id));
    });
    res.json(await receipt(row, caller, graph, true));
  } catch (error) {
    inviteError(error, res, next);
  }
});
export default router;
