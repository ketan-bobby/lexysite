import { z } from "zod";

/** Project diagnostic only: never returns an account id, busy intervals or event data. */
export interface GoogleCalendarReadGateway {
  connections(): Promise<Array<{ id: string; connector_name: string }>>;
  read(
    connectionId: string,
    path: string,
    options: { method: "GET" | "POST"; body?: unknown },
  ): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

export class GoogleCalendarReadError extends Error {
  constructor(public readonly code: string) {
    super("Google Calendar reads could not be verified. No invitations are enabled.");
  }
}

export const GOOGLE_PRIMARY_READ =
  "/calendar/v3/calendars/primary?fields=id,timeZone,conferenceProperties(allowedConferenceSolutionTypes)";
export const GOOGLE_FREEBUSY_READ = "/calendar/v3/freeBusy";

const primarySchema = z.object({
  id: z.string().min(1).max(1024),
  timeZone: z.string().min(1).max(100),
  conferenceProperties: z
    .object({
      allowedConferenceSolutionTypes: z.array(z.string().max(100)).max(20),
    })
    .optional(),
});
const instant = z.string().datetime({ offset: true });
const freeBusySchema = z.object({
  timeMin: instant,
  timeMax: instant,
  calendars: z.record(
    z.string(),
    z.object({
      busy: z.array(z.object({ start: instant, end: instant })).max(1000),
      errors: z.array(z.unknown()).optional(),
    }),
  ),
  groups: z.record(z.string(), z.unknown()).optional(),
});

export function assertGoogleReadOperation(
  path: string,
  options: { method: string; body?: unknown },
) {
  if (path === GOOGLE_PRIMARY_READ && options.method === "GET" && options.body === undefined)
    return;
  if (path === GOOGLE_FREEBUSY_READ && options.method === "POST") {
    const body = z
      .object({
        timeMin: instant,
        timeMax: instant,
        timeZone: z.literal("UTC"),
        calendarExpansionMax: z.literal(1),
        items: z.tuple([z.object({ id: z.string().min(1).max(1024) }).strict()]),
      })
      .strict()
      .safeParse(options.body);
    if (body.success) {
      const duration = Date.parse(body.data.timeMax) - Date.parse(body.data.timeMin);
      if (duration > 0 && duration <= 15 * 60_000) return;
    }
  }
  throw new GoogleCalendarReadError("operation_not_allowed");
}

async function jsonRead(
  gateway: GoogleCalendarReadGateway,
  id: string,
  path: string,
  options: { method: "GET" | "POST"; body?: unknown },
) {
  assertGoogleReadOperation(path, options);
  try {
    const response = await gateway.read(id, path, options);
    if (!response.ok)
      throw new GoogleCalendarReadError(
        [401, 403].includes(response.status) ? "permission_required" : "provider_unavailable",
      );
    return await response.json();
  } catch (error) {
    if (error instanceof GoogleCalendarReadError) throw error;
    throw new GoogleCalendarReadError("provider_unavailable");
  }
}

export async function checkGoogleCalendarReads(
  gateway: GoogleCalendarReadGateway,
  now = new Date(),
) {
  if (!Number.isFinite(now.getTime())) throw new GoogleCalendarReadError("invalid_clock");
  const base = {
    checkedAt: now.toISOString(),
    calendarReadVerified: false,
    availabilityReadVerified: false,
    meetSupported: null as boolean | null,
    accountBinding: "not_configured" as const,
    invitationsEnabled: false as const,
  };
  let connections;
  try {
    connections = (await gateway.connections()).filter(
      (c) => c.connector_name === "google-calendar",
    );
  } catch {
    throw new GoogleCalendarReadError("connection_unavailable");
  }
  if (connections.length === 0) return { ...base, status: "not_connected" as const };
  if (connections.length !== 1) return { ...base, status: "selection_required" as const };
  const connection = connections[0];
  if (typeof connection.id !== "string" || !connection.id.trim())
    throw new GoogleCalendarReadError("connection_unavailable");
  const parsed = primarySchema.safeParse(
    await jsonRead(gateway, connection.id, GOOGLE_PRIMARY_READ, { method: "GET" }),
  );
  if (!parsed.success) throw new GoogleCalendarReadError("invalid_calendar_response");
  const primary = parsed.data;
  try {
    new Intl.DateTimeFormat("en", { timeZone: primary.timeZone });
  } catch {
    throw new GoogleCalendarReadError("invalid_calendar_response");
  }
  const start = now.getTime();
  const end = start + 15 * 60_000;
  const timeMin = new Date(start).toISOString(),
    timeMax = new Date(end).toISOString();
  const busy = freeBusySchema.safeParse(
    await jsonRead(gateway, connection.id, GOOGLE_FREEBUSY_READ, {
      method: "POST",
      body: {
        timeMin,
        timeMax,
        timeZone: "UTC",
        calendarExpansionMax: 1,
        items: [{ id: primary.id }],
      },
    }),
  );
  if (!busy.success) throw new GoogleCalendarReadError("invalid_availability_response");
  const result = busy.data;
  const keys = Object.keys(result.calendars);
  if (
    Date.parse(result.timeMin) !== start ||
    Date.parse(result.timeMax) !== end ||
    keys.length !== 1 ||
    keys[0] !== primary.id ||
    Object.keys(result.groups ?? {}).length !== 0
  )
    throw new GoogleCalendarReadError("invalid_availability_response");
  const calendar = result.calendars[primary.id];
  if (
    calendar.errors?.length ||
    calendar.busy.some((interval) => {
      const a = Date.parse(interval.start),
        b = Date.parse(interval.end);
      return a < start || b > end || b <= a;
    })
  )
    throw new GoogleCalendarReadError("availability_unknown");
  return {
    ...base,
    status: "verified" as const,
    calendarReadVerified: true,
    availabilityReadVerified: true,
    meetSupported: primary.conferenceProperties
      ? primary.conferenceProperties.allowedConferenceSolutionTypes.includes("hangoutsMeet")
      : null,
  };
}
