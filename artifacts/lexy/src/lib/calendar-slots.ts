export interface CalendarPeriod {
  start: string;
  end: string;
}
export interface CalendarAvailability extends CalendarPeriod {
  busy: CalendarPeriod[];
}
export interface InterviewSlot extends CalendarPeriod {
  durationMinutes: number;
}

const minute = 60_000;
const instant = (value: unknown) =>
  typeof value === "string" && /(?:Z|[+-]\d\d:\d\d)$/i.test(value) ? Date.parse(value) : NaN;

/** Unknown or incomplete availability must never be interpreted as a free calendar. */
export function validateAvailability(value: unknown): CalendarAvailability {
  if (!value || typeof value !== "object") throw new Error("Calendar availability is unknown.");
  const data = value as CalendarAvailability;
  if (
    !Number.isFinite(instant(data.start)) ||
    !Number.isFinite(instant(data.end)) ||
    instant(data.end) <= instant(data.start) ||
    instant(data.end) - instant(data.start) > 7 * 86400000 ||
    !Array.isArray(data.busy) ||
    data.busy.some(
      (period) =>
        !period ||
        !Number.isFinite(instant(period.start)) ||
        !Number.isFinite(instant(period.end)) ||
        instant(period.end) <= instant(period.start),
    )
  ) {
    throw new Error("Calendar availability is incomplete. Refresh before choosing a time.");
  }
  return data;
}

export function localScheduleFields(value: string) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid interview time.");
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`,
    time: `${pad(date.getHours())}:${pad(date.getMinutes())}`,
  };
}

export function scheduleDraftInstant(day: string, time: string, selectedStart?: string): string {
  if (selectedStart) {
    const selected = localScheduleFields(selectedStart);
    if (selected.date === day && selected.time === time)
      return new Date(selectedStart).toISOString();
  }
  const date = new Date(`${day}T${time}:00`);
  if (!Number.isFinite(date.getTime())) throw new Error("Choose a valid interview time.");
  const fields = localScheduleFields(date.toISOString());
  if (fields.date !== day || fields.time !== time)
    throw new Error("That time does not exist in your browser’s time zone. Choose another time.");
  return date.toISOString();
}

export function localWorkWindow(day: string, start: string, end: string): CalendarPeriod {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(day) ||
    !/^\d{2}:\d{2}$/.test(start) ||
    !/^\d{2}:\d{2}$/.test(end)
  )
    throw new Error("Choose a valid date and working hours.");
  const a = new Date(`${day}T${start}:00`);
  const b = new Date(`${day}T${end}:00`);
  // Round-trip rejects invalid dates and nonexistent local times at DST transitions.
  if (
    !Number.isFinite(a.getTime()) ||
    !Number.isFinite(b.getTime()) ||
    localScheduleFields(a.toISOString()).date !== day ||
    localScheduleFields(a.toISOString()).time !== start ||
    localScheduleFields(b.toISOString()).date !== day ||
    localScheduleFields(b.toISOString()).time !== end ||
    b <= a
  ) {
    throw new Error("Choose valid working hours with the end after the start.");
  }
  return { start: a.toISOString(), end: b.toISOString() };
}

export function availableInterviewSlots(
  raw: unknown,
  options: CalendarPeriod & { durationMinutes: number; bufferMinutes: number; now: number },
): InterviewSlot[] {
  const availability = validateAvailability(raw);
  const start = instant(options.start),
    end = instant(options.end);
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 25 * 60 * minute ||
    start < instant(availability.start) ||
    end > instant(availability.end) ||
    !Number.isInteger(options.durationMinutes) ||
    options.durationMinutes < 5 ||
    options.durationMinutes > 480 ||
    !Number.isInteger(options.bufferMinutes) ||
    options.bufferMinutes < 0 ||
    options.bufferMinutes > 60 ||
    !Number.isFinite(options.now)
  ) {
    throw new Error(
      "Choose valid working hours, duration and buffer within the checked calendar day.",
    );
  }
  const buffer = options.bufferMinutes * minute;
  const busy = availability.busy.map((period) => ({
    start: instant(period.start) - buffer,
    end: instant(period.end) + buffer,
  }));
  const slots: InterviewSlot[] = [];
  // Fifteen-minute grid anchored to the chosen local working-hour start.
  for (
    let candidate = start;
    candidate + options.durationMinutes * minute <= end;
    candidate += 15 * minute
  ) {
    const finish = candidate + options.durationMinutes * minute;
    if (
      candidate < options.now + 15 * minute ||
      busy.some((period) => period.start < finish && period.end > candidate)
    )
      continue;
    slots.push({
      start: new Date(candidate).toISOString(),
      end: new Date(finish).toISOString(),
      durationMinutes: options.durationMinutes,
    });
  }
  return slots;
}
