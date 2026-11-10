import { z } from "zod/v4";
import { googleStaffFailure } from "./google-staff-config";
import {
  googleEventObservation,
  googleInterviewEventId,
  type GoogleEventDetails,
} from "./google-interview-event";

export type GoogleObservedEvent = ReturnType<typeof googleEventObservation>;
export function googleInterviewEventChanges(request: typeof fetch = fetch) {
  async function call(access: string, path: string, method = "GET", body?: unknown, etag?: string) {
    try {
      const r = await request(`https://www.googleapis.com/calendar/v3/calendars/primary${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${access}`,
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(etag ? { "If-Match": etag } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(8000),
        redirect: "error",
      });
      if (!r.ok) throw googleStaffFailure("google_event_unverified", 409);
      return r;
    } catch {
      throw googleStaffFailure("google_event_unverified", 409);
    }
  }
  const path = (d: GoogleEventDetails) => `/events/${googleInterviewEventId(d.transactionId)}`;
  return {
    async observe(access: string, d: GoogleEventDetails) {
      return googleEventObservation(await (await call(access, path(d))).json(), d);
    },
    async available(
      access: string,
      d: GoogleEventDetails,
      member?: { source: GoogleObservedEvent; email: string },
    ) {
      // Free/busy cannot subtract the original event without hiding a second,
      // overlapping booking. Inspect this bounded interval, never return its contents.
      const query = new URLSearchParams({
        timeMin: d.startAt,
        timeMax: d.endAt,
        singleEvents: "true",
        showDeleted: "false",
        maxResults: "250",
      });
      const raw = await (await call(access, `/events?${query}`)).json();
      const result = z
        .object({
          kind: z.literal("calendar#events"),
          nextPageToken: z.string().optional(),
          items: z
            .array(
              z.object({
                id: z.string(),
                status: z.string().optional(),
                transparency: z.string().optional(),
                iCalUID: z.string().min(1).max(1024).optional(),
                organizer: z.object({ email: z.email() }).optional(),
                attendees: z
                  .array(
                    z.object({
                      email: z.email(),
                      self: z.boolean().optional(),
                      organizer: z.boolean().optional(),
                      additionalGuests: z.number().optional(),
                    }),
                  )
                  .max(7)
                  .optional(),
                recurringEventId: z.string().optional(),
                recurrence: z.array(z.string()).optional(),
                start: z
                  .object({
                    dateTime: z.iso.datetime({ offset: true }).optional(),
                    date: z.string().optional(),
                  })
                  .optional(),
                end: z
                  .object({
                    dateTime: z.iso.datetime({ offset: true }).optional(),
                    date: z.string().optional(),
                  })
                  .optional(),
              }),
            )
            .max(250)
            .default([]),
        })
        .safeParse(raw);
      if (!result.success || result.data.nextPageToken)
        throw googleStaffFailure("google_availability_incomplete", 503);
      let excludedCopy = false;
      for (const e of result.data.items) {
        if (
          (!member && e.id === googleInterviewEventId(d.transactionId)) ||
          e.status === "cancelled" ||
          e.transparency === "transparent"
        )
          continue;
        const start = Date.parse(e.start?.dateTime ?? ""),
          end = Date.parse(e.end?.dateTime ?? "");
        if (
          member &&
          !excludedCopy &&
          member.source.iCalUID &&
          e.status === "confirmed" &&
          e.iCalUID === member.source.iCalUID &&
          !e.recurringEventId &&
          !e.recurrence?.length &&
          e.organizer?.email.trim().toLowerCase() === d.organizerEmail.trim().toLowerCase() &&
          start === Date.parse(member.source.startAt) &&
          end === Date.parse(member.source.endAt)
        ) {
          const guests = e.attendees?.filter(
            (a) =>
              !(
                a.organizer &&
                a.email.trim().toLowerCase() === d.organizerEmail.trim().toLowerCase()
              ),
          );
          const expected = [d.recipientEmail, ...(d.panelEmails ?? [])].map((email) =>
            email.trim().toLowerCase(),
          );
          if (
            guests &&
            guests.length === expected.length &&
            new Set(guests.map((a) => a.email.trim().toLowerCase())).size === expected.length &&
            guests.every((a) => expected.includes(a.email.trim().toLowerCase())) &&
            e.attendees!.every((a) => !a.additionalGuests) &&
            e.attendees!.filter((a) => a.self).length === 1 &&
            e.attendees!.some((a) => a.self && a.email.trim().toLowerCase() === member.email)
          ) {
            excludedCopy = true;
            continue;
          }
        }
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          end <= start ||
          (start < Date.parse(d.endAt) && end > Date.parse(d.startAt))
        )
          throw googleStaffFailure("google_interval_busy", 409);
      }
    },
    async reschedule(
      access: string,
      d: GoogleEventDetails,
      source: GoogleObservedEvent,
      changeId: string,
    ) {
      const raw = await (
        await call(
          access,
          `${path(d)}?conferenceDataVersion=1&sendUpdates=all`,
          "PATCH",
          {
            start: { dateTime: d.startAt, timeZone: "UTC" },
            end: { dateTime: d.endAt, timeZone: "UTC" },
            extendedProperties: {
              private: {
                lexySchedule: d.binding,
                lexyAttempt: d.transactionId,
                lexyChange: changeId,
              },
            },
          },
          source.etag,
        )
      ).json();
      const receipt = googleEventObservation(raw, d);
      if (
        receipt.startAt !== d.startAt ||
        receipt.endAt !== d.endAt ||
        receipt.changeId !== changeId ||
        (source.meetUrl && receipt.meetUrl !== source.meetUrl)
      )
        throw googleStaffFailure("google_event_unverified", 409);
      return receipt;
    },
    async cancel(access: string, d: GoogleEventDetails, source: GoogleObservedEvent) {
      const r = await call(access, `${path(d)}?sendUpdates=all`, "DELETE", undefined, source.etag);
      if (r.status !== 204 && (r.status !== 200 || (await r.text()).trim() !== ""))
        throw googleStaffFailure("google_event_unverified", 409);
    },
  };
}
