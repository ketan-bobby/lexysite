import { CalendarError, utcInstant, type GraphEvent } from "./outlook-calendar-core";
export type PanelBusyInterval = Pick<GraphEvent, "start" | "end" | "showAs" | "isCancelled">;

export function commonPanelSlots(
  calendars: PanelBusyInterval[][],
  input: { start: string; end: string; durationMinutes: number; bufferMinutes: number },
  now = Date.now(),
  allows?: (start: number, end: number) => boolean,
) {
  const start = Date.parse(input.start),
    end = Date.parse(input.end);
  const minute = 60000;
  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 25 * 60 * minute ||
    !Number.isInteger(input.durationMinutes) ||
    input.durationMinutes < 5 ||
    input.durationMinutes > 480 ||
    !Number.isInteger(input.bufferMinutes) ||
    input.bufferMinutes < 0 ||
    input.bufferMinutes > 60 ||
    calendars.length < 1 ||
    calendars.length > 5 ||
    !Number.isFinite(now)
  )
    throw new CalendarError(
      400,
      "invalid_panel_window",
      "Choose a panel of one to five people and a time window of up to 25 hours.",
    );
  const busy: Array<{ start: number; end: number }> = [];
  for (const calendar of calendars) {
    if (!Array.isArray(calendar))
      throw new CalendarError(
        503,
        "panel_unknown",
        "Panel availability is unknown. Try again later.",
      );
    for (const event of calendar) {
      if (
        !event ||
        typeof event !== "object" ||
        (event.isCancelled !== undefined && typeof event.isCancelled !== "boolean") ||
        typeof event.showAs !== "string"
      )
        throw new CalendarError(
          503,
          "panel_unknown",
          "A calendar returned incomplete availability. No times can be suggested.",
        );
      if (event.isCancelled === true || event.showAs === "free") continue;
      const a = event.start && Date.parse(utcInstant(event.start));
      const b = event.end && Date.parse(utcInstant(event.end));
      if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a)
        throw new CalendarError(
          503,
          "panel_unknown",
          "A calendar returned incomplete availability. No times can be suggested.",
        );
      busy.push({ start: a - input.bufferMinutes * minute, end: b + input.bufferMinutes * minute });
    }
  }
  const slots: Array<{ start: string; end: string }> = [];
  for (let t = start; t + input.durationMinutes * minute <= end; t += 15 * minute) {
    const finish = t + input.durationMinutes * minute;
    if (
      t < now + 15 * minute ||
      busy.some((p) => p.start < finish && p.end > t) ||
      (allows && !allows(t, finish))
    )
      continue;
    slots.push({ start: new Date(t).toISOString(), end: new Date(finish).toISOString() });
    if (slots.length === 40) break;
  }
  return slots;
}
