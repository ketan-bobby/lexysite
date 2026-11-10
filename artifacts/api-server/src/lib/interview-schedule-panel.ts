import { and, eq } from "drizzle-orm";
import {
  applicationsTable,
  candidatesTable,
  jobsTable,
  interviewSchedulesTable,
  interviewSchedulePanelsTable as panels,
  usersTable,
} from "@workspace/db";
import { calendarStaff } from "./calendar-staff";
import { calendarScheduleVisible, CalendarError } from "./outlook-calendar-core";
import { getDataScopeTenantIds, type TenantScopeReader } from "./tenantUtils";
import { recruiterOwnsResource } from "./ownership";
import { compliantCandidatePredicate } from "./compliance-scope";
import { isJobApproved } from "./job-approval-gate";
import { scheduleVersion } from "./coordinator-schedule-version";
import { CandidateConfirmationError } from "./candidate-schedule-confirmation";
import { commonPanelSlots } from "./panel-calendar-slots";
import {
  members,
  memberAllowed,
  panelCalendars,
  storage,
  unavailable,
  type PanelTx,
  type PanelSchedule,
  type PanelCaller,
} from "./calendar-panel-access";
import { savedPanelMembers as savedMembers, savedPanelProvider } from "./saved-panel-members";

export async function lockPanelSchedule(tx: PanelTx, id: string): Promise<PanelSchedule> {
  const [locked] = await tx
    .select()
    .from(interviewSchedulesTable)
    .where(eq(interviewSchedulesTable.id, id))
    .for("update");
  if (!locked) throw unavailable();
  const read = () =>
    tx
      .select({
        schedule: interviewSchedulesTable,
        application: applicationsTable,
        job: jobsTable,
        candidate: candidatesTable,
      })
      .from(interviewSchedulesTable)
      .innerJoin(applicationsTable, eq(applicationsTable.id, interviewSchedulesTable.applicationId))
      .innerJoin(jobsTable, eq(jobsTable.id, applicationsTable.jobId))
      .innerJoin(candidatesTable, eq(candidatesTable.id, applicationsTable.candidateId))
      .where(
        and(
          eq(interviewSchedulesTable.id, id),
          eq(interviewSchedulesTable.tenantId, applicationsTable.tenantId),
          compliantCandidatePredicate(),
        ),
      );
  const [first] = await read();
  if (!first) throw unavailable();
  await tx
    .select()
    .from(applicationsTable)
    .where(eq(applicationsTable.id, first.application.id))
    .for("share");
  await tx.select().from(jobsTable).where(eq(jobsTable.id, first.job.id)).for("share");
  await tx
    .select()
    .from(candidatesTable)
    .where(eq(candidatesTable.id, first.candidate.id))
    .for("share");
  const [row] = await read();
  if (
    !row ||
    !isJobApproved(row.job.status) ||
    row.schedule.type === "ai_interview" ||
    !["pending", "scheduled", "rescheduled", "confirmed"].includes(row.schedule.status)
  )
    throw unavailable();
  return row;
}
export async function assertPanelCoordinator(
  caller: PanelCaller,
  row: PanelSchedule,
  reader?: TenantScopeReader,
) {
  if (
    caller.role === "interviewer" ||
    !calendarScheduleVisible({
      callerId: caller.id,
      role: caller.role,
      allowedTenantIds: await getDataScopeTenantIds(caller, reader),
      ownsJob: await recruiterOwnsResource(caller, { kind: "jobId", value: row.job.id }, reader),
      jobTenantId: row.job.tenantId,
      scheduleTenantId: row.schedule.tenantId,
      applicationTenantId: row.application.tenantId,
      interviewerId: row.schedule.interviewerId,
    })
  )
    throw unavailable();
}
export async function checkPanelSlot(
  tx: PanelTx,
  caller: PanelCaller,
  row: PanelSchedule,
  userIds: string[],
  start: string,
  durationMinutes: number,
  bufferMinutes: number,
) {
  await storage(tx);
  if (!userIds.length || new Set(userIds).size !== userIds.length) throw unavailable();
  const panel = await members(caller, row, tx, userIds);
  if (row.schedule.interviewerId && !userIds.includes(row.schedule.interviewerId))
    throw unavailable();
  if (panel.length !== userIds.length) throw unavailable();
  const end = new Date(Date.parse(start) + durationMinutes * 60000).toISOString();
  // Discovery needs 15 minutes' notice; confirming an already offered time only
  // requires that it is still future. It must still fit every actual calendar.
  const options = { start, end, durationMinutes, bufferMinutes };
  commonPanelSlots([[]], options, Date.parse(start) - 15 * 60000);
  const availability = await panelCalendars(tx, panel, start, end, bufferMinutes);
  for (const p of panel) if (!(await memberAllowed(p.member, row))) throw unavailable();
  const slots = commonPanelSlots(
    availability.calendars,
    options,
    Date.parse(start) - 15 * 60000,
    availability.allows,
  );
  if (!slots.length || Date.parse(start) <= Date.now())
    throw new CalendarError(
      409,
      "panel_conflict",
      "This time is no longer available for the whole panel. Choose and review another time.",
    );
  return panel;
}
export async function assertSavedPanel(
  tx: PanelTx,
  snapshot: typeof interviewSchedulesTable.$inferSelect,
  start = snapshot.scheduledAt.toISOString(),
  duration = snapshot.durationMinutes,
) {
  if (!snapshot.panelRevision) return;
  const row = await lockPanelSchedule(tx, snapshot.id);
  if (scheduleVersion(row.schedule) !== scheduleVersion(snapshot)) throw unavailable();
  await storage(tx, "interview_schedule_panels");
  const [saved] = await tx
    .select()
    .from(panels)
    .where(eq(panels.scheduleId, snapshot.id))
    .for("share");
  if (!saved || saved.revision !== snapshot.panelRevision) throw unavailable();
  const parsed = savedMembers.safeParse(saved.members);
  if (
    !parsed.success ||
    new Set(parsed.data.map((m) => m.userId)).size !== parsed.data.length ||
    !Number.isInteger(saved.bufferMinutes) ||
    saved.bufferMinutes < 0 ||
    saved.bufferMinutes > 60
  )
    throw unavailable();
  // Empty is a deliberate removal tombstone; its nonce prevents old proposals
  // reviving after an attach/remove cycle. Missing state is never an empty panel.
  if (!parsed.data.length) return;
  await tx.select().from(usersTable).where(eq(usersTable.id, saved.coordinatorId)).for("share");
  const caller = await calendarStaff(saved.coordinatorId);
  await assertPanelCoordinator(caller, row, tx);
  if (savedPanelProvider(parsed.data) === "google") {
    const { googlePanelRepository } = await import("./google-panel-store");
    await googlePanelRepository().assertSaved(tx, row, caller, saved, start, duration);
    return;
  }
  const panel = await members(
    caller,
    row,
    tx,
    parsed.data.map((m) => m.userId),
  );
  if (
    panel.length !== parsed.data.length ||
    parsed.data.some(
      (m) =>
        !panel.some(
          (p) =>
            p.member.id === m.userId &&
            !("provider" in m) &&
            p.consent.mailboxHash === m.mailboxHash &&
            p.consent.grantedAt.toISOString() === m.grantedAt,
        ),
    )
  )
    throw unavailable();
  await checkPanelSlot(
    tx,
    caller,
    row,
    parsed.data.map((m) => m.userId),
    start,
    duration,
    saved.bufferMinutes,
  );
}

export async function assertPanelConfirmation(
  tx: PanelTx,
  snapshot: typeof interviewSchedulesTable.$inferSelect,
  start = snapshot.scheduledAt.toISOString(),
) {
  try {
    await assertSavedPanel(tx, snapshot, start);
  } catch (error) {
    if (error instanceof CalendarError)
      throw new CandidateConfirmationError(
        error.status >= 500 ? 503 : 409,
        "The interview time could not be confirmed with the panel. Nothing was booked. Contact your recruiter or try again later.",
      );
    throw error;
  }
}
