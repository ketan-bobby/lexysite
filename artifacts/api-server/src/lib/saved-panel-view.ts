import { and, eq, inArray } from "drizzle-orm";
import { interviewSchedulePanelsTable as panels, usersTable } from "@workspace/db";
import { storage, unavailable, type PanelTx, type PanelSchedule } from "./calendar-panel-access";
import { scheduleVersion } from "./coordinator-schedule-version";
import { readSavedPanelMembers, savedPanelProvider } from "./saved-panel-members";

export async function readSchedulePanel(tx: PanelTx, row: PanelSchedule) {
  await storage(tx, "interview_schedule_panels");
  const [saved] = await tx
    .select()
    .from(panels)
    .where(eq(panels.scheduleId, row.schedule.id))
    .for("share");
  if ((saved?.revision ?? null) !== (row.schedule.panelRevision ?? null)) throw unavailable();
  if (saved) readSavedPanelMembers(saved.members);
  return saved;
}
export async function savedPanelView(tx: PanelTx, row: PanelSchedule, callerTenant: string | null) {
  const saved = await readSchedulePanel(tx, row);
  const ids = saved?.members.map((m) => m.userId) ?? [];
  const names = ids.length
    ? await tx
        .select({ id: usersTable.id, name: usersTable.name })
        .from(usersTable)
        .where(
          and(
            inArray(usersTable.id, ids),
            inArray(
              usersTable.tenantId,
              [callerTenant, row.job.tenantId].filter((id): id is string => !!id),
            ),
          ),
        )
    : [];
  return {
    provider: saved ? savedPanelProvider(saved.members) : null,
    scheduleId: row.schedule.id,
    version: scheduleVersion(row.schedule),
    scheduledAt: row.schedule.scheduledAt.toISOString(),
    durationMinutes: row.schedule.durationMinutes,
    members: ids.map((id) => ({
      id,
      name: names.find((m) => m.id === id)?.name || "Unavailable staff member",
    })),
    bufferMinutes: saved?.bufferMinutes ?? 0,
    calendarReserved: false as const,
    invitationSent: false as const,
  };
}
