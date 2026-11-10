import { createHash } from "node:crypto";
import {
  CALENDAR_BINDING,
  CalendarError,
  assertCalendarAvailable,
  assertPersonalHold,
  scheduleBinding,
  utcInstant,
  type CalendarRequest,
  type GraphEvent,
} from "./outlook-calendar-core";

export function invitationRecipientHash(email: string) {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex");
}

export function invitedCandidate(
  event: GraphEvent | null,
  email: string,
  start: string,
  end: string,
) {
  return invitedRecipients(event, [email], start, end);
}

export function invitedRecipients(
  event: GraphEvent | null,
  emails: string[],
  start: string,
  end: string,
  hidden = false,
) {
  if (
    !event ||
    event.isCancelled ||
    event.isOrganizer !== true ||
    event.type !== "singleInstance" ||
    utcInstant(event.start) !== start ||
    utcInstant(event.end) !== end ||
    !Array.isArray(event.attendees) ||
    event.attendees.length !== emails.length ||
    (hidden && event.hideAttendees !== true)
  )
    return false;
  const addresses = event.attendees.map((attendee) => {
    if (!attendee || typeof attendee !== "object") return null;
    const address = (attendee as { emailAddress?: { address?: unknown } }).emailAddress?.address;
    return typeof address === "string" ? address.trim().toLowerCase() : null;
  });
  return (
    new Set(addresses).size === emails.length &&
    emails.every((email) => addresses.includes(email.trim().toLowerCase()))
  );
}

export async function sendCandidateCalendarInvitation(
  request: CalendarRequest,
  input: {
    scheduleId: string;
    tenantId: string;
    jobTitle: string;
    candidateEmail: string;
    start: string;
    end: string;
    transactionId: string;
    panelEmails?: string[];
  },
  current: GraphEvent | null,
): Promise<GraphEvent> {
  if (current) {
    assertPersonalHold(current);
    if (
      current.isCancelled ||
      utcInstant(current.start) !== input.start ||
      utcInstant(current.end) !== input.end ||
      !current["@odata.etag"]
    ) {
      throw new CalendarError(
        409,
        "calendar_hold_changed",
        "The personal hold does not match the confirmed Lexy time. Review it in Outlook first.",
      );
    }
  }
  await assertCalendarAvailable(request, input.start, input.end, current?.id);
  const body = {
    subject: `Lexy interview — ${input.jobTitle}`.slice(0, 255),
    body: {
      contentType: "Text",
      content:
        "Your interview time was confirmed in Lexy. Contact your recruiter for meeting details.",
    },
    start: { dateTime: input.start, timeZone: "UTC" },
    end: { dateTime: input.end, timeZone: "UTC" },
    showAs: "busy",
    sensitivity: "private",
    allowNewTimeProposals: false,
    responseRequested: true,
    ...(input.panelEmails ? { hideAttendees: true } : {}),
    attendees: [input.candidateEmail, ...(input.panelEmails ?? [])].map((address) => ({
      emailAddress: { address },
      type: "required",
    })),
  };
  const event = await request<GraphEvent>(
    current ? `/me/events/${encodeURIComponent(current.id)}` : "/me/events",
    {
      method: current ? "PATCH" : "POST",
      headers: current ? { "If-Match": current["@odata.etag"]! } : {},
      body: JSON.stringify(
        current
          ? body
          : {
              ...body,
              transactionId: input.transactionId,
              singleValueExtendedProperties: [
                {
                  id: CALENDAR_BINDING,
                  value: scheduleBinding(input.tenantId, input.scheduleId),
                },
              ],
            },
      ),
    },
  );
  // Graph accepting a request is not proof of delivery. An ambiguous provider
  // response remains a durable review case, never a reason to send again.
  if (
    !event?.id ||
    !invitedRecipients(
      event,
      [input.candidateEmail, ...(input.panelEmails ?? [])],
      input.start,
      input.end,
      !!input.panelEmails,
    )
  )
    throw new CalendarError(
      503,
      "invitation_uncertain",
      "Outlook may have accepted the invitation. Review its event before doing anything else.",
    );
  return event;
}
