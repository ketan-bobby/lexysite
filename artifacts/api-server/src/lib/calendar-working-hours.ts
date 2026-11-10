import { z } from "zod/v4";
import { CalendarError } from "./outlook-calendar-core";

const clock = (value: string) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3));
const windowSchema = z
  .object({
    day: z.number().int().min(0).max(6),
    start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
    end: z.string().regex(/^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/),
  })
  .strict();
export function workingHoursPolicy(timeZone: unknown, windows: unknown) {
  const zone = z.string().min(1).max(100).nullable().parse(timeZone);
  const parsed = z.array(windowSchema).max(14).parse(windows);
  if (zone === null) {
    if (parsed.length) throw new Error("Cleared hours must have no windows");
    return { timeZone: null, windows: parsed, allows: (_start: number, _end: number) => true };
  }
  if (!/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(zone))
    throw new Error("Use an IANA timezone, not a numeric offset");
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const sorted = [...parsed].sort((a, b) => a.day - b.day || clock(a.start) - clock(b.start));
  for (let i = 0; i < sorted.length; i++) {
    const w = sorted[i],
      previous = sorted[i - 1];
    if (
      clock(w.end) <= clock(w.start) ||
      (previous?.day === w.day && clock(previous.end) > clock(w.start))
    )
      throw new Error("Weekly intervals must be forward and non-overlapping");
  }
  const weekdays = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const cache = new Map<number, boolean>();
  function minuteAllowed(instant: number) {
    const key = Math.floor(instant / 60000);
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const parts = formatter.formatToParts(new Date(instant));
    const part = (type: string) => parts.find((p) => p.type === type)?.value;
    const day = weekdays.indexOf(part("weekday") ?? "");
    const minute = Number(part("hour")) * 60 + Number(part("minute"));
    if (day < 0 || !Number.isFinite(minute))
      throw new CalendarError(
        503,
        "working_hours_unknown",
        "Working-hour availability is unknown.",
      );
    const allowed = sorted.some(
      (w) => w.day === day && clock(w.start) <= minute && minute < clock(w.end),
    );
    cache.set(key, allowed);
    return allowed;
  }
  return {
    timeZone: zone,
    windows: parsed,
    allows(start: number, end: number) {
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
      // Walk actual instants, not constructed wall-clock dates: DST gaps never
      // become invented times, and both instants in a repeated hour are checked.
      for (let t = start; t < end; t = (Math.floor(t / 60000) + 1) * 60000)
        if (!minuteAllowed(t)) return false;
      return true;
    },
  };
}
