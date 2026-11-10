import { z } from "zod/v4";
import { digest, googleStaffFailure } from "./google-staff-config";

export type GoogleEventDetails = {
  transactionId: string;
  binding: string;
  jobTitle: string;
  recipientEmail: string;
  panelEmails?: string[];
  organizerEmail: string;
  startAt: string;
  endAt: string;
};
export type GoogleEventReceipt = {
  id: string;
  meetUrl: string | null;
  conferenceStatus: "pending" | "ready" | "failed";
};
export const googleInterviewEventId = (id: string) => `a${digest(id)}`; // Google's base32hex alphabet.
export function safeGoogleMeetUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const u = new URL(value);
    return (
      u.protocol === "https:" &&
      u.hostname === "meet.google.com" &&
      !u.port &&
      !u.username &&
      !u.password &&
      !u.search &&
      !u.hash &&
      /^\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(u.pathname)
    );
  } catch {
    return false;
  }
}
const remoteSchema = z.object({
  recurrence: z.never().optional(),
  recurringEventId: z.never().optional(),
  originalStartTime: z.never().optional(),
  id: z.string(),
  status: z.literal("confirmed"),
  summary: z.string(),
  start: z.object({ dateTime: z.iso.datetime({ offset: true }) }),
  end: z.object({ dateTime: z.iso.datetime({ offset: true }) }),
  organizer: z.object({ email: z.email(), self: z.literal(true) }),
  attendees: z
    .array(
      z.object({
        email: z.email(),
        organizer: z.boolean().optional(),
        additionalGuests: z.number().optional(),
      }),
    )
    .max(7),
  attendeesOmitted: z.literal(false).optional(),
  guestsCanInviteOthers: z.literal(false),
  guestsCanModify: z.literal(false).optional(),
  guestsCanSeeOtherGuests: z.literal(false),
  visibility: z.literal("private"),
  extendedProperties: z.object({
    private: z.object({ lexySchedule: z.string(), lexyAttempt: z.string() }),
  }),
  conferenceData: z
    .object({
      conferenceSolution: z
        .object({ key: z.object({ type: z.literal("hangoutsMeet") }) })
        .optional(),
      createRequest: z
        .object({
          requestId: z.string(),
          status: z.object({ statusCode: z.enum(["pending", "success", "failure"]) }),
        })
        .optional(),
      entryPoints: z
        .array(z.object({ entryPointType: z.string(), uri: z.string() }))
        .max(20)
        .optional(),
    })
    .optional(),
});
export function googleEventReceipt(raw: unknown, details: GoogleEventDetails): GoogleEventReceipt {
  const p = remoteSchema.safeParse(raw);
  if (!p.success) throw googleStaffFailure("google_event_unverified", 409);
  const e = p.data,
    same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();
  const guests = e.attendees.filter((a) => !(a.organizer && same(a.email, details.organizerEmail)));
  const expected = googleEventRecipients(details);
  if (
    e.id !== googleInterviewEventId(details.transactionId) ||
    !same(e.organizer.email, details.organizerEmail) ||
    e.summary !== `Interview: ${details.jobTitle}`.slice(0, 300) ||
    Date.parse(e.start.dateTime) !== Date.parse(details.startAt) ||
    Date.parse(e.end.dateTime) !== Date.parse(details.endAt) ||
    guests.length !== expected.length ||
    new Set(guests.map((a) => a.email.trim().toLowerCase())).size !== guests.length ||
    guests.some((a) => !expected.includes(a.email.trim().toLowerCase())) ||
    e.attendees.some((a) => (a.additionalGuests ?? 0) !== 0) ||
    e.extendedProperties.private.lexySchedule !== details.binding ||
    e.extendedProperties.private.lexyAttempt !== details.transactionId ||
    (e.conferenceData?.createRequest &&
      e.conferenceData.createRequest.requestId !== details.transactionId)
  )
    throw googleStaffFailure("google_event_unverified", 409);
  const conf = e.conferenceData,
    videos = conf?.entryPoints?.filter((p) => p.entryPointType === "video") ?? [];
  const status = conf?.createRequest?.status.statusCode;
  if (status === "failure") return { id: e.id, meetUrl: null, conferenceStatus: "failed" };
  if (videos.length) {
    if (
      videos.length !== 1 ||
      !safeGoogleMeetUrl(videos[0].uri) ||
      conf?.conferenceSolution?.key.type !== "hangoutsMeet" ||
      status === "pending"
    )
      throw googleStaffFailure("google_event_unverified", 409);
    return { id: e.id, meetUrl: videos[0].uri, conferenceStatus: "ready" };
  }
  if (status === "success") throw googleStaffFailure("google_event_unverified", 409);
  return { id: e.id, meetUrl: null, conferenceStatus: "pending" };
}
export function googleEventRecipients(details: GoogleEventDetails) {
  const expected = [details.recipientEmail, ...(details.panelEmails ?? [])].map((e) =>
    e.trim().toLowerCase(),
  );
  if (
    expected.length > 6 ||
    expected.some(
      (email) =>
        !z.email().safeParse(email).success ||
        email === details.organizerEmail.trim().toLowerCase(),
    ) ||
    new Set(expected).size !== expected.length
  )
    throw googleStaffFailure("google_event_unverified", 409);
  return expected;
}
export function googleEventObservation(raw: unknown, d: GoogleEventDetails) {
  const fields = z
    .object({
      iCalUID: z.string().min(1).max(1024).optional(),
      etag: z.string().regex(/^"[\x21\x23-\x7e]{1,200}"$/),
      start: z.object({ dateTime: z.iso.datetime({ offset: true }) }),
      end: z.object({ dateTime: z.iso.datetime({ offset: true }) }),
      extendedProperties: z.object({ private: z.object({ lexyChange: z.string().optional() }) }),
    })
    .safeParse(raw);
  if (
    !fields.success ||
    Date.parse(fields.data.end.dateTime) <= Date.parse(fields.data.start.dateTime)
  )
    throw googleStaffFailure("google_event_unverified", 409);
  const f = fields.data;
  return {
    ...googleEventReceipt(raw, { ...d, startAt: f.start.dateTime, endAt: f.end.dateTime }),
    etag: f.etag,
    startAt: new Date(f.start.dateTime).toISOString(),
    endAt: new Date(f.end.dateTime).toISOString(),
    changeId: f.extendedProperties.private.lexyChange ?? null,
    ...(f.iCalUID ? { iCalUID: f.iCalUID } : {}),
  };
}
export function googleInterviewEvents(request: typeof fetch = fetch) {
  async function call(
    access: string,
    path: string,
    method = "GET",
    body?: unknown,
  ): Promise<unknown> {
    try {
      const res = await request(`https://www.googleapis.com/calendar/v3/calendars/primary${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${access}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!res.ok) throw googleStaffFailure("google_event_unverified", 409);
      return await res.json();
    } catch {
      throw googleStaffFailure("google_event_unverified", 409);
    }
  }
  return {
    async canMeet(access: string) {
      const data = await call(access, "?fields=id,conferenceProperties");
      const parsed = z
        .object({
          id: z.string().min(1),
          conferenceProperties: z.object({ allowedConferenceSolutionTypes: z.array(z.string()) }),
        })
        .safeParse(data);
      if (
        !parsed.success ||
        !parsed.data.conferenceProperties.allowedConferenceSolutionTypes.includes("hangoutsMeet")
      )
        throw googleStaffFailure("google_meet_unavailable", 409);
    },
    async create(access: string, d: GoogleEventDetails) {
      const raw = await call(access, "/events?conferenceDataVersion=1&sendUpdates=all", "POST", {
        id: googleInterviewEventId(d.transactionId),
        summary: `Interview: ${d.jobTitle}`.slice(0, 300),
        description: "Interview scheduled through Lexy. The organizer approved this invitation.",
        start: { dateTime: d.startAt, timeZone: "UTC" },
        end: { dateTime: d.endAt, timeZone: "UTC" },
        attendees: googleEventRecipients(d).map((email) => ({
          email,
          responseStatus: "needsAction",
        })),
        guestsCanInviteOthers: false,
        guestsCanModify: false,
        guestsCanSeeOtherGuests: false,
        visibility: "private",
        extendedProperties: { private: { lexySchedule: d.binding, lexyAttempt: d.transactionId } },
        conferenceData: {
          createRequest: {
            requestId: d.transactionId,
            conferenceSolutionKey: { type: "hangoutsMeet" },
          },
        },
      });
      return googleEventReceipt(raw, d);
    },
    async read(access: string, d: GoogleEventDetails) {
      return googleEventReceipt(
        await call(access, `/events/${googleInterviewEventId(d.transactionId)}`),
        d,
      );
    },
  };
}
