import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  dbAdmin,
  interviewSchedulePanelsTable as panels,
  interviewCalendarInvitationAttemptsTable as attempts,
  usersTable,
} from "@workspace/db";
import { getAuthUserId } from "../lib/auth-token";
import { calendarStaff } from "../lib/calendar-staff";
import { getDataScopeTenantIds } from "../lib/tenantUtils";
import { recruiterOwnsResource } from "../lib/ownership";
import { scheduleVersion } from "../lib/coordinator-schedule-version";
import { CalendarError, linkedCalendarEvent, scheduleBinding } from "../lib/outlook-calendar-core";
import { outlookCalendarRequest } from "../lib/outlook-calendar";
import {
  invitationRecipientHash,
  invitedRecipients,
  sendCandidateCalendarInvitation,
} from "../lib/outlook-candidate-invitation";
import {
  members,
  mailboxHash,
  storage,
  unavailable,
  type PanelTx,
  type PanelSchedule,
  type PanelCaller,
} from "../lib/calendar-panel-access";
import { assertPanelCoordinator, assertSavedPanel } from "../lib/interview-schedule-panel";
import { visibleSchedule } from "./outlook-calendar";
import {
  eligible,
  inviteError,
  lockCurrent,
  readAttempt,
  requireAttemptStorage,
} from "./outlook-candidate-invitations";
import { SendOutlookPanelInvitationBody } from "@workspace/api-zod";

const router = Router();
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const savedSchema = z
  .array(
    z.strictObject({
      userId: z.string().min(1),
      mailboxHash: z.string().regex(/^[a-f0-9]{64}$/),
      grantedAt: z.iso.datetime(),
    }),
  )
  .max(5);
type Attempt = typeof attempts.$inferSelect;
function conflict() {
  return new CalendarError(
    409,
    "panel_invitation_changed",
    "The panel, mailbox, recipient or interview changed. Reload and review before sending. No automatic retry will occur.",
  );
}
async function privateStorage(tx: PanelTx) {
  await requireAttemptStorage(tx);
  const proof = await tx.execute(sql`SELECT EXISTS(
    SELECT 1 FROM pg_attribute WHERE attrelid=to_regclass('interview_calendar_invitation_attempts')
      AND attname='panel_snapshot' AND atttypid='jsonb'::regtype AND NOT attisdropped
  ) AS ready`);
  if (proof.rows[0]?.ready !== true)
    throw new CalendarError(
      503,
      "panel_invitation_unavailable",
      "Panel invitation storage is unavailable. No invitation was sent.",
    );
}
async function mailbox(userId: string) {
  const graph = await outlookCalendarRequest(userId);
  const identity = await graph<{ id: string; mail?: string; userPrincipalName?: string }>(
    "/me?$select=id,mail,userPrincipalName",
  );
  const email = (identity?.mail || identity?.userPrincipalName || "").trim().toLowerCase();
  if (!identity?.id || !z.email().safeParse(email).success) throw conflict();
  return { graph, email, mailboxHash: mailboxHash(identity.id) };
}
async function snapshot(
  tx: PanelTx,
  caller: PanelCaller,
  row: PanelSchedule,
  checkAvailability: boolean,
) {
  await tx.select().from(usersTable).where(eq(usersTable.id, caller.id)).for("share");
  const fresh = await calendarStaff(caller.id);
  if (fresh.role !== caller.role || fresh.tenantId !== caller.tenantId) throw conflict();
  await assertPanelCoordinator(caller, row);
  if (!row.schedule.panelRevision) return null;
  await storage(tx, "interview_schedule_panels");
  const [saved] = await tx
    .select()
    .from(panels)
    .where(eq(panels.scheduleId, row.schedule.id))
    .for("share");
  if (!saved || saved.revision !== row.schedule.panelRevision) throw unavailable();
  const parsed = savedSchema.safeParse(saved.members);
  if (!parsed.success) throw unavailable();
  const selected = parsed.data;
  if (!selected.length) return null;
  if (
    new Set(selected.map((p) => p.userId)).size !== selected.length ||
    (row.schedule.interviewerId && !selected.some((p) => p.userId === row.schedule.interviewerId))
  )
    throw unavailable();
  await storage(tx);
  const roster = await members(
    caller,
    row,
    tx,
    selected.map((p) => p.userId),
  );
  if (
    roster.length !== selected.length ||
    selected.some(
      (p) =>
        !roster.some(
          (r) =>
            r.member.id === p.userId &&
            r.consent.mailboxHash === p.mailboxHash &&
            r.consent.grantedAt.toISOString() === p.grantedAt,
        ),
    )
  )
    throw unavailable();
  if (checkAvailability) await assertSavedPanel(tx, row.schedule);
  const organizer = await mailbox(caller.id);
  const recipients = [];
  for (const { member, consent } of roster.sort((a, b) => a.member.id.localeCompare(b.member.id))) {
    const identity = member.id === caller.id ? organizer : await mailbox(member.id);
    if (identity.mailboxHash !== consent.mailboxHash) throw conflict();
    recipients.push({
      userId: member.id,
      name: member.name,
      email: identity.email,
      mailboxHash: identity.mailboxHash,
    });
  }
  if (
    new Set(recipients.map((p) => p.mailboxHash)).size !== recipients.length ||
    new Set(recipients.map((p) => p.email)).size !== recipients.length ||
    recipients.some((p) => p.email === row.candidate.email.trim().toLowerCase()) ||
    organizer.email === row.candidate.email.trim().toLowerCase() ||
    recipients.some(
      (p) =>
        p.userId !== caller.id &&
        (p.mailboxHash === organizer.mailboxHash || p.email === organizer.email),
    )
  )
    throw conflict();
  const evidence = {
    organizerMailboxHash: organizer.mailboxHash,
    organizerEmailHash: invitationRecipientHash(organizer.email),
    recipients: recipients.map((p) => ({
      userId: p.userId,
      mailboxHash: p.mailboxHash,
      emailHash: invitationRecipientHash(p.email),
    })),
  };
  const approvalToken = hash([
    scheduleVersion(row.schedule),
    invitationRecipientHash(row.candidate.email),
    row.schedule.id,
    row.application.id,
    row.candidate.id,
    caller.id,
    evidence,
    selected,
    recipients.map((p) => p.name),
  ]);
  return {
    organizer,
    recipients,
    evidence: { ...evidence, approvalToken },
    approvalToken,
    panelEmails: recipients.filter((p) => p.userId !== caller.id).map((p) => p.email),
  };
}
function same(row: PanelSchedule, attempt: Attempt, token: string, caller: PanelCaller) {
  return (
    attempt.scheduleVersion === scheduleVersion(row.schedule) &&
    attempt.candidateId === row.candidate.id &&
    attempt.applicationId === row.application.id &&
    attempt.recipientHash === invitationRecipientHash(row.candidate.email) &&
    attempt.organizerId === caller.id &&
    attempt.panelSnapshot?.approvalToken === token
  );
}
function view(
  row: PanelSchedule,
  details: Awaited<ReturnType<typeof snapshot>>,
  attempt?: Attempt,
) {
  const matches =
    details &&
    attempt &&
    attempt.panelSnapshot?.approvalToken === details.approvalToken &&
    attempt.scheduleVersion === scheduleVersion(row.schedule);
  return {
    scheduleId: row.schedule.id,
    version: scheduleVersion(row.schedule),
    scheduledAt: row.schedule.scheduledAt.toISOString(),
    durationMinutes: row.schedule.durationMinutes,
    recipientEmail: row.candidate.email,
    organizerEmail: details?.organizer.email ?? null,
    panelRecipients:
      details?.recipients.map(({ userId, name, email }) => ({ userId, name, email })) ?? [],
    approvalToken: details?.approvalToken ?? null,
    status: attempt
      ? matches && attempt.status === "accepted"
        ? "accepted"
        : "needs_review"
      : details
        ? "not_sent"
        : "unavailable",
    acceptedAt: attempt?.acceptedAt?.toISOString() ?? null,
  };
}
router.get("/outlook-calendar/schedules/:scheduleId/panel-invitation", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const caller = await calendarStaff(getAuthUserId(req));
    const row = await visibleSchedule(caller, String(req.params.scheduleId));
    const result = await dbAdmin.transaction(async (tx) => {
      await privateStorage(tx);
      const current = await lockCurrent(tx, caller, row);
      const attempt = await readAttempt(tx, row.schedule.id);
      const details = await snapshot(tx, caller, current, !attempt);
      // Reconciliation is reads only at Microsoft; never resend a committed attempt.
      if (
        details &&
        attempt?.status === "attempted" &&
        same(current, attempt, details.approvalToken, caller)
      ) {
        const remote = await linkedCalendarEvent(
          details.organizer.graph,
          scheduleBinding(current.schedule.tenantId, current.schedule.id),
        );
        const start = current.schedule.scheduledAt.toISOString();
        const end = new Date(
          current.schedule.scheduledAt.getTime() + current.schedule.durationMinutes * 60000,
        ).toISOString();
        if (
          remote?.id &&
          invitedRecipients(
            remote,
            [current.candidate.email, ...details.panelEmails],
            start,
            end,
            true,
          )
        ) {
          const [saved] = await tx
            .update(attempts)
            .set({ status: "accepted", acceptedAt: new Date(), eventId: remote.id })
            .where(eq(attempts.scheduleId, current.schedule.id))
            .returning();
          return view(current, details, saved);
        }
      }
      return view(current, details, attempt);
    });
    res.json(result);
  } catch (error) {
    inviteError(error, res, next);
  }
});
router.post("/outlook-calendar/schedules/:scheduleId/panel-invitation", async (req, res, next) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    // Generated schemas use Zod 3 and omit boolean const/strictness. Do not mix
    // Zod 4 nodes into them or rely on cross-version ZodError instanceof checks.
    const contract = SendOutlookPanelInvitationBody.safeParse(req.body);
    if (!contract.success)
      throw new CalendarError(400, "invalid_input", "Provide a valid panel invitation request.");
    const input = z
      .strictObject({
        confirm: z.literal(true),
        expectedVersion: z.string(),
        expectedApprovalToken: z.string(),
      })
      .parse(req.body);
    const caller = await calendarStaff(getAuthUserId(req));
    const row = await visibleSchedule(caller, String(req.params.scheduleId));
    const allowed = await getDataScopeTenantIds(caller);
    if (
      (allowed !== null && !allowed.includes(row.job.tenantId)) ||
      !(await recruiterOwnsResource(caller, { kind: "jobId", value: row.job.id }))
    )
      throw new CalendarError(404, "schedule_not_found", "Interview schedule not found.");
    eligible(row);
    const intent = await dbAdmin.transaction(async (tx) => {
      await privateStorage(tx);
      const current = await lockCurrent(tx, caller, row);
      const prior = await readAttempt(tx, row.schedule.id);
      const details = await snapshot(tx, caller, current, !prior);
      if (
        !details ||
        scheduleVersion(current.schedule) !== input.expectedVersion ||
        details.approvalToken !== input.expectedApprovalToken
      )
        throw conflict();
      if (prior) {
        if (prior.status === "accepted" && same(current, prior, details.approvalToken, caller))
          return { prior, accepted: view(current, details, prior) };
        throw conflict();
      }
      const existing = await linkedCalendarEvent(
        details.organizer.graph,
        scheduleBinding(current.schedule.tenantId, current.schedule.id),
      );
      // Do not turn holds or existing guest events into panel invitations implicitly.
      if (existing)
        throw new CalendarError(
          409,
          "panel_existing_event",
          "An Outlook event already exists for this interview. Review it in Outlook; no new invitation was sent.",
        );
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
          panelSnapshot: details.evidence,
        })
        .returning();
      return { prior: saved, accepted: null };
    });
    if (intent.accepted) {
      res.json(intent.accepted);
      return;
    }
    const result = await dbAdmin.transaction(async (tx) => {
      const current = await lockCurrent(tx, caller, row);
      const stored = await readAttempt(tx, row.schedule.id);
      if (
        !stored ||
        stored.status !== "attempted" ||
        stored.transactionId !== intent.prior.transactionId
      )
        throw conflict();
      const details = await snapshot(tx, caller, current, true);
      if (
        !details ||
        !same(current, stored, details.approvalToken, caller) ||
        details.approvalToken !== input.expectedApprovalToken
      )
        throw conflict();
      const graph = details.organizer.graph;
      if (
        await linkedCalendarEvent(
          graph,
          scheduleBinding(current.schedule.tenantId, current.schedule.id),
        )
      )
        throw conflict();
      const start = current.schedule.scheduledAt.toISOString();
      const end = new Date(
        current.schedule.scheduledAt.getTime() + current.schedule.durationMinutes * 60000,
      ).toISOString();
      const remote = await sendCandidateCalendarInvitation(
        graph,
        {
          scheduleId: current.schedule.id,
          tenantId: current.schedule.tenantId,
          jobTitle: current.job.title,
          candidateEmail: current.candidate.email,
          start,
          end,
          transactionId: stored.transactionId,
          panelEmails: details.panelEmails,
        },
        null,
      );
      const [saved] = await tx
        .update(attempts)
        .set({ status: "accepted", acceptedAt: new Date(), eventId: remote.id })
        .where(eq(attempts.scheduleId, current.schedule.id))
        .returning();
      if (!saved) throw conflict();
      return view(current, details, saved);
    });
    res.json(result);
  } catch (error) {
    inviteError(error, res, next);
  }
});
export default router;
