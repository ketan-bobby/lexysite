import { createHash } from "node:crypto";

/** A named MAPI property persists the binding in Outlook, without a schema migration. */
export const CALENDAR_BINDING = "String {b6d6dd4d-b322-4bf9-a38b-302b951c808a} Name LexySchedule";
export const CALENDAR_SCOPE = "Calendars.ReadWrite";

export class CalendarError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export function hasGraphScope(scopes: string, permission: string): boolean {
  const wanted = permission.toLowerCase();
  return scopes
    .split(/\s+/)
    .some((s) => [wanted, `https://graph.microsoft.com/${wanted}`].includes(s.toLowerCase()));
}

export function hasCalendarScope(scopes: string): boolean {
  return hasGraphScope(scopes, CALENDAR_SCOPE);
}

export interface GraphEvent {
  id: string;
  "@odata.etag"?: string;
  start: { dateTime: string; timeZone: string };
  end: { dateTime: string; timeZone: string };
  isCancelled?: boolean;
  showAs?: string;
  webLink?: string;
  isOrganizer?: boolean;
  attendees?: unknown[];
  hideAttendees?: boolean;
  type?: string;
}
export type CalendarRequest = <T>(path: string, init?: RequestInit) => Promise<T>;

export function utcInstant(value: GraphEvent["start"]): string {
  if (value.timeZone !== "UTC")
    throw new CalendarError(
      502,
      "invalid_timezone",
      "Outlook returned an unsupported time zone. No changes were saved.",
    );
  const date = new Date(
    /[zZ]|[+-]\d\d:\d\d$/.test(value.dateTime) ? value.dateTime : `${value.dateTime}Z`,
  );
  if (!Number.isFinite(date.getTime()))
    throw new CalendarError(502, "invalid_date", "Outlook returned an invalid event time.");
  return date.toISOString();
}

export function calendarWindow(start: string, end: string) {
  const a = new Date(start).getTime(),
    b = new Date(end).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b) || b <= a || b - a > 7 * 86400000) {
    throw new CalendarError(
      400,
      "invalid_window",
      "Choose a valid time range of up to seven days.",
    );
  }
  return { start: new Date(a).toISOString(), end: new Date(b).toISOString() };
}

export function scheduleBinding(tenantId: string, scheduleId: string): string {
  return createHash("sha256")
    .update(JSON.stringify([tenantId, scheduleId]))
    .digest("hex");
}

export function safeGraphPath(path: string): string {
  const url = new URL(path.startsWith("/") ? `https://graph.microsoft.com/v1.0${path}` : path);
  if (
    url.origin !== "https://graph.microsoft.com" ||
    !url.pathname.startsWith("/v1.0/me/") ||
    url.username ||
    url.password
  ) {
    throw new CalendarError(
      502,
      "invalid_graph_page",
      "Outlook returned an invalid pagination link.",
    );
  }
  return url.toString();
}

async function collectEvents(request: CalendarRequest, first: string): Promise<GraphEvent[]> {
  let next: string | undefined = first;
  const events: GraphEvent[] = [];
  const seen = new Set<string>();
  for (let page = 0; next && page < 10; page++) {
    const path = safeGraphPath(next);
    if (seen.has(path))
      throw new CalendarError(502, "repeated_graph_page", "Outlook pagination did not advance.");
    seen.add(path);
    const result: { value: GraphEvent[]; "@odata.nextLink"?: string } = await request(path);
    if (!Array.isArray(result.value))
      throw new CalendarError(
        502,
        "invalid_graph_response",
        "Outlook did not return calendar data.",
      );
    events.push(...result.value);
    next = result["@odata.nextLink"];
  }
  if (next)
    throw new CalendarError(
      503,
      "calendar_too_large",
      "This calendar range is too large. Choose a shorter range.",
    );
  return events;
}

export async function calendarEvents(request: CalendarRequest, start: string, end: string) {
  const window = calendarWindow(start, end);
  const query = new URLSearchParams({
    startDateTime: window.start,
    endDateTime: window.end,
    $select: "id,start,end,showAs,isCancelled",
    $top: "100",
  });
  return collectEvents(request, `/me/calendarView?${query}`);
}

export async function linkedCalendarEvent(
  request: CalendarRequest,
  binding: string,
): Promise<GraphEvent | null> {
  const query = new URLSearchParams({
    $filter: `singleValueExtendedProperties/Any(ep: ep/id eq '${CALENDAR_BINDING}' and ep/value eq '${binding}')`,
    $select: "id,start,end,isCancelled,webLink,isOrganizer,attendees,hideAttendees,type",
    $top: "10",
  });
  const events = await collectEvents(request, `/me/events?${query}`);
  if (events.length > 1)
    throw new CalendarError(
      409,
      "duplicate_binding",
      "More than one Outlook event is linked. Resolve the duplicate in Outlook before continuing.",
    );
  return events[0] ?? null;
}

/** Only Lexy-created personal holds are mutable. Never modify an invited meeting or series. */
export function assertPersonalHold(event: GraphEvent) {
  if (event.isOrganizer !== true || event.attendees?.length || event.type !== "singleInstance") {
    throw new CalendarError(
      409,
      "meeting_requires_review",
      "This Outlook event has guests, recurrence, or another organizer. Manage it in Outlook; Lexy will not send unexpected meeting updates.",
    );
  }
}

export function calendarScheduleVisible(input: {
  callerId: string;
  role: string;
  allowedTenantIds: string[] | null;
  ownsJob: boolean;
  jobTenantId: string;
  scheduleTenantId: string;
  applicationTenantId: string;
  interviewerId: string | null;
}): boolean {
  return (
    input.scheduleTenantId === input.applicationTenantId &&
    (input.allowedTenantIds === null || input.allowedTenantIds.includes(input.jobTenantId)) &&
    input.ownsJob &&
    (!input.interviewerId || input.interviewerId === input.callerId) &&
    (!["interviewer", "hiring_manager"].includes(input.role) ||
      input.interviewerId === input.callerId)
  );
}

export function eventView(event: GraphEvent | null) {
  if (!event) return null;
  const start = utcInstant(event.start),
    end = utcInstant(event.end);
  const durationMinutes = (new Date(end).getTime() - new Date(start).getTime()) / 60000;
  if (!Number.isInteger(durationMinutes) || durationMinutes < 5 || durationMinutes > 480) {
    throw new CalendarError(
      409,
      "invalid_duration",
      "The Outlook event must last between 5 minutes and 8 hours.",
    );
  }
  let webLink: string | null = null;
  try {
    const link = new URL(event.webLink ?? "");
    if (
      link.protocol === "https:" &&
      ["outlook.office.com", "outlook.office365.com", "outlook.live.com"].includes(link.hostname)
    )
      webLink = link.href;
  } catch {
    /* No usable provider link. */
  }
  return { start, end, durationMinutes, cancelled: Boolean(event.isCancelled), webLink };
}

export async function assertCalendarAvailable(
  request: CalendarRequest,
  start: string,
  end: string,
  excludeId?: string,
) {
  const events = await calendarEvents(request, start, end);
  const conflict = events.some(
    (event) =>
      event.id !== excludeId &&
      !event.isCancelled &&
      event.showAs !== "free" &&
      utcInstant(event.start) < end &&
      utcInstant(event.end) > start,
  );
  if (conflict)
    throw new CalendarError(
      409,
      "calendar_conflict",
      "Your Outlook calendar is busy at this time. Choose another time in Lexy before booking.",
    );
}
