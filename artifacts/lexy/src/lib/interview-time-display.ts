type DisplayOptions = { locale?: string; timeZone?: string };

function instant(value: string | Date): Date {
  const date = typeof value === "string" ? new Date(value) : value;
  if (!Number.isFinite(date.getTime())) throw new Error("Invalid interview time.");
  return date;
}

/** Include the offset of this instant, not today's offset for that timezone. */
export function formatInterviewInstant(
  value: string | Date,
  { locale, timeZone }: DisplayOptions = {},
): string {
  const date = instant(value);
  const precise = date.getUTCSeconds() !== 0 || date.getUTCMilliseconds() !== 0;
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    ...(precise ? { second: "2-digit" as const } : {}),
    ...(date.getUTCMilliseconds() ? { fractionalSecondDigits: 3 as const } : {}),
    timeZoneName: "longOffset",
  }).format(date);
}

export function interviewTimeOffset(
  value: string | Date,
  { locale, timeZone }: DisplayOptions = {},
): string {
  const date = instant(value);
  const offset = new Intl.DateTimeFormat(locale, {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(date)
    .find((part) => part.type === "timeZoneName")?.value;
  if (!offset) throw new Error("Interview time offset could not be displayed.");
  return offset;
}
