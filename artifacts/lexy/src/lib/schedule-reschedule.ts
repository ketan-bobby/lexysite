import { localScheduleFields, scheduleDraftInstant } from "./calendar-slots";
import { requireScheduleVersion, type ScheduleEditRecord } from "./schedule-edit";

export interface RescheduleDraft {
  date: string;
  time: string;
  durationMinutes: string;
}

export function canReschedule(schedule: Pick<ScheduleEditRecord, "status">): boolean {
  return ["pending", "scheduled", "confirmed", "rescheduled"].includes(schedule.status);
}

export function initialRescheduleDraft(schedule: ScheduleEditRecord): RescheduleDraft {
  return {
    ...localScheduleFields(schedule.scheduledAt),
    durationMinutes: String(schedule.durationMinutes),
  };
}

function draftTiming(draft: RescheduleDraft, originalStart: string) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(draft.date) || !/^\d{2}:\d{2}$/.test(draft.time))
    throw new Error("Choose a valid date and time.");
  const durationMinutes = Number(draft.durationMinutes);
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480)
    throw new Error("Duration must be a whole number between 5 and 480 minutes.");
  return {
    scheduledAt: scheduleDraftInstant(draft.date, draft.time, originalStart),
    durationMinutes,
  };
}

// Keep the original instant anchor even when rebasing onto a newer revision.
// Otherwise an unchanged wall-clock input could silently switch DST offsets.
export function hasRequestedTiming(
  schedule: ScheduleEditRecord,
  draft: RescheduleDraft,
  originalStart: string,
): boolean {
  try {
    const timing = draftTiming(draft, originalStart);
    return (
      Date.parse(schedule.scheduledAt) === Date.parse(timing.scheduledAt) &&
      schedule.durationMinutes === timing.durationMinutes
    );
  } catch {
    return false;
  }
}

export function rescheduleUpdate(
  schedule: ScheduleEditRecord,
  draft: RescheduleDraft,
  originalStart: string,
  now = Date.now(),
) {
  if (!canReschedule(schedule))
    throw new Error("This schedule is closed. Create a new schedule instead.");
  const expectedVersion = requireScheduleVersion(schedule);
  const timing = draftTiming(draft, originalStart);
  if (Date.parse(timing.scheduledAt) <= now) throw new Error("Choose a future interview time.");
  if (hasRequestedTiming(schedule, draft, originalStart))
    throw new Error("Choose a different time or duration.");
  return { ...timing, status: "rescheduled" as const, expectedVersion };
}
